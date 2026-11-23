# Local reverb audio effects

This feature was created on `feature/reverb-audio-effects` directly from `feature/advanced-ui-local-memory`, commit `34c01013058d00a49dd94f40a3903d99a62d25dd`. No mask-experiment commits or source were used. The pre-existing untracked local mask files remain untouched. Nothing was pushed or merged.

## Try it in Chrome

1. Run `npm run build:extension`. If you use the production extension, run `npm run build:extension -- --mode production` instead.
2. Reload your existing MoodShift entry in `chrome://extensions`. Its unpacked directory must be `extension/dist` for development or `extension/dist-cloud` for production. Reload an already-open YouTube page to install its updated content script.
3. Play a local audio file in a browser tab, or play authorized audio on YouTube. Click the MoodShift toolbar icon on that tab.
4. Open **Advanced → Audio Effects**. Select a reverb preset, adjust Amount and Duration, and toggle Enable reverb. The feature works with no proxy or stem worker running.
5. Try Original and Modified. Reverb applies to both; Original still bypasses the other DSP controls. Disable reverb for a dry A/B comparison. Full Mix, Instrumental and Vocals keep the reverb settings when switched.
6. On YouTube, note the current playback speed, then choose Slowed + Reverb. The status reports the actual applied speed. Change presets, disable reverb, Stop, or switch capture to another tab and verify the previous speed returns.
7. Close and reopen the side panel, pause/resume the source, and save a customized result under My Presets. Change the reverb and reapply that saved preset.

Amount uses the existing safe 0–55% reverb-mix range. Duration ranges from 0.4–4.0 seconds. Moving Amount to zero disables processing while remembering the last positive amount for the enable toggle. Duration changes are applied on release rather than regenerating an impulse response on each pointer move.

| Preset | Initial amount | Initial duration | Character |
| --- | --- | --- | --- |
| 🌙 Dreamy Reverb | 28% | 2.4 s | Warm, smooth, atmospheric |
| 🏛️ Concert Hall | 24% | 2.8 s | Brighter stereo reflections with a little more predelay |
| 🌧️ Slowed + Reverb | 34% | 3.4 s | Darker, longer tail; optional source slowdown |

## Audio routing and state

The existing offscreen document remains the audio owner. Source capture, stem transport/model, buffering, and the single AudioContext per capture are unchanged. The existing `reverbMix` effect field remains authoritative for audible amount; the old fixed reverb branch was replaced rather than duplicated.

```text
Captured source → Original branch ─────────────────────────┐
Captured source or selected stem → existing DSP → Modified ┤
                                                         ↓
                     monitor mix → local reverb → master/mute → limiter → speakers
```

There is one dry route through the reverb stage. Stereo impulse responses are generated locally with distinct predelay, tonal damping and decay. Constant-power-style dry/wet gains are conservative, with reduced wet return level. No music or effect request goes to a server. The direct path has no added separation buffer; the intentional reflection predelay only affects the wet signal. Physical speaker latency has not been measured.

Impulse changes coalesce for 80 ms. Old and new wet returns crossfade over 300 ms, and faded returns disconnect after 350 ms. At zero amount there are no connected convolution returns after the fade. A four-entry LRU cache bounds retained response buffers; one maximum-length stereo response uses about 1.54 MB at 48 kHz. Stop clears timers, cache and graph connections. Amount changes reuse the active response.

The offscreen state includes preset, duration, last positive amount and actual speed status. Changes increment the existing effects revision, so stale Gemini responses cannot overwrite a newer local reverb edit. Gemini's existing reverb amount field remains compatible. Home presets and Gemini amount changes use the current reverb style/duration. The side panel reads this authoritative state when reopened; switching Home/Advanced does not reapply an effect.

My Presets optionally stores the new reverb metadata alongside the unchanged audio settings. Existing version-1 presets without metadata remain valid and are not rewritten during listing. A new saved preset restores its metadata and audio settings in the same acknowledged effects command. A new capture starts neutral; use My Presets to explicitly carry a customized configuration across captures.

## Slowed + Reverb limitations

Speed control is intentionally limited to the existing YouTube watch-page content script. Other sources receive the reverb immediately and show **Reverb active. Slowing is supported on YouTube only.** No new permissions, scraping, downloader, global browser setting or audio time-stretching system was introduced.

