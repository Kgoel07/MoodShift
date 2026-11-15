# MoodShift test results

November 14, 2026 · Windows · Node.js 22.20.0 · Chrome 157.0.8103.52

| Automated check | Result | Evidence |
| --- | --- | --- |
| `npm install` | PASS (automated) | Installed 137 packages and generated `package-lock.json`. |
| `npm run build:extension` | PASS (automated) | Bundled the worker, offscreen document and side panel into `extension/dist`. Chrome loaded it as an unpacked extension. |
| `npm run typecheck` | PASS (automated) | TypeScript completed with no errors. |
| `npm test` | PASS (automated) | 45 tests passed across effects, schema, intent, mocked Gemini HTTP, and real loopback routing. |
| `npm run dev:server` and `GET /health` | PASS (automated) | HTTP 200, `{"ok":true,"aiConfigured":false,"model":"gemini-3.1-flash-lite"}`. A valid local interpretation request returned HTTP 503 with instructions for adding the key. |
| Chrome local tone | PASS (automated) | The real extension action opened the panel and started an offscreen capture. The running Web Audio graph received the tone at approximately 0.071 RMS. Dreamy, A/B, Reset, slider ACK, repeated action, source switch, source closure, stale session, and Stop checks passed. |
| Chrome prompt behavior | PASS (automated) | Offline feedback, unsupported-only feedback without Applied, ACK for a supported patch, and protection against a delayed response after a preset edit were exercised. Model replies were mocked. |
| Chrome + YouTube | PASS (automated) | A real YouTube tab supplied a non-silent stream to the offscreen analyser. Dreamy returned an ACK and persisted through backgrounding and closing/reopening the panel. The service worker went idle and restarted with the same offscreen session and settings. Playback advanced through the check and Stop cleared capture. |
| Real Gemini call and model access | NOT RUN | No Gemini API key was configured. |
| Human listening and macOS | NOT RUN | Chrome runs were automated on Windows. Audible output, perceived delay, level, smoothness, and long-session quality require listening. |

The sandbox initially blocked npm registry access and loopback HTTP. Install, the HTTP suite, and the proxy health probe passed when run with the necessary access. Early browser attempts also exposed test setup problems with a reused profile and reopening a background tab. The passing run used a fresh profile and focused the YouTube tab before invoking the action again.

## Chrome acceptance checklist

| # | Check | Result |
| --- | --- | --- |
| 1 | Click MoodShift on authorized YouTube music. Confirm the panel opens and audio continues at normal level without doubling. | PASS (automated) for open/capture and measured input. NOT RUN for listening. |
| 2 | Without an AI key, apply Dreamy. Confirm audible EQ/reverb within 0.5 s while the video advances. | PASS (automated) for effect ACK and advancing playback. NOT RUN for audible timing. |
| 3 | Switch tabs, close and reopen the panel, and confirm processed sound and state persist. Repeat with application switching and minimizing. | PASS (automated) for tab switching, panel close/reopen, worker suspension and retained state. NOT RUN for minimizing and application switching. |
| 4 | Submit “Make it warmer and more dreamy” to Gemini. Confirm acknowledgment after DSP and audibly changed bass, treble or reverb. | NOT RUN. |
| 5 | Submit “A little more bass, keep the reverb.” Confirm more bass and preserved reverb and unrelated values. | PASS (automated) with mocked upstream. NOT RUN against Gemini. |
| 6 | Compare Original/Modified, then Reset. Confirm smooth audibly distinct A/B and neutral capture after Reset. | PASS (automated) for monitor state, Reset and continued capture. NOT RUN for listening. |
| 7 | Change a slider. Confirm the value is acknowledged and the audible change is smooth. | PASS (automated) for slider and acknowledged value. NOT RUN for listening. |
| 8 | Stop the proxy. Confirm music and local controls continue and the prompt reports a recoverable error. | PASS (automated) for missing-key or failed fetch handling and local controls. NOT RUN for a live-key outage with listening. |
| 9 | Click Stop processing, then test closing the source tab. Confirm normal browser output resumes. | PASS (automated) for Stop, released capture and tab-close cleanup. NOT RUN for direct speaker output restoration. |
| 10 | Listen for 10 minutes on speakers or wired headphones for stutter and feedback. | NOT RUN. |
| 11 | Run the automated schema/state tests and extension build. | PASS (automated). |
| 12 | Optional Spotify Web Player smoke test. | NOT RUN. |

**PASS (manual)** indicates an observed human check. **FAIL** indicates a reproducible check that failed. Neither status applies to the baseline checks above.

## Phase 2 live stems

All 45 baseline tests remain in the suite. Phase 2 adds nine TypeScript tests and four Python tests. The browser evidence above is retained from the original implementation.

| Phase 2 check | Result | Evidence |
| --- | --- | --- |
| Extension build and type check | PASS (automated) | Builds both local AudioWorklet and dedicated worker assets and passes TypeScript. |
| `npm test` | PASS (automated) | 54 tests, including direct stem intents, unsupported beat/drum isolation, schema validation, and mixed stem plus effect patches. |
| Python self-test and transport suite | PASS (automated) | STFT and overlap integrity, stereo ordering, 44.1/48 kHz conversion, malformed and late packets, inference deadline, Origin rejection, session exclusivity and reconnect. |
| Gate 1 on RTX 3070 Laptop GPU | PASS (automated) | 120-second paced input, 8.76× processing throughput and zero missed software playout deadlines. 24-second Realtek WASAPI test measured 2.800 s input-to-DAC latency and zero missing frames. |
| Real mixed sample separation | PASS (automated) | Wrote the 24-second vocal and instrumental WAVs. The separate known-reference check measured 23.91 dB vocal rejection in the instrumental stem and 45.31 dB backing rejection in the vocal stem. See [STEM_FEASIBILITY.md](STEM_FEASIBILITY.md). |
| CPU-only stem streaming | FAIL | 0.42× throughput. CPU-only live fallback remains disabled. |
| Locally captured vocal-and-guitar tab | PASS (automated) | Both modeled PCM outputs reached the Chrome worklet. The media playhead advanced 121.2 s while the stem session stayed active. Prompt-driven selection, Original/Modified, mocked Gemini mixed request, unsupported beat, pause, source switch, helper reconnection and loss, full-mix fallback, and Stop passed. |
| Real YouTube stem capture | PASS (automated) | Headless Chrome measured distinct, nonzero stem signals from the artist’s YouTube tab and acknowledged both modes. Helper loss restored full mix. A separate standard YouTube regression passed for Dreamy, background playback, panel reopen and Stop. [YouTube stem source](https://www.youtube.com/watch?v=OEAowPzDnaw) · [Artist’s remix source material](https://www.bradsucks.net/news/archives/2004/05/03/making-me-nervous-source) |
| Manual listening, audible crossfades, and speaker perception | NOT RUN | WASAPI device timing and Chrome PCM measurements were automated. Use the stem listening checklist in [README.md](README.md). |
| Live Gemini stem interpretation | PASS (automated) | Gemini 3.1 Flash-Lite returned HTTP 200 with `stemMode: instrumental` and a `reverbMix: 0.28` patch for “remove vocals and add more reverb” with synthetic features. A separate live Gemini request from the Chrome panel selected Instrumental and increased reverb on the YouTube tab while preserving bass. |
| macOS stems and unsupported or slow Windows adapters | BLOCKED | This helper uses Windows DirectML. A host must pass its runtime checks before Chrome can activate a stem. |

The longer YouTube attempt kept the stem session active for two minutes but failed the minimum playhead advancement check. The sustained playback result above uses the local fixture. Human listening on YouTube remains part of acceptance.
