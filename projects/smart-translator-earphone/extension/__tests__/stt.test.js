import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { transcribeWithGoogle, transcribeWithWhisper } from '../lib/stt.js';

function makeShortPcm() {
  // Two samples is enough — we just want a non-empty Int16Array so the
  // body shape is preserved. WAV / base64 encoding is exercised
  // separately in audio-capture.test.js.
  return new Int16Array([1234, -5678]);
}

describe('transcribeWithWhisper', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('POSTs multipart audio to /v1/audio/transcriptions with bearer auth', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ text: ' Hello world ', language: 'english' }), { status: 200 }));

    const result = await transcribeWithWhisper({
      pcm: makeShortPcm(),
      sampleRateHz: 16_000,
      sourceLang: 'auto',
      apiKey: 'sk-test-123',
    });

    expect(result).toEqual({ text: 'Hello world', detectedLang: 'english' });

    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer sk-test-123' });
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('model')).toBe('whisper-1');
    expect(init.body.get('response_format')).toBe('verbose_json');
    // 'auto' must NOT be forwarded as a language hint.
    expect(init.body.get('language')).toBeNull();
    const file = init.body.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('audio/wav');
  });

  test('forwards an explicit source language as the language form field', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: '', language: 'ja' }), {
        status: 200,
      }),
    );

    await transcribeWithWhisper({
      pcm: makeShortPcm(),
      sampleRateHz: 16_000,
      sourceLang: 'ja',
      apiKey: 'sk-test-123',
    });

    const init = globalThis.fetch.mock.calls[0][1];
    expect(init.body.get('language')).toBe('ja');
  });

  test('throws a descriptive error on HTTP failure', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response('invalid_api_key', { status: 401 }));

    await expect(
      transcribeWithWhisper({
        pcm: makeShortPcm(),
        sampleRateHz: 16_000,
        sourceLang: 'auto',
        apiKey: 'bad',
      }),
    ).rejects.toThrow(/Whisper STT failed: HTTP 401 invalid_api_key/);
  });

  test('returns empty text when the API returns no text field', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const result = await transcribeWithWhisper({
      pcm: makeShortPcm(),
      sampleRateHz: 16_000,
      sourceLang: 'auto',
      apiKey: 'sk-test-123',
    });

    expect(result.text).toBe('');
    expect(result.detectedLang).toBeUndefined();
  });
});

describe('transcribeWithGoogle', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('POSTs JSON LINEAR16 audio with the API key in the query string', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [{ alternatives: [{ transcript: 'Hello' }] }, { alternatives: [{ transcript: 'world' }] }],
        }),
        { status: 200 },
      ),
    );

    const result = await transcribeWithGoogle({
      pcm: makeShortPcm(),
      sampleRateHz: 16_000,
      sourceLang: 'auto',
      apiKey: 'AIza-test/with special?chars',
    });

    expect(result).toEqual({ text: 'Hello world' });

    const [url, init] = globalThis.fetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://speech.googleapis.com/v1/speech:recognize');
    expect(parsed.searchParams.get('key')).toBe('AIza-test/with special?chars');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body);
    expect(body.config).toEqual({
      encoding: 'LINEAR16',
      sampleRateHertz: 16_000,
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
    });
    expect(typeof body.audio.content).toBe('string');
    // base64 of 4 bytes (two int16 samples) = 8 chars (roughly).
    expect(body.audio.content.length).toBeGreaterThan(0);
  });

  test('forwards an explicit source language as languageCode', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));

    await transcribeWithGoogle({
      pcm: makeShortPcm(),
      sampleRateHz: 16_000,
      sourceLang: 'ja-JP',
      apiKey: 'AIza-test',
    });

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.config.languageCode).toBe('ja-JP');
  });

  test('throws on HTTP failure with the body included in the message', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response('PERMISSION_DENIED', { status: 403 }));

    await expect(
      transcribeWithGoogle({
        pcm: makeShortPcm(),
        sampleRateHz: 16_000,
        sourceLang: 'auto',
        apiKey: 'AIza-test',
      }),
    ).rejects.toThrow(/Google STT failed: HTTP 403 PERMISSION_DENIED/);
  });

  test('returns an empty transcript when the API has no results', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const result = await transcribeWithGoogle({
      pcm: makeShortPcm(),
      sampleRateHz: 16_000,
      sourceLang: 'auto',
      apiKey: 'AIza-test',
    });

    expect(result).toEqual({ text: '' });
  });
});
