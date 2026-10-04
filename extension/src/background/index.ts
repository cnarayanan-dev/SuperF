// Service worker: opens the overlay on the shortcut and relays embedding requests
// to the single offscreen document that holds the model.
import type { Envelope } from '../messages.ts';

async function openSearch(tab?: chrome.tabs.Tab): Promise<void> {
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'sf-toggle' });
  } catch (e) {
    // chrome:// pages, the Web Store and PDF viewers do not allow injection.
    console.warn('Semantic Find cannot run on this page:', e);
  }
}
Object.assign(globalThis, { openSearch }); // used by the smoke test

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-search') void openSearch(tab);
});
chrome.action.onClicked.addListener((tab) => void openSearch(tab));

let creating: Promise<void> | null = null;
async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (existing.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Run the local embedding model outside the page.',
    })
    .finally(() => { creating = null; });
  await creating;
}

async function toOffscreen(msg: Envelope): Promise<unknown> {
  await ensureOffscreen();
  for (let attempt = 0; ; attempt++) {
    try {
      return await chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
    } catch (e) {
      // The document can exist a moment before its listener is registered.
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

chrome.runtime.onMessage.addListener((msg: Envelope, sender, sendResponse) => {
  if (msg?.target !== 'bg' || !sender.tab?.id) return;
  toOffscreen({ ...msg, tabId: sender.tab.id }).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (existing.length) void chrome.runtime.sendMessage({ target: 'offscreen', type: 'drop', tabId }).catch(() => {});
});
