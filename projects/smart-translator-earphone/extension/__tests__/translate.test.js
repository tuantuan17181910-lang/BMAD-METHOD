import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { translateFree } from '../lib/translate.js';

describe('translateFree (Google free endpoint)', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns empty string for blank input without hitting the network', async () => {
    const result = await translateFree({
      text: '',
      sourceLang: 'auto',
      targetLang: 'vi',
    });

    expect(result).toEqual({ text: '' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('returns empty string for whitespace-only input', async () => {
    const result = await translateFree({
      text: '   \n\t',
      sourceLang: 'auto',
      targetLang: 'vi',
    });

    expect(result).toEqual({ text: '' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('parses joined segments + detected language from the response', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          [
            ['Xin chào, ', 'Hello, ', null, null, 1],
            ['bạn khoẻ không?', 'how are you?', null, null, 1],
          ],
          null,
          'en',
        ]),
        { status: 200 },
      ),
    );

    const result = await translateFree({
      text: 'Hello, how are you?',
      sourceLang: 'auto',
      targetLang: 'vi',
    });

    expect(result).toEqual({
      text: 'Xin chào, bạn khoẻ không?',
      detectedLang: 'en',
    });
  });

  test('builds the URL with the expected query parameters', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify([[['x', 'x', null, null, 1]], null, 'ja']), {
        status: 200,
      }),
    );

    await translateFree({
      text: 'こんにちは',
      sourceLang: 'ja',
      targetLang: 'vi',
    });

    const url = new URL(globalThis.fetch.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://translate.googleapis.com/translate_a/single');
    expect(url.searchParams.get('client')).toBe('gtx');
    expect(url.searchParams.get('sl')).toBe('ja');
    expect(url.searchParams.get('tl')).toBe('vi');
    expect(url.searchParams.get('dt')).toBe('t');
    expect(url.searchParams.get('q')).toBe('こんにちは');
  });

  test('defaults sl to "auto" when sourceLang is falsy', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify([[], null, null]), { status: 200 }));

    await translateFree({ text: 'hi', sourceLang: '', targetLang: 'vi' });

    const url = new URL(globalThis.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('sl')).toBe('auto');
  });

  test('throws on non-2xx HTTP responses', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));

    await expect(translateFree({ text: 'hi', sourceLang: 'auto', targetLang: 'vi' })).rejects.toThrow(/HTTP 429/);
  });

  test('forwards the AbortSignal to fetch', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify([[], null, null]), { status: 200 }));
    const controller = new AbortController();

    await translateFree({
      text: 'hi',
      sourceLang: 'auto',
      targetLang: 'vi',
      signal: controller.signal,
    });

    expect(globalThis.fetch.mock.calls[0][1]).toEqual({
      signal: controller.signal,
    });
  });
});
