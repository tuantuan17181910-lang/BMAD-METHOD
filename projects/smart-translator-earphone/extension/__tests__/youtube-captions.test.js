import { describe, expect, test } from 'vitest';
import {
  captionsJson3Url,
  extractPlayerResponse,
  extractVideoId,
  findEventAt,
  listCaptionTracks,
  parseJson3Events,
  pickCaptionTrack,
} from '../lib/youtube-captions.js';

describe('extractVideoId', () => {
  test('returns the v param from a watch URL', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  test('handles m.youtube.com', () => {
    expect(extractVideoId('https://m.youtube.com/watch?v=abc123')).toBe('abc123');
  });

  test('returns null for non-watch URLs', () => {
    expect(extractVideoId('https://www.youtube.com/feed/trending')).toBeNull();
    expect(extractVideoId('https://example.com/watch?v=abc')).toBeNull();
    expect(extractVideoId('not-a-url')).toBeNull();
  });

  test('returns null when v is empty', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=')).toBeNull();
    expect(extractVideoId('https://www.youtube.com/watch')).toBeNull();
  });
});

describe('extractPlayerResponse', () => {
  test('parses the embedded JSON blob from a watch HTML body', () => {
    const html = `<script>
      var foo = 1;
      ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc"},"captions":{"x":1}};
      var meta = 2;
    </script>`;
    expect(extractPlayerResponse(html)).toEqual({
      videoDetails: { videoId: 'abc' },
      captions: { x: 1 },
    });
  });

  test('returns null when the marker is missing', () => {
    expect(extractPlayerResponse('<html>no marker</html>')).toBeNull();
  });

  test('returns null on garbage / non-string input', () => {
    expect(extractPlayerResponse('')).toBeNull();
    expect(extractPlayerResponse(null)).toBeNull();
    expect(extractPlayerResponse(undefined)).toBeNull();
    expect(extractPlayerResponse(42)).toBeNull();
  });
});

describe('listCaptionTracks', () => {
  test('returns the captionTracks array', () => {
    const player = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: 'https://x', languageCode: 'en' }],
        },
      },
    };
    expect(listCaptionTracks(player)).toHaveLength(1);
  });

  test('returns [] when captions are missing', () => {
    expect(listCaptionTracks({})).toEqual([]);
    expect(listCaptionTracks(null)).toEqual([]);
    expect(listCaptionTracks(undefined)).toEqual([]);
  });
});

describe('pickCaptionTrack', () => {
  const tracks = [
    { baseUrl: 'a', languageCode: 'en', kind: 'asr' },
    { baseUrl: 'b', languageCode: 'en' },
    { baseUrl: 'c', languageCode: 'ja' },
    { baseUrl: 'd', languageCode: 'ja', kind: 'asr' },
  ];

  test('prefers manual over asr for the requested language', () => {
    expect(pickCaptionTrack(tracks, 'en')?.baseUrl).toBe('b');
    expect(pickCaptionTrack(tracks, 'ja')?.baseUrl).toBe('c');
  });

  test('falls back to asr when no manual track is available for that language', () => {
    const onlyAsr = [
      { baseUrl: 'x', languageCode: 'fr', kind: 'asr' },
      { baseUrl: 'y', languageCode: 'en' },
    ];
    expect(pickCaptionTrack(onlyAsr, 'fr')?.baseUrl).toBe('x');
  });

  test('on `auto`, prefers the first manual track over any asr', () => {
    expect(pickCaptionTrack(tracks, 'auto')?.baseUrl).toBe('b');
  });

  test('returns null on empty input', () => {
    expect(pickCaptionTrack([], 'en')).toBeNull();
    expect(pickCaptionTrack(null, 'en')).toBeNull();
  });
});

describe('captionsJson3Url', () => {
  test('forces fmt=json3 even if a different fmt is set', () => {
    const url = captionsJson3Url({
      baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=srv3&kind=asr',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('fmt')).toBe('json3');
    expect(parsed.searchParams.get('v')).toBe('abc');
    expect(parsed.searchParams.get('lang')).toBe('en');
    expect(parsed.searchParams.get('kind')).toBe('asr');
  });

  test('throws when baseUrl is missing', () => {
    expect(() => captionsJson3Url({})).toThrow(/baseUrl/);
  });
});

describe('parseJson3Events', () => {
  const json = {
    events: [
      {
        tStartMs: 1000,
        dDurationMs: 2000,
        segs: [{ utf8: 'Hello, ' }, { utf8: 'world!' }],
      },
      // event with no segs is dropped
      { tStartMs: 5000, dDurationMs: 100 },
      // whitespace-only event is dropped
      { tStartMs: 6000, dDurationMs: 100, segs: [{ utf8: '   ' }] },
      {
        tStartMs: 4000,
        dDurationMs: 1000,
        segs: [{ utf8: 'こんにちは' }],
      },
    ],
  };

  test('parses, sorts, drops empty events, and joins segs', () => {
    const events = parseJson3Events(json);
    expect(events).toEqual([
      { startMs: 1000, endMs: 3000, text: 'Hello, world!' },
      { startMs: 4000, endMs: 5000, text: 'こんにちは' },
    ]);
  });

  test('returns [] on missing / malformed input', () => {
    expect(parseJson3Events(null)).toEqual([]);
    expect(parseJson3Events({})).toEqual([]);
    expect(parseJson3Events({ events: 'nope' })).toEqual([]);
  });

  test('collapses multi-newline segs to single spaces', () => {
    const events = parseJson3Events({
      events: [
        {
          tStartMs: 0,
          dDurationMs: 1000,
          segs: [{ utf8: 'foo\n\nbar  baz' }],
        },
      ],
    });
    expect(events[0].text).toBe('foo bar baz');
  });
});

describe('findEventAt', () => {
  const events = [
    { startMs: 0, endMs: 1000, text: 'a' },
    { startMs: 1000, endMs: 2000, text: 'b' },
    { startMs: 2000, endMs: 3000, text: 'c' },
    { startMs: 3000, endMs: 4000, text: 'd' },
  ];

  test('finds the active event at a given playback time', () => {
    expect(findEventAt(events, 0.5)?.text).toBe('a');
    expect(findEventAt(events, 1.5)?.text).toBe('b');
    expect(findEventAt(events, 3.999)?.text).toBe('d');
  });

  test('returns the latest event that has started even if it ended', () => {
    // 5s — past the last event but within 5s tolerance.
    expect(findEventAt(events, 5)?.text).toBe('d');
  });

  test('returns null beyond the stale-rewind window', () => {
    expect(findEventAt(events, 100)).toBeNull();
  });

  test('returns null before any event has started', () => {
    expect(findEventAt([{ startMs: 5000, endMs: 6000, text: 'late' }], 1)).toBeNull();
  });

  test('returns null on empty input', () => {
    expect(findEventAt([], 0)).toBeNull();
    expect(findEventAt(null, 0)).toBeNull();
  });
});
