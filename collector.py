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
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

RUNTIME_DIR = Path("/run/frost-dashboard")
METRICS_PATH = RUNTIME_DIR / "metrics.json"
INTERVAL_SECONDS = 1
HISTORY_SIZE = 120
PROCESS_REFRESH_SECONDS = 4
CONNECTION_REFRESH_SECONDS = 5
DOCKER_REFRESH_SECONDS = 15
SERVICE_REFRESH_SECONDS = 30
NETWORK_METADATA_REFRESH_SECONDS = 30
APP_PROBE_REFRESH_SECONDS = 45
STORAGE_METADATA_REFRESH_SECONDS = 300
SMART_REFRESH_SECONDS = 600
WEB_INTERFACES = (
    ("cockpit", "Cockpit", "Server administration", "https://127.0.0.1:9090", "https", 9090, "Management"),
    ("uptime-kuma", "Uptime Kuma", "Service monitoring", "http://127.0.0.1:3001", "http", 3001, "Monitoring"),
    ("file-browser", "File Browser", "File management", "http://127.0.0.1:8081", "http", 8081, "Files"),
    ("freshrss", "FreshRSS", "Feed reader", "http://127.0.0.1:8082", "http", 8082, "News"),
    ("syncthing", "Syncthing", "File synchronization", "http://127.0.0.1:8384", "http", 8384, "Sync"),
    ("qbittorrent", "qBittorrent", "Torrent downloads", "http://127.0.0.1:8080", "http", 8080, "Downloads"),
    ("ariang", "Direct Downloads", "HTTP and HTTPS downloads", "http://127.0.0.1:8083", "http", 8083, "Downloads"),
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
PSEUDO_FILESYSTEMS = {
    "autofs", "binfmt_misc", "bpf", "cgroup", "cgroup2", "configfs", "debugfs",
    "devpts", "devtmpfs", "efivarfs", "fusectl", "hugetlbfs", "mqueue", "nsfs",
    "overlay", "proc", "pstore", "ramfs", "rpc_pipefs", "securityfs", "sysfs",
    "tmpfs", "tracefs",
}


def run(*args: str, timeout: int = 5) -> str:
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=timeout).strip()
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return ""


def run_allow_error(*args: str, timeout: int = 5) -> str:
    try:
        completed = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        return completed.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""


def first_line(path: Path) -> str:
    try:
        return path.read_text().strip().splitlines()[0]
    except (OSError, IndexError):
        return ""


def as_gib(value: int | float) -> float:
    return round(value / 1024**3, 2)


def os_pretty_name() -> str:
    for line in Path("/etc/os-release").read_text().splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip('"')
    return "Ubuntu server"


def parse_blocks(text: str) -> list[dict[str, str]]:
    blocks = []
    for raw_block in re.split(r"\n\s*\n", text.strip()):
        values = {}
        for line in raw_block.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                values[key] = value
        if values:
            blocks.append(values)
    return blocks


def parse_bytes(value: str | None) -> int | None:
    if not value or not value.isdigit():
        return None
    return int(value)


