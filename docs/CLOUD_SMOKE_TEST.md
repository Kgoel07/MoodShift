# Cloud smoke test

Run the stages in order. Use authorized audio for tests. Record the instance type, Region, provider, sample rate, timing results and Chrome version. Keep API keys and the demo code out of reports.

## 1. Vercel API by itself

After deploying the API, run this with your production HTTPS origin and the installed extension’s exact origin. This first command checks the pitch and voice version headers, preflight, wrong Origin, and missing code. It makes no Gemini request.

```powershell
node scripts/smoke-cloud-api.mjs https://YOUR-PROJECT.vercel.app chrome-extension://YOUR_EXTENSION_ID
```

To send one live synthetic prompt, use PowerShell 7.2+ to enter the code privately.

```powershell
$env:MOODSHIFT_SMOKE_TOKEN = Read-Host 'Private demo access code' -MaskInput
try {
    node scripts/smoke-cloud-api.mjs https://YOUR-PROJECT.vercel.app chrome-extension://YOUR_EXTENSION_ID --authorized
} finally {
    Remove-Item Env:MOODSHIFT_SMOKE_TOKEN
}
```

Verify HTTP 200 and a bass-only patch that preserves reverb. Then use the installed extension to try a pitch command in the text box and in the microphone tab. See [Vercel setup](DEPLOY_VERCEL.md).

## 2. Private SSH GPU link

1. Run the [EC2 inference and local playout gate](DEPLOY_AWS_GPU.md#2-copy-only-the-worker-source-and-run-the-gpu-gate). Confirm CUDA is active, max processing is at most 650 ms, processing throughput exceeds 1×, and misses equal zero.
2. Run the worker in local mode and open the [SSH forward](DEPLOY_AWS_GPU.md#3-start-loopback-mode-and-verify-through-ssh). Use the development extension’s ID. Leave the production HTTP ports closed.
3. From the laptop, use the existing authorized fixture and the local benchmark environment. On Windows use the existing stem venv. On other clients, a Python 3.12 venv with `numpy`, `scipy`, `soundfile` and `websockets` suffices for this client probe.

   ```powershell
   $origin = 'chrome-extension://YOUR_LOCAL_EXTENSION_ID'
   $python = '.stem-gate/venv/Scripts/python.exe'
   & $python -m scripts.benchmark_stem_link .stem-gate/assets/fixture.ogg --origin $origin --rate 48000 --seconds 120 --buffer 2.8
   & $python -m scripts.benchmark_stem_link .stem-gate/assets/fixture.ogg --origin $origin --rate 44100 --seconds 120 --buffer 2.8
   ```

4. Record WebSocket RTT, maximum interarrival jitter, and maximum input-to-stem arrival lag. Require all expected output packets in order and zero misses with headroom below the browser buffer. The link test measures network and compute latency. A listening test adds Chrome and audio device scheduling. If either rate misses, increase the buffer in tenths up to 8 seconds and rerun both. If the gate still fails, use Full Mix or the existing local Windows helper. Confirm the development extension selects Instrumental and Vocals through the tunnel, and returns to Full Mix when you close the tunnel.

## 3. Public WSS and final Chrome demo

1. After the SSH gate passes, configure a trusted certificate and the cloud-authenticated worker per [AWS setup](DEPLOY_AWS_GPU.md#4-enable-public-wss-for-a-private-demo). Use the **production** extension’s ID. From the laptop, run the same link benchmark at both rates with `--url wss://YOUR_STEM_HOST/stem` and the production origin. The script prompts for the code without echoing it. A missing or wrong code must fail. Record the worst lag and jitter for the verified WSS path.
2. Build with the actual domains and the measured buffer. The example below uses the production default of 4.5 seconds. Replace it with a value validated by the link tests.

   ```powershell
   $env:API_BASE_URL = 'https://YOUR-PROJECT.vercel.app'
   $env:STEM_WS_URL = 'wss://YOUR_STEM_HOST/stem'
   $env:STEM_DELAY_SECONDS = '4.5'
   npm run build:extension -- --mode production
   ```

3. In Chrome reload `extension/dist-cloud` and refresh the authorized YouTube tab. Start playback, click MoodShift, and [provision the access code](DEPLOY_VERCEL.md#provision-the-installed-extension) on a fresh installation. Verify the neutral mix and then Dreamy, Original/Modified, and an acknowledged Gemini prompt. Check Lyrics, Chords, and My Presets independently.
4. Enable Instrumental, listen through the displayed buffer delay, switch to Vocals, and confirm Original still plays the live mix. Adjust the shared lyrics/chords offset by ear if needed. While a stream is active, a second authorized client should receive busy feedback. Stop or disable the worker and confirm the panel reports the failure and Full Mix stays audible. Restart it, reconnect, and try **Stop processing**.
5. Clear the saved code using the blank field and check that the next interpretation or stem request requires it. Confirm local DSP controls and saved presets remain usable. Stop or terminate the EC2 instance after the demo.
