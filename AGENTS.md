# AGENTS.md — Codex implementation contract for MoodShift

**Execute the build now.** Read `PRD.md` before touching code. The project starts from **an empty repository**. Deliver a working Chrome 116+ Manifest V3 extension and local Gemini proxy; do not stop at a plan, pseudo-code, demo UI, or mocked audio engine. Avoid follow-up questions; implement the documented defaults. Optimize for a reliable YouTube demo under hackathon time constraints.

## Absolute priorities

1. **Sound must work first.** `tabCapture → offscreen MediaStream → Web Audio graph → speakers`, neutral at start, no duplicate output.
2. **Audio persists when the UI closes** and when the user switches tabs.
3. **Local presets and sliders work without the AI server.**
4. Gemini interprets text into validated parameter **patches**, then DSP applies them with smooth transitions and acknowledgment.
5. Basic audio-aware metrics and minimalist panel UI, then tests/docs/polish.

Do not implement downloads/recording, native audio routing, complicated framework scaffolding, Spotify API, true tempo shift, or stem separation. Never invent successful tests, and never claim Spotify compatibility without a real test.

## Fixed technology choices

- **Extension:** TypeScript + minimal HTML/CSS + Web Audio API; no React or unnecessary UI dependencies. Manifest V3, `minimum_chrome_version: "116"`. Build with `esbuild` into `extension/dist/` for `chrome://extensions` → **Load unpacked**. No remote JS in extension.
- **UI:** Chrome `sidePanel` persistent control interface; toolbar `action` has **no `default_popup`**. Clicking the action icon on the intended audio tab is the explicit capture-start gesture and opens the panel. Clicking again on the same active tab should show panel / preserve session, not create a second capture. Clicking on a different tab switches source cleanly.
- **Audio owner:** extension offscreen document, `chrome.offscreen.createDocument({ reasons: ['USER_MEDIA'], ... })`, long-lived MediaStream + AudioContext, not panel or service worker.
- **Background:** MV3 service worker solely coordinates tab selection, capture startup, offscreen creation, stop/switch, messages and state reconciliation. Assume the service worker can be suspended.
- **AI server:** Node.js 20+, TypeScript, Express, Zod, dotenv. Listen **only on `127.0.0.1:8787`**. Outbound `fetch` from server to `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with the `x-goog-api-key` header; configurable `GEMINI_MODEL`, default `gemini-3.1-flash-lite`. Use `responseMimeType` and `responseJsonSchema` in the generation config, with validation after parsing. Keep API key **server-side only**.
- **Dev tooling:** `tsx` for server dev, `esbuild` for extension bundle, `typescript` for type checks, `vitest` for unit tests. Minimal npm scripts. No Docker/database/cloud deployment.
- **Vendor outage:** Do not break playback. Presets/manual adjustments still work; AI shows explicit failed/timeout state. A clearly labeled **local preset testing mode** is okay, not an undisclosed imitation of the AI.

## Project layout (implement these paths)

```text
/
  PRD.md
  AGENTS.md
  README.md
  TEST_RESULTS.md
  package.json
  tsconfig.json
  scripts/build-extension.mjs
  extension/
    manifest.json
    src/background.ts
    src/offscreen.html
    src/offscreen.ts
    src/audio-engine.ts
    src/audio-features.ts
    src/sidepanel.html
    src/sidepanel.ts
    src/sidepanel.css
    src/shared/types.ts
    src/shared/effects.ts
    src/shared/messages.ts
    dist/                     # generated, Load unpacked here
  server/
    .env.example
    src/index.ts
    src/interpret.ts
    src/schema.ts
  tests/
    effects.test.ts
    schema.test.ts
    intent.test.ts
