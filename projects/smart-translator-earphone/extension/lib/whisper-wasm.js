/**
 * Local Whisper provider — runs OpenAI Whisper in the browser via
 * `@huggingface/transformers` (formerly `@xenova/transformers`).
 *
 * This module is loaded only when the user picks the `whisper-wasm`
 * STT provider; until then no model is downloaded. The model itself
 * (~40 MB for `Xenova/whisper-tiny` quantised) is fetched from the
 * HuggingFace CDN on first transcription and then cached by the
 * library's own browser cache.
 *
 * The runtime contract mirrors `lib/stt.js`:
 *   `transcribe({ pcm, sampleRateHz, sourceLang, signal })` →
 *   `{ text, detectedLang }`.
 *
 * Because `@huggingface/transformers` is multi-megabyte and uses Web
 * Workers + WASM, this file expects to be run through `npm run build`
 * before the extension is loaded — the bundled output lands at
 * `dist/whisper-wasm.bundle.js` (gitignored). The dependency injection
 * in `loadModel` lets unit tests swap in a fake `pipeline` factory
 * without touching the real package.
 */

const DEFAULT_MODEL = 'Xenova/whisper-tiny';
const DEFAULT_QUANTIZED = true;

let cachedPipeline = null;
let cachedModel = null;

/**
 * Lazy-load the Whisper pipeline. Returns the cached instance on
 * subsequent calls. `factory` is the `pipeline` function from
 * `@huggingface/transformers`; tests can inject a stub.
 */
export async function loadModel({ factory, modelName = DEFAULT_MODEL, quantized = DEFAULT_QUANTIZED } = {}) {
  if (typeof factory !== 'function') {
    throw new Error('loadModel: a `factory` function is required');
  }
  if (cachedPipeline && cachedModel === modelName) return cachedPipeline;
  cachedPipeline = await factory('automatic-speech-recognition', modelName, {
    quantized,
  });
  cachedModel = modelName;
  return cachedPipeline;
}

/**
 * Reset the cached pipeline. Used by tests, and by callers that want
 * to swap the active model at runtime.
 */
export function resetModelCache() {
  cachedPipeline = null;
  cachedModel = null;
}

/**
 * Convert a 16-bit signed PCM buffer into the `Float32Array` that
 * transformers.js expects (mono, sample-rate-matched, range [-1, 1]).
 */
export function pcm16ToFloat32(pcm) {
  if (!(pcm instanceof Int16Array)) {
    throw new Error('pcm16ToFloat32: expected Int16Array');
  }
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    out[i] = pcm[i] / 32768;
  }
  return out;
}

/**
 * Map our `auto`/ISO-639-1 language code into the language hint the
 * Whisper pipeline accepts. Whisper takes a full English language
 * name (e.g. `"japanese"`) or the empty string for auto-detect.
 */
export function whisperLangFor(sourceLang) {
  if (!sourceLang || sourceLang === 'auto') return null;
  const map = {
    en: 'english',
    ja: 'japanese',
    ko: 'korean',
    zh: 'chinese',
    es: 'spanish',
    fr: 'french',
    de: 'german',
    ru: 'russian',
    th: 'thai',
    id: 'indonesian',
    vi: 'vietnamese',
    pt: 'portuguese',
    it: 'italian',
    nl: 'dutch',
    sv: 'swedish',
  };
  return map[sourceLang] ?? null;
}

/**
 * Run Whisper on a single PCM chunk.
 *
 * `deps.factory` defaults to the real transformers pipeline; tests
 * can pass a stub to avoid loading the package. `deps.signal` is an
 * `AbortSignal` — when aborted before the inference resolves the
 * promise rejects with `AbortError`.
 */
export async function transcribe({ pcm, sampleRateHz, sourceLang, signal }, deps = {}) {
  if (!(pcm instanceof Int16Array) || pcm.length === 0) {
    return { text: '', detectedLang: null };
  }
  if (signal?.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
  const pipe = await loadModel({
    factory: deps.factory,
    modelName: deps.modelName,
    quantized: deps.quantized,
  });
  if (signal?.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
  const audio = pcm16ToFloat32(pcm);
  const language = whisperLangFor(sourceLang);
  const result = await pipe(audio, {
    sampling_rate: sampleRateHz,
    language: language ?? undefined,
    task: 'transcribe',
    return_timestamps: false,
  });
  // The pipeline returns `{ text }` for single-chunk calls and
  // `{ text, chunks }` for chunked calls. We always run in
  // single-chunk mode here.
  const text = (result?.text ?? '').trim();
  return {
    text,
    detectedLang: language ?? sourceLang ?? null,
  };
}
