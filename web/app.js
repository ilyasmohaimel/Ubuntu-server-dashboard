const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const APP_META = {
  cockpit: { category: "Management", icon: "terminal", iconUrl: "/assets/apps/cockpit.svg" },
  "uptime-kuma": { category: "Monitoring", icon: "pulse", iconUrl: "/assets/apps/uptime-kuma.svg" },
  "file-browser": { category: "Files", icon: "folder", iconUrl: "/assets/apps/filebrowser.svg" },
  freshrss: { category: "News", icon: "rss", iconUrl: "/assets/apps/freshrss.svg" },
  syncthing: { category: "Sync", icon: "sync", iconUrl: "/assets/apps/syncthing.svg" },
};
const DASHBOARD_APP = { id: "dashboard", name: "Frostserver Dashboard", description: "Live health, capacity, and system status.", category: "Management", icon: "grid", iconUrl: "/assets/apps/linux.svg", scheme: null, port: null, healthy: true, status: "local", latency_ms: null, source: "Static dashboard" };
let latest = null;
let selectedCategory = "All";
let appSearch = "";
const DETAIL_ROUTES = new Set(["performance", "storage", "network", "services", "docker", "processes", "settings"]);

const escapeHtml = (value) => String(value ?? "—").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
const fixed = (value, digits = 1) => value == null || Number.isNaN(Number(value)) ? "—" : Number(value).toFixed(digits);
const percent = (value) => value == null ? "—" : `${fixed(value)}%`;
const gib = (value) => value == null ? "—" : `${fixed(value)} GiB`;
const uptime = (seconds) => { const days = Math.floor((seconds || 0) / 86400); const hours = Math.floor(((seconds || 0) % 86400) / 3600); const minutes = Math.floor(((seconds || 0) % 3600) / 60); return `${days}d ${hours}h ${minutes}m`; };
const stateClass = (healthy) => healthy ? "healthy" : "down";
const validPort = (value) => Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 65535 ? Number(value) : null;
const appUrl = (app) => {
  if (app.id === "dashboard") return window.location.origin;
  const scheme = app.scheme === "https" ? "https:" : "http:";
  const port = validPort(app.port);
  const url = new URL(`${scheme}//${window.location.hostname}${port ? `:${port}` : ""}`);
  return ["http:", "https:"].includes(url.protocol) ? url.href : "#";
};
const appIcon = (app, className = "app-icon") => `<span class="${className}${app.iconUrl ? " brand-icon" : ""}">${app.iconUrl ? `<img src="${escapeHtml(app.iconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon(app.icon)}</span>`;
const metricMeter = (selector, value) => $(selector).style.width = `${Math.min(100, Math.max(0, Number(value) || 0))}%`;
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${({ grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z", terminal: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5", pulse: "M3 12h4l2-5 4 10 2-5h6", folder: "M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", rss: "M5 19a2 2 0 1 0 0 .01M4 11a9 9 0 0 1 9 9M4 5a15 15 0 0 1 15 15", sync: "M18 8l3 3-3 3M21 11H9a4 4 0 0 0-4 4v1M6 16l-3-3 3-3M3 13h12a4 4 0 0 0 4-4V8" })[name] || "M4 12h16M12 4v16"}"/></svg>`;

function lineChart(canvas, first, second, firstColor = "#5d97ff", secondColor = "#50c878") {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * ratio); canvas.height = Math.floor(rect.height * ratio);
  const ctx = canvas.getContext("2d"); ctx.scale(ratio, ratio); ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.strokeStyle = "#26313c"; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) { const y = rect.height * i / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke(); }
  const draw = (values, color, maximum) => { const points = (values || []).filter((point) => point != null); if (!points.length) return; ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.beginPath(); (values || []).forEach((point, index) => { if (point == null) return; const x = values.length === 1 ? 0 : rect.width * index / (values.length - 1); const y = rect.height - Math.min(1, Math.max(0, Number(point) / maximum)) * (rect.height - 4) - 2; if (index && values[index - 1] != null) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); };
  draw(first, firstColor, 100); if (second) draw(second, secondColor, 100);
}

function normalizedApps(data) {
  return [DASHBOARD_APP, ...(data.web_interfaces || []).map((app) => ({ ...app, ...(APP_META[app.id] || { category: "Other", icon: "grid" }) }))];
}

