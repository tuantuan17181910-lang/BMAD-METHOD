# Manual testing — Smart Translator Earphone (Chrome extension)

End-to-end manual test for the dual-ear stereo translation flow on YouTube.
The automated unit / integration tests live next to the code:

- `__tests__/translate.test.js` — free Google Translate provider (URL,
  query params, response parsing, errors).
- `__tests__/stt.test.js` — Whisper + Google Cloud STT adapters (endpoint,
  headers, request body shape, error handling).
- `__tests__/audio-capture.test.js` — `wrapPcmAsWav` header bytes,
  `downsample`, `floatToPcm16` clamping/scaling.
- `__tests__/offscreen.test.js` — buffer accumulation + STT → translate →
  TTS pipeline in `lib/translator-pipeline.js`, plus the YouTube
  caption-driven translator (zero-key path).
- `__tests__/youtube-captions.test.js` — `ytInitialPlayerResponse`
  parsing, caption-track selection (manual vs auto-generated), `json3`
  event parsing, and `findEventAt` segment lookup.
- `__tests__/whisper-wasm.test.js` — local Whisper wrapper: PCM →
  Float32 conversion, language code mapping, lazy model load with
  factory injection, AbortSignal handling, and result-text trimming.
- `../app/src/core/engine-router.test.ts` — dual-ear stereo, multi-utterance
  panning, and language-switching mid-session for the Expo app pipeline.

Run them with:

```bash
cd projects/smart-translator-earphone/extension && npm install && npm test
cd projects/smart-translator-earphone/app       && npm install && npm test
```

The remainder of this document covers what cannot be automated: real tab
audio capture inside Chrome, Web Speech TTS, and verifying that a real
pair of stereo earphones routes original audio to the left ear and the
translation to the right ear.

## Prerequisites

- Chrome / Edge / Brave **116+** (Manifest V3 + `chrome.offscreen`).
- Stereo earphones — wired is the easiest to verify because some Bluetooth
  stacks downmix to mono.
- An STT engine. Pick one of:
  - **YouTube captions** (default for YouTube tabs in `Auto` mode) —
    zero-key, zero-download. Only works on `youtube.com/watch` videos
    that already publish a caption track (manual or auto-generated).
  - **Whisper-WASM** (default fallback in `Auto` mode for non-YouTube
    tabs) — zero-key, runs locally; downloads `Xenova/whisper-tiny`
    (~40 MB quantised) from HuggingFace the first time a tab uses it,
    then caches it in the browser. Run `npm run build` once to produce
    the `dist/whisper-wasm.bundle.js` esbuild output before loading
    the extension.
  - **OpenAI Whisper API** — paid, `$0.006/min`
    ([keys](https://platform.openai.com/api-keys)).
  - **Google Cloud Speech-to-Text** — paid, free tier ~60 min/month
    ([credentials](https://console.cloud.google.com/apis/credentials)).
- Free Google Translate is built in; no translation key required.

## Build and load the extension

1. From the repo root:

   ```bash
   cd projects/smart-translator-earphone/extension
   npm install
   npm run build   # produces dist/whisper-wasm.bundle.js (~2 MB)
   ```

   The build step is only required for the Whisper-WASM provider; the
   YouTube captions / Whisper API / Google STT paths work without it.
   `dist/` is gitignored — re-run `npm run build` after pulling
   updates if you want Whisper-WASM available.

2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select
   `projects/smart-translator-earphone/extension/`.
5. Pin the **Smart Translator Earphone** action so the popup is one
   click away.

## Run the dual-ear translation (zero-key, YouTube)

1. Open a foreign-language YouTube video — Japanese / Korean / Mandarin /
   Spanish all work well. Pick one that has captions (the **CC** button
   on the player must be available).
2. Click the extension icon to open the popup.
3. **STT provider** → `Auto` (default) or `YouTube captions`. The API
   key field is hidden — you don't need one.
4. **Source language** → `Auto-detect` (or pin to a specific language to
   force a particular caption track if multiple are available).
5. **Target language** → Vietnamese (or anything you like).
6. ✅ **Stereo dual-ear (original L / translation R)**.
7. ✅ **Speak translation through Web Speech TTS**.
8. Click **Start**.
9. Chrome prompts for permission to capture the tab's audio — accept.

The popup status changes to `Listening (YouTube captions (zero-key))…`,
the **Original** field updates within ~250 ms of each on-screen caption,
and the **Translation** field follows. There is no STT round-trip
latency on this path, so the only delay is the Web Speech TTS speaking
out the translation.

## Run the dual-ear translation (zero-key, non-YouTube via Whisper-WASM)

For tabs that don't expose captions (Spotify, Twitch, podcast players,
in-app meetings, …) use the local Whisper-WASM engine — still no API
key, but it transcribes the captured tab audio.

1. Make sure `npm run build` was run at least once (see **Build and
   load the extension**).
2. Open the audio source.
3. Click the extension icon → **STT provider** → `Whisper-WASM in
browser` (or leave it on `Auto`, which picks Whisper-WASM
   automatically off-YouTube).
4. Configure source / target language and the dual-ear / TTS checkboxes
   as in the YouTube flow above.
5. Click **Start**, accept the tab-capture permission.

The status field reads `Loading Whisper-WASM (local) model (~40 MB on
first run)…` while `Xenova/whisper-tiny` downloads, then switches to
`Listening (Whisper-WASM (local))…`. Subsequent sessions reuse the
cached model and start in seconds.

## Run the dual-ear translation (paid STT)

If you want higher accuracy than Whisper-tiny, the paid engines remain
available.

1. Open the audio source.
2. Click the extension icon → **STT provider** → `OpenAI Whisper API`
   or `Google Cloud STT`.
3. Paste your STT **API key**.
4. Configure source / target language and the dual-ear / TTS
   checkboxes as in the YouTube flow above.
5. Click **Start**, accept the tab-capture permission.

Status changes to `Listening (OpenAI Whisper API)…` (or Google). The
**Original** field updates every ~4 s as each chunk finishes
transcribing.

## Expected behaviour

| Where to look                          | What you should see / hear                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| Left ear                               | Original audio from the YouTube video.                                           |
| Right ear                              | Web Speech TTS reading out the translation (~4–5 s after the matching original). |
| Popup → **Original** field             | Live transcript of the source language as STT returns it.                        |
| Popup → **Translation** field          | Translated text matching the original utterance.                                 |
| Popup → status                         | `Listening to tab…` while running.                                               |
| `chrome://extensions` → service worker | No errors after `Start`.                                                         |
| Offscreen document DevTools (Inspect)  | `[partial]` and `[translation]` log lines on each chunk.                         |

End-to-end latency is dominated by the 4-second chunk size + STT
round-trip. Anything in the 3–6 s range is normal.

## Regression checks

After making any change to the extension:

1. Click **Stop**, then **Start** again — transcript field clears, capture
   resumes without restarting Chrome.
2. Switch the **target language** mid-session (e.g. `vi → fr`), keep
   running, click **Start** again — new utterances should now arrive in
   the new language. Original audio should still pan left.
3. Open a video in a different language than the one you originally
   chose — with **Source language = Auto-detect**, the popup
   `[detectedLang]` value changes and translation continues.
4. Switch tabs while a capture is running — the original tab keeps
   streaming (Chrome only supports one captured tab at a time; this is
   documented behaviour, not a bug).
5. Click **Stop** — `speechSynthesis.cancel()` is called, queued
   utterances drop within ~1 s.
6. **Provider switching:** start with `YouTube captions` on a YouTube
   tab, **Stop**, switch the dropdown to `OpenAI Whisper API`, paste a
   key, **Start** again — the Original field now updates every ~4 s
   instead of every ~250 ms.
7. **Auto-mode routing:** with `Auto`, **Start** on a non-YouTube tab —
   the popup status reads `… (Whisper-WASM (local))…`. Switch back to
   a YouTube tab and the same `Auto` mode picks
   `YouTube captions (zero-key)` instead.
8. **Caption-less video:** open a YouTube video that has no captions
   (live stream without auto-captions, brand-new upload), pick
   `YouTube captions`, **Start** — the popup surfaces
   `Error: No caption tracks for this video`. Switch to Whisper-WASM
   (zero-key) to keep working.
9. **Cold model load:** uninstall + reinstall the extension, pick
   Whisper-WASM, click **Start** on a non-YouTube tab — the popup
   shows `Loading … model (~40 MB on first run)` and only the first
   chunk has the model-download latency. Subsequent chunks (~4 s
   each) finish in <1 s on a modern laptop with WebGPU enabled.

## Troubleshooting

| Symptom                                                  | Likely cause                                                                                                                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Silence in both ears after `Start`                       | Tab-capture permission was denied. Click the extension's **site access** toggle in `chrome://extensions` and try again.                                                       |
| `Start failed: Could not get media stream`               | The tab is muted by Chrome, or another extension already holds the capture. Refresh the tab.                                                                                  |
| `Whisper STT failed: HTTP 401`                           | Wrong / expired API key. Re-paste the key (it lives in `chrome.storage.session` only).                                                                                        |
| `Google STT failed: HTTP 403`                            | The Speech-to-Text API isn't enabled on the project the key belongs to.                                                                                                       |
| `No caption tracks for this video`                       | The YouTube video does not expose captions (no manual subtitles, auto-captions disabled). Switch the provider dropdown to `Whisper-WASM` (zero-key) or a paid engine instead. |
| `YouTube captions mode requires a youtube.com/watch tab` | The active tab is on YouTube but not on a `/watch?v=…` URL (e.g. `/feed/trending`). Open an actual video first.                                                               |
| `Could not parse ytInitialPlayerResponse`                | YouTube changed its watch-page HTML shape. File an issue; the captions provider needs a regex update.                                                                         |
| `Whisper-WASM bundle missing`                            | You haven't run `npm run build` since cloning, or `dist/` got wiped. Re-run the build and reload the extension.                                                               |
| Whisper-WASM stuck on `Loading … model`                  | First-run model download is ~40 MB; check the offscreen DevTools console for HF CDN errors and retry on a faster connection.                                                  |
| Translation lag > 10 s                                   | Slow network or rate-limited Google Translate endpoint. Try again in a minute.                                                                                                |
| Translation plays in **both** ears equally               | Web Speech TTS does not honour stereo panning. The original audio still pans left, so the right ear remains translation-dominant — this is expected.                          |
| Popup shows nothing in transcript                        | Open the offscreen document via `chrome://extensions` → **service worker** → **Inspect views: offscreen.html** and check the console for STT errors.                          |

## Cleanup

`chrome://extensions` → toggle the extension off, or **Remove** to fully
uninstall. The session-scoped API key is wiped automatically when Chrome
closes; settings (provider, languages, dual-ear / TTS toggles) persist in
`chrome.storage.local` until you reset the extension.
