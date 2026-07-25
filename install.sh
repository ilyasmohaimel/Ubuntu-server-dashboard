#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/frost-dashboard}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/frost-dashboard-$(date +%Y%m%d-%H%M%S)}"

sudo install -d -m 0755 "$BACKUP_DIR" "$INSTALL_DIR" /run/frost-dashboard
sudo cp -a "$INSTALL_DIR" "$BACKUP_DIR/install" 2>/dev/null || true
sudo cp -a /etc/systemd/system/frost-dashboard-collector.service "$BACKUP_DIR/" 2>/dev/null || true

sudo install -m 0755 "$SOURCE_DIR/collector.py" "$INSTALL_DIR/collector.py"
sudo install -m 0644 "$SOURCE_DIR/nginx.conf" "$INSTALL_DIR/nginx.conf"
sudo install -d -m 0755 "$INSTALL_DIR/web" "$INSTALL_DIR/deploy"
sudo cp -a "$SOURCE_DIR/web/." "$INSTALL_DIR/web/"
sudo chmod -R a+rX "$INSTALL_DIR/web"
sudo install -m 0644 "$SOURCE_DIR/README.md" "$INSTALL_DIR/README.md"
sudo install -m 0755 "$SOURCE_DIR/health-check.sh" "$INSTALL_DIR/health-check.sh"
sudo install -m 0755 "$SOURCE_DIR/rollback.sh" "$INSTALL_DIR/rollback.sh"
sudo install -m 0644 "$SOURCE_DIR/systemd/frost-dashboard-collector.service" /etc/systemd/system/frost-dashboard-collector.service
sudo install -m 0644 "$SOURCE_DIR/compose.yaml" "$INSTALL_DIR/deploy/compose.yaml"

sudo systemctl daemon-reload
sudo systemctl enable --now frost-dashboard-collector
sudo docker compose -f "$INSTALL_DIR/deploy/compose.yaml" up -d
echo "Backup: $BACKUP_DIR"