function renderHeader(data, apps) {
  const activeServices = (data.services || []).filter((service) => ["active", "listening"].includes(service.state)).length;
  const alerts = data.alerts || [];
  $("#topHostname").textContent = data.host.name || "Frostserver";
  $("#topOs").textContent = data.host.os || "Ubuntu server";
  $("#sidebarHost").innerHTML = `<strong>${escapeHtml(data.host.name)}</strong><span>${escapeHtml(data.host.model)}</span><span>${escapeHtml(data.host.os)}</span>`;
  $("#lastUpdated").textContent = new Date(data.generated_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Africa/Casablanca" });
  $("#connectionState").textContent = "Connected";
  $("#heroHostDetails").innerHTML = [[data.host.model, "Host platform"], [data.cpu.model, "Processor"], [data.host.os, "Operating system"], [data.gpu && data.gpu.name, "Graphics"]].filter(([value]) => value).map(([value, label]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  $("#heroAddress").textContent = data.network.lan_ip || "Unavailable";
  $("#healthTitle").textContent = alerts.some((alert) => alert.level === "critical") ? "Action needed" : alerts.length ? "Attention recommended" : "System healthy";
  $("#healthDetail").textContent = alerts.length ? `${alerts.length} active alert${alerts.length === 1 ? "" : "s"}` : "No active collector alerts";
  $("#uptimeValue").textContent = uptime(data.host.uptime_seconds);
  const hermes = (data.services || []).find((service) => service.unit === "hermes-gateway.service");
  $("#hermesSummary").textContent = hermes && ["active", "listening"].includes(hermes.state) ? "Online" : "Unavailable";
  $("#hermesSummary").className = hermes && ["active", "listening"].includes(hermes.state) ? "healthy-text" : "warning-text";
  $("#serviceSummary").textContent = `${activeServices}/${(data.services || []).length} services online`;
  $("#appSummary").textContent = "Gateway service";
  $("#refreshState").textContent = `Collector refresh: ${(data.collector && data.collector.interval_seconds) || 1}s`;
  $("#sidebarStatus").textContent = `Live · ${(data.collector && data.collector.interval_seconds) || 1}s refresh`;
  $("#appNav").innerHTML = apps.filter((app) => app.id !== "dashboard").map((app) => `<a class="side-app-link" href="${escapeHtml(appUrl(app))}" target="_blank" rel="noopener noreferrer">${appIcon(app, "side-app-icon")}<span>${escapeHtml(app.name)}</span><i class="app-nav-state ${stateClass(app.healthy)}" aria-label="${app.healthy ? "Healthy" : "Unavailable"}"></i></a>`).join("");
}

function renderOverview(data, apps) {
  const { cpu, memory, network, storage, temperatures, fan, history } = data;
  const primaryStorage = [...(storage || [])].sort((a, b) => b.percent - a.percent)[0] || {};
  $("#cpuModel").textContent = cpu.model || "CPU"; $("#cpuUsage").textContent = percent(cpu.usage); metricMeter("#cpuMeter", cpu.usage);
  $("#cpuDetails").innerHTML = [["Temperature", cpu.temperature == null ? "Unavailable" : `${fixed(cpu.temperature)}°C`], ["Frequency", cpu.frequency_mhz ? `${cpu.frequency_mhz} MHz` : "Managed"], ["Load", (cpu.load || []).map((value) => fixed(value, 2)).join(" · ") || "—"]].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  $("#memoryCaption").textContent = `${gib(memory.used)} of ${gib(memory.total)}`; $("#memoryPercent").textContent = percent(memory.percent); metricMeter("#memoryMeter", memory.percent);
  $("#memoryDetails").innerHTML = [["Available", gib(memory.available)], ["Cache", gib(memory.cached)], ["Swap", `${gib(memory.swap_used)} / ${gib(memory.swap_total)}`]].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("");
  $("#storagePercent").textContent = primaryStorage.percent == null ? "—" : percent(primaryStorage.percent); metricMeter("#storageMeter", primaryStorage.percent); $("#storageCaption").textContent = primaryStorage.mount ? `${primaryStorage.mount} is the fullest mount` : "Mounted filesystems";
  $("#storageDetails").innerHTML = (storage || []).slice(0, 3).map((disk) => `<div><dt>${escapeHtml(disk.mount)}</dt><dd>${percent(disk.percent)} · ${gib(disk.free)} free</dd></div>`).join("") || "<div><dt>Storage</dt><dd>Unavailable</dd></div>";
  $("#networkInterface").textContent = network.interface || "Network"; $("#downloadValue").textContent = `${fixed(network.download_mbps, 2)} Mbps`;
  $("#networkDetails").innerHTML = [["Upload", `${fixed(network.upload_mbps, 2)} Mbps`], ["Link", network.link_mbps ? `${network.link_mbps} Mbps` : "Unavailable"], ["Address", network.lan_ip || "Unavailable"]].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  $("#thermalMetrics").innerHTML = [["CPU package", cpu.temperature == null ? "Unavailable" : `${fixed(cpu.temperature)}°C`], ["GPU", temperatures.gpu == null ? "Unavailable" : `${fixed(temperatures.gpu)}°C`], ["GPU fan", temperatures.gpu_fan == null ? "Unavailable" : `${temperatures.gpu_fan}%`]].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#temperatureValue").textContent = cpu.temperature == null ? "—" : `${fixed(cpu.temperature)}°C`;
  $("#temperatureCaption").textContent = cpu.temperature == null ? "Sensor unavailable" : "CPU package";
  $("#temperatureDetails").innerHTML = [["GPU", temperatures.gpu == null ? "Unavailable" : `${fixed(temperatures.gpu)}°C`], ["GPU fan", temperatures.gpu_fan == null ? "Unavailable" : `${temperatures.gpu_fan}%`], ["Profile", temperatures.cpu_fan_status || "Automatic"]].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  $("#fanStatus").textContent = `CPU fan: ${temperatures.cpu_fan_status || "Unavailable"}. ${fan.reason || ""}`;
  $("#shortcutRows").innerHTML = apps.slice(0, 6).map((app) => `<a class="shortcut" href="${escapeHtml(appUrl(app))}" target="_blank" rel="noopener noreferrer">${appIcon(app)}<span>${escapeHtml(app.name)}</span></a>`).join("");
  const alerts = data.alerts || []; $("#alertCount").textContent = alerts.length ? `${alerts.length} active` : "None";
  $("#alerts").innerHTML = alerts.length ? alerts.map((alert) => `<div class="alert ${escapeHtml(alert.level)}"><span>${alert.level === "critical" ? "Critical" : "Warning"}</span><p>${escapeHtml(alert.message)}</p></div>`).join("") : "<div class=\"empty-state\">No active alerts. The collector has not detected a capacity or service issue.</div>";
  $("#serviceRows").innerHTML = (data.services || []).map((item) => `<div class="service"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.unit)}${item.port ? ` · ${item.port}` : ""}</span></div><span class="service-state ${stateClass(["active", "listening"].includes(item.state))}">${escapeHtml(item.state)}</span></div>`).join("");
  $("#processRows").innerHTML = (data.processes || []).map((item) => `<tr><td>${escapeHtml(item.command)}</td><td>${percent(item.cpu)}</td><td>${percent(item.memory)}</td><td>${escapeHtml(item.runtime)}</td></tr>`).join("");
  const docker = data.docker || [];
  $("#dockerCount").textContent = `${docker.length} running`;
  $("#dockerHostUptime").textContent = uptime(data.host.uptime_seconds);
  $("#dockerRows").innerHTML = docker.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td><span class="service-state ${stateClass(/^up/i.test(row.status || ""))}">${escapeHtml(row.status || "Unavailable")}</span></td><td>${escapeHtml(row.cpu || "—")}</td><td>${escapeHtml(row.memory || "—")}</td><td>${escapeHtml(row.ports || "—")}</td></tr>`).join("") || "<tr><td colspan=\"5\" class=\"empty-state\">No running containers detected.</td></tr>";
  lineChart($("#cpuChart"), history.cpu, history.temperature, "#ff7936", "#f6aa3a"); lineChart($("#networkChart"), (history.download || []).map((point) => point * 10), (history.upload || []).map((point) => point * 10), "#ff7936", "#f6aa3a"); lineChart($("#temperatureChart"), history.temperature, null, "#ff7936");
}

function renderApps(apps) {
  const categories = ["All", ...new Set(apps.map((app) => app.category))];
  $("#filterChips").innerHTML = categories.map((category) => `<button class="chip ${category === selectedCategory ? "active" : ""}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join("");
  $$(".chip").forEach((button) => button.addEventListener("click", () => { selectedCategory = button.dataset.category; renderApps(apps); }));
  const needle = appSearch.trim().toLowerCase();
  const shown = apps.filter((app) => (selectedCategory === "All" || app.category === selectedCategory) && (!needle || `${app.name} ${app.description} ${app.category}`.toLowerCase().includes(needle)));
  const healthy = apps.filter((app) => app.healthy).length; const down = apps.length - healthy;
  $("#appHealthSummary").innerHTML = `<div><strong>${healthy}</strong><span>healthy</span></div><div><strong>${down}</strong><span>unavailable</span></div><div><strong>${apps.length}</strong><span>installed</span></div>`;
  $("#appCards").innerHTML = shown.map((app) => `<article class="app-card"><div class="app-card-head">${appIcon(app)}<span class="app-state ${stateClass(app.healthy)}">${app.healthy ? "Healthy" : "Unavailable"}</span></div><div><span class="app-category">${escapeHtml(app.category)}</span><h2>${escapeHtml(app.name)}</h2><p>${escapeHtml(app.description)}</p></div><dl><div><dt>Connection</dt><dd>${app.id === "dashboard" ? "Current origin" : `${escapeHtml(app.scheme || "http").toUpperCase()} · port ${escapeHtml(app.port)}`}</dd></div><div><dt>Latency</dt><dd>${app.latency_ms == null ? "Local" : `${escapeHtml(app.latency_ms)} ms`}</dd></div></dl><a class="open-app" href="${escapeHtml(appUrl(app))}" target="_blank" rel="noopener noreferrer">Open app <span aria-hidden="true">↗</span></a></article>`).join("") || "<div class=\"empty-state\">No apps match this search.</div>";
  $("#appTableCount").textContent = `${shown.length} shown`;
  $("#appTableRows").innerHTML = shown.map((app) => `<tr><td>${appIcon(app, "table-app-icon")}${escapeHtml(app.name)}</td><td>${escapeHtml(app.category)}</td><td><span class="service-state ${stateClass(app.healthy)}">${app.healthy ? "Healthy" : "Unavailable"}</span></td><td>${app.port || "Current origin"}</td><td>${app.latency_ms == null ? "Local" : `${escapeHtml(app.latency_ms)} ms`}</td><td>${escapeHtml(app.source || "Local probe")}</td></tr>`).join("");
}

function detailHeading(eyebrow, title, description) {
  return `<div class="page-heading"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div><div class="collector-state">Live collector data</div></div>`;
}

function renderDetailView(data) {
  const route = (window.location.hash || "#overview").slice(1);
  if (!DETAIL_ROUTES.has(route)) return;
  const page = $("#detailPage");
  const serviceState = (state) => ["active", "listening"].includes(state);
  if (route === "performance") {
    page.innerHTML = `${detailHeading("System telemetry", "Performance", "Live CPU, memory, and load telemetry.")}<section class="metric-grid detail-metric-grid"><article class="metric-card"><div class="metric-label"><span>CPU usage</span><small>${escapeHtml(data.cpu.model)}</small></div><strong>${percent(data.cpu.usage)}</strong><span class="metric-unit">current utilization</span><div class="meter"><i style="width:${Math.min(100, Math.max(0, Number(data.cpu.usage) || 0))}%"></i></div></article><article class="metric-card"><div class="metric-label"><span>Memory usage</span><small>${gib(data.memory.used)} of ${gib(data.memory.total)}</small></div><strong>${percent(data.memory.percent)}</strong><span class="metric-unit">memory in use</span><div class="meter"><i style="width:${Math.min(100, Math.max(0, Number(data.memory.percent) || 0))}%"></i></div></article><article class="metric-card"><div class="metric-label"><span>Load average</span><small>1 · 5 · 15 minutes</small></div><strong>${(data.cpu.load || []).map((value) => fixed(value, 2)).join(" · ") || "—"}</strong><span class="metric-unit">system load</span></article></section><section class="panel detail-chart-panel"><div class="panel-heading"><div><p class="eyebrow">Trend</p><h2>CPU and temperature</h2></div><span class="muted">Last 120 samples</span></div><canvas class="detail-chart" id="detailPerformanceChart" aria-label="CPU and temperature trend"></canvas></section>`;
    lineChart($("#detailPerformanceChart"), data.history.cpu, data.history.temperature, "#ff7936", "#f6aa3a");
  } else if (route === "storage") {
    page.innerHTML = `${detailHeading("Capacity", "Storage", "Mounted filesystems and available capacity.")}<section class="panel"><div class="panel-heading"><div><p class="eyebrow">Volumes</p><h2>Mounted storage</h2></div><span class="muted">${(data.storage || []).length} filesystems</span></div><div class="table-wrap"><table><thead><tr><th>Mount</th><th>Usage</th><th>Used / total</th><th>Free</th></tr></thead><tbody>${(data.storage || []).map((disk) => `<tr><td>${escapeHtml(disk.mount)}</td><td><span class="storage-bar"><i style="width:${Math.min(100, Math.max(0, Number(disk.percent) || 0))}%"></i></span>${percent(disk.percent)}</td><td>${gib(disk.used)} / ${gib(disk.total)}</td><td>${gib(disk.free)}</td></tr>`).join("") || "<tr><td colspan=\"4\" class=\"empty-state\">No mounted storage found.</td></tr>"}</tbody></table></div></section>`;
  } else if (route === "network") {
    page.innerHTML = `${detailHeading("Connectivity", "Network", "Interface activity and current connection state.")}<section class="metric-grid detail-metric-grid"><article class="metric-card"><div class="metric-label"><span>Download</span><small>${escapeHtml(data.network.interface || "Interface")}</small></div><strong>${fixed(data.network.download_mbps, 2)} Mbps</strong><canvas id="detailDownloadChart" aria-label="Download trend"></canvas></article><article class="metric-card"><div class="metric-label"><span>Upload</span><small>Current transfer rate</small></div><strong>${fixed(data.network.upload_mbps, 2)} Mbps</strong><canvas id="detailUploadChart" aria-label="Upload trend"></canvas></article><article class="metric-card"><div class="metric-label"><span>Link</span><small>Physical connection</small></div><strong>${data.network.link_mbps ? `${data.network.link_mbps} Mbps` : "—"}</strong><span class="metric-unit">${escapeHtml(data.network.lan_ip || "No LAN address")}</span></article></section><section class="panel detail-chart-panel"><div class="panel-heading"><div><p class="eyebrow">Traffic</p><h2>Network activity</h2></div><span class="muted">Live history</span></div><canvas class="detail-chart" id="detailNetworkChart" aria-label="Network activity trend"></canvas></section>`;
    lineChart($("#detailDownloadChart"), (data.history.download || []).map((value) => value * 10), null, "#ff7936"); lineChart($("#detailUploadChart"), (data.history.upload || []).map((value) => value * 10), null, "#f6aa3a"); lineChart($("#detailNetworkChart"), (data.history.download || []).map((value) => value * 10), (data.history.upload || []).map((value) => value * 10), "#ff7936", "#f6aa3a");
  } else if (route === "services") {
    page.innerHTML = `${detailHeading("Systemd", "Services", "Read-only health of server services.")}<section class="panel"><div class="panel-heading"><div><p class="eyebrow">Service status</p><h2>Managed services</h2></div><span class="muted">${(data.services || []).filter((service) => serviceState(service.state)).length}/${(data.services || []).length} active</span></div><div class="table-wrap"><table><thead><tr><th>Service</th><th>Unit</th><th>Status</th><th>Port</th></tr></thead><tbody>${(data.services || []).map((service) => `<tr><td>${escapeHtml(service.name)}</td><td>${escapeHtml(service.unit)}</td><td><span class="service-state ${stateClass(serviceState(service.state))}">${escapeHtml(service.state)}</span></td><td>${service.port || "—"}</td></tr>`).join("")}</tbody></table></div></section>`;
  } else if (route === "docker") {
    const containers = data.docker || [];
    page.innerHTML = `${detailHeading("Runtime", "Docker containers", "Running containers, resource use, and status.")}<section class="runtime-summary"><div><strong>${containers.length}</strong><span>running</span></div><div><strong>${containers.filter((row) => /^up/i.test(row.status || "")).length}</strong><span>healthy</span></div><div><strong>${uptime(data.host.uptime_seconds)}</strong><span>host uptime</span></div></section><section class="panel"><div class="panel-heading"><div><p class="eyebrow">Containers</p><h2>Docker runtime</h2></div><span class="muted">Live snapshot</span></div><div class="table-wrap"><table><thead><tr><th>Container</th><th>Status</th><th>CPU</th><th>Memory</th><th>Ports</th></tr></thead><tbody>${containers.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td><span class="service-state ${stateClass(/^up/i.test(row.status || ""))}">${escapeHtml(row.status || "Unavailable")}</span></td><td>${escapeHtml(row.cpu || "—")}</td><td>${escapeHtml(row.memory || "—")}</td><td>${escapeHtml(row.ports || "—")}</td></tr>`).join("") || "<tr><td colspan=\"5\" class=\"empty-state\">No containers detected.</td></tr>"}</tbody></table></div></section>`;
  } else if (route === "processes") {
    page.innerHTML = `${detailHeading("Runtime", "Processes", "Top processes ranked by current CPU use.")}<section class="panel"><div class="panel-heading"><div><p class="eyebrow">Processes</p><h2>Top resource consumers</h2></div><span class="muted">Live snapshot</span></div><div class="table-wrap"><table><thead><tr><th>Process</th><th>CPU</th><th>Memory</th><th>Runtime</th></tr></thead><tbody>${(data.processes || []).map((process) => `<tr><td>${escapeHtml(process.command)}</td><td>${percent(process.cpu)}</td><td>${percent(process.memory)}</td><td>${escapeHtml(process.runtime)}</td></tr>`).join("")}</tbody></table></div></section>`;
  } else {
    page.innerHTML = `${detailHeading("Dashboard", "Settings", "Read-only configuration and security posture.")}<section class="settings-grid"><article class="panel"><div class="panel-heading"><div><p class="eyebrow">Display</p><h2>Dashboard defaults</h2></div></div><dl class="settings-list"><div><dt>Landing page</dt><dd>Overview</dd></div><div><dt>Refresh interval</dt><dd>${(data.collector && data.collector.interval_seconds) || 1} second</dd></div><div><dt>Motion</dt><dd>Respects system preference</dd></div></dl></article><article class="panel"><div class="panel-heading"><div><p class="eyebrow">Security</p><h2>Local access</h2></div></div><dl class="settings-list"><div><dt>Collector</dt><dd>Root-only local snapshot</dd></div><div><dt>Web server</dt><dd>Read-only static files</dd></div><div><dt>App links</dt><dd>HTTP(S) only</dd></div></dl></article></section>`;
  }
}

function setRoute() {
  const route = (window.location.hash || "#overview").slice(1);
  const appView = route === "apps";
  const detailView = DETAIL_ROUTES.has(route);
  $("#appsView").classList.toggle("is-hidden", !appView); $("#overviewView").classList.toggle("is-hidden", appView || detailView); $("#detailView").classList.toggle("is-hidden", !detailView);
  $$("[data-nav]").forEach((link) => link.classList.toggle("active", link.dataset.nav === (appView ? "apps" : detailView ? route : "overview")));
  $("#sidebar").classList.remove("open"); $("#menuButton").setAttribute("aria-expanded", "false");
  if (detailView && latest) renderDetailView(latest);
}

function setupControls() {
  $("#menuButton").addEventListener("click", () => { const open = $("#sidebar").classList.toggle("open"); $("#menuButton").setAttribute("aria-expanded", String(open)); });
  $("#appSearch").addEventListener("input", (event) => { appSearch = event.target.value; if (latest) renderApps(normalizedApps(latest)); });
  const closePalette = () => { $("#commandPalette").classList.add("is-hidden"); $("#paletteBackdrop").classList.add("is-hidden"); };
  const openPalette = () => { $("#paletteActions").innerHTML = [["Overview", "#overview"], ["Apps Hub", "#apps"], ["Performance", "#performance"], ["Storage", "#storage"], ["Network", "#network"], ["Services", "#services"], ["Docker", "#docker"], ["Processes", "#processes"], ["Settings", "#settings"]].map(([label, href]) => `<a href="${href}">${label}</a>`).join(""); $("#commandPalette").classList.remove("is-hidden"); $("#paletteBackdrop").classList.remove("is-hidden"); };
  $("#commandButton").addEventListener("click", openPalette); $("#paletteBackdrop").addEventListener("click", closePalette);
  window.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openPalette(); } if (event.key === "Escape") closePalette(); });
  window.addEventListener("hashchange", setRoute); window.addEventListener("resize", () => latest && renderOverview(latest, normalizedApps(latest)));
}

async function update() {
  try { const response = await fetch("/metrics.json", { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP ${response.status}`); latest = await response.json(); const apps = normalizedApps(latest); renderHeader(latest, apps); renderOverview(latest, apps); renderApps(apps); renderDetailView(latest); setRoute(); } catch { $("#connectionState").textContent = "Collector unavailable"; $("#connectionDot").classList.add("down-dot"); $("#refreshState").textContent = "Unable to load live metrics"; }
}

setupControls(); update(); setInterval(update, 1000);
