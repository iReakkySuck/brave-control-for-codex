const BRIDGE_VERSION = "0.3.5";
const AUTH_CONTEXT = "brave-control-auth-v1";
const DEFAULT_PORT = 32123;
const SECURITY_MIGRATION_VERSION = 1;
const MAX_SOCKET_MESSAGE_CHARS = 24 * 1024 * 1024;
const MAX_TEXT_INPUT_CHARS = 10000;
const DEFAULT_SNAPSHOT_ELEMENTS = 120;
const MAX_SNAPSHOT_ELEMENTS = 400;
const DEFAULT_SNAPSHOT_TEXT_CHARS = 12000;
const MAX_SNAPSHOT_TEXT_CHARS = 60000;
const ALL_SITE_PATTERNS = ["http://*/*", "https://*/*"];

let socket = null;
let reconnectTimer = null;
let keepaliveTimer = null;
let connected = false;
let pairingError = null;
let authSession = null;
let connectPromise = null;
const debuggerTabs = new Set();

function randomHex(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function hexBytes(value) {
  const normalized = String(value || "");
  if (!/^[a-f0-9]{64}$/i.test(normalized)) throw new Error("Invalid pairing token");
  return Uint8Array.from(normalized.match(/../g), (part) => Number.parseInt(part, 16));
}

async function hmacHex(token, value) {
  const key = await crypto.subtle.importKey("raw", hexBytes(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalHex(left, right) {
  const a = String(left || "").toLowerCase();
  const b = String(right || "").toLowerCase();
  if (a.length !== 64 || b.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

function authValue(role, clientNonce, serverNonce) {
  return `${AUTH_CONTEXT}:${role}:${clientNonce}:${serverNonce}:${chrome.runtime.id}`;
}

async function readPairingBootstrap() {
  try {
    const response = await fetch(chrome.runtime.getURL("pairing.json"), { cache: "no-store" });
    if (!response.ok) return null;
    const pairing = await response.json();
    const port = Number(pairing.port);
    const token = String(pairing.token || "");
    const revision = String(pairing.revision || "");
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[a-f0-9]{64}$/i.test(token) || !/^[a-zA-Z0-9_-]{8,128}$/.test(revision)) {
      return null;
    }
    return { port, token: token.toLowerCase(), revision };
  } catch {
    return null;
  }
}

async function syncPairingBootstrap() {
  const bootstrap = await readPairingBootstrap();
  if (!bootstrap) return;
  const stored = await chrome.storage.local.get(["pairingRevision"]);
  if (stored.pairingRevision !== bootstrap.revision) {
    await chrome.storage.local.set({
      host: "127.0.0.1",
      port: bootstrap.port,
      token: bootstrap.token,
      pairingRevision: bootstrap.revision
    });
  }
}

async function loadConfig() {
  await syncPairingBootstrap();
  const stored = await chrome.storage.local.get(["port", "token"]);
  const port = Number(stored.port || DEFAULT_PORT);
  const token = String(stored.token || "");
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error("Pairing is not configured. Run install.ps1 or enter the matching bridge token in Pairing settings.");
  }
  return { host: "127.0.0.1", port, token: token.toLowerCase() };
}

async function applySecurityMigration() {
  const stored = await chrome.storage.local.get(["securityMigrationVersion"]);
  if (Number(stored.securityMigrationVersion || 0) >= SECURITY_MIGRATION_VERSION) return;
  try {
    await chrome.permissions.remove({ origins: ["http://*/*", "https://*/*"] });
  } catch {
    // The broad permission may not have been granted on a fresh install.
  }
  await chrome.storage.local.set({ approvedOrigins: [], securityMigrationVersion: SECURITY_MIGRATION_VERSION });
}

function siteAccess(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { origin: url.origin, pattern: `${url.protocol}//${url.hostname}/*` };
  } catch {
    return null;
  }
}

function parseHttpUrl(rawUrl) {
  const text = String(rawUrl || "");
  if (!text || text.length > 8192) throw new Error("Enter a valid HTTP(S) URL");
  const url = new URL(text);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Only HTTP(S) URLs without embedded credentials are permitted");
  }
  return url;
}

async function approvedOrigins() {
  const stored = await chrome.storage.local.get(["approvedOrigins"]);
  return new Set(Array.isArray(stored.approvedOrigins) ? stored.approvedOrigins.filter((value) => typeof value === "string") : []);
}

async function saveApprovedOrigins(origins) {
  await chrome.storage.local.set({ approvedOrigins: [...origins].sort() });
}

async function isUrlApproved(rawUrl) {
  const access = siteAccess(rawUrl);
  if (!access) return false;
  const origins = await approvedOrigins();
  if (!origins.has(access.origin)) return false;
  return chrome.permissions.contains({ origins: [access.pattern] });
}

async function hasAllSitePermission() {
  return chrome.permissions.contains({ origins: ALL_SITE_PATTERNS });
}

async function isTabUrlApproved(tabId, rawUrl) {
  if (!siteAccess(rawUrl)) return false;
  const crossSite = await crossSiteTabIds();
  if (crossSite.has(Number(tabId)) && await hasAllSitePermission()) return true;
  return isUrlApproved(rawUrl);
}

async function approveTabOrigin(tabId, expectedUrl) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url !== expectedUrl) throw new Error("The tab changed before site approval. Reopen the popup and try again.");
  const access = siteAccess(tab.url);
  if (!access || !(await chrome.permissions.contains({ origins: [access.pattern] }))) {
    throw new Error("Brave did not grant access to this site");
  }
  const origins = await approvedOrigins();
  origins.add(access.origin);
  await saveApprovedOrigins(origins);
  const enabled = await enabledTabIds();
  if (enabled.has(tab.id)) {
    const crossSite = await crossSiteTabIds();
    await ensureDebugger(tab.id);
    await setBadgeState(tab.id, crossSite.has(tab.id) ? "all" : "on");
  }
  return { origin: access.origin, approved: true };
}

