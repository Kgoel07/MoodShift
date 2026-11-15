# Deploy the MoodShift CUDA worker on AWS EC2

Use a private SSH tunnel for the first GPU test. A domain and public ports are needed only for the final WSS test. The Python worker listens on `127.0.0.1:8788` in both modes. EC2 never needs inbound port 8788. The Chrome extension uses its existing stereo PCM protocol and falls back to Full Mix if the worker misses a deadline or disconnects.

## 1. Launch an instance in your AWS account

1. Choose a Region close to the demo browser. In **Service Quotas → AWS services → Amazon EC2**, check **Running On-Demand G and VT instances**. New accounts may have a zero quota. Request at least 4 vCPUs in that Region if needed. Check availability and estimates for `g4dn.xlarge` (T4) and `g5.xlarge` (A10G). [EC2 quotas](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html) · [AWS pricing estimates](https://docs.aws.amazon.com/pricing-calculator/latest/userguide/ec2-estimates.html)
2. In **EC2 → Instances → Launch instances**, choose the **AWS Deep Learning Base AMI with NVIDIA GPU drivers, Ubuntu 24.04, x86_64**, or the current **Deep Learning Base AMI with Single CUDA (Ubuntu 24.04)**. Verify the publisher is AWS and that the AMI release lists your instance family. Select one of the instance types above. Start with an encrypted gp3 root volume of at least 50 GiB with **Delete on termination** selected. [AWS Ubuntu AMI notes](https://docs.aws.amazon.com/dlami/latest/devguide/aws-deep-learning-ami-gpubasesinglecuda-ul2404-2026-09-16.html)
3. Use a restricted IAM user or role for launching. The worker needs no instance role or AWS access keys. Select your SSH key pair and require IMDSv2. Choose a subnet with internet access for installation. For a direct SSH demo, enable a public IPv4 address and create a security group with inbound TCP 22 from **My IP** only. Leave TCP 80, 443 and 8788 closed for this stage. Keep the private key on your laptop.
4. In **Billing and Cost Management → Budgets → Create budget**, set a small cost budget with email alerts. Check running-instance time, EBS, snapshots, IPv4 and data transfer separately. Budgets can alert and can use configured actions. An alert alone does not stop billing. [AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/create-cost-budget.html)

## 2. Copy only the worker source and run the GPU gate

On your laptop, run these commands from the committed feature branch. Replace the hostname and SSH key path with your own. Only the explicit paths are uploaded.

```powershell
New-Item -ItemType Directory -Force .moodshift-test | Out-Null
git archive --format=tar -o .moodshift-test/moodshift-stem.tar HEAD deploy/aws scripts/stem_protocol.py scripts/stem_model.py scripts/stem_helper.py scripts/stems-requirements-linux.txt scripts/benchmark_stems.py
scp -i <key.pem> .moodshift-test/moodshift-stem.tar ubuntu@<EC2-host>:/tmp/
ssh -i <key.pem> ubuntu@<EC2-host>
```

On EC2:

```bash
nvidia-smi
df -h /
mkdir -p ~/moodshift-source
tar -xf /tmp/moodshift-stem.tar -C ~/moodshift-source
cd ~/moodshift-source
sudo bash deploy/aws/install-stem.sh
```

The installer creates an unprivileged service account and a Python 3.12 virtual environment. It installs ONNX Runtime GPU 1.23.2 with CUDA 12.8 and cuDNN 9 from pinned wheels. Verify NVIDIA driver 570.124.06 or newer. The venv supplies the worker libraries even if the AMI also includes a different CUDA toolkit. The installer downloads the original model and checks the SHA-256 in `stem_model.py`. The worker verifies it again before warm-up. [ONNX Runtime CUDA matrix](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements) · [NVIDIA CUDA driver versions](https://docs.nvidia.com/cuda/archive/12.8.1/cuda-toolkit-release-notes/index.html)

Run the paired inference and paced playout benchmark using the existing authorized fixture. This may take two minutes. Use the same fixture on the browser computer for link tests. [Fixture attribution and baseline](../STEM_FEASIBILITY.md)

```bash
curl --fail --location --output /tmp/moodshift-fixture.ogg \
  https://upload.wikimedia.org/wikipedia/commons/0/01/Amazing_Grace_with_vocals_and_guitar_by_Rocks_From_The_Garden_-_20060603.ogg
cd /opt/moodshift-stem
sudo -u moodshift-stem .venv/bin/python scripts/benchmark_stems.py --self-test
sudo -u moodshift-stem .venv/bin/python scripts/benchmark_stems.py /tmp/moodshift-fixture.ogg \
  --model assets/vocals.onnx --device 0 --seconds 120 --delay 2.8 --require-realtime
```

Require `CUDAExecutionProvider` first, inference windows at or below 650 ms including pre/post-processing, processing throughput above 1×, and zero paced playout misses. On launch, the helper also requires warm-up at both 44.1 and 48 kHz under 550 ms per measured window. If startup or the gate fails, keep cloud stems off. Compare an A10G only if a T4 fails compute, and rerun the same tests before enabling it. The existing Windows DirectML path remains the tested fallback on compatible hardware. CPU-only live inference is disabled.

## 3. Start loopback mode and verify through SSH

Build and load the development extension locally with `npm run build:extension`. Copy its ID from `chrome://extensions`. On EC2, install and edit the environment file. Use `STEM_DEPLOYMENT=local`, set `ALLOWED_EXTENSION_ORIGINS=chrome-extension://<LOCAL_ID>` and leave the code blank.

```bash
sudo install -m 0600 ~/moodshift-source/deploy/aws/.env.stem.example /etc/moodshift-stem.env
sudoedit /etc/moodshift-stem.env
sudo systemctl start moodshift-stem
sudo journalctl -u moodshift-stem -n 30 --no-pager
ss -ltn '( sport = :8788 )'
```

Expect the ready line to name `CUDAExecutionProvider` and the listener to show only `127.0.0.1:8788`. From a separate laptop terminal, close any local helper using port 8788 and run:

```text
ssh -i <key.pem> -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8788:127.0.0.1:8788 ubuntu@<EC2-host>
```

Use the [SSH smoke test](CLOUD_SMOKE_TEST.md#2-private-ssh-gpu-link) before adding public ports. The extension still connects to loopback and the audio between the laptop and EC2 travels inside SSH. If compute passes but the network misses the deadline, keep testing privately with a closer Region or a larger buffer and run the same link gate again.

## 4. Enable public WSS for a private demo

1. Obtain a hostname you control and point its DNS A record at the EC2 public IPv4. If you use an Elastic IP, account for IPv4 charges and release it after the demo. A default public IPv4 can change after stop/start.
2. In `/etc/moodshift-stem.env` set `STEM_DEPLOYMENT=cloud`, replace the allowlist with the **production** extension origin(s), and set the same `DEMO_ACCESS_TOKEN` you use for Vercel. Use `sudoedit` to enter the code. Restart the worker with `sudo systemctl restart moodshift-stem` and check its journal. An unauthenticated connection is rejected before a PCM session is allocated.
3. Install Caddy using its [official Ubuntu package steps](https://caddyserver.com/docs/install#debian-ubuntu-raspbian). Keep external ports closed while replacing the default config.

   ```bash
   sudo install -m 0644 ~/moodshift-source/deploy/aws/Caddyfile /etc/caddy/Caddyfile
   sudoedit /etc/moodshift-caddy.env
   sudo systemctl edit caddy
   ```

   Set `STEM_DOMAIN=<your DNS hostname>` in `/etc/moodshift-caddy.env`. In the Caddy systemd override enter:

   ```ini
   [Service]
   EnvironmentFile=/etc/moodshift-caddy.env
   ```

4. Validate the Caddyfile with `sudo env STEM_DOMAIN=<your DNS hostname> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`. In the EC2 security group, add inbound TCP 80 and 443 for TLS certificate validation and WSS. Keep SSH restricted and port 8788 closed. Run `sudo systemctl daemon-reload`, `sudo systemctl restart caddy`, and `sudo journalctl -u caddy -n 40 --no-pager`. Confirm a publicly trusted certificate on your hostname. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https) · [WebSocket reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
5. Build the production extension with `STEM_WS_URL=wss://<your DNS hostname>/stem`, the real `API_BASE_URL`, and the measured buffer. Reload Chrome, [provision access for a fresh installation](DEPLOY_VERCEL.md#deploy-from-the-dashboard), then run the [final smoke test](CLOUD_SMOKE_TEST.md#3-public-wss-and-final-chrome-demo).

Caddy terminates TLS, sets the trusted protocol indicator, and proxies over loopback. The code is in the first WebSocket message, never in the URL. The worker keeps one authenticated stream, bounded queues and a session time limit. Pending connections have short handshakes and WebSockets have ping/pong timeouts. Limit ingress to trusted demo networks after certificate issuance if your certificate renewal setup permits it. A public launch requires per-user admission and quotas.

## Operate and clean up

- Logs and state: `sudo systemctl status moodshift-stem caddy`, `sudo journalctl -u moodshift-stem -u caddy -f`, `nvidia-smi`.
- Restart after any config change: `sudo systemctl restart moodshift-stem`. To start it on future reboots run `sudo systemctl enable moodshift-stem`. To shut off the service and its autostart run `sudo systemctl disable --now moodshift-stem`.
- Rotate the code in the root-owned environment file and restart. Rotate Vercel’s matching code and deploy it as described in [Deploy on Vercel](DEPLOY_VERCEL.md). Update the browser’s saved code.
- After the demo, stop the EC2 instance if you plan to resume, or terminate it to clean up. Verify that unwanted EBS volumes and snapshots are deleted, release any unused Elastic IP, remove demo DNS records, and check the next billing report for IPv4 and transfer charges. [EC2 stop and terminate behavior](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html)
