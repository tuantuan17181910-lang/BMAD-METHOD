/**
 * Service worker. Owns the offscreen document lifecycle, ferries
 * `chrome.tabCapture.getMediaStreamId()` results from the popup down
 * into it, and routes the YouTube captions content script when the
 * STT provider is `youtube-captions` (or `auto` resolves to it).
 *
 * Provider resolution:
 *   - `youtube-captions` — only valid on `youtube.com/watch` tabs.
 *   - `auto` — try YouTube captions on watch tabs, otherwise fall
 *     through to `whisper-wasm` (added in a follow-up commit) or the
 *     paid Whisper / Google STT engines if a key is present.
 */

const OFFSCREEN_URL = 'offscreen.html';

async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture and process tab audio for real-time translation.',
  });
}

function isYouTubeWatch(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === '/watch';
  } catch {
    return false;
  }
}

async function resolveProvider(provider, tab, _config) {
  if (provider !== 'auto') return provider;
  if (isYouTubeWatch(tab?.url)) return 'youtube-captions';
  // Off-YouTube fallback: zero-key local Whisper. Users who set an
  // explicit API key can still pick the paid engine from the dropdown.
  return 'whisper-wasm';
}

async function injectYouTubeContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-script-youtube.js'],
  });
}

async function startCapture(config) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');

  const resolvedProvider = await resolveProvider(config.sttProvider, tab, config);
  const finalConfig = { ...config, resolvedProvider };

  if (resolvedProvider === 'youtube-captions') {
    if (!isYouTubeWatch(tab.url)) {
      throw new Error('YouTube captions mode requires a youtube.com/watch tab');
    }
  }

  // Always grab the tab audio so we can route the original to the left
  // ear, even when STT is bypassed by the captions provider.
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message ?? 'tabCapture failed'));
      else resolve(id);
    });
  });
  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId,
    config: finalConfig,
  });
  await chrome.storage.session.set({
    capturedTabId: tab.id,
    activeProvider: resolvedProvider,
  });

  if (resolvedProvider === 'youtube-captions') {
    await injectYouTubeContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, {
      target: 'content-youtube',
      type: 'yt-watch-start',
      sourceLang: config.sourceLang,
    });
  }

  return { resolvedProvider };
}

async function stopCapture() {
  const stored = await chrome.storage.session.get(['capturedTabId', 'activeProvider']);
  const tabId = stored.capturedTabId;
  const provider = stored.activeProvider;
  if (provider === 'youtube-captions' && typeof tabId === 'number') {
    chrome.tabs
      .sendMessage(tabId, {
        target: 'content-youtube',
        type: 'yt-watch-stop',
      })
      .catch(() => {
        /* tab may have closed */
      });
  }
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
  } catch {
    /* offscreen may have closed */
  }
  await chrome.storage.session.remove(['capturedTabId', 'activeProvider']);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return false;
  if (msg.type === 'start') {
    startCapture(msg.config)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'stop') {
    stopCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});