async function clearSiteApprovals() {
  const origins = await approvedOrigins();
  for (const origin of origins) {
    const access = siteAccess(origin);
    if (!access) continue;
    try { await chrome.permissions.remove({ origins: [access.pattern] }); } catch { /* Required localhost access cannot be removed. */ }
  }
  await saveApprovedOrigins(new Set());
  await saveCrossSiteTabs(new Set());
  try { await chrome.permissions.remove({ origins: ALL_SITE_PATTERNS }); } catch { /* Broad access may not be granted. */ }
  const enabled = await enabledTabIds();
  for (const tabId of enabled) {
    await detachDebugger(tabId);
    try {
      const tab = await chrome.tabs.get(tabId);
      await setBadgeState(tabId, isLaunchTabUrl(tab.url) ? "on" : "ask");
    } catch { /* Tab may have closed. */ }
  }
}

async function enabledTabIds() {
  const state = await chrome.storage.session.get("enabledTabs");
  return new Set(Array.isArray(state.enabledTabs) ? state.enabledTabs.filter(Number.isInteger) : []);
}

async function saveEnabledTabs(ids) {
  await chrome.storage.session.set({ enabledTabs: [...ids] });
}

async function crossSiteTabIds() {
  const state = await chrome.storage.session.get("crossSiteTabs");
  return new Set(Array.isArray(state.crossSiteTabs) ? state.crossSiteTabs.filter(Number.isInteger) : []);
}

async function saveCrossSiteTabs(ids) {
  await chrome.storage.session.set({ crossSiteTabs: [...ids] });
}

async function revokeAllSitePermissionIfUnused() {
  const crossSite = await crossSiteTabIds();
  if (crossSite.size) return;
  try { await chrome.permissions.remove({ origins: ALL_SITE_PATTERNS }); } catch { /* Broad access may not be granted. */ }
}

