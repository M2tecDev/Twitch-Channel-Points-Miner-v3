#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wrapper.py  —  Supervised restart manager for run.py
=====================================================
Start the bot with:   python wrapper.py

What it does:
  1. Launches run.py as a subprocess.
  2. If run.py crashes, it auto-restarts it after 5 seconds.
  3. If the streamer list in config.json changes (add / remove / enable toggle),
     it gracefully terminates run.py and restarts it (10-second delay so the
     Web UI can display a "restarting…" state).
  4. Settings changes (bet strategy, make_predictions, etc.) do NOT trigger a
     restart — run.py's config watcher thread handles those in-memory.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

CONFIG_PATH = os.path.join(Path(__file__).parent.absolute(), "config.json")
RUNNER_PATH = os.path.join(Path(__file__).parent.absolute(), "run.py")
RESTART_DELAY = 10   # seconds to wait before restart on streamer-list change
CRASH_DELAY   = 5    # seconds to wait before restart on crash


def get_streamers_fingerprint(config_path: str):
    """
    Returns a stable tuple representing the current enabled streamer list.
    Only username + enabled flag are considered; settings changes are ignored.
    Returns None if the file cannot be read.
    """
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        return tuple(
            (s["username"].strip().lower(), bool(s.get("enabled", True)))
            for s in config.get("streamers", [])
        )
    except Exception:
        return None


def start_miner() -> subprocess.Popen:
    print(f"▶  Starting miner ({RUNNER_PATH})…", flush=True)
    return subprocess.Popen([sys.executable, RUNNER_PATH])


# ── Boot ─────────────────────────────────────────────────────
print("╔══════════════════════════════════════╗", flush=True)
print("║  CPM 3   —  wrapper.py  started      ║", flush=True)
print("╚══════════════════════════════════════╝", flush=True)

if not os.path.exists(CONFIG_PATH):
    print(f"✗  config.json not found at {CONFIG_PATH}", flush=True)
    print("   Copy config.json.example → config.json and fill in your credentials.", flush=True)
    sys.exit(1)

process          = start_miner()
last_fingerprint = get_streamers_fingerprint(CONFIG_PATH)
last_mtime       = 0.0

try:
    while True:
        time.sleep(3)

        # ── 1. Restart on crash ───────────────────────────────
        if process.poll() is not None:
            code = process.returncode
            print(f"⚠  Miner exited (code {code}) — restarting in {CRASH_DELAY}s…", flush=True)
            time.sleep(CRASH_DELAY)
            process          = start_miner()
            last_fingerprint = get_streamers_fingerprint(CONFIG_PATH)
            last_mtime       = 0.0
            continue

        # ── 2. Detect streamer-list changes ──────────────────
        try:
            mtime = os.path.getmtime(CONFIG_PATH)
        except OSError:
            continue

        if mtime == last_mtime:
            continue

        last_mtime  = mtime
        current_fp  = get_streamers_fingerprint(CONFIG_PATH)

        if current_fp is None or current_fp == last_fingerprint:
            # File changed but streamer list is the same → hot-reload handled by run.py
            continue

        print(f"🔄  Streamer list changed — restarting miner in {RESTART_DELAY}s…", flush=True)
        time.sleep(RESTART_DELAY)

        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            print("   Force-killing unresponsive miner…", flush=True)
            process.kill()
            process.wait()

        process          = start_miner()
        last_fingerprint = current_fp

except KeyboardInterrupt:
    print("\n⛔  Wrapper stopped — shutting down miner…", flush=True)
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
    print("   Done.", flush=True)
