const DEFAULT_PORT = 32123;

async function load() {
  const config = await chrome.storage.local.get(["port", "token"]);
  document.getElementById("port").value = config.port || DEFAULT_PORT;
  document.getElementById("token").value = config.token || "";
}

document.getElementById("save").addEventListener("click", async () => {
  const port = Number(document.getElementById("port").value);
  const token = document.getElementById("token").value.trim();
  const message = document.getElementById("message");
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[a-f0-9]{64}$/i.test(token)) {
    message.textContent = "Enter a valid port and a 64-character hexadecimal token.";
    return;
  }
  await chrome.storage.local.set({ host: "127.0.0.1", port, token });
  await chrome.runtime.sendMessage({ type: "popup.reconnect" });
  message.textContent = "Saved.";
});

document.getElementById("clearSites").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "options.clearApprovals" });
  document.getElementById("clearMessage").textContent = result?.error ? result.error : " Site approvals cleared.";
});

void load();
