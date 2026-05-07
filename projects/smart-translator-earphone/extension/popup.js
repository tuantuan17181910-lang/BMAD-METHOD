const $ = (id) => document.getElementById(id);
const sttSelect = $('stt-provider');
const apiKeyInput = $('api-key');
const apiKeyRow = $('api-key-row');
const sourceLangSelect = $('source-lang');
const targetLangSelect = $('target-lang');
const dualEarCheckbox = $('dual-ear');
const ttsCheckbox = $('tts');
const toggleBtn = $('toggle');
const statusEl = $('status');
const originalEl = $('original');
const translationEl = $('translation');

const STORAGE_KEY = 'smartTranslatorEarphone:settings';

const PAID_PROVIDERS = new Set(['whisper', 'google']);
const FREE_PROVIDERS = new Set(['auto', 'youtube-captions', 'whisper-wasm']);

let running = false;

function isPaid(provider) {
  return PAID_PROVIDERS.has(provider);
}

function syncApiKeyVisibility() {
  apiKeyRow.style.display = isPaid(sttSelect.value) ? '' : 'none';
}

function describeEngine(engine) {
  switch (engine) {
    case 'youtube-captions':
      return 'YouTube captions (zero-key)';
    case 'whisper-wasm':
      return 'Whisper-WASM (local)';
    case 'whisper':
      return 'OpenAI Whisper API';
    case 'google':
      return 'Google Cloud STT';
    default:
      return engine ?? 'unknown';
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const s = stored[STORAGE_KEY] ?? {};
  if (s.sttProvider) sttSelect.value = s.sttProvider;
  if (s.sourceLang) sourceLangSelect.value = s.sourceLang;
  if (s.targetLang) targetLangSelect.value = s.targetLang;
  if (typeof s.dualEar === 'boolean') dualEarCheckbox.checked = s.dualEar;
  if (typeof s.tts === 'boolean') ttsCheckbox.checked = s.tts;
  // The API key only persists for the browser session — pulled from
  // session storage so closing Chrome wipes it.
  const session = await chrome.storage.session.get(STORAGE_KEY);
  if (session[STORAGE_KEY]?.apiKey) apiKeyInput.value = session[STORAGE_KEY].apiKey;
  syncApiKeyVisibility();
}

async function saveSettings() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      sttProvider: sttSelect.value,
      sourceLang: sourceLangSelect.value,
      targetLang: targetLangSelect.value,
      dualEar: dualEarCheckbox.checked,
      tts: ttsCheckbox.checked,
    },
  });
  await chrome.storage.session.set({
    [STORAGE_KEY]: { apiKey: apiKeyInput.value },
  });
}

function setRunning(state) {
  running = state;
  toggleBtn.textContent = state ? 'Stop' : 'Start';
  toggleBtn.disabled = false;
}

function setStatus(text) {
  statusEl.textContent = text;
}

sttSelect.addEventListener('change', syncApiKeyVisibility);

toggleBtn.addEventListener('click', async () => {
  toggleBtn.disabled = true;
  await saveSettings();
  if (running) {
    const res = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'stop',
    });
    if (!res?.ok) setStatus(`Stop failed: ${res?.error ?? 'unknown'}`);
    setRunning(false);
    return;
  }
  const provider = sttSelect.value;
  const apiKey = apiKeyInput.value.trim();
  if (isPaid(provider) && !apiKey) {
    setStatus('Enter an API key for the paid engine, or pick a free one.');
    toggleBtn.disabled = false;
    return;
  }
  const config = {
    sttProvider: provider,
    apiKey,
    sourceLang: sourceLangSelect.value,
    targetLang: targetLangSelect.value,
    dualEar: dualEarCheckbox.checked,
    tts: ttsCheckbox.checked,
  };
  const res = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'start',
    config,
  });
  if (!res?.ok) {
    setStatus(`Start failed: ${res?.error ?? 'unknown'}`);
    toggleBtn.disabled = false;
    return;
  }
  setStatus(`Capturing tab audio (${describeEngine(res.resolvedProvider ?? provider)})…`);
  setRunning(true);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'popup') return false;
  if (msg.kind === 'status') {
    if (msg.state === 'listening') {
      setStatus(`Listening (${describeEngine(msg.engine)})…`);
    } else if (msg.state === 'loading-model') {
      setStatus(`Loading ${describeEngine(msg.engine)} model (~40 MB on first run)…`);
    } else if (msg.state === 'stopped') {
      setStatus('Stopped.');
      setRunning(false);
    }
  } else if (msg.kind === 'partial') {
    originalEl.textContent = msg.text;
  } else if (msg.kind === 'translation') {
    originalEl.textContent = msg.original;
    translationEl.textContent = msg.translated;
  } else if (msg.kind === 'error') {
    setStatus(`Error: ${msg.message}`);
  }
  return false;
});

loadSettings();

// Exported for unit tests.
export const __test__ = {
  isPaid,
  describeEngine,
  PAID_PROVIDERS,
  FREE_PROVIDERS,
};
