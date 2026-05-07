/**
 * Content script injected on demand into a YouTube watch page.
 *
 * Owns:
 *   - Discovering the active video element and reading `currentTime`.
 *   - Fetching the captions JSON for the current video.
 *   - Polling the player and posting `yt-caption` messages whenever
 *     the visible caption changes.
 *
 * It stays inert until the background sends `yt-watch-start`, and
 * tears itself down on `yt-watch-stop`. Because the script runs in
 * an isolated world, we read `ytInitialPlayerResponse` by re-fetching
 * the watch HTML (same-origin) instead of touching the page's
 * JavaScript globals.
 *
 * MV3 content scripts loaded via `chrome.scripting.executeScript`
 * are classic scripts, so we pull the pure helpers via dynamic
 * `import(chrome.runtime.getURL(...))` — the helpers module is
 * exposed in `web_accessible_resources`.
 */

const POLL_MS = 250;
const STALE_REWIND_MS = 5_000;

let pollTimer = null;
let events = [];
let lastEmittedStartMs = -1;
let trackLanguage = null;
let helpers = null;

async function getHelpers() {
  if (helpers) return helpers;
  helpers = await import(chrome.runtime.getURL('lib/youtube-captions.js'));
  return helpers;
}

function findVideoElement() {
  return document.querySelector('video.html5-main-video') ?? document.querySelector('video');
}

async function loadCaptions(videoId, sourceLang) {
  const h = await getHelpers();
  // Re-fetch the watch HTML so we get a fresh ytInitialPlayerResponse
  // (the page's globals aren't reachable from the isolated world).
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`watch HTML HTTP ${res.status}`);
  const html = await res.text();
  const player = h.extractPlayerResponse(html);
  if (!player) throw new Error('Could not parse ytInitialPlayerResponse');
  const tracks = h.listCaptionTracks(player);
  const track = h.pickCaptionTrack(tracks, sourceLang);
  if (!track) throw new Error('No caption tracks for this video');
  trackLanguage = track.languageCode ?? null;
  const captionsRes = await fetch(h.captionsJson3Url(track));
  if (!captionsRes.ok) throw new Error(`captions HTTP ${captionsRes.status}`);
  const json = await captionsRes.json();
  events = h.parseJson3Events(json);
  if (events.length === 0) throw new Error('Caption track has no segments');
}

async function tick() {
  const video = findVideoElement();
  if (!video) return;
  const h = await getHelpers();
  const ev = h.findEventAt(events, video.currentTime);
  if (!ev) return;
  // If the user rewound past our last emit, reset so we re-emit.
  if (ev.startMs < lastEmittedStartMs - STALE_REWIND_MS) {
    lastEmittedStartMs = -1;
  }
  if (ev.startMs === lastEmittedStartMs) return;
  lastEmittedStartMs = ev.startMs;
  chrome.runtime
    .sendMessage({
      target: 'offscreen',
      type: 'yt-caption',
      text: ev.text,
      startMs: ev.startMs,
      endMs: ev.endMs,
      lang: trackLanguage,
    })
    .catch(() => {
      // offscreen may have closed — ignore.
    });
}

async function start(sourceLang) {
  stop();
  const h = await getHelpers();
  const videoId = h.extractVideoId(location.href);
  if (!videoId) throw new Error('Not a YouTube watch page');
  await loadCaptions(videoId, sourceLang);
  pollTimer = setInterval(() => {
    void tick();
  }, POLL_MS);
  chrome.runtime
    .sendMessage({
      target: 'offscreen',
      type: 'yt-captions-ready',
      lang: trackLanguage,
      eventCount: events.length,
    })
    .catch(() => {});
}

function stop() {
  if (pollTimer != null) clearInterval(pollTimer);
  pollTimer = null;
  events = [];
  lastEmittedStartMs = -1;
  trackLanguage = null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'content-youtube') return false;
  if (msg.type === 'yt-watch-start') {
    start(msg.sourceLang)
      .then(() => sendResponse({ ok: true, lang: trackLanguage }))
      .catch((err) => sendResponse({ ok: false, error: err?.message }));
    return true;
  }
  if (msg.type === 'yt-watch-stop') {
    stop();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
