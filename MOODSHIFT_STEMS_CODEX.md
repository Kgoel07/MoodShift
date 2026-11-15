# MoodShift — Phase 2 Codex Instructions: Real Live Stem Separation

**Use in the EXISTING repository. Do not generate a new project.** Read this file, then inspect only the necessary existing source. Preserve the working Chrome extension and Gemini interpreter. This file is the authoritative change request for Phase 2 where the original PRD/AGENTS.md declared stem separation out of scope. Do not begin the proposed USB audio hardware project.

## Verified baseline from the provided repository (not inferred from screenshots)

- Existing `TEST_RESULTS.md` records 45 passing tests, a successful Chrome/YouTube **automated** capture, and a working offscreen `AudioContext` with effects, presets, A/B, and tab switching. Human listening, an actual Gemini request, and macOS were **not** tested. Do **not** mark those as verified.
- `extension/src/audio-engine.ts` owns the current Web Audio chain; `extension/src/offscreen.ts` owns the captured `MediaStream` and its lifetime; `extension/src/background.ts` manages selected-tab sessions; `extension/src/shared/{types,messages,effects}.ts` defines messages and effect state; `extension/src/sidepanel.ts` renders the interface; `server/src/{index,interpret,schema}.ts` implements **Gemini** (not Grok). `scripts/build-extension.mjs` bundles the extension. Read these first.
- `server/src/interpret.ts` already explicitly says that source separation is unsupported, and the existing tests cover unsupported-only handling. **Do not spend a milestone rewriting the existing unsupported handler.** Extend it *only once real stem functionality is available*.
- Retain existing commands, effect parameters, presets, neutral passthrough, original/modified monitoring, per-tab capture, local-only Gemini proxy, output routing, and tests. No redesign, no new framework, no Grok migration.

## Required outcome and scope

Provide real, audible **two-stem** playback from a live authorized Chrome/YouTube tab:

1. **Full mix** (existing effects continue working).
2. **Instrumental only** (actual vocal attenuation with a pretrained separator, **not** EQ or center cancellation advertised as AI).
3. **Vocals only** (actual accompaniment attenuation).
4. **Original** bypass with clear behavior when live separation is active.

Separate `stemMode` from `AudioEffectState`; keep all existing DSP sliders applicable after selecting a stem. Implement simple **Instrumental** and **Vocals** buttons; the existing prompt field must understand `just play instrumental`, `vocals only`, and combined phrases like `remove vocals and add more reverb`. Once the selected stem mode has *actually* been activated, show an ACK. If disabled/unavailable, show an honest reason, never `Applied ✓`.

**Defer:** drums-only/beat-only, bass-only, 4/6 stems, instrument regeneration, genre rewriting, changing YouTube tempo, cloud raw-audio processing, downloadable song files, mobile device support, and dedicated USB hardware. `Underlying beat` is NOT the same as instrumental; show unsupported until a genuine drums stem exists. No recording, audio uploads, DRM bypass, or Spotify-specific code.

## Gate 1 — Performance proof BEFORE integration

Choose **one** workable two-stem pretrained model with redistributable/legal weights and a documented local runtime. Preferred FIRST experiment: **localhost Python helper** using an ONNX UVR/MDX vocal/instrumental model, informed by `nnyj/python-audio-separator-live` (MIT wrapper; verify model weight and transitive licenses separately). It demonstrates a chunked MDX-NET streaming scheme with overlap; its advertised ~1.7-second delay is **hardware-specific**, not a promise. The current Node/Gemini backend must continue to work independently. This Python service is for audio only, on the local machine.

References for implementation investigation:
- https://github.com/nnyj/python-audio-separator-live
- https://github.com/nomadkaraoke/python-audio-separator
- https://github.com/KGAudioLab/K.G.Studio (in-browser ONNX models, **offline file processing**, not proven live)
- https://github.com/elicwhite/bs-roformer-web (in-browser file-based separation; reference only)

