# -*- coding: utf-8 -*-
"""
Config CRUD routes and shared helpers.
Split from AnalyticsServer.py — functions are unchanged.
"""
import copy
import json
import logging
import os
import re
from pathlib import Path
from urllib.parse import quote as url_quote
from urllib.parse import urlencode

import requests

from flask import Response, request

from TwitchChannelPointsMiner.classes.Settings import Settings
from TwitchChannelPointsMiner.classes.Discord import Discord
from TwitchChannelPointsMiner.classes.Matrix import Matrix
from TwitchChannelPointsMiner.classes.Telegram import Telegram
from TwitchChannelPointsMiner.classes.Webhook import Webhook
from TwitchChannelPointsMiner.classes.Pushover import Pushover
from TwitchChannelPointsMiner.classes.Gotify import Gotify

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
    "notifications": {
        "discord":  {
            "enabled": False, "webhook_api": "",
            "events": ["BET_WIN", "BET_LOSE", "STREAMER_ONLINE", "STREAMER_OFFLINE"]
        },
        "matrix":   {
            "enabled": False, "username": "", "password": "",
            "homeserver": "", "room_id": "",
            "events": ["BET_WIN", "BET_LOSE", "STREAMER_ONLINE", "STREAMER_OFFLINE"]
        },
        "telegram": {
            "enabled": False, "chat_id": "", "token": "",
            "disable_notification": False,
            "events": ["BET_WIN", "BET_LOSE", "STREAMER_ONLINE", "STREAMER_OFFLINE"]
        },
        "webhook":  {
            "enabled": False, "endpoint": "", "method": "GET",
            "events": ["BET_WIN", "BET_LOSE"]
        },
        "pushover": {
            "enabled": False, "userkey": "", "token": "",
            "priority": 0, "sound": "pushover",
            "events": ["BET_WIN", "BET_LOSE"]
        },
        "gotify":   {
            "enabled": False, "endpoint": "",
            "priority": 5,
            "events": ["BET_WIN", "BET_LOSE"]
        },
    },
}


# ── Auth helpers ──────────────────────────────────────────────

def _get_config_password() -> str:
    """Reads the settings_password from config.json. Returns '' if not set."""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        # Passwort kann auf zwei Ebenen stehen (Kompatibilität)
        pw = cfg.get("miner", {}).get("settings_password") or cfg.get("settings_password", "")
        return str(pw).strip() if pw else ""
    except Exception:
        return ""


def _check_auth() -> bool:
    """
    Checks whether the request contains the correct password.
    If no password is configured, everything is allowed.
    Password is read ONLY from the HTTP header X-Settings-Password
    to avoid consuming the request body before the route handler reads it.
    """
    pw = _get_config_password()
    if not pw:
        return True

    header_pw = request.headers.get("X-Settings-Password", "")
    return header_pw == pw


def _auth_error() -> Response:
    return Response(
        json.dumps({"error": "Unauthorized. Wrong or missing settings_password."}),
        status=401,
        mimetype="application/json",
    )


def _build_notif_objects(notif_cfg: dict) -> dict:
    """Builds provider_name → instance for each enabled, configured provider.
    Duplicates build_notification_settings() from run.py to avoid circular import."""
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


def _send_test_to(service: str, cfg: dict, msg: str) -> None:
    """Fires each provider's HTTP request directly, bypassing send()'s event-list filter.
    Raises on HTTP error or invalid credentials."""
    if service == "discord":
        r = requests.post(
            url=cfg["webhook_api"],
            json={
                "content": msg,
                "username": "Twitch Channel Points Miner",
                "avatar_url": "https://i.imgur.com/X9fEkhT.png",
            },
        )
        r.raise_for_status()

    elif service == "matrix":
        hs = cfg["homeserver"].strip().rstrip("/")
        if "://" in hs:
            hs = hs.split("://", 1)[1]
        login_resp = requests.post(
            url=f"https://{hs}/_matrix/client/r0/login",
            json={"user": cfg["username"], "password": cfg["password"],
                  "type": "m.login.password"},
            timeout=10,
        )
        token = login_resp.json().get("access_token")
        if not token:
            raise ValueError(f"Matrix login failed: {login_resp.json()}")
        room = url_quote(cfg["room_id"])
        r = requests.post(
            url=f"https://{hs}/_matrix/client/r0/rooms/{room}/send/m.room.message?access_token={token}",
            json={"body": msg, "msgtype": "m.text"},
        )
        r.raise_for_status()

    elif service == "telegram":
        r = requests.post(
            url=f"https://api.telegram.org/bot{cfg['token']}/sendMessage",
            data={
                "chat_id": cfg["chat_id"],
                "text": msg,
                "disable_web_page_preview": True,
                "disable_notification": cfg.get("disable_notification", False),
            },
        )
        r.raise_for_status()

    elif service == "webhook":
        url = cfg["endpoint"] + "?" + urlencode({"event_name": "TEST", "message": msg})
        if cfg.get("method", "GET").upper() == "POST":
            r = requests.post(url=url)
        else:
            r = requests.get(url=url)
        r.raise_for_status()

    elif service == "pushover":
        r = requests.post(
            url="https://api.pushover.net/1/messages.json",
            data={
                "user": cfg["userkey"],
                "token": cfg["token"],
                "message": msg,
                "title": "Twitch Channel Points Miner",
                "priority": cfg.get("priority", 0),
                "sound": cfg.get("sound", "pushover"),
            },
        )
        r.raise_for_status()

    elif service == "gotify":
        r = requests.post(
            url=cfg["endpoint"],
            data={"message": msg, "priority": cfg.get("priority", 5)},
        )
        r.raise_for_status()

    else:
        raise ValueError(f"Unknown notification service: {service}")


