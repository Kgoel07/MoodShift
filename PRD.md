# MoodShift — Product Requirements Document (Hackathon MVP)

**Version:** 1.0 · **Date:** 2026-11-14 · **Status:** Approved for implementation  
**Target:** Google Chrome 116+ on Windows and macOS; local development only  
**Primary demo:** YouTube music playing in a background Chrome tab

## 1. Product vision

MoodShift is an AI-controlled **live audio effects layer for a browser tab**. A listener plays music normally on YouTube, opens the extension, and types something like **“Make it dreamy, warmer, with more reverb and less treble.”** An AI converts that request into safe, precise audio settings. The audio changes *while the video keeps playing*, without downloading, recording, transcoding, or producing a new music file.

**Primary success moment:** A YouTube song is audible through laptop speakers or wired headphones; the user clicks the extension icon, opens its minimal side panel, enters a prompt, presses Enter, sees *Applying… → Applied ✓*, and clearly hears the transformation without playback interruption. Closing the side panel or switching tabs does not stop processing.

## 2. Platform and scope truths

- This is a **Chrome Manifest V3 extension**, not a native Windows audio driver or a general system-wide processor. It processes **one explicitly selected Chrome tab at a time**; other browser tabs, desktop apps, and games are unaffected.
- The same Chrome extension should work on **Windows and macOS**. Edge/Brave compatibility is possible later but **not guaranteed**; Firefox and Safari require separate adaptations.
- **Spotify Web Player in Chrome:** its audio may be capturable with the same tab-capture pipeline, so the architecture is not YouTube-specific. **It is an unverified, best-effort compatibility case**, not an MVP requirement: protected playback/DRM and application behavior may prevent capture. Never bypass DRM or represent success on Spotify as guaranteed. No Spotify API integration. Respect source terms; demo using audio authorized for processing.
- Browser tab capture does **not** provide access to Spotify/Apple Music native desktop apps or other OS sounds.
- Real-time = continuous low-latency DSP updates after the AI request completes. AI interpretation is **not** instantaneous; audio processing does **not** wait on cloud inference between samples.
- “Sad/dreamy/nostalgic” means **sound-design effects** (EQ/reverb/delay etc.), not re-harmonizing, genre conversion, replacement instruments, or generative music production.

## 3. Intended users and core journey

For casual listeners who want to change how browser music feels without learning audio engineering.

1. Play an authorized song or music video in a Chrome tab.
2. Click the MoodShift toolbar icon while the source tab is active. This **explicit gesture** starts capture for that tab and opens the extension side panel. The UI shows `Connected · [tab title]` (or an honest failure state).
3. Music continues through the extension's processing path, initially sounding unaltered.
4. Type a natural-language command; **Enter** submits, **Shift+Enter** inserts a line break, or click **Apply**.
5. UI shows `Interpreting…`, then `Applying…`, then `Applied ✓` **only after the audio engine acknowledges** the new settings. Changes smoothly ramp in over 250–400 ms.
6. Follow-up request (“a bit more bass, keep the reverb”) modifies existing settings rather than resetting everything.
7. User can try presets, edit sliders, **Original / Modified** A/B, **Reset effects**, and **Stop processing**. The side panel can close while audio processing continues.
8. To select another source tab, activate that tab and click the toolbar icon again; MVP supports **one session at a time**, switching cleanly.

## 4. Must-have features (P0)

### P0.1 Robust background tab audio processing

- Capture audio from the user-activated tab through `chrome.tabCapture` initiated via an extension action click, then redeem the stream ID in a persistent **offscreen document** (`USER_MEDIA`).
- Build a **Web Audio API** graph and connect one processed output to `AudioContext.destination`. Chrome normally stops a captured tab's direct output; the extension must reconnect the audio so the listener does not hear silence or doubled sound.
- Keep the graph/session in the offscreen document; never in a popup or UI that will close.
- Continue through switching tabs, minimizing Chrome, side-panel close/reopen, and Manifest V3 service-worker suspension. Stop when the captured tab closes, stream ends, user stops, or unrecoverable capture error occurs.
- Start with **neutral DSP/bypass**, preserving perceived source volume. At stop, release tracks and graph/context so Chrome returns audio to normal routing; offer clear retry if it fails.
- Detect silence/input loss and distinguish from a normal pause. No false `Connected` state when capture has ended.

### P0.2 Real-time DSP effects

Use **browser-native Web Audio** (no Python/native audio dependencies). All effect values must be clamped, safe, testable and independently configurable:

