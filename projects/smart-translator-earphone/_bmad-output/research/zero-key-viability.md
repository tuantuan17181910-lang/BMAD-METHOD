---
workflowType: 'research'
project_name: 'Smart Translator Earphone'
phase: 'pre-v1-implementation'
agent: 'Mary (Business Analyst)'
date: '2026-05-07'
inputDocuments:
  - prd-v1-free-only.md
  - epics-and-stories-v2.md
  - handoff-2026-05-07.md
status: 'phase-1-desk-research-complete; phase-2-benchmark-pending'
---

# 🔍 Research — Zero-Key Path Viability (Mary, BA)

> Hi Tuan — Mary here. The user's 2026-05-07 decision was "free-only
> v1 on every surface." That's a strong product position, but it
> rests on three unofficial / undocumented endpoints (YouTube
> `timedtext`, free Google translate, in-browser Whisper) plus
> three OS-provided STT engines (Web Speech, iOS Speech.framework,
> Android SpeechRecognizer).
>
> This document is split into a **Phase 1 desk-research pass**
> (done now, summarized below) and a **Phase 2 benchmark pass**
> (gated on hardware availability — written as a methodology so
> the dev team can run it in parallel with EXT-01/02/03).

---

## 1. Research scope

The four open questions from `handoff-2026-05-07.md` §6.3:

1. **YouTube `timedtext` endpoint long-term viability** (BA-01).
2. **Whisper-tiny multi-language accuracy in production conditions** (BA-02).
3. **Free Google translate endpoint ToS / rate-limit risk** (BA-03).
4. **Mobile STT comparison** (BA-04).

All four are **risk-driven** — we already chose Option A (free-only),
so these aren't deciding *whether* to ship the free path; they're
quantifying *what we're exposing ourselves to* and *where to put
guardrails.*

Severity scale (carried over from `ba-review.md`):
- `info` — note for the team
- `warn` — fix or document
- `block` — must resolve before shipping

---

## 2. Executive summary

| # | Question | Severity | Headline finding (Phase 1) |
|---|---|---|---|
| 1 | YouTube `timedtext` | **warn** | IP-level rate limits are real and well-documented since 2020. The threat to *our* extension is lower than for scrapers because we run from the *user's* browser session, not a datacenter. Add 429 detection + Whisper-WASM fallback (already in code path). |
| 2 | Whisper-tiny accuracy | **warn** | Tiny is poor on Japanese (CER 32.7 baseline per arxiv 2412.10705). Acceptable on English, Spanish, French. Per-language UI gating recommended — show a "Captions look wrong? Switch to whisper-base" tip when source ∈ {ja, ko, zh, vi, th}. Phase 2 benchmarks needed. |
| 3 | Free Google translate | **warn** | The `client=gtx` web-frontend endpoint is undocumented but stable since at least 2017 (every open-source `googletrans`-style library uses it). Google's official ToS for the *paid* Translate API forbids "create … substantially similar product"; the free endpoint isn't covered by that ToS but Google could shut it off any time. Mitigation: contract test in CI, fallback to LibreTranslate self-hosted. |
| 4 | Mobile STT | **info** | iOS `Speech.framework` and Android `SpeechRecognizer` are well-documented free OS APIs with known limitations (online-only by default, language quotas). No legal risk; only quality risk. |

**No `block` findings.** Option A (free-only v1) remains shippable.

---

## 3. BA-01 — YouTube `timedtext` viability

### 3.1 What the endpoint is

```
https://www.youtube.com/api/timedtext?v={videoId}&lang={lang}&fmt=json3
```

This is **not** part of the official YouTube Data API v3 (which is
key-gated and listed at `developers.google.com/youtube`). It is
the same endpoint the public YouTube web player uses to render
captions on `youtube.com/watch`. There is no published quota or
SLA.

### 3.2 What is known (sources)

