# Frostserver dashboard

Frostserver is a static, responsive server dashboard served by an unprivileged Nginx container. A root-only local collector gathers host metrics and writes an atomic JSON snapshot to `/run/frost-dashboard/metrics.json`; Nginx exposes that snapshot read-only at `/metrics.json`.

## Information architecture

- **Overview** is the default landing view and contains live capacity, temperature, fan, Docker, Hermes agent, service, process, and alert detail.
- **Apps Hub** provides search, health, and launch details for every installed web application.
- The sidebar provides direct, status-aware app launchers instead of duplicate links to Overview sections.
- The command palette (`Ctrl` + `K`) provides a keyboard route switcher.

## Apps Hub

The hub includes Cockpit, Uptime Kuma, File Browser, FreshRSS, Syncthing, qBittorrent, and Direct Downloads powered by Aria2/AriaNg. It provides search, category filters, health status, port/context, local-probe latency, and an external open action.

App artwork is sourced from [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons) and vendored into the static site. It only identifies applications; browsing the dashboard does not contact a third-party icon service.

Application URLs are deliberately built in the browser from `window.location.hostname` plus the verified scheme and port. A dashboard opened through a LAN address, private overlay network, or reverse proxy therefore launches the same server through that address. The UI validates destinations and permits only `http:` and `https:` URLs. All outbound app links use `rel="noopener noreferrer"`.

qBittorrent runs as the unprivileged NAS user and stores torrents below `/srv/nas/files/Downloads/qbittorrent`, where they are visible in File Browser. Its WebUI is published only on server-local LAN and Tailscale addresses discovered during installation. Direct Downloads uses Aria2 and AriaNg for ordinary HTTP and HTTPS downloads, saving them below `/srv/nas/files/Downloads/Direct`. AriaNg is bound only to the same server-local LAN and Tailscale addresses, and Aria2's RPC port is private to Docker.

Direct Downloads handles ordinary HTTP, HTTPS, FTP, SFTP, Metalink, and torrent URLs with Aria2 and the AriaNg web interface. Files are saved below `/srv/nas/files/Downloads/Direct`. Aria2 RPC is never published on a host port; the authenticated AriaNg container proxies it over the private Compose network. The server-local HTTP Basic Auth file is intentionally excluded from this repository.

## Metrics schema

`collector.py` writes schema version 3 data including physical drives, real mounted filesystems, live drive I/O, Docker state, process metadata, and CPU/GPU temperature and fan histories. Short-lived sampling commands that have already exited are excluded from process rankings.

Dashboard settings are browser-local and functional: display name, refresh cadence, chart history length, compact density, reduced motion, and network-address masking are applied immediately without changing server configuration.

Process actions never expose a destructive dashboard API. After confirmation, the browser copies the exact `kill` command and opens Cockpit’s authenticated terminal; PID 1 remains protected in the dashboard.

`web_interfaces` never contains a public server URL. Its records contain an id, display metadata, locally verified scheme and port, health result, status code, probe latency, and source. The browser derives a safe destination only when rendering an app link.

## Local preview and deployment

Validate Python and the Compose file before deployment:

```bash
python3 -m py_compile collector.py
docker compose -f compose.yaml config -q
```

Install on the server using the existing deployment helpers, then verify:

```bash
sudo systemctl status frost-dashboard-collector
sudo journalctl -u frost-dashboard-collector -f
curl -fsS http://127.0.0.1/metrics.json | jq .
sudo /opt/frost-dashboard/health-check.sh
```

The Nginx container is non-root, the web directory and Nginx configuration are mounted read-only, and the collector is the only component allowed to write the runtime metric file.

## Adding an app safely

1. Add a tuple to `WEB_INTERFACES` using a stable id, name, description, loopback probe URL, `http` or `https`, port, and category.
2. Keep probe URLs bound to loopback. Do not add LAN IP addresses, credentials, tokens, API keys, or private URLs to the repository.
3. Restart the collector and verify `/metrics.json` locally. The frontend will create the current-browser-host URL automatically.

## Rollback

Restore the timestamped backup made before deployment, reload systemd if the unit changed, restart the collector, and run the health check:

```bash
sudo systemctl daemon-reload
sudo systemctl restart frost-dashboard-collector
sudo /opt/frost-dashboard/health-check.sh
```