A WebGPU in-extension implementation is acceptable **only if you verify an existing streaming-compatible model/runtime and can demonstrate live throughput**. Do not spend time shoehorning a file-upload separator into a live `AudioWorklet` and pretend it is low-latency. Do not paste random remote JS/WASM into Manifest V3; extension executable code must be bundled locally. Avoid implementing a custom neural model or training a model.

1. Detect machine GPU, compute backend, sample rates and available memory; do not assume NVIDIA CUDA or an M-series Mac. Provide CPU fallback **only if it benchmarks fast enough**.
2. Add a small benchmark that separates an **authorized** local 15–30-second mixed-vocals-and-instruments sample (or user-supplied royalty-free fixture) into two audible outputs; also test deterministic synthetic input for stream integrity. Measure model load/download, inference duration vs audio duration, memory use if available, and potential buffer delay. Note model size/download requirements.
3. Streaming check: process multiple successive windows with overlap, and demonstrate that compute sustainably handles more than 1 second of incoming audio per 1 second elapsed; target **inference <= 0.8 × the audio duration per window** to leave headroom. Measure **actual** end-to-end lag rather than just model inference. Prefer an initial target of **<= 3 s audio delay**; label failures or larger delays clearly rather than faking a pass. Use two or more minutes of source for sustained throughput checks if environment permits.
4. **Hard stop / safe fallback:** If no functioning fast model exists on this machine, leave MoodShift functional and unchanged, document the results in `STEM_FEASIBILITY.md`, and clearly expose stem buttons as unavailable or omit them. **Do not** claim stem modes work. Then stop feature integration and report the blocker.

## Gate 2 — Stream integration (only after Gate 1 passes)

Architecture must remain:

`Chrome selected tab -> offscreen document -> Web Audio input -> (streaming PCM AudioWorklet -> localhost separator -> bounded output buffer) -> selected stem -> existing DSP graph -> AudioContext destination`

- Keep `chrome.tabCapture`/offscreen/session lifecycle intact. Use a separate `AudioWorklet` for frame capture/playback and a worker or other non-audio-thread mechanism for PCM marshaling, buffering, and local inference communication. **Never** call neural inference, network I/O, JSON parsing, or heavy allocation directly in the audio render callback.
- Locally stream binary PCM to a **localhost-only WebSocket** (or another demonstrably efficient local transport), with explicit sample rate, channel layout, buffer sequence numbers/timestamps, and bounded buffers. Choose one sample rate for the model (often 44.1 kHz) and correctly resample from the browser's `AudioContext` rate (often 48 kHz); preserve stereo if model supports it, and handle mono safely. Do not silently change pitch by mismatching rates.
- In the localhost helper, preserve ordered frames, overlap inference windows, trim/crossfade boundaries, and maintain steady output consumption. Keep maximum queue lengths bounded; report processing/underrun state. A growing backlog is a failure: do not let audio fall further and further behind. Provide a reconnect/reset mechanism. Audio samples must remain local and **must not** be saved to disk or sent to Gemini.
- **No duplicate audio:** Keep exactly one audible path at a time. Existing original/full-mix graph is the fallback until stem output has enough samples. When enabling separation, clearly show `Loading model` / `Buffering` before activating; switch safely with gain ramps. While separated audio is delayed, **align the original/full-mix path to the same delay for A/B within separation mode**, or explicitly perform a resynchronizing switch rather than claiming a phase-aligned, instant comparison. Audio may be behind the YouTube **video** by the reported delay: document that limitation; do not claim lip-sync.
- On slow inference, startup failure, helper shutdown, tab close, change of source tab, mute, stream end, Chrome worker suspension, or extension stop: end/recover streams cleanly, never leave the original tab permanently silent. If possible fall back automatically to the existing live full mix (and display that the stem feature stopped). Avoid output volume spikes/clicks with ramps and existing limiter.
- `Original` should mean the original mixed source and `Full mix` should mean the original source through existing effects; maintain distinction from `Instrumental only` and `Vocals only`. The UI can use a separate stem selector alongside existing original/modified controls; do not try to encode stem mode using the ten EQ sliders.
- Preserve privacy: process PCM entirely on `127.0.0.1` and validate WebSocket `Origin`/authorized session; avoid opening an unauthenticated listener to the network or arbitrary websites. Do not log/store audio; no unnecessary permissions. No API keys in extension or Git. Any new native helper must have precise startup steps.

