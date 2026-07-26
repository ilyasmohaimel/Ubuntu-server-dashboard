#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/frost-dashboard}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/frost-dashboard-$(date +%Y%m%d-%H%M%S)}"
QBITTORRENT_PUID="${QBITTORRENT_PUID:-1000}"
QBITTORRENT_PGID="${QBITTORRENT_PGID:-1001}"
QBITTORRENT_LAN_IP="${QBITTORRENT_LAN_IP:-$(ip -4 route get 1.1.1.1 | awk '{print $7; exit}')}"
QBITTORRENT_TAILSCALE_IP="${QBITTORRENT_TAILSCALE_IP:-$(tailscale ip -4 | head -n 1)}"

if [[ -z "$QBITTORRENT_LAN_IP" || -z "$QBITTORRENT_TAILSCALE_IP" ]]; then
  echo "Unable to determine the LAN and Tailscale addresses required for the qBittorrent WebUI." >&2
  exit 1
fi

sudo install -d -m 0755 "$BACKUP_DIR" "$INSTALL_DIR" /run/frost-dashboard
sudo install -d -o "$QBITTORRENT_PUID" -g "$QBITTORRENT_PGID" -m 0770 /srv/nas/services/config/qbittorrent
sudo install -d -o "$QBITTORRENT_PUID" -g "$QBITTORRENT_PGID" -m 2770 /srv/nas/files/Downloads/qbittorrent /srv/nas/files/Downloads/qbittorrent/incomplete
sudo install -d -o "$QBITTORRENT_PUID" -g "$QBITTORRENT_PGID" -m 0700 /srv/nas/services/config/aria2
sudo install -d -o "$QBITTORRENT_PUID" -g "$QBITTORRENT_PGID" -m 2770 /srv/nas/files/Downloads/Direct
sudo touch /srv/nas/services/config/aria2/aria2.session
sudo chown "$QBITTORRENT_PUID:$QBITTORRENT_PGID" /srv/nas/services/config/aria2/aria2.session
sudo chmod 0600 /srv/nas/services/config/aria2/aria2.session
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
sudo install -m 0644 "$SOURCE_DIR/Dockerfile.aria2" "$INSTALL_DIR/deploy/Dockerfile.aria2"
sudo install -m 0644 "$SOURCE_DIR/Dockerfile.ariang" "$INSTALL_DIR/deploy/Dockerfile.ariang"
sudo install -m 0644 "$SOURCE_DIR/nginx-ariang.conf" "$INSTALL_DIR/deploy/nginx-ariang.conf"
printf 'QBITTORRENT_LAN_IP=%s\nQBITTORRENT_TAILSCALE_IP=%s\nQBITTORRENT_PUID=%s\nQBITTORRENT_PGID=%s\n' \
  "$QBITTORRENT_LAN_IP" "$QBITTORRENT_TAILSCALE_IP" "$QBITTORRENT_PUID" "$QBITTORRENT_PGID" \
  | sudo tee "$INSTALL_DIR/deploy/.env" >/dev/null
sudo chmod 0600 "$INSTALL_DIR/deploy/.env"

sudo systemctl daemon-reload
sudo systemctl enable frost-dashboard-collector
sudo docker compose -p frost-dashboard -f "$INSTALL_DIR/deploy/compose.yaml" up -d --force-recreate frost-dashboard
sudo docker compose -p frost-dashboard -f "$INSTALL_DIR/deploy/compose.yaml" up -d --build qbittorrent aria2 ariang
sudo systemctl restart frost-dashboard-collector
echo "Backup: $BACKUP_DIR"
