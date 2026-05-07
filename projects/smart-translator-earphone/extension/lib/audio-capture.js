/**
 * Tab-audio capture helpers used inside the offscreen document.
 *
 * `connectStream(streamId, opts)` opens an `AudioContext`, plays the
 * captured tab audio back to the user (left channel by default), and
 * also feeds a low-latency PCM-16 mono 16 kHz callback that you can
 * forward to a streaming STT provider.
 *
 * Tab capture mutes the original tab while a `MediaStream` is held, so
 * we always re-emit the audio through Web Audio. Routing the original
 * to one ear (left) and TTS to the other (right) gives a UN-style
 * dual-ear experience without paying for hardware mixing.
 */

const TARGET_SAMPLE_RATE = 16_000;
const BUFFER_SIZE = 4096;

export class TabAudioCapture {
  /** @type {MediaStream | null} */
  stream = null;
  /** @type {AudioContext | null} */
  ctx = null;
  /** @type {ScriptProcessorNode | null} */
  processor = null;
  /** @type {MediaStreamAudioSourceNode | null} */
  source = null;

  /**
   * @param {string} streamId returned by `chrome.tabCapture.getMediaStreamId`.
   * @param {{ pan?: 'left' | 'right' | 'center'; onPcm: (pcm: Int16Array) => void }} opts
   */
  async connect(streamId, opts) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    this.stream = stream;
    const ctx = new AudioContext();
    this.ctx = ctx;
    const source = ctx.createMediaStreamSource(stream);
    this.source = source;

    // Playback path: pan to chosen ear so TTS can occupy the other.
    const pan = opts.pan ?? 'left';
    const playbackGain = ctx.createGain();
    playbackGain.gain.value = 1;
    source.connect(playbackGain);
    if (typeof ctx.createStereoPanner === 'function' && pan !== 'center') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan === 'left' ? -1 : 1;
      playbackGain.connect(panner);
      panner.connect(ctx.destination);
    } else {
      playbackGain.connect(ctx.destination);
    }

    // Analysis path: downsample → int16 PCM → STT callback.
    const processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    this.processor = processor;
    processor.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      const down = downsample(input, ctx.sampleRate, TARGET_SAMPLE_RATE);
      const pcm = floatToPcm16(down);
      opts.onPcm(pcm);
    };
    source.connect(processor);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    processor.connect(sink);
    sink.connect(ctx.destination);
  }

  stop() {
    try {
      this.processor?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.processor = null;
    this.source = null;
    this.ctx = null;
  }
}

/**
 * @param {Float32Array} buffer
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function downsample(buffer, fromRate, toRate) {
  if (fromRate === toRate) return buffer;
  const ratio = fromRate / toRate;
  const length = Math.round(buffer.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const x = i * ratio;
    const lo = Math.floor(x);
    const hi = Math.min(lo + 1, buffer.length - 1);
    const frac = x - lo;
    out[i] = buffer[lo] * (1 - frac) + buffer[hi] * frac;
  }
  return out;
}

/** @param {Float32Array} buf */
export function floatToPcm16(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const s = Math.max(-1, Math.min(1, buf[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Wrap raw int16 PCM samples in a WAV (RIFF) container so we can hand
 * them to non-streaming STT endpoints (Whisper, Google REST). 16-bit
 * mono.
 *
 * @param {Int16Array} samples
 * @param {number} sampleRateHz
 * @returns {Blob}
 */
export function wrapPcmAsWav(samples, sampleRateHz) {
  const byteLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + byteLength);
  const view = new DataView(buffer);
  let offset = 0;
  function writeString(s) {
    for (const c of s) view.setUint8(offset++, c.charCodeAt(0));
  }
  writeString('RIFF');
  view.setUint32(offset, 36 + byteLength, true);
  offset += 4;
  writeString('WAVE');
  writeString('fmt ');
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2; // PCM
  view.setUint16(offset, 1, true);
  offset += 2; // mono
  view.setUint32(offset, sampleRateHz, true);
  offset += 4;
  view.setUint32(offset, sampleRateHz * 2, true);
  offset += 4;
  view.setUint16(offset, 2, true);
  offset += 2; // block align
  view.setUint16(offset, 16, true);
  offset += 2; // bits per sample
  writeString('data');
  view.setUint32(offset, byteLength, true);
  offset += 4;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, samples[i], true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