# ── Validation helpers ────────────────────────────────────────

def _is_valid_twitch_username(username: str) -> bool:
    """Erste Verteidigungslinie: Regex-Check bevor überhaupt ein API-Call passiert."""
    return bool(re.match(r'^[a-z0-9_]{1,25}$', username))


def _streamer_exists_on_twitch(username: str) -> bool:
    """Prüft über die Twitch Helix API ob der User existiert."""
    try:
        from TwitchChannelPointsMiner.constants import CLIENT_ID

        r = requests.get(
            "https://gql.twitch.tv/gql",
            json=[{
                "operationName": "ReportMenuItem",
                "variables": {"channelLogin": username},
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "8f3628981255345ca5e5e56c5e3c0a2b62a66a85e4b66e25e8b8f45bbca33cc0"
                    }
                }
            }],
            headers={"Client-Id": CLIENT_ID},
            timeout=5
        )

        if r.status_code == 200:
            data = r.json()
            # Wenn der User existiert, kommt ein User-Objekt zurück
            # Wenn nicht, ist es None
            if isinstance(data, list) and len(data) > 0:
                user = data[0].get("data", {}).get("user")
                return user is not None
        return False
    except Exception:
        # Bei Netzwerk-Fehler: lieber durchlassen als blocken
        # Der Regex-Check hat ja schon die schlimmen Sachen gefiltert
        return True


# ── Shared helpers (used by analytics_routes too) ─────────────

def _load_or_default() -> dict:
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"config.json unreadable ({e}), using defaults")
    return copy.deepcopy(DEFAULT_CONFIG)


def streamers_available() -> list[str]:
    try:
        return [
            f for f in os.listdir(Settings.analytics_path)
            if os.path.isfile(os.path.join(Settings.analytics_path, f)) and f.endswith(".json")
        ]
    except Exception:
        return []


def _auto_fill_streamers(config: dict) -> None:
    if not config.get("streamers"):
        config["streamers"] = [
            {"username": fname.removesuffix(".json"), "enabled": True, "settings": None}
            for fname in sorted(streamers_available())
        ]


# ── Config CRUD routes ────────────────────────────────────────

def get_config():
    config = _load_or_default()
    _auto_fill_streamers(config)

    safe_config = copy.deepcopy(config)

    if "miner" in safe_config:
        safe_config["miner"].pop("password", None)

    has_password = False
    if safe_config.get("miner", {}).get("settings_password"):
        has_password = True
        safe_config["miner"].pop("settings_password", None)
    if safe_config.get("settings_password"):
        has_password = True
        safe_config.pop("settings_password", None)

    safe_config["has_settings_password"] = has_password

    return Response(json.dumps(safe_config, indent=2),
                    status=200, mimetype="application/json")


def save_config():
    if not _check_auth():
        return _auth_error()
    data = request.get_json(force=True)
    if not data:
        return Response(json.dumps({"error": "No JSON body"}), status=400, mimetype="application/json")
    try:
        # Re-inject sensitive fields from disk — the client never receives them
        # (get_config() strips them for security), so they must be preserved
        # here to avoid erasing passwords on every settings save.
        existing = _load_or_default()

        # Twitch login password (miner.password)
        existing_login_pw = existing.get("miner", {}).get("password")
        if existing_login_pw:
            data.setdefault("miner", {})["password"] = existing_login_pw

        # Settings UI password (settings_password or miner.settings_password)
        existing_settings_pw = (
            existing.get("miner", {}).get("settings_password")
            or existing.get("settings_password", "")
        )
        if existing_settings_pw:
            if existing.get("miner", {}).get("settings_password"):
                data.setdefault("miner", {})["settings_password"] = existing_settings_pw
            else:
                data["settings_password"] = existing_settings_pw

        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        logger.info("config.json updated via web UI")
        return Response(json.dumps({"status": "ok", "message": "Saved. Hot-reload in ~2s."}),
                        status=200, mimetype="application/json")
    except Exception as e:
        return Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")