async function setBadgeState(tabId, state) {
  const text = state === "all" ? "ALL" : state === "on" ? "ON" : state === "ask" ? "ASK" : "";
  await chrome.action.setBadgeText({ tabId, text });
  if (state === "all") await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563EB" });
  if (state === "on") await chrome.action.setBadgeBackgroundColor({ tabId, color: "#16A34A" });
  if (state === "ask") await chrome.action.setBadgeBackgroundColor({ tabId, color: "#D97706" });
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

async function assertSitePermission(tab) {
  if (!siteAccess(tab?.url)) throw new Error("Only normal HTTP(S) pages can be controlled");
  if (!(await isTabUrlApproved(tab.id, tab.url))) {
    throw new Error("This exact site is not approved. Open the Brave Control popup on this tab and choose Grant access to this site.");
  }
}

async function ensureDebugger(tabId) {
  if (debuggerTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    debuggerTabs.add(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  } catch (error) {
    if (!String(error?.message || error).includes("already attached")) throw error;
    debuggerTabs.add(tabId);
  }
}

async function detachDebugger(tabId) {
  if (!debuggerTabs.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch { /* The tab may already be closed. */ }
  debuggerTabs.delete(tabId);
}

async function enableTab(tabId, acrossSites = false) {
  const tab = await chrome.tabs.get(tabId);
  const launchOnly = isLaunchTabUrl(tab.url);
  if (acrossSites && !(await hasAllSitePermission())) {
    throw new Error("Brave did not grant session-wide website access");
  }
  if (!launchOnly && !acrossSites) await assertSitePermission(tab);
  if (!launchOnly) await ensureDebugger(tabId);
  const ids = await enabledTabIds();
  ids.add(tabId);
  await saveEnabledTabs(ids);
  const crossSite = await crossSiteTabIds();
  if (acrossSites) crossSite.add(tabId);
  else crossSite.delete(tabId);
  await saveCrossSiteTabs(crossSite);
  if (launchOnly) {
    await detachDebugger(tabId);
    await setBadgeState(tabId, acrossSites ? "all" : "on");
  } else {
    await setBadgeState(tabId, acrossSites ? "all" : "on");
  }
  return { id: tab.id, title: tab.title, url: tab.url, window_id: tab.windowId, enabled: true, launch_only: launchOnly, site_approved: !launchOnly, cross_site_session: acrossSites };
}

async function disableTab(tabId) {
  const ids = await enabledTabIds();
  ids.delete(tabId);
  await saveEnabledTabs(ids);
  const crossSite = await crossSiteTabIds();
  crossSite.delete(tabId);
  await saveCrossSiteTabs(crossSite);
  await revokeAllSitePermissionIfUnused();
  await detachDebugger(tabId);
  try { await setBadgeState(tabId, "off"); } catch { /* The tab may already be closed. */ }
  return { id: tabId, enabled: false };
}

async function resolveEnabledTab(tabId) {
  const ids = await enabledTabIds();
  let resolved = tabId;
  if (resolved == null) {
    if (ids.size !== 1) throw new Error("Specify tab_id unless exactly one Brave tab is enabled");
    [resolved] = ids;
  }
  resolved = Number(resolved);
  if (!Number.isInteger(resolved) || !ids.has(resolved)) throw new Error("That Brave tab is not enabled. Enable it from the Brave Control popup first.");
  return chrome.tabs.get(resolved);
}

async function assertEnabled(tabId) {
  const tab = await resolveEnabledTab(tabId);
  if (isLaunchTabUrl(tab.url)) {
    throw new Error("This New Tab is enabled for navigation only. Navigate it to HTTP(S), then approve the destination site from the extension popup.");
  }
  await assertSitePermission(tab);
  await ensureDebugger(tab.id);
  return tab;
}

async function listTabs() {
  const enabled = await enabledTabIds();
  const crossSite = await crossSiteTabIds();
  const output = [];
  let changed = false;
  for (const tabId of enabled) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      enabled.delete(tabId);
      changed = true;
      continue;
    }
    const launchOnly = isLaunchTabUrl(tab.url);
    output.push({
      id: tab.id,
      window_id: tab.windowId,
      title: tab.title || "",
      url: tab.url || "",
      active: Boolean(tab.active),
      controlled: true,
      launch_only: launchOnly,
      site_approved: launchOnly ? false : await isTabUrlApproved(tab.id, tab.url),
      cross_site_session: crossSite.has(tab.id)
    });
  }
  if (changed) await saveEnabledTabs(enabled);
  return output;
}

async function claimTab(params) {
  const tab = await resolveEnabledTab(Number(params.tab_id));
  const crossSite = await crossSiteTabIds();
  if (tab.title !== params.title || tab.url !== params.url) {
    throw new Error("The enabled tab changed after it was listed. List tabs again and use the fresh title and URL.");
  }
  return {
    id: tab.id,
    title: tab.title || "",
    url: tab.url || "",
    window_id: tab.windowId,
    enabled: true,
    launch_only: isLaunchTabUrl(tab.url),
    site_approved: await isTabUrlApproved(tab.id, tab.url),
    cross_site_session: crossSite.has(tab.id)
  };
}

function snapshotPage(options = {}) {
  const boundedInteger = (value, fallback, minimum, maximum) => {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(Math.max(number, minimum), maximum);
  };
  const maxElements = boundedInteger(options.max_elements, 120, 1, 400);
  const maxTextChars = boundedInteger(options.max_text_chars, 12000, 1000, 60000);
  const selector = [
    "a[href]", "button", "input", "textarea", "select", "summary", "details",
    "[role='button']", "[role='link']", "[role='checkbox']", "[role='radio']",
    "[role='tab']", "[role='option']", "[role='combobox']", "[contenteditable='true']"
  ].join(",");
  const inViewport = (rect) => rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return element.getAttribute("aria-hidden") !== "true" && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0.01 && rect.width > 0 && rect.height > 0 && inViewport(rect);
  };
  const labelFor = (element) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ").trim();
      if (text) return text;
    }
    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label?.innerText) return label.innerText.trim();
    }
    return String(element.getAttribute("aria-label") || element.innerText || element.textContent || element.getAttribute("placeholder") || element.getAttribute("title") || "").trim();
  };
  const sensitive = (element, label) => {
    const inputType = element instanceof HTMLInputElement ? (element.type || "text").toLowerCase() : "";
    const attributes = [
      element.getAttribute("autocomplete"), element.getAttribute("name"), element.id,
      element.getAttribute("placeholder"), element.getAttribute("aria-label"), label
    ].filter(Boolean).join(" ").toLowerCase();
    return inputType === "password" || /(?:password|passcode|one[- ]?time|verification code|auth(?:entication)? code|\botp\b|card number|security code|\bcvv\b|\bcvc\b|cc-|seed phrase|recovery code|private key)/i.test(attributes);
  };
  const viewportText = () => {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const parts = [];
    let total = 0;
    let truncated = false;
    let node;
    while ((node = walker.nextNode())) {
      const text = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
      const parent = node.parentElement;
      if (!text || !parent || !visible(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (![...range.getClientRects()].some(inViewport)) continue;
      const remaining = maxTextChars - total;
      if (remaining <= 0) { truncated = true; break; }
      const clipped = text.slice(0, Math.min(800, remaining));
      parts.push(clipped);
      total += clipped.length + 1;
      if (clipped.length < text.length) truncated = true;
      if (total >= maxTextChars) { truncated = true; break; }
    }
    return { text: parts.join("\n").slice(0, maxTextChars), truncated };
  };

  const elements = [];
  let elementsTruncated = false;
  for (const element of document.querySelectorAll(selector)) {
    if (!visible(element)) continue;
    if (elements.length >= maxElements) { elementsTruncated = true; break; }
    const id = `bc-${crypto.randomUUID()}`;
    element.setAttribute("data-brave-control-id", id);
    const rect = element.getBoundingClientRect();
    const inputType = element instanceof HTMLInputElement ? (element.type || "text") : null;
    const label = labelFor(element).slice(0, 200);
    const isSensitive = sensitive(element, label);
    const item = {
      index: elements.length,
      id,
      tag: element.tagName.toLowerCase(),
      label,
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
    const role = element.getAttribute("role");
    const expanded = element.getAttribute("aria-expanded");
    if (role) item.role = role;
    if (element.disabled) item.disabled = true;
    if (typeof element.checked === "boolean") item.checked = element.checked;
    if (typeof element.selected === "boolean") item.selected = element.selected;
    if (expanded != null) item.expanded = expanded;
    if (inputType) item.input_type = inputType;
    if (isSensitive) item.sensitive = true;
    if (element instanceof HTMLAnchorElement) item.href = element.href.slice(0, 2048);
    if ("value" in element) item.value = isSensitive ? "[redacted]" : String(element.value || "").slice(0, 300);
    elements.push(item);
  }
  const textSnapshot = viewportText();
  return {
    title: document.title,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight, scroll_x: scrollX, scroll_y: scrollY },
    visible_text: textSnapshot.text,
    elements,
    snapshot_limits: {
      max_elements: maxElements,
      max_text_chars: maxTextChars,
      elements_truncated: elementsTruncated,
      text_truncated: textSnapshot.truncated
    }
  };
}

function clickElement(elementId, clickCount) {
  const element = document.querySelector(`[data-brave-control-id="${CSS.escape(String(elementId))}"]`);
  if (!element) throw new Error("Element is no longer available; take a new snapshot");
  element.scrollIntoView({ block: "center", inline: "center" });
  if (Number(clickCount) === 2) element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
  else element.click();
  return { clicked: elementId, click_count: Number(clickCount) === 2 ? 2 : 1 };
}

function elementCenter(elementId) {
  const element = document.querySelector(`[data-brave-control-id="${CSS.escape(String(elementId))}"]`);
  if (!element) throw new Error("Element is no longer available; take a new snapshot");
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function fillElement(elementId, value) {
  const element = document.querySelector(`[data-brave-control-id="${CSS.escape(String(elementId))}"]`);
  if (!element) throw new Error("Element is no longer available; take a new snapshot");
  const inputType = element instanceof HTMLInputElement ? (element.type || "text").toLowerCase() : "";
  const attributes = [element.getAttribute("autocomplete"), element.getAttribute("name"), element.id, element.getAttribute("placeholder"), element.getAttribute("aria-label")].filter(Boolean).join(" ").toLowerCase();
  if (inputType === "password" || /(?:password|passcode|one[- ]?time|verification code|auth(?:entication)? code|\botp\b|card number|security code|\bcvv\b|\bcvc\b|cc-|seed phrase|recovery code|private key)/i.test(attributes)) {
    throw new Error("Brave Control refuses to fill sensitive fields");
  }
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element.isContentEditable)) {
    throw new Error("The selected element is not fillable");
  }
  element.focus();
  if (element instanceof HTMLSelectElement) element.value = value;
  else if (element.isContentEditable) element.textContent = value;
  else {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { filled: elementId };
}

function assertFocusedElementSafe(elementId) {
  const element = document.activeElement;
  if (!element || element instanceof HTMLIFrameElement) throw new Error("Typing into frames is blocked for safety");
  if (element.getAttribute("data-brave-control-id") !== elementId) throw new Error("Focus changed; take a fresh snapshot and click the intended element again");
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) throw new Error("The focused element is not typeable");
  const inputType = element instanceof HTMLInputElement ? (element.type || "text").toLowerCase() : "";
  const attributes = [element.getAttribute("autocomplete"), element.getAttribute("name"), element.id, element.getAttribute("placeholder"), element.getAttribute("aria-label")].filter(Boolean).join(" ").toLowerCase();
  if (inputType === "password" || /(?:password|passcode|one[- ]?time|verification code|auth(?:entication)? code|\botp\b|card number|security code|\bcvv\b|\bcvc\b|cc-|seed phrase|recovery code|private key)/i.test(attributes)) {
    throw new Error("Brave Control refuses to type into sensitive fields");
  }
  return true;
}