```

Change file organization only if technically necessary; keep these responsibility boundaries and document deviations.

## Lifecycle / user gesture implementation (critical)

1. `chrome.action.onClicked` **without a default popup** receives the source `tab`. Call/open `chrome.sidePanel.open({ windowId: tab.windowId })` in the user-gesture handler. Coordinate capture only for this explicitly invoked `tab.id`, never whichever tab happens to be active *later*.
2. Ensure there is **one** offscreen document using `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })` and a promise lock; create with reason `USER_MEDIA`. On action click, start capture using `chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id })` **in the service worker**, as in Chrome's official MV3 offscreen example. Obtain the stream ID only when the consumer is ready; it is short-lived and single-use. Pass it promptly to offscreen with `chrome.runtime.sendMessage` and await an acknowledgment that `getUserMedia` succeeded.
3. Offscreen redeem via `navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false })`. Handle actual Chrome constraints/types carefully. Build a `MediaStreamAudioSourceNode`, process, reconnect audio to `AudioContext.destination`. Avoid recording / `MediaRecorder`.
4. Keep **exactly one active session**, tied to source `tabId` and a unique `sessionId`/generation counter. If a new source is selected, stop and clean old stream/context before starting new. Guard against double action clicks and late messages. Do not accidentally capture the extension side panel instead of the selected tab.
5. Stream `ended` and `chrome.tabs.onRemoved` must stop the session and clear stale UI. `chrome.tabCapture.onStatusChanged` can help reconcile unexpected shutdowns. Use `chrome.storage.session` for compact session metadata, but **the offscreen document owns the actual live audio and effects state**. On service-worker wakeup or panel reopen, query offscreen for truth and do not claim a session merely because storage said it existed.
6. Panel receives current state via `GET_STATUS` and runtime messages; closing/reopening it cannot disconnect audio. Offscreen may be messaged while the panel is absent. The panel should make it clear that users click the extension icon from a tab to select it.
7. Stop: disconnect nodes, `stream.getTracks().forEach(t => t.stop())`, close AudioContext, clear session state, and optionally close offscreen document. If Chrome does not immediately restore direct audio in a real manual test, identify and fix; don't silently add a second output path.
8. `AudioContext` can be suspended; attempt `resume()` and verify `running` before acknowledging; if browser blocks playback, show a clear user-action/retry error. Handle tab pause/silence without assuming stream ended. Source tab navigation should retain capture when Chrome permits and recover gracefully otherwise.

**Common trap:** Setting `action.default_popup` disables `action.onClicked`. Do not do that. Avoid implementing capture in sidepanel/popup JS; the stream lifetime and gesture flow must follow the documented worker→offscreen pattern.

## Audio engine — concrete topology and semantics

- Create **one** `AudioContext` and graph per session, not per prompt. Canonical source fans into two nonduplicated branches:

```text
MediaStreamSource ──> originalGain ────────────────┐
                 └─> pre-EQ/filters ─> processed ─> processedGain ─> master/limiter ─> destination
                          ├─> reverb send/return ─┘
                          ├─> delay send/feedback/return ─┘
                          └─> distortion wet/dry mix ─┘
```

The sketch indicates effect branches; ensure there is **one destination**, no feedback path from destination back to input, no independent untreated connection to speakers. A/B uses crossfade between original and processed branches. Neutral settings should sound practically identical to original, with neither silent playback nor doubled loudness. Use equal-power or conservative linear crossfade and limiting.

- `BiquadFilterNode` lowshelf/highshelf, highpass, lowpass; `ConvolverNode` with **generated local impulse response** (not remote sample); `DelayNode` with feedback max 0.40; `WaveShaperNode` with controllable *blended* distortion, never a discontinuous curve swap at full amplitude; `DynamicsCompressorNode` conservatively to reduce clipping; master `GainNode`. Ensure graph does not inadvertently double the dry signal when sends are enabled.
- Implement the precise ranges/defaults in PRD. Settings shape is defined in `shared/effects.ts` and used everywhere. Do not maintain separate approximate copies of parameter names/ranges. Use typed `AudioEffectState`, `neutralEffects`, `clampEffects`, and a safe `applyPatch(current, patch)`. Reject NaN/Infinity/unrecognized keys; clamp numeric bounds. Unit tests required.
- For every change use `AudioParam` ramps / `setTargetAtTime` over ~0.25–0.4 s; for on/off branches ramp gain, not nodes. When reset, all parameters go to neutral and tail-heavy effects fade smoothly. A/B state is separate from effect parameters. Return ACK with actual post-clamp settings **after** scheduling DSP changes.
- `outputGainDb` is gain in dB converted to linear; avoid clipping. `delayMs: 0` means no echo, not instantaneous zero-time feedback. Reverb IR can have a fixed ~1.5 s decay for MVP; only mix is adjustable.
- Use locally created `AnalyserNode` and throttle sample loop; compute rolling ~2 s summary (`rms`, `bassEnergy`, `midEnergy`, `trebleEnergy`, `brightness`, `isSilent`). 0–1 normalized rough descriptors, not calibrated measurements. Do **not** transmit audio samples or make model calls on every audio frame.

## AI interpretation API contract

HTTP: `POST http://127.0.0.1:8787/api/interpret` with JSON:

