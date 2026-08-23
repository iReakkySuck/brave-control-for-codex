import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = await readFile(path.join(root, "extension", "service-worker.js"), "utf8");
const allSites = ["http://*/*", "https://*/*"];
const grantedOrigins = new Set(allSites);

function storageArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const requested = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
      return Object.fromEntries(requested.map((key) => [key, data[key]]));
    },
    async set(values) { Object.assign(data, values); }
  };
}

const local = storageArea({
  port: 32123,
  token: "a".repeat(64),
  securityMigrationVersion: 1,
  approvedOrigins: []
});
const session = storageArea({ enabledTabs: [], crossSiteTabs: [] });
const tabs = new Map([
  [7, { id: 7, windowId: 1, title: "First", url: "https://first.example/", active: true }],
  [8, { id: 8, windowId: 1, title: "Second", url: "https://second.example/", active: false }]
]);

class QuietWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  constructor() { this.readyState = QuietWebSocket.CONNECTING; }
  addEventListener() {}
  close() { this.readyState = 3; }
  send() {}
}

const noopEvent = { addListener() {} };
const chrome = {
  runtime: {
    id: "a".repeat(32),
    getURL: (value) => `chrome-extension://${"a".repeat(32)}/${value}`,
    onInstalled: noopEvent,
    onStartup: noopEvent,
    onMessage: noopEvent
  },
  storage: { local, session },
  permissions: {
    async contains({ origins = [] }) { return origins.every((origin) => grantedOrigins.has(origin)); },
    async remove({ origins = [] }) {
      let removed = false;
      for (const origin of origins) removed = grantedOrigins.delete(origin) || removed;
      return removed;
    }
  },
  tabs: {
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error("Missing tab");
      return { ...tab };
    },
    onRemoved: noopEvent,
    onUpdated: noopEvent
  },
  debugger: {
    async attach() {},
    async detach() {},
    async sendCommand() { return {}; },
    onDetach: noopEvent
  },
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {}
  },
  scripting: { async executeScript() { return [{ result: {} }]; } }
};

const context = vm.createContext({
  chrome,
  console,
  crypto: webcrypto,
  fetch: async () => ({ ok: false }),
  WebSocket: QuietWebSocket,
  URL,
  TextEncoder,
  Uint8Array,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
});

vm.runInContext(workerSource, context, { filename: "service-worker.js" });
await new Promise((resolve) => setTimeout(resolve, 0));

for (const origin of allSites) grantedOrigins.add(origin);
await vm.runInContext("enableTab(7, true)", context);
assert.deepEqual(Array.from(session.data.enabledTabs), [7]);
assert.deepEqual(Array.from(session.data.crossSiteTabs), [7]);
assert.equal(await vm.runInContext('isTabUrlApproved(7, "https://different.example/path")', context), true);

await vm.runInContext("enableTab(8, true)", context);
await vm.runInContext("disableTab(7)", context);
assert.equal(grantedOrigins.has(allSites[0]), true, "Broad permission was removed while another cross-site tab remained");
assert.deepEqual(Array.from(session.data.crossSiteTabs), [8]);

await vm.runInContext("disableTab(8)", context);
assert.equal(grantedOrigins.has(allSites[0]), false);
assert.equal(grantedOrigins.has(allSites[1]), false);
assert.deepEqual(Array.from(session.data.crossSiteTabs), []);

for (const origin of allSites) grantedOrigins.add(origin);
session.data.enabledTabs = [7];
session.data.crossSiteTabs = [7];
await vm.runInContext("initializeExtension()", context);
assert.equal(grantedOrigins.has(allSites[0]), false);
assert.equal(grantedOrigins.has(allSites[1]), false);
assert.deepEqual(Array.from(session.data.enabledTabs), []);
assert.deepEqual(Array.from(session.data.crossSiteTabs), []);

console.log("PASS cross-site control stays scoped to enabled tab IDs");
console.log("PASS broad permission survives until the last cross-site tab stops");
console.log("PASS broad permission is revoked after the last cross-site tab stops");
console.log("PASS Brave startup clears controlled tabs and broad permission");