function focusedFieldIsSensitive() {
  const element = document.activeElement;
  if (!element) return false;
  if (element instanceof HTMLIFrameElement) return true;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element?.isContentEditable)) return false;
  const inputType = element instanceof HTMLInputElement ? (element.type || "text").toLowerCase() : "";
  const attributes = [element.getAttribute("autocomplete"), element.getAttribute("name"), element.id, element.getAttribute("placeholder"), element.getAttribute("aria-label")].filter(Boolean).join(" ").toLowerCase();
  return inputType === "password" || /(?:password|passcode|one[- ]?time|verification code|auth(?:entication)? code|\botp\b|card number|security code|\bcvv\b|\bcvc\b|cc-|seed phrase|recovery code|private key)/i.test(attributes);
}

function selectElement(elementId, value) {
  const element = document.querySelector(`[data-brave-control-id="${CSS.escape(String(elementId))}"]`);
  if (!(element instanceof HTMLSelectElement)) throw new Error("The selected element is no longer an HTML select menu");
  const option = [...element.options].find((entry) => entry.value === value || entry.label === value || entry.text === value);
  if (!option) throw new Error("No matching option was found");
  element.value = option.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: elementId, value: option.value, label: option.label || option.text };
}

function scrollPage(deltaX, deltaY) {
  window.scrollBy({ left: Number(deltaX) || 0, top: Number(deltaY) || 0, behavior: "instant" });
  return { scroll_x: scrollX, scroll_y: scrollY };
}