| Control / internal field | Range | Neutral/default |
| --- | --- | --- |
| Bass shelf (`bassDb`) | -12 to +8 dB | 0 |
| Treble shelf (`trebleDb`) | -12 to +8 dB | 0 |
| High-pass (`highpassHz`) | 20–1,500 Hz | 20 |
| Low-pass (`lowpassHz`) | 600–20,000 Hz | 20,000 |
| Reverb wet (`reverbMix`) | 0–0.55 | 0 |
| Delay time (`delayMs`) | 0–500 ms | 0 |
| Delay wet (`delayMix`) | 0–0.35 | 0 |
| Delay feedback (`delayFeedback`) | 0–0.40 | 0 |
| Distortion amount (`distortion`) | 0–0.50 | 0 |
| Output gain (`outputGainDb`) | -12 to +3 dB | 0 |

- Reverb: generated impulse response + `ConvolverNode`, with dry/wet balance.
- Echo: `DelayNode`, bounded feedback, controllable send/return.
- Filters: `BiquadFilterNode` high-pass, low-pass and low/high shelves.
- Distortion: gentle `WaveShaperNode` with controllable blend.
- Dynamic/compressor limiting and headroom to minimize clipping; never let LLM set arbitrary raw node values.
- Pre-allocate the graph; **never tear down/recreate `AudioContext` per prompt**. Smooth/ramp parameter changes so there are no clicks, jumps or dropouts. Effects should remain stable for long sessions.
- **A/B** smoothly crossfades original captured stream with processed stream; does not stop capture or reload video. **Reset** returns all controls to neutral, but continues capturing.

### P0.3 Natural-language AI interpretation

- **Use Gemini 3.1 Flash-Lite** as the default cloud interpreter on the Google AI Studio Free tier, with **editable local environment configuration** (key and model). Use a secure **local Node.js proxy** bound to `127.0.0.1`, never bundle an API key in the extension.
- Send the user's text, current effect state, and **non-identifying local audio metrics** to Gemini. Request machine-readable JSON (structured output where supported); validate with a runtime schema and clamp/deny unsafe values.
- Model responses should be **patches** of effect settings, not replacement of unspecified values. Requests like “reset everything” explicitly reset to neutral; “a little more” is relative to existing values; “don't change the reverb” retains reverb.
- Provide examples for dreamy, nostalgic, dark, underwater, concert hall, warm, heavy bass, clearer speech, subtle reverb, minimal distortion.
- Explicitly tell the user if their request contains unsupported features (actual slowing, removing vocals, source separation, changing chords, new instruments, song recognition). Optionally apply supported parts but never claim the unsupported operation occurred.
- If the model/API is unavailable, **existing audio remains uninterrupted**, the UI shows a recoverable error, and user can still use presets and manual sliders. A clearly labeled local preset mode is acceptable for offline testing; do not present it as a successful Gemini response.
- `Applied ✓` means DSP state has been updated successfully, not merely that a server returned JSON.

### P0.4 Small but genuine local audio awareness

- Include `AnalyserNode` in the offscreen pipeline. Locally compute rolling ~2-second signals: RMS loudness, low/mid/high band energy, approximate brightness, and input-silent boolean.
- Surface a restrained meter/indicator in the side panel and send a **bounded summary** (not raw or recorded copyrighted audio) with each prompt to Gemini so settings can account for whether input is already bass-heavy, loud or bright.
- Be transparent: these are **simple signal features**, not recognition of instruments, BPM, key, chords, lyrics, mood, or song identity. No periodic cloud calls while the user listens.
- Analytics/meter calculations must be throttled (approximately 4–5 Hz locally; UI updates <=4 Hz) and must not degrade audio.

### P0.5 Minimal, polished extension UI

Use an extension **side panel** (rather than a popup that would terminate audio capture). Quiet, modern, minimalist styling, no generic AI-chat appearance. Show:
- Brand/logo, active-tab title, and capture status (capturing / paused or silent / disconnected / error).
- A small live audio-level indicator.
- One prompt field with clear Enter behavior; `Interpreting…`, `Applying…`, `Applied ✓`, and useful errors.
- Presets: **Dreamy**, **Warm**, **Underwater**, **Bass Boost**, **Clear Voice**, **Reset**. Presets work **without an API key**.
- A compact advanced section with effect sliders and current numeric values.
- Original/Modified A/B toggle, Reset, Stop. No voice microphone, song uploads, registration, accounts, databases, or cloud storage.
- Labels must tell the user that capture applies to the *selected tab*, not all browser audio.

