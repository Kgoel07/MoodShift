# MoodShift — Cloud deployment preparation (Codex instructions)

You are working in the user's EXISTING MoodShift repository. Prepare the CURRENT working app for deployment as: (1) a Vercel-hosted Express/TypeScript JSON API for Gemini and Supermemory; and (2) an AWS EC2 NVIDIA GPU-hosted Python WebSocket source-separation worker, accessed via secure WSS when publicly hosted. Users will continue loading the Chrome extension **unpacked**; Chrome Web Store submission is NOT part of this task.

## 0. Branch, audit, and non-negotiable constraints

1. Run `git status` and inspect branches. Create and switch to a new `feature/cloud-deployment` branch from the most recent working implementation. Do not overwrite uncommitted changes. Do NOT merge into main.
2. Read `AGENTS.md`, `PRD.md`, `README.md`, `TEST_RESULTS.md` and the current code before editing. The uploaded reference contains these key locations (confirm in the actual repository):
   - `server/src/index.ts`: `createApp()` and current direct localhost-only listener, Vercel-incompatible fixed port check; accepts **any** well-formed Chrome extension Origin and has **no authentication**.
   - `server/src/interpret.ts`, `server/src/memory.ts`: Gemini and Supermemory endpoints; memory installation ID is **not authentication**.
   - `extension/src/sidepanel.ts`: hardcoded `http://127.0.0.1:8787/api/interpret`.
   - `extension/src/personalization-panel.ts`: hardcoded `http://127.0.0.1:8787/api/memory`.
   - `extension/src/stem-worker.ts`: hardcoded `ws://127.0.0.1:8788`.
   - `extension/manifest.json`: localhost and lyrics/chord provider host permissions.
   - `scripts/stem_helper.py`, `scripts/stem_model.py`: WebSocket server bound to loopback, permits **one concurrent stream**, model uses **Windows DirectML only** and requires an extension ID. Current model filename is `.stem-gate/assets/vocals.onnx` and validated SHA-256 is already in `stem_model.py`.
   - `scripts/stems-requirements.txt`: Windows `onnxruntime-directml`, not usable for NVIDIA CUDA on Linux.
   - `extension/src/stem-worklet.ts` and `extension/src/shared/stem-pcm.ts`: currently assume a ~2.8 s fixed playback buffer; real network jitter may exceed it.
   - `scripts/build-extension.mjs`: esbuild bundles and copies an unpacked extension to `extension/dist`.
3. Preserve existing Chrome tab audio capture, DSP, side panel, lyrics, chords, saved presets, live stem protocol, and tests. Do NOT refactor unrelated features, introduce a new front-end framework, invent backend features, or add Spotify/YouTube downloading.
4. Do not automatically create or launch cloud resources. Your job is to prepare code and **exact deployment runbooks**; the user will provide cloud credentials/URLs through provider dashboards when ready. Do not request API keys inside chat, do not print secret values, do not commit `.env` or any credentials.
5. Do not include local model assets, virtual environments, `.git`, `.npm-cache`, browser profiles, downloaded media, or `node_modules` in cloud deploys.

## 1. Local + production configuration

Implement one typed, validated, centralized extension configuration with dev and production build modes. Make both of these endpoints configurable WITHOUT modifying bundled source files after each build:
- `API_BASE_URL`: local `http://127.0.0.1:8787`, production `https://<VERCEL_PROJECT_DOMAIN>`
- `STEM_WS_URL`: local `ws://127.0.0.1:8788`, production `wss://<YOUR_STEM_DOMAIN>`

Use the existing esbuild script to substitute verified build-time constants or package a small non-secret config. Do NOT embed Gemini, Supermemory, AWS access keys, or backend demo access secrets in the extension build. Reject invalid protocols or unexpected hosts. Update host permissions for the chosen production HTTPS/WSS endpoints while retaining legitimate lyrics/chords host access; apply least privilege, don't request `<all_urls>`.

