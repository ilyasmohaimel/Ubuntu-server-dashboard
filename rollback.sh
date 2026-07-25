#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${1:?Usage: sudo ./rollback.sh /var/backups/frost-dashboard-YYYYmmdd-HHMMSS}"
INSTALL_DIR="${INSTALL_DIR:-/opt/frost-dashboard}"

sudo systemctl disable --now frost-dashboard-collector || true
sudo rm -f /etc/systemd/system/frost-dashboard-collector.service
sudo rm -rf "$INSTALL_DIR"
sudo cp -a "$BACKUP_DIR/install" "$INSTALL_DIR"
sudo systemctl daemon-reload
sudo docker compose -f "$INSTALL_DIR/deploy/compose.yaml" up -d
