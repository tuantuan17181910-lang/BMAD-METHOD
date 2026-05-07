---
workflowType: 'prd-update'
project_name: 'Smart Translator Earphone'
phase: 'pre-v1-implementation'
agent: 'John (Product Manager)'
date: '2026-05-07'
predecessor: '_bmad-output/prd.md'
inputDocuments:
  - prd.md
  - architecture.md
  - handoff-2026-05-07.md
  - reviews/pm-review.md
scope_decision: 'Option A — free-only on all surfaces; paid → v1.1'
---

# 📋 PRD Update — v1 Free-Only Scope (John, PM)

> Hi Tuan — John here. This is the PRD delta for the 2026-05-07
> planning round. I keep it as a delta (not a full re-issue) so you
> can diff it against the original `prd.md`. Paragraphs flagged
> 🔴 are **changed**, 🟢 are **new**, ⚪ are **unchanged but
> reaffirmed**. Anything not mentioned stays as written in `prd.md`.

---

## 1. Why this update exists

`prd.md` was written before two zero-key STT paths existed
(YouTube captions, Whisper-WASM) and before Web Speech API was
considered. The PRD treated paid Whisper / Google Cloud STT as the
default and free providers as optional. That is no longer correct
for v1.

Per the user's 2026-05-07 decision (Option A), v1 ships **free-only
on every surface**. Paid engines are kept in the codebase but
gated behind a `v1.1` feature flag.

This update changes:

- **FR-1 / FR-2 acceptance criteria** to use free providers as the
  reference engine.
- **Adds FR-WSP** for Web Speech API on PC mic.
- **Adds NFR-COST** to formalize the zero-key constraint.
- **Adds DEL-WEBSTORE** as a v1 deliverable.
- **Updates v1 / v1.1 split** in the release plan.

Stories impacted are listed at the end (§7) so Sarah's backlog
groom in `epics-and-stories-v2.md` can pick them up.

---

## 2. Scope summary (the one slide)

```
       ┌───────────────────────────────────────────────────────┐
       │                v1 — FREE-ONLY (this sprint)            │
       └───────────────────────────────────────────────────────┘
                                  │
   ┌────────────────────┬─────────┴──────────┬─────────────────┐
   ▼                    ▼                    ▼                 ▼
 MOBILE              EXTENSION             EXTENSION         EXTENSION
 (Expo)              YouTube tab           Other tab         Mic conversation
                                                             (NEW in v1)

 expo-speech-        youtube-captions      whisper-wasm      Web Speech API
 recognition         (Phase A)             (Phase B)         (NEW provider)
 ↓                   ↓                     ↓                 ↓
 → free Google MT  → free Google MT      → free Google MT  → free Google MT
 ↓                   ↓                     ↓                 ↓
 → Native TTS      → Web Speech TTS      → Web Speech TTS  → Web Speech TTS

       ┌───────────────────────────────────────────────────────┐
       │              v1.1 — PAID (later sprint)                │
       └───────────────────────────────────────────────────────┘

  • Whisper API (OpenAI)              • Google Cloud STT
  • DeepL                             • Azure / ElevenLabs TTS
  • Group sessions (Cloudflare)       • Native on-device Whisper / NLLB
```

**No paid API key is required at any point in v1.** The user can
install the extension or app, hit Start, and get a translation —
zero setup, zero cost.

---

## 3. Functional Requirements — delta

### 🔴 FR-1 (modified) — Real-time mic translation

**Was:** Real-time transcription accuracy ≥ 92 % WER on Whisper-large
or Google STT for the top-10 supported languages.

**Now:** Real-time transcription accuracy is targeted at **≥ 80 %
WER on the on-device free engine** for the top-10 supported
languages, measured per surface:

- **Mobile:** Apple `Speech.framework` / Android `SpeechRecognizer`
  (whatever the OS provides for free).
- **PC mic:** Web Speech API (Chrome / Edge native).

The 92 % target moves to FR-1.1 (paid surface, deferred to v1.1).
Stories must include the per-language accuracy floor (Mary's
research in `research/zero-key-viability.md` provides the per-
language numbers; below 80 % languages get a UI warning, not a
silent fail).

### 🟢 FR-WSP (new) — Web Speech API mic provider on PC

**Statement.** When the Chrome extension's input source is
"Microphone" (not tab capture), the extension shall use the
browser-native Web Speech API as the default STT provider, with
zero key and zero download.

**Acceptance criteria (Given/When/Then):**

