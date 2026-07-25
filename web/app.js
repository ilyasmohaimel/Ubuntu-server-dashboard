const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const APP_META = {
  cockpit: { category: "Management", icon: "terminal" },
  "uptime-kuma": { category: "Monitoring", icon: "pulse" },
  "file-browser": { category: "Files", icon: "folder" },
  freshrss: { category: "News", icon: "rss" },
  syncthing: { category: "Sync", icon: "sync" },
};
const DASHBOARD_APP = { id: "dashboard", name: "Frostserver Dashboard", description: "Live health, capacity, and system status.", category: "Management", icon: "grid", scheme: null, port: null, healthy: true, status: "local", latency_ms: null, source: "Static dashboard" };
let latest = null;
let selectedCategory = "All";
let appSearch = "";

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
  $("#healthTitle").textContent = alerts.some((alert) => alert.level === "critical") ? "Action needed" : alerts.length ? "Attention recommended" : "System healthy";
  $("#healthDetail").textContent = alerts.length ? `${alerts.length} active alert${alerts.length === 1 ? "" : "s"}` : "No active collector alerts";
  $("#uptimeValue").textContent = uptime(data.host.uptime_seconds);
  $("#serviceSummary").textContent = `${activeServices}/${(data.services || []).length} online`;
  $("#appSummary").textContent = `${apps.filter((app) => app.healthy).length}/${apps.length} ready`;
  $("#alertSummary").textContent = alerts.length ? `${alerts.length} active` : "None";
  $("#alertSummary").className = alerts.length ? "warning-text" : "healthy-text";
  $("#refreshState").textContent = `Collector refresh: ${(data.collector && data.collector.interval_seconds) || 1}s`;
  $("#sidebarStatus").textContent = `Live · ${(data.collector && data.collector.interval_seconds) || 1}s refresh`;
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
  $("#fanStatus").textContent = `CPU fan: ${temperatures.cpu_fan_status || "Unavailable"}. ${fan.reason || ""}`;
  $("#shortcutRows").innerHTML = apps.slice(0, 6).map((app) => `<a class="shortcut" href="${escapeHtml(appUrl(app))}" target="_blank" rel="noopener noreferrer"><span class="app-icon">${icon(app.icon)}</span><span>${escapeHtml(app.name)}</span></a>`).join("");
  const alerts = data.alerts || []; $("#alertCount").textContent = alerts.length ? `${alerts.length} active` : "None";
  $("#alerts").innerHTML = alerts.length ? alerts.map((alert) => `<div class="alert ${escapeHtml(alert.level)}"><span>${alert.level === "critical" ? "Critical" : "Warning"}</span><p>${escapeHtml(alert.message)}</p></div>`).join("") : "<div class=\"empty-state\">No active alerts. The collector has not detected a capacity or service issue.</div>";
  $("#serviceRows").innerHTML = (data.services || []).map((item) => `<div class="service"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.unit)}${item.port ? ` · ${item.port}` : ""}</span></div><span class="service-state ${stateClass(["active", "listening"].includes(item.state))}">${escapeHtml(item.state)}</span></div>`).join("");
  $("#processRows").innerHTML = (data.processes || []).map((item) => `<tr><td>${escapeHtml(item.command)}</td><td>${percent(item.cpu)}</td><td>${percent(item.memory)}</td><td>${escapeHtml(item.runtime)}</td></tr>`).join("");
  lineChart($("#cpuChart"), history.cpu, history.temperature); lineChart($("#networkChart"), (history.download || []).map((point) => point * 10), (history.upload || []).map((point) => point * 10), "#50c878", "#5d97ff");
}

