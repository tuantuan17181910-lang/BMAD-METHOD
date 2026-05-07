/**
 * Pure helpers for the YouTube zero-key path.
 *
 * The companion `content-script-youtube.js` runs inside a YouTube
 * watch tab and needs to (a) discover the available caption tracks
 * for the current video, (b) pull the json3 caption track, and
 * (c) find which segment matches the video's current playback time.
 *
 * This file contains only the parsing / selection logic so it can be
 * unit-tested in Node without DOM / `chrome.*` APIs.
 *
 * `ytInitialPlayerResponse` is an undocumented internal YouTube blob
 * embedded in the watch HTML. The captions endpoint is also internal
 * (`/api/timedtext?...&fmt=json3`). Both are subject to change without
 * notice — see TESTING.md for fallback guidance.
 */

const PLAYER_RESPONSE_RE = /ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})\s*;\s*(?:var\s+(?:meta|head)|<\/script|\n\s*<\/script)/;

/**
 * Pull the embedded `ytInitialPlayerResponse` JSON out of a watch page
 * HTML body. Returns the parsed object or `null` when the marker is
 * not found.
 */
export function extractPlayerResponse(html) {
  if (typeof html !== 'string' || html.length === 0) return null;
  const m = html.match(PLAYER_RESPONSE_RE);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Read the caption tracks list out of a parsed player response.
 * Returns an empty array when captions are unavailable.
 */
export function listCaptionTracks(playerResponse) {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(tracks) ? tracks : [];
}

/**
 * Pick the best caption track for the requested source language.
 *
 * Preference order:
 *   1. Manual (non-asr) track in the requested language.
 *   2. Auto-generated (asr) track in the requested language.
 *   3. Manual track in any language.
 *   4. Auto-generated track in any language.
 *
 * `sourceLang === 'auto'` collapses the language preference, so we
 * just take the first manual track and fall back to asr.
 */
export function pickCaptionTrack(tracks, sourceLang) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const wantLang = sourceLang && sourceLang !== 'auto' ? sourceLang : null;
  const manual = tracks.filter((t) => t?.kind !== 'asr');
  const asr = tracks.filter((t) => t?.kind === 'asr');
  const matchLang = (t) => t?.languageCode === wantLang;
  if (wantLang) {
    return manual.find(matchLang) ?? asr.find(matchLang) ?? manual[0] ?? asr[0];
  }
  return manual[0] ?? asr[0];
}

/**
 * Build the json3 captions URL from a track entry. Tracks come back
 * with `&fmt=srv3` or no fmt by default; we always force `fmt=json3`.
 */
export function captionsJson3Url(track) {
  if (!track?.baseUrl) throw new Error('Caption track is missing baseUrl');
  const u = new URL(track.baseUrl);
  u.searchParams.set('fmt', 'json3');
  return u.toString();
}

/**
 * Parse a json3 captions response into an ordered array of
 * `{ startMs, endMs, text }` segments. Empty / whitespace-only
 * segments are dropped.
 */
export function parseJson3Events(json) {
  const events = json?.events;
  if (!Array.isArray(events)) return [];
  const out = [];
  for (const e of events) {
    if (!Array.isArray(e?.segs)) continue;
    const text = e.segs
      .map((s) => (typeof s?.utf8 === 'string' ? s.utf8 : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const startMs = Number.isFinite(e.tStartMs) ? e.tStartMs : 0;
    const durationMs = Number.isFinite(e.dDurationMs) ? e.dDurationMs : 0;
    out.push({ startMs, endMs: startMs + durationMs, text });
  }
  // The API normally returns events ordered by tStartMs, but be
  // defensive in case a translated track interleaves them.
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

/**
 * Find the caption segment that should be visible at `currentTimeSec`.
 *
 * Segments occasionally overlap (interpolated word-level cues for live
 * captions). We pick the one whose start is the latest one still
 * before `currentTime`, mirroring what the YouTube player itself does.
 * Returns `null` when no segment has started yet.
 */
export function findEventAt(events, currentTimeSec) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const ms = currentTimeSec * 1000;
  let lo = 0;
  let hi = events.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const ev = events[found];
  // Ignore segments that have already ended a long time ago — protects
  // against "I rewound the video" producing stale captions.
  if (ev.endMs > 0 && ms > ev.endMs + 5_000) return null;
  return ev;
}

/**
 * Pull the videoId from a YouTube watch URL. Returns `null` when the
 * URL is not a watch URL.
 */
export function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    if (u.pathname !== '/watch') return null;
    const v = u.searchParams.get('v');
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}