def add_streamer():
    if not _check_auth():
        return _auth_error()
    body = request.get_json(force=True)
    if not body or "username" not in body:
        return Response(json.dumps({"error": "username required"}), status=400, mimetype="application/json")
    config   = _load_or_default()
    username = body["username"].strip().lower()
    if not _is_valid_twitch_username(username):
        return Response(
            json.dumps({"error": f"Invalid username format. "
                        "Only a-z, 0-9 and _ allowed."}),
            status=400, mimetype="application/json"
        )
    if not _streamer_exists_on_twitch(username):
        return Response(
            json.dumps({"error": f"Streamer '{username}' not found on Twitch."}),
            status=404, mimetype="application/json"
        )
    config = _load_or_default()
    if username in [s["username"] for s in config.get("streamers", [])]:
        return Response(json.dumps({"error": f"'{username}' already in list"}),
                        status=409, mimetype="application/json")
    if not username:
        return Response(json.dumps({"error": "username must not be empty"}), status=400, mimetype="application/json")
    if username in [s["username"] for s in config.get("streamers", [])]:
        return Response(json.dumps({"error": f"'{username}' already in list"}), status=409, mimetype="application/json")
    config.setdefault("streamers", []).append({"username": username, "enabled": True, "settings": body.get("settings")})
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        logger.info(f"Streamer '{username}' added via web UI")
    except Exception as e:
        logger.error(f"Failed to save config after add_streamer: {e}")
        return Response(json.dumps({"error": f"Failed to write config: {e}"}), status=500, mimetype="application/json")
    return Response(json.dumps({"status": "ok", "message": f"'{username}' added. Miner restarts in ~10s."}),
                    status=201, mimetype="application/json")


def patch_streamer(username: str):
    if not _check_auth():
        return _auth_error()
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
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        logger.info(f"Streamer '{username}' patched via web UI")
    except Exception as e:
        logger.error(f"Failed to save config after patch_streamer: {e}")
        return Response(json.dumps({"error": f"Failed to write config: {e}"}), status=500, mimetype="application/json")
    return Response(json.dumps({"status": "ok", "message": f"'{username}' updated."}),
                    status=200, mimetype="application/json")


def delete_streamer(username: str):
    if not _check_auth():
        return _auth_error()
    config = _load_or_default()
    _auto_fill_streamers(config)
    before = len(config.get("streamers", []))
    config["streamers"] = [s for s in config.get("streamers", []) if s["username"] != username]
    if len(config["streamers"]) == before:
        return Response(json.dumps({"error": f"'{username}' not found"}), status=404, mimetype="application/json")
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        logger.info(f"Streamer '{username}' deleted via web UI")
    except Exception as e:
        logger.error(f"Failed to save config after delete_streamer: {e}")
        return Response(json.dumps({"error": f"Failed to write config: {e}"}), status=500, mimetype="application/json")
    return Response(json.dumps({"status": "ok", "message": f"'{username}' removed. Miner restarts in ~10s."}),
                    status=200, mimetype="application/json")


def test_notifications():
    """POST /config/notifications/test
    Sends a test message to a single provider specified in the JSON body:
      { "service": "discord" }
    Always returns HTTP 200 with a per-provider result dict:
      { "discord": "ok" }  or  { "discord": "error: 403 Forbidden" }
    """
    if not _check_auth():
        return _auth_error()

    body = request.get_json(silent=True) or {}
    service = body.get("service", "")
    if not service:
        return Response(
            json.dumps({"error": "Missing 'service' in request body"}),
            status=400, mimetype="application/json"
        )

    cfg = _load_or_default()
    notif_cfg = cfg.get("notifications", {})
    TEST_MESSAGE = "\U0001f514 Test Notification from Twitch Channel Points Miner"

    provider_cfg = notif_cfg.get(service)
    if not isinstance(provider_cfg, dict) or not provider_cfg.get("enabled"):
        return Response(
            json.dumps({service: "error: provider not found or not enabled"}),
            status=200, mimetype="application/json"
        )

    try:
        _send_test_to(service, provider_cfg, TEST_MESSAGE)
        result = "ok"
    except Exception as e:
        result = f"error: {e}"

    return Response(json.dumps({service: result}), status=200, mimetype="application/json")
