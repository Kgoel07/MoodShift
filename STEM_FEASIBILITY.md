# MoodShift stem feasibility

**Gate 1: PROVEN on the tested Windows DirectML adapter.** Gate 1 passed before the browser transport was added. This result applies to the tested model, GPU, and window settings.

## Model and fixture attribution

- KUIELab’s MDX-Net Track A vocal checkpoint is the original `onnx_A/vocals.onnx` from the authors’ MIT-licensed submission. The model predicts the vocal waveform. Subtracting that estimate from the original mixture yields the instrumental stem. The project fetches the original checkpoint separately and checks its SHA-256 against the upstream Git LFS pointer. [Checkpoint](https://github.com/kuielab/mdx-net-submission/blob/master/onnx_A/vocals.onnx) · [MIT license, © 2021 AIcrowd](https://github.com/kuielab/mdx-net-submission/blob/master/LICENSE) · [Upstream checksum](https://raw.githubusercontent.com/kuielab/mdx-net-submission/master/onnx_A/vocals.onnx)
- The checkpoint is 29,703,204 bytes (28.33 MiB). The initial download took 5.50 seconds here. ONNX Runtime is MIT-licensed. The benchmark uses the chunked overlap approach from the streaming reference. That project's wrapper license does not determine this checkpoint’s license. [ONNX Runtime](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) · [Streaming reference](https://github.com/nnyj/python-audio-separator-live)
- The natural mix was “Amazing Grace,” recorded by Rocks From The Garden, with Joannie on vocals and Randy on guitar. The rights holder dedicated the recording to the public domain. The 24-second audition excerpt starts at 00:15. The 120-second run also starts at 00:15. [Recording and permission](https://commons.wikimedia.org/wiki/File:Amazing_Grace_with_vocals_and_guitar_by_Rocks_From_The_Garden_-_20060603.ogg)
- The reference mix combines 20 seconds of “Mushino - vocals AFTER 03.mp3” by mushino and “Carefree” by Kevin MacLeod. Both sources are CC BY 4.0. The benchmark trims, RMS-matches and mixes them, then projects the estimated stems against the known original tracks for numeric attenuation measurements. [Vocal source and license](https://freesound.org/people/mushino/sounds/455158/) · [Music source and license](https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400037)

## Host and results

Windows, Python 3.13.7, ONNX Runtime DirectML 1.23.0. AMD Ryzen 7 5800H, 8 physical cores and 16 logical threads, with 15.4 GiB of visible RAM. About 2.3–2.7 GiB was available at the start of the passing tests. DXGI adapter 0 was the integrated Radeon. Adapter 1 was an RTX 3070 Laptop GPU with 8 GiB nominal VRAM and driver 621.14. The Realtek WASAPI device had a native rate of 48 kHz. MDX-Net runs at 44.1 kHz. The browser stream path supports both rates and uses polyphase resampling at 48 kHz.

The model has a fixed `[N,4,2048,512]` input, equivalent to 11.865 seconds of PCM. The benchmark centers each two-second window in a zero-padded native frame, overlaps successive windows by 160 ms, and crossfades the overlap. This gives a 1.84-second hop and avoids waiting for an entire native-length frame.

| Check | Result |
| --- | --- |
| RTX DirectML adapter 1 startup | Model session about 0.39–0.45 s, warm-up about 0.37–0.44 s in the passing runs. |
| 120-second paced run, 66 windows | Median 0.204 s, p95 0.231 s, maximum 0.236 s per window including DSP and inference. Sustained 8.76 audio seconds per processing second. The 0.8 × hop target was 1.472 s. Peak sampled process RSS 474 MiB. |
| 120-second software playout check | 2.7 s playout target, 2.236 s worst input-to-ready latency, zero deadline misses, peak queue two completed chunks. |
| 24-second WASAPI playout | Measured 2.800 s from first input sample time to the endpoint’s first DAC timestamp. Zero missing frames or device underflows. This is device-clock timing. Acoustic latency and listening quality still require a human check. |
| Reference mix quality | The instrumental output attenuated the known vocal contribution by 23.91 dB while retaining accompaniment within 0.05 dB. The vocal output attenuated the known backing contribution by 45.31 dB while retaining vocals within 0.58 dB. Results apply to this particular mix and projection method. |
| AMD adapter 0, 24-second unpaced run | Median 0.913 s, p95 1.484 s, maximum 2.401 s and 1.67× throughput. It missed the headroom target and did not qualify for the tested playout configuration. |
| CPU-only, 5-second unpaced run | Median 4.002 s per window, 0.42× throughput, 2.25 GiB peak sampled RSS. CPU-only live fallback is disabled. |
| Deterministic stereo | STFT round-trip, ordered overlap, tail handling and channel preservation passed. This check measures stream integrity. |

## Reproduce the gate

Install the optional Python dependencies and fetch the model using the commands in [README.md](README.md). Download the public-domain recording below into the ignored benchmark directory. The optional WAV outputs are generated solely from the authorized local fixture.

```powershell
curl.exe --fail --location --output .stem-gate/assets/fixture.ogg https://upload.wikimedia.org/wikipedia/commons/0/01/Amazing_Grace_with_vocals_and_guitar_by_Rocks_From_The_Garden_-_20060603.ogg
$python = '.stem-gate/venv/Scripts/python.exe'
& $python scripts/benchmark_stems.py --self-test
& $python scripts/benchmark_stems.py .stem-gate/assets/fixture.ogg --device 1 --seconds 120 --delay 2.7
& $python -m sounddevice
# Substitute the local WASAPI output index for 23.
& $python scripts/benchmark_stems.py .stem-gate/assets/fixture.ogg --device 1 --delay 2.8 --play-device 23 --output .stem-gate/preview
```

The preview directory has `mix.wav`, `instrumental.wav` and `vocals.wav` from the 24-second fixture. To reproduce the reference mix result, pass the licensed instrumental file as the fixture and the vocal file using `--reference-vocals`, with `--offset 10 --seconds 20 --device 1`.

## Live path and privacy

The extension sends binary stereo PCM over a single local WebSocket to `127.0.0.1:8788`. The helper requires the exact Chrome extension origin and a fresh session handshake. The worklet sends ordered frames to a dedicated worker and consumes bounded PCM buffers. The Python helper keeps one active connection. The stream stays in memory. Gemini still receives only prompt text, settings and coarse audio features. See [TEST_RESULTS.md](TEST_RESULTS.md) for browser verification and the remaining manual checks.
