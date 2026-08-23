import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_VERSION = "0.3.5";
const AUTH_CONTEXT = "brave-control-auth-v1";
const MAX_FRAME_BYTES = 24 * 1024 * 1024;
const MAX_PENDING_COMMANDS = 100;
const MAX_UNAUTHENTICATED_CLIENTS = 8;
const MAX_RPC_BUFFER_CHARS = 2 * 1024 * 1024;
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await readFile(join(pluginRoot, "config.json"), "utf8"));
const host = config.host === "127.0.0.1" ? config.host : "127.0.0.1";
const port = Number(config.port);
const token = String(process.env.BRAVE_CONTROL_TOKEN || config.token || "");

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("config.json must contain a port from 1024 to 65535");
}
if (!/^[a-f0-9]{64}$/i.test(token)) {
  throw new Error("Run install.ps1 to generate a private 256-bit pairing token");
}

let browserClient = null;
let browserVersion = null;
let sequence = 0;
const pending = new Map();
const unauthenticatedSockets = new Set();

function authProof(role, clientNonce, serverNonce, extensionId) {
  return createHmac("sha256", Buffer.from(token, "hex"))
    .update(`${AUTH_CONTEXT}:${role}:${clientNonce}:${serverNonce}:${extensionId}`, "utf8")
    .digest("hex");
}

function equalHex(expected, candidate) {
  if (!/^[a-f0-9]{64}$/i.test(String(candidate || ""))) return false;
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(String(candidate), "hex");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function encodeFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function sendJson(socket, value) {
  if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(value)));
}

function closeSocket(socket, code = 1000, reason = "") {
  unauthenticatedSockets.delete(socket);
  const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  if (!socket.destroyed) socket.end(encodeFrame(payload, 0x8));
}

function parseFrames(socket, chunk, state, onMessage) {
  if (state.buffer.length + chunk.length > MAX_FRAME_BYTES + 14) {
    closeSocket(socket, 1009, "Message too large");
    return;
  }
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const fin = Boolean(first & 0x80);
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;

    if (first & 0x70 || !masked) {
      closeSocket(socket, 1002, "Invalid frame");
      return;
    }
    if (length === 126) {
      if (state.buffer.length < 4) return;
      length = state.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (state.buffer.length < 10) return;
      const largeLength = state.buffer.readBigUInt64BE(2);
      if (largeLength > BigInt(MAX_FRAME_BYTES)) {
        closeSocket(socket, 1009, "Message too large");
        return;
      }
      length = Number(largeLength);
      offset = 10;
    }
    if (length > MAX_FRAME_BYTES) {
      closeSocket(socket, 1009, "Message too large");
      return;
    }

    const maskLength = 4;
    if (state.buffer.length < offset + maskLength + length) return;
    const mask = state.buffer.subarray(offset, offset + 4);
    offset += maskLength;
    const payload = Buffer.from(state.buffer.subarray(offset, offset + length));
    state.buffer = state.buffer.subarray(offset + length);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

    if (opcode === 0x8) {
      closeSocket(socket);
      return;
    }
    if (opcode === 0x9) {
      if (!fin || payload.length > 125) {
        closeSocket(socket, 1002, "Invalid control frame");
        return;
      }
      socket.write(encodeFrame(payload, 0xA));
      continue;
    }
    if (opcode === 0xA) continue;

    if (opcode === 0x1) {
      if (state.fragments.length) {
        closeSocket(socket, 1002, "Unexpected text frame");
        return;
      }
      state.fragments = [payload];
      state.fragmentBytes = payload.length;
    } else if (opcode === 0x0 && state.fragments.length) {
      state.fragments.push(payload);
      state.fragmentBytes += payload.length;
    } else {
      closeSocket(socket, 1003, "Unsupported frame");
      return;
    }

    if (state.fragmentBytes > MAX_FRAME_BYTES) {
      closeSocket(socket, 1009, "Message too large");
      return;
    }
    if (fin) {
      const message = Buffer.concat(state.fragments).toString("utf8");
      state.fragments = [];
      state.fragmentBytes = 0;
      onMessage(message);
    }
  }
}

function rejectPending(reason) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(reason));
  }
  pending.clear();
}