On supported YouTube playback, MoodShift requests 85% of the source's prior rate, so 1.0× becomes 0.85× and 1.25× becomes 1.0625×. Pitch behavior remains the browser's native behavior; no pitch-shift effect is promised. The script avoids ads and unsupported player speeds. If the user changes speed in the player, that choice takes priority. Re-select the preset to explicitly enable slowing again.

The offscreen capture renews a short speed lease every two seconds while slowing is active, independently of the panel. Normal disable, preset change, Stop and source switch request restoration immediately. The page restores the prior rate after seven seconds without renewal, covering extension reload/crash. Navigation releases the current video. Restoration does not overwrite a newer user-selected rate. A busy player has a bounded 1.2-second acknowledgment deadline, and the audio effect remains usable when speed control fails. Reload an existing YouTube page if the updated content script is unavailable.

The existing lyric/chord clock already reads the player's actual playback rate. Source slowdown changes incoming captured audio naturally. The stem helper's delay, throughput configuration, and separation model are untouched. Actual GPU separation combined with Slowed + Reverb and a long listening session still need manual verification.

## Automated checks

```powershell
npm run typecheck
npm test
npm run build:extension
npm run build:extension -- --mode production

# Real tab capture from a synthesized local WAV and existing stem transport/worklet.
# The test server emits half-gain vocal packets; it does NOT run separation or a GPU.
$env:MOODSHIFT_REVERB_TEST = '1'
$env:MOODSHIFT_REVERB_STEMS = '1'
$env:MOODSHIFT_STEM_TEST_PORT = '9191'
node tests/chrome-smoke.mjs

# Optional: use your own local MP3 instead of the WAV fixture.
$env:MOODSHIFT_REVERB_AUDIO = 'C:\path\to\song.mp3'
# Optional: verify speed and restoration on a real YouTube watch page.
$env:MOODSHIFT_REVERB_YOUTUBE = 'https://www.youtube.com/watch?v=kTJczUoc26U'
node tests/chrome-smoke.mjs
```

The PCM fixture uses the existing `.stem-gate/venv/Scripts/python.exe` and its NumPy/websockets packages. Set `MOODSHIFT_STEM_PYTHON` if that environment is elsewhere. The runner builds an isolated test extension with the chosen loopback port, preserving the configured worker URL in normal builds. Tests use isolated Chrome profiles. No production worker configuration is changed.

`tests/reverb.test.ts` checks safe settings, distinct finite stereo responses, decay, bounded/coalesced response generation, bypass, reuse/cleanup, and speed ownership/restoration/expiry. Saved-preset tests cover optional metadata and legacy compatibility. The Chrome tests exercise the actual Web Audio renderer, capture/offscreen messaging, controls, custom preset persistence/application, panel reopen, pause/resume and stem routing. The final local-MP3 run measured output RMS 0.003731 after captured input reached zero, confirming a reverb tail through the actual extension output. Offline impulse checks prove dry onset is unchanged and compare actual rendered tails; subjective sound quality and perceived clicks require listening.

## File inventory

New implementation files: `extension/src/shared/reverb.ts`, `extension/src/reverb.ts`, `extension/src/reverb-panel.ts`, `extension/src/playback-speed.ts`.

Modified implementation files: `extension/src/audio-engine.ts`, `extension/src/offscreen.ts`, `extension/src/background.ts`, `extension/src/shared/messages.ts`, `extension/src/shared/types.ts`, `extension/src/saved-presets.ts`, `extension/src/sidepanel.ts`, `extension/src/sidepanel.html`, `extension/src/sidepanel.css`, `extension/src/youtube-playback.ts`.

New test files: `tests/reverb.test.ts`, `tests/reverb-browser.mjs`, `tests/reverb_stem_fixture.py`. Modified test files: `tests/saved-presets.test.ts`, `tests/chrome-smoke.mjs`.

Documentation: this guide, `README.md`, `TEST_RESULTS.md`. Rebuilt tracked artifacts: `extension/dist/background.js`, `extension/dist/offscreen.js`, `extension/dist/sidepanel.js`, `extension/dist/sidepanel.html`, `extension/dist/sidepanel.css`, `extension/dist/youtube-playback.js`. The production output in `extension/dist-cloud` remains gitignored.
