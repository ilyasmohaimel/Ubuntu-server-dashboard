const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const ROUTES = [
  ["overview", "Overview", "home"],
  ["apps", "Apps", "apps"],
  ["performance", "Performance", "gauge"],
  ["storage", "Storage", "storage"],
  ["network", "Network", "network"],
  ["services", "Services", "services"],
  ["docker", "Docker", "docker"],
  ["processes", "Processes", "process"],
  ["settings", "Settings", "settings"],
];
const APP_META = {
  cockpit: { icon: "/assets/apps/cockpit.svg", type: "Web Console" },
  "uptime-kuma": { icon: "/assets/apps/uptime-kuma.svg", type: "Monitoring" },
  "file-browser": { icon: "/assets/apps/filebrowser.svg", type: "File Manager" },
  freshrss: { icon: "/assets/apps/freshrss.svg", type: "RSS Reader" },
  syncthing: { icon: "/assets/apps/syncthing.svg", type: "File Sync" },
  qbittorrent: { icon: "/assets/apps/qbittorrent.svg", type: "Torrent Client" },
  ariang: { icon: "/assets/apps/ariang.svg", type: "Download Manager" },
};
const OVERVIEW_APP_IDS = ["cockpit", "uptime-kuma", "file-browser", "freshrss", "qbittorrent", "ariang"];

let latest = null;
let settingsTab = "general";
let processSort = "cpu";
let serviceQuery = "";
let serviceState = "all";
let serviceSort = "name";
let settingsMessage = "";
let interactionUntil = 0;
let pendingRender = false;
let refreshTimer = null;

const iconPaths = {
  home: "M3 11.5 12 4l9 7.5M5 10.5V20h5v-6h4v6h5v-9.5",
  apps: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  gauge: "M4 18a8 8 0 1 1 16 0M12 18l4-5M7 18h.01M17 18h.01",
  storage: "M4 5c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2Zm0 0v7c0 1.1 3.6 2 8 2s8-.9 8-2V5M4 12v7c0 1.1 3.6 2 8 2s8-.9 8-2v-7",
  network: "M5 8v8M9 5v14M15 5v14M19 8v8M3 12h4M17 12h4M11 9h2v6h-2z",
  services: "M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  docker: "M3 13h14c1.8 0 3.2-.6 4-2-1.2 5.8-5.1 9-10.7 9C6.2 20 3.7 17.8 3 13ZM5 9h3v3H5zM9 9h3v3H9zM13 9h3v3h-3zM9 5h3v3H9zM13 5h3v3h-3z",
  process: "M5 4h14v16H5zM8 8h2M8 12h8M8 16h5",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 12H2M22 12h-2M12 4V2M12 22v-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M17.7 6.3l1.4-1.4M4.9 19.1l1.4-1.4",
  terminal: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5",
  bell: "M6 17h12l-2-3V9a4 4 0 0 0-8 0v5l-2 3ZM10 20h4",
  cpu: "M8 8h8v8H8zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3",
  memory: "M4 7h16v10H4zM7 10v4M10 10v4M13 10v4M16 10v4",
  activity: "M3 12h4l2-5 4 10 2-5h6",
  temperature: "M10 14.8V5a2 2 0 0 1 4 0v9.8a4 4 0 1 1-4 0ZM12 8v8",
  health: "M3 12h4l2-5 4 10 2-5h6",
  logs: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
  support: "M4 13v-2a8 8 0 0 1 16 0v2M4 13h3v5H5a2 2 0 0 1-2-2v-1a2 2 0 0 1 1-2ZM20 13h-3v5h2a2 2 0 0 0 2-2v-1a2 2 0 0 0-1-2Z",
};

const svgIcon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPaths[name] || iconPaths.activity}"/></svg>`;
const escapeHtml = (value) => String(value ?? "—").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
const number = (value, digits = 1) => value == null || Number.isNaN(Number(value)) ? "—" : Number(value).toFixed(digits);
const percent = (value) => value == null ? "—" : `${number(value)}%`;
const gib = (value) => value == null ? "—" : `${number(value)} GiB`;
const bytes = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = Number(value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${number(amount, unit ? 1 : 0)} ${units[unit]}`;
};
const diskRate = (value) => value == null ? "—" : `${number(value, 2)} MiB/s`;
const uptime = (seconds) => {
  if (seconds == null) return "Unavailable";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
};
const isActive = (state) => ["active", "listening", "running"].includes(String(state || "").toLowerCase()) || /^up/i.test(String(state || ""));
const state = (active, label) => `<span class="state ${active ? "" : "down"}">${escapeHtml(label)}</span>`;
const unavailable = (label = "Unavailable") => `<span class="unavailable">${escapeHtml(label)}</span>`;
const currentRoute = () => {
  const route = (location.hash || "#overview").slice(1);
  return ROUTES.some(([id]) => id === route) ? route : "overview";
};
const appUrl = (app) => {
  const port = Number(app.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "#";
  const protocol = app.scheme === "https" ? "https:" : "http:";
  const destination = new URL(`${protocol}//${location.hostname}:${port}`);
  if (app.id === "ariang") {
    destination.hash = `!/settings/rpc/set/http/${encodeURIComponent(location.hostname)}/${port}/jsonrpc/`;
  }
  return destination.href;
};
const cockpitUrl = (path) => new URL(path, `https://${location.hostname}:9090`).href;
const storageGet = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const storageSet = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* Browser privacy mode can disable local storage. */ }
};
const setting = (key, fallback) => storageGet(key) ?? fallback;
const settingEnabled = (key, fallback = false) => {
  const value = storageGet(key);
  return value == null ? fallback : value === "true";
};
const dashboardName = (data) => setting("frost-server-name", data?.host?.name || "Frostserver");
const historyLimit = () => Math.max(30, Math.min(120, Number(setting("frost-history-window", "120")) || 120));
const historySeries = (values) => (values || []).slice(-historyLimit());
const displayNetworkValue = (value) => settingEnabled("frost-hide-network") ? "Hidden" : (value || "Unavailable");
const applyPreferences = () => {
  document.body.classList.toggle("compact-ui", settingEnabled("frost-compact-density"));
  document.body.classList.toggle("reduce-motion", settingEnabled("frost-reduce-motion"));
};
const apps = (data) => (data.web_interfaces || []).map((app) => ({ ...app, ...(APP_META[app.id] || { icon: "/assets/apps/linux.svg", type: app.category || "Application" }) }));
const overviewApps = (data) => {
  const byId = new Map(apps(data).map((app) => [app.id, app]));
  return OVERVIEW_APP_IDS.map((id) => byId.get(id)).filter(Boolean);
};
const matchingContainer = (data, app) => (data.docker || []).find((row) => String(row.name || "").toLowerCase().includes(String(app.id || "").replace("file-", "").toLowerCase()));
const safeAverage = (values) => {
  const valid = (values || []).filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};