function checkWaitCondition(condition, value) {
  if (condition === "text") return String(document.body?.innerText || "").includes(String(value));
  if (condition === "url") return location.href.includes(String(value));
  if (condition === "selector") return Boolean(document.querySelector(String(value)));
  throw new Error("Unsupported wait condition");
}

function viewportSize() {
  return { width: innerWidth, height: innerHeight };
}

async function execute(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  if (!results?.length) throw new Error("The page did not return an execution result");
  return results[0].result;
}

async function cdp(tabId, method, params = {}) {
  await ensureDebugger(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

function limitedString(value, label, maximum = MAX_TEXT_INPUT_CHARS) {
  const text = String(value ?? "");
  if (text.length > maximum) throw new Error(`${label} is too long`);
  return text;
}

function elementId(value) {
  const id = String(value || "");
  if (!/^bc-[a-f0-9-]{36}$/i.test(id)) throw new Error("Use an element_id from the latest snapshot");
  return id;
}

async function clickAt(tabId, xValue, yValue, clickCount = 1, button = "left") {
  const x = finiteNumber(xValue, "x");
  const y = finiteNumber(yValue, "y");
  const viewport = await execute(tabId, viewportSize);
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) throw new Error("Click coordinates must be inside the current viewport");
  const count = Number(clickCount) === 2 ? 2 : 1;
  const safeButton = ["left", "right", "middle"].includes(button) ? button : "left";
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: safeButton, clickCount: count });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: safeButton, clickCount: count });
  return { x, y, button: safeButton, click_count: count };
}

