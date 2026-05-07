/**
 * Tests for the buffering / pipeline logic that the offscreen document
 * delegates to. The Chrome-specific glue (chrome.runtime, AudioContext,
 * speechSynthesis) lives in `offscreen.js` and is exercised manually
 * via the steps in `TESTING.md`.
 */
import { describe, expect, test, vi } from 'vitest';
import { createCaptionTranslator, createTranslator } from '../lib/translator-pipeline.js';

function defaultDeps(overrides = {}) {
  return {
    transcribe: vi.fn(async () => ({ text: 'hello', detectedLang: 'en' })),
    translate: vi.fn(async ({ text, targetLang }) => ({
      text: `[${targetLang}] ${text}`,
    })),
    speak: vi.fn(),
    report: vi.fn(),
    chunkSamples: 8,
    ...overrides,
  };
}

describe('createTranslator — buffer accumulation', () => {
  test('does not flush until the buffer reaches chunkSamples', async () => {
    const deps = defaultDeps();
    const t = createTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    t.onPcm(new Int16Array(3));
    t.onPcm(new Int16Array(4));
    await t.flush();

    expect(deps.transcribe).not.toHaveBeenCalled();
  });

  test('flushes exactly one full chunk and keeps the remainder buffered', async () => {
    const deps = defaultDeps({ chunkSamples: 4 });
    const t = createTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    // Push 6 samples — one chunk (4) flushes, remainder (2) sits in buffer.
    t.onPcm(new Int16Array([1, 2, 3, 4, 5, 6]));
    await t.flush();

    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    const sentSamples = deps.transcribe.mock.calls[0][0];
    expect(sentSamples).toBeInstanceOf(Int16Array);
    expect(Array.from(sentSamples)).toEqual([1, 2, 3, 4]);
    expect(t.isBusy()).toBe(false);

    // Next two samples bring the buffer back up to the chunk size.
    t.onPcm(new Int16Array([7, 8]));
    await t.flush();
    expect(deps.transcribe).toHaveBeenCalledTimes(2);
    expect(Array.from(deps.transcribe.mock.calls[1][0])).toEqual([5, 6, 7, 8]);
  });

  test('drains multiple buffered chunks sequentially', async () => {
    const deps = defaultDeps({ chunkSamples: 2 });
    const t = createTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    t.onPcm(new Int16Array([1, 2, 3, 4, 5, 6]));
    await t.flush();

    expect(deps.transcribe).toHaveBeenCalledTimes(3);
    expect(Array.from(deps.transcribe.mock.calls[0][0])).toEqual([1, 2]);
    expect(Array.from(deps.transcribe.mock.calls[1][0])).toEqual([3, 4]);
    expect(Array.from(deps.transcribe.mock.calls[2][0])).toEqual([5, 6]);
  });

  test('does not run a second chunk concurrently while the first is in flight', async () => {
    let release;
    const inflight = new Promise((resolve) => {
      release = resolve;
    });
    const deps = defaultDeps({
      chunkSamples: 2,
      transcribe: vi.fn(async () => {
        await inflight;
        return { text: 'hello', detectedLang: 'en' };
      }),
    });

    const t = createTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    t.onPcm(new Int16Array([1, 2, 3, 4]));
    // First call starts immediately and is now busy.
    await Promise.resolve();
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(t.isBusy()).toBe(true);

    // Releasing the first call lets the second chunk drain.
    release();
    await t.flush();
    expect(deps.transcribe).toHaveBeenCalledTimes(2);
  });
});