```json
{
  "prompt": "A little more bass, keep the reverb",
  "currentEffects": {
    "bassDb": 0,
    "trebleDb": 0,
    "highpassHz": 20,
    "lowpassHz": 20000,
    "reverbMix": 0.3,
    "delayMs": 0,
    "delayMix": 0,
    "delayFeedback": 0,
    "distortion": 0,
    "outputGainDb": 0
  },
  "audioFeatures": {
    "rms": 0.24,
    "bassEnergy": 0.62,
    "midEnergy": 0.35,
    "trebleEnergy": 0.25,
    "brightness": 0.3,
    "isSilent": false
  }
}
```

Response (validation + per-field clamping on BOTH server and extension):

```json
{
  "mode": "patch",
  "patch": { "bassDb": 3 },
  "summary": "Increased bass while keeping your existing reverb.",
  "unsupported": []
}
```

`mode` = `patch | reset | unsupported`. `patch` contains **only changed keys** from `AudioEffectState`. `reset` discards the old state and returns neutral settings. `unsupported` is a concise array of unfulfilled operations. A command that has supported and unsupported portions can return `patch` plus `unsupported` notices. If absolutely no supported part exists, return `unsupported` with `{}`; no fake effect, no `Applied ✓` for an unsupported-only request.

Use the structured-output schema accepted by the selected Gemini model. If strict schema cannot express arbitrary sparse object keys, have the model output **all effect keys as nullable**, then strip nulls to form the patch; this is an acceptable wire normalization as long as the external contract above remains unchanged. Validate all output against Zod; sanitize summary text and strictly limit prompt length (<=500 characters). Never execute model-generated code, JS expressions, or graph definitions.

Prompt rules: make small relative changes for “a little more”, preserve unmentioned fields, interpret “leave X alone” literally, use gentle mixes for vague mood prompts, avoid extreme gains, choose effects based on *supplied current-state + coarse signal features*. Never claim to understand song identity/lyrics/chords from these metrics. User feedback must mention unsupported actions like slowing down playback, voice extraction or replacing instruments. Do not call the AI when user clicks a local preset or slider.

Server: read secret from `.env` (`GEMINI_API_KEY`, `GEMINI_MODEL=gemini-3.1-flash-lite`, `PORT=8787`), implement `/health`, 10–15-second model timeout, useful status codes, bounded input body and strict CORS (development `chrome-extension://` origins only). Bind loopback host. Avoid logging API keys, music, or whole prompt history. `server/.env` must be gitignored. Audio continues on all failures.

**AI concurrency:** Disable a second submission while interpreting; use request IDs. Manual slider or preset changes during an in-flight request either cancel it (`AbortController`) or make the response stale and ignore it. Apply only the latest valid patch and wait for an offscreen ACK to show success.

## Local controls and UI contract

- Visual design: quiet slate/charcoal or light-neutral palette, accent used sparingly, clean spacing, no chat bubbles, no stock AI gradients. Responsive to narrow side panel.
- Header `MoodShift`, status with current captured tab, subtle meter, prompt textarea, Apply/Enter, preset chips, an Original/Modified toggle, an accordion of labeled effect sliders/numbers, Reset and Stop.
- Show **real status transitions**: `Ready / Capturing / Interpreting… / Applying… / Applied ✓ / Offline / Error`. Do not claim audio is “AI remixed”. Unavailable AI? Say “Gemini unavailable. Presets and manual controls still work.”
- P0 presets have deterministic **explicit effect values** in `shared/effects.ts`; presets replace current effects (not incremental) and do not call server. Example presets: Dreamy (reverb .33, treble -2), Warm (bass +2, treble -3), Underwater (lowpass ~1000), Bass Boost (+5), Clear Voice (highpass ~100, bass -2, treble +2). All unspecified fields neutral. Keep output levels comfortable.
- Show `Listening to this tab · [title]`, not “all browser audio”. Show muted/silent state without dropping capture. Slider input creates same `APPLY_EFFECTS` offscreen path as Gemini response; UI updates on ACK. A/B original path should always work even if AI server fails.

