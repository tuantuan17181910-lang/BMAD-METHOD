import { describe, expect, test } from 'vitest';
import { downsample, floatToPcm16, wrapPcmAsWav } from '../lib/audio-capture.js';

function readString(view, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe('wrapPcmAsWav', () => {
  test('produces a valid 16-bit mono RIFF/WAVE container with the right header values', async () => {
    const samples = new Int16Array([0, 100, -100, 32_767, -32_768, 1234]);
    const sampleRate = 16_000;

    const blob = wrapPcmAsWav(samples, sampleRate);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('audio/wav');

    const arrayBuf = await blob.arrayBuffer();
    expect(arrayBuf.byteLength).toBe(44 + samples.length * 2);

    const view = new DataView(arrayBuf);
    expect(readString(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(readString(view, 8, 4)).toBe('WAVE');
    expect(readString(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM format code
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint32(28, true)).toBe(sampleRate * 2); // byte rate (mono * 2 bytes)
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(readString(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);

    // Round-trip the samples back out.
    for (let i = 0; i < samples.length; i++) {
      expect(view.getInt16(44 + i * 2, true)).toBe(samples[i]);
    }
  });

  test('handles a different sample rate (24 kHz)', async () => {
    const samples = new Int16Array([1, 2, 3]);
    const blob = wrapPcmAsWav(samples, 24_000);

    const view = new DataView(await blob.arrayBuffer());
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(24_000 * 2);
  });

  test('handles an empty PCM buffer', async () => {
    const blob = wrapPcmAsWav(new Int16Array(0), 16_000);
    const view = new DataView(await blob.arrayBuffer());
    expect(view.getUint32(40, true)).toBe(0);
    // RIFF size = 36 + dataSize.
    expect(view.getUint32(4, true)).toBe(36);
  });
});

describe('downsample', () => {
  test('returns the input unchanged when source and target rates match', () => {
    const buffer = new Float32Array([0.1, -0.2, 0.3]);
    expect(downsample(buffer, 16_000, 16_000)).toBe(buffer);
  });

  test('halves the length when target rate is half the source rate', () => {
    const buffer = new Float32Array(48); // 48 samples @ 48 kHz
    for (let i = 0; i < buffer.length; i++) buffer[i] = i;

    const out = downsample(buffer, 48_000, 24_000);

    expect(out.length).toBe(24);
    // First and last samples should still be in range (linear interp).
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[out.length - 1]).toBeLessThanOrEqual(buffer.length - 1);
  });

  test('linearly interpolates between source samples', () => {
    // Source @ 4 Hz: [0, 4, 8, 12]; target @ 2 Hz expects [0, 8].
    const buffer = new Float32Array([0, 4, 8, 12]);
    const out = downsample(buffer, 4, 2);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(8, 6);
  });
});

describe('floatToPcm16', () => {
  test('converts -1 .. +1 floats to int16 with proper asymmetric scaling', () => {
    const buf = new Float32Array([0, 1, -1, 0.5, -0.5]);
    const out = floatToPcm16(buf);

    expect(out).toBeInstanceOf(Int16Array);
    expect(out.length).toBe(buf.length);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0x7fff); // +1.0 * 0x7fff
    expect(out[2]).toBe(-0x8000); // -1.0 * 0x8000
    // Int16Array assignment truncates toward zero, so 0.5 * 0x7fff
    // (16383.5) becomes 16383 — keep this in lockstep with the impl.
    expect(out[3]).toBe(Math.trunc(0.5 * 0x7fff));
    expect(out[4]).toBe(Math.trunc(-0.5 * 0x8000));
  });

  test('clamps inputs outside [-1, 1] to int16 limits', () => {
    const buf = new Float32Array([2, -2, 1.5, -1.5]);
    const out = floatToPcm16(buf);
    expect(out[0]).toBe(0x7fff);
    expect(out[1]).toBe(-0x8000);
    expect(out[2]).toBe(0x7fff);
    expect(out[3]).toBe(-0x8000);
  });
});