## Gate 3 — Gemini + UI wiring

- Add typed `StemMode = 'full' | 'instrumental' | 'vocals'` and a separate availability/processing status in `extension/src/shared/types.ts` and `messages.ts`. Extend `offscreen.ts` and `audio-engine.ts` without regressing effect state revision protections or A/B. Audio-effect changes and stem changes must remain independent and support mixed requests.
- Update `server/src/schema.ts` and `interpret.ts` so Gemini produces either a DSP patch, a stem request, both, or an unsupported notice. Update the existing strict schema, client parser and tests together. **Gating:** Gemini is a controller, not a separator; only activate a stem mode if the local model has passed runtime readiness checks. Never let the model hallucinate that `beat-only` or full AI recomposition exists.
- Make direct UI buttons work even with Gemini unavailable. For obvious direct commands (`instrumental only`, `vocals only`, `back to full song`) deterministic local intent parsing is acceptable as a zero-credit fallback, without falsely displaying `Gemini interpreted`.
- Keep UI minimalist: one concise `Stems` group, selected mode, `Loading / Buffering / Active / Unavailable / Error` line, optional reported latency. Do not create a large dashboard or redo the design. Preserve existing sidepanel presets and sliders.

## Tests and stop conditions

**Automated, no fake audio-success tests:**
- Model benchmark/output exists on a *real* mixed voice+instruments fixture and demonstrates meaningful audible vocal attenuation/retention. Merely receiving PCM / mock sine waves **does not** prove separation quality.
- Streaming transport tests: ordered frames, sample-rate conversion, bounded queues, drop/recover, late chunks, pause/silence, tab/session switches, helper disconnected, stale async results, and clean teardown.
- UI/schema tests: disabled/unavailable mode never says `Applied`; `just instrumental` selects only real instrumental mode; `vocals only`; `remove vocals and increase reverb` preserves unrelated settings; `beat only` remains unsupported. Existing 45-test suite must stay passing or clearly explain changes.
- Run `npm run build:extension`, `npm run typecheck`, and `npm test` and any Python helper tests. Build includes any audio worklet asset in `extension/dist`; include new docs and install commands.

**Manual checklist, to show user rather than pretend to execute:**
1. Launch the local helper and existing Gemini proxy (if necessary). Load extension and a licensed YouTube music/video tab. Confirm normal sound without stems.
2. Choose `Instrumental` and listen: singer substantially disappears while music remains. Choose `Vocals`: accompaniment is substantially reduced. Try switching several times and adding reverb to vocals.
3. Leave song playing for 2+ minutes; check no accumulating delay, repeated silence, pops, or double playback. Observe video sync limitation and note output latency.
4. Stop helper abruptly, Stop processing, switch tabs, close source tab, close/reopen panel; confirm graceful fallback and session cleanup.
5. Prompt `just play instrumental`; prompt `just play the beat`; ensure only first succeeds if model ready and second is honestly unsupported.

## Required deliverables / honest reporting

1. `STEM_FEASIBILITY.md`: selected model & license/weight attribution, hardware measured, inference benchmark, actual audio delay and continuous performance, privacy, and whether streaming is **PROVEN / EXPERIMENTAL / BLOCKED**.
2. Updated code **only if feasibility gate passes**, plus `README.md` with exact helper setup and test instructions.
3. Updated `TEST_RESULTS.md` (do not overwrite existing baseline evidence). Distinguish `PASS (automated)`, `PASS (manual)`, `FAIL`, `NOT RUN`, and `BLOCKED`.
4. Brief final response: what implemented, whether a real YouTube live stem was tested, commands to run, any model downloads/setup and **one exact user action** to verify. Do not claim the project is complete based on models, mocked samples, or inference performance alone.

**Scope priority:** Reliable *two-stem* live isolation > every other feature. Do not start four-stem separation, cross-platform packaging, Grok, USB hardware, or extra visual polish in this phase. Work without repeated clarification; use the project defaults and document any environmental blockers.
