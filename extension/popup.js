let activeTab = null;
let enabled = false;
let siteApproved = false;
let crossSiteSession = false;
const ALL_SITE_PATTERNS = ["http://*/*", "https://*/*"];

function siteAccess(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { origin: url.origin, pattern: `${url.protocol}//${url.hostname}/*` };
  } catch {
    return null;
  }
}

function isLaunchTabUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if ((url.protocol === "brave:" || url.protocol === "chrome:") && url.hostname === "newtab") return true;
    if (url.protocol === "chrome-search:" && url.hostname === "local-ntp") return true;
    return url.protocol === "about:" && (url.pathname === "newtab" || url.pathname === "blank");
  } catch {
    return false;
  }
}

async function approveCurrentSite() {
  const access = siteAccess(activeTab?.url);
  if (!access) return false;
  const granted = await chrome.permissions.request({ origins: [access.pattern] });
  if (!granted) return false;
  const result = await chrome.runtime.sendMessage({ type: "popup.approve", tabId: activeTab.id, url: activeTab.url });
  if (result?.error) throw new Error(result.error);
  return true;
}

async function enableAcrossSites() {
  const granted = await chrome.permissions.request({ origins: ALL_SITE_PATTERNS });
  if (!granted) return false;
  const result = await chrome.runtime.sendMessage({ type: "popup.enableAcrossSites", tabId: activeTab.id });
  if (result?.error) {
    await chrome.runtime.sendMessage({ type: "popup.revokeUnusedAllSites" });
    throw new Error(result.error);
  }
  return true;
}

async function refresh() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const access = siteAccess(activeTab?.url);
  const launchOnly = isLaunchTabUrl(activeTab?.url);
  const claimable = Boolean(access || launchOnly);
  document.getElementById("site").textContent = access
    ? access.origin
    : launchOnly
      ? "Brave New Tab (navigation only)"
      : "This page cannot be controlled";

  const state = await chrome.runtime.sendMessage({ type: "popup.status", tabId: activeTab?.id });
  enabled = Boolean(state?.enabled);
  siteApproved = Boolean(state?.siteApproved);
  crossSiteSession = Boolean(state?.crossSiteSession);

  const bridge = document.getElementById("bridge");
  bridge.textContent = state?.connected ? "Authenticated" : "Waiting for Codex";
  bridge.className = state?.connected ? "ok" : "bad";

  const tabState = document.getElementById("tabState");
  tabState.textContent = enabled
    ? crossSiteSession
      ? "Enabled — follows this tab across websites"
      : access && !siteApproved
        ? "Enabled — site approval needed"
        : "Enabled — current site only"
    : "Disabled";
  tabState.className = enabled && (!access || siteApproved) ? "ok" : "bad";

  const toggle = document.getElementById("toggle");
  toggle.disabled = !claimable;
  toggle.textContent = enabled
    ? "Stop Codex control"
    : launchOnly
      ? "Allow Codex to navigate this tab"
      : "Allow Codex on this tab";
  toggle.style.background = enabled ? "#52525b" : "#fb542b";

  document.getElementById("modeChoice").hidden = enabled || !claimable;
  document.getElementById("follow").hidden = !(enabled && !crossSiteSession && claimable);
  document.getElementById("grant").hidden = !(enabled && access && !siteApproved && !crossSiteSession);
}

document.getElementById("toggle").addEventListener("click", async () => {
  if (!siteAccess(activeTab?.url) && !isLaunchTabUrl(activeTab?.url)) return;
  if (enabled) {
    const result = await chrome.runtime.sendMessage({ type: "popup.disable", tabId: activeTab.id });
    if (result?.error) throw new Error(result.error);
  } else {
    if (document.getElementById("acrossSites").checked) {
      if (!(await enableAcrossSites())) return;
    } else {
      if (siteAccess(activeTab.url) && !(await approveCurrentSite())) return;
      const result = await chrome.runtime.sendMessage({ type: "popup.enable", tabId: activeTab.id });
      if (result?.error) throw new Error(result.error);
    }
  }
  await refresh();
});

document.getElementById("follow").addEventListener("click", async () => {
  if (await enableAcrossSites()) await refresh();
});

document.getElementById("grant").addEventListener("click", async () => {
  if (await approveCurrentSite()) await refresh();
});

document.getElementById("reconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup.reconnect" });
  setTimeout(refresh, 500);
});

document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
void refresh();
