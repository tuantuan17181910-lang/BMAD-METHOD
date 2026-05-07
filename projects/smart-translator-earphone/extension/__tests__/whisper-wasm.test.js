import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadModel, pcm16ToFloat32, resetModelCache, transcribe, whisperLangFor } from '../lib/whisper-wasm.js';

afterEach(() => {
  resetModelCache();
});

describe('pcm16ToFloat32', () => {
  test('scales Int16 samples into [-1, 1]', () => {
    const pcm = new Int16Array([0, 16384, -16384, 32767, -32768]);
    const f32 = pcm16ToFloat32(pcm);
    expect(f32).toBeInstanceOf(Float32Array);
    expect(f32).toHaveLength(5);
    expect(f32[0]).toBe(0);
    expect(f32[1]).toBeCloseTo(0.5, 4);
    expect(f32[2]).toBeCloseTo(-0.5, 4);
    expect(f32[3]).toBeCloseTo(0.999969, 4);
    expect(f32[4]).toBeCloseTo(-1, 4);
  });

  test('throws on non-Int16 inputs', () => {
    expect(() => pcm16ToFloat32(new Float32Array([0.1]))).toThrow();
    expect(() => pcm16ToFloat32([0, 1, 2])).toThrow();
  });
});

describe('whisperLangFor', () => {
  test('maps ISO codes to whisper language names', () => {
    expect(whisperLangFor('en')).toBe('english');
    expect(whisperLangFor('ja')).toBe('japanese');
    expect(whisperLangFor('vi')).toBe('vietnamese');
  });

  test('returns null for `auto` / empty / unknown', () => {
    expect(whisperLangFor('auto')).toBeNull();
    expect(whisperLangFor('')).toBeNull();
    expect(whisperLangFor(undefined)).toBeNull();
    expect(whisperLangFor('xx')).toBeNull();
  });
});

describe('loadModel', () => {
  test('calls the factory exactly once across multiple loads', async () => {
    const fakePipeline = vi.fn(() => 'fake-pipe');
    const factory = vi.fn(async () => fakePipeline);

    const a = await loadModel({ factory });
    const b = await loadModel({ factory });
    const c = await loadModel({ factory });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('automatic-speech-recognition', 'Xenova/whisper-tiny', { quantized: true });
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe(fakePipeline);
  });

  test('reloads when the model name changes', async () => {
    const factory = vi.fn(async () => () => ({ text: 'ok' }));

    await loadModel({ factory, modelName: 'Xenova/whisper-tiny' });
    await loadModel({ factory, modelName: 'Xenova/whisper-base' });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[0][1]).toBe('Xenova/whisper-tiny');
    expect(factory.mock.calls[1][1]).toBe('Xenova/whisper-base');
  });

  test('forwards the `quantized` option', async () => {
    const factory = vi.fn(async () => () => ({ text: 'ok' }));
    await loadModel({ factory, quantized: false });
    expect(factory.mock.calls[0][2]).toEqual({ quantized: false });
  });

  test('throws when no factory is supplied', async () => {
    await expect(loadModel({})).rejects.toThrow(/factory/);
  });
});

describe('transcribe', () => {
  test('calls the model with Float32 audio + matching sample rate', async () => {
    const fakePipe = vi.fn(async () => ({ text: 'hello world' }));
    const factory = vi.fn(async () => fakePipe);

    const pcm = new Int16Array([100, -200, 300, -400]);
    const result = await transcribe({ pcm, sampleRateHz: 16_000, sourceLang: 'en' }, { factory });

    expect(result).toEqual({ text: 'hello world', detectedLang: 'english' });
    expect(fakePipe).toHaveBeenCalledTimes(1);
    const [audio, opts] = fakePipe.mock.calls[0];
    expect(audio).toBeInstanceOf(Float32Array);
    expect(audio).toHaveLength(4);
    expect(opts).toMatchObject({
      sampling_rate: 16_000,
      task: 'transcribe',
      return_timestamps: false,
      language: 'english',
    });
  });

  test('omits the `language` option when sourceLang is auto', async () => {
    const fakePipe = vi.fn(async () => ({ text: 'salut' }));
    const factory = vi.fn(async () => fakePipe);

    await transcribe({ pcm: new Int16Array([1, 2, 3]), sampleRateHz: 16_000, sourceLang: 'auto' }, { factory });

    expect(fakePipe.mock.calls[0][1].language).toBeUndefined();
  });

  test('returns empty result for an empty PCM buffer (no model load)', async () => {
    const factory = vi.fn();
    const r = await transcribe({ pcm: new Int16Array(), sampleRateHz: 16_000, sourceLang: 'en' }, { factory });
    expect(r).toEqual({ text: '', detectedLang: null });
    expect(factory).not.toHaveBeenCalled();
  });

  test('throws AbortError when the signal is already aborted', async () => {
    const factory = vi.fn();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      transcribe(
        {
          pcm: new Int16Array([1, 2, 3]),
          sampleRateHz: 16_000,
          sourceLang: 'en',
          signal: ctrl.signal,
        },
        { factory },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(factory).not.toHaveBeenCalled();
  });

  test('throws AbortError when the signal aborts during model load', async () => {
    const ctrl = new AbortController();
    let resolveFactory;
    const factory = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFactory = () => resolve(async () => ({ text: 'never' }));
        }),
    );
    const p = transcribe(
      {
        pcm: new Int16Array([1, 2, 3]),
        sampleRateHz: 16_000,
        sourceLang: 'en',
        signal: ctrl.signal,
      },
      { factory },
    );
    ctrl.abort();
    resolveFactory();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('trims whitespace around the transcript text', async () => {
    const factory = vi.fn(async () => async () => ({
      text: '  spaced out  ',
    }));
    const r = await transcribe({ pcm: new Int16Array([1]), sampleRateHz: 16_000, sourceLang: 'en' }, { factory });
    expect(r.text).toBe('spaced out');
  });
});
