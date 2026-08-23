import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const nodePath = process.execPath;
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceServer = path.join(pluginRoot, "scripts", "server.mjs");
const token = randomBytes(32).toString("hex");
const extensionId = "a".repeat(32);
const context = "brave-control-auth-v1";

function proof(role, clientNonce, serverNonce) {
  return createHmac("sha256", Buffer.from(token, "hex"))
    .update(`${context}:${role}:${clientNonce}:${serverNonce}:${extensionId}`)
    .digest("hex");
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function clientFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const mask = randomBytes(4);
  let header;
  if (body.length < 126) header = Buffer.from([0x81, 0x80 | body.length]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  }
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function readServerFrame(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => finish(new Error("Timed out reading WebSocket frame")), 3000);
    function finish(error, value) {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error) reject(error); else resolve(value);
    }
    function onError(error) { finish(error); }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      }
      if (buffer.length < offset + length) return;
      const opcode = buffer[0] & 0x0f;
      const payload = buffer.subarray(offset, offset + length);
      if (opcode === 0x8) finish(new Error(`Socket closed: ${payload.subarray(2).toString("utf8")}`));
      else finish(null, JSON.parse(payload.toString("utf8")));
    }
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function openSocket(port, origin) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = Buffer.alloc(0);
    const timeout = setTimeout(() => finish(new Error("Handshake timed out")), 3000);
    function finish(error, value) {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error) reject(error); else resolve(value);
    }
    function onError(error) { finish(error); }
    function onData(chunk) {
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = response.subarray(0, end).toString("utf8");
      finish(null, { socket, accepted: head.startsWith("HTTP/1.1 101") });
    }
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write([
        "GET /bridge HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Origin: ${origin}`,
        "\r\n"
      ].join("\r\n"));
    });
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", () => {
      if (!response.length) finish(null, { socket, accepted: false });
    });
  });
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "brave-control-security-"));
const port = await freePort();
await mkdir(path.join(tempRoot, "scripts"));
await copyFile(sourceServer, path.join(tempRoot, "scripts", "server.mjs"));
await writeFile(path.join(tempRoot, "config.json"), JSON.stringify({ host: "127.0.0.1", port, token }));
const child = spawn(nodePath, [path.join(tempRoot, "scripts", "server.mjs")], { stdio: ["pipe", "pipe", "pipe"] });

try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Bridge did not start")), 3000);
    child.stderr.on("data", (chunk) => {
      if (chunk.toString().includes("listening")) { clearTimeout(timeout); resolve(); }
    });
    child.once("exit", (code) => reject(new Error(`Bridge exited early: ${code}`)));
  });

  const evil = await openSocket(port, "https://evil.example");
  if (evil.accepted) throw new Error("Web origin was incorrectly accepted");

  const valid = await openSocket(port, `chrome-extension://${extensionId}`);
  if (!valid.accepted) throw new Error("Valid extension origin was rejected");
  const clientNonce = randomBytes(32).toString("hex");
  valid.socket.write(clientFrame({ type: "client_hello", client_nonce: clientNonce, extension_id: extensionId, version: "test" }));
  const challenge = await readServerFrame(valid.socket);
  if (challenge.type !== "server_challenge" || challenge.proof !== proof("server", clientNonce, challenge.server_nonce)) {
    throw new Error("Server proof did not validate");
  }
  valid.socket.write(clientFrame({ type: "client_proof", proof: proof("client", clientNonce, challenge.server_nonce) }));
  const ready = await readServerFrame(valid.socket);
  if (ready.type !== "hello_ok") throw new Error("Mutual authentication did not complete");
  valid.socket.destroy();

  const invalid = await openSocket(port, `chrome-extension://${extensionId}`);
  const badNonce = randomBytes(32).toString("hex");
  invalid.socket.write(clientFrame({ type: "client_hello", client_nonce: badNonce, extension_id: extensionId, version: "test" }));
  await readServerFrame(invalid.socket);
  invalid.socket.write(clientFrame({ type: "client_proof", proof: "0".repeat(64) }));
  let rejected = false;
  try { await readServerFrame(invalid.socket); } catch { rejected = true; }
  if (!rejected) throw new Error("Invalid client proof was not rejected");
  invalid.socket.destroy();

  console.log("PASS origin rejection");
  console.log("PASS mutual authentication");
  console.log("PASS invalid-proof rejection");
} finally {
  child.kill("SIGTERM");
  await rm(tempRoot, { recursive: true, force: true });
}
