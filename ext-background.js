/**
 * KRYV-MCP Chrome Extension — Background Service Worker
 * File: ext-background.js
 * 
 * What it does:
 * - Every 5 minutes: collects open tabs, recent history
 * - Pushes compressed context to KRYV-MCP server
 * - Receives WhatsApp context from content script
 * - Stores everything locally first (privacy mode option)
 */

const KRYV_URL = "https://mcp.kryv.network";
const PUSH_URL = `${KRYV_URL}/push`;
const SYNC_INTERVAL_MINUTES = 5;

// ── Get config from storage ──
async function getConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(
      ["client_id", "kryv_url", "privacy_mode", "enabled"],
      resolve
    );
  });
}

// ── Collect open tabs context ──
async function collectTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter(t => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"))
    .map(t => ({
      title: t.title || "",
      url: t.url || "",
      active: t.active,
      domain: t.url ? new URL(t.url).hostname : "",
    }))
    .slice(0, 50); // max 50 tabs
}

// ── Collect recent browser history ──
async function collectHistory() {
  const cutoff = Date.now() - (24 * 60 * 60 * 1000); // last 24 hours
  const items = await chrome.history.search({
    text: "",
    startTime: cutoff,
    maxResults: 100,
  });
  return items.map(h => ({
    title: h.title || "",
    url: h.url || "",
    domain: h.url ? new URL(h.url).hostname : "",
    visits: h.visitCount,
    last_visit: new Date(h.lastVisitTime || 0).toISOString(),
  }));
}

// ── Push to KRYV server ──
async function pushToKryv(clientId, source, data, serverUrl) {
  const url = serverUrl ? `${serverUrl}/push` : PUSH_URL;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, source, data }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Store locally (privacy mode) ──
async function storeLocal(source, data) {
  const key = `context_${source}`;
  await chrome.storage.local.set({
    [key]: { data, updated_at: new Date().toISOString() }
  });
}

// ── Main sync function ──
async function syncContext() {
  const cfg = await getConfig();
  if (!cfg.enabled || !cfg.client_id) return;

  const [tabs, history] = await Promise.all([
    collectTabs(),
    collectHistory(),
  ]);

  const context = {
    tabs,
    history,
    collected_at: new Date().toISOString(),
    browser: "chrome",
    tab_count: tabs.length,
    history_count: history.length,
  };

  // Always store locally
  await storeLocal("browser_tabs", { tabs, collected_at: context.collected_at });
  await storeLocal("browser_history", { history: history.slice(0, 30), collected_at: context.collected_at });

  // Push to server if not in privacy mode
  if (!cfg.privacy_mode) {
    const serverUrl = cfg.kryv_url || KRYV_URL;
    await pushToKryv(cfg.client_id, "browser_tabs", { tabs }, serverUrl);
    await pushToKryv(cfg.client_id, "browser_history", { history: history.slice(0, 30) }, serverUrl);
  }

  // Update badge
  chrome.action.setBadgeText({ text: tabs.length.toString() });
  chrome.action.setBadgeBackgroundColor({ color: "#63b3ed" });
}

// ── Receive WhatsApp context from content script ──
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type !== "WHATSAPP_CONTEXT") return;
  const cfg = await getConfig();
  await storeLocal("whatsapp", msg.data);
  if (!cfg.privacy_mode && cfg.client_id) {
    const serverUrl = cfg.kryv_url || KRYV_URL;
    await pushToKryv(cfg.client_id, "whatsapp", msg.data, serverUrl);
  }
});

// ── Schedule sync every 5 minutes ──
chrome.alarms.create("kryv_sync", { periodInMinutes: SYNC_INTERVAL_MINUTES });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "kryv_sync") syncContext();
});

// ── Run on install / startup ──
chrome.runtime.onInstalled.addListener(() => syncContext());
chrome.runtime.onStartup.addListener(() => syncContext());
