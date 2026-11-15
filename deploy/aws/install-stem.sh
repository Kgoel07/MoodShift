#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) == 0 ]] || { echo 'Run with sudo on the Ubuntu NVIDIA EC2 instance.' >&2; exit 1; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
target=/opt/moodshift-stem
[[ $(uname -m) == x86_64 ]] || { echo 'Ubuntu x86_64 is required.' >&2; exit 1; }
[[ $(. /etc/os-release; printf '%s %s' "$ID" "$VERSION_ID") == 'ubuntu 24.04' ]] || {
  echo 'Use the Ubuntu 24.04 NVIDIA Deep Learning Base AMI.' >&2
  exit 1
}
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv
df -h /opt
apt-get update
apt-get install -y ca-certificates curl python3.12-venv libsndfile1

getent passwd moodshift-stem >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin moodshift-stem
install -d -m 0755 "$target/scripts" "$target/assets"
install -m 0644 "$root"/scripts/{stem_model.py,stem_protocol.py,stem_helper.py,benchmark_stems.py,stems-requirements-linux.txt} "$target/scripts/"
python3.12 -m venv "$target/.venv"
"$target/.venv/bin/python" -m pip install --only-binary=:all: -r "$target/scripts/stems-requirements-linux.txt"
"$target/.venv/bin/python" -m pip check

checksum=$(sed -n 's/^MODEL_HASH = "\([0-9a-f]\{64\}\)"$/\1/p' "$target/scripts/stem_model.py")
[[ "$checksum" =~ ^[0-9a-f]{64}$ ]]
model="$target/assets/vocals.onnx"
if ! printf '%s  %s\n' "$checksum" "$model" | sha256sum --check --status; then
  download=$(mktemp "$target/assets/model.XXXXXX")
  trap 'rm -f -- "$download"' EXIT
  curl --fail --location --retry 3 --proto '=https' --output "$download" \
    https://media.githubusercontent.com/media/kuielab/mdx-net-submission/refs/heads/master/onnx_A/vocals.onnx
  printf '%s  %s\n' "$checksum" "$download" | sha256sum --check --status
  install -m 0644 "$download" "$model"
fi

install -m 0644 "$root/deploy/aws/moodshift-stem.service" /etc/systemd/system/moodshift-stem.service
systemctl daemon-reload
printf '%s\n' 'Installed and checksum-verified. Run the GPU gate before starting the worker.'
