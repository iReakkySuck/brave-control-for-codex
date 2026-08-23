import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

for (const forbidden of ["config.json", "extension/pairing.json"]) {
  let found = false;
  try { await access(path.join(root, forbidden)); found = true; } catch { /* Expected. */ }
  if (found) throw new Error(`Private pairing file is present: ${forbidden}`);
}

const manifest = JSON.parse(await read("extension/manifest.json"));
if (manifest.version !== "0.3.5") throw new Error("Unexpected extension version");
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["http://127.0.0.1/*"])) {
  throw new Error("Required host permissions must remain localhost-only");
}
if (!manifest.optional_host_permissions?.includes("https://*/*")) throw new Error("Optional per-site HTTPS access is missing");

const plugin = JSON.parse(await read(".codex-plugin/plugin.json"));
if (plugin.version !== "0.3.5-beta.2") throw new Error("Unexpected plugin beta version");

const configExample = JSON.parse(await read("config.example.json"));
const pairingExample = JSON.parse(await read("extension/pairing.example.json"));
if (configExample.token !== null || pairingExample.token !== null) throw new Error("Example files must not contain tokens");

const worker = await read("extension/service-worker.js");
const openStart = worker.indexOf('if (method === "tab.open")');
const openEnd = worker.indexOf('if (method === "tab.navigate")', openStart);
const openBlock = worker.slice(openStart, openEnd);
if (openStart < 0 || openEnd < 0 || !openBlock.includes("enabled: false") || openBlock.includes("markTabControlled")) {
  throw new Error("New tabs must require explicit popup enablement");
}

for (const required of ["crossSiteTabs", "popup.enableAcrossSites", "revokeAllSitePermissionIfUnused", 'state === "all"']) {
  if (!worker.includes(required)) throw new Error(`Cross-site session safeguard is missing: ${required}`);
}

console.log("PASS release pairing policy");
console.log("PASS localhost and optional-origin permissions");
console.log("PASS explicit new-tab consent");
console.log("PASS session-scoped cross-site controls");
