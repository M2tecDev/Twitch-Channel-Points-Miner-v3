# -*- coding: utf-8 -*-
"""
run.py  —  Config-driven entry point for Twitch Channel Points Miner v3
=========================================================================
Start via:   python wrapper.py   (recommended — handles auto-restart)
Or directly: python run.py       (no auto-restart on streamer list changes)

All settings are read from config.json.
Settings changes (bet strategy, toggles, …) are hot-reloaded every 2 seconds.
Streamer list changes (add / remove) trigger a restart via wrapper.py.
"""

import json
import logging
import os
import threading
import time
from pathlib import Path

from TwitchChannelPointsMiner import TwitchChannelPointsMiner
from TwitchChannelPointsMiner.classes.Chat import ChatPresence
from TwitchChannelPointsMiner.classes.Settings import Priority, FollowersOrder, Settings
from TwitchChannelPointsMiner.utils import set_default_settings
from TwitchChannelPointsMiner.classes.entities.Bet import (
    BetSettings, Condition, DelayMode, FilterCondition, OutcomeKeys, Strategy,
)
from TwitchChannelPointsMiner.classes.entities.Streamer import Streamer, StreamerSettings
from TwitchChannelPointsMiner.logger import LoggerSettings

CONFIG_PATH = os.path.join(Path(__file__).parent.absolute(), "config.json")


# ── Helpers ───────────────────────────────────────────────────

def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def build_filter_condition(fc_cfg):
    if not fc_cfg:
        return None
    outcome_map = {
        "PERCENTAGE_USERS": OutcomeKeys.PERCENTAGE_USERS,
        "ODDS_PERCENTAGE":  OutcomeKeys.ODDS_PERCENTAGE,
        "ODDS":             OutcomeKeys.ODDS,
        "TOP_POINTS":       OutcomeKeys.TOP_POINTS,
        "TOTAL_USERS":      OutcomeKeys.TOTAL_USERS,
        "TOTAL_POINTS":     OutcomeKeys.TOTAL_POINTS,
        "DECISION_USERS":   OutcomeKeys.DECISION_USERS,
        "DECISION_POINTS":  OutcomeKeys.DECISION_POINTS,
    }
    return FilterCondition(
        by=outcome_map.get(fc_cfg.get("by", "TOTAL_USERS"), OutcomeKeys.TOTAL_USERS),
        where=Condition[fc_cfg.get("where", "LTE")],
        value=fc_cfg.get("value", 800),
    )


def build_bet_settings(bet_cfg):
    if not bet_cfg:
        return BetSettings()
    return BetSettings(
        strategy=Strategy[bet_cfg.get("strategy", "SMART")],
        percentage=bet_cfg.get("percentage", 5),
        percentage_gap=bet_cfg.get("percentage_gap", 20),
        max_points=bet_cfg.get("max_points", 50000),
        minimum_points=bet_cfg.get("minimum_points", 0),
        stealth_mode=bet_cfg.get("stealth_mode", False),
        delay=bet_cfg.get("delay", 6),
        delay_mode=DelayMode[bet_cfg.get("delay_mode", "FROM_END")],
        filter_condition=build_filter_condition(bet_cfg.get("filter_condition")),
    )


def build_streamer_settings(s_cfg):
    if not s_cfg:
        return None
    chat_val = s_cfg.get("chat")
    return StreamerSettings(
        make_predictions=s_cfg.get("make_predictions"),
        follow_raid=s_cfg.get("follow_raid"),
        claim_drops=s_cfg.get("claim_drops"),
        claim_moments=s_cfg.get("claim_moments"),
        watch_streak=s_cfg.get("watch_streak"),
        community_goals=s_cfg.get("community_goals"),
        chat=ChatPresence[chat_val] if chat_val else None,
        bet=build_bet_settings(s_cfg.get("bet")),
    )


# ── Config hot-reload watcher ─────────────────────────────────

def config_watcher(miner):
    last_mtime = 0.0
    log = logging.getLogger(__name__)
    while True:
        time.sleep(2)
        try:
            mtime = os.path.getmtime(CONFIG_PATH)
            if mtime == last_mtime:
                continue
            last_mtime = mtime

            config = load_config()
            if not miner.streamers:
                continue

            streamer_map = {s.username: s for s in miner.streamers}

            for sc in config.get("streamers", []):
                name = sc.get("username", "").strip().lower()
                if name not in streamer_map or not sc.get("enabled", True):
                    continue
                new_settings = build_streamer_settings(sc.get("settings"))
                if new_settings is not None:
                    # Fill None fields from global defaults so partial per-streamer
                    # configs don't silently disable follow_raid, claim_drops, etc.
                    new_settings = set_default_settings(new_settings, Settings.streamer_settings)
                    new_settings.bet = set_default_settings(new_settings.bet, Settings.streamer_settings.bet)
                    streamer_map[name].settings = new_settings
                    log.debug(f"[ConfigWatcher] Hot-reloaded settings for '{name}'")

        except Exception as exc:
            logging.getLogger(__name__).warning(f"[ConfigWatcher] {exc}")


# ── Main ─────────────────────────────────────────────────────

config        = load_config()
miner_cfg     = config.get("miner", {})
analytics_cfg = config.get("analytics", {"host": "0.0.0.0", "port": 5000, "refresh": 5, "days_ago": 7})
global_cfg    = config.get("global_settings")

twitch_miner = TwitchChannelPointsMiner(
    username=miner_cfg.get("username", "your-twitch-username"),
    password=miner_cfg.get("password"),
    claim_drops_startup=miner_cfg.get("claim_drops_startup", False),
    enable_analytics=miner_cfg.get("enable_analytics", True),
    disable_ssl_cert_verification=miner_cfg.get("disable_ssl_cert_verification", False),
    disable_at_in_nickname=miner_cfg.get("disable_at_in_nickname", False),
    priority=[Priority[p] for p in miner_cfg.get("priority", ["STREAK", "DROPS", "ORDER"])],
    logger_settings=LoggerSettings(
        save=True,
        console_level=logging.INFO,
        # FIX #9: file_level=INFO prevents DEBUG spam in the web log viewer
        file_level=logging.INFO,
        auto_clear=True,
        emoji=True,
        colored=True,
    ),
    streamer_settings=build_streamer_settings(global_cfg),
)

_watcher = threading.Thread(
    target=config_watcher, args=(twitch_miner,), daemon=True, name="ConfigWatcher"
)
_watcher.start()

twitch_miner.analytics(
    host=analytics_cfg.get("host",     "0.0.0.0"),
    port=analytics_cfg.get("port",     5000),
    refresh=analytics_cfg.get("refresh",   5),
    days_ago=analytics_cfg.get("days_ago", 7),
)

_streamers = [
    Streamer(s["username"], settings=build_streamer_settings(s.get("settings")))
    for s in config.get("streamers", [])
    if s.get("enabled", True)
]

twitch_miner.mine(_streamers)