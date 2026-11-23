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

## Synchronized lyrics

| Check | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck` and `npm run build:extension` | PASS (automated) | The unpacked build includes the YouTube content script and lyrics panel. |
| `npm test` | PASS (automated) | 74 tests, including 20 lyrics tests for title normalization, song and capture changes, stale requests, LRCLIB recording selection and errors, timed parsing, seek, pause, rate and offset. The 54 existing tests also passed. |
| Python stem transport | PASS (automated) | All four existing tests passed. |
| YouTube and LRCLIB | PASS (automated) | Chrome 157 loaded live synchronized lyrics for Jonathan Coulton’s “Code Monkey” and verified the title, artist, active line, pause, seek, playback rate, manual offset, and panel reopen. [Official track](https://www.youtube.com/watch?v=AEBld6I_AKs) |
| In-tab YouTube navigation | PASS (automated) | A related video replaced the lyrics metadata in the same document and capture session. A pre-roll exposed a timing edge case during development. MoodShift now displays the incoming song’s identity and waits for its playback clock before looking up lyrics. |
| Audio coexistence | PASS (automated) | The local tone regression passed. Dreamy and the real DirectML Instrumental stem both worked on the YouTube capture with lyrics visible. |
| Human listening and manual offset calibration | NOT RUN | The Chrome smoke test checked displayed state and active audio routing programmatically. |

## Chords, My Presets, and personalization

November 14, 2026 · Windows · Node.js 22.20.0 · Chrome 157.0.8103.52

| Check | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck`, `npm run build:extension`, `npm test` | PASS (automated) | The final build passed type checking. All 93 Vitest tests passed, including 19 new tests and all 74 existing tests. |
| Python stem transport | PASS (automated) | All four existing `test_stem_*.py` tests passed. |
| Songle live in Chrome | PASS (automated) | Songle’s documented recording returned a real timeline. Chrome verified Eb → Eb/Ab, forward and backward seeks, pause, rate and shared offset, the guitar and piano diagrams, local cache storage, and Stop. [YouTube recording](https://www.youtube.com/watch?v=PqJNc9KVIZE) · [Songle API](https://widget.songle.jp/docs/v1?lang=en) |
| Chord provider error and stale-state handling | PASS (automated) | 404, malformed and empty data, provider errors, ads, timed gaps, and an old response after a video change were exercised with mocks. |
| Saved presets in Chrome | PASS (automated) | A saved preset survived a full Chrome restart and restored Dreamy’s exact reverb and treble, plus Original mode, on a different tab with fetch blocked. A separate real YouTube test saved and restored DSP settings and an active Instrumental stem. Unit tests exercised rename, update, deletion, invalid data, overlapping saves, and a missing stem helper. |
| YouTube audio, lyrics and live stems | PASS (automated) | YouTube capture, LRCLIB seek/rate/offset sync, active Instrumental alongside lyrics, panel reopen, in-tab navigation, and service-worker suspension with session recovery passed. Both DirectML outputs reached the Chrome worklet on the licensed track. Prompt effects, A/B, pause/resume, tab switch, helper loss and Stop passed. The Chrome tests used disposable bundles and separate helper ports because another session already held port 8788. |
| Live Gemini and personalization fallback | PASS (automated) | `GET /health` returned HTTP 200. The live proxy returned a +2 dB bass patch and left reverb unchanged with Supermemory unconfigured. Live Gemini applied Instrumental and added reverb on the captured YouTube tab. With a synthetic preference for strong bass, “Remove all bass” returned a −12 dB patch. |
| Supermemory v5 SDK and Chrome controls | PASS (automated) | SDK calls used mock HTTP responses and verified the namespace, opt-in lookup, distinct scope, write and view, remote deletion acknowledgment, no-key fallback, upstream errors and timeouts. Chrome exercised opt-in/out, both explicit save paths, view and clear. The running proxy returned an actionable HTTP 503 for memory without a key. |
| Real Supermemory add, profile, and delete | NOT RUN | No `SUPERMEMORY_API_KEY` was available. |
| Human listening, diagram usability, and timing by ear | NOT RUN | Run the Chrome and stem listening checklists in [README.md](README.md). macOS stems and CPU-only live stems retain the hardware limitations recorded above. |

Cloud-build and deployment preparation checks are recorded in [CLOUD_DEPLOY_STATUS.md](CLOUD_DEPLOY_STATUS.md).

## Local preferences and Home / Advanced

| Check | Result | Evidence |
| --- | --- | --- |
| Typecheck, development build, and production build | PASS (automated) | `npm run typecheck`, `npm run build:extension`, and `npm run build:extension -- --mode production`. |
| Full Vitest suite | PASS (automated) | 106 tests, including local preference storage, relevance and limits, the authenticated shared-demo interpretation path, and existing private-owner Supermemory checks. Loopback access was required for the HTTP tests. |
| Home and Advanced in Chrome | PASS (automated) | Keyboard navigation, preset application in both tabs, preserved prompt processing, one audio session and uninterrupted signal while the panel was closed, and selected-tab recovery on reopen. |
| Preferences and saved presets in Chrome | PASS (automated) | Local saves, edits, deletions, and opt-out. Preferences, opt-out, and exact audio presets persisted across Chrome restart. Chrome exercised both builds with mocked Gemini and Supermemory. |
| Active stem in production Chrome with the laptop helper | PASS (automated on retry) | Both stem outputs produced PCM from the local fixture. The active Vocals session survived Home and Advanced navigation on both runs. The first run reported the stem unavailable after pausing. The standalone rerun passed pause/resume, A/B, tab switch, reconnection, and Stop. |
| Live YouTube listening and live providers on this revision | NOT RUN | In desktop Chrome, open Advanced while playing a YouTube track, try the lyric offset and chord diagrams, and switch tabs while applying a preset and an active stem. On the updated backend, try a broad Gemini prompt with a local preference, then give a conflicting explicit instruction. Check live Supermemory only with a configured private owner or local backend. |

## Local reverb audio effects — November 22, 2026

Branch `feature/reverb-audio-effects` starts directly at `feature/advanced-ui-local-memory` commit `34c01013058d00a49dd94f40a3903d99a62d25dd`. No cancelled mask source or commits were used; existing untracked mask files were left untouched.

| Check | Result | Evidence |
| --- | --- | --- |
| Typecheck | PASS (automated) | `npm run typecheck`. |
| Development and production extension builds | PASS (automated) | Both standard build commands passed; production output is `extension/dist-cloud`. |
| Full JavaScript suite | PASS (automated) | 112 tests across 12 files, including five new reverb/lease tests and a saved-preset compatibility test. |
| Existing Python stem regressions | PASS (automated) | Nine tests; no GPU model execution or benchmarking. |
| Real Chrome offline audio rendering | PASS (automated) | Chrome 157.0.8103.80 rendered actual ConvolverNodes. Disabled reverb reproduced the impulse at the same sample with maximum error 2.98e-9. Dreamy/Hall/Slowed tail energies were 0.007168/0.006144/0.008704 for a 0.2 impulse. A 0.4-second response had no late tail after two seconds; a four-second response did. These are signal checks, not listening ratings. |
| Local captured audio without a backend | PASS (automated) | Chrome captured the generated WAV fixture and, in the final run, the existing local STAY MP3. All presets, amount, duration, enable/disable, Original/Modified, pause/resume, panel closure/reopening and Stop passed. A tap at the actual output measured RMS 0.003731 while captured-input RMS was zero after pause, verifying a real reverb tail in the extension pipeline. No Gemini requests; one AudioContext per capture; no convolver before enable; wet nodes disconnected after disable. |
| My Presets | PASS (automated) | Customized amount/duration/style saved to local storage, another preset applied, and the saved settings restored through an ACK. Legacy records remain valid. |
| Instrumental/Vocals/Full Mix with reverb | PASS (automated with a protocol fixture) | The real stem worker, transport and AudioWorklet path used an isolated loopback test server emitting half-gain vocal PCM. Switching all three modes preserved reverb settings. This does not verify actual AI source-separation quality. |
| Live YouTube slowdown and restoration | PASS (automated) | On the supplied STAY video, prior rate 1.25× became 1.0625×. Renewal and panel closure preserved it. Changing preset, disabling reverb, Stop, and switching capture back to the local tab restored 1.25×. The new source started neutral and Stop released it. |
| Unsupported-source slowdown | PASS (automated) | Local playback retained reverb and explicitly reported YouTube-only speed support. No simulated slowdown. |
| User override, unavailable player and crashed-extension lease expiry | PASS (unit tests) | Explicit player speed changes are preserved; refused/unsupported rate changes do not claim slowing; a seven-second expired lease restores the original rate. |
| Human listening, perceived clicks, physical latency and long-session GPU separation with reverb | NOT RUN | Listen to each preset, adjust intensity/duration during music, and compare Original with reverb enabled/disabled. Start the actual worker separately for a sustained Vocals/Instrumental listening check. |
| macOS and speed control outside YouTube | NOT RUN / unsupported | macOS was unavailable. Other sources keep reverb but have no slowdown integration. |

The first browser attempts exposed test-harness issues with repeated CDP variable declarations, loading a reopened panel, activating the source before triggering its toolbar action, and sending Stop through the real panel. These were corrected; the final full integration run exited successfully. No product failures were suppressed.

Commands, file inventory, architecture, limits and manual steps are in [Reverb audio effects](docs/REVERB_AUDIO_EFFECTS.md). The existing separator model, configuration and buffer lengths are unchanged. No GPU benchmark, cloud deployment or additional dependency was introduced.

## Home and Settings refresh — November 22, 2026

`feature/reverb-audio-effects` was already committed at `d4aaa47` and pushed to its matching branch on `origin`. The local `feature/ui-settings-home-refresh` branch starts directly at that commit.

| Check | Result | Evidence |
| --- | --- | --- |
| Builds and typecheck | PASS (automated) | Development and production bundles and `npm run typecheck`. |
| JavaScript and Python tests | PASS (automated) | 110 JavaScript tests and nine Python stem tests. The new tests cover Home defaults and stored selections, negative and fractional slider fills, domain detection, and artwork URL validation. |
| Home and Settings in Chrome 157.0.8103.80 | PASS (automated) | Four quick presets, exact preset selection, keyboard tab navigation, slider DSP acknowledgments and fill, Home customization, storage across panel reopen, and access to hidden Home sections from Settings. Switching views kept the same audio session and controls. |
| Narrow layout | PASS (visual inspection and automated) | Inspected actual extension renders of Home, Settings, and expanded Audio Controls at 320 CSS pixels. Checked horizontal overflow at 320 and 250 CSS pixels. Slimmed the scrollbar after inspection. |
| Player information and lyrics | PASS (automated) | Real YouTube playback showed the current title, artist and thumbnail. Local captures showed a generic music icon and cleared stale artwork when switching tabs. Live LRCLIB lyrics passed Home placement, pause, seek, playback rate, offset, reopening, and YouTube in-tab navigation. |
| Original branding | PASS (automated) | Chrome decoded the original logo at all four manifest sizes and rendered the icon on `chrome://extensions`. Both builds contain the icon files and point the toolbar action at the 16 and 32 pixel variants. |
| Reverb, stem routing, and local settings | PASS (automated) | Real captured audio and reverb tail, saved presets and local sound preferences across Chrome restart, local preference opt-out, YouTube slowdown/restoration, and Instrumental/Vocals/Full Mix via the real AudioWorklet path with a PCM fixture. |
| Production access | PASS (automated with fixtures) | Chrome reused a provisioned test credential. Server tests rejected invalid bearer tokens, disallowed origins, and requests over quota. The retired memory endpoint returned 404 to an authenticated request. |
| Physical toolbar, live Spotify/SoundCloud, and GPU separation | NOT RUN | Headless Chrome verifies icon wiring and decoding rather than the visible toolbar. Platform detection for Spotify and SoundCloud is covered by unit tests. Stem protocol coverage used a fixture. |

The implementation is in the side-panel HTML, CSS and TypeScript, `panel-tabs.ts`, `shared/home-layout.ts`, `now-playing.ts`, `shared/track.ts`, and the existing audio, lyrics, saved-presets, and preferences adapters. Branding comes from the original PNG restored under `extension/assets`, plus the four icon sizes copied by `scripts/build-extension.mjs`. The server and package manifest changes remove the Supermemory SDK, routes and configuration. The updated cloud access instructions are in [Vercel setup](docs/DEPLOY_VERCEL.md#provision-the-installed-extension). Chrome and regression checks live in `tests/chrome-smoke.mjs`, `tests/reverb-browser.mjs`, `tests/ui-settings.test.ts`, and the existing cloud tests.

To try the update, run `npm run build:extension`, reload your unpacked installation in `chrome://extensions`, refresh an open YouTube page, and click MoodShift on the playing tab. Open **Settings → Customize Home** to change which sections appear. Production users can rebuild with `npm run build:extension -- --mode production` and reload their existing production installation.

## Independent pitch and interactive EQ — November 22, 2026

The Home and Settings update was already committed at `329dbc5`. It was pushed to `origin/feature/ui-settings-home-refresh` before the Pitch and Equalizer edits began.

| Check | Result | Evidence |
| --- | --- | --- |
| Dependency install, development and production builds, and typecheck | PASS (automated) | Installed Signalsmith Stretch 1.3.2. Both extension build modes include the locally packaged AudioWorklet, editor, and notice. `npm run typecheck` exited successfully. |
| JavaScript and stem transport tests | PASS (automated) | `npm test` passed 118 tests in 13 files. Nine Python stem tests passed. New tests cover value validation, feature isolation, band response and limits, and full-mix preset compatibility. |
| Local proxy | PASS (automated) | `npm run dev:server` started on `127.0.0.1:8787`. `GET /health` returned HTTP 200. |
| Stereo pitch frequency, duration, and bypass | PASS (automated in Chrome 157.0.8103.80) | Generated 440 and 660 Hz stereo channels rendered at −3 and +3 semitones at 44.1 and 48 kHz. All frequencies were within 6 cents of the targets. The two-second bursts measured 1.979–1.990 s at the RMS threshold. The worklet reported 100 ms latency at both rates. Zero pitch and flat EQ produced sample-exact stereo output. |
| Actual EQ response | PASS (automated in Chrome) | The plot calculation agreed with Chrome’s `getFrequencyResponse` to within 0.000004 dB across the sampled frequencies. The rendered filter cascade with alternating boosts and cuts plus a custom point and headroom matched the plot within 0.0013 dB at the measured band centers. |
| Live controls and Domain Expansion | PASS (automated and visually inspected) | Live stereo shifted while the media rate stayed at 1.0. Pitch bypass, re-enable, and reset kept adjacent sample changes below 0.06 on the captured tones. The editor added, dragged, numerically edited, deleted, stored, and recalled points with exact frequency, gain, and Q. Both views stayed in sync. The spectrum reacted to audio and paused when the editor closed or reduced motion was enabled. Inspected actual compact renders at 320 CSS pixels and the larger editor at 940 pixels. |
| Pitch, EQ, reverb and stems | PASS (automated in Chrome) | Captured output remained finite and audible through Pitch + EQ, Pitch + Reverb, EQ + Reverb, and all three together. The local PCM worker exercised Vocals + Pitch + EQ and Instrumental + EQ + Reverb through the real stem worklet. Timing reported 2.8 s for the test stem buffer and 2.9 s with active pitch. Original with all three disabled returned to the dry stereo frequencies. |
| Closed-panel stereo playback | PASS (automated in Chrome) | The 120-second check sampled shifted stereo output with Pitch and EQ active while the panel was closed. The capture retained one context and one pitch worklet. Offscreen JavaScript heap after forced GC went from 1,112,336 to 1,114,280 bytes during this run. |
| Source switches and profile persistence | PASS (automated in Chrome) | Pause/resume and switching to another playing tab retained the saved Pitch and EQ. Closing and reopening the panel and editor kept the same active session. Restarting Chrome retained the selected custom curve, every point and Q value, and Home visibility. The four quick preset emoji labels rendered. |
| Production-format extension and YouTube | PASS (automated in Chrome) | The isolated production-format build loaded its local WASM and passed the tuning checks with its restricted CSP. The development build captured audio from a real YouTube music tab with Pitch and EQ active at media rate 1.0. Playback advanced while the panel was closed and the tab backgrounded. |
| Existing Chrome features | PASS (automated in Chrome) | Reverb, Home settings, saved full presets, local sound preferences, live LRCLIB lyrics, and the documented Songle chord timeline passed their existing browser checks. |
| Physical output and separation quality | NOT RUN | Listening for voice character, percussion artifacts at larger shifts, and perceived bypass transitions requires a desktop Chrome listening check. The stem integration used a deterministic PCM worker. |

Repeat the tuning checks with `MOODSHIFT_TUNING_TEST=1` using the command in the [Chrome smoke test instructions](README.md#repeat-the-browser-smoke-test). For listening verification, reload MoodShift in Chrome, refresh a playing music tab, and apply −3 then +3 semitones from **Settings → Pitch Control**. Open **Home → Equalizer → ⛶ Domain Expansion**, adjust a band, and save a curve. Close and reopen the editor and panel while playback continues. Try Instrumental and Vocals if your existing stem helper is available.

## Recovered playback and natural-language controls — November 22, 2026

The checkout is `feature/ui-settings-home-refresh`. The Git graph, reflog, commit parents, and file comparisons identify `feature/local-precomputed-mask-poc` at `1f0d0f3` as a child of `feature/mood-scenes` at `b820c2b`. Both the current branch and the mask ancestry share `34c0101`, where `feature/universal-song-lyrics-sync` and `feature/advanced-ui-local-memory` point. Commit `3096892` was the first missing commit after that base. It contains the cross-player code plus some presentation and deployment changes. The focused port restores player metadata, lyrics and timed captions, device and processing timing, and local chord estimates. The later Mood Scenes UI, mask work, and the retired personalization and provisioning interfaces were excluded. The earlier karaoke, Songle, cloud deployment, and reverb branches were also checked for existing equivalents.

| Check | Result | Evidence |
| --- | --- | --- |
| Typecheck, both extension builds, JavaScript and Python | PASS (automated) | TypeScript, development and configured production builds, 134 JavaScript tests in 15 files, and nine Python stem tests. |
| Local proxy and native ESM cloud entry | PASS (automated) | The Express entry compiled with NodeNext and started under plain Node.js. `/health` returned HTTP 200 and `X-MoodShift-Controls: 2`. The v2 route rejected an unauthenticated cloud request. An isolated production Chrome build reached the v2 path with test authentication. |
| Live Gemini and Chrome | PASS (automated with the configured provider) | Gemini 3.1 Flash-Lite returned the validated −2 semitone and Concert Hall actions. In Chrome, a live request moved the active pitch worklet from −1 to −3 semitones while retaining the existing reverb and a media rate of 1.0. Earlier live attempts hit the existing timeout and left playback running. |
| Recovered player support | PASS (automated in Chrome and unit fixtures) | Real Chrome capture of a loopback audio player used Media Session title and artist, native timed captions, and live detection of C major. Unit fixtures cover Spotify, YouTube Music, SoundCloud, recording selection, seek and pause timing, and stale lookups. |
| Existing YouTube and tuning regressions | PASS (automated in Chrome) | Real YouTube capture, live LRCLIB lyrics and Songle timeline, Home visibility, local preferences, saved presets and restarts passed. Stereo pitch, Domain Expansion, EQ response, and stem timing also passed, along with Slowed + Reverb and restoration of the original YouTube playback rate. |
| Shared text and voice actions | PASS (automated in Chrome with fixtures) | Manual pitch appeared in the next Gemini request. Validated plans changed pitch, reverb, EQ points and Q, presets, Home and lyrics preferences, and reset settings in the live graph. An Instrumental request reached the stem worklet with reverb and the existing 2.8 s PCM fixture buffer. |
| Voice window and microphone lifecycle | PASS (automated in Chrome with simulated transcripts) | Chrome registered Ctrl+Shift+Y. The side-panel button opened the same voice window. Checks covered explicit start, denial, cancellation during recognition and interpretation, blur, closure, and continued audio on the original capture. |
| Native recognition and physical keyboard | PARTIAL | Native Chrome honored a denied microphone permission. Its speech service misrecognized one generated WAV and reached Gemini. A second generated sample produced no transcript. The desktop computer-use runtime failed to initialize, so the physical shortcut and an end-to-end spoken command using a real microphone still need checking. |
| Platform and hardware verification | NOT RUN | Live Spotify, SoundCloud, and YouTube Music accounts and GPU separation quality. The non-YouTube Chrome player and stem PCM fixture tested the application paths. |

To repeat the voice check, reload MoodShift, capture a playing tab, and press **Ctrl+Shift+Y**. Click **Listen**, allow the microphone, then say “Lower pitch by two semitones and add Concert Hall reverb.” Check Pitch Control and Reverb while the music continues. Close the window or cancel a second request and confirm that the existing capture keeps running. For a cloud installation, follow the [command API upgrade](docs/DEPLOY_VERCEL.md#upgrade-an-existing-api-to-command-version-2).

## Gemini and browser microphone compatibility (November 23, 2026)

| Check | Result | Evidence |
| --- | --- | --- |
| Typecheck, extension builds and unit tests | PASS (automated) | Development and production builds ran in isolated directories. `npm run typecheck` passed. `npm test` passed 136 tests across 15 files, including voice request validation and the bounded Gemini 503 retry. |
| Vercel Express artifact | PASS (automated) | The locally packaged `index.js` started under plain Node.js 22. `/health` returned 200 with both command version headers. The voice route returned 401 without a token. |
| Microphone permission and recording | PASS (automated) | Chrome 157 and Edge 158 exercised native `getUserMedia` denial and grant and recorded WebM via `MediaRecorder` with a fake input device. Cancellation released input, discarded unsent recordings, and prevented stale updates. A mocked Gemini result changed the settings in the current capture. |
| Live Gemini 3.5 Flash-Lite | PASS (automated) | The local proxy returned HTTP 200 for both a typed pitch command and synthetic WebM speech. The responses lowered pitch by two semitones and raised bass by 2 dB, respectively. Earlier tests with 3.1 Flash-Lite encountered an upstream 503 and a timeout. |
| Desktop permissions and live deployment | NOT RUN | The OS microphone prompt and a spoken command with a real microphone still need checking in each target browser. The live production API was checked for health only and did not advertise the pitch or voice endpoints. |