def parse_percent(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return float(value.rstrip("%"))
    except ValueError:
        return None


def parse_size(value: str | None) -> int | None:
    if not value:
        return None
    match = re.match(r"^\s*([\d.]+)\s*([KMGT]?i?B)\s*$", value, re.I)
    if not match:
        return None
    number, unit = float(match.group(1)), match.group(2).upper()
    multipliers = {
        "B": 1,
        "KB": 1000,
        "MB": 1000**2,
        "GB": 1000**3,
        "TB": 1000**4,
        "KIB": 1024,
        "MIB": 1024**2,
        "GIB": 1024**3,
        "TIB": 1024**4,
    }
    return round(number * multipliers[unit])


def format_duration(seconds: int | float | None) -> str | None:
    if seconds is None:
        return None
    total = max(0, round(seconds))
    days, remainder = divmod(total, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, remaining_seconds = divmod(remainder, 60)
    if days:
        return f"{days}d {hours}h {minutes}m"
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m {remaining_seconds}s"
    return f"{remaining_seconds}s"


def flatten_findmnt(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flattened = []
    pending = list(reversed(rows))
    while pending:
        row = pending.pop()
        children = row.get("children") or []
        flattened.append({key: value for key, value in row.items() if key != "children"})
        pending.extend(reversed(children))
    return flattened


class Collector:
    def __init__(self) -> None:
        self.previous_cpu: tuple[int, int] | None = None
        self.previous_cores: dict[str, tuple[int, int]] = {}
        self.previous_network: tuple[int, int, float] | None = None
        self.previous_interfaces: dict[str, tuple[int, int, float]] = {}
        self.previous_disk: dict[str, tuple[int, int, float]] = {}
        self.previous_service_cpu: dict[str, int] = {}
        self.previous_service_sample_at: float | None = None
        self.cpu_history: deque[float] = deque(maxlen=HISTORY_SIZE)
        self.temp_history: deque[float | None] = deque(maxlen=HISTORY_SIZE)
        self.gpu_temp_history: deque[float | None] = deque(maxlen=HISTORY_SIZE)
        self.gpu_fan_history: deque[float | None] = deque(maxlen=HISTORY_SIZE)
        self.memory_history: deque[float] = deque(maxlen=HISTORY_SIZE)
        self.rx_history: deque[float] = deque(maxlen=HISTORY_SIZE)
        self.tx_history: deque[float] = deque(maxlen=HISTORY_SIZE)
        self.cached: dict[str, Any] = {
            "connections": {},
            "docker": [],
            "docker_summary": {},
            "gpu_metadata": {},
            "network_metadata": {},
            "processes": [],
            "services": [],
            "storage_metadata": [],
            "storage_devices": [],
            "web": [],
        }
        self.last_refresh = {
            "apps": float("-inf"),
            "connections": float("-inf"),
            "docker": float("-inf"),
            "gpu_metadata": float("-inf"),
            "network_metadata": float("-inf"),
            "processes": float("-inf"),
            "services": float("-inf"),
            "smart": float("-inf"),
            "storage_metadata": float("-inf"),
        }
        self.network_peaks = {"download_mbps": 0.0, "upload_mbps": 0.0}

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
        return self.cached["network_metadata"].get("primary_interface") or "eno1"

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
        metadata = self.cached["network_metadata"]
        lan_ip = metadata.get("lan_ip")
        tailscale_ip = metadata.get("tailscale_ip")
        speed = first_line(Path("/sys/class/net") / interface / "speed")
        download_mbps = round(down_rate * 8 / 1_000_000, 2)
        upload_mbps = round(up_rate * 8 / 1_000_000, 2)
        self.network_peaks["download_mbps"] = max(self.network_peaks["download_mbps"], download_mbps)
        self.network_peaks["upload_mbps"] = max(self.network_peaks["upload_mbps"], upload_mbps)
        return {
            "interface": interface,
            "lan_ip": lan_ip,
            "tailscale_ip": tailscale_ip,
            "gateway": metadata.get("gateway"),
            "dns": metadata.get("dns", []),
            "download_mbps": download_mbps,
            "upload_mbps": upload_mbps,
            "peak_download_mbps": self.network_peaks["download_mbps"],
            "peak_upload_mbps": self.network_peaks["upload_mbps"],
            "rx_total_gb": as_gib(rx),
            "tx_total_gb": as_gib(tx),
            "link_mbps": int(speed) if speed.lstrip("-").isdigit() else None,
            "interfaces": self.interface_metrics(),
            "connections": self.cached["connections"],
            "internet_health": "Route configured" if metadata.get("gateway") else "Unavailable",
            "dns_health": "Configured" if metadata.get("dns") else "Unavailable",
            "tailscale_health": metadata.get("tailscale_health", "Unavailable"),
        }

    def refresh_network_metadata(self) -> None:
        route = run("ip", "-j", "route", "show", "default")
        addresses = run("ip", "-j", "-4", "addr", "show")
        try:
            route_rows = json.loads(route or "[]")
        except json.JSONDecodeError:
            route_rows = []
        try:
            address_rows = json.loads(addresses or "[]")
        except json.JSONDecodeError:
            address_rows = []
        default = route_rows[0] if route_rows else {}
        primary = default.get("dev")
        address_map = {}
        state_map = {}
        for row in address_rows:
            name = row.get("ifname")
            if not name:
                continue
            state_map[name] = row.get("operstate", "UNKNOWN").lower()
            address_map[name] = [
                item.get("local") for item in row.get("addr_info", [])
                if item.get("family") == "inet" and item.get("local")
            ]
        dns = []
        try:
            for line in Path("/etc/resolv.conf").read_text().splitlines():
                fields = line.split()
                if len(fields) == 2 and fields[0] == "nameserver":
                    dns.append(fields[1])
        except (FileNotFoundError, PermissionError):
            pass
        if not dns or all(address.startswith("127.") for address in dns):
            resolved = re.findall(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", run("resolvectl", "dns", timeout=3))
            dns = [address for address in resolved if not address.startswith("127.")] or dns
        tailscale_addresses = address_map.get("tailscale0", [])
        self.cached["network_metadata"] = {
            "primary_interface": primary,
            "gateway": default.get("gateway"),
            "lan_ip": (address_map.get(primary) or [None])[0] if primary else None,
            "tailscale_ip": tailscale_addresses[0] if tailscale_addresses else None,
            "dns": dns[:3],
            "states": state_map,
            "addresses": address_map,
            "tailscale_health": "Connected" if tailscale_addresses and state_map.get("tailscale0") == "up" else "Unavailable",
        }

    def interface_metrics(self) -> list[dict[str, Any]]:
        now = time.monotonic()
        metadata = self.cached["network_metadata"]
        rows = []
        for net_path in sorted(Path("/sys/class/net").glob("*")):
            name = net_path.name
            stats = net_path / "statistics"
            rx = int(first_line(stats / "rx_bytes") or 0)
            tx = int(first_line(stats / "tx_bytes") or 0)
            previous = self.previous_interfaces.get(name)
            down_rate = up_rate = 0.0
            if previous and now > previous[2]:
                elapsed = now - previous[2]
                down_rate = max(0, (rx - previous[0]) / elapsed)
                up_rate = max(0, (tx - previous[1]) / elapsed)
            self.previous_interfaces[name] = (rx, tx, now)
            speed = first_line(net_path / "speed")
            rows.append({
                "name": name,
                "state": metadata.get("states", {}).get(name) or first_line(net_path / "operstate") or "unknown",
                "addresses": metadata.get("addresses", {}).get(name, []),
                "download_mbps": round(down_rate * 8 / 1_000_000, 2),
                "upload_mbps": round(up_rate * 8 / 1_000_000, 2),
                "link_mbps": int(speed) if speed.lstrip("-").isdigit() and int(speed) >= 0 else None,
                "rx_errors": int(first_line(stats / "rx_errors") or 0),
                "tx_errors": int(first_line(stats / "tx_errors") or 0),
                "rx_dropped": int(first_line(stats / "rx_dropped") or 0),
                "tx_dropped": int(first_line(stats / "tx_dropped") or 0),
            })
        return rows

    def refresh_connections(self) -> None:
        tcp = run("ss", "-H", "-tan", timeout=3).splitlines()
        udp = run("ss", "-H", "-uan", timeout=3).splitlines()
        listening = run("ss", "-H", "-lntu", timeout=3).splitlines()
        established = sum(1 for line in tcp if line.split() and line.split()[0] == "ESTAB")
        self.cached["connections"] = {
            "tcp": len(tcp),
            "tcp_established": established,
            "udp": len(udp),
            "listening": len(listening),
            "total": len(tcp) + len(udp),
        }

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

    def refresh_storage_metadata(self) -> None:
        text = run("findmnt", "-J", "-b", "-o", "TARGET,SOURCE,FSTYPE,OPTIONS", timeout=5)
        try:
            filesystems = flatten_findmnt(json.loads(text or "{}").get("filesystems", []))
        except json.JSONDecodeError:
            filesystems = []
        metadata = []
        seen_mounts = set()
        for row in filesystems:
            mount = row.get("target")
            filesystem = row.get("fstype")
            raw_source = row.get("source") or ""
            source = re.sub(r"\[.*\]$", "", raw_source)
            excluded_prefixes = ("/snap", "/var/lib/snapd", "/var/lib/docker", "/var/lib/containers", "/run/docker")
            if (
                not mount
                or not source
                or mount in seen_mounts
                or filesystem in PSEUDO_FILESYSTEMS
                or "systemd-private" in raw_source
                or any(mount == prefix or mount.startswith(prefix + "/") for prefix in excluded_prefixes)
            ):
                continue
            seen_mounts.add(mount)
            try:
                resolved_source = Path(source).resolve() if source.startswith("/dev/") else Path(source)
            except OSError:
                resolved_source = Path(source)
            device = resolved_source.name
            block = Path("/sys/class/block") / device
            rotational = first_line(block / "queue/rotational")
            smart_device = device
            if (block / "partition").exists():
                try:
                    smart_device = block.resolve().parent.name
                except OSError:
                    pass
            metadata.append({
                "mount": mount,
                "source": source,
                "filesystem": filesystem,
                "read_only": "ro" in (row.get("options") or "").split(","),
                "device": device or None,
                "smart_device": smart_device or None,
                "type": "HDD" if rotational == "1" else "SSD" if rotational == "0" else "Virtual",
            })
        metadata.sort(key=lambda item: (item["mount"].count("/"), item["mount"]))
        self.cached["storage_metadata"] = metadata
        self.cached["storage_devices"] = self.block_devices()

    def block_devices(self) -> list[dict[str, Any]]:
        text = run("lsblk", "-J", "-b", "-o", "NAME,PATH,TYPE,SIZE,ROTA,RO,MODEL,TRAN,FSTYPE,MOUNTPOINTS", timeout=5)
        try:
            devices = json.loads(text or "{}").get("blockdevices", [])
        except json.JSONDecodeError:
            devices = []
        rows = []
        for device in devices:
            if device.get("type") != "disk":
                continue
            descendants = flatten_findmnt([device])
            mountpoints = []
            filesystems = []
            for item in descendants:
                for mountpoint in item.get("mountpoints") or []:
                    if mountpoint and mountpoint != "/var/tmp" and mountpoint not in mountpoints:
                        mountpoints.append(mountpoint)
                filesystem = item.get("fstype")
                if filesystem and filesystem not in filesystems:
                    filesystems.append(filesystem)
            rows.append({
                "name": device.get("name"),
                "path": device.get("path"),
                "model": (device.get("model") or "").strip() or None,
                "size_bytes": device.get("size"),
                "type": "HDD" if device.get("rota") else "SSD",
                "read_only": bool(device.get("ro")),
                "transport": device.get("tran"),
                "mountpoints": mountpoints,
                "filesystems": filesystems,
                "read_mbps": None,
                "write_mbps": None,
                "smart_health": None,
                "temperature_c": None,
                "power_on_hours": None,
            })
        return rows

    def refresh_smart(self) -> None:
        if not shutil.which("smartctl"):
            return
        for device in self.cached["storage_devices"]:
            path = device.get("path")
            if not path:
                continue
            text = run_allow_error("smartctl", "-j", "-H", "-A", path, timeout=10)
            try:
                payload = json.loads(text or "{}")
            except json.JSONDecodeError:
                continue
            passed = payload.get("smart_status", {}).get("passed")
            device["smart_health"] = "Passed" if passed is True else "Failed" if passed is False else None
            device["temperature_c"] = payload.get("temperature", {}).get("current")
            hours = payload.get("power_on_time", {}).get("hours")
            device["power_on_hours"] = hours if isinstance(hours, int) else None

    def disk_rates(self) -> dict[str, dict[str, float]]:
        now = time.monotonic()
        rates = {}
        try:
            lines = Path("/proc/diskstats").read_text().splitlines()
        except (FileNotFoundError, PermissionError):
            return rates
        for line in lines:
            fields = line.split()
            if len(fields) < 10:
                continue
            name = fields[2]
            sectors_read, sectors_written = int(fields[5]), int(fields[9])
            previous = self.previous_disk.get(name)
            read_rate = write_rate = 0.0
            if previous and now > previous[2]:
                elapsed = now - previous[2]
                read_rate = max(0, (sectors_read - previous[0]) * 512 / elapsed)
                write_rate = max(0, (sectors_written - previous[1]) * 512 / elapsed)
            self.previous_disk[name] = (sectors_read, sectors_written, now)
            rates[name] = {"read_mbps": round(read_rate / 1024**2, 3), "write_mbps": round(write_rate / 1024**2, 3)}
        return rates

    def storage(self) -> list[dict[str, Any]]:
        mounts = []
        rates = self.disk_rates()
        smart = {device["name"]: device for device in self.cached["storage_devices"]}
        for device in self.cached["storage_devices"]:
            device.update(rates.get(device["name"], {"read_mbps": None, "write_mbps": None}))
        for metadata in self.cached["storage_metadata"]:
            mount = metadata["mount"]
            try:
                stat = os.statvfs(mount)
            except OSError:
                continue
            total, available = stat.f_blocks * stat.f_frsize, stat.f_bavail * stat.f_frsize
            used = total - available
            inode_total = stat.f_files
            inode_used = inode_total - stat.f_ffree
            label = "Root" if mount == "/" else Path(mount).name
            device_name = metadata.get("device")
            device_health = smart.get(metadata.get("smart_device"), {})
            mounts.append({
                **metadata,
                "label": label,
                "total": as_gib(total),
                "used": as_gib(used),
                "free": as_gib(available),
                "percent": round(100 * used / total, 1) if total else 0,
                "inode_percent": round(100 * inode_used / inode_total, 1) if inode_total else None,
                "health": device_health.get("smart_health") or "Available",
                "temperature_c": device_health.get("temperature_c"),
                "power_on_hours": device_health.get("power_on_hours"),
                **rates.get(device_name, {"read_mbps": None, "write_mbps": None}),
            })
        return mounts

    def gpu(self, temperatures: dict[str, Any]) -> dict[str, Any]:
        return {
            **self.cached["gpu_metadata"],
            "temperature": temperatures["gpu"],
            "fan_percent": temperatures["gpu_fan"],
            "utilization": None,
            "vram": None,
            "status": "Limited telemetry with nouveau driver",
        }

    def refresh_gpu_metadata(self) -> None:
        gpu_name = next(
            (line.split(":", 2)[-1].strip() for line in run("lspci").splitlines() if re.search(r"VGA|3D|Display", line, re.I)),
            "GPU unavailable",
        )
        self.cached["gpu_metadata"] = {"name": gpu_name, "driver": "nouveau"}

    def pressure(self) -> dict[str, Any]:
        result = {}
        for kind in ("cpu", "memory", "io"):
            values = {}
            try:
                lines = (Path("/proc/pressure") / kind).read_text().splitlines()
            except (FileNotFoundError, PermissionError):
                continue
            for line in lines:
                fields = line.split()
                values[fields[0]] = {
                    key: float(value) if key != "total" else int(value)
                    for key, value in (field.split("=", 1) for field in fields[1:])
                }
            result[kind] = values
        return result

    def refresh_processes(self) -> None:
        text = run("ps", "-eo", "pid=,user=,pcpu=,pmem=,rss=,stat=,etimes=,comm=", timeout=4)
        rows = []
        generated = datetime.now(ZoneInfo("Africa/Casablanca"))
        for line in text.splitlines():
            parts = line.split(None, 7)
            if len(parts) != 8:
                continue
            try:
                pid = int(parts[0])
                runtime_seconds = int(parts[6])
                rss_bytes = int(parts[4]) * 1024
                cpu_percent = float(parts[2])
                memory_percent = float(parts[3])
            except ValueError:
                continue
            if not (Path("/proc") / str(pid)).exists():
                continue
            rows.append({
                "pid": pid,
                "user": parts[1],
                "cpu": cpu_percent,
                "memory": memory_percent,
                "memory_bytes": rss_bytes,
                "rss_bytes": rss_bytes,
                "status": parts[5],
                "runtime_seconds": runtime_seconds,
                "runtime": format_duration(runtime_seconds),
                "started_at": datetime.fromtimestamp(generated.timestamp() - runtime_seconds, generated.tzinfo).isoformat(),
                "command": parts[7][:64],
                "associated_service": None,
                "associated_container": None,
            })
        top_cpu = sorted(rows, key=lambda row: row["cpu"], reverse=True)[:20]
        top_memory = sorted(rows, key=lambda row: row["rss_bytes"], reverse=True)[:20]
        selected = {row["pid"]: row for row in top_cpu}
        selected.update({row["pid"]: row for row in top_memory})
        self.cached["processes"] = list(selected.values())
        self.associate_processes()

    def associate_processes(self) -> None:
        containers = {
            row.get("id"): row.get("name")
            for row in self.cached["docker"]
            if row.get("id") and row.get("name")
        }
        for row in self.cached["processes"]:
            try:
                cgroup = (Path("/proc") / str(row["pid"]) / "cgroup").read_text()
            except (FileNotFoundError, PermissionError, ProcessLookupError):
                continue
            service_match = re.search(r"(?:^|/)([^/\n]+\.service)(?:/|$)", cgroup, re.MULTILINE)
            container_match = re.search(r"(?:docker[-/]|cri-containerd-)([0-9a-f]{12,64})", cgroup)
            row["associated_service"] = service_match.group(1) if service_match else None
            if container_match:
                container_id = container_match.group(1)
                row["associated_container"] = next(
                    (name for short_id, name in containers.items() if container_id.startswith(short_id)),
                    None,
                )

    def refresh_services(self) -> None:
        listed = run("systemctl", "list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain", timeout=8)
        units = [line.split()[0] for line in listed.splitlines() if line.split()]
        preferred = [unit for _, unit, _ in SERVICES]
        selected = list(dict.fromkeys(preferred + units))[:40]
        properties = (
            "Id,Description,ActiveState,SubState,MainPID,TasksCurrent,MemoryCurrent,"
            "CPUUsageNSec,NRestarts,ActiveEnterTimestampMonotonic"
        )
        text = run_allow_error("systemctl", "show", *selected, f"--property={properties}", "--no-pager", timeout=12)
        ports = {unit: port for _, unit, port in SERVICES}
        friendly_names = {unit: friendly for friendly, unit, _ in SERVICES}
        boot_seconds = float(first_line(Path("/proc/uptime")).split()[0])
        sampled_at = time.monotonic()
        elapsed = sampled_at - self.previous_service_sample_at if self.previous_service_sample_at else None
        services = []
        for values in parse_blocks(text):
            unit = values.get("Id")
            if not unit:
                continue
            active_monotonic = parse_bytes(values.get("ActiveEnterTimestampMonotonic"))
            uptime = max(0, boot_seconds - active_monotonic / 1_000_000) if active_monotonic else None
            cpu_nanoseconds = parse_bytes(values.get("CPUUsageNSec"))
            previous_cpu = self.previous_service_cpu.get(unit)
            cpu_percent = None
            if elapsed and cpu_nanoseconds is not None and previous_cpu is not None:
                cpu_percent = round(max(0, cpu_nanoseconds - previous_cpu) / elapsed / 10_000_000, 2)
            if cpu_nanoseconds is not None:
                self.previous_service_cpu[unit] = cpu_nanoseconds
            services.append({
                "name": friendly_names.get(unit) or re.sub(r"\.service$", "", unit).replace("-", " ").title(),
                "unit": unit,
                "description": values.get("Description") or unit,
                "state": values.get("ActiveState") or "unknown",
                "substate": values.get("SubState") or "unknown",
                "cpu_percent": cpu_percent,
                "cpu_seconds": round(cpu_nanoseconds / 1_000_000_000, 2) if cpu_nanoseconds is not None else None,
                "memory_bytes": parse_bytes(values.get("MemoryCurrent")),
                "main_pid": int(values["MainPID"]) if values.get("MainPID", "").isdigit() else None,
                "tasks": int(values["TasksCurrent"]) if values.get("TasksCurrent", "").isdigit() else None,
                "uptime_seconds": round(uptime) if uptime is not None else None,
                "uptime": format_duration(uptime),
                "restart_count": int(values["NRestarts"]) if values.get("NRestarts", "").isdigit() else 0,
                "port": ports.get(unit),
                "source": "systemd",
                "category": "Pinned" if unit in preferred else "System",
            })
        self.previous_service_sample_at = sampled_at
        self.cached["services"] = services

    def refresh_docker(self) -> None:
        docker_rows = []
        for line in run("docker", "ps", "--format", "{{json .}}", timeout=8).splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            docker_rows.append({
                "id": row.get("ID"),
                "name": row.get("Names"),
                "image": row.get("Image"),
                "state": row.get("State"),
                "status": row.get("Status"),
                "ports": row.get("Ports"),
            })
        stats = {}
        for line in run("docker", "stats", "--no-stream", "--format", "{{json .}}", timeout=12).splitlines():
            try:
                row = json.loads(line)
                stats[row.get("Name")] = {
                    "cpu": row.get("CPUPerc"),
                    "cpu_percent": parse_percent(row.get("CPUPerc")),
                    "memory": row.get("MemUsage"),
                    "memory_bytes": parse_size((row.get("MemUsage") or "").split("/", 1)[0].strip()),
                    "memory_percent": parse_percent(row.get("MemPerc")),
                    "network_io": row.get("NetIO"),
                    "block_io": row.get("BlockIO"),
                }
            except json.JSONDecodeError:
                continue
        inspect_by_name = {}
        ids = [row["id"] for row in docker_rows if row.get("id")]
        if ids:
            try:
                inspected = json.loads(run("docker", "inspect", *ids, timeout=12) or "[]")
            except json.JSONDecodeError:
                inspected = []
            for item in inspected:
                name = (item.get("Name") or "").lstrip("/")
                state = item.get("State") or {}
                labels = (item.get("Config") or {}).get("Labels") or {}
                started_at = state.get("StartedAt")
                inspect_by_name[name] = {
                    "health": (state.get("Health") or {}).get("Status"),
                    "restart_count": item.get("RestartCount", 0),
                    "started_at": started_at,
                    "compose_project": labels.get("com.docker.compose.project"),
                }
        for row in docker_rows:
            row.update(stats.get(row["name"], {}))
            row.update(inspect_by_name.get(row["name"], {}))
            started_at = row.get("started_at")
            row["uptime_seconds"] = None
            if started_at:
                try:
                    started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
                    row["uptime_seconds"] = max(0, round(time.time() - started.timestamp()))
                except ValueError:
                    pass
        image_ids = {line for line in run("docker", "image", "ls", "-q", timeout=8).splitlines() if line}
        exposed_ports = set()
        for row in docker_rows:
            for match in re.findall(r":(\d+)->", row.get("ports") or ""):
                exposed_ports.add(match)
        self.cached["docker"] = docker_rows
        self.cached["docker_summary"] = {
            "containers": len(docker_rows),
            "running": sum(1 for row in docker_rows if row.get("state") == "running"),
            "images": len(image_ids),
            "cpu_percent": round(sum(row.get("cpu_percent") or 0 for row in docker_rows), 2),
            "memory_percent": round(sum(row.get("memory_percent") or 0 for row in docker_rows), 2),
            "memory_bytes": sum(row.get("memory_bytes") or 0 for row in docker_rows),
            "exposed_ports": len(exposed_ports),
        }
        self.associate_processes()

    def refresh_web(self) -> None:
        def probe(app: tuple[str, str, str, str, str, int, str]) -> dict[str, Any]:
            app_id, name, description, local_url, scheme, port, category = app
            flags = ["curl", "-ksS", "--max-time", "3", "-o", "/dev/null", "-w", "%{http_code} %{time_total}", local_url]
            response = run(*flags, timeout=5).split()
            status = response[0] if response else "unavailable"
            try:
                latency_ms = round(float(response[1]) * 1000) if len(response) > 1 else None
            except ValueError:
                latency_ms = None
            return {"id": app_id, "name": name, "description": description, "category": category, "scheme": scheme, "port": port, "healthy": status.startswith(("2", "3")), "status": status, "latency_ms": latency_ms, "source": "Local probe"}

        with ThreadPoolExecutor(max_workers=len(WEB_INTERFACES)) as executor:
            self.cached["web"] = list(executor.map(probe, WEB_INTERFACES))

    def refresh_cached_metrics(self, now: float) -> None:
        schedules = (
            ("network_metadata", NETWORK_METADATA_REFRESH_SECONDS, self.refresh_network_metadata),
            ("connections", CONNECTION_REFRESH_SECONDS, self.refresh_connections),
            ("processes", PROCESS_REFRESH_SECONDS, self.refresh_processes),
            ("services", SERVICE_REFRESH_SECONDS, self.refresh_services),
            ("docker", DOCKER_REFRESH_SECONDS, self.refresh_docker),
            ("gpu_metadata", STORAGE_METADATA_REFRESH_SECONDS, self.refresh_gpu_metadata),
            ("apps", APP_PROBE_REFRESH_SECONDS, self.refresh_web),
            ("storage_metadata", STORAGE_METADATA_REFRESH_SECONDS, self.refresh_storage_metadata),
            ("smart", SMART_REFRESH_SECONDS, self.refresh_smart),
        )
        for name, interval, refresh in schedules:
            if now - self.last_refresh[name] >= interval:
                refresh()
                self.last_refresh[name] = now

    def snapshot(self) -> dict[str, Any]:
        cpu = self.cpu()
        memory = self.memory()
        temperatures = self.temperatures()
        self.gpu_temp_history.append(temperatures["gpu"])
        self.gpu_fan_history.append(temperatures["gpu_fan"])
        now = time.monotonic()
        self.refresh_cached_metrics(now)
        network = self.network()
        storage = self.storage()
        alerts = []
        if cpu["temperature"] and cpu["temperature"] >= 80:
            alerts.append({"level": "critical", "message": f"CPU package temperature is {cpu['temperature']:.0f}°C"})
        if memory["percent"] >= 90:
            alerts.append({"level": "warning", "message": f"Memory use is {memory['percent']}%"})
        for disk in storage:
            if disk["percent"] >= 90:
                alerts.append({"level": "warning", "message": f"{disk['label']} storage is {disk['percent']}% full"})
        failed_services = [
            service["name"] for service in self.cached["services"]
            if service["state"] == "failed"
            or (service["category"] == "Pinned" and service["state"] not in ("active", "listening"))
        ]
        if failed_services:
            alerts.append({"level": "warning", "message": "Unavailable services: " + ", ".join(failed_services)})
        return {
            "generated_at": datetime.now(ZoneInfo("Africa/Casablanca")).isoformat(),
            "schema_version": 3,
            "host": {"name": os.uname().nodename, "model": first_line(Path("/sys/class/dmi/id/product_name")) or "Unknown model", "os": os_pretty_name(), "kernel": os.uname().release, "uptime_seconds": float(first_line(Path("/proc/uptime")).split()[0])},
            "cpu": cpu, "memory": memory, "network": network, "storage": storage, "storage_devices": self.cached["storage_devices"], "temperatures": temperatures, "gpu": self.gpu(temperatures),
            "pressure": self.pressure(),
            "collector": {
                "interval_seconds": INTERVAL_SECONDS,
                "process_refresh_seconds": PROCESS_REFRESH_SECONDS,
                "connection_refresh_seconds": CONNECTION_REFRESH_SECONDS,
                "docker_refresh_seconds": DOCKER_REFRESH_SECONDS,
                "service_refresh_seconds": SERVICE_REFRESH_SECONDS,
                "app_probe_refresh_seconds": APP_PROBE_REFRESH_SECONDS,
                "storage_metadata_refresh_seconds": STORAGE_METADATA_REFRESH_SECONDS,
                "smart_refresh_seconds": SMART_REFRESH_SECONDS,
            },
            "services": self.cached["services"], "docker": self.cached["docker"], "docker_summary": self.cached["docker_summary"], "web_interfaces": self.cached["web"], "processes": self.cached["processes"], "alerts": alerts,
            "fan": {"profile": "Firmware automatic", "software_control": False, "next_switch": None, "reason": "No verified CPU PWM channel or fan RPM sensor is available."},
            "history": {
                "cpu": list(self.cpu_history),
                "temperature": list(self.temp_history),
                "gpu_temperature": list(self.gpu_temp_history),
                "gpu_fan": list(self.gpu_fan_history),
                "memory": list(self.memory_history),
                "download": list(self.rx_history),
                "upload": list(self.tx_history),
            },
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