Implement a tiny optional **private-demo access code** field in extension settings if a no-account hackathon deployment is desired. It must be entered by the user after installing the unpacked extension, stored via `chrome.storage.local`, and sent only over HTTPS/WSS. Never commit or bundle it. Make it explicitly documented as **private demo protection only**, NOT a multi-user identity system. Prefer separate per-user login/authorization for any actual public launch. The app must continue to function locally without a demo code in development mode.

Use a shared API client/helper so Gemini and Supermemory use the same configured API base URL and authentication header. Do not change their request/response schemas unnecessarily.

## 2. Vercel Express backend

Keep `createApp()` and the current tests working. Add a Vercel-recognized root entry point (for example `index.ts` default-exporting the Express app initialized with `process.env`) as described in CURRENT official Vercel Express docs. Do not force `PORT=8787`, call `app.listen`, or rely on local files in the serverless environment. Keep the existing `npm run dev:server` path for local use. Configure monorepo/root deploy correctly and explain how to select project Root Directory in the Vercel dashboard.

Routes `/health`, `/api/interpret`, and `/api/memory` must function under the deployment URL with consistent paths. Health must not leak any keys. Keep Zod/schema limits, upstream aborts, timeouts, and error handling. Implement safe, exact `ALLOWED_EXTENSION_ORIGINS` (comma separated) for production: don't accept every syntactically valid Chrome extension ID. Development can allow specifically configured local extension ID(s). Treat CORS/Origin as browser protections, NOT authentication.

Protect paid API endpoints with a private-demo code mechanism **if that is the deployment model**; validate a server-side secret with timing-safe comparison and add best-effort bounded rate limiting and quotas, with instructions for provider-side Vercel firewall/budget controls. Reject unauthenticated requests BEFORE invoking Gemini/Supermemory. Do not treat a `chrome.storage.local` installation ID as authorization to read/delete other users' memories. Because a single shared demo code is not per-user authentication, restrict or disable Supermemory `view/clear/remember` in publicly shared deployments unless proper identity-bound authorization is implemented. State limitations plainly. Validate any security feature with negative tests.

Environment example (NO actual secrets): `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPERMEMORY_API_KEY`, `ALLOWED_EXTENSION_ORIGINS`, optional `DEMO_ACCESS_TOKEN`, deployment mode. Ensure production requires explicit configuration rather than silently running insecure. Update `.env.example` and `.gitignore` appropriately.

Document BOTH Vercel dashboard Git import and `vercel` CLI deployment, setting Environment Variables in Vercel, production deployment, and calling `/health`. Do not claim real Vercel deployment or real Gemini/Supermemory calls passed without credentials/network access.

## 3. AWS NVIDIA GPU stem worker

Keep the local Windows DirectML worker working exactly as before. Add **Linux NVIDIA CUDA** support rather than attempting to install Windows DirectML on an Ubuntu EC2 instance.

