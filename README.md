# Frostserver dashboard

Static dashboard UI served by an unprivileged Nginx container. A root-only local collector discovers local host metrics and atomically writes `/run/frost-dashboard/metrics.json`; Nginx exposes it read-only at `/metrics.json`.

## Layout

- `collector.py` — local metrics collector; no third-party Python packages.
- `web/` — privacy-preserving dashboard UI.
- `compose.yaml` and `nginx.conf` — port 80 container deployment.
- `systemd/` — collector service unit.

## Operations

```bash
sudo systemctl status frost-dashboard-collector
sudo journalctl -u frost-dashboard-collector -f
sudo docker compose -f /opt/frost-dashboard/deploy/compose.yaml ps
curl -fsS http://127.0.0.1/metrics.json | jq .
```

## Fan control

The dashboard never assumes that fan control is safe. It reports firmware control or unavailable telemetry until a verified, hardware-specific controller is implemented.

## Rollback

Restore the timestamped backup made in `/var/backups/frost-dashboard-*`, then run:

```bash
sudo systemctl disable --now frost-dashboard-collector
sudo rm -f /etc/systemd/system/frost-dashboard-collector.service
sudo systemctl daemon-reload
sudo /opt/frost-dashboard/rollback.sh /var/backups/frost-dashboard-YYYYmmdd-HHMMSS
```
