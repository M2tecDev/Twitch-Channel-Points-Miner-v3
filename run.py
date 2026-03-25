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
from TwitchChannelPointsMiner.classes.Discord import Discord
from TwitchChannelPointsMiner.classes.Matrix import Matrix
from TwitchChannelPointsMiner.classes.Telegram import Telegram
from TwitchChannelPointsMiner.classes.Webhook import Webhook
from TwitchChannelPointsMiner.classes.Pushover import Pushover
from TwitchChannelPointsMiner.classes.Gotify import Gotify

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


def build_notification_settings(notif_cfg: dict) -> dict:
    """Returns provider_name → instance for each enabled, configured provider."""
    result = {}
    if not notif_cfg:
        return result

    dc = notif_cfg.get("discord", {})
    if dc.get("enabled") and dc.get("webhook_api"):
        result["discord"] = Discord(dc["webhook_api"], dc.get("events", []))

    mx = notif_cfg.get("matrix", {})
    if mx.get("enabled") and mx.get("homeserver") and mx.get("room_id"):
        result["matrix"] = Matrix(
            mx.get("username", ""), mx.get("password", ""),
            mx["homeserver"], mx["room_id"],
            mx.get("events", [])
        )

    tg = notif_cfg.get("telegram", {})
    if tg.get("enabled") and tg.get("token") and tg.get("chat_id"):
        result["telegram"] = Telegram(
            tg["chat_id"], tg["token"],
            tg.get("events", []),
            tg.get("disable_notification", False)
        )

    wh = notif_cfg.get("webhook", {})
    if wh.get("enabled") and wh.get("endpoint"):
        result["webhook"] = Webhook(
            wh["endpoint"], wh.get("method", "GET"), wh.get("events", [])
        )

    po = notif_cfg.get("pushover", {})
    if po.get("enabled") and po.get("userkey") and po.get("token"):
        result["pushover"] = Pushover(
            po["userkey"], po["token"],
            po.get("priority", 0), po.get("sound", "pushover"),
            po.get("events", [])
        )

    gt = notif_cfg.get("gotify", {})
    if gt.get("enabled") and gt.get("endpoint"):
        result["gotify"] = Gotify(
            gt["endpoint"], gt.get("priority", 5), gt.get("events", [])
        )

    return result


# ── Config hot-reload watcher ─────────────────────────────────

def config_watcher(miner, startup_notif_cfg):
    _prev_notif_cfg = startup_notif_cfg
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

            # ── notification hot-reload ──────────────────
            new_notif_cfg = config.get("notifications", {})
            if new_notif_cfg != _prev_notif_cfg:
                _prev_notif_cfg = new_notif_cfg
                new_notifs = build_notification_settings(new_notif_cfg)
                Settings.logger.discord  = new_notifs.get("discord")
                Settings.logger.matrix   = new_notifs.get("matrix")
                Settings.logger.telegram = new_notifs.get("telegram")
                Settings.logger.webhook  = new_notifs.get("webhook")
                Settings.logger.pushover = new_notifs.get("pushover")
                Settings.logger.gotify   = new_notifs.get("gotify")
                log.debug("[ConfigWatcher] Notification settings reloaded")

        except Exception as exc:
            logging.getLogger(__name__).warning(f"[ConfigWatcher] {exc}")


# ── Main ─────────────────────────────────────────────────────

config        = load_config()
miner_cfg     = config.get("miner", {})
analytics_cfg = config.get("analytics", {"host": "0.0.0.0", "port": 5000, "refresh": 5, "days_ago": 7})
global_cfg    = config.get("global_settings")

_notifs = build_notification_settings(config.get("notifications", {}))

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
        discord=_notifs.get("discord"),
        matrix=_notifs.get("matrix"),
        telegram=_notifs.get("telegram"),
        webhook=_notifs.get("webhook"),
        pushover=_notifs.get("pushover"),
        gotify=_notifs.get("gotify"),
    ),
    streamer_settings=build_streamer_settings(global_cfg),
)

_watcher = threading.Thread(
    target=config_watcher, args=(twitch_miner, config.get("notifications", {})), daemon=True, name="ConfigWatcher"
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