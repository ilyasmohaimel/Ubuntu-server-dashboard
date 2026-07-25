# Frostserver dashboard

Frostserver is a static, responsive server dashboard served by an unprivileged Nginx container. A root-only local collector gathers host metrics and writes an atomic JSON snapshot to `/run/frost-dashboard/metrics.json`; Nginx exposes that snapshot read-only at `/metrics.json`.

## Information architecture

- **Apps Hub** is the default landing view and launches every installed web application.
- **Overview** contains live capacity, temperature, fan, service, process, and alert detail.
- **Performance, Storage, Network, Services, and Processes** route directly to the corresponding Overview section.
- The command palette (`Ctrl` + `K`) provides a keyboard route switcher.

## Apps Hub

The hub includes Frostserver Dashboard, Cockpit, Uptime Kuma, File Browser, FreshRSS, and Syncthing. It provides search, category filters, health status, port/context, local-probe latency, and an external open action.

Application URLs are deliberately built in the browser from `window.location.hostname` plus the verified scheme and port. A dashboard opened through a LAN address, private overlay network, or reverse proxy therefore launches the same server through that address. The UI validates destinations and permits only `http:` and `https:` URLs. All outbound app links use `rel="noopener noreferrer"`.

## Metrics schema

`collector.py` writes `generated_at`, `collector`, `host`, `cpu`, `memory`, `network`, `storage`, `temperatures`, `gpu`, `services`, `docker`, `web_interfaces`, `processes`, `alerts`, `fan`, and `history`.

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