describe('createTranslator — pipeline flow', () => {
  test('runs transcribe → translate → speak with the configured target language', async () => {
    const deps = defaultDeps({ chunkSamples: 4 });
    const t = createTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    t.onPcm(new Int16Array([1, 2, 3, 4]));
    await t.flush();

    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.translate).toHaveBeenCalledTimes(1);
    expect(deps.translate.mock.calls[0][0]).toMatchObject({
      text: 'hello',
      sourceLang: 'en', // detected language from STT wins over config
      targetLang: 'vi',
    });
    expect(deps.speak).toHaveBeenCalledWith('[vi] hello', 'vi');
  });

  test('emits partial + translation report payloads in order', async () => {
    const deps = defaultDeps({ chunkSamples: 4 });
    const t = createTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    t.onPcm(new Int16Array([1, 2, 3, 4]));
    await t.flush();

    const kinds = deps.report.mock.calls.map((c) => c[0].kind);
    expect(kinds).toEqual(['partial', 'translation']);
    expect(deps.report.mock.calls[0][0]).toMatchObject({
      kind: 'partial',
      text: 'hello',
      detectedLang: 'en',
    });
    expect(deps.report.mock.calls[1][0]).toMatchObject({
      kind: 'translation',
      original: 'hello',
      translated: '[vi] hello',
      detectedLang: 'en',
    });
  });

  test('skips translate + speak when STT returns no text', async () => {
    const deps = defaultDeps({
      chunkSamples: 4,
      transcribe: vi.fn(async () => ({ text: '' })),
    });
    const t = createTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    t.onPcm(new Int16Array([1, 2, 3, 4]));
    await t.flush();

    expect(deps.translate).not.toHaveBeenCalled();
    expect(deps.speak).not.toHaveBeenCalled();
    expect(deps.report).not.toHaveBeenCalled();
  });

  test('honours config.tts === false: no speak call', async () => {
    const deps = defaultDeps({ chunkSamples: 4 });
    const t = createTranslator({ sourceLang: 'auto', targetLang: 'vi', tts: false }, deps);

    t.onPcm(new Int16Array([1, 2, 3, 4]));
    await t.flush();

    expect(deps.translate).toHaveBeenCalledTimes(1);
    expect(deps.speak).not.toHaveBeenCalled();
  });

  test('reports an error when transcribe throws (non-abort)', async () => {
    const deps = defaultDeps({
      chunkSamples: 4,
      transcribe: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const t = createTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    t.onPcm(new Int16Array([1, 2, 3, 4]));
    await t.flush();

    expect(deps.report).toHaveBeenCalledWith({ kind: 'error', message: 'boom' });
    expect(deps.translate).not.toHaveBeenCalled();
    expect(deps.speak).not.toHaveBeenCalled();
  });

  test('does NOT report an error when the work is aborted', async () => {
    const deps = defaultDeps({
      chunkSamples: 4,
      transcribe: vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    });
    const t = createTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    t.onPcm(new Int16Array([1, 2, 3, 4]));
    await t.flush();

    expect(deps.report).not.toHaveBeenCalled();
  });

  test('falls back to config.sourceLang when STT does not detect a language', async () => {
    const deps = defaultDeps({
      chunkSamples: 4,
      transcribe: vi.fn(async () => ({ text: 'hej' })), // no detectedLang
    });
    const t = createTranslator({ sourceLang: 'sv', targetLang: 'vi' }, deps);

    t.onPcm(new Int16Array([1, 2, 3, 4]));
    await t.flush();

    expect(deps.translate.mock.calls[0][0].sourceLang).toBe('sv');
  });
});

describe('createCaptionTranslator (YouTube zero-key path)', () => {
  function captionDeps(overrides = {}) {
    return {
      translate: vi.fn(async ({ text, targetLang }) => ({
        text: `[${targetLang}] ${text}`,
      })),
      speak: vi.fn(),
      report: vi.fn(),
      ...overrides,
    };
  }

  test('runs translate → speak and emits partial+translation reports', async () => {
    const deps = captionDeps();
    const t = createCaptionTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    await t.onCaption({ text: 'Hello, world', lang: 'en', key: 'a' });

    expect(deps.translate).toHaveBeenCalledWith({
      text: 'Hello, world',
      sourceLang: 'en',
      targetLang: 'vi',
      signal: undefined,
    });
    expect(deps.speak).toHaveBeenCalledWith('[vi] Hello, world', 'vi');
    expect(deps.report.mock.calls.map((c) => c[0].kind)).toEqual(['partial', 'translation']);
  });

  test('skips empty / whitespace-only captions', async () => {
    const deps = captionDeps();
    const t = createCaptionTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    await t.onCaption({ text: '   ', lang: 'en' });
    await t.onCaption({ text: '', lang: 'en' });

    expect(deps.translate).not.toHaveBeenCalled();
    expect(deps.report).not.toHaveBeenCalled();
  });

  test('deduplicates back-to-back identical captions', async () => {
    const deps = captionDeps();
    const t = createCaptionTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    await t.onCaption({ text: 'foo', lang: 'en', key: 'k1' });
    await t.onCaption({ text: 'foo', lang: 'en', key: 'k1' });
    await t.onCaption({ text: 'foo', lang: 'en', key: 'k2' });

    expect(deps.translate).toHaveBeenCalledTimes(2);
  });

  test('honours config.tts === false: no speak call but translation still reported', async () => {
    const deps = captionDeps();
    const t = createCaptionTranslator({ sourceLang: 'auto', targetLang: 'vi', tts: false }, deps);

    await t.onCaption({ text: 'Hello', lang: 'en' });

    expect(deps.translate).toHaveBeenCalledTimes(1);
    expect(deps.speak).not.toHaveBeenCalled();
    expect(deps.report.mock.calls.find((c) => c[0].kind === 'translation')).toBeDefined();
  });

  test('reports an error when translate throws (non-abort)', async () => {
    const deps = captionDeps({
      translate: vi.fn(async () => {
        throw new Error('translate boom');
      }),
    });
    const t = createCaptionTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    await t.onCaption({ text: 'Hello', lang: 'en' });

    expect(deps.report.mock.calls.find((c) => c[0].kind === 'error')).toBeDefined();
    expect(deps.speak).not.toHaveBeenCalled();
  });

  test('does NOT report an error on AbortError', async () => {
    const deps = captionDeps({
      translate: vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    });
    const t = createCaptionTranslator({ sourceLang: 'auto', targetLang: 'vi' }, deps);

    await t.onCaption({ text: 'Hello', lang: 'en' });

    expect(deps.report.mock.calls.find((c) => c[0].kind === 'error')).toBeUndefined();
  });

  test('falls back to config.sourceLang when caption has no lang', async () => {
    const deps = captionDeps();
    const t = createCaptionTranslator({ sourceLang: 'ja', targetLang: 'vi' }, deps);

    await t.onCaption({ text: 'おはよう' });

    expect(deps.translate.mock.calls[0][0].sourceLang).toBe('ja');
  });
});