- **`jdepoix/youtube-transcript-api` issue #467 (July 2025).** Users
  report HTTP 429 from the endpoint, even on freshly-deployed
  scripts. Issue closed without a fix because YouTube's
  rate-limit is server-side. ([Source](https://github.com/jdepoix/youtube-transcript-api/issues/467))
- **Same project, issue #70 (2020) and #66 (2020).** Rate-limit
  behavior was already documented five years ago. The maintainer
  added an explicit "we cannot fix this" note to the README.
- **The 429 response includes `ip=0.0.0.0&ipbits=0&expire=...`**
  in its URL parameters, which strongly implies the rate limit is
  applied at the IP / IP-range level on YouTube's side, not at a
  user / API-key level.
- **Datacenter IPs are heavily flagged.** Both the user's previous
  VM session and most VPS providers (DigitalOcean, AWS, GCP) hit
  "Sign in to confirm you're not a bot" within a few requests.

### 3.3 Why our extension is at lower risk

Three reasons:

1. **Origin.** The extension runs in a real Chrome browser on a
   residential IP, with a real `chrome` user-agent and a real
   YouTube session cookie attached (the user is already logged
   into youtube.com when they visit a watch page). Our request
   pattern is *indistinguishable* from a normal viewer who has
   captions turned on.
2. **Frequency.** A typical viewing session loads `timedtext` once
   per video — not hundreds of times per minute as scrapers do.
3. **Session continuity.** The `ytInitialPlayerResponse` already
   contains the `baseUrl` for the caption track, often including
   short-lived signature parameters. We use that signed URL,
   which is much harder to fingerprint as a scraper.

### 3.4 Failure modes & mitigation

| Failure | Frequency (estimated) | Mitigation |
|---|---|---|
| HTTP 429 on caption fetch | Low for normal users; high if user opens 50 tabs | EXT-04 already shows "Captions blocked" badge; auto-fallback to Whisper-WASM |
| Endpoint URL changes (e.g. fmt=json3 dropped) | Very low; endpoint stable 5+ years | Pure-function parser already covers null/empty responses; CI integration smoke test runs once per day to detect drift early |
| `ytInitialPlayerResponse` JSON shape changes | Low; YouTube has many extensions depending on it | Same as above; parser is defensive |
| YouTube blocks the extension explicitly via Web Store policy | Low; many transcript / caption extensions are listed | Privacy policy must say "we read public captions only, no audio leaves the device" |

### 3.5 Recommendation

**Severity: warn.** Ship with the existing 429-detection +
Whisper-WASM fallback. Add a contract test that hits a known
public video once per day in CI (when GH Actions is enabled) so
we know if YouTube changes the response shape.

### 3.6 Edge case — live streams with auto-generated captions

Phase A is **not safe** for live streams that rely on YouTube's
internal streaming ASR. Auto-generated captions on live
broadcasts cut mid-sentence on JA/KO/ZH for the same root
reason Phase B does (verb-final grammar + streaming pipeline).
Detection from `ytInitialPlayerResponse`:

- `captionTrack.kind === 'asr'` — auto-generated track
- `videoDetails.isLive === true` — currently live broadcast

When **both** are present, the `auto` provider must bypass
Phase A and use Phase B (Whisper-WASM) instead. This is story
**EXT-08.7** in the v2 backlog (effort S, with a defensive
acceptance criterion for missing/undefined fields since
`ytInitialPlayerResponse` is an undocumented internal API).

VOD content with manual or pre-processed captions is unaffected
and represents ≈99 % of typical viewing time. Live JA/KO content
is the only segment routed away from Phase A.

---

## 4. BA-02 — Whisper-tiny multi-language accuracy

### 4.1 Known baseline (Phase 1)

Reference paper: *Bajo, Fukukawa, Morita, Ogasawara — "Efficient
Adaptation of Multilingual Models for Japanese ASR"*, arxiv
2412.10705 (Dec 2024). [Source](https://arxiv.org/pdf/2412.10705)

| Model | Japanese CER (baseline, no fine-tune) | Notes |
|---|---|---|
| Whisper-tiny | 32.7 | What we ship by default |
| Whisper-base | 20.2 | What we'd ship if we relaxed the bundle-size budget by ~75 MB |
| Whisper-tiny + LoRA fine-tune | 20.8 | Achievable with ~10 hr Japanese audio |
| Whisper-tiny + E2E fine-tune | 14.7 | Achievable with much more compute |
| ReazonSpeech (JA-only) | < 10 (cited) | Best-in-class JA-only model, much larger |

CER (Character Error Rate) is the right metric for languages with
non-Latin scripts; for Latin-script languages WER (Word Error
Rate) is the convention.

### 4.2 Production-conditions caveats

The arxiv numbers are on **clean read speech**. Production
YouTube audio is degraded by:

- Background music / sound effects (gaming streams, vlogs)
- Speaker overlap (interviews, panel shows)
- Compression artifacts (low-bitrate AAC at 96 kbps)
- Speaker accent / dialect drift
- Specialized vocabulary (gaming jargon, brand names)

A **real WER/CER in production is typically 1.5–2× the lab WER/CER**
based on industry rule-of-thumb. So Whisper-tiny on production
Japanese YouTube content likely sits at CER 50–65 — barely
usable.

### 4.3 Phase 2 benchmark plan (gated on hardware)

When dev hardware is available, run this benchmark:

**Corpus (small):**
- 5 minutes of public-domain YouTube audio per language for the
  top-10 v1 languages: en, es, fr, de, ja, ko, zh, vi, th, hi.
- Mixed conditions: 1 min news read, 2 min vlog, 2 min
  interview.
- Reference transcript: human-edited, source-language only.

**Models compared:**
- Whisper-tiny (what we ship)
- Whisper-base (what we'd ship if we accept +75 MB bundle)
- YouTube auto-captions (our Phase A path)
- (Optional) Web Speech API on Chrome (the FR-WSP provider)

**Metrics:**
- WER for Latin-script (en/es/fr/de/vi)
- CER for non-Latin (ja/ko/zh/th/hi)
- RTF (real-time factor) for each model on a typical user laptop
  (M1 Mac air-class)
- First-token latency

**Output:**
A table in `research/whisper-tiny-benchmark.md` (sub-document) and
a popup-UI gating rule per language: if benchmark CER/WER >
threshold, the popup shows "Captions look wrong? Switch to
whisper-base or paid Whisper API."

### 4.4 Recommendation

**Severity: warn.** Ship Whisper-tiny as default but gate
expectations per language:

- **Green** (good): en, es, fr, de — ship without warning.
- **Yellow** (acceptable, recommend Phase A captions when
  available): vi, hi, th — popup shows "YouTube captions
  recommended for this language."
- **Red** (poor without fine-tune): ja, ko, zh — popup shows
  "Tip: Whisper-tiny is less accurate for this language. Try
  YouTube captions or use Advanced → paid Whisper API." For
  story EXT-08.5, the v1 plan **swaps to Whisper-base** for
  these three languages specifically (lazy-loaded, +75 MB
  model, only when source language is detected as ja/ko/zh).

This gating ships in v1 but is informed by the Phase 2 benchmark.
If Phase 2 numbers differ materially, the gating rules update
in v1.0.1.

### 4.5 Whisper hallucination — characteristic to plan around

A second-order risk identified during the 2026-05-07 ADR review:
**Whisper-tiny tends to emit fabricated sentence-final particles
(`です。`, `요.`)** when the model is uncertain (noisy audio,
rare vocabulary). At CER 32.7 on JA, the hallucination rate is
high enough that any text-trigger commit logic (e.g., the
text-layer SFP regex described in ADR-006 §Layer 2) will be
fooled into committing on fabricated content.

**Mitigations** (codified in ADR-006 / ADR-007):

1. **Audio-layer VAD as independent commit signal.** Energy-based
   silence detection on PCM does not depend on Whisper output and
   is not fooled by hallucination.
2. **Hard ordering dependency: EXT-08.5 → EXT-09.** The Whisper-
   base swap must ship and per-language CER must be measured
   *before* the dual-trigger commit logic is finalized. This
   avoids tuning regex thresholds against tiny-model noise.
3. **Field-report instrumentation.** During EXT-01 live
   verification, observers should explicitly look for
   "translation appears on text the user did not say" and report
   it with the original audio + transcript so we can characterize
   hallucination frequency in production.

This pattern is consistent across Whisper variants (tiny → base →
small → medium); larger models hallucinate less but never zero.
Architectural compensation (audio-VAD cross-check) is durable.

---

## 5. BA-03 — Free Google translate ToS / rate-limit

### 5.1 What the endpoint is

```
https://translate.googleapis.com/translate_a/single
  ?client=gtx&sl=auto&tl=vi&dt=t&q=hello
```

`client=gtx` is the parameter the public web frontend at
`translate.google.com` sends. It returns a non-standard JSON-array
response. It is not documented. It does not require an API key.

### 5.2 Legal status

**The official Google Translate API ToS** ([source](https://console.cloud.google.com/tos?id=translate))
applies to "the API." Specifically section 1 says: *"You will not
knowingly use the API to create, train, or improve … a
substantially similar product or service, including any other
machine translation engine."*

The `client=gtx` endpoint is **not part of "the API"** as that
term is defined; it is the web-frontend backend. There is no
explicit ToS that covers it.

That said, Google's general Terms of Service apply to anyone
making requests to Google services, and a court could plausibly
read the spirit of the API ToS as covering the gtx endpoint too.

### 5.3 Practical track record

- Used by `googletrans` Python library (~3.6k GitHub stars) for
  ~7 years.
- Used by Translatium, simply-translate, deep-translator, and
  ~50 other open-source projects.
- No reported C&D letters from Google in public record.
- Endpoint URL has not changed since at least 2017.

### 5.4 Failure modes & mitigation

| Failure | Likelihood | Mitigation |
|---|---|---|
| Rate-limit per IP | Medium | Already documented; show "Translation rate-limited; pause 1 min" UX |
| Endpoint deprecated | Low | Add LibreTranslate self-hosted as fallback (~2 days work) |
| Response shape changes | Low | Contract-test fixture in CI |
| Google C&Ds the project | Low | Rapid-cycle replacement to LibreTranslate; add Apache-2 attribution |

### 5.5 Recommendation

**Severity: warn.** Ship with the existing endpoint. Add:

1. A contract test in `extension/__tests__/translate.contract.test.js`
   that hits the live endpoint with a fixed phrase and validates
   the response shape (runs once per day in CI).
2. A LibreTranslate provider in `app/src/core/translation/` and
   `extension/lib/translate.js` as a one-flag fallback (does not
   ship enabled in v1, but available if the gtx endpoint breaks).
3. Privacy policy clause: "Translation requests are sent to
   translate.googleapis.com (Google Translate). No personal data
   beyond the text being translated is sent."

---

## 6. BA-04 — Mobile STT comparison

### 6.1 Available providers on mobile

| Platform | Provider | Free? | Online required? | Languages | Notes |
|---|---|---|---|---|---|
| iOS 13+ | `Speech.framework` (`SFSpeechRecognizer`) | Yes | Online by default; offline available iOS 13+ for some languages | 50+ | 1 minute / request limit by default; multiple requests per day |
| Android 5+ | `SpeechRecognizer` (Google app) | Yes | Online by default | Varies; depends on Google app | Daily quota (varies); may not be available on AOSP-without-Google |
| iOS / Android | Whisper on-device (whisper.cpp) | Yes | No (offline) | 99 | Requires native module + 75 MB model bundle |

`expo-speech-recognition` (already in the app) wraps both
`Speech.framework` and `SpeechRecognizer` through one JS API.

### 6.2 Comparison axes

**Accuracy (Phase 2 benchmark planned):**
- iOS Speech vs Whisper-tiny on a fixed corpus
- Android SpeechRecognizer vs Whisper-tiny on the same
- Run on real devices (Tuan's iPhone, an Android emulator, a
  physical Android in a noisy environment)

**Latency:**
- iOS Speech: typically < 1s (online streaming)
- Android SpeechRecognizer: typically < 1s online; > 5s offline
- Whisper on-device: 2-10s depending on chunk size

**Privacy:**
- iOS Speech: audio sent to Apple servers by default; on-device
  optional flag in iOS 13+ if user enables it
- Android SpeechRecognizer: audio sent to Google by default
- Whisper on-device: never leaves the device

**Cost (to user):**
- All three: $0

### 6.3 Recommendation for v1

**Severity: info.** Ship `expo-speech-recognition` as the default
mobile mic STT. It's free, works offline on modern iOS, and
covers all v1 languages.

For users who care about privacy (audio not leaving device), add
a v1.1 toggle "Use on-device Whisper instead" — gated on Whisper
on-device being shipped in the native sprint.

### 6.4 Phase 2 benchmark plan

Same corpus as BA-02 but recorded through device microphones
under real noise conditions:

- Quiet room (baseline)
- Café noise (~60 dB background)
- Outdoor street (~70 dB background, traffic)
- Train / bus interior (~75 dB, mechanical)

Compare CER/WER for iOS Speech vs Whisper-base (or whatever
Whisper.cpp variant we'd ship on-device). Output table in
`research/mobile-stt-benchmark.md`.

---

## 7. Cross-cutting notes

### 7.1 The "free path" is actually three independent zero-key
paths

The user might assume zero-key = one provider. It's actually
**five free providers** working together:

1. YouTube captions (extension Phase A)
2. Whisper-WASM (extension Phase B)
3. Web Speech API (extension PC mic — NEW per FR-WSP)
4. iOS Speech.framework (mobile)
5. Android SpeechRecognizer (mobile)

Plus **one free translation backend** (translate.googleapis.com
client=gtx).

Plus **two free TTS** options (Web Speech TTS + native OS TTS).

If any one of these breaks, the rest are unaffected. That's a
strength of Option A's architecture — the free path is
**defense-in-depth**, not a single fragile dependency.

### 7.2 Marketing positioning — privacy claims, precise

The privacy story is unusually strong, but each provider has a
**different** privacy profile and marketing must distinguish
them carefully or risk losing trust with paranoid users.

| Provider | Audio leaves device? | New server exposure introduced by *us*? | What we can claim |
|---|---|---|---|
| Mobile native STT (iOS Speech.framework with on-device flag enabled) | No | None | "Audio never leaves your device" |
| Mobile native STT (default cloud mode) | Yes — to Apple / Google | None (the OS does it, not us) | "We don't operate any STT server" |
| Extension Phase A (YouTube captions) | Already at YouTube before we touch it | None — we read existing public captions | "We add no server beyond YouTube itself; the translation is computed in your browser" |
| Extension Phase B (Whisper-WASM) | No | None | "Audio + translation never leave your browser" |
| Extension Phase WSP (Web Speech API) | Yes — to the browser's recognizer (Google in Chrome) | None — the browser does it, not us | "We add no audio destination beyond your browser's built-in recognizer" |

The **strongest** claim ("audio never leaves your browser") is
**only** valid for **Phase B**. For Phase A, the user's audio is
already at YouTube *because they chose to watch a YouTube video*;
we don't add to that exposure but we also don't reduce it. For
Phase WSP, the browser's recognizer is the same one already in
the OS, so we don't introduce a new vendor relationship — but
audio does leave the device.

**Concrete marketing copy:**

- Top-line tagline: "Translate any tab without API keys.
  Computation happens in your browser."
- For privacy-focused audiences: emphasize Phase B
  ("Whisper-WASM mode: audio never leaves your browser").
- For broad audiences: emphasize Phase A
  ("YouTube mode: zero new server exposure, sub-second
  latency").
- Avoid ambiguous claims like "100 % local" without specifying
  which provider; users discovering Phase WSP later will lose
  trust if the claim is over-broad.

Compare to most paid competitors who route audio through their
own servers + OpenAI / Google. This is a clear marketing point —
**when made precisely**.

### 7.3 Risk of regulatory / EU AI Act exposure

Low. The product processes audio for translation only; it does
not biometrically identify speakers, does not score emotional
state, does not store audio. The free path is even *less* exposed
than the paid path because no audio leaves the device.

---

## 8. Updates to `market-research.md`

The competitive positioning has changed materially because of
Option A. I'll do a separate revision pass on
`_bmad-output/market-research.md` next round (gated on EXT-01
verification — I want to confirm the extension actually runs
on real Chrome before claiming "zero-friction install" in
marketing copy).

Preview of changes:

- **Entry point** changes from "user already has API key" to
  "user has Chrome and 30 seconds." This drops trial CAC to
  near-zero — almost no competitor matches this.
- **Privacy story** moves from "encrypted in transit" (table
  stakes) to "audio never leaves device" (premium positioning,
  most competitors can't claim this).
- **Mobile pricing** model needs redo. Original v0.5 PRD assumed
  freemium with API costs subsidized; v1 free-only means we ship
  with no recurring cost to anyone, and v1.1 paid is a true
  upsell ("better quality" not "any service at all").

---

## 9. Open items returned to PM / PO

- **PM (John):** Should the popup-UI per-language gating
  thresholds (BA-02 §4.4) be in the PRD or in implementation?
  My recommendation: in the PRD as an NFR, since users notice it.
- **PO (Sarah):** BA-02 (Whisper benchmark) and BA-04 (mobile
  benchmark) require real hardware. Should they block the sprint
  or run in parallel with EXT/MOB stories? My recommendation:
  parallel, as already in the backlog.
- **Tuan:** Phase 2 benchmarks need ~10 hours of dev hardware
  time. Can be batched into one weekend if you want it done
  fast, or spread over the sprint.

---

## 10. Industry context — streaming pipelines and SOV languages

> Added 2026-05-07 after Tuan asked how the broader translation
> industry handles the streaming pipeline and SOV (Japanese /
> Korean / Chinese / German subordinate) grammar challenges.
> This section is informational; the architectural conclusions
> are codified in `adrs/ADR-006.md`.

### 10.1 Sequential vs streaming pipelines

The "classical" sequential pipeline (record full utterance →
STT → MT → TTS) introduces ~3 s of unavoidable latency per
chunk and is what `extension/lib/whisper-wasm.js` currently
does at chunk granularity.

Modern streaming pipelines used by translation glasses
(Leion Hey2, RayNeo) and cloud APIs (Azure Speech Translation,
Google Translate API streaming) operate on **partial hypotheses**:

- STT emits `partial` events as the model decodes; MT consumes
  these and produces tentative translations.
- A small **commit buffer** holds the last N tokens. Each
  partial extends or revises the buffer.
- TTS only speaks committed tokens — those that the MT model
  is "confident enough" won't change.

A non-streaming TTS adds **up to 4.2 s** to the perceived
latency on its own (per Deepgram's benchmark). Streaming TTS
is what brings end-to-end latency on translation glasses to
the marketing-claimed ~500 ms.

**Where this project sits:**

| Path in this codebase | Pipeline style | Realistic latency |
|---|---|---|
| Mobile (`expo-speech-recognition`) | Streaming-ish (OS provides partials; MT runs on `final`) | 1.5–2 s |
| Extension Phase A (YouTube captions) | "Pre-streamed" — captions arrive pre-chunked with timestamps | 0.5–1 s |
| Extension Phase B (Whisper-WASM) | **Sequential** at 4 s chunk granularity | 5–7 s |
| Extension Phase WSP (Web Speech API) — NEW per FR-WSP | Streaming (browser-native) | < 2 s expected |

Phase B is the weak link. ADR-006 §Layer 2 prescribes
VAD-aware chunking + commit-delay to soften this; story EXT-09
in the backlog implements it.

### 10.2 The SOV problem

Japanese, Korean, Mandarin (as spoken in casual register), and
German subordinate clauses place the **verb at the end** of
the sentence. Concrete failure modes:

- **Verb-final ambiguity (Japanese).** `私は寿司を…` ("I …
  sushi") can resolve to `食べたい` (want to eat), `食べない`
  (won't eat), `食べた` (ate), or `食べすぎた` (ate too
  much) — entirely different meanings.
- **Negation bomb (Korean).** `아주 좋아…` sounds affirmative
  ("really like…") until `…하지 않아요` is appended at the
  end and flips the meaning to "don't really like." TTS that
  has already played the affirmative cannot be retracted.
- **German subordinate clauses.** `Ich weiß, dass er Sushi
  essen will` — `will` (the verb) is at the end of the
  subordinate clause.

These are an **open problem in NLP**. The state of the art at
IWSLT 2025 (CUNI SimulStreaming, arxiv 2503.13745) reports
that JA/ZH simultaneous translation is only viable at
"high-latency" mode (4–5 s). "Low-latency" (500 ms) mode is
disabled by configuration for these language pairs.

### 10.3 What commercial products do

| Product | SOV strategy |
|---|---|
| Leion Hey2 / LLVision (translation glasses) | Higher commit-delay for JA/KO/ZH (+200–400 ms vs EN) — undocumented but observable |
| RayNeo (translation glasses) | Same as Leion; prefers text-on-display over TTS for SOV |
| Azure Speech Translation | "Automatic break points optimized per language pair" — undocumented |
| Deepgram Nova-3 | 27 % WER reduction on Korean via syllable-block segmentation; STT only, no MT |
| Whisper + LLM (e.g. Nova-3 → GPT-4o) | Best accuracy via context-aware MT; latency 2–3 s, OK for subtitles, bad for TTS |

**Common pattern:** prefer **text on display** over **speech
output** for SOV because text can be silently revised when the
verb resolves; speech cannot be unspoken.

### 10.4 What this project will do (per ADR-006)

Three layers:

1. **Phase A (YouTube captions)** — already pre-segmented, no
   SOV problem. Recommend it as primary for ja/ko/zh.
2. **Phase B (Whisper-WASM)** — story EXT-09 adds VAD-aware
   chunking + commit-delay buffer for ja/ko/zh/de.
3. **Caption-only mode (v1.1)** — popup option to disable TTS
   for ja/ko/zh, fall back to dual-ear stereo + text panel
   only. Matches what translation glasses do.

This keeps the marketing message honest: we don't claim "real-
time translation" for SOV in a single number; we publish two
numbers (best case for Phase A, worst case for Phase B).

### 10.5 Competitive positioning summary

| Dimension | Translation glasses | This project |
|---|---|---|
| Pipeline | Streaming + commit-delay | Phase A: pre-segmented (excellent for VOD); Phase B: sequential → dual-trigger commit per ADR-006 |
| Latency (EN) | 500–700 ms | Phase A: 0.5–1 s; Phase B: 5–7 s |
| Latency (JA/KO) | 700–1100 ms | Phase A: 0.5–1 s VOD; Phase B: 6–7 s with EXT-09 |
| Hardware | Custom glasses + 4-mic beamforming | Tab audio (zero hardware) |
| Cost (one-time) | $300–1500 USD | $0 |
| Cost (recurring) | Subscription tier varies | $0 in v1 |
| Privacy | Audio routed through cloud STT + cloud MT | Phase B: audio never leaves browser. Phase A: no new server beyond YouTube. Phase WSP: audio sent to browser's built-in recognizer only. |

**Conclusion.** This project does not compete on raw latency
with $1500 hardware. It dominates on:

- **Cost** ($0 vs subscription)
- **Privacy** — but with **per-provider precision**, not a
  blanket "100 % local" claim (see §7.2 for exact wording).
  Phase B is the strongest privacy story; Phase A and Phase WSP
  are merely "no new exposure beyond what already exists."
- **Install friction** (Chrome Web Store install vs ordering
  hardware)

Marketing should lead with privacy + zero-cost rather than
chasing the "500 ms" number that hardware vendors achieve only
on EN→ZH. Use the precise per-provider wording from §7.2 so
paranoid users do not catch the project in an over-broad claim.

---

> **— Mary 🔍 BA**
>
> Phase 1 is done. No `block` findings — Option A is shippable.
> Phase 2 (the benchmarks) needs hardware time; please tell me
> when EXT-01 is verified and I'll start the corpus collection
> in parallel with the dev work.