## Build sequence — finish each milestone before moving on

### M1 — Audio path (stop-and-fix gate)

Manifest, action click, side panel open, offscreen creation, `tabCapture` capture, Web Audio neutral pass-through, stop cleanup, status. Deliver a tab capture you can actually hear; **do not spend time on the polished interface or AI before this works**. If browser UI testing is unavailable to Codex, implement from Chrome reference, unit-check, and document the exact steps the user must manually run. Never claim M1 is manually verified without testing it.

### M2 — DSP controls + background stability

Implement graph, all PRD effects, crossfades, presets, sliders, audio analyzer, reconnect/reopen behavior, stop/switch handling. Unit tests for clamping, neutral/reset, preserved fields, repeated updates, conflicting sessions.

### M3 — Gemini interpretation and resilient client

Implement local proxy, structured-output parser, validation, prompt rules, timeouts and request lifecycle. Side panel calls server and sends patch to offscreen; use update ACK for `Applied ✓`. Tests with mocked HTTP, malicious/invalid/malformed responses, relative commands and preservation. At least one actual Gemini test only if valid credentials are available; otherwise **clearly mark unverified**.

### M4 — UI polish + quality assurance

Finish minimalist side panel; README; error states; browser/manual test checklist; `TEST_RESULTS.md`. Fix actual compile/test problems. Do not claim direct media validation from unit tests alone.

## Required acceptance/testing discipline

- Unit tests: neutral defaults; each parameter clamped; unknown/non-finite values rejected; patch preserves other values; reset; preset deterministic; invalid AI JSON rejected; unsupported-only request never shows applied; old responses cannot override newer manual state; capture session idempotency wherever mockable.
- Run: `npm install`, `npm run build:extension`, `npm run typecheck`, `npm test`, `npm run dev:server` / `/health` smoke check. Correct failing commands.
- Manual Chrome test list from `PRD.md` must be included in `README.md` and `TEST_RESULTS.md`. Explicitly distinguish `PASS (automated)`, `PASS (manual)`, `FAIL`, and `NOT RUN`.
- Document a simple local signal fixture/test tab if helpful; never replace the real YouTube capture acceptance test with it.
- Source must be installable as unpacked Chrome extension from `extension/dist` and must work on authorized YouTube audio without API keys for local presets.
- Avoid fake simulation layers, APIs that don't exist, broad wildcard permissions, credentials in bundle, and unauthorized DRM workarounds. No Spotify-specific code in MVP.

## User instructions to produce in README

1. `npm install` at project root.
2. Copy `server/.env.example` → `server/.env`, paste local `GEMINI_API_KEY` there (never in extension or Git). Set model if different.
3. `npm run dev:server` in one terminal.
4. `npm run build:extension` (and document watch command if implemented).
5. Chrome → `chrome://extensions` → Developer mode → Load unpacked → choose `extension/dist`.
6. Play authorized music on YouTube, click extension toolbar icon **on that tab**, check the side panel, apply a local preset, enter a Gemini prompt, then A/B and Stop.
7. Troubleshooting: capture silent, Chrome audio permissions, AI server not running, expired model/credits, background tab, extension reload after rebuild. Extension reload may terminate current capture and requires re-clicking action icon.
8. State the actual scope: Chrome Windows/macOS and selected tab only; Spotify web playback possible but unverified / protected playback may fail; not standalone apps; no tempo rewrite.

## Delivery response format for Codex

Finish with a compact report: implemented files, runnable commands, which tests you **ran** and their results, whether a **real Chrome+YouTube** capture was personally verified, remaining blockers, and the exact single next manual action for the user. Complete as much as possible in one pass; do not spend time prompting the user about preferences already decided in `PRD.md`.

## API references / do not guess

- https://developer.chrome.com/docs/extensions/reference/api/tabCapture/
- https://developer.chrome.com/docs/extensions/reference/api/offscreen
- https://developer.chrome.com/docs/extensions/reference/api/sidePanel/
- https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture
- https://ai.google.dev/gemini-api/docs/structured-output
- https://ai.google.dev/api/generate-content
