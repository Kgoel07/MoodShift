# MoodShift

MoodShift applies live pitch shifting, EQ, filters, reverb, echo, and distortion to one selected Chrome tab. It targets Chrome 116+ on Windows and macOS. The side panel can close while the offscreen audio session keeps running. Presets, sliders, and Original/Modified work without the proxy or an API key.

## Install and run

1. Install Node.js 22 (Node.js 20 also works locally) and run `npm install` from the project root.
2. For Gemini, copy `server/.env.example` to `server/.env`. On PowerShell, run `Copy-Item server/.env.example server/.env` if the file does not exist. Set `GEMINI_API_KEY` in that file using a key from a Google AI Studio project on the Free tier. The default model is Gemini 3.1 Flash-Lite (`gemini-3.1-flash-lite`), with free input and output within the project’s quota. Keep the key out of Git and the extension. [Google AI Studio API keys](https://aistudio.google.com/apikey) · [Gemini pricing](https://aistudio.google.com/docs/pricing#gemini-3.1-flash-lite)
3. Run `npm run dev:server` in one terminal. The proxy listens on `127.0.0.1:8787`. Visit [proxy health](http://127.0.0.1:8787/health) to check reachability and whether a key is configured. Account access and credits are verified by an actual prompt.
4. Run `npm run build:extension`.
5. In Chrome, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and choose `extension/dist`. Pin MoodShift from Chrome’s Extensions menu for quick access.
6. Play authorized audio on YouTube. Click the MoodShift icon **from the playing tab** and look for its title and signal in the side panel. Try **Dreamy**, then a prompt such as “Make it warmer and more dreamy.” Press Enter or click **Apply**. Shift+Enter adds a line break. Try **Original**, **Modified**, then **Stop processing**.

Open the panel from Chrome’s side panel menu to inspect the existing session. Use the toolbar icon on a different source tab to switch capture. **Reset** in **Audio Controls** restores neutral values for those controls. **Original** plays the full captured mix with its own path through any enabled Pitch, Equalizer, and Reverb. For a dry comparison, select **Original** and turn off those three effects.

## Pitch and Equalizer

1. During playback, open **Settings → Pitch Control**. Try **−3.0 st** and **+3.0 st** while watching the song's playhead. The slider enables pitch and changes it in 0.1-semitone increments from −6 to +6. Use **Enable pitch** to bypass and retain the value. **Reset pitch** returns the slider to zero.
2. Open **Home → Equalizer**. Adjust the six sliders or pick **Balanced**, **Bass Boost**, **Vocal Clarity**, **Warm**, or **Bright**. Each band supports −12 to +12 dB. **Enable EQ** bypasses or restores the current curve. **Reset EQ** returns to the six flat bands and clears any added points.
3. Click **⛶ Domain Expansion** to open a larger editor in a Chrome tab. Drag a point to change frequency and gain, or use the frequency, gain, and bandwidth (Q) fields for exact values. Use the arrow keys with a point focused to move it. Click the graph or **Add point** to add up to twelve custom points. Select one and use **Remove point** to delete it. The graph shows the cascade’s frequency response over the live spectrum. Large overlapping boosts may trigger automatic headroom in the curve.
4. Open **Save an EQ preset**, enter a name, and click **Save preset**. Recall it from either EQ view. The preset includes the six base bands and any added points with their frequency, gain, and Q. **My Presets** can save a full mix that includes Pitch and EQ settings.
5. Use **Settings → Customize Home** to set which controls appear on Home. Close Domain Expansion or the panel while playback is running, then reopen it to check that the shared settings persist. Pitch, EQ, and Home visibility also persist across Chrome restarts.

Pitch uses the packaged Signalsmith Stretch AudioWorklet with stereo processing. Its measured algorithmic delay is 100 ms at 44.1 and 48 kHz for a nonzero setting. Lyrics and chords account for this delay automatically. Pitch at zero takes the dry path. The capture can run through optional live stem separation, Pitch, Equalizer, and Reverb in the same local audio graph. [Signalsmith Stretch Web documentation](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/main/web/release/README.md)

For a listening check, try vocals and percussion at ±3 and ±6 semitones, then turn pitch off during the song. The bypass crossfade changes the amount of processing delay. Larger offsets can color transients or voices, depending on the recording.

## Reverb without a stem worker

Open **Settings → Reverb** and choose **Dreamy Reverb**, **Concert Hall**, or **Slowed + Reverb**. Adjust **Reverb Amount** and **Reverb Duration**, or turn reverb off. It runs locally on the captured audio without a proxy, GPU or separation buffer, and also works on the selected Instrumental/Vocals output when a stem worker is available. My Presets saves customized reverb settings while preserving existing presets.

Slowed + Reverb uses 85% of the previous playback speed on supported YouTube watch pages and restores it when disabled, stopped, or switched to another source. Reload an already-open YouTube page after updating the extension. Other sources keep the reverb and explicitly report that slowing is unavailable. Reverb also applies in Original; turn reverb off for a dry comparison. [Controls, limitations, implementation and Chrome tests](docs/REVERB_AUDIO_EFFECTS.md)

## Synchronized YouTube lyrics

Build or reload MoodShift, then reload the YouTube watch page so Chrome injects the new content script. Start a song and click the MoodShift icon on that tab. The **Lyrics** section uses the selected player’s position, pause state and playback rate. It follows the active line through seeks and YouTube’s in-tab video changes. Scroll the lyrics at any time and re-enable **Follow playback** to return to the active line.

Edit **Song Title** and **Artist** and click **Search lyrics** if YouTube identifies the song incorrectly. MoodShift looks for matching title and artist and checks that the recording’s duration is within two seconds. It shows plain lyrics when an otherwise matching record has no timing. Different edits, live performances, and ambiguous results may have no verified match. [LRCLIB API](https://lrclib.net/docs)

**Lyric offset** starts at `0` and applies to both lyrics and chord highlights. Use a positive value to delay them and a negative value to advance them. With delayed stem playback, try `+2.8` seconds and adjust by ear. Pitch’s additional latency is applied automatically. The offset persists locally.

Lyrics work without Gemini or the stem helper. MoodShift sends only the song title and artist to LRCLIB. The extension caches recent lookup results and song corrections for the current Chrome session.

To smoke-test in Chrome, open Jonathan Coulton’s “Code Monkey,” click MoodShift, and wait for **Synchronized lyrics**. Pause and seek, change the playback speed, then open another recommendation in the same tab. If an ad plays, the panel can identify the new song while waiting for the song’s clock. [Official YouTube track](https://www.youtube.com/watch?v=AEBld6I_AKs)

To repeat the automated Chrome check after building, run `$env:MOODSHIFT_LYRICS_TEST='1'; node tests/chrome-smoke.mjs` in PowerShell. Add `$env:MOODSHIFT_LYRICS_STEMS='1'` to test an active stem alongside lyrics with the optional Windows helper.

## Synchronized YouTube chords

1. Open the YouTube watch page used in the Songle API example, start playback, and click MoodShift on that tab. Open **Chords**. Wait for **Songle · Estimated chords**. [YouTube example](https://www.youtube.com/watch?v=PqJNc9KVIZE)
2. At about 13.5 seconds, look for **Eb**, then **Eb/Ab** under **Next**. Pause and seek to 17 seconds, then seek backward. Click a chord in the progression to inspect its guitar and piano diagrams. Click it again to follow the current chord. Supported diagrams are based on local tables.
3. Change the YouTube rate and adjust **Lyric offset (s)** in **Lyrics** to change both highlights. Switch videos or click **Stop processing** to clear the current chord.

MoodShift sends the exact YouTube watch URL to Songle when you open **Chords**. It caches successful results locally for up to seven days and keeps up to 16 videos. Songle covers registered recordings. A missing recording has no progression, and an outage shows a retry control. The integration is for noncommercial use and the original video plays directly from YouTube. [Songle chord API](https://widget.songle.jp/docs/v1?lang=en) · [Songle Widget terms](https://widget.songle.jp/docs/terms-of-use) · [Songle terms](https://api.songle.jp/terms_of_use.pdf)

## My Presets

1. Capture a playing tab and adjust effects, the stem mode, and Original or Modified. Open **My Presets**, enter a name and an optional description, and click **Save Preset**.
2. Select another playing tab with the toolbar icon. Pick the saved preset and click **Apply Preset**. MoodShift waits for the audio engine to acknowledge the stored settings. If the requested stem helper is unavailable, the panel reports the partial result.
3. Change the mix, then use **Update Preset** to replace the saved audio settings. Edit the text fields and use **Rename** to save the name and description. Use **Delete** to remove that preset. Close and reopen Chrome to check that the preset is still in the list.

Saved presets are shared across songs in the same Chrome profile. They use local Chrome extension storage and work without Gemini. An active capture is needed to save, update the audio settings, or apply a preset.

## Side panel and sound preferences

**Home** starts with four quick presets, 🌙 Dreamy, ☀️ Warm, 🌊 Underwater, and 🔊 Bass Boost. The prompt and Original/Modified controls sit below them. **Settings → Customize Home** lets you pin Lyrics, Stems, Reverb, Audio Controls, My Presets, Pitch Control, and Equalizer. Lyrics, Stems, and a collapsed Equalizer appear by default. Settings provides access to every section, plus Chords and Sound Preferences. Hiding a section from Home leaves its settings and any active effect intact. Use the Left and Right arrow keys to switch tabs while a tab button has focus. MoodShift remembers the selected tab and Home layout in this Chrome profile.

The Now Playing bar uses the captured tab's title and platform. On supported YouTube watch pages it shows the song and artist from the existing playback integration and loads the current video thumbnail from YouTube. Spotify and SoundCloud use the tab title and a platform icon. Other sources show the tab title and a music icon.

In **Settings → Sound Preferences**, enter a short sound preference such as “I prefer warm bass and minimal distortion” and choose **Save locally**. Each entry has Edit and Delete controls. During capture, “Remember that I prefer warm bass” in the main prompt also saves locally. Local preferences and saved presets use separate Chrome storage and persist across restarts. Local preferences support up to 30 entries of 240 characters each.

Turn on **Use remembered sound preferences** to let the extension send up to four relevant entries with each Gemini prompt. Broad mood requests can use recent preferences. Explicit instructions take priority, so “Remove all bass” takes precedence over a bass preference. Turn the setting off to stop using preferences while keeping them on the device. The local sound preferences continue to work with the existing Gemini API.

## Optional live stems on Windows

**Instrumental** and **Vocals** use the local MDX-Net helper. It was benchmarked on an RTX 3070 Laptop GPU with DirectML. The helper checks startup throughput for both 44.1 and 48 kHz before accepting audio. CPU-only playback missed the deadline in testing. The stem helper and Gemini proxy run independently.

Install 64-bit Python 3.13, then run these commands from the project root in PowerShell.

```powershell
python -m venv .stem-gate/venv
$python = '.stem-gate/venv/Scripts/python.exe'
& $python -m pip install -r scripts/stems-requirements.txt
New-Item -ItemType Directory -Force .stem-gate/assets | Out-Null
curl.exe --fail --location --output .stem-gate/assets/vocals.onnx https://media.githubusercontent.com/media/kuielab/mdx-net-submission/refs/heads/master/onnx_A/vocals.onnx
```

Build the extension and reload it in Chrome. Copy MoodShift’s ID from `chrome://extensions`. Start the helper using that ID and the DirectML adapter index for your GPU. On the test machine, index 1 was the RTX and index 0 was the integrated Radeon.

```powershell
$moodShiftId = Read-Host 'Paste the MoodShift extension ID'
& $python -m scripts.stem_helper --extension-id $moodShiftId --device 1
```

Keep the helper terminal open. The helper listens on `127.0.0.1:8788` and validates the model checksum. It prints `helper ready` after warming the model and checking both sample rates. If your laptop has a different GPU layout, adjust `--device` to its DirectML index.

On a playing tab, select **Instrumental** or **Vocals**. MoodShift plays the full mix while buffering. Active stem audio trails the video by about 2.8 seconds plus browser/device output latency. **Full mix** switches back to live audio through the effects. **Original** plays the live mix with effects bypassed. Returning to **Modified** resumes the selected delayed stem. These switches resynchronize with a short fade.

“Just play instrumental,” “vocals only,” and “back to full song” also work without Gemini. With the Gemini proxy configured, use a combined request like “remove vocals and add more reverb.” Beat-only, drums-only, and bass-only isolation are outside this two-stem feature. If the helper stops or misses its deadline, the extension returns to full-mix audio and shows why.

### Stem listening checklist

1. Launch the helper and play authorized music with vocals. Start capture and confirm normal Full mix and Original audio.
2. Select **Instrumental** and listen for reduced vocals. Select **Vocals** and listen for reduced accompaniment. Switch a few times and add reverb to Vocals.
3. Keep a stem active for two minutes. Listen for accumulating delay, repeated silence, pops, or doubled playback. Observe the lag behind video.
4. Stop the helper mid-song and confirm full-mix fallback. Try Stop, switching source tabs, closing the source, and closing and reopening the side panel.
5. Try “just play instrumental” and “just play the beat.” The first requires a ready helper. The second should show **Unsupported**.

Run the Python transport tests with `& $python -m unittest discover -s tests -p 'test_stem_*.py'`. For the Chrome integration smoke test, first download the benchmark fixture as described in [STEM_FEASIBILITY.md](STEM_FEASIBILITY.md). With the helper port free, run `$env:MOODSHIFT_STEM_TEST='1'; node tests/chrome-smoke.mjs`. Set `$env:MOODSHIFT_STEM_YOUTUBE='1'` to use the authorized YouTube track in place of the local fixture. For the two-minute browser test, use the local fixture with `$env:MOODSHIFT_STEM_SUSTAIN='1'`. To exercise a real combined request, run the configured Gemini proxy and set `$env:MOODSHIFT_STEM_GEMINI='1'`. The smoke test starts its own stem helper.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Capture failed or output is paused | Start playback, click MoodShift on a normal audio-playing tab, and check Chrome's extension access and any organization restrictions on tab sharing. |
| Meter stays at zero | Check that the source is playing, the video player and tab are unmuted, and the panel shows the intended title. Protected playback can produce silence. |
| Meter moves but output is quiet | Check the Chrome or system output device and volume. Switch to Original and check Output gain. |
| Gemini unavailable | Check `/health`. Start the proxy, confirm `GEMINI_API_KEY` and `GEMINI_MODEL` in `server/.env`, and restart the proxy after changes. If you hit a quota, check your project’s rate limits and try again later. Presets and manual controls remain available. [Google AI Studio rate limits](https://aistudio.google.com/rate-limit) |
| The wrong tab is playing | The toolbar selects the tab where you click it. Switching tabs alone leaves the original source running in the background. |
| Source went away | If Chrome ends capture on navigation or tab closure, start playback in the desired tab and click MoodShift again. |
| Rebuild does not show up | After rebuilding, click **Reload** on MoodShift at `chrome://extensions`, then reselect the source with the toolbar icon. Reload can end a capture. |

## Chrome acceptance checklist

Use authorized audio. A Creative Commons option is Kevin MacLeod’s “Carefree.” [YouTube track](https://www.youtube.com/watch?v=rZWLwz9_7o0) · [Track license](https://incompetech.com/music/royalty-free/index.html?gt=&isrc=USUAN1400037)

1. From the playing YouTube tab, click MoodShift. Confirm the panel opens, the right title appears, and the audio continues at normal level with no duplicate output.
2. With no key, click **Dreamy**. Verify audible reverb/EQ in under half a second while playback advances.
3. Change tabs or applications, close and reopen the side panel, and confirm sound and settings persist. Try minimizing Chrome. Clicking the toolbar icon on the same tab should preserve the session. Clicking it on another playing tab should switch cleanly.
4. With a valid Gemini API key, enter “Make it warmer and more dreamy.” Confirm interpretation, application acknowledgment, and an audible effect change while playback advances.
5. Enter “A little more bass, keep the reverb.” Verify bass increases when there is headroom, reverb stays fixed, and unrelated values stay fixed.
6. Compare **Original** and **Modified**. Verify a smooth crossfade, then **Reset** and confirm neutral sound with capture still running.
7. Move an effect slider during playback. Verify a smooth change and the same reported value after reopening the panel.
8. Stop the local proxy while listening. Submit a prompt and confirm an actionable error, ongoing audio, and working presets and sliders. Restart the proxy and retry.
9. Click **Stop processing**. Confirm direct audio resumes on the same tab. Restart capture, close the source tab, and confirm the panel clears and other tabs play normally.
10. Listen on speakers or wired headphones for 10 minutes. Check for stutter, feedback, and sustained silence.
11. Run `npm run build:extension`, `npm run typecheck`, and `npm test`. See [TEST_RESULTS.md](TEST_RESULTS.md) for completed checks.
12. If time permits, smoke-test Spotify Web Player and record the result. Spotify is unverified and protected playback may fail. [Spotify Web Player help](https://support.spotify.com/us/article/web-player-help/)

## Implementation

- The worker coordinates the toolbar, session selection and metadata. The offscreen document owns the live audio track, one Web Audio graph, and current settings. Start uses Chrome’s worker-to-offscreen stream ID flow. [Chrome capture guide](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)
- The settings in `extension/src/shared/effects.ts` define the effect ranges, defaults, and presets. Original and Modified share the same output. Modified uses neutral filter bypasses and a conservative limiter. Updates ramp over roughly 300 ms.
- Each effect prompt sends text, current effect values, and a two-second summary of RMS and frequency bands to the loopback proxy. It sends those fields and any opted-in preference context to Gemini. Audio samples, tab titles, and URLs stay out of the Gemini request. The proxy validates Gemini’s structured patches and reports unsupported requests. [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- MoodShift processes the selected Chrome tab. It supports independent pitch and the Slowed + Reverb mode on supported YouTube watch pages. Desktop apps, system-wide audio, general tempo editing, instrument replacement, and recording are outside the project scope.

## Repeat the browser smoke test

After building, run `node tests/chrome-smoke.mjs` with current desktop Chrome installed. The script uses a disposable headless profile and a locally generated tone. On PowerShell, set `$env:MOODSHIFT_YOUTUBE_TEST='1'` before the command to add the YouTube check. Also set `$env:MOODSHIFT_WORKER_TEST='1'` to wait for the worker to go idle during YouTube playback. Set `MOODSHIFT_CHROME_PATH` to the Chrome executable if it is installed outside the default Windows location. This test checks capture and state programmatically. Use the listening checklist to assess audio quality and direct speaker output.

Set `MOODSHIFT_CHORDS_TEST=1` to exercise the live Songle timeline, `MOODSHIFT_PRESETS_TEST=1` to verify exact restoration across a Chrome restart, and `MOODSHIFT_MEMORY_TEST=1` to exercise local Sound Preferences with mocked Gemini responses. If another MoodShift session is using the stem helper, set `MOODSHIFT_STEM_TEST_PORT` to a free port such as `18788`. The test uses a disposable copy of the bundled extension and starts a separate helper on that port.

Set `$env:MOODSHIFT_TUNING_TEST='1'` before running `node tests/chrome-smoke.mjs` to measure stereo pitch and EQ response in Chrome, exercise Domain Expansion during capture, and verify persistence after browser restart. `$env:MOODSHIFT_TUNING_SOAK='120'` adds two minutes of playback with the panel closed. To also check routing through the stem buffer with the test PCM worker, set `$env:MOODSHIFT_REVERB_STEMS='1'` and `$env:MOODSHIFT_STEM_TEST_PORT='9191'` with the Python dependencies from the optional stem setup installed.

## Private cloud demo

The default build still uses the local Gemini proxy and the local stem helper. The production build writes to `extension/dist-cloud` and uses a configured HTTPS API and WSS stem worker. Existing provisioned credentials are reused. See the operator setup steps for new installations. [Vercel setup](docs/DEPLOY_VERCEL.md) · [AWS CUDA worker setup](docs/DEPLOY_AWS_GPU.md) · [Cloud smoke test](docs/CLOUD_SMOKE_TEST.md) · [Deployment status](CLOUD_DEPLOY_STATUS.md)
