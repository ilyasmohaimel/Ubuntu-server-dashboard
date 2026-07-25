const $ = (selector) => document.querySelector(selector);
const number = (value, digits = 1) => value == null ? "Unavailable" : `${Number(value).toFixed(digits)}`;
const gib = (value) => value == null ? "Unavailable" : `${number(value)} GiB`;
const percent = (value) => value == null ? "—" : `${number(value)}%`;
const safe = (value) => String(value ?? "—").replace(/[&<>\"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[char]));
const uptime = (seconds) => { const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60); return `${days}d ${hours}h ${minutes}m`; };

function lineChart(canvas, values, color, secondary = null) {
  const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio)); canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext("2d"); ctx.scale(ratio, ratio); const width = rect.width, height = rect.height;
  ctx.clearRect(0, 0, width, height); ctx.strokeStyle = "#263340"; ctx.lineWidth = 1;
  for (let row = 1; row < 4; row += 1) { const y = (height / 4) * row; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  const draw = (points, stroke, max) => { const usable = points.filter((point) => point != null); if (!usable.length) return; ctx.strokeStyle = stroke; ctx.lineWidth = 1.8; ctx.beginPath(); points.forEach((point, index) => { if (point == null) return; const x = points.length === 1 ? width : (index / (points.length - 1)) * width; const y = height - Math.min(1, Math.max(0, point / max)) * (height - 5) - 2; index && points[index - 1] != null ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); };
  draw(values, color, 100); if (secondary) draw(secondary, "#66c45b", 100);
}

function render(data) {
  const { host, cpu, memory, network, storage, temperatures, gpu, docker, services, web_interfaces: web, processes, alerts, fan, history } = data;
  $("#localTime").textContent = new Date(data.generated_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "Africa/Casablanca" });
  $("#connectionState").innerHTML = "<i></i>System healthy"; $("#refreshState").textContent = "Live · 1 second refresh";
  $("#sidebarHost").innerHTML = `<strong>${safe(host.name)}</strong><br>${safe(host.model)}<br>${safe(cpu.model)}<br>Ubuntu 26.04 LTS`;
  $("#hostDetails").innerHTML = [["Hostname",host.name],["Platform",host.model],["CPU",cpu.model],["Cores",`${cpu.cores.length} physical cores`],["GPU",gpu.name],["Kernel",host.kernel],["Uptime",uptime(host.uptime_seconds)],["Fan profile",fan.profile]].map(([key,value]) => `<div><dt>${safe(key)}</dt><dd>${safe(value)}</dd></div>`).join("");
  $("#cpuModel").textContent = cpu.model; $("#cpuTemperature").textContent = cpu.temperature == null ? "Unavailable" : `${number(cpu.temperature)}°C`;
  $("#coreUsage").innerHTML = cpu.cores.map((value,index) => `<div class="core"><strong>Core ${index + 1}</strong><span>${percent(value)}</span></div>`).join("");
  $("#memoryPercent").textContent = percent(memory.percent); $("#memoryUsed").textContent = gib(memory.used); $("#memoryDonut").style.setProperty("--pct", `${memory.percent}%`);
  $("#memoryDetails").innerHTML = [["Total",gib(memory.total)],["Used",gib(memory.used)],["Available",gib(memory.available)],["Cache",gib(memory.cached)],["Swap",`${gib(memory.swap_used)} / ${gib(memory.swap_total)}`]].map(([key,value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`).join("");
  $("#networkInterface").textContent = network.interface; $("#networkDetails").innerHTML = [["Download",`${number(network.download_mbps,2)} Mbps`],["Upload",`${number(network.upload_mbps,2)} Mbps`],["LAN IP",network.lan_ip],["Tailscale",network.tailscale_ip || "Unavailable"],["Link",network.link_mbps ? `${network.link_mbps} Mbps` : "Unavailable"]].map(([key,value]) => `<div><dt>${key}</dt><dd>${safe(value)}</dd></div>`).join("");
  $("#storageRows").innerHTML = storage.map((disk) => `<tr><td>${safe(disk.mount)}</td><td>${safe(disk.label)}</td><td>${gib(disk.used)} <span class="bar"><i style="width:${disk.percent}%"></i></span>${percent(disk.percent)}</td><td>${gib(disk.free)}</td><td><span class="health">${safe(disk.health)}</span></td></tr>`).join("");
  $("#dockerCount").textContent = `${docker.length} containers`; $("#dockerRows").innerHTML = docker.map((row) => `<tr><td>${safe(row.name)}</td><td><span class="health">${safe(row.status)}</span></td><td>${safe(row.cpu || "—")}</td><td>${safe(row.memory || "—")}</td><td>${safe(row.ports || "—")}</td></tr>`).join("");
  $("#thermalMetrics").innerHTML = [["CPU package",cpu.temperature == null ? "Unavailable" : `${number(cpu.temperature)}°C`],["GPU",temperatures.gpu == null ? "Unavailable" : `${number(temperatures.gpu)}°C`],["GPU fan",temperatures.gpu_fan == null ? "Unavailable" : `${temperatures.gpu_fan}%`]].map(([label,value]) => `<div class="thermal-metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#fanStatus").textContent = `CPU fan: ${temperatures.cpu_fan_status}. ${fan.reason}`;
  $("#interfaceRows").innerHTML = web.map((item) => `<a class="interface" href="${safe(item.url)}" target="_blank" rel="noopener"><div><h3>${safe(item.name)}</h3><p>${safe(item.description)} · port ${item.port}</p></div><span class="state ${item.healthy ? "" : "down"}">${item.healthy ? "Healthy" : "Unavailable"}</span></a>`).join("");
  $("#serviceRows").innerHTML = services.map((item) => `<div class="service"><div><span>${safe(item.name)}</span><small> ${safe(item.unit)}${item.port ? ` · ${item.port}` : ""}</small></div><span class="state ${item.state === "active" || item.state === "listening" ? "" : "failed"}">${safe(item.state)}</span></div>`).join("");
  $("#processRows").innerHTML = processes.map((item) => `<tr><td>${safe(item.command)}</td><td>${safe(item.pid)}</td><td>${safe(item.user)}</td><td>${percent(item.cpu)}</td><td>${percent(item.memory)}</td><td>${safe(item.runtime)}</td></tr>`).join("");
  $("#alerts").innerHTML = alerts.length ? alerts.map((alert) => `<div class="alert ${alert.level}">${safe(alert.message)}</div>`).join("") : "";
  lineChart($("#cpuChart"), history.cpu, "#3d83f7", history.temperature); lineChart($("#memoryChart"), history.memory, "#3d83f7"); lineChart($("#downloadChart"), history.download.map((x) => x * 10), "#66c45b"); lineChart($("#uploadChart"), history.upload.map((x) => x * 10), "#3d83f7");
}

async function update() {
  try { const response = await fetch("/metrics.json", { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP ${response.status}`); render(await response.json()); } catch (error) { $("#connectionState").innerHTML = "<i style=\"background:#ea5b67\"></i>Collector unavailable"; $("#refreshState").textContent = "Unable to load live metrics"; }
}

$("#menuButton").addEventListener("click", () => { const sidebar = $(".sidebar"); sidebar.classList.toggle("open"); $("#menuButton").setAttribute("aria-expanded", sidebar.classList.contains("open")); });
window.addEventListener("resize", () => update()); update(); setInterval(update, 1000);