function handleBrowserMessage(socket, raw, authState) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    closeSocket(socket, 1007, "Invalid JSON");
    return;
  }

  if (!authState.authenticated) {
    if (authState.phase === "hello") {
      const clientNonce = String(message.client_nonce || "");
      if (message.type !== "client_hello" || !/^[a-f0-9]{64}$/i.test(clientNonce) || message.extension_id !== authState.extensionId) {
        closeSocket(socket, 1008, "Pairing failed");
        return;
      }
      authState.clientNonce = clientNonce.toLowerCase();
      authState.serverNonce = randomBytes(32).toString("hex");
      authState.browserVersion = String(message.version || "unknown").slice(0, 64);
      authState.phase = "proof";
      sendJson(socket, {
        type: "server_challenge",
        server_nonce: authState.serverNonce,
        proof: authProof("server", authState.clientNonce, authState.serverNonce, authState.extensionId),
        version: BRIDGE_VERSION
      });
      return;
    }
    if (authState.phase === "proof") {
      const expected = authProof("client", authState.clientNonce, authState.serverNonce, authState.extensionId);
      if (message.type !== "client_proof" || !equalHex(expected, message.proof)) {
        closeSocket(socket, 1008, "Pairing failed");
        return;
      }
      authState.authenticated = true;
      authState.phase = "ready";
      clearTimeout(authState.authTimer);
      unauthenticatedSockets.delete(socket);
      if (browserClient && browserClient !== socket) closeSocket(browserClient, 1012, "Replaced");
      browserClient = socket;
      browserVersion = authState.browserVersion;
      sendJson(socket, { type: "hello_ok", version: BRIDGE_VERSION });
      console.error("Brave extension mutually authenticated on localhost.");
      return;
    }
    closeSocket(socket, 1008, "Pairing failed");
    return;
  }

  if (message.type === "keepalive") {
    sendJson(socket, { type: "keepalive_ok", at: Date.now() });
    return;
  }
  if (message.type === "result" && typeof message.id === "string" && message.id.length <= 128) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(String(message.error || "Brave command failed").slice(0, 1000)));
  }
}

function validWebSocketKey(value) {
  if (typeof value !== "string") return false;
  try {
    return Buffer.from(value, "base64").length === 16;
  } catch {
    return false;
  }
}

const httpServer = createServer((_request, response) => {
  response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end("Brave Control bridge\n");
});

httpServer.on("upgrade", (request, socket) => {
  const origin = String(request.headers.origin || "");
  const originMatch = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  const key = request.headers["sec-websocket-key"];
  const upgrade = String(request.headers.upgrade || "").toLowerCase();
  const connection = String(request.headers.connection || "").toLowerCase();
  const version = String(request.headers["sec-websocket-version"] || "");
  const expectedHost = `${host}:${port}`;
  if (
    request.method !== "GET" || request.url !== "/bridge" || !originMatch ||
    request.headers.host !== expectedHost || upgrade !== "websocket" || !connection.split(/\s*,\s*/).includes("upgrade") ||
    version !== "13" || !validWebSocketKey(key) || unauthenticatedSockets.size >= MAX_UNAUTHENTICATED_CLIENTS
  ) {
    socket.destroy();
    return;
  }

  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n"));

  socket.setNoDelay(true);
  unauthenticatedSockets.add(socket);
  const frameState = { buffer: Buffer.alloc(0), fragments: [], fragmentBytes: 0 };
  const authState = {
    authenticated: false,
    phase: "hello",
    extensionId: originMatch[1],
    clientNonce: null,
    serverNonce: null,
    browserVersion: null,
    authTimer: setTimeout(() => closeSocket(socket, 1008, "Pairing timed out"), 5000)
  };
  socket.on("data", (chunk) => parseFrames(socket, chunk, frameState, (raw) => handleBrowserMessage(socket, raw, authState)));
  socket.on("error", () => {});
  socket.on("close", () => {
    clearTimeout(authState.authTimer);
    unauthenticatedSockets.delete(socket);
    if (browserClient === socket) {
      browserClient = null;
      browserVersion = null;
      rejectPending("The Brave extension disconnected");
      console.error("Brave extension disconnected.");
    }
  });
});

httpServer.on("error", (error) => {
  console.error(`Brave Control bridge failed: ${error.message}`);
  process.exitCode = 1;
});

httpServer.listen(port, host, () => {
  console.error(`Brave Control bridge listening on ws://${host}:${port}/bridge`);
});

