#!/usr/bin/env bash
set -euo pipefail

curl --fail --silent --show-error http://127.0.0.1/ >/dev/null
curl --fail --silent --show-error http://127.0.0.1/metrics.json | python3 -m json.tool >/dev/null
systemctl is-active --quiet frost-dashboard-collector
docker inspect --format '{{.State.Running}}' frost-dashboard | grep -qx true
