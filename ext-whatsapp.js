/**
 * KRYV-MCP Chrome Extension — WhatsApp Web Content Script
 * File: ext-whatsapp.js
 * Injected into: https://web.whatsapp.com
 * 
 * Reads the WhatsApp Web DOM to extract recent chat context.
 * NEVER reads message content — only metadata (chat names, count).
 * Full message reading requires explicit user permission toggle.
 */

let lastPush = 0;
const MIN_INTERVAL_MS = 60 * 1000; // max once per minute

function extractWhatsAppContext() {
  const now = Date.now();
  if (now - lastPush < MIN_INTERVAL_MS) return;
  lastPush = now;

  try {
    // Extract chat list (left sidebar)
    const chatItems = document.querySelectorAll('[data-testid="cell-frame-container"]');
    const chats = [];
    chatItems.forEach((item, i) => {
      if (i >= 20) return; // max 20 chats
      const nameEl = item.querySelector('[data-testid="cell-frame-title"]') || item.querySelector('span[title]');
      const timeEl = item.querySelector('[data-testid="cell-frame-secondary"] span');
      const unreadEl = item.querySelector('[data-testid="icon-unread-count"]') || item.querySelector('.unread-count');
      chats.push({
        name: nameEl?.textContent?.trim() || nameEl?.getAttribute('title') || "Unknown",
        last_active: timeEl?.textContent?.trim() || null,
        has_unread: !!unreadEl,
      });
    });

    // Active chat title
    const activeChat = document.querySelector('[data-testid="conversation-header"] span[title]')?.getAttribute('title')
      || document.querySelector('header span[title]')?.getAttribute('title')
      || null;

    const ctx = {
      active_chat: activeChat,
      chat_count: chats.length,
      chats, // names + metadata only, no message content
      collected_at: new Date().toISOString(),
      source: "whatsapp_web",
      note: "Metadata only. No message content collected without explicit permission.",
    };

    chrome.runtime.sendMessage({ type: "WHATSAPP_CONTEXT", data: ctx });
  } catch {
    // Silently fail — WhatsApp DOM may have changed
  }
}

// Run when page loads and every 2 minutes
extractWhatsAppContext();
setInterval(extractWhatsAppContext, 2 * 60 * 1000);

// Also run when URL changes (chat switch)
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(extractWhatsAppContext, 1000);
  }
}).observe(document.body, { subtree: true, childList: true });