- **Given** the user has selected `Auto (free)` provider AND
  `Microphone` input source AND is on Chrome / Edge,  
  **When** the user clicks Start,  
  **Then** the extension uses Web Speech API for transcription.

- **Given** the user is on a browser without Web Speech API
  (Firefox / Safari),  
  **When** the user selects `Microphone` input source,  
  **Then** the extension surfaces a clear error:
  "Web Speech API not supported. Switch to Tab audio + YouTube,
  or install whisper-wasm bundle by re-loading the extension."

- **Given** Web Speech API is producing partial transcripts,  
  **When** a `final` event fires,  
  **Then** the pipeline emits a `final` SttEvent identical in
  shape to other providers (so the translator/TTS chain works
  unchanged).

**Why this is a separate FR.** Web Speech API is the **only** free
PC mic STT path. Without it, mic conversation on PC requires either
mic capture → Whisper-WASM (works but uses 2 MB + 40 MB download)
or paid Whisper API. Adding Web Speech API as the default for
"input source = mic" satisfies Option A's zero-key promise on PC.

### ⚪ FR-2 (reaffirmed) — Tab audio capture

Unchanged. `chrome.tabCapture` + Phase A/B remain the path for tab
audio. Web Speech API does **not** capture tab audio (security
restriction in Chrome) so this FR is mic-only.

### 🔴 FR-3 (modified) — Translation engine

**Was:** Default DeepL or Google Cloud Translate (paid).

**Now:** Default is the unofficial Google Translate endpoint
(`translate.googleapis.com/translate_a/single`, `client=gtx`).
Paid DeepL / OpenAI / Google Cloud Translate move to v1.1.

Acceptance criteria stay the same (translation correctness on the
test corpus); only the default engine changes.

Mary's research §3 covers the ToS and rate-limit risks of the free
endpoint, including a fallback strategy: if free endpoint returns
HTTP 429 for 3 consecutive calls in a 60 s window, the extension
shows "Translation service rate-limited; pause for 1 minute."

### ⚪ FR-4 (reaffirmed) — Dual-ear stereo

Unchanged. `dualEarStereo = true` puts capture monitor on left,
TTS on right.

### 🟢 FR-WS (new) — Chrome Web Store deliverable

**Statement.** v1 includes a packaged `.zip` published to the
Chrome Web Store under a new listing.

**Acceptance criteria:**

- **Given** the developer runs `npm run build && npm run package`
  in `extension/`,  
  **When** the build finishes,  
  **Then** a `dist/extension-v1.zip` exists, validated against
  Chrome Web Store policies (no remote-code execution, manifest
  v3, declared permissions justified in store description).

- **Given** the zip is uploaded to the store,  
  **When** the listing review completes,  
  **Then** the extension is installable from
  `chrome.google.com/webstore/...` with one click, no
  "Developer mode" needed.

**Out of scope for v1:** Edge / Firefox add-on store listings.
Same codebase but different review processes — defer to v1.1.

---

## 4. Non-Functional Requirements — delta

### 🟢 NFR-COST (new) — Zero monetary cost for the user in v1

**Statement.** The v1 user shall pay zero dollars to use the
product through any free path. No API key purchase, no paid SaaS
subscription, no per-minute charge.

**Acceptance:**

- Install → first translation: 0 USD spent.
- 60 minutes of continuous use: 0 USD spent.
- One year of typical use (estimate 3 hr / week): 0 USD spent.

**Implication for the team.** Any code path that requires a paid
API key must be either (a) gated behind a `v1.1` feature flag, or
(b) hidden in the popup UI behind an "Advanced" disclosure.

### 🔴 NFR-LATENCY (modified)

**Was:** End-to-end latency ≤ 3 s on Whisper API + Google MT.

**Now:** End-to-end latency targets are surface-specific:

- **Mobile native STT:** ≤ 2 s (OS STT is fast).
- **PC YouTube captions:** ≤ 1 s (no STT, just translate + TTS).
- **PC Whisper-WASM:** ≤ 5 s for the first chunk after model load
  (which is a one-time ~30 s cost on first ever use); ≤ 3 s
  steady-state.
- **PC Web Speech API:** ≤ 2 s.

If any of these exceed the target by 50 % or more, story carries
a "perf regression" tag in the backlog.

### ⚪ NFR-PRIVACY (reaffirmed)

