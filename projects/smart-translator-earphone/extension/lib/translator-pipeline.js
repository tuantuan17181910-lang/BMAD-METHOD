/**
 * Pure, dependency-injected translator pipeline.
 *
 * Two entry points:
 *   - `createTranslator(config, deps)` — buffer PCM samples and run
 *     them through STT → translate → speak.
 *   - `createCaptionTranslator(config, deps)` — feed pre-transcribed
 *     caption text through translate → speak (used by the YouTube
 *     zero-key path).
 *
 * Both factories share the same `report()` event shape so the popup
 * UI doesn't care which engine produced the text.
 *
 * `deps` is shaped to make the chrome / DOM / fetch dependencies
 * trivial to mock from Node.js (see `__tests__/offscreen.test.js`).
 */

export const SAMPLE_RATE_HZ = 16_000;
export const CHUNK_SECONDS = 4;
export const CHUNK_SAMPLES = SAMPLE_RATE_HZ * CHUNK_SECONDS;

export function createTranslator(config, deps) {
  const { transcribe, translate, speak, report, signal, chunkSamples = CHUNK_SAMPLES } = deps;
  let buffer = new Int16Array(0);
  let busy = false;
  let pendingDrain = null;

  function appendBuffer(extra) {
    if (extra.length === 0) return;
    const merged = new Int16Array(buffer.length + extra.length);
    merged.set(buffer, 0);
    merged.set(extra, buffer.length);
    buffer = merged;
  }

  function takeChunk() {
    if (buffer.length < chunkSamples) return null;
    const chunk = buffer.slice(0, chunkSamples);
    buffer = buffer.slice(chunkSamples);
    return chunk;
  }

  async function processChunk(chunk) {
    let stt;
    try {
      stt = await transcribe(chunk, signal);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      report?.({ kind: 'error', message: err?.message ?? String(err) });
      return;
    }
    const text = (stt?.text ?? '').trim();
    if (!text) return;
    const detectedLang = stt?.detectedLang;
    report?.({ kind: 'partial', text, detectedLang });
    let result;
    try {
      result = await translate({
        text,
        sourceLang: detectedLang ?? config.sourceLang ?? 'auto',
        targetLang: config.targetLang,
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      report?.({ kind: 'error', message: err?.message ?? String(err) });
      return;
    }
    const translated = (result?.text ?? '').trim();
    if (!translated) return;
    report?.({
      kind: 'translation',
      original: text,
      translated,
      detectedLang,
    });
    if (config.tts !== false) speak?.(translated, config.targetLang);
  }

  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (buffer.length >= chunkSamples) {
        const chunk = takeChunk();
        if (!chunk) break;
        await processChunk(chunk);
      }
    } finally {
      busy = false;
    }
  }

  function onPcm(pcm) {
    appendBuffer(pcm);
    if (busy) return;
    pendingDrain = drain();
  }

  async function flush() {
    if (pendingDrain) await pendingDrain;
    if (busy) {
      // wait for the drain to clear, then re-check.
      while (busy) await Promise.resolve();
    }
    if (buffer.length >= chunkSamples) await drain();
  }

  return {
    onPcm,
    flush,
    isBusy: () => busy,
  };
}

/**
 * Caption-driven translator: skip the STT stage entirely, accept
 * already-transcribed text segments, and run them through translate
 * → speak. Used by the YouTube zero-key provider.
 *
 * Identical events / report shape as `createTranslator` so the popup
 * UI is engine-agnostic.
 */
export function createCaptionTranslator(config, deps) {
  const { translate, speak, report, signal } = deps;
  let lastKey = null;

  async function onCaption({ text, lang, key }) {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return;
    const dedupeKey = key ?? `${lang ?? ''}::${trimmed}`;
    if (dedupeKey === lastKey) return;
    lastKey = dedupeKey;
    report?.({ kind: 'partial', text: trimmed, detectedLang: lang });
    let result;
    try {
      result = await translate({
        text: trimmed,
        sourceLang: lang ?? config.sourceLang ?? 'auto',
        targetLang: config.targetLang,
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      report?.({ kind: 'error', message: err?.message ?? String(err) });
      return;
    }
    const translated = (result?.text ?? '').trim();
    if (!translated) return;
    report?.({
      kind: 'translation',
      original: trimmed,
      translated,
      detectedLang: lang,
    });
    if (config.tts !== false) speak?.(translated, config.targetLang);
  }

  return { onCaption };
}