function renderApps(apps) {
  const categories = ["All", ...new Set(apps.map((app) => app.category))];
  $("#filterChips").innerHTML = categories.map((category) => `<button class="chip ${category === selectedCategory ? "active" : ""}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join("");
  $$(".chip").forEach((button) => button.addEventListener("click", () => { selectedCategory = button.dataset.category; renderApps(apps); }));
  const needle = appSearch.trim().toLowerCase();
  const shown = apps.filter((app) => (selectedCategory === "All" || app.category === selectedCategory) && (!needle || `${app.name} ${app.description} ${app.category}`.toLowerCase().includes(needle)));
  const healthy = apps.filter((app) => app.healthy).length; const down = apps.length - healthy;
  $("#appHealthSummary").innerHTML = `<div><strong>${healthy}</strong><span>healthy</span></div><div><strong>${down}</strong><span>unavailable</span></div><div><strong>${apps.length}</strong><span>installed</span></div>`;
  $("#appCards").innerHTML = shown.map((app) => `<article class="app-card"><div class="app-card-head"><span class="app-icon">${icon(app.icon)}</span><span class="app-state ${stateClass(app.healthy)}">${app.healthy ? "Healthy" : "Unavailable"}</span></div><div><span class="app-category">${escapeHtml(app.category)}</span><h2>${escapeHtml(app.name)}</h2><p>${escapeHtml(app.description)}</p></div><dl><div><dt>Connection</dt><dd>${app.id === "dashboard" ? "Current origin" : `${escapeHtml(app.scheme || "http").toUpperCase()} · port ${escapeHtml(app.port)}`}</dd></div><div><dt>Latency</dt><dd>${app.latency_ms == null ? "Local" : `${escapeHtml(app.latency_ms)} ms`}</dd></div></dl><a class="open-app" href="${escapeHtml(appUrl(app))}" target="_blank" rel="noopener noreferrer">Open app <span aria-hidden="true">↗</span></a></article>`).join("") || "<div class=\"empty-state\">No apps match this search.</div>";
  $("#appTableCount").textContent = `${shown.length} shown`;
  $("#appTableRows").innerHTML = shown.map((app) => `<tr><td><span class="table-app-icon">${icon(app.icon)}</span>${escapeHtml(app.name)}</td><td>${escapeHtml(app.category)}</td><td><span class="service-state ${stateClass(app.healthy)}">${app.healthy ? "Healthy" : "Unavailable"}</span></td><td>${app.port || "Current origin"}</td><td>${app.latency_ms == null ? "Local" : `${escapeHtml(app.latency_ms)} ms`}</td><td>${escapeHtml(app.source || "Local probe")}</td></tr>`).join("");
}

function setRoute() {
  const route = (window.location.hash || "#overview").slice(1);
  const appView = route === "apps";
  $("#appsView").classList.toggle("is-hidden", !appView); $("#overviewView").classList.toggle("is-hidden", appView);
  $$("[data-nav]").forEach((link) => link.classList.toggle("active", link.dataset.nav === (appView ? "apps" : route === "overview" ? "overview" : route)));
  $("#sidebar").classList.remove("open"); $("#menuButton").setAttribute("aria-expanded", "false");
  if (!appView && route !== "overview") requestAnimationFrame(() => document.getElementById(route)?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function setupControls() {
  $("#menuButton").addEventListener("click", () => { const open = $("#sidebar").classList.toggle("open"); $("#menuButton").setAttribute("aria-expanded", String(open)); });
  $("#appSearch").addEventListener("input", (event) => { appSearch = event.target.value; if (latest) renderApps(normalizedApps(latest)); });
  const closePalette = () => { $("#commandPalette").classList.add("is-hidden"); $("#paletteBackdrop").classList.add("is-hidden"); };
  const openPalette = () => { $("#paletteActions").innerHTML = [["Apps Hub", "#apps"], ["Overview", "#overview"], ["Performance", "#performance"], ["Storage", "#storage"], ["Network", "#network"], ["Services", "#services"], ["Processes", "#processes"]].map(([label, href]) => `<a href="${href}">${label}</a>`).join(""); $("#commandPalette").classList.remove("is-hidden"); $("#paletteBackdrop").classList.remove("is-hidden"); };
  $("#commandButton").addEventListener("click", openPalette); $("#paletteBackdrop").addEventListener("click", closePalette);
  window.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openPalette(); } if (event.key === "Escape") closePalette(); });
  window.addEventListener("hashchange", setRoute); window.addEventListener("resize", () => latest && renderOverview(latest, normalizedApps(latest)));
}

async function update() {
  try { const response = await fetch("/metrics.json", { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP ${response.status}`); latest = await response.json(); const apps = normalizedApps(latest); renderHeader(latest, apps); renderOverview(latest, apps); renderApps(apps); setRoute(); } catch { $("#connectionState").textContent = "Collector unavailable"; $("#connectionDot").classList.add("down-dot"); $("#refreshState").textContent = "Unable to load live metrics"; }
}

setupControls(); update(); setInterval(update, 1000);
