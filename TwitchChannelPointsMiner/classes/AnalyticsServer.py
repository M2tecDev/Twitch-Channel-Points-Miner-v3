# -*- coding: utf-8 -*-
import copy
import json
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from threading import Thread

import pandas as pd
from flask import Flask, Response, cli, render_template, request

from TwitchChannelPointsMiner.classes.Settings import Settings
from TwitchChannelPointsMiner.utils import download_file

cli.show_server_banner = lambda *_: None
logger = logging.getLogger(__name__)

CONFIG_PATH = os.path.join(Path().absolute(), "config.json")

DEFAULT_CONFIG = {
    "miner": {
        "username": "",
        "priority": ["STREAK", "DROPS", "ORDER"],
        "enable_analytics": True,
        "claim_drops_startup": False,
        "disable_ssl_cert_verification": False,
        "disable_at_in_nickname": False,
    },
    "analytics": {"host": "0.0.0.0", "port": 5000, "refresh": 5, "days_ago": 7},
    "global_settings": {
        "make_predictions": True,
        "follow_raid":      True,
        "claim_drops":      True,
        "claim_moments":    True,
        "watch_streak":     True,
        "community_goals":  False,
        "chat":             "ONLINE",
        "bet": {
            "strategy":        "SMART",
            "percentage":       5,
            "percentage_gap":  20,
            "max_points":   50000,
            "minimum_points":   0,
            "stealth_mode":  True,
            "delay_mode":  "FROM_END",
            "delay":            6,
            "filter_condition": None,
        },
    },
    "settings_password": "",
    "streamers": [],
}


# ── Helpers ───────────────────────────────────────────────────

def _load_or_default():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"config.json unreadable ({e}), using defaults")
    return copy.deepcopy(DEFAULT_CONFIG)


def streamers_available():
    try:
        return [
            f for f in os.listdir(Settings.analytics_path)
            if os.path.isfile(os.path.join(Settings.analytics_path, f)) and f.endswith(".json")
        ]
    except Exception:
        return []


def _active_streamer_names():
    """
    Returns only the ENABLED streamers from config.json.
    FIX #1: deleted / disabled streamers are excluded from the sidebar
    even if their .json analytics file still exists on disk.
    Falls back to all analytics files only when config has no streamers.
    """
    config     = _load_or_default()
    configured = [
        s["username"].strip().lower()
        for s in config.get("streamers", [])
        if s.get("enabled", True)
    ]
    if configured:
        return set(configured)
    return {f.strip(".json") for f in streamers_available()}