## 5. Out of scope (P1+)

Voice input/speech-to-text; native Spotify/Apple Music; system-wide or game audio; audio recording/download; stem separation, vocal isolation, instrumental extraction; true playback slowdown; pitch shift; key/chord/genre rewriting; generative remixing; automatic song identification; mobile Chrome extensions; cloud hosting; synced preferences across devices; multi-tab simultaneous capture; waveform/history dashboards.

**Why no true “slower” command now:** incoming streamed audio arrives in real time; playing it continuously at 0.8× would create unbounded buffer delay unless the original player speed is controlled. Do not fake it with EQ/reverb. This can be added as a separate YouTube-player-control feature later.

## 6. Reliability and safety requirements

- Audio capture/processing must be entirely **local and continuous**. If backend or network goes down, audio continues under the last applied settings.
- No unintended amplification jumps; conservative limits and output limiting. Never promise zero clipping for arbitrary sources.
- No double playback, echo from accidental parallel raw output, persistent silence after stopping, feedback loops, or full-graph rebuilding on each update.
- Model provider timeouts, malformed JSON, extension lifecycle changes, tab navigation, multiple fast icon clicks, stream end, tab closure, empty prompts, and stale responses must have explicit handling.
- For concurrent AI requests: **one request at a time**, or request IDs with stale-reply rejection. Never let an older response silently override a newer manual edit.
- Do not store/record/send raw music. No Spotify/YouTube API scraping. Avoid permissions beyond tab capture, offscreen processing, UI, local backend access and minimal tab metadata.
- No DRM circumvention. Use legally authorized audio for the demo; playback on third-party protected streaming services is best-effort and subject to applicable terms.

## 7. Acceptance criteria / live demo checklist

The MVP is **accepted** only after these are verified in Chrome on a real audio-playing tab:

1. Click extension icon on YouTube tab; side panel opens and the video audio remains audible without doubled output.
2. Apply **Dreamy** without any AI key: audible reverb/EQ change in <0.5 sec; YouTube playback position keeps advancing.
3. Open another tab or switch application, close side panel, then reopen it: processed sound keeps playing and state remains intact.
4. Enter **“Make it warmer and more dreamy”**; real Gemini call returns; panel acknowledges only after applying; bass/treble/reverb change audibly while playback continues.
5. Enter **“A little more bass, keep the reverb”**; bass increases, reverb is preserved, and other unaffected controls retain values.
6. Original/Modified toggle produces a clear smooth A/B change; Reset removes effects while maintaining capture.
7. Modify a slider during playback; effect changes smoothly, UI and saved state agree.
8. Disconnect/stop local AI server; music **does not stop**; preset and sliders still function; prompt shows error and recovery instruction.
9. Stop processing or close source tab; capture ends gracefully and normal browser audio resumes for newly playing tabs.
10. Test on speakers and/or wired headphones; no repeated stutter or obvious feedback over a 10-minute listening run.
11. Run automated schema/state/parameter unit tests and extension build with no errors. Real browser capture may require **manual** testing and must be reported as such if not performed.
12. Best-effort **Spotify web-player smoke test only if time permits**; log success/failure as observed, do not mark core MVP blocked by it.

Performance targets are goals, **not verified guarantees**: steady-state DSP additions should feel low-latency; apply parameter changes within ~400 ms **after** the AI response; model network round-trip may take seconds. Test on Chrome Windows first and macOS if hardware is available.

## 8. Delivery definition

A source-controlled project with the built unpacked extension, local AI proxy server, `.env.example`, usable README with one-time Chrome installation instructions, automatic unit tests, and a `TEST_RESULTS.md` distinguishing automated tests from actually performed browser checks. No mock screenshot or untested claim may be passed off as a working end-to-end demo.

## 9. Reference documentation

- Chrome tabCapture: https://developer.chrome.com/docs/extensions/reference/api/tabCapture/
- Chrome audio capture + offscreen recipe: https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture
- Chrome offscreen: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Chrome sidePanel: https://developer.chrome.com/docs/extensions/reference/api/sidePanel/
- Gemini structured outputs: https://ai.google.dev/gemini-api/docs/structured-output
- Spotify web player / protected-content caveats: https://support.spotify.com/us/article/web-player-help/
- Spotify Developer Policy (if any Spotify Platform integration is later attempted): https://developer.spotify.com/policy