Unchanged. No raw audio leaves the device for the free path
(YouTube captions are caption text → already public; Whisper-WASM
runs locally; Web Speech API uses the browser's local recognition).

This is actually **stronger in v1 than in v1.1**, since paid
providers send audio to OpenAI / Google. Marketing should
emphasize this.

### ⚪ NFR-LANG (reaffirmed)

Unchanged target: top-10 source languages, top-20 target
languages. Mary's research validates per-language accuracy.

---

## 5. Architecture impact

These changes do not require architecture changes per se, but they
do require:

### 5.1 New: `WebSpeechSttProvider` in extension

The mobile app already has `WebSpeechSttProvider` in
`app/src/core/stt/`. Port the same logic to
`extension/lib/web-speech-stt.js` (vanilla JS for MV3
compatibility). Reuse `lib/translator-pipeline.js` —
`createTranslator` factory already accepts any STT provider.

**Risk:** Web Speech API in MV3 service worker context is
restricted. The `SpeechRecognition` API is window-scoped and
needs to run in the offscreen document, which already exists.

### 5.2 Modified: Hybrid router in `background.js`

Current logic:
```
input source = mic           → whisper-wasm (Phase B)
input source = tab + YouTube → youtube-captions (Phase A)
input source = tab + other   → whisper-wasm (Phase B)
```

New logic:
```
input source = mic           → web-speech (NEW, default for mic)
input source = mic + Firefox → whisper-wasm (fallback when no Web Speech)
input source = tab + YouTube → youtube-captions
input source = tab + other   → whisper-wasm
```

### 5.3 New: Packaging script

`extension/package.json` adds:

```json
"scripts": {
  "package": "node scripts/package-extension.js"
}
```

The script bundles `dist/whisper-wasm.bundle.js`, copies the
extension files, validates the manifest against Chrome Web Store
policy (max 32 permissions, no remote code, etc.), and produces
`dist/extension-v{version}.zip`.

### 5.4 No mobile architecture change

Mobile already uses `expo-speech-recognition` for free mic STT.
The 2026-05-05 handoff covers it. Stories MOB-01 (LocalStore
plumbing) and MOB-02 (field test) carry over unchanged.

---

## 6. Release plan

### v1 (this sprint, ~4 weeks)

- Story EXT-01 to EXT-08 from Sarah's backlog (covers Phase A
  verification, Web Speech adapter, popup polish, Web Store
  packaging, store listing).
- Story MOB-01, MOB-02 from carry-over (LocalStore + field test).
- Story BA-01 to BA-04 from Mary's research (run in parallel,
  output is `research/zero-key-viability.md`).

### v1.1 (next quarter)

- Re-enable paid providers in default UI (under "Advanced").
- Native iOS / Android route-change bridges.
- Whisper on-device + NLLB on-device for offline mode.
- Cloudflare Worker for group sessions.

### v2 (TBD)

- Native earphone integrations (live caption to AirPods? Soundcore
  AI-translation buds? Hardware partnership.)
- Offline language packs.
- Real-time speaker diarization (who's talking).

---

## 7. Stories impacted (handoff to Sarah)

The following stories should be reviewed against this PRD update
in `epics-and-stories-v2.md`:

| Story | Status after this update |
|---|---|
| FR-1 stories about Whisper API accuracy | Move to v1.1 backlog. |
| FR-WSP stories | NEW — Sarah authors. |
| FR-WS stories | NEW — Sarah authors. |
| FR-3 default-engine stories | Update default to "free Google MT". |
| NFR-COST stories | NEW — Sarah authors as a constraint, not a feature. |
| NFR-LATENCY targets | Per-surface table; Sarah captures into ACs. |

I have flagged each in §3 / §4 with 🔴 / 🟢 / ⚪ for diffability.

---

## 8. Open questions for the next round

These are explicitly **not** decided in this update; they will
need a follow-up planning session:

1. **Mobile app Web Store / App Store / Play Store listing.** This
   PRD covers Chrome Web Store only. Mobile listing decisions
   (paid vs free, in-app purchase for v1.1 paid features, etc.)
   are deferred until Mary's market research is in.

2. **Privacy policy text.** v1 is local-only, so the policy is
   short, but legal still needs to review the wording.

3. **Brand name for the extension.** Currently
   "Smart Translator Earphone." Marketing might want something
   shorter for the store listing.

---

> **— John 🪪 PM**
>
> When you're ready, hand this PRD update plus
> `epics-and-stories-v2.md` to the implementation session. The
> sprint is well-scoped; the only thing blocking development is
> Mary's accuracy numbers (which gate the per-language warning UI).
> She is researching in parallel — see
> `research/zero-key-viability.md`.
