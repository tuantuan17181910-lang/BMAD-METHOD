/**
 * Bundle entry point for `npm run build`.
 *
 * `lib/whisper-wasm.js` accepts an injected `factory` so it stays
 * unit-testable from Node without pulling in `@huggingface/transformers`.
 * The runtime — the offscreen document — needs that factory to be the
 * real `pipeline` function, which is multi-megabyte and pulls in the
 * ONNX runtime + Web Workers + WASM.
 *
 * This entry file is what esbuild bundles into
 * `dist/whisper-wasm.bundle.js`. The offscreen document dynamic-imports
 * that bundle on first whisper-wasm request, so the heavy dependencies
 * never load when the user is on a YouTube tab using the captions
 * provider.
 */
import { env, pipeline } from '@huggingface/transformers';
import * as whisper from './whisper-wasm.js';

// `transformers.js` defaults try to load Node-only deps when the
// global `process` is detected. In an offscreen document we want the
// browser path explicitly.
env.allowLocalModels = false;
env.useBrowserCache = true;

export const factory = pipeline;
export const transcribe = (args, deps = {}) => whisper.transcribe(args, { factory, ...deps });
export const loadModel = (opts = {}) => whisper.loadModel({ factory, ...opts });
export const resetModelCache = whisper.resetModelCache;
export const pcm16ToFloat32 = whisper.pcm16ToFloat32;
export const whisperLangFor = whisper.whisperLangFor;
