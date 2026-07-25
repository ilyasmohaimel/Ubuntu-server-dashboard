#!/usr/bin/env python3
"""Low-overhead, local-only metrics collector."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

RUNTIME_DIR = Path("/run/frost-dashboard")
METRICS_PATH = RUNTIME_DIR / "metrics.json"
INTERVAL_SECONDS = 1
HISTORY_SIZE = 120
WEB_INTERFACES = (
    ("cockpit", "Cockpit", "Server administration", "https://127.0.0.1:9090", "https", 9090, "Management"),
    ("uptime-kuma", "Uptime Kuma", "Service monitoring", "http://127.0.0.1:3001", "http", 3001, "Monitoring"),
    ("file-browser", "File Browser", "File management", "http://127.0.0.1:8081", "http", 8081, "Files"),
    ("freshrss", "FreshRSS", "Feed reader", "http://127.0.0.1:8082", "http", 8082, "News"),
    ("syncthing", "Syncthing", "File synchronization", "http://127.0.0.1:8384", "http", 8384, "Sync"),
)
SERVICES = (
    ("SSH", "ssh.service", 22),
    ("Docker", "docker.service", None),
    ("Hermes agent", "hermes-gateway.service", None),
    ("Tailscale", "tailscaled.service", None),
    ("Syncthing", "syncthing@user.service", 8384),
    ("Cockpit", "cockpit.socket", 9090),
    ("Samba", "smbd.service", 445),
)


def run(*args: str, timeout: int = 5) -> str:
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=timeout).strip()
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return ""


def first_line(path: Path) -> str:
    try:
        return path.read_text().strip().splitlines()[0]
    except (FileNotFoundError, PermissionError, IndexError):
        return ""


def as_gib(value: int | float) -> float:
    return round(value / 1024**3, 2)


def os_pretty_name() -> str:
    for line in Path("/etc/os-release").read_text().splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip('"')
    return "Ubuntu server"


class Collector:
    def __init__(self) -> None:
        self.previous_cpu: tuple[int, int] | None = None
        self.previous_cores: dict[str, tuple[int, int]] = {}
        self.previous_network: tuple[int, int, float] | None = None
        self.previous_disk: dict[str, tuple[int, int, float]] = {}
        self.cpu_history: deque[float] = deque(maxlen=HISTORY_SIZE)
        self.temp_history: deque[float | None] = deque(maxlen=HISTORY_SIZE)
        self.memory_history: deque[float] = deque(maxlen=HISTORY_SIZE)
        self.rx_history: deque[float] = deque(maxlen=HISTORY_SIZE)
        self.tx_history: deque[float] = deque(maxlen=HISTORY_SIZE)
        self.cached: dict[str, Any] = {"docker": [], "services": [], "web": []}
        self.last_slow_refresh = 0.0

    def cpu(self) -> dict[str, Any]:
        lines = Path("/proc/stat").read_text().splitlines()
        samples = [line.split() for line in lines if re.match(r"^cpu\d* ", line)]
        total_sample = samples[0]
        values = [int(value) for value in total_sample[1:]]
        total, idle = sum(values), values[3] + (values[4] if len(values) > 4 else 0)
        usage = 0.0
        if self.previous_cpu:
            delta_total, delta_idle = total - self.previous_cpu[0], idle - self.previous_cpu[1]
            usage = round(100 * (delta_total - delta_idle) / delta_total, 1) if delta_total else 0.0
        self.previous_cpu = (total, idle)
        cores: list[float] = []
        for sample in samples[1:]:
            name, numbers = sample[0], [int(value) for value in sample[1:]]
            core_total, core_idle = sum(numbers), numbers[3] + (numbers[4] if len(numbers) > 4 else 0)
            previous = self.previous_cores.get(name)
            core_usage = 0.0
            if previous and core_total > previous[0]:
                core_usage = round(100 * ((core_total - previous[0]) - (core_idle - previous[1])) / (core_total - previous[0]), 1)
            self.previous_cores[name] = (core_total, core_idle)
            cores.append(core_usage)
        temperature = self.temperatures()["cpu_package"]
        model = first_line(Path("/proc/cpuinfo"))
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                model = line.split(":", 1)[1].strip()
                break
        governor = first_line(Path("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")) or "Managed by intel_pstate"
        frequency = first_line(Path("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"))
        self.cpu_history.append(usage)
        self.temp_history.append(temperature)
        return {
            "model": model,
            "usage": usage,
            "cores": cores,
            "governor": governor,
            "frequency_mhz": round(int(frequency) / 1000) if frequency.isdigit() else None,
            "load": [round(float(value), 2) for value in os.getloadavg()],
            "temperature": temperature,
        }

    def memory(self) -> dict[str, Any]:
        info = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, value = line.split(":", 1)
            info[key] = int(value.strip().split()[0]) * 1024
        total, available = info["MemTotal"], info["MemAvailable"]
        used = total - available
        percent = round(100 * used / total, 1)
        self.memory_history.append(percent)
        return {
            "total": as_gib(total), "used": as_gib(used), "available": as_gib(available),
            "cached": as_gib(info.get("Cached", 0) + info.get("SReclaimable", 0)), "percent": percent,
            "swap_total": as_gib(info.get("SwapTotal", 0)), "swap_used": as_gib(info.get("SwapTotal", 0) - info.get("SwapFree", 0)),
        }

    def primary_interface(self) -> str:
        route = run("ip", "route", "get", "1.1.1.1")
        match = re.search(r"\bdev\s+(\S+)", route)
        return match.group(1) if match else "eno1"

    def network(self) -> dict[str, Any]:
        interface = self.primary_interface()
        base = Path("/sys/class/net") / interface / "statistics"
        rx, tx = int(first_line(base / "rx_bytes") or 0), int(first_line(base / "tx_bytes") or 0)
        now = time.monotonic()
        down_rate = up_rate = 0.0
        if self.previous_network:
            old_rx, old_tx, old_time = self.previous_network
            elapsed = now - old_time
            if elapsed:
                down_rate, up_rate = max(0, (rx - old_rx) / elapsed), max(0, (tx - old_tx) / elapsed)
        self.previous_network = (rx, tx, now)
        self.rx_history.append(round(down_rate / 1024**2, 3))
        self.tx_history.append(round(up_rate / 1024**2, 3))
        addresses = run("ip", "-br", "-4", "addr").splitlines()
        lan_ip = tailscale_ip = None
        for line in addresses:
            fields = line.split()
            if len(fields) > 2 and fields[0] == interface:
                lan_ip = fields[2].split("/")[0]
            if len(fields) > 2 and fields[0] == "tailscale0":
                tailscale_ip = fields[2].split("/")[0]
        speed = first_line(Path("/sys/class/net") / interface / "speed")
        return {"interface": interface, "lan_ip": lan_ip, "tailscale_ip": tailscale_ip, "download_mbps": round(down_rate * 8 / 1_000_000, 2), "upload_mbps": round(up_rate * 8 / 1_000_000, 2), "rx_total_gb": as_gib(rx), "tx_total_gb": as_gib(tx), "link_mbps": int(speed) if speed.lstrip("-").isdigit() else None}

    def temperatures(self) -> dict[str, Any]:
        result: dict[str, Any] = {"cpu_package": None, "cpu_cores": [], "gpu": None, "gpu_fan": None, "cpu_fan": None, "cpu_fan_status": "Firmware automatic — software control unavailable"}
        for hwmon in Path("/sys/class/hwmon").glob("hwmon*"):
            name = first_line(hwmon / "name")
            if name == "coretemp":
                for path in sorted(hwmon.glob("temp*_input")):
                    value = int(first_line(path) or 0) / 1000
                    label = first_line(path.with_name(path.name.replace("_input", "_label")))
                    if label == "Package id 0":
                        result["cpu_package"] = value
                    elif label.startswith("Core"):
                        result["cpu_cores"].append(value)
            elif name == "nouveau":
                result["gpu"] = int(first_line(hwmon / "temp1_input") or 0) / 1000 or None
                pwm = first_line(hwmon / "pwm1")
                maximum = first_line(hwmon / "pwm1_max")
                if pwm.isdigit() and maximum.isdigit() and int(maximum):
                    result["gpu_fan"] = round(100 * int(pwm) / int(maximum))
        return result

    def storage(self) -> list[dict[str, Any]]:
        mounts = []
        seen = set()
        for line in run("findmnt", "-rn", "-t", "ext4,xfs,btrfs", "-o", "TARGET").splitlines():
            mount = line.strip()
            if not mount or mount in seen:
                continue
            seen.add(mount)
            try:
                stat = os.statvfs(mount)
            except FileNotFoundError:
                continue
            total, available = stat.f_blocks * stat.f_frsize, stat.f_bavail * stat.f_frsize
            used = total - available
            label = "Root" if mount == "/" else Path(mount).name
            mounts.append({"mount": mount, "label": label, "total": as_gib(total), "used": as_gib(used), "free": as_gib(available), "percent": round(100 * used / total, 1), "health": "Available"})
        return mounts

    def gpu(self, temperatures: dict[str, Any]) -> dict[str, Any]:
        gpu_name = next((line.split(":", 2)[-1].strip() for line in run("lspci").splitlines() if re.search(r"VGA|3D|Display", line, re.I)), "GPU unavailable")
        return {"name": gpu_name, "driver": "nouveau", "temperature": temperatures["gpu"], "fan_percent": temperatures["gpu_fan"], "utilization": None, "vram": None, "status": "Limited telemetry with nouveau driver"}

    def processes(self) -> list[dict[str, Any]]:
        text = run("ps", "-eo", "pid=,user=,pcpu=,pmem=,etime=,comm=", "--sort=-pcpu", timeout=4)
        rows = []
        for line in text.splitlines()[:8]:
            parts = line.split(None, 5)
            if len(parts) == 6:
                rows.append({"pid": parts[0], "user": parts[1], "cpu": float(parts[2]), "memory": float(parts[3]), "runtime": parts[4], "command": parts[5][:64]})
        return rows

    def refresh_slow(self) -> None:
        services = []
        for friendly, unit, port in SERVICES:
            state = run("systemctl", "is-active", unit, timeout=3) or "unknown"
            services.append({"name": friendly, "unit": unit, "state": state, "port": port})
        docker_rows = []
        for line in run("docker", "ps", "--format", "{{json .}}", timeout=8).splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            docker_rows.append({"name": row.get("Names"), "image": row.get("Image"), "status": row.get("Status"), "ports": row.get("Ports")})
        stats = {}
        for line in run("docker", "stats", "--no-stream", "--format", "{{json .}}", timeout=12).splitlines():
            try:
                row = json.loads(line)
                stats[row.get("Name")] = {"cpu": row.get("CPUPerc"), "memory": row.get("MemUsage")}
            except json.JSONDecodeError:
                continue
        for row in docker_rows:
            row.update(stats.get(row["name"], {}))
        web = []
        for app_id, name, description, local_url, scheme, port, category in WEB_INTERFACES:
            flags = ["curl", "-ksS", "--max-time", "3", "-o", "/dev/null", "-w", "%{http_code} %{time_total}", local_url]
            response = run(*flags, timeout=5).split()
            status = response[0] if response else "unavailable"
            try:
                latency_ms = round(float(response[1]) * 1000) if len(response) > 1 else None
            except ValueError:
                latency_ms = None
            web.append({"id": app_id, "name": name, "description": description, "category": category, "scheme": scheme, "port": port, "healthy": status.startswith(("2", "3")), "status": status, "latency_ms": latency_ms, "source": "Local probe"})
        self.cached = {"docker": docker_rows, "services": services, "web": web}

    def snapshot(self) -> dict[str, Any]:
        cpu = self.cpu()
        memory = self.memory()
        network = self.network()
        temperatures = self.temperatures()
        now = time.monotonic()
        if now - self.last_slow_refresh > 15:
            self.refresh_slow()
            self.last_slow_refresh = now
        alerts = []
        if cpu["temperature"] and cpu["temperature"] >= 80:
            alerts.append({"level": "critical", "message": f"CPU package temperature is {cpu['temperature']:.0f}°C"})
        if memory["percent"] >= 90:
            alerts.append({"level": "warning", "message": f"Memory use is {memory['percent']}%"})
        for disk in self.storage():
            if disk["percent"] >= 90:
                alerts.append({"level": "warning", "message": f"{disk['label']} storage is {disk['percent']}% full"})
        failed_services = [service["name"] for service in self.cached["services"] if service["state"] not in ("active", "listening")]
        if failed_services:
            alerts.append({"level": "warning", "message": "Unavailable services: " + ", ".join(failed_services)})
        return {
            "generated_at": datetime.now(ZoneInfo("Africa/Casablanca")).isoformat(),
            "host": {"name": os.uname().nodename, "model": first_line(Path("/sys/class/dmi/id/product_name")) or "Unknown model", "os": os_pretty_name(), "kernel": os.uname().release, "uptime_seconds": float(first_line(Path("/proc/uptime")).split()[0])},
            "cpu": cpu, "memory": memory, "network": network, "storage": self.storage(), "temperatures": temperatures, "gpu": self.gpu(temperatures),
            "collector": {"interval_seconds": INTERVAL_SECONDS, "slow_refresh_seconds": 15},
            "services": self.cached["services"], "docker": self.cached["docker"], "web_interfaces": self.cached["web"], "processes": self.processes(), "alerts": alerts,
            "fan": {"profile": "Firmware automatic", "software_control": False, "next_switch": None, "reason": "No verified CPU PWM channel or fan RPM sensor is available."},
            "history": {"cpu": list(self.cpu_history), "temperature": list(self.temp_history), "memory": list(self.memory_history), "download": list(self.rx_history), "upload": list(self.tx_history)},
        }

    def write_snapshot(self) -> None:
        RUNTIME_DIR.mkdir(mode=0o755, parents=True, exist_ok=True)
        snapshot = self.snapshot()
        temporary = RUNTIME_DIR / "metrics.json.tmp"
        temporary.write_text(json.dumps(snapshot, separators=(",", ":")))
        temporary.chmod(0o644)
        temporary.replace(METRICS_PATH)


def main() -> None:
    collector = Collector()
    while True:
        started = time.monotonic()
        try:
            collector.write_snapshot()
        except Exception as error:  # Collector errors must not stop the last good snapshot.
            print(f"collector error: {error}", flush=True)
        time.sleep(max(0.05, INTERVAL_SECONDS - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