function sendBrowserCommand(method, params = {}) {
  if (!browserClient || browserClient.destroyed) {
    return Promise.reject(new Error("Brave is not authenticated. Open the Brave Control extension popup and check its connection."));
  }
  if (pending.size >= MAX_PENDING_COMMANDS) return Promise.reject(new Error("Too many pending Brave commands"));
  const id = `command-${Date.now()}-${sequence += 1}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Brave command timed out: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    sendJson(browserClient, { type: "command", id, method, params });
  });
}

const tabProperty = { tab_id: { type: "integer", description: "Explicitly enabled tab ID; omit when exactly one tab is enabled." } };
const tools = [
  {
    name: "brave_status",
    description: "Check whether Brave is mutually authenticated and list only tabs the user explicitly enabled.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "brave_tabs",
    description: "List only Brave tabs explicitly enabled by the user, including whether control follows that tab across websites for the current Brave session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "brave_claim_tab",
    description: "Select an already enabled Brave tab using the exact id, title and URL returned by brave_tabs. This never enables another tab.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "integer" }, title: { type: "string" }, url: { type: "string" } },
      required: ["tab_id", "title", "url"],
      additionalProperties: false
    }
  },
  {
    name: "brave_open_tab",
    description: "Open a new HTTP(S) tab. For safety, the user must explicitly enable that tab and approve its destination from the extension popup before Codex can inspect or interact with it.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, active: { type: "boolean", default: true } },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "brave_snapshot",
    description: "Read a compact viewport snapshot from an enabled, approved Brave tab. Increase the limits only when the default result omits needed content. Sensitive field values are redacted on a best-effort basis.",
    inputSchema: {
      type: "object",
      properties: {
        ...tabProperty,
        max_elements: { type: "integer", minimum: 1, maximum: 400, default: 120 },
        max_text_chars: { type: "integer", minimum: 1000, maximum: 60000, default: 12000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "brave_screenshot",
    description: "Capture the current viewport of an enabled, approved Brave tab as an image.",
    inputSchema: {
      type: "object",
      properties: { ...tabProperty, format: { type: "string", enum: ["png", "jpeg"], default: "png" }, quality: { type: "integer", minimum: 1, maximum: 100, default: 80 } },
      additionalProperties: false
    }
  },
  {
    name: "brave_navigate",
    description: "Navigate an enabled tab to HTTP(S). A new origin needs popup approval unless the user enabled session-scoped cross-site control for that tab.",
    inputSchema: {
      type: "object",
      properties: { ...tabProperty, url: { type: "string" } },
      required: ["url"],
      additionalProperties: false
    }
  },
  ...["back", "forward", "reload"].map((action) => ({
    name: `brave_${action}`,
    description: `${action[0].toUpperCase() + action.slice(1)} the enabled Brave tab.`,
    inputSchema: { type: "object", properties: tabProperty, additionalProperties: false }
  })),
  {
    name: "brave_click",
    description: "Click or double-click an element from the latest viewport snapshot. Refresh the snapshot after the action.",
    inputSchema: {
      type: "object",
      properties: { ...tabProperty, element_id: { type: "string" }, click_count: { type: "integer", enum: [1, 2], default: 1 } },
      required: ["element_id"],
      additionalProperties: false
    }
  },
  {
    name: "brave_click_at",
    description: "Click coordinates inside the current viewport when no snapshot element is usable.",
    inputSchema: {
      type: "object",
      properties: { ...tabProperty, x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right", "middle"], default: "left" }, click_count: { type: "integer", enum: [1, 2], default: 1 } },
      required: ["x", "y"],
      additionalProperties: false
    }
  },
  {
    name: "brave_hover",
    description: "Move the pointer over an element from the latest viewport snapshot.",
    inputSchema: {
      type: "object",
      properties: { ...tabProperty, element_id: { type: "string" } },
      required: ["element_id"],
      additionalProperties: false
    }
  },
  {
    name: "brave_fill",
    description: "Set a non-sensitive input, textarea, select, or editable element value.",
    inputSchema: {
      type: "object",
      properties: { ...tabProperty, element_id: { type: "string" }, value: { type: "string" } },
      required: ["element_id", "value"],
      additionalProperties: false
    }
  },
  {
    name: "brave_type",
    description: "Type text into the focused non-sensitive element from the latest snapshot using browser input events.",
    inputSchema: {
      type: "object",
      properties: { ...tabProperty, element_id: { type: "string" }, text: { type: "string" } },
      required: ["element_id", "text"],
      additionalProperties: false
    }
  },
  {
    name: "brave_press",
    description: "Press a key or shortcut such as Enter, Escape, Tab, Control+A, or Shift+Tab outside sensitive fields.",
    inputSchema: {
      type: "object",
      properties: { ...tabProperty, key: { type: "string" } },
      required: ["key"],
      additionalProperties: false
    }
  },
  {
    name: "brave_select",
    description: "Select an HTML option by value or visible label.",
    inputSchema: {
      type: "object",
      properties: { ...tabProperty, element_id: { type: "string" }, value: { type: "string" } },
      required: ["element_id", "value"],
      additionalProperties: false
    }
  },
  {
    name: "brave_scroll",
    description: "Scroll the enabled Brave tab by pixel deltas.",
    inputSchema: {
      type: "object",
      properties: { ...tabProperty, delta_x: { type: "number", default: 0 }, delta_y: { type: "number", default: 600 } },
      additionalProperties: false
    }
  },
  {
    name: "brave_wait",
    description: "Wait for viewport text, a URL fragment, or a CSS selector after navigation or interaction.",
    inputSchema: {
      type: "object",
      properties: { ...tabProperty, condition: { type: "string", enum: ["text", "url", "selector"] }, value: { type: "string" }, timeout_ms: { type: "integer", minimum: 100, maximum: 30000, default: 10000 } },
      required: ["condition", "value"],
      additionalProperties: false
    }
  },
  {
    name: "brave_close_tab",
    description: "Close an enabled Brave tab.",
    inputSchema: { type: "object", properties: tabProperty, additionalProperties: false }
  },
  {
    name: "brave_release_tab",
    description: "Release an enabled Brave tab and detach browser automation.",
    inputSchema: { type: "object", properties: tabProperty, additionalProperties: false }
  },
  {
    name: "brave_disable_tab",
    description: "Compatibility alias for brave_release_tab.",
    inputSchema: { type: "object", properties: tabProperty, additionalProperties: false }
  }
];

async function callTool(name, args) {
  if (name === "brave_status") {
    if (!browserClient || browserClient.destroyed) return { connected: false, extension_version: null, tabs: [] };
    return { connected: true, extension_version: browserVersion, tabs: await sendBrowserCommand("tabs.list") };
  }
  if (name === "brave_tabs") {
    if (!browserClient || browserClient.destroyed) throw new Error("Brave is not authenticated");
    return sendBrowserCommand("tabs.list");
  }
  const method = {
    brave_claim_tab: "tab.claim",
    brave_open_tab: "tab.open",
    brave_snapshot: "tab.snapshot",
    brave_screenshot: "tab.screenshot",
    brave_navigate: "tab.navigate",
    brave_back: "tab.back",
    brave_forward: "tab.forward",
    brave_reload: "tab.reload",
    brave_click: "tab.click",
    brave_click_at: "tab.click_at",
    brave_hover: "tab.hover",
    brave_fill: "tab.fill",
    brave_type: "tab.type",
    brave_press: "tab.press",
    brave_select: "tab.select",
    brave_scroll: "tab.scroll",
    brave_wait: "tab.wait",
    brave_close_tab: "tab.close",
    brave_release_tab: "tab.disable",
    brave_disable_tab: "tab.disable"
  }[name];
  if (!method) throw new Error(`Unknown tool: ${name}`);
  const output = await sendBrowserCommand(method, args || {});
  if (name === "brave_screenshot") {
    return { __image: true, data: output.data, mimeType: output.mime_type || "image/png", tab_id: output.tab_id };
  }
  return output;
}

function writeRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleRpc(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
  if (message.method.startsWith("notifications/")) return;
  const id = message.id;
  try {
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "brave-control", version: BRIDGE_VERSION }
      };
    } else if (message.method === "ping") {
      result = {};
    } else if (message.method === "tools/list") {
      result = { tools };
    } else if (message.method === "tools/call") {
      const output = await callTool(message.params?.name, message.params?.arguments || {});
      if (output?.__image) {
        result = {
          content: [
            { type: "image", data: output.data, mimeType: output.mimeType },
            { type: "text", text: JSON.stringify({ tab_id: output.tab_id }, null, 2) }
          ],
          isError: false
        };
      } else {
        const serialized = message.params?.name === "brave_snapshot" ? JSON.stringify(output) : JSON.stringify(output, null, 2);
        result = { content: [{ type: "text", text: serialized }], isError: false };
      }
    } else {
      writeRpc({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      return;
    }
    writeRpc({ jsonrpc: "2.0", id, result });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (message.method === "tools/call") {
      writeRpc({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
    } else {
      writeRpc({ jsonrpc: "2.0", id, error: { code: -32000, message: text } });
    }
  }
}

let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  if (stdinBuffer.length > MAX_RPC_BUFFER_CHARS && !stdinBuffer.includes("\n")) {
    writeRpc({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "RPC message too large" } });
    stdinBuffer = "";
    return;
  }
  while (stdinBuffer.includes("\n")) {
    const newline = stdinBuffer.indexOf("\n");
    const line = stdinBuffer.slice(0, newline).trim();
    stdinBuffer = stdinBuffer.slice(newline + 1);
    if (!line) continue;
    if (line.length > MAX_RPC_BUFFER_CHARS) {
      writeRpc({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "RPC message too large" } });
      continue;
    }
    try {
      void handleRpc(JSON.parse(line));
    } catch {
      writeRpc({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
  }
});

process.on("SIGINT", () => httpServer.close(() => process.exit(0)));
process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