async function pressKey(tabId, shortcut) {
  if (await execute(tabId, focusedFieldIsSensitive)) throw new Error("Key input is blocked while a sensitive field or frame is focused");
  const safeShortcut = limitedString(shortcut, "key", 64);
  const parts = safeShortcut.split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.pop() || "";
  if (!key) throw new Error("Enter a key or shortcut");
  let modifiers = 0;
  for (const part of parts) {
    const name = part.toLowerCase();
    if (name === "alt") modifiers |= 1;
    else if (name === "control" || name === "ctrl") modifiers |= 2;
    else if (name === "meta" || name === "command" || name === "cmd") modifiers |= 4;
    else if (name === "shift") modifiers |= 8;
    else throw new Error(`Unsupported modifier: ${part}`);
  }
  const code = key.length === 1 ? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : (/^[0-9]$/.test(key) ? `Digit${key}` : key)) : key;
  const downType = modifiers || key.length !== 1 ? "rawKeyDown" : "keyDown";
  const down = { type: downType, key, code, modifiers };
  if (!modifiers && key.length === 1) down.text = key;
  await cdp(tabId, "Input.dispatchKeyEvent", down);
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
  return { pressed: safeShortcut };
}

async function waitFor(tabId, condition, value, timeoutMs) {
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 10000, 100), 30000);
  while (Date.now() < deadline) {
    try {
      if (await execute(tabId, checkWaitCondition, [condition, value])) return { matched: true, condition, value };
    } catch { /* Navigation may briefly replace the document. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${condition}: ${value}`);
}

async function runCommand(method, params = {}) {
  if (method === "tabs.list") return listTabs();
  if (method === "tab.claim") return claimTab(params);
  if (method === "tab.disable") {
    const tab = await resolveEnabledTab(params.tab_id);
    return disableTab(tab.id);
  }
  if (method === "tab.open") {
    const destination = parseHttpUrl(params.url);
    const tab = await chrome.tabs.create({ url: destination.href, active: params.active !== false });
    return {
      id: tab.id,
      title: tab.title || "",
      url: tab.url || destination.href,
      window_id: tab.windowId,
      enabled: false,
      launch_only: false,
      site_approved: false,
      permission_required: true,
      user_action_required: "Open the Brave Control popup on this tab, then explicitly enable it and approve this site."
    };
  }
  if (method === "tab.navigate") {
    const tab = await resolveEnabledTab(params.tab_id);
    const destination = parseHttpUrl(params.url);
    const approved = await isTabUrlApproved(tab.id, destination.href);
    if (!approved) await detachDebugger(tab.id);
    await chrome.tabs.update(tab.id, { url: destination.href });
    return { tab_id: tab.id, url: destination.href, launch_only: false, site_approved: approved, permission_required: !approved };
  }
  if (method === "tab.close") {
    const tab = await resolveEnabledTab(params.tab_id);
    await chrome.tabs.remove(tab.id);
    return { tab_id: tab.id, closed: true };
  }

  const tab = await assertEnabled(params.tab_id);
  if (method === "tab.snapshot") {
    const maxElements = Math.min(Math.max(Number(params.max_elements) || DEFAULT_SNAPSHOT_ELEMENTS, 1), MAX_SNAPSHOT_ELEMENTS);
    const maxTextChars = Math.min(Math.max(Number(params.max_text_chars) || DEFAULT_SNAPSHOT_TEXT_CHARS, 1000), MAX_SNAPSHOT_TEXT_CHARS);
    return { tab_id: tab.id, ...(await execute(tab.id, snapshotPage, [{ max_elements: maxElements, max_text_chars: maxTextChars }])) };
  }
  if (method === "tab.screenshot") {
    const format = params.format === "jpeg" ? "jpeg" : "png";
    const quality = format === "jpeg" ? Math.min(Math.max(Number(params.quality) || 80, 1), 100) : undefined;
    const options = { format, fromSurface: true, captureBeyondViewport: false };
    if (quality != null) options.quality = quality;
    const result = await cdp(tab.id, "Page.captureScreenshot", options);
    return { tab_id: tab.id, data: result.data, mime_type: `image/${format}` };
  }
  if (method === "tab.back") { await chrome.tabs.goBack(tab.id); return { tab_id: tab.id }; }
  if (method === "tab.forward") { await chrome.tabs.goForward(tab.id); return { tab_id: tab.id }; }
  if (method === "tab.reload") { await chrome.tabs.reload(tab.id); return { tab_id: tab.id }; }
  if (method === "tab.click") return { tab_id: tab.id, ...(await execute(tab.id, clickElement, [elementId(params.element_id), params.click_count || 1])) };
  if (method === "tab.click_at") return { tab_id: tab.id, ...(await clickAt(tab.id, params.x, params.y, params.click_count, params.button || "left")) };
  if (method === "tab.hover") {
    const id = elementId(params.element_id);
    const point = await execute(tab.id, elementCenter, [id]);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    return { tab_id: tab.id, hovered: id };
  }
  if (method === "tab.fill") {
    const id = elementId(params.element_id);
    const value = limitedString(params.value, "value");
    return { tab_id: tab.id, ...(await execute(tab.id, fillElement, [id, value])) };
  }
  if (method === "tab.type") {
    const id = elementId(params.element_id);
    const text = limitedString(params.text, "text");
    await execute(tab.id, assertFocusedElementSafe, [id]);
    await cdp(tab.id, "Input.insertText", { text });
    return { tab_id: tab.id, typed: true };
  }
  if (method === "tab.press") return { tab_id: tab.id, ...(await pressKey(tab.id, params.key)) };
  if (method === "tab.select") {
    const id = elementId(params.element_id);
    const value = limitedString(params.value, "value", 1000);
    return { tab_id: tab.id, ...(await execute(tab.id, selectElement, [id, value])) };
  }
  if (method === "tab.scroll") {
    const deltaX = Math.max(-100000, Math.min(100000, finiteNumber(params.delta_x || 0, "delta_x")));
    const deltaY = Math.max(-100000, Math.min(100000, finiteNumber(params.delta_y ?? 600, "delta_y")));
    return { tab_id: tab.id, ...(await execute(tab.id, scrollPage, [deltaX, deltaY])) };
  }
  if (method === "tab.wait") {
    const condition = String(params.condition || "");
    if (!["text", "url", "selector"].includes(condition)) throw new Error("Unsupported wait condition");
    const value = limitedString(params.value, "value", 1000);
    return { tab_id: tab.id, ...(await waitFor(tab.id, condition, value, params.timeout_ms)) };
  }
  throw new Error(`Unsupported command: ${method}`);
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connect(), 2000);
}

async function connect() {
  clearTimeout(reconnectTimer);
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    let config;
    try {
      config = await loadConfig();
      pairingError = null;
    } catch (error) {
      pairingError = error instanceof Error ? error.message : String(error);
      connected = false;
      scheduleReconnect();
      return;
    }

    const currentSocket = new WebSocket(`ws://127.0.0.1:${config.port}/bridge`);
    const currentSession = { clientNonce: randomHex(), serverNonce: null, serverVerified: false, token: config.token };
    socket = currentSocket;
    authSession = currentSession;

    currentSocket.addEventListener("open", () => {
      if (socket !== currentSocket || currentSocket.readyState !== WebSocket.OPEN) return;
      currentSocket.send(JSON.stringify({
        type: "client_hello",
        client_nonce: currentSession.clientNonce,
        extension_id: chrome.runtime.id,
        browser: "brave-control",
        version: BRIDGE_VERSION
      }));
    });
    currentSocket.addEventListener("message", async (event) => {
      if (socket !== currentSocket) return;
      if (typeof event.data !== "string" || event.data.length > MAX_SOCKET_MESSAGE_CHARS) {
        currentSocket.close(1009, "Message too large");
        return;
      }
      let message;
      try { message = JSON.parse(event.data); } catch { currentSocket.close(1007, "Invalid JSON"); return; }

      if (message.type === "server_challenge" && !currentSession.serverVerified) {
        const serverNonce = String(message.server_nonce || "");
        if (!/^[a-f0-9]{64}$/i.test(serverNonce)) { currentSocket.close(1008, "Pairing failed"); return; }
        const expected = await hmacHex(currentSession.token, authValue("server", currentSession.clientNonce, serverNonce));
        if (!equalHex(expected, message.proof)) { currentSocket.close(1008, "Pairing failed"); return; }
        currentSession.serverNonce = serverNonce.toLowerCase();
        currentSession.serverVerified = true;
        const proof = await hmacHex(currentSession.token, authValue("client", currentSession.clientNonce, currentSession.serverNonce));
        if (socket === currentSocket && currentSocket.readyState === WebSocket.OPEN) {
          currentSocket.send(JSON.stringify({ type: "client_proof", proof }));
        }
        return;
      }
      if (message.type === "hello_ok" && currentSession.serverVerified) {
        connected = true;
        clearInterval(keepaliveTimer);
        keepaliveTimer = setInterval(() => {
          if (socket === currentSocket && currentSocket.readyState === WebSocket.OPEN && connected) {
            currentSocket.send(JSON.stringify({ type: "keepalive", at: Date.now() }));
          }
        }, 20000);
        return;
      }
      if (message.type !== "command" || !connected || !currentSession.serverVerified) return;
      if (typeof message.id !== "string" || message.id.length > 128 || typeof message.method !== "string" || message.method.length > 128) {
        currentSocket.close(1008, "Invalid command");
        return;
      }
      try {
        const result = await runCommand(message.method, message.params || {});
        if (socket === currentSocket && currentSocket.readyState === WebSocket.OPEN) {
          currentSocket.send(JSON.stringify({ type: "result", id: message.id, ok: true, result }));
        }
      } catch (error) {
        if (socket === currentSocket && currentSocket.readyState === WebSocket.OPEN) {
          currentSocket.send(JSON.stringify({ type: "result", id: message.id, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }));
        }
      }
    });
    currentSocket.addEventListener("close", () => {
      if (socket !== currentSocket) return;
      socket = null;
      connected = false;
      authSession = null;
      clearInterval(keepaliveTimer);
      scheduleReconnect();
    });
    currentSocket.addEventListener("error", () => {});
  })();

  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

async function initializeExtension() {
  await applySecurityMigration();
  await syncPairingBootstrap();
  await chrome.storage.session.set({ enabledTabs: [], crossSiteTabs: [] });
  try { await chrome.permissions.remove({ origins: ALL_SITE_PATTERNS }); } catch { /* Broad access may not be granted. */ }
  await connect();
}

