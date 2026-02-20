/**
 * KRYV-MCP Chrome Extension — WhatsApp Web Full Context
 * File: ext-whatsapp.js
 * 
 * Reads WhatsApp Web DOM for real message content.
 * User must enable "Read message content" in extension popup.
 * Default: metadata only (private). Full mode: user opt-in.
 */

let lastPush = 0;
const MIN_MS = 30 * 1000; // every 30 seconds max

function getConfig() {
  return new Promise(resolve =>
    chrome.storage.local.get(["whatsapp_full_mode", "enabled"], resolve)
  );
}

async function extractWhatsApp() {
  const now = Date.now();
  if (now - lastPush < MIN_MS) return;

  const cfg = await getConfig();
  if (!cfg.enabled) return;
  lastPush = now;

  try {
    // ── Active chat title ──
    const activeChatEl =
      document.querySelector('[data-testid="conversation-header"] span[title]') ||
      document.querySelector('header span[title]');
    const activeChat = activeChatEl?.getAttribute('title') || null;

    // ── Chat list (sidebar) ──
    const chatEls = document.querySelectorAll('[data-testid="cell-frame-container"]');
    const chats = [];
    chatEls.forEach((el, i) => {
      if (i >= 30) return;
      const nameEl = el.querySelector('[data-testid="cell-frame-title"]') || el.querySelector('span[title]');
      const timeEl = el.querySelector('[data-testid="cell-frame-secondary"] span');
      const previewEl = el.querySelector('[data-testid="last-msg-status"] + span') ||
                        el.querySelector('span.tailored-last-message-preview');
      const unreadEl = el.querySelector('[aria-label*="unread"]') || el.querySelector('.unread-count');
      chats.push({
        name: nameEl?.getAttribute('title') || nameEl?.textContent?.trim() || "Unknown",
        last_time: timeEl?.textContent?.trim() || null,
        preview: previewEl?.textContent?.trim() || null, // preview of last message
        has_unread: !!unreadEl,
      });
    });

    // ── Active conversation messages (FULL MODE — user opt-in) ──
    let messages = [];
    if (cfg.whatsapp_full_mode) {
      // Message bubbles in the current open chat
      const msgEls = document.querySelectorAll('[data-testid="msg-container"]');
      msgEls.forEach((el, i) => {
        if (i >= 50) return; // last 50 messages
        const textEl = el.querySelector('[data-testid="balloon-text-content"]') ||
                       el.querySelector('span.selectable-text');
        const timeEl = el.querySelector('[data-testid="msg-meta"] span') ||
                       el.querySelector('span[data-testid="msg-time"]');
        const isSent = el.closest('[class*="message-out"]') !== null ||
                       el.querySelector('[data-testid="msg-dbl-check"]') !== null;
        if (textEl?.textContent?.trim()) {
          messages.push({
            from: isSent ? "me" : activeChat || "them",
            text: textEl.textContent.trim(),
            time: timeEl?.textContent?.trim() || null,
          });
        }
      });
    }

    const ctx = {
      active_chat: activeChat,
      chat_count: chats.length,
      chats,
      messages: cfg.whatsapp_full_mode ? messages : [],
      full_mode: !!cfg.whatsapp_full_mode,
      collected_at: new Date().toISOString(),
      note: cfg.whatsapp_full_mode
        ? "Full message content enabled by user."
        : "Metadata + previews only. Enable full mode in KRYV extension popup for message content.",
    };

    chrome.runtime.sendMessage({ type: "WHATSAPP_CONTEXT", data: ctx });

  } catch (e) {
    // DOM changed — WhatsApp updates structure often
    console.debug("KRYV WhatsApp: DOM read failed", e);
  }
}

// Run on load
extractWhatsApp();
// Run every 30 seconds
setInterval(extractWhatsApp, 30 * 1000);
// Run on chat switch (URL change)
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    lastPush = 0; // reset throttle on chat switch
    setTimeout(extractWhatsApp, 800);
  }
}).observe(document.body, { subtree: true, childList: true });