const maxValue = (values) => {
  const valid = (values || []).filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
  return valid.length ? Math.max(...valid) : null;
};
const uniqueFilesystems = (rows) => {
  const seen = new Set();
  return (rows || []).filter((row) => {
    const key = `${row.source || row.mount}|${row.filesystem || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

function buildNavigation() {
  $("#sideNav").innerHTML = ROUTES.map(([id, label, iconName]) => `<a href="#${id}" data-route="${id}"><span class="nav-icon">${svgIcon(iconName)}</span>${label}</a>`).join("");
  $$("[data-icon]").forEach((element) => { element.innerHTML = svgIcon(element.dataset.icon); });
  $("#logsLink").href = cockpitUrl("/system/logs");
}

function header(title, description, action = true) {
  const terminalHref = cockpitUrl("/system/terminal");
  return `<header class="page-header"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${action ? `<div class="header-actions"><a class="button" href="${escapeHtml(terminalHref)}" ${terminalHref === "#" ? 'aria-disabled="true"' : 'target="_blank" rel="noopener noreferrer"'}><span class="nav-icon">${svgIcon("terminal")}</span>Terminal</a><a class="icon-button" href="#settings" data-settings-target="alerts" aria-label="Open alerts" title="${escapeHtml((latest.alerts || []).length ? `${latest.alerts.length} active alerts` : "No active alerts")}"><span class="nav-icon">${svgIcon("bell")}</span></a></div>` : ""}</header>`;
}

function metricCard(iconName, label, value, caption, series, color = "#ff6a00") {
  const id = `spark-${Math.random().toString(36).slice(2)}`;
  requestAnimationFrame(() => drawLine($(`#${id}`), [historySeries(series)], [color], { grid: false }));
  return `<article class="metric-card"><div class="metric-label"><span class="nav-icon">${svgIcon(iconName)}</span>${escapeHtml(label)}</div><strong>${escapeHtml(value)}</strong><small>${escapeHtml(caption)}</small><canvas class="spark" id="${id}" aria-label="${escapeHtml(label)} history"></canvas></article>`;
}

function updateSidebar(data) {
  const alerts = data.alerts || [];
  const healthy = !alerts.some((alert) => alert.level === "critical");
  const load = (data.cpu.load || []).map((value) => number(value, 2)).join(" ");
  $("#healthCard").innerHTML = `<div class="health-title"><i class="status-dot ${healthy ? "" : "bad"}"></i><strong>${healthy ? "System Healthy" : "Attention Needed"}</strong></div><p>${alerts.length ? `${alerts.length} collector alert${alerts.length === 1 ? "" : "s"}` : "All systems operational"}</p><dl><div><dt>Uptime</dt><dd>${uptime(data.host.uptime_seconds)}</dd></div><div><dt>Load Average</dt><dd>${escapeHtml(load || "Unavailable")}</dd></div><div><dt>Hostname</dt><dd>${escapeHtml(data.host.name)}</dd></div><div><dt>Time</dt><dd>${escapeHtml(new Date(data.generated_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }))}</dd></div></dl>`;
  $$("[data-route]").forEach((link) => link.classList.toggle("active", link.dataset.route === currentRoute()));
}

function drawLine(canvas, series, colors, options = {}) {
  if (!canvas) return;
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  context.clearRect(0, 0, bounds.width, bounds.height);
  if (options.grid !== false) {
    context.strokeStyle = "#2a3035";
    context.setLineDash([4, 5]);
    for (let index = 1; index < 5; index += 1) {
      const y = bounds.height * index / 5;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(bounds.width, y);
      context.stroke();
    }
    context.setLineDash([]);
  }
  const values = series.flat().filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
  if (!values.length) return;
  const maximum = options.maximum || Math.max(1, ...values);
  series.forEach((points, seriesIndex) => {
    context.strokeStyle = colors[seriesIndex] || "#ff6a00";
    context.lineWidth = options.grid === false ? 1.7 : 2;
    context.beginPath();
    let started = false;
    points.forEach((point, index) => {
      if (point == null || !Number.isFinite(Number(point))) return;
      const x = points.length === 1 ? 0 : bounds.width * index / (points.length - 1);
      const y = bounds.height - Math.min(1, Math.max(0, Number(point) / maximum)) * (bounds.height - 8) - 4;
      if (started) context.lineTo(x, y); else { context.moveTo(x, y); started = true; }
    });
    context.stroke();
  });
}

function overviewPage(data) {
  const { cpu, memory, network, storage, temperatures, history } = data;
  const capacityStorage = uniqueFilesystems(storage);
  const total = capacityStorage.reduce((sum, disk) => sum + Number(disk.total || 0), 0);
  const used = capacityStorage.reduce((sum, disk) => sum + Number(disk.used || 0), 0);
  const storagePercent = total ? 100 * used / total : null;
  const hermes = (data.services || []).find((service) => service.unit === "hermes-gateway.service");
  const appList = overviewApps(data);
  const visibleCpuHistory = historySeries(history.cpu);
  const visibleMemoryHistory = historySeries(history.memory);
  return `${header(dashboardName(data), "Home server running smoothly.")}
    <section class="host-strip">
      <img class="server-photo" src="/assets/server-tower-cutout.png" alt="HP Compaq desktop tower">
      <div class="host-copy"><strong>${escapeHtml(data.host.model)}</strong><span>${escapeHtml(cpu.model)}</span><span>${escapeHtml(data.host.os)}</span><span>${escapeHtml(data.gpu?.name || "GPU unavailable")}</span></div>
      <div class="host-fact"><span>System health</span><strong class="healthy">${(data.alerts || []).length ? `${data.alerts.length} active alert${data.alerts.length === 1 ? "" : "s"}` : "All systems operational"}</strong><small>Hermes agent: ${hermes && isActive(hermes.state) ? "online" : "unavailable"}</small></div>
      <div class="host-fact"><span>LAN IP</span><strong>${escapeHtml(displayNetworkValue(network.lan_ip))}</strong><small>Tailscale: ${escapeHtml(displayNetworkValue(network.tailscale_ip))}</small></div>
      <div class="host-fact"><span>Uptime</span><strong>${uptime(data.host.uptime_seconds)}</strong><small>${escapeHtml(new Date(data.generated_at).toLocaleString("en-GB", { timeStyle: "medium" }))}</small></div>
    </section>
    <section class="metrics-five">
      ${metricCard("cpu", "CPU Usage", percent(cpu.usage), cpu.frequency_mhz ? `${number(cpu.frequency_mhz, 0)} MHz current` : "Managed frequency", history.cpu)}
      ${metricCard("memory", "Memory Usage", percent(memory.percent), `${gib(memory.used)} / ${gib(memory.total)}`, history.memory)}
      ${metricCard("storage", "Storage Usage", percent(storagePercent), `${gib(used)} / ${gib(total)}`, (history.memory || []).map(() => storagePercent))}
      ${metricCard("network", "Network Activity", `${number(network.download_mbps, 2)} Mb/s`, `↑ ${number(network.upload_mbps, 2)} Mb/s`, (history.download || []).map((value) => value * 8))}
      ${metricCard("temperature", "Temperature", cpu.temperature == null ? "Unavailable" : `${number(cpu.temperature)}°C`, "CPU package", history.temperature)}
    </section>
    <section class="grid-two">
      <article class="panel"><div class="panel-head"><h2>Performance Trend</h2><span class="muted">Last ${escapeHtml(visibleCpuHistory.length)} samples</span></div><div class="legend"><span><i></i>CPU Usage</span><span><i class="yellow"></i>Memory Usage</span><span><i class="green"></i>Load Average</span></div><canvas class="chart compact" id="overviewTrend"></canvas><div class="stat-foot"><div><span>Current CPU</span><strong>${percent(cpu.usage)}</strong></div><div><span>RAM Used</span><strong>${gib(memory.used)}</strong></div><div><span>Peak CPU</span><strong>${percent(maxValue(visibleCpuHistory))}</strong></div><div><span>Peak Memory</span><strong>${percent(maxValue(visibleMemoryHistory))}</strong></div></div></article>
      <article class="panel"><div class="panel-head"><h2>Physical Drives</h2><a class="button" href="#storage">Storage details</a></div>${storageDeviceTable(data.storage_devices || [])}</article>
    </section>
    <section class="grid-two equal">
      <article class="panel"><div class="panel-head"><h2>Apps / Service Hub</h2><a class="button" href="#apps">View all</a></div><div class="app-grid overview-apps">${appList.slice(0, 6).map(appMini).join("")}</div></article>
      <article class="panel thermal-panel"><div class="panel-head"><h2>Temperatures &amp; Fans</h2><span class="muted">Last ${escapeHtml(historySeries(history.temperature).length)} samples</span></div><div class="thermal-series"><div><div class="legend"><span><i></i>CPU ${cpu.temperature == null ? "—" : `${number(cpu.temperature)}°C`}</span><span><i class="yellow"></i>GPU ${temperatures.gpu == null ? "—" : `${number(temperatures.gpu)}°C`}</span></div><canvas class="chart micro" id="overviewTemperatureTrend" aria-label="CPU and GPU temperature history"></canvas></div><div><div class="legend"><span><i class="green"></i>GPU fan ${temperatures.gpu_fan == null ? "unavailable" : `${number(temperatures.gpu_fan, 0)}%`}</span><span class="muted">${escapeHtml(data.fan?.software_control ? "Software control" : "Firmware automatic")}</span></div><canvas class="chart micro" id="overviewFanTrend" aria-label="GPU fan speed history"></canvas></div></div><p class="muted thermal-note">${escapeHtml(data.fan?.reason || temperatures.cpu_fan_status || "Fan telemetry unavailable")}</p></article>
    </section>
    <article class="panel"><div class="panel-head"><h2>Docker Containers</h2><a class="button" href="#docker">View all</a></div>${dockerTable(data.docker || [], 6)}</article>`;
}

function appMini(app) {
  return `<a class="app-card" href="${escapeHtml(appUrl(app))}" ${appUrl(app) === "#" ? 'aria-disabled="true"' : 'target="_blank" rel="noopener noreferrer"'}><div class="app-id"><span class="app-icon"><img src="${escapeHtml(app.icon || APP_META[app.id]?.icon || "/assets/apps/linux.svg")}" alt=""></span><div><h2>${escapeHtml(app.name)}</h2><p>${escapeHtml(app.type || app.description)}</p></div></div></a>`;
}

function appsPage(data) {
  const appList = apps(data);
  return `${header("Apps / Service Hub", "Manage and launch your self-hosted applications.", false)}
    <div class="app-grid">${appList.map((app) => {
      const container = matchingContainer(data, app);
      const link = appUrl(app);
      const appMemory = container?.memory_bytes == null ? null : `${number(container.memory_bytes / 1024 / 1024)} MB`;
      return `<article class="app-card"><div class="app-card-head"><div class="app-id"><span class="app-icon"><img src="${escapeHtml(app.icon || APP_META[app.id]?.icon || "/assets/apps/linux.svg")}" alt=""></span><div><h2>${escapeHtml(app.name)}</h2><p>${escapeHtml(app.type || app.description)}</p></div></div>${state(Boolean(app.healthy), app.healthy ? "Running" : "Unavailable")}</div><div class="app-stats"><div><span>Status</span><strong>${escapeHtml(app.status || "Local")}</strong></div><div><span>Latency</span><strong>${app.latency_ms == null ? "—" : `${escapeHtml(app.latency_ms)} ms`}</strong></div><div><span>${container ? "Memory" : "Port"}</span><strong>${escapeHtml(appMemory || app.port || "Local")}</strong></div></div><canvas class="spark app-spark" data-app-series="${escapeHtml(app.id)}"></canvas><a class="button" href="${escapeHtml(link)}" ${link === "#" ? 'aria-disabled="true"' : 'target="_blank" rel="noopener noreferrer"'}>Open <span aria-hidden="true">↗</span></a></article>`;
    }).join("")}</div>
    <article class="panel app-banner"><div><strong>Installed services only</strong><p>Launch links are derived from the current browser host and collector-reported ports.</p></div><a class="button" href="#services">Review service health</a></article>`;
}

function performancePage(data) {
  const { cpu, memory, history, temperatures } = data;
  const visibleCpuHistory = historySeries(history.cpu);
  return `${header("Performance", "Monitor system performance and resource usage.")}
    <section class="summary-grid">
      ${metricCard("cpu", "CPU Usage", percent(cpu.usage), cpu.model, history.cpu)}
      ${metricCard("memory", "Memory Usage", percent(memory.percent), `${gib(memory.used)} / ${gib(memory.total)}`, history.memory)}
      ${metricCard("activity", "Load Average", number(cpu.load?.[0], 2), (cpu.load || []).map((value) => number(value, 2)).join("  "), history.cpu)}
      ${metricCard("temperature", "CPU Package", cpu.temperature == null ? "Unavailable" : `${number(cpu.temperature)}°C`, "Live thermal sensor", history.temperature)}
    </section>
    <section class="grid-two equal">
      <article class="panel"><div class="panel-head"><h2>CPU Usage</h2><span class="muted">Last ${escapeHtml(visibleCpuHistory.length)} samples</span></div><div class="legend"><span><i></i>CPU Usage</span><span><i class="yellow"></i>Memory</span></div><canvas class="chart" id="performanceCpu"></canvas><div class="stat-foot"><div><span>Peak CPU</span><strong>${percent(maxValue(visibleCpuHistory))}</strong></div><div><span>Average CPU</span><strong>${percent(safeAverage(visibleCpuHistory))}</strong></div><div><span>Current</span><strong>${percent(cpu.usage)}</strong></div><div><span>Cores</span><strong>${escapeHtml((cpu.cores || []).length || "—")}</strong></div></div></article>
      <article class="panel"><div class="panel-head"><h2>Temperatures</h2><span class="muted">Hardware sensors over time</span></div><div class="legend"><span><i></i>CPU Package</span><span><i class="yellow"></i>GPU</span></div><canvas class="chart" id="performanceTemp"></canvas><div class="stat-foot"><div><span>CPU Package</span><strong>${cpu.temperature == null ? "—" : `${number(cpu.temperature)}°C`}</strong></div><div><span>GPU</span><strong>${temperatures.gpu == null ? "—" : `${number(temperatures.gpu)}°C`}</strong></div><div><span>Fan Control</span><strong>Firmware</strong></div><div><span>GPU Fan</span><strong>${temperatures.gpu_fan == null ? "—" : `${number(temperatures.gpu_fan, 0)}%`}</strong></div></div></article>
    </section>
    <article class="panel"><div class="panel-head"><h2>Top Processes by CPU Usage</h2><a class="button" href="#processes">View all processes</a></div>${processTable(data.processes || [], 5)}</article>`;
}

function storageTable(storage, limit) {
  const rows = (storage || []).slice(0, limit || storage.length);
  if (!rows.length) return '<div class="empty">No mounted storage was reported.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Mount</th><th>Usage</th><th>Used / Total</th><th>Read</th><th>Write</th><th>Type</th><th>Health</th></tr></thead><tbody>${rows.map((disk) => `<tr><td><span class="accent">${escapeHtml(disk.mount)}</span><br><span class="muted">${escapeHtml(disk.label)}</span></td><td><progress max="100" value="${Math.min(100, Number(disk.percent) || 0)}">${percent(disk.percent)}</progress>${percent(disk.percent)}</td><td>${gib(disk.used)} / ${gib(disk.total)}</td><td>${diskRate(disk.read_mbps)}</td><td>${diskRate(disk.write_mbps)}</td><td>${escapeHtml(disk.type || disk.filesystem || "Unavailable")}</td><td>${state(String(disk.health || "").toLowerCase() !== "unavailable", disk.health || "Available")}</td></tr>`).join("")}</tbody></table></div>`;
}

function storageDeviceTable(devices) {
  if (!(devices || []).length) return '<div class="empty">No physical drives were reported.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Drive</th><th>Model</th><th>Capacity</th><th>Mounts</th><th>Read</th><th>Write</th><th>Health</th></tr></thead><tbody>${devices.map((disk) => `<tr><td><strong>${escapeHtml(disk.name)}</strong><br><span class="muted">${escapeHtml(disk.type || disk.transport || "Drive")}</span></td><td>${escapeHtml(disk.model || "Unknown model")}</td><td>${bytes(disk.size_bytes)}</td><td>${escapeHtml((disk.mountpoints || []).join(", ") || "Not mounted")}</td><td>${diskRate(disk.read_mbps)}</td><td>${diskRate(disk.write_mbps)}</td><td>${state(String(disk.smart_health || "").toLowerCase() !== "failed", disk.smart_health || "Available")}</td></tr>`).join("")}</tbody></table></div>`;
}

function storagePage(data) {
  const disks = data.storage || [];
  const capacityDisks = uniqueFilesystems(disks);
  const total = capacityDisks.reduce((sum, disk) => sum + Number(disk.total || 0), 0);
  const used = capacityDisks.reduce((sum, disk) => sum + Number(disk.used || 0), 0);
  const usage = total ? 100 * used / total : null;
  return `${header("Storage", "View and manage storage devices and mounts.")}
    <section class="summary-grid">
      ${metricCard("storage", "Total Capacity", gib(total), "All mounted storage", disks.map((disk) => disk.total))}
      ${metricCard("storage", "Total Used", gib(used), `${percent(usage)} of total capacity`, disks.map((disk) => disk.used))}
      ${metricCard("activity", "Usage", percent(usage), `${gib(used)} / ${gib(total)}`, disks.map((disk) => disk.percent))}
      ${metricCard("health", "Health", disks.every((disk) => String(disk.health || "").toLowerCase() !== "failed") ? "All good" : "Attention", "Collector-reported device state", disks.map((disk) => disk.percent), "#55d45d")}
    </section>
    <article class="panel storage-section"><div class="panel-head"><div><h2>Physical Drives</h2><p>${(data.storage_devices || []).length} devices reported with live I/O</p></div><a class="button" href="${escapeHtml(cockpitUrl("/storage"))}" target="_blank" rel="noopener noreferrer">Open Cockpit storage ↗</a></div>${storageDeviceTable(data.storage_devices || [])}</article>
    <article class="panel"><div class="panel-head"><div><h2>Mounted Filesystems</h2><p>${disks.length} filesystems reported</p></div><a class="button" href="${escapeHtml(cockpitUrl("/storage"))}" target="_blank" rel="noopener noreferrer">Storage logs ↗</a></div>${storageTable(disks)}<div class="stat-foot"><div><span>Total Used</span><strong>${gib(used)}</strong></div><div><span>Total Capacity</span><strong>${gib(total)}</strong></div><div><span>Usage</span><strong>${percent(usage)}</strong></div><div><span>Mounts</span><strong>${disks.length}</strong></div></div></article>`;
}

function networkPage(data) {
  const network = data.network || {};
  const connections = data.connections || network.connections || {};
  const totalConnections = Number(connections.total || 0);
  const interfaces = network.interfaces || [];
  return `${header("Network", "Monitor network interfaces and connections.")}
    <section class="summary-grid">
      ${metricCard("network", "LAN IP", displayNetworkValue(network.lan_ip), network.interface || "Primary interface", data.history.download)}
      ${metricCard("network", "Tailscale IP", displayNetworkValue(network.tailscale_ip), "Private overlay network", data.history.upload)}
      ${metricCard("network", "Gateway", displayNetworkValue(network.gateway), "Default route", data.history.download)}
      ${metricCard("network", "DNS", displayNetworkValue((network.dns || [])[0]), "Resolver", data.history.upload)}
    </section>
    <section class="grid-two">
      <article class="panel"><div class="panel-head"><h2>Network Throughput</h2><span class="muted">Live samples</span></div><div class="legend"><span><i></i>Upload</span><span><i class="green"></i>Download</span></div><canvas class="chart" id="networkTrend"></canvas></article>
      <article class="panel"><div class="panel-head"><h2>Active Connections</h2><span class="muted">Kernel socket summary</span></div>${totalConnections ? `<div class="donut-wrap"><div class="donut"><div class="donut-center"><strong>${totalConnections}</strong><span>Total</span></div></div><div class="donut-legend"><div><span><i></i>TCP</span><strong>${escapeHtml(connections.tcp || 0)}</strong></div><div><span><i class="green-key"></i>UDP</span><strong>${escapeHtml(connections.udp || 0)}</strong></div><div><span><i class="gray-key"></i>Established</span><strong>${escapeHtml(connections.tcp_established || 0)}</strong></div></div></div>` : '<div class="empty">Connection counts unavailable.</div>'}</article>
    </section>
      <article class="panel"><div class="panel-head"><h2>Network Interfaces</h2><span class="muted">Read-only</span></div>${interfaces.length ? `<div class="table-wrap"><table><thead><tr><th>Interface</th><th>State</th><th>IP Address</th><th>Upload</th><th>Download</th></tr></thead><tbody>${interfaces.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${state(item.state === "up", item.state || "unknown")}</td><td>${escapeHtml(displayNetworkValue((item.addresses || [])[0]))}</td><td>${escapeHtml(item.upload_mbps == null ? "Unavailable" : `${number(item.upload_mbps, 2)} Mb/s`)}</td><td>${escapeHtml(item.download_mbps == null ? "Unavailable" : `${number(item.download_mbps, 2)} Mb/s`)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="table-wrap"><table><thead><tr><th>Interface</th><th>State</th><th>IP Address</th><th>Upload</th><th>Download</th></tr></thead><tbody><tr><td>${escapeHtml(network.interface || "Unavailable")}</td><td>${state(Boolean(network.interface), network.interface ? "up" : "unknown")}</td><td>${escapeHtml(displayNetworkValue(network.lan_ip))}</td><td>${number(network.upload_mbps, 2)} Mb/s</td><td>${number(network.download_mbps, 2)} Mb/s</td></tr></tbody></table></div>`}</article>`;
}

function servicesPage(data) {
  const services = [...(data.services || [])]
    .filter((service) => serviceState === "all" || (serviceState === "active" ? isActive(service.state) : !isActive(service.state)))
    .filter((service) => `${service.name} ${service.unit} ${service.description} ${service.category}`.toLowerCase().includes(serviceQuery.toLowerCase()))
    .sort((left, right) => {
      if (serviceSort === "cpu") return Number(right.cpu_percent || 0) - Number(left.cpu_percent || 0);
      if (serviceSort === "memory") return Number(right.memory_bytes || 0) - Number(left.memory_bytes || 0);
      return String(left.name || "").localeCompare(String(right.name || ""));
    });
  const totalServices = (data.services || []).length;
  return `${header("Services", "Manage and monitor system services on your server.", false)}
    <article class="panel"><div class="panel-head"><div><h2>Managed Services</h2><p>${services.length}/${totalServices} shown · ${(data.services || []).filter((service) => isActive(service.state)).length} active</p></div><div class="table-controls"><input id="serviceSearch" type="search" value="${escapeHtml(serviceQuery)}" placeholder="Search services" aria-label="Search services"><select id="serviceState" aria-label="Filter service state"><option value="all" ${serviceState === "all" ? "selected" : ""}>All states</option><option value="active" ${serviceState === "active" ? "selected" : ""}>Active</option><option value="inactive" ${serviceState === "inactive" ? "selected" : ""}>Inactive</option></select><select id="serviceSort" aria-label="Sort services"><option value="name" ${serviceSort === "name" ? "selected" : ""}>Sort: name</option><option value="cpu" ${serviceSort === "cpu" ? "selected" : ""}>Sort: CPU</option><option value="memory" ${serviceSort === "memory" ? "selected" : ""}>Sort: memory</option></select></div></div><div class="table-wrap"><table><thead><tr><th>Service</th><th>Description</th><th>State</th><th>Category</th><th>CPU</th><th>Memory</th><th>PID</th><th>Tasks</th><th>Restarts</th><th>Uptime</th><th>Port</th></tr></thead><tbody>${services.map((service) => `<tr><td><strong>${escapeHtml(service.name)}</strong><br><span class="muted">${escapeHtml(service.unit)}</span></td><td>${escapeHtml(service.description || service.name)}</td><td>${state(isActive(service.state), `${service.state || "unknown"} · ${service.substate || "unknown"}`)}</td><td>${escapeHtml(service.category || "System")}</td><td>${service.cpu_percent == null ? "—" : percent(service.cpu_percent)}</td><td>${bytes(service.memory_bytes)}</td><td>${escapeHtml(service.main_pid || "—")}</td><td>${escapeHtml(service.tasks ?? "—")}</td><td>${escapeHtml(service.restart_count ?? "—")}</td><td>${service.uptime_seconds == null ? unavailable() : uptime(service.uptime_seconds)}</td><td>${escapeHtml(service.port || "—")}</td></tr>`).join("") || '<tr><td colspan="11" class="empty">No services match this view.</td></tr>'}</tbody></table></div></article>`;
}

function dockerTable(containers, limit) {
  const rows = containers.slice(0, limit || containers.length);
  return `<div class="table-wrap"><table><thead><tr><th>Container</th><th>Image</th><th>Status</th><th>Health</th><th>Uptime</th><th>CPU</th><th>Memory</th><th>Network I/O</th><th>Block I/O</th><th>Restarts</th><th>Ports</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${escapeHtml(row.name)}</strong><br><span class="muted">${escapeHtml(row.compose_project || "standalone")}</span></td><td>${escapeHtml(row.image || "Unavailable")}</td><td>${state(isActive(row.state || row.status), row.state || row.status || "unknown")}</td><td>${escapeHtml(row.health || "Not configured")}</td><td>${row.uptime_seconds == null ? "—" : uptime(row.uptime_seconds)}</td><td>${row.cpu_percent == null ? escapeHtml(row.cpu || "—") : percent(row.cpu_percent)}</td><td>${escapeHtml(row.memory || "—")}</td><td>${escapeHtml(row.network_io || "—")}</td><td>${escapeHtml(row.block_io || "—")}</td><td>${escapeHtml(row.restart_count ?? "—")}</td><td>${escapeHtml(row.ports || "—")}</td></tr>`).join("") || '<tr><td colspan="11" class="empty">No running containers detected.</td></tr>'}</tbody></table></div>`;
}

function dockerPage(data) {
  const rows = data.docker || [];
  const summary = data.docker_summary || {};
  return `${header("Docker", "Manage your Docker containers.", false)}
    <section class="summary-grid five">
      ${metricCard("docker", "Containers", summary.containers ?? rows.length, "Running", rows.map(() => rows.length))}
      ${metricCard("storage", "Images", summary.images ?? "Unavailable", "Total", rows.map(() => summary.images || 0))}
      ${metricCard("cpu", "CPU", summary.cpu_percent == null ? "Unavailable" : percent(summary.cpu_percent), "Current total", rows.map((row) => Number.parseFloat(row.cpu) || 0))}
      ${metricCard("memory", "Memory", summary.memory_bytes == null ? "Unavailable" : `${number(summary.memory_bytes / 1024 / 1024)} MB`, "Current total", rows.map((row) => Number(row.memory_bytes) / 1024 / 1024 || 0))}
      ${metricCard("network", "Ports", summary.exposed_ports ?? rows.filter((row) => row.ports).length, "Exposed mappings", rows.map((row) => row.ports ? 1 : 0))}
    </section>
    <article class="panel"><div class="panel-head"><div><h2>Containers</h2><p>Live Docker runtime snapshot</p></div><span class="muted">Updated ${escapeHtml(new Date(data.generated_at).toLocaleTimeString("en-GB"))} · Docker refresh ${escapeHtml(data.collector?.docker_refresh_seconds || 15)}s</span></div>${dockerTable(rows)}</article>`;
}

function processTable(processes, limit, controls = false) {
  const sorted = [...processes].sort((left, right) => processSort === "memory" ? Number(right.memory || 0) - Number(left.memory || 0) : Number(right.cpu || 0) - Number(left.cpu || 0));
  const actionHeader = controls ? "<th>Actions</th>" : "";
  const emptyColumns = controls ? 8 : 7;
  return `<div class="table-wrap"><table><thead><tr><th>PID</th><th>Process</th><th>User</th><th>CPU</th><th>Memory</th><th>Status</th><th>Started</th>${actionHeader}</tr></thead><tbody>${sorted.slice(0, limit || sorted.length).map((process) => {
    const manageable = Number(process.pid) > 1;
    const actionTitle = manageable ? "Copy the command and open the authenticated Cockpit terminal" : "PID 1 is protected";
    const actions = controls ? `<td><div class="process-actions" title="${actionTitle}"><button type="button" class="button" data-process-pid="${escapeHtml(process.pid)}" data-process-name="${escapeHtml(process.command)}" data-terminal-signal="SIGTERM" ${manageable ? "" : "disabled"}>Copy terminate</button><button type="button" class="button danger" data-process-pid="${escapeHtml(process.pid)}" data-process-name="${escapeHtml(process.command)}" data-terminal-signal="SIGKILL" ${manageable ? "" : "disabled"}>Copy force-kill</button></div></td>` : "";
    return `<tr><td>${escapeHtml(process.pid)}</td><td><strong>${escapeHtml(process.command)}</strong></td><td>${escapeHtml(process.user)}</td><td class="accent">${percent(process.cpu)}</td><td>${process.memory_bytes != null ? escapeHtml(process.memory_human || `${number(process.memory_bytes / 1024 / 1024)} MB`) : percent(process.memory)}</td><td>${state(!String(process.status || "").startsWith("Z"), process.status || "Running")}</td><td>${escapeHtml(process.started_at ? new Date(process.started_at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : process.runtime || "Unavailable")}</td>${actions}</tr>`;
  }).join("") || `<tr><td colspan="${emptyColumns}" class="empty">No process data available.</td></tr>`}</tbody></table></div>`;
}

function processesPage(data) {
  return `${header("Processes", "View and manage running processes.")}
    <article class="panel"><div class="panel-head"><div><h2>Top Resource Consumers</h2><p>Actions copy a command and open Cockpit’s authenticated terminal; PID 1 remains protected.</p></div><div class="segmented" aria-label="Process sort"><button type="button" data-process-sort="cpu" class="${processSort === "cpu" ? "active" : ""}">CPU</button><button type="button" data-process-sort="memory" class="${processSort === "memory" ? "active" : ""}">Memory</button></div></div><div id="processActionStatus" class="action-status" aria-live="polite"></div>${processTable(data.processes || [], null, true)}<div class="empty">Showing ${(data.processes || []).length} collector-ranked processes</div></article>`;
}

function serviceLinks(data) {
  return apps(data).filter((app) => app.id !== "dashboard").map((app) => {
    const link = appUrl(app);
    return `<div class="link-row"><span>${escapeHtml(app.name)}</span><div class="link-actions"><div class="link-value">${escapeHtml(link)}</div><a class="button" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open</a></div></div>`;
  }).join("");
}

function settingsPage(data) {
  const tabs = ["general", "display", "alerts", "links", "diagnostics"];
  const notice = `<div class="action-status settings-status" aria-live="polite">${escapeHtml(settingsMessage)}</div>`;
  let body = "";
  if (settingsTab === "general") {
    const refreshInterval = setting("frost-refresh-interval", "1000");
    const chartWindow = setting("frost-history-window", "120");
    const browserRefreshSeconds = Number(refreshInterval) / 1000;
    body = `${notice}<div class="settings-grid"><article class="panel"><div class="panel-head"><div><h2>Dashboard Behavior</h2><p>Saved in this browser and applied immediately.</p></div></div><form class="settings-form" id="settingsForm"><label>Dashboard Name<input name="serverName" maxlength="40" value="${escapeHtml(dashboardName(data))}"></label><label>Live Refresh<select name="refreshInterval"><option value="1000" ${refreshInterval === "1000" ? "selected" : ""}>Every second</option><option value="5000" ${refreshInterval === "5000" ? "selected" : ""}>Every 5 seconds</option><option value="10000" ${refreshInterval === "10000" ? "selected" : ""}>Every 10 seconds</option><option value="30000" ${refreshInterval === "30000" ? "selected" : ""}>Every 30 seconds</option></select></label><label>Chart History<select name="historyWindow"><option value="30" ${chartWindow === "30" ? "selected" : ""}>Last 30 samples</option><option value="60" ${chartWindow === "60" ? "selected" : ""}>Last 60 samples</option><option value="120" ${chartWindow === "120" ? "selected" : ""}>Last 120 samples</option></select></label><button class="button" type="submit">Save behavior</button></form></article><article class="panel"><div class="panel-head"><h2>Current Runtime</h2></div><div class="link-list"><div class="link-row"><span>Collector cadence</span><div class="link-value">${escapeHtml(data.collector?.interval_seconds || 1)} second</div></div><div class="link-row"><span>Browser refresh</span><div class="link-value">${escapeHtml(browserRefreshSeconds)} ${browserRefreshSeconds === 1 ? "second" : "seconds"}</div></div><div class="link-row"><span>Chart window</span><div class="link-value">${escapeHtml(chartWindow)} samples</div></div><div class="link-row"><span>Data timestamp</span><div class="link-value">${escapeHtml(new Date(data.generated_at).toLocaleString("en-GB"))}</div></div></div></article></div>`;
  } else if (settingsTab === "display") {
    body = `${notice}<div class="settings-grid"><article class="panel"><div class="panel-head"><div><h2>Display &amp; Privacy</h2><p>Choose how this browser presents the dashboard.</p></div></div><form class="settings-form" id="displaySettingsForm"><label class="toggle-row"><span><strong>Compact density</strong><small>Fit more rows and panels on screen.</small></span><input type="checkbox" name="compactDensity" ${settingEnabled("frost-compact-density") ? "checked" : ""}></label><label class="toggle-row"><span><strong>Reduce motion</strong><small>Disable interface transitions in this browser.</small></span><input type="checkbox" name="reduceMotion" ${settingEnabled("frost-reduce-motion") ? "checked" : ""}></label><label class="toggle-row"><span><strong>Hide network addresses</strong><small>Mask LAN, Tailscale, gateway, DNS, and interface addresses.</small></span><input type="checkbox" name="hideNetwork" ${settingEnabled("frost-hide-network") ? "checked" : ""}></label><button class="button" type="submit">Save display settings</button></form></article><article class="panel"><div class="panel-head"><h2>Applied Theme</h2></div><div class="link-list"><div class="link-row"><span>Theme</span><div class="link-value">Ubuntu dark · orange accent</div></div><div class="link-row"><span>Density</span><div class="link-value">${settingEnabled("frost-compact-density") ? "Compact" : "Comfortable"}</div></div><div class="link-row"><span>Network values</span><div class="link-value">${settingEnabled("frost-hide-network") ? "Hidden" : "Visible"}</div></div></div></article></div>`;
  } else if (settingsTab === "alerts") {
    body = `<article class="panel"><div class="panel-head"><div><h2>Collector Alerts</h2><p>Live warnings generated from temperature, memory, storage, and service health.</p></div><span class="muted">${(data.alerts || []).length} active</span></div>${(data.alerts || []).map((alert) => `<div class="link-row"><span class="state ${alert.level === "critical" ? "down" : "warn"}">${escapeHtml(alert.level)}</span><div class="link-value">${escapeHtml(alert.message)}</div></div>`).join("") || '<div class="empty">No active alerts. All monitored thresholds are currently normal.</div>'}</article>`;
  } else if (settingsTab === "links") {
    body = `<article class="panel"><div class="panel-head"><div><h2>Service Links</h2><p>Addresses follow the host used to open this dashboard.</p></div></div><div class="link-list">${serviceLinks(data)}</div></article>`;
  } else {
    body = `${notice}<div class="settings-grid"><article class="panel"><div class="panel-head"><div><h2>Diagnostics</h2><p>Inspect and refresh the read-only collector snapshot.</p></div></div><div class="link-list"><div class="link-row"><span>Schema</span><div class="link-value">Version ${escapeHtml(data.schema_version || "Unavailable")}</div></div><div class="link-row"><span>Processes</span><div class="link-value">${escapeHtml((data.processes || []).length)} ranked entries · ${escapeHtml(data.collector?.process_refresh_seconds || "—")}s cadence</div></div><div class="link-row"><span>Docker</span><div class="link-value">${escapeHtml((data.docker || []).length)} containers · ${escapeHtml(data.collector?.docker_refresh_seconds || "—")}s cadence</div></div><div class="link-row"><span>Security</span><div class="link-value">Read-only snapshot · no dashboard command API</div></div></div></article><article class="panel"><div class="panel-head"><h2>Tools</h2></div><div class="settings-tools"><button class="button" id="refreshNow" type="button">Refresh now</button><button class="button" id="downloadSnapshot" type="button">Download diagnostics JSON</button><a class="button" href="${escapeHtml(cockpitUrl("/system/logs"))}" target="_blank" rel="noopener noreferrer">Open system logs</a><a class="button" href="${escapeHtml(cockpitUrl("/system/terminal"))}" target="_blank" rel="noopener noreferrer">Open terminal</a></div></article></div>`;
  }
  return `${header("Settings", "Control dashboard behavior, privacy, links, and diagnostics.", false)}<div class="settings-tabs" role="tablist">${tabs.map((tab) => `<button type="button" role="tab" aria-selected="${tab === settingsTab}" data-settings-tab="${tab}" class="${tab === settingsTab ? "active" : ""}">${tab[0].toUpperCase()}${tab.slice(1)}</button>`).join("")}</div>${body}`;
}

function pageInteractionActive() {
  const active = document.activeElement;
  return Date.now() < interactionUntil
    || Boolean(active && $("#page")?.contains(active) && active.matches("input, select, textarea"));
}

function render(force = false) {
  if (!latest) return;
  if (!force && pageInteractionActive()) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  const route = currentRoute();
  const renderers = { overview: overviewPage, apps: appsPage, performance: performancePage, storage: storagePage, network: networkPage, services: servicesPage, docker: dockerPage, processes: processesPage, settings: settingsPage };
  $("#page").innerHTML = renderers[route](latest);
  updateSidebar(latest);
  bindPageControls();
  requestAnimationFrame(renderCharts);
}

function renderCharts() {
  if (!latest) return;
  const history = latest.history || {};
  const cpuHistory = historySeries(history.cpu);
  const memoryHistory = historySeries(history.memory);
  const temperatureHistory = historySeries(history.temperature);
  const gpuTemperatureHistory = historySeries(history.gpu_temperature);
  const gpuFanHistory = historySeries(history.gpu_fan);
  drawLine($("#overviewTrend"), [cpuHistory, memoryHistory, cpuHistory.map(() => Number(latest.cpu?.load?.[0] || 0) * 25)], ["#ff6a00", "#e6aa18", "#4c9d3b"], { maximum: 100 });
  drawLine($("#overviewTemperatureTrend"), [temperatureHistory, gpuTemperatureHistory], ["#ff6a00", "#e6aa18"], { maximum: 100 });
  drawLine($("#overviewFanTrend"), [gpuFanHistory], ["#4c9d3b"], { maximum: 100 });
  drawLine($("#performanceCpu"), [cpuHistory, memoryHistory], ["#ff6a00", "#e6aa18"], { maximum: 100 });
  drawLine($("#performanceTemp"), [temperatureHistory, gpuTemperatureHistory], ["#ff6a00", "#e6aa18"], { maximum: 100 });
  drawLine($("#networkTrend"), [historySeries(history.upload).map((value) => value * 8), historySeries(history.download).map((value) => value * 8)], ["#ff6a00", "#4c9d3b"]);
  $$(".app-spark").forEach((canvas) => drawLine(canvas, [cpuHistory], ["#ff6a00"], { grid: false, maximum: 100 }));
}

function bindPageControls() {
  $$("[data-settings-target]").forEach((control) => control.addEventListener("click", () => { settingsTab = control.dataset.settingsTarget; }));
  $$("[data-settings-tab]").forEach((button) => button.addEventListener("click", () => { settingsTab = button.dataset.settingsTab; settingsMessage = ""; render(true); }));
  $$("[data-process-sort]").forEach((button) => button.addEventListener("click", () => { processSort = button.dataset.processSort; render(true); }));
  $("#serviceSearch")?.addEventListener("input", (event) => {
    serviceQuery = event.currentTarget.value;
    const cursor = event.currentTarget.selectionStart;
    render(true);
    $("#serviceSearch")?.focus();
    $("#serviceSearch")?.setSelectionRange(cursor, cursor);
  });
  $("#serviceState")?.addEventListener("change", (event) => { serviceState = event.currentTarget.value; render(true); });
  $("#serviceSort")?.addEventListener("change", (event) => { serviceSort = event.currentTarget.value; render(true); });
  $$("[data-terminal-signal]").forEach((button) => button.addEventListener("click", async () => {
    const pid = Number(button.dataset.processPid);
    const signal = button.dataset.terminalSignal;
    const processName = button.dataset.processName || `PID ${pid}`;
    const message = signal === "SIGKILL"
      ? `Force-kill ${processName} (PID ${pid})? Unsaved work will be lost.`
      : `Terminate ${processName} (PID ${pid})?`;
    if (!window.confirm(message)) return;
    const command = `${signal === "SIGKILL" ? "sudo kill -KILL" : "sudo kill -TERM"} ${pid}`;
    const status = $("#processActionStatus");
    window.open(cockpitUrl("/system/terminal"), "_blank", "noopener,noreferrer");
    try {
      await navigator.clipboard.writeText(command);
      if (status) status.textContent = `Copied “${command}”. Paste it into the Cockpit terminal to manage ${processName}.`;
    } catch {
      if (status) status.textContent = `Run “${command}” in the Cockpit terminal to manage ${processName}.`;
    }
  }));
  $("#settingsForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    storageSet("frost-server-name", String(form.get("serverName") || "Frostserver"));
    storageSet("frost-refresh-interval", String(form.get("refreshInterval") || "1000"));
    storageSet("frost-history-window", String(form.get("historyWindow") || "120"));
    settingsMessage = "Dashboard behavior saved.";
    scheduleUpdate();
    render(true);
  });
  $("#displaySettingsForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    storageSet("frost-compact-density", String(form.has("compactDensity")));
    storageSet("frost-reduce-motion", String(form.has("reduceMotion")));
    storageSet("frost-hide-network", String(form.has("hideNetwork")));
    settingsMessage = "Display and privacy settings saved.";
    applyPreferences();
    render(true);
  });
  $("#refreshNow")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    await update();
    settingsMessage = "Collector snapshot refreshed.";
    render(true);
  });
  $("#downloadSnapshot")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(latest, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `frostserver-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
    settingsMessage = "Diagnostics JSON downloaded.";
    render(true);
  });
}

