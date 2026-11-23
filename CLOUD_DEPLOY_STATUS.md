# MoodShift cloud deployment status

Branch `feature/cloud-deployment` starts from the working chords, presets, and Supermemory implementation at `0d2e3b6`. Deployment code and runbooks are in `41ba189`. This status file has a separate verification commit.

## Prepared

- Vercel Express entry point and Node 22 function configuration. The local dev command still listens on `127.0.0.1:8787`. Cloud access requires an explicit mode, exact extension origins, a timing-safe demo code check, and per-instance request quotas. Shared demos disable Supermemory access. A single-operator deployment can use one pinned memory namespace.
- Separate development and production extension builds. The production manifest scopes HTTPS and WSS to configured hosts, along with the existing lyric and chord sources. Users enter the shared code after installation. The worklet uses a 2.8–8.0 second build-time buffer. Defaults are 2.8 seconds locally and 4.5 seconds for production.
- Linux CUDA and Windows DirectML provider selection. The EC2 installer pins the CUDA runtime, verifies the existing model checksum, and installs a loopback-only service. Caddy terminates TLS. The worker authenticates before accepting a PCM stream, allows one active stream, and enforces time and queue limits. A failed stream returns to Full Mix.
- A paced inference benchmark, a link probe for RTT and playout deadlines, and a Vercel HTTPS smoke script. See the [Vercel runbook](docs/DEPLOY_VERCEL.md), [AWS runbook](docs/DEPLOY_AWS_GPU.md), and [cloud smoke checklist](docs/CLOUD_SMOKE_TEST.md).

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run build:extension`, `npm test` | **PASS**. 101 Vitest tests. |
| Existing Python helper tests, CUDA mocks, authenticated startup, session expiry, paced link probe and numerical self-test | **PASS**. Nine Python tests and the benchmark self-test. |
| Development proxy and `GET /health` | **PASS** on loopback. |
| Vercel builder and HTTP routes | **PASS** locally. The public Express builder packaged the root entry as a Node 22 function with a 30-second limit. Local HTTP and HTTPS tests exercised health, CORS, authentication, quotas, shared-demo memory rejection and operator namespace isolation. Vendor responses were mocked. |
| AWS installation script and Caddy | **PASS** for shell syntax and Caddy configuration validation. Real loopback WSS through Caddy exercised TLS, rejection of a wrong origin and missing code, and ordered PCM with simulated inference. |
| Linux CUDA dependencies and model warm-up | **PASS** on Ubuntu 22.04 under WSL with the local RTX 3070 Laptop GPU. All 22 wheel versions installed, dependency validation passed, all nine Python tests passed on Linux, and ONNX Runtime selected CUDA and completed a real inference warm-up with synthetic input. |
| Local sustained CUDA and live transport gate | **INCOMPLETE**. The CUDA warm-up finished, but the paced run was interrupted during troubleshooting. WSL removed the temporary virtual environment before the follow-up run. No sustained inference, latency, or jitter measurements from that run are reported. |
| Windows DirectML fixture | **PASS**. The six-second paced gate on the local RTX 3070 produced 2.93× processing throughput, 94 ms maximum ONNX inference, 596 ms maximum window processing time, and zero software playout misses with a 2.8-second buffer. |
| Windows DirectML in Chrome with a 4.5-second buffer | **FAIL** at helper startup. The 44.1 kHz warm-up exceeded the existing 550 ms startup gate, so Chrome could not activate live stems in this run. The guard stayed enabled. |
| Chrome 157 | **PASS** for production manifest and HTTPS auth with mocks, local tab capture and DSP, real YouTube audio, live LRCLIB and Songle, preset restore after restart, and mock personalization. |
| Actual Vercel deployment and hosted Gemini/Supermemory | **NOT RUN**. Requires the operator’s project and provider keys. |
| EC2 launch, Ubuntu 24.04 service installation, SSH tunnel latency, public DNS and certificate, and hosted WSS listening | **NOT RUN**. Requires the operator’s AWS account and domain. |

## Next deployment steps

1. Build the production extension to obtain its ID and create or link your Vercel project yourself. These example domains are for obtaining the ID. Keep using the same unpacked directory when you rebuild with the actual domains.

   ```powershell
   npm ci
   $env:API_BASE_URL = 'https://api.example.com'
   $env:STEM_WS_URL = 'wss://stems.example.com/stem'
   npm run build:extension -- --mode production
   ```

2. Load `extension/dist-cloud` at `chrome://extensions`, copy its ID, configure the [Vercel environment](docs/DEPLOY_VERCEL.md), and deploy. For the CLI use `npx vercel@latest link`, the documented environment commands, and `npx vercel@latest deploy --prod`. Verify `/health` and the API smoke checks.
3. Launch your NVIDIA Ubuntu EC2 instance with SSH restricted to your IP. Copy the worker archive and run `sudo bash deploy/aws/install-stem.sh`. Run the GPU gate, then the private SSH link gate at both sample rates. Keep the worker unexposed if deadlines fail. After both pass, configure Caddy and the exact production extension origin, and test the secure link.
4. Rebuild with the actual HTTPS and WSS origins and measured delay. Load the unpacked output, save the private demo code, and run the [Chrome listening checks](docs/CLOUD_SMOKE_TEST.md#3-public-wss-and-final-chrome-demo).