- Implement provider selection for `DmlExecutionProvider` on Windows and `CUDAExecutionProvider` on Linux, while preserving startup provider verification and existing SHA-256 model integrity check.
- Add a Linux-specific reproducible dependency specification (`scripts/stems-requirements-linux.txt` or pinned Docker image). Pin a *compatible* ONNX Runtime GPU + CUDA/cuDNN combination according to official ONNX Runtime docs. Do not assume CPU fallback can run live: the existing benchmark showed CPU-only fails real-time throughput.
- Create a reproducible GPU startup/benchmark command for a `g4dn.xlarge` (T4) or `g5.xlarge` (A10G), using the existing reference fixture and existing success criteria. Measure actual inference time AND end-to-end throughput; if deadlines fail, fail closed to full mix, report failure and propose a tested alternative. Never claim AWS is faster merely because it has a GPU.
- Keep exactly one active stream for a demo, with accurate “busy” feedback, bounded memory, queue limits, heartbeat/timeout, max session duration, and clean teardown. The original `PACKET_FRAMES=2048`, startup message, session ID, ordered PCM packets, binary layout, and audio worklet wiring must continue working. Any protocol changes require tests and coordinated client+server changes.
- The current tight inference deadline and `stemDelaySeconds=2.8` were tuned for local RTX 3070. Measure RTT, GPU inference and worst-case jitter on EC2. Make the playback buffer configurable within safe bounds, explicitly show current/buffered delay, and fail gracefully to Full Mix on missed deadlines. Do not promise remote real-time latency without an AWS benchmark.
- Implement secure public transport through **WSS** behind a TLS reverse proxy such as Caddy, with a real hostname/certificate. The Python WebSocket server should bind to `127.0.0.1:8788` behind the proxy. Do not expose raw TCP port 8788 directly in AWS security groups. Never transmit audio over public plaintext `ws://`.
- Restrict allowed Chrome-extension `Origin` to configured ID(s), but don't treat Origin or predictable session IDs as credentials. For private demo mode, authenticate WSS sessions with a server-configured secret sent in the initial message **over WSS only**, BEFORE expensive model/stream allocation. Keep token out of URL query strings and logs, and reject unauthorized clients. Document how to revoke/rotate demo secrets. A real public deployment requires proper user authentication and quotas.
- Do not persist streamed raw music on disk or send it to Gemini/Supermemory. Log only safe counters/health information, not raw audio or headers containing secrets.
- Add a Linux `systemd` service file (or straightforward Docker Compose if genuinely simpler), model download/checksum instructions, GPU and disk checks, launch, restart, logs, shutdown, and a sample Caddy reverse-proxy configuration. Do not hardcode IPs, hostnames, secrets or local Windows paths.
- For earliest deployment tests, document **SSH tunnel testing**: run the CUDA worker bound to loopback on EC2, then from the user's laptop forward local port 8788 to EC2 port 8788 using `ssh -N -L 8788:127.0.0.1:8788 ...`. This allows the unmodified local `ws://127.0.0.1:8788` extension to exercise EC2 GPU inference privately BEFORE WSS/domain deployment. Do not expose the worker publicly during this first test.
- Provide instructions for obtaining the Chrome extension ID from `chrome://extensions` and putting `chrome-extension://<ID>` into the allowlist. Preserve and document how to run locally with an unpacked extension.

## 4. Verification & user handoff

Run `npm run typecheck`, `npm test`, `npm run build:extension`, existing Python helper tests, and any new environment/config/security tests. Where possible build/test the Vercel entry point and run its HTTP routes locally. Add mocked CUDA-provider and WSS authentication tests without assuming actual AWS GPUs are available locally.

Add `docs/DEPLOY_VERCEL.md` (exact Vercel dashboard/CLI steps and required env vars), `docs/DEPLOY_AWS_GPU.md` (AWS console EC2 launch with NVIDIA GPU AMI, IAM/security groups SSH only from user's IP, 80/443 for TLS, setup script, GPU benchmark, WSS, cleanup), and `docs/CLOUD_SMOKE_TEST.md` (isolated Vercel API test, SSH-tunnel GPU test, and final end-to-end extension testing). Include cost controls: AWS GPU quota may start at zero, charge while instance is running, EBS and data transfer may incur charges, alarms/budgets, stop or terminate after demo. Clearly label steps dependent on a domain or user-provided cloud credentials.

Add a succinct `CLOUD_DEPLOY_STATUS.md` with completed code changes, passed/failed/not-run checks, exact manual tasks, actual branch and commits, and the precise next deployment commands. Commit to the new branch, do not merge into main. Do not declare a cloud integration “working” based on mocks alone.

**Finish by prioritizing:** (1) Vercel API production compatibility, (2) Linux CUDA worker startup + SSH tunnel feasibility, (3) WSS public hosting and extension config. Do not stall or redesign the app when AWS access/credentials are unavailable; implement and test everything possible offline and document the manual deployment steps.