async function update() {
  try {
    const response = await fetch("/metrics.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    latest = await response.json();
    updateSidebar(latest);
    render();
  } catch {
    if (!latest) $("#page").innerHTML = '<div class="loading-panel">The local collector is unavailable. Check the local collector service and refresh this page.</div>';
    $("#healthCard").innerHTML = '<div class="health-title"><i class="status-dot bad"></i><strong>Collector Unavailable</strong></div><p>Check the local collector service.</p>';
  }
}

function scheduleUpdate() {
  window.clearTimeout(refreshTimer);
  const interval = Math.max(1000, Number(storageGet("frost-refresh-interval")) || 1000);
  refreshTimer = window.setTimeout(async () => {
    await update();
    scheduleUpdate();
  }, interval);
}

applyPreferences();
buildNavigation();
function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#menuButton").setAttribute("aria-expanded", "false");
}
$("#menuButton").addEventListener("click", () => {
  const open = $("#sidebar").classList.toggle("open");
  $("#menuButton").setAttribute("aria-expanded", String(open));
});
$("#sidebarBackdrop").addEventListener("click", closeSidebar);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSidebar();
});
$("#page").addEventListener("pointerdown", () => { interactionUntil = Date.now() + 1200; });
$("#page").addEventListener("focusout", () => window.setTimeout(() => {
  if (pendingRender && !pageInteractionActive()) render(true);
}, 0));
window.addEventListener("hashchange", () => { closeSidebar(); render(true); });
window.addEventListener("resize", () => requestAnimationFrame(renderCharts));
update().finally(scheduleUpdate);