chrome.runtime.onInstalled.addListener(() => { void initializeExtension(); });
chrome.runtime.onStartup.addListener(() => { void initializeExtension(); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: "Untrusted extension message" });
    return false;
  }
  void (async () => {
    if (message.type === "popup.status") {
      const ids = await enabledTabIds();
      const crossSite = await crossSiteTabIds();
      let siteApproved = false;
      try {
        const tab = await chrome.tabs.get(Number(message.tabId));
        siteApproved = await isTabUrlApproved(tab.id, tab.url);
      } catch { /* No active controllable tab. */ }
      sendResponse({ connected, pairingError, enabled: ids.has(Number(message.tabId)), siteApproved, crossSiteSession: crossSite.has(Number(message.tabId)) });
    } else if (message.type === "popup.approve") {
      sendResponse(await approveTabOrigin(Number(message.tabId), String(message.url || "")));
    } else if (message.type === "popup.enable") {
      sendResponse(await enableTab(Number(message.tabId)));
    } else if (message.type === "popup.enableAcrossSites") {
      sendResponse(await enableTab(Number(message.tabId), true));
    } else if (message.type === "popup.revokeUnusedAllSites") {
      await revokeAllSitePermissionIfUnused();
      sendResponse({ revokedIfUnused: true });
    } else if (message.type === "popup.disable") {
      sendResponse(await disableTab(Number(message.tabId)));
    } else if (message.type === "popup.reconnect") {
      if (socket) socket.close();
      await connect();
      sendResponse({ connected, pairingError });
    } else if (message.type === "options.clearApprovals") {
      await clearSiteApprovals();
      sendResponse({ cleared: true });
    } else {
      sendResponse({ error: "Unsupported extension message" });
    }
  })().catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) debuggerTabs.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => { void disableTab(tabId); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  void (async () => {
    const ids = await enabledTabIds();
    if (!ids.has(tabId)) return;
    if (isLaunchTabUrl(changeInfo.url)) {
      const crossSite = await crossSiteTabIds();
      await detachDebugger(tabId);
      await setBadgeState(tabId, crossSite.has(tabId) ? "all" : "on");
      return;
    }
    const crossSite = await crossSiteTabIds();
    if (await isTabUrlApproved(tabId, changeInfo.url)) {
      await ensureDebugger(tabId);
      await setBadgeState(tabId, crossSite.has(tabId) ? "all" : "on");
    } else {
      await detachDebugger(tabId);
      await setBadgeState(tabId, "ask");
    }
  })().catch(() => {});
});

void (async () => {
  await applySecurityMigration();
  await syncPairingBootstrap();
  await revokeAllSitePermissionIfUnused();
  await connect();
})();