def filter_datas(start_date, end_date, datas):
    start_date = (
        datetime.strptime(start_date, "%Y-%m-%d").timestamp() * 1000
        if start_date is not None else 0
    )
    end_date = (
        datetime.strptime(end_date, "%Y-%m-%d")
        if end_date is not None else datetime.now()
    ).replace(hour=23, minute=59, second=59).timestamp() * 1000

    original_series = datas.get("series", [])

    if "series" in datas and datas["series"]:
        df = pd.DataFrame(datas["series"])
        df["datetime"] = pd.to_datetime(df.x // 1000, unit="s")
        df = df[(df.x >= start_date) & (df.x <= end_date)]
        datas["series"] = (
            df.drop(columns="datetime")
            .sort_values(by=["x", "y"], ascending=True)
            .to_dict("records")
        )
    else:
        datas["series"] = []

    if len(datas["series"]) == 0 and original_series:
        df = pd.DataFrame(original_series)
        df["datetime"] = pd.to_datetime(df.x // 1000, unit="s")
        df = df[df.x <= start_date]
        if not df.empty:
            last_balance = df.sort_values("x").iloc[-1]["y"]
            datas["series"] = [
                {"x": start_date, "y": last_balance, "z": "No Stream"},
                {"x": end_date,   "y": last_balance, "z": "No Stream"},
            ]

    if "annotations" in datas and datas["annotations"]:
        df = pd.DataFrame(datas["annotations"])
        df["datetime"] = pd.to_datetime(df.x // 1000, unit="s")
        df = df[(df.x >= start_date) & (df.x <= end_date)]
        datas["annotations"] = (
            df.drop(columns="datetime")
            .sort_values(by="x", ascending=True)
            .to_dict("records")
        )
    else:
        datas["annotations"] = []

    return datas


def read_json(streamer, return_response=True):
    start_date = request.args.get("startDate", type=str)
    end_date   = request.args.get("endDate",   type=str)
    path       = Settings.analytics_path
    streamer   = streamer if streamer.endswith(".json") else f"{streamer}.json"
    fpath      = os.path.join(path, streamer)

    if not os.path.exists(fpath):
        err = {"error": f"File '{streamer}' not found."}
        logger.error(err["error"])
        if return_response:
            return Response(json.dumps(err), status=404, mimetype="application/json")
        return err

    try:
        with open(fpath, "r") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        err = {"error": f"JSON decode error in '{streamer}': {e}"}
        logger.error(err["error"])
        if return_response:
            return Response(json.dumps(err), status=500, mimetype="application/json")
        return err

    filtered = filter_datas(start_date, end_date, data)
    if return_response:
        return Response(json.dumps(filtered, default=int), status=200, mimetype="application/json")
    return filtered


def get_challenge_points(streamer):
    d = read_json(streamer, return_response=False)
    return d["series"][-1]["y"] if d.get("series") else 0


def get_last_activity(streamer):
    d = read_json(streamer, return_response=False)
    return d["series"][-1]["x"] if d.get("series") else 0


def json_all():
    return Response(
        json.dumps([
            {"name": s.strip(".json"), "data": read_json(s, return_response=False)}
            for s in streamers_available()
        ]),
        status=200, mimetype="application/json",
    )


def index(refresh=5, days_ago=7):
    return render_template("charts.html", refresh=(refresh * 60 * 1000), daysAgo=days_ago)


def streamers():
    """Only return enabled streamers — deleted/disabled ones won't show in sidebar."""
    active = _active_streamer_names()
    result = []
    for s in sorted(streamers_available()):
        if s.strip(".json") in active:
            result.append({
                "name":          s,
                "points":        get_challenge_points(s),
                "last_activity": get_last_activity(s),
            })
    return Response(json.dumps(result), status=200, mimetype="application/json")


# ── /status ───────────────────────────────────────────────────

def make_status_handler(miner_ref):
    def status():
        result = {}
        # FIX #3: Only return live data when miner_ref exists.
        # Without it we return {} so the frontend shows NO dots (not all-green).
        if miner_ref is not None and getattr(miner_ref, "streamers", None):
            for s in miner_ref.streamers:
                result[s.username] = {
                    "is_online":      bool(s.is_online),
                    "channel_points": getattr(s, "channel_points", 0) or 0,
                    "last_activity":  get_last_activity(f"{s.username}.json"),
                }
        return Response(json.dumps(result), status=200, mimetype="application/json")
    return status


# ── /bets ─────────────────────────────────────────────────────

def bets():
    COLOR_MAP = {"#36b535": "WIN", "#ff4545": "LOSE", "#ffe045": "PLACED"}
    all_bets  = []
    active    = _active_streamer_names()

    for fname in streamers_available():
        name = fname.strip(".json")
        if name not in active:
            continue
        try:
            with open(os.path.join(Settings.analytics_path, fname), "r") as f:
                data = json.load(f)
        except Exception:
            continue
        annotations = data.get("annotations", [])
        series      = sorted(data.get("series", []), key=lambda e: e["x"])
        for ann in annotations:
            result = COLOR_MAP.get(ann.get("borderColor", ""))
            if not result:
                continue
            ts        = ann.get("x", 0)
            points_at = 0
            if series:
                closest   = min(series, key=lambda e: abs(e["x"] - ts))
                points_at = closest.get("y", 0)
            all_bets.append({
                "streamer":  name,
                "title":     ann.get("label", {}).get("text", ""),
                "result":    result,
                "timestamp": ts,
                "points_at": points_at,
            })

    all_bets.sort(key=lambda b: b["timestamp"], reverse=True)
    return Response(json.dumps(all_bets), status=200, mimetype="application/json")


# ── /summary ─────────────────────────────────────────────────

def summary():
    total_points = 0; total_gained = 0; total_streamers = 0
    bets_won = 0; bets_lost = 0
    best_streamer  = {"name": None, "points": 0}
    worst_streamer = {"name": None, "points": float("inf")}
    active = _active_streamer_names()

    for fname in streamers_available():
        name = fname.strip(".json")
        if name not in active:
            continue
        try:
            with open(os.path.join(Settings.analytics_path, fname), "r") as f:
                data = json.load(f)
        except Exception:
            continue
        total_streamers += 1
        series      = data.get("series", [])
        annotations = data.get("annotations", [])
        if series:
            current       = series[-1]["y"]
            first         = series[0]["y"]
            total_points += current
            total_gained += current - first
            if current > best_streamer["points"]:
                best_streamer = {"name": name, "points": current}
            if current < worst_streamer["points"]:
                worst_streamer = {"name": name, "points": current}
        for ann in annotations:
            c = ann.get("borderColor", "")
            if c == "#36b535":   bets_won  += 1
            elif c == "#ff4545": bets_lost += 1

    total_bets = bets_won + bets_lost
    return Response(json.dumps({
        "total_streamers": total_streamers,
        "total_points":    total_points,
        "total_gained":    total_gained,
        "best_streamer":   best_streamer  if best_streamer["name"] else None,
        "worst_streamer":  worst_streamer if worst_streamer["name"] and total_streamers > 0 else None,
        "bets_won": bets_won, "bets_lost": bets_lost,
        "total_bets": total_bets,
        "bet_win_rate": round(bets_won / total_bets * 100, 1) if total_bets > 0 else 0.0,
    }), status=200, mimetype="application/json")


# ── /config CRUD ──────────────────────────────────────────────

def _auto_fill_streamers(config):
    if not config.get("streamers"):
        config["streamers"] = [
            {"username": fname.strip(".json"), "enabled": True, "settings": None}
            for fname in sorted(streamers_available())
        ]


def get_config():
    config = _load_or_default()
    _auto_fill_streamers(config)
    return Response(json.dumps(config, indent=2), status=200, mimetype="application/json")


def save_config():
    data = request.get_json(force=True)
    if not data:
        return Response(json.dumps({"error": "No JSON body"}), status=400, mimetype="application/json")
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        logger.info("config.json updated via web UI")
        return Response(json.dumps({"status": "ok", "message": "Saved. Hot-reload in ~2s."}),
                        status=200, mimetype="application/json")
    except Exception as e:
        return Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")


def add_streamer():
    body = request.get_json(force=True)
    if not body or "username" not in body:
        return Response(json.dumps({"error": "username required"}), status=400, mimetype="application/json")
    config   = _load_or_default()
    username = body["username"].strip().lower()
    if username in [s["username"] for s in config.get("streamers", [])]:
        return Response(json.dumps({"error": f"'{username}' already in list"}), status=409, mimetype="application/json")
    config.setdefault("streamers", []).append({"username": username, "enabled": True, "settings": body.get("settings")})
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    return Response(json.dumps({"status": "ok", "message": f"'{username}' added. Miner restarts in ~10s."}),
                    status=201, mimetype="application/json")


def patch_streamer(username):
    body = request.get_json(force=True)
    if not body:
        return Response(json.dumps({"error": "No JSON body"}), status=400, mimetype="application/json")
    config = _load_or_default()
    _auto_fill_streamers(config)
    found = False
    for s in config.get("streamers", []):
        if s["username"] == username:
            if "settings" in body:
                if body["settings"] is None:
                    s["settings"] = None
                else:
                    if s.get("settings") is None:
                        s["settings"] = {}
                    if "bet" in body["settings"]:
                        s["settings"].setdefault("bet", {}).update(body["settings"].pop("bet"))
                    s["settings"].update(body["settings"])
            if "enabled" in body:
                s["enabled"] = bool(body["enabled"])
            found = True
            break
    if not found:
        return Response(json.dumps({"error": f"'{username}' not found"}), status=404, mimetype="application/json")
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    return Response(json.dumps({"status": "ok", "message": f"'{username}' updated."}),
                    status=200, mimetype="application/json")


def delete_streamer(username):
    config = _load_or_default()
    _auto_fill_streamers(config)
    before = len(config.get("streamers", []))
    config["streamers"] = [s for s in config.get("streamers", []) if s["username"] != username]
    if len(config["streamers"]) == before:
        return Response(json.dumps({"error": f"'{username}' not found"}), status=404, mimetype="application/json")
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    return Response(json.dumps({"status": "ok", "message": f"'{username}' removed. Miner restarts in ~10s."}),
                    status=200, mimetype="application/json")


# ── Assets ────────────────────────────────────────────────────

def download_assets(assets_folder, required_files):
    Path(assets_folder).mkdir(parents=True, exist_ok=True)
    for f in required_files:
        if not os.path.isfile(os.path.join(assets_folder, f)):
            if download_file(os.path.join("assets", f), os.path.join(assets_folder, f)):
                logger.info(f"Downloaded {f}")


def check_assets():
    required = ["banner.png", "charts.html", "script.js", "style.css", "dark-theme.css"]
    folder   = os.path.join(Path().absolute(), "assets")
    if not os.path.isdir(folder):
        download_assets(folder, required)
    else:
        for f in required:
            if not os.path.isfile(os.path.join(folder, f)):
                download_assets(folder, required)
                break


last_sent_log_index = 0


# ── Server class ──────────────────────────────────────────────

class AnalyticsServer(Thread):
    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 5000,
        refresh: int = 5,
        days_ago: int = 7,
        username: str = None,
        miner=None,
    ):
        super(AnalyticsServer, self).__init__()
        check_assets()

        self.host     = host
        self.port     = port
        self.refresh  = refresh
        self.days_ago = days_ago
        self.username = username
        self.miner    = miner
        _miner        = self.miner

        def generate_log():
            global last_sent_log_index
            last_received = int(request.args.get("lastIndex", last_sent_log_index))
            log_path = os.path.join(Path().absolute(), "logs", f"{username}.log")
            try:
                with open(log_path, "r", encoding="utf-8") as lf:
                    content = lf.read()
                new_entries         = content[last_received:]
                last_sent_log_index = len(content)
                return Response(new_entries, status=200, mimetype="text/plain")
            except FileNotFoundError:
                return Response("Log file not found.", status=404, mimetype="text/plain")

        self.app = Flask(
            __name__,
            template_folder=os.path.join(Path().absolute(), "assets"),
            static_folder=os.path.join(Path().absolute(), "assets"),
        )

        self.app.add_url_rule("/", "index", index, defaults={"refresh": refresh, "days_ago": days_ago}, methods=["GET"])
        self.app.add_url_rule("/streamers",               "streamers", streamers,    methods=["GET"])
        self.app.add_url_rule("/json/<string:streamer>",  "json",      read_json,    methods=["GET"])
        self.app.add_url_rule("/json_all",                "json_all",  json_all,     methods=["GET"])
        self.app.add_url_rule("/log",                     "log",       generate_log, methods=["GET"])
        self.app.add_url_rule("/status",  "status",  make_status_handler(_miner), methods=["GET"])
        self.app.add_url_rule("/bets",    "bets",    bets,    methods=["GET"])
        self.app.add_url_rule("/summary", "summary", summary, methods=["GET"])
        self.app.add_url_rule("/config",                            "get_config",     get_config,      methods=["GET"])
        self.app.add_url_rule("/config",                            "save_config",    save_config,     methods=["POST"])
        self.app.add_url_rule("/config/streamer",                   "add_streamer",   add_streamer,    methods=["POST"])
        self.app.add_url_rule("/config/streamer/<string:username>", "patch_streamer", patch_streamer,  methods=["PATCH"])
        self.app.add_url_rule("/config/streamer/<string:username>", "del_streamer",   delete_streamer, methods=["DELETE"])

    def run(self):
        logger.info(f"Analytics running on http://{self.host}:{self.port}/",
                    extra={"emoji": ":globe_with_meridians:"})
        self.app.run(host=self.host, port=self.port, threaded=True, debug=False)