#!/usr/bin/env python3
"""
KRYV-MCP Oracle VM Agent
File: oracle-agent.py

Runs 24/7 on your Oracle Always-Free VM.
Collects local data and pushes to KRYV-MCP server.

INSTALL on Oracle VM (Ubuntu):
  sudo apt update && sudo apt install python3-pip -y
  pip3 install requests schedule watchdog --break-system-packages

RUN:
  python3 oracle-agent.py

RUN AS SERVICE (always-on):
  sudo nano /etc/systemd/system/kryv-agent.service
  [paste the systemd config below]
  sudo systemctl enable kryv-agent && sudo systemctl start kryv-agent

SYSTEMD CONFIG:
  [Unit]
  Description=KRYV-MCP Context Agent
  After=network.target

  [Service]
  ExecStart=/usr/bin/python3 /home/ubuntu/oracle-agent.py
  Restart=always
  User=ubuntu
  Environment=KRYV_CLIENT_ID=your-client-id
  Environment=KRYV_SERVER=https://mcp.kryv.network

  [Install]
  WantedBy=multi-user.target
"""

import os
import json
import time
import hashlib
import requests
import schedule
import platform
from datetime import datetime
from pathlib import Path

# ── Config ──
KRYV_SERVER = os.environ.get("KRYV_SERVER", "https://mcp.kryv.network")
CLIENT_ID = os.environ.get("KRYV_CLIENT_ID", "")
PRIVACY_MODE = os.environ.get("KRYV_PRIVACY", "false").lower() == "true"
PUSH_URL = f"{KRYV_SERVER}/push"
LOCAL_STORE = Path("/tmp/kryv-context")
LOCAL_STORE.mkdir(exist_ok=True)

def log(msg: str):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] KRYV-AGENT: {msg}")

def push_context(source: str, data: dict):
    """Push context to KRYV server or store locally in privacy mode."""
    payload = {"client_id": CLIENT_ID, "source": source, "data": data}

    # Always store locally
    local_file = LOCAL_STORE / f"{source}.json"
    with open(local_file, "w") as f:
        json.dump({**data, "updated_at": datetime.utcnow().isoformat()}, f)

    # Push to server unless privacy mode
    if not PRIVACY_MODE and CLIENT_ID:
        try:
            res = requests.post(PUSH_URL, json=payload, timeout=10)
            if res.ok:
                log(f"✓ Pushed {source} ({len(str(data))} bytes)")
            else:
                log(f"✗ Push failed for {source}: {res.status_code}")
        except requests.RequestException as e:
            log(f"✗ Network error: {e}")
    else:
        log(f"📦 Stored locally: {source} (privacy mode)")

# ── Context Collectors ──

def collect_system_info():
    """Collect system stats — CPU, memory, disk."""
    try:
        import psutil
        return {
            "cpu_percent": psutil.cpu_percent(interval=1),
            "memory_percent": psutil.virtual_memory().percent,
            "disk_percent": psutil.disk_usage("/").percent,
            "platform": platform.system(),
            "hostname": platform.node(),
        }
    except ImportError:
        return {
            "platform": platform.system(),
            "hostname": platform.node(),
            "note": "install psutil for full stats",
        }

def collect_local_files(watch_dirs=None):
    """Collect metadata about recently modified files."""
    if watch_dirs is None:
        home = Path.home()
        watch_dirs = [
            home / "Documents",
            home / "Downloads",
            home / "Desktop",
        ]

    files = []
    cutoff = time.time() - (24 * 60 * 60)  # last 24 hours

    for d in watch_dirs:
        if not d.exists():
            continue
        try:
            for f in d.rglob("*"):
                if f.is_file() and f.stat().st_mtime > cutoff:
                    files.append({
                        "name": f.name,
                        "path": str(f.relative_to(Path.home())),
                        "size_kb": round(f.stat().st_size / 1024, 1),
                        "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
                        "type": f.suffix.lower(),
                    })
        except PermissionError:
            continue

    files.sort(key=lambda x: x["modified"], reverse=True)
    return {
        "recent_files": files[:50],
        "count": len(files),
        "watched_dirs": [str(d) for d in watch_dirs],
    }

def collect_notes():
    """Collect text/markdown notes from common locations."""
    home = Path.home()
    note_dirs = [home / "Notes", home / "Documents", home / "Desktop"]
    extensions = {".txt", ".md", ".markdown", ".text"}
    notes = []

    for d in note_dirs:
        if not d.exists():
            continue
        for f in d.rglob("*"):
            if f.is_file() and f.suffix.lower() in extensions:
                try:
                    content = f.read_text(encoding="utf-8", errors="ignore")
                    notes.append({
                        "name": f.name,
                        "path": str(f.relative_to(home)),
                        "preview": content[:200].strip(),
                        "word_count": len(content.split()),
                        "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
                    })
                except Exception:
                    continue

    notes.sort(key=lambda x: x["modified"], reverse=True)
    return {"notes": notes[:20], "count": len(notes)}

def collect_clipboard():
    """Try to get clipboard content (requires xclip on Linux)."""
    try:
        import subprocess
        result = subprocess.run(["xclip", "-selection", "clipboard", "-o"],
                                capture_output=True, text=True, timeout=2)
        if result.returncode == 0 and result.stdout:
            return {"content": result.stdout[:500], "has_content": True}
    except Exception:
        pass
    return {"has_content": False, "note": "xclip not available or clipboard empty"}

# ── Scheduled Jobs ──

def job_full_sync():
    """Full context sync — runs every 5 minutes."""
    log("Starting full sync...")

    # System info
    push_context("system_info", collect_system_info())

    # Recent files
    push_context("local_files", collect_local_files())

    # Notes
    push_context("local_notes", collect_notes())

    log("Full sync complete.")

def job_quick_sync():
    """Quick sync — just system info every minute."""
    push_context("system_info", collect_system_info())

def check_server():
    """Ping server to verify it's up."""
    try:
        res = requests.get(f"{KRYV_SERVER}/health", timeout=5)
        if res.ok:
            data = res.json()
            log(f"Server OK · {data.get('version','?')} · DB: {data.get('db','?')}")
            return True
        else:
            log(f"Server returned {res.status_code}")
            return False
    except Exception as e:
        log(f"Server unreachable: {e}")
        return False

# ── Main ──

def main():
    log(f"KRYV-MCP Agent starting...")
    log(f"Server: {KRYV_SERVER}")
    log(f"Client ID: {CLIENT_ID or '(not set — set KRYV_CLIENT_ID env var)'}")
    log(f"Privacy mode: {PRIVACY_MODE}")

    if not CLIENT_ID:
        log("WARNING: KRYV_CLIENT_ID not set. Context will be stored locally only.")

    # Check server
    check_server()

    # Run immediately on start
    job_full_sync()

    # Schedule
    schedule.every(1).minutes.do(job_quick_sync)
    schedule.every(5).minutes.do(job_full_sync)
    schedule.every(30).minutes.do(check_server)

    log("Scheduler running. Press Ctrl+C to stop.")
    while True:
        schedule.run_pending()
        time.sleep(10)

if __name__ == "__main__":
    main()
