# -*- coding: utf-8 -*-
"""
Analytics data routes: streamers, JSON data, bets, summary, status.
Split from AnalyticsServer.py — functions are unchanged.
"""
import json
import logging
import os
from datetime import datetime

import pandas as pd
from flask import Response, render_template, request

from TwitchChannelPointsMiner.classes.Settings import Settings
from TwitchChannelPointsMiner.classes.routes.config_routes import (
    _load_or_default,
    streamers_available,
)

logger = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────

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
    return {f.removesuffix(".json") for f in streamers_available()}


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


# ── JSON data routes ──────────────────────────────────────────

def read_json(streamer, return_response=True):
    start_date = request.args.get("startDate", type=str)
    end_date   = request.args.get("endDate",   type=str)
    path       = Settings.analytics_path
    streamer   = streamer if streamer.endswith(".json") else f"{streamer}.json"
    fpath      = os.path.join(path, streamer)

    if not os.path.exists(fpath):
        err = {"error": f"File '{streamer}' not found."}
        # Only log as ERROR for real HTTP requests — internal calls (return_response=False)
        # happen routinely for new streamers that haven't collected data yet.
        if return_response:
            logger.error(err["error"])
            return Response(json.dumps(err), status=404, mimetype="application/json")
        else:
            logger.debug(err["error"])
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
            {"name": s.removesuffix(".json"), "data": read_json(s, return_response=False)}
            for s in streamers_available()
        ]),
        status=200, mimetype="application/json",
    )


# ── Page routes ───────────────────────────────────────────────

def index(refresh=5, days_ago=7):
    return render_template("charts.html", refresh=(refresh * 60 * 1000), daysAgo=days_ago)


def streamers():
    """
    Return all enabled streamers from config — including newly added ones
    that don't have a .json analytics file yet (they show 0 points).
    Deleted/disabled streamers are excluded even if their file still exists.
    """
    config  = _load_or_default()
    active  = _active_streamer_names()
    on_disk = {s.removesuffix(".json") for s in streamers_available()}
    result  = []
    for entry in sorted(config.get("streamers", []), key=lambda e: e.get("username", "")):
        name = entry.get("username", "").strip().lower()
        if not name or name not in active:
            continue
        if name in on_disk:
            result.append({
                "name":          f"{name}.json",
                "points":        get_challenge_points(f"{name}.json"),
                "last_activity": get_last_activity(f"{name}.json"),
            })
        else:
            # Newly added streamer — no data file yet, show with zeroes
            result.append({
                "name":          f"{name}.json",
                "points":        0,
                "last_activity": 0,
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
        name = fname.removesuffix(".json")
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
        name = fname.removesuffix(".json")
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
