/**
 * Offscreen document — owns the AudioContext and the chrome-specific
 * messaging. The actual translation pipeline lives in
 * `lib/translator-pipeline.js` so it can be unit-tested without the
 * `chrome.*` / `speechSynthesis` APIs.
 *
 * Two engine paths share this document:
 *   - PCM → STT → translate → speak (Whisper API / Google STT).
 *   - YouTube captions → translate → speak (zero-key fast path).
 *
 * In both cases the captured tab audio is panned to the left ear so
 * the right ear stays translation-dominant.
 *
 * Manifest V3 service workers can't hold a `MediaStream`, hence the
 * offscreen document.
 */

import { TabAudioCapture } from './lib/audio-capture.js';
import { transcribeWithGoogle, transcribeWithWhisper } from './lib/stt.js';
import { translateFree } from './lib/translate.js';
import { SAMPLE_RATE_HZ, createCaptionTranslator, createTranslator } from './lib/translator-pipeline.js';

let capture = null;
let cancelToken = null;
let translator = null;
let captionTranslator = null;
let activeProvider = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'start') {
    start(msg.streamId, msg.config)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        report({ kind: 'error', message: err?.message ?? String(err) });
        sendResponse({ ok: false, error: err?.message });
      });
    return true;
  }
  if (msg.type === 'stop') {
    stop()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message }));
    return true;
  }
  if (msg.type === 'yt-caption') {
    if (captionTranslator) {
      captionTranslator
        .onCaption({
          text: msg.text,
          lang: msg.lang,
          key: `${msg.startMs ?? 0}:${msg.text}`,
        })
        .catch((err) => report({ kind: 'error', message: err?.message ?? String(err) }));
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'yt-captions-ready') {
    report({ kind: 'status', state: 'listening', engine: 'youtube-captions' });
    return false;
  }
  return false;
});

async function start(streamId, config) {
  await stop();
  cancelToken = new AbortController();
  activeProvider = config.resolvedProvider ?? config.sttProvider;

  if (activeProvider === 'youtube-captions') {
    captionTranslator = createCaptionTranslator(config, {
      signal: cancelToken.signal,
      translate: (args) => translateFree(args),
      speak: (text, lang) => speakRight(text, lang),
      report,
    });
  } else {
    translator = createTranslator(config, {
      signal: cancelToken.signal,
      transcribe: (pcm, signal) => runStt(pcm, config, signal),
      translate: (args) => translateFree(args),
      speak: (text, lang) => speakRight(text, lang),
      report,
    });
  }

  capture = new TabAudioCapture();
  await capture.connect(streamId, {
    pan: config.dualEar ? 'left' : 'center',
    onPcm: (pcm) => {
      // In captions mode the PCM is only used for left-ear monitoring;
      // discard it instead of feeding STT.
      if (translator) translator.onPcm(pcm);
    },
  });
  if (activeProvider !== 'youtube-captions') {
    report({ kind: 'status', state: 'listening', engine: activeProvider });
  }
}

async function stop() {
  cancelToken?.abort();
  cancelToken = null;
  capture?.stop();
  capture = null;
  translator = null;
  captionTranslator = null;
  activeProvider = null;
  try {
    speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
  report({ kind: 'status', state: 'stopped' });
}

// Whisper-WASM is heavyweight (~2 MB bundle + 40 MB model on first
// run), so we only dynamic-import the bundle when the user actually
// asks for it.
let whisperWasmModulePromise = null;
let whisperWasmReady = false;

async function loadWhisperWasm() {
  if (!whisperWasmModulePromise) {
    whisperWasmModulePromise = import('./dist/whisper-wasm.bundle.js').catch((err) => {
      whisperWasmModulePromise = null;
      throw new Error(
        `Whisper-WASM bundle missing — run \`npm run build\` in the extension/ directory and reload (${err?.message ?? err})`,
      );
    });
  }
  return whisperWasmModulePromise;
}

async function runStt(pcm, config, signal) {
  if (config.resolvedProvider === 'whisper-wasm') {
    const mod = await loadWhisperWasm();
    if (!whisperWasmReady) {
      report({
        kind: 'status',
        state: 'loading-model',
        engine: 'whisper-wasm',
      });
      try {
        await mod.loadModel();
        whisperWasmReady = true;
        report({
          kind: 'status',
          state: 'listening',
          engine: 'whisper-wasm',
        });
      } catch (err) {
        whisperWasmModulePromise = null;
        throw err;
      }
    }
    return mod.transcribe({
      pcm,
      sampleRateHz: SAMPLE_RATE_HZ,
      sourceLang: config.sourceLang,
      signal,
    });
  }
  if (config.resolvedProvider === 'whisper' || config.sttProvider === 'whisper') {
    return transcribeWithWhisper({
      pcm,
      sampleRateHz: SAMPLE_RATE_HZ,
      sourceLang: config.sourceLang,
      apiKey: config.apiKey,
      signal,
    });
  }
  return transcribeWithGoogle({
    pcm,
    sampleRateHz: SAMPLE_RATE_HZ,
    sourceLang: config.sourceLang,
    apiKey: config.apiKey,
    signal,
  });
}

function speakRight(text, lang) {
  if (typeof speechSynthesis === 'undefined') return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  utter.rate = 1;
  utter.pitch = 1;
  utter.volume = 1;
  // The browser's speechSynthesis pans to both ears. The mic-side
  // panning we do in audio-capture.js sends original audio to the left
  // ear, so the mix still leaves the right ear translation-dominant.
  speechSynthesis.speak(utter);
}

function report(payload) {
  chrome.runtime.sendMessage({ target: 'popup', ...payload }).catch(() => {
    /* popup might be closed — fine */
  });
}
