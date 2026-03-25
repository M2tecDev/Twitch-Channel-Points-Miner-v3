# Notification System Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken notification pipeline so settings saved in the web UI are loaded into the runtime, hot-reloaded on change, and verifiable via a "Send Test" button.

**Architecture:** `run.py` reads `config["notifications"]`, constructs provider objects (Discord, Matrix, etc.) via `build_notification_settings()`, and passes them into `LoggerSettings`. The `config_watcher` thread detects notification config changes and rebuilds providers in place. A new `POST /config/notifications/test` route fires test messages to all enabled providers without going through the event-filter logic.

**Tech Stack:** Python 3, Flask, `requests`, pytest + unittest.mock; vanilla JS (no framework).

**Spec:** `docs/superpowers/specs/2026-03-25-notification-system-fix-design.md`

---

## File Map

| File | Role in this change |
|------|---------------------|
| `TwitchChannelPointsMiner/classes/Discord.py` | Switch payload to `json=`; add error logging |
| `TwitchChannelPointsMiner/classes/Matrix.py` | Normalise homeserver URL; wrap login + send in try/except |
| `TwitchChannelPointsMiner/classes/routes/config_routes.py` | Add `notifications` to DEFAULT_CONFIG; add `_build_notif_objects`, `_send_test_to`, `test_notifications` |
| `TwitchChannelPointsMiner/classes/AnalyticsServer.py` | Register `POST /config/notifications/test` route |
| `run.py` | Add `build_notification_settings()`; wire into `LoggerSettings`; extend `config_watcher` with delta-check |
| `assets/script.js` | Add "Send Test" button + async click handler to each notification card |
| `tests/test_notifications.py` | Unit tests for all backend changes |

---

## Task 1: Fix Discord payload and add error logging

**Files:**
- Modify: `TwitchChannelPointsMiner/classes/Discord.py`
- Test: `tests/test_notifications.py` (create)

- [ ] **Step 1: Create the test file with a failing test**

Create `tests/__init__.py` (empty) and `tests/test_notifications.py`:

```python
# tests/test_notifications.py
from unittest.mock import MagicMock, patch
import pytest

from TwitchChannelPointsMiner.classes.Discord import Discord
from TwitchChannelPointsMiner.classes.Settings import Events


def test_discord_send_uses_json_payload():
    """Discord.send() must use json= kwarg so Content-Type is application/json."""
    discord = Discord(
        webhook_api="https://discord.com/api/webhooks/fake/url",
        events=["BET_WIN"],
    )
    mock_response = MagicMock()
    mock_response.ok = True
    with patch("requests.post", return_value=mock_response) as mock_post:
        discord.send("hello", Events.BET_WIN)
        call_kwargs = mock_post.call_args
        # Must use json= kwarg, NOT data=
        assert "json" in call_kwargs.kwargs, "send() must use json= not data="
        assert "data" not in call_kwargs.kwargs, "send() must not use data="


def test_discord_send_logs_warning_on_bad_status(caplog):
    """Discord.send() logs a warning when the webhook returns non-2xx."""
    import logging
    discord = Discord(
        webhook_api="https://discord.com/api/webhooks/fake/url",
        events=["BET_WIN"],
    )
    mock_response = MagicMock()
    mock_response.ok = False
    mock_response.status_code = 400
    mock_response.text = "Bad Request"
    with patch("requests.post", return_value=mock_response):
        with caplog.at_level(logging.WARNING):
            discord.send("hello", Events.BET_WIN)
    assert any("400" in r.message for r in caplog.records), \
        "Expected warning with status code"


def test_discord_send_skips_unsubscribed_event():
    """Discord.send() must not fire if the event is not in the subscribed list."""
    discord = Discord(
        webhook_api="https://discord.com/api/webhooks/fake/url",
        events=["BET_WIN"],
    )
    with patch("requests.post") as mock_post:
        discord.send("hello", Events.BET_LOSE)
        mock_post.assert_not_called()
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd "D:\Git Repo\Twitch-Channel-Points-Miner-v3\.claude\worktrees\quirky-goldstine"
python -m pytest tests/test_notifications.py::test_discord_send_uses_json_payload -v
```

Expected: `FAILED` — `AssertionError: send() must use json= not data=`

- [ ] **Step 3: Update `Discord.py`**

Replace the entire `send()` method. The file is 25 lines — replace it in full:

```python
from textwrap import dedent
import logging

import requests

from TwitchChannelPointsMiner.classes.Settings import Events


class Discord(object):
    __slots__ = ["webhook_api", "events"]

    def __init__(self, webhook_api: str, events: list):
        self.webhook_api = webhook_api
        self.events = [str(e) for e in events]

    def send(self, message: str, event: Events) -> None:
        if str(event) in self.events:
            try:
                r = requests.post(
                    url=self.webhook_api,
                    json={
                        "content": dedent(message),
                        "username": "Twitch Channel Points Miner",
                        "avatar_url": "https://i.imgur.com/X9fEkhT.png",
                    },
                )
                if not r.ok:
                    logging.getLogger(__name__).warning(
                        f"Discord webhook {r.status_code}: {r.text[:200]}"
                    )
            except Exception as e:
                logging.getLogger(__name__).warning(f"Discord send failed: {e}")
```

- [ ] **Step 4: Run all three Discord tests**

```bash
python -m pytest tests/test_notifications.py::test_discord_send_uses_json_payload \
                 tests/test_notifications.py::test_discord_send_logs_warning_on_bad_status \
                 tests/test_notifications.py::test_discord_send_skips_unsubscribed_event -v
```

Expected: all 3 `PASSED`

- [ ] **Step 5: Commit**

```bash
git add TwitchChannelPointsMiner/classes/Discord.py tests/test_notifications.py tests/__init__.py
git commit -m "fix: Discord.py — switch to json= payload, add error logging"
```

---

## Task 2: Fix Matrix homeserver normalisation and error handling

**Files:**
- Modify: `TwitchChannelPointsMiner/classes/Matrix.py`
- Test: `tests/test_notifications.py` (extend)

- [ ] **Step 1: Add failing Matrix tests**

Append to `tests/test_notifications.py`:

```python
# ── Matrix tests ─────────────────────────────────────────────

from TwitchChannelPointsMiner.classes.Matrix import Matrix


@pytest.mark.parametrize("raw_homeserver,expected_stored", [
    ("koridev.tail183fd1.ts.net",          "koridev.tail183fd1.ts.net"),
    ("https://koridev.tail183fd1.ts.net",  "koridev.tail183fd1.ts.net"),
    ("http://koridev.tail183fd1.ts.net",   "koridev.tail183fd1.ts.net"),
    ("https://matrix.example.com/",        "matrix.example.com"),
])
def test_matrix_homeserver_normalisation(raw_homeserver, expected_stored):
    """Matrix.__init__ stores the bare hostname regardless of protocol prefix."""
    login_ok = {"access_token": "tok_abc"}
    with patch("requests.post") as mock_post:
        mock_post.return_value.json.return_value = login_ok
        mock_post.return_value.status_code = 200
        m = Matrix("user", "pass", raw_homeserver, "!room:example.com", [])
    assert m.homeserver == expected_stored, \
        f"Expected '{expected_stored}', got '{m.homeserver}'"


def test_matrix_login_failure_sets_token_none_and_logs(caplog):
    """When Matrix login returns no access_token, token is None and warning is logged."""
    import logging
    with patch("requests.post") as mock_post:
        mock_post.return_value.json.return_value = {"errcode": "M_FORBIDDEN"}
        mock_post.return_value.status_code = 403
        with caplog.at_level(logging.WARNING):
            m = Matrix("user", "wrongpass", "matrix.example.com", "!room:example.com", [])
    assert m.access_token is None
    assert any("login failed" in r.message.lower() for r in caplog.records)


def test_matrix_send_skips_when_no_token():
    """Matrix.send() must not fire an HTTP request when access_token is None."""
    with patch("requests.post") as mock_post:
        mock_post.return_value.json.return_value = {}  # login returns no token
        m = Matrix("user", "pass", "matrix.example.com", "!room:example.com",
                   ["BET_WIN"])
    m.access_token = None  # force None in case patching varies
    with patch("requests.post") as mock_send:
        m.send("hello", Events.BET_WIN)
        mock_send.assert_not_called()


def test_matrix_send_logs_warning_on_bad_status(caplog):
    """Matrix.send() logs a warning when the room message POST returns non-2xx."""
    import logging
    # Successful login
    login_resp = MagicMock()
    login_resp.json.return_value = {"access_token": "tok_abc"}
    login_resp.status_code = 200
    # Failed send
    send_resp = MagicMock()
    send_resp.ok = False
    send_resp.status_code = 403
    send_resp.text = "Forbidden"

    with patch("requests.post", side_effect=[login_resp, send_resp]):
        m = Matrix("user", "pass", "matrix.example.com", "!room:example.com",
                   ["BET_WIN"])
    with patch("requests.post", return_value=send_resp):
        with caplog.at_level(logging.WARNING):
            m.send("hello", Events.BET_WIN)
    assert any("403" in r.message for r in caplog.records)
```

- [ ] **Step 2: Run Matrix tests to confirm they fail**

```bash
python -m pytest tests/test_notifications.py -k "matrix" -v
```

Expected: all 4 Matrix tests `FAILED`

- [ ] **Step 3: Rewrite `Matrix.py`**

Replace the full file:

```python
from textwrap import dedent
import logging

import requests
from urllib.parse import quote

from TwitchChannelPointsMiner.classes.Settings import Events

log = logging.getLogger(__name__)


class Matrix(object):
    __slots__ = ["access_token", "homeserver", "room_id", "events"]

    def __init__(self, username: str, password: str, homeserver: str, room_id: str, events: list):
        # Normalise homeserver — strip any protocol prefix; f-strings below add https://
        hs = homeserver.strip().rstrip("/")
        if "://" in hs:
            hs = hs.split("://", 1)[1]
        self.homeserver = hs

        self.room_id = quote(room_id)
        self.events = [str(e) for e in events]

        try:
            resp = requests.post(
                url=f"https://{self.homeserver}/_matrix/client/r0/login",
                json={
                    "user": username,
                    "password": password,
                    "type": "m.login.password"
                },
                timeout=10,
            )
            body = resp.json()
            self.access_token = body.get("access_token")
            if not self.access_token:
                log.warning(
                    f"Matrix login failed (HTTP {resp.status_code}). "
                    f"Check username/password/homeserver. Response: {body}"
                )
        except Exception as e:
            log.warning(f"Matrix login error: {e}")
            self.access_token = None

    def send(self, message: str, event: Events) -> None:
        if str(event) not in self.events or not self.access_token:
            return
        try:
            r = requests.post(
                url=(
                    f"https://{self.homeserver}/_matrix/client/r0/rooms/"
                    f"{self.room_id}/send/m.room.message"
                    f"?access_token={self.access_token}"
                ),
                json={"body": dedent(message), "msgtype": "m.text"},
            )
            if not r.ok:
                log.warning(f"Matrix send {r.status_code}: {r.text[:200]}")
        except Exception as e:
            log.warning(f"Matrix send failed: {e}")
```

- [ ] **Step 4: Run all Matrix tests**

```bash
python -m pytest tests/test_notifications.py -k "matrix" -v
```

Expected: all 4 `PASSED`

- [ ] **Step 5: Run full test suite so far**

```bash
python -m pytest tests/test_notifications.py -v
```

Expected: all 7 tests `PASSED`

- [ ] **Step 6: Commit**

```bash
git add TwitchChannelPointsMiner/classes/Matrix.py tests/test_notifications.py
git commit -m "fix: Matrix.py — homeserver URL normalisation, login/send error handling"
```

---

## Task 3: Update config_routes.py — DEFAULT_CONFIG, builder, test dispatcher, route

**Files:**
- Modify: `TwitchChannelPointsMiner/classes/routes/config_routes.py`
- Test: `tests/test_notifications.py` (extend)

- [ ] **Step 1: Add failing tests for config_routes**

Append to `tests/test_notifications.py`:

```python
# ── config_routes tests ──────────────────────────────────────

from TwitchChannelPointsMiner.classes.routes.config_routes import (
    DEFAULT_CONFIG,
    _build_notif_objects,
    _send_test_to,
)


def test_default_config_has_notifications_key():
    """DEFAULT_CONFIG must include the notifications key with all 6 providers."""
    assert "notifications" in DEFAULT_CONFIG
    for provider in ("discord", "matrix", "telegram", "webhook", "pushover", "gotify"):
        assert provider in DEFAULT_CONFIG["notifications"], \
            f"Missing provider '{provider}' in DEFAULT_CONFIG['notifications']"


def test_default_config_notifications_are_disabled():
    """All providers start disabled so new installs don't send noise."""
    for provider, cfg in DEFAULT_CONFIG["notifications"].items():
        assert cfg.get("enabled") is False, \
            f"Provider '{provider}' should default to enabled=False"


def test_build_notif_objects_returns_discord_when_enabled():
    """_build_notif_objects builds a Discord instance when enabled + webhook_api set."""
    notif_cfg = {
        "discord": {
            "enabled": True,
            "webhook_api": "https://discord.com/api/webhooks/123/abc",
            "events": ["BET_WIN"],
        }
    }
    objects = _build_notif_objects(notif_cfg)
    from TwitchChannelPointsMiner.classes.Discord import Discord
    assert "discord" in objects
    assert isinstance(objects["discord"], Discord)


def test_build_notif_objects_skips_disabled_provider():
    """_build_notif_objects does not build an object for disabled providers."""
    notif_cfg = {
        "discord": {
            "enabled": False,
            "webhook_api": "https://discord.com/api/webhooks/123/abc",
            "events": ["BET_WIN"],
        }
    }
    objects = _build_notif_objects(notif_cfg)
    assert "discord" not in objects


def test_build_notif_objects_skips_provider_missing_required_field():
    """_build_notif_objects does not build Discord if webhook_api is empty."""
    notif_cfg = {
        "discord": {"enabled": True, "webhook_api": "", "events": ["BET_WIN"]}
    }
    objects = _build_notif_objects(notif_cfg)
    assert "discord" not in objects


def test_send_test_to_discord_uses_json(monkeypatch):
    """_send_test_to('discord', ...) must POST with json= payload."""
    calls = []

    class FakeResp:
        status_code = 204
        def raise_for_status(self): pass

    def fake_post(url, json=None, data=None, **kw):
        calls.append({"url": url, "json": json, "data": data})
        return FakeResp()

    monkeypatch.setattr("requests.post", fake_post)
    cfg = {"webhook_api": "https://discord.com/api/webhooks/123/abc"}
    _send_test_to("discord", cfg, "test msg")
    assert calls, "Expected requests.post to be called"
    assert calls[0]["json"] is not None, "Discord test must use json="
    assert calls[0]["data"] is None, "Discord test must not use data="


def test_send_test_to_raises_on_http_error(monkeypatch):
    """_send_test_to raises an exception when the HTTP request fails."""
    import requests as req

    class FakeResp:
        status_code = 404
        def raise_for_status(self):
            raise req.HTTPError("404 Not Found")

    monkeypatch.setattr("requests.post", lambda *a, **kw: FakeResp())
    with pytest.raises(req.HTTPError):
        _send_test_to("discord",
                      {"webhook_api": "https://discord.com/api/webhooks/bad/url"},
                      "test")
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
python -m pytest tests/test_notifications.py -k "config_routes or default_config or build_notif or send_test_to" -v
```

Expected: `ImportError` or `FAILED` — `_build_notif_objects` and `_send_test_to` don't exist yet.

- [ ] **Step 3: Update `config_routes.py` — add imports**

Add these imports at the top of the file, after the existing imports block:

```python
from TwitchChannelPointsMiner.classes.Settings import Events
from TwitchChannelPointsMiner.classes.Discord import Discord
from TwitchChannelPointsMiner.classes.Matrix import Matrix
from TwitchChannelPointsMiner.classes.Telegram import Telegram
from TwitchChannelPointsMiner.classes.Webhook import Webhook
from TwitchChannelPointsMiner.classes.Pushover import Pushover
from TwitchChannelPointsMiner.classes.Gotify import Gotify
```

- [ ] **Step 4: Update `DEFAULT_CONFIG` — add `notifications` key**

In `config_routes.py`, locate `DEFAULT_CONFIG` (around line 21). Add the `notifications` key **before** the closing `}`:

```python
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
```

- [ ] **Step 5: Add `_build_notif_objects()` to `config_routes.py`**

Add this function after the `_auth_error()` function (around line 91), before the validation helpers:

```python
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
```

- [ ] **Step 6: Add `_send_test_to()` to `config_routes.py`**

Add this function immediately after `_build_notif_objects()`:

```python
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
        from urllib.parse import quote as url_quote
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
        from urllib.parse import urlencode
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
```

- [ ] **Step 7: Add `test_notifications()` route function to `config_routes.py`**

Add this function at the end of the file, after `delete_streamer()`:

```python
def test_notifications():
    """POST /config/notifications/test
    Sends a test message to every enabled provider.
    Always returns HTTP 200 with a per-provider result dict:
      { "discord": "ok", "matrix": "error: 403 Forbidden", ... }
    """
    if not _check_auth():
        return _auth_error()

    cfg = _load_or_default()
    notif_cfg = cfg.get("notifications", {})
    TEST_MESSAGE = "\U0001f514 Test Notification from Twitch Channel Points Miner"

    results = {}
    for service, provider_cfg in notif_cfg.items():
        if not isinstance(provider_cfg, dict) or not provider_cfg.get("enabled"):
            continue
        try:
            _send_test_to(service, provider_cfg, TEST_MESSAGE)
            results[service] = "ok"
        except Exception as e:
            results[service] = f"error: {e}"

    return Response(json.dumps(results), status=200, mimetype="application/json")
```

- [ ] **Step 8: Run all config_routes tests**

```bash
python -m pytest tests/test_notifications.py -k "config_routes or default_config or build_notif or send_test_to" -v
```

Expected: all 8 new tests `PASSED`

- [ ] **Step 9: Run full test suite**

```bash
python -m pytest tests/test_notifications.py -v
```

Expected: all 15 tests `PASSED`

- [ ] **Step 10: Commit**

```bash
git add TwitchChannelPointsMiner/classes/routes/config_routes.py tests/test_notifications.py
git commit -m "feat: config_routes — notifications DEFAULT_CONFIG, _build_notif_objects, _send_test_to, test_notifications route"
```

---

## Task 4: Register the test route in AnalyticsServer.py

**Files:**
- Modify: `TwitchChannelPointsMiner/classes/AnalyticsServer.py`

No new tests needed — route registration is covered by the integration verification in Task 6.

- [ ] **Step 1: Add `test_notifications` to the import from `config_routes`**

In `AnalyticsServer.py`, find the import block starting at line 16:

```python
from TwitchChannelPointsMiner.classes.routes.config_routes import (
    get_config,
    save_config,
    add_streamer,
    patch_streamer,
    delete_streamer,
)
```

Add `test_notifications` to it:

```python
from TwitchChannelPointsMiner.classes.routes.config_routes import (
    get_config,
    save_config,
    add_streamer,
    patch_streamer,
    delete_streamer,
    test_notifications,
)
```

- [ ] **Step 2: Register the route**

In `AnalyticsServer.__init__`, after the last existing `add_url_rule` call (line 120), add:

```python
self.app.add_url_rule(
    "/config/notifications/test",
    "test_notifications",
    test_notifications,
    methods=["POST"]
)
```

- [ ] **Step 3: Verify the import is clean**

```bash
python -c "from TwitchChannelPointsMiner.classes.AnalyticsServer import AnalyticsServer; print('OK')"
```

Expected: `OK` (no import errors)

- [ ] **Step 4: Commit**

```bash
git add TwitchChannelPointsMiner/classes/AnalyticsServer.py
git commit -m "feat: AnalyticsServer — register POST /config/notifications/test route"
```

---

## Task 5: Update run.py — notification builder, LoggerSettings wiring, config_watcher

**Files:**
- Modify: `run.py`
- Test: `tests/test_notifications.py` (extend)

- [ ] **Step 1: Add failing tests for run.py builder**

Append to `tests/test_notifications.py`:

```python
# ── run.py build_notification_settings tests ─────────────────

# We import directly from run.py — it's a script, not a module, but the
# function will be importable after we add it.
import importlib, sys, types

def _import_build_fn():
    """Imports build_notification_settings from run.py without executing main code."""
    # run.py executes on import; we need to stub out the TwitchChannelPointsMiner
    # instantiation. The easiest path is to exec only the function definitions.
    import ast, pathlib
    src = pathlib.Path("run.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    # Collect only function definitions and imports
    allowed = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Import, ast.ImportFrom,
               ast.Assign, ast.AugAssign)
    filtered = ast.Module(
        body=[node for node in tree.body if isinstance(node, allowed)],
        type_ignores=[]
    )
    ns = {}
    exec(compile(filtered, "run.py", "exec"), ns)
    return ns["build_notification_settings"]


def test_build_notification_settings_discord():
    """build_notification_settings returns a Discord instance when enabled."""
    build = _import_build_fn()
    notif_cfg = {
        "discord": {
            "enabled": True,
            "webhook_api": "https://discord.com/api/webhooks/1/abc",
            "events": ["BET_WIN"],
        }
    }
    result = build(notif_cfg)
    from TwitchChannelPointsMiner.classes.Discord import Discord
    assert isinstance(result.get("discord"), Discord)


def test_build_notification_settings_returns_empty_for_disabled():
    """build_notification_settings returns {} when all providers are disabled."""
    build = _import_build_fn()
    notif_cfg = {
        "discord": {"enabled": False, "webhook_api": "https://x.com", "events": []}
    }
    result = build(notif_cfg)
    assert result == {}


def test_build_notification_settings_pushover_requires_priority_and_sound():
    """build_notification_settings passes priority and sound to Pushover."""
    build = _import_build_fn()
    notif_cfg = {
        "pushover": {
            "enabled": True, "userkey": "ukey", "token": "tok",
            "priority": 1, "sound": "cosmic", "events": ["BET_WIN"]
        }
    }
    result = build(notif_cfg)
    from TwitchChannelPointsMiner.classes.Pushover import Pushover
    po = result.get("pushover")
    assert isinstance(po, Pushover)
    assert po.priority == 1
    assert po.sound == "cosmic"
```

- [ ] **Step 2: Run to confirm failure**

```bash
python -m pytest tests/test_notifications.py -k "build_notification_settings" -v
```

Expected: `FAILED` — `KeyError: 'build_notification_settings'` (function doesn't exist yet)

- [ ] **Step 3: Add imports to `run.py`**

At the top of `run.py`, after the existing `from TwitchChannelPointsMiner.logger import LoggerSettings` line, add:

```python
from TwitchChannelPointsMiner.classes.Discord import Discord
from TwitchChannelPointsMiner.classes.Matrix import Matrix
from TwitchChannelPointsMiner.classes.Telegram import Telegram
from TwitchChannelPointsMiner.classes.Webhook import Webhook
from TwitchChannelPointsMiner.classes.Pushover import Pushover
from TwitchChannelPointsMiner.classes.Gotify import Gotify
```

- [ ] **Step 4: Add `build_notification_settings()` to `run.py`**

Add this function alongside the existing `build_bet_settings` / `build_streamer_settings` helpers (around line 80, before the `config_watcher` function):

```python
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
```

- [ ] **Step 5: Update `LoggerSettings` construction in `run.py`**

Find the `TwitchChannelPointsMiner(...)` call (around line 143). Just before it, add:

```python
_notifs = build_notification_settings(config.get("notifications", {}))
```

Then replace the `logger_settings=LoggerSettings(...)` block inside the constructor call:

```python
    logger_settings=LoggerSettings(
        save=True,
        console_level=logging.INFO,
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
```

- [ ] **Step 6: Update `config_watcher()` signature and body in `run.py`**

Find `def config_watcher(miner):` (around line 95). Apply these changes:

**a) Change the signature:**
```python
def config_watcher(miner, startup_notif_cfg):
```

**b) Add `_prev_notif_cfg` initialisation as the first line inside the function:**
```python
    _prev_notif_cfg = startup_notif_cfg
```

**c) At the end of the `try:` block inside the `while True:` loop, after the existing streamer hot-reload block, add:**
```python
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
```

- [ ] **Step 7: Update the `config_watcher` thread start call in `run.py`**

Find the thread creation (around line 155):

```python
_watcher = threading.Thread(
    target=config_watcher, args=(twitch_miner,), daemon=True, name="ConfigWatcher"
)
```

Change it to:

```python
_watcher = threading.Thread(
    target=config_watcher,
    args=(twitch_miner, config.get("notifications", {})),
    daemon=True,
    name="ConfigWatcher"
)
```

- [ ] **Step 8: Run all run.py tests**

```bash
python -m pytest tests/test_notifications.py -k "build_notification_settings" -v
```

Expected: all 3 `PASSED`

- [ ] **Step 9: Run full test suite**

```bash
python -m pytest tests/test_notifications.py -v
```

Expected: all 18 tests `PASSED`

- [ ] **Step 10: Commit**

```bash
git add run.py tests/test_notifications.py
git commit -m "feat: run.py — build_notification_settings, wire LoggerSettings, config_watcher hot-reload"
```

---

## Task 6: Add "Send Test" button to UI

**Files:**
- Modify: `assets/script.js`

No automated tests — the notification card handler is browser JavaScript that calls external services; unit-testing it would require a browser automation stack (Playwright/Puppeteer) that doesn't exist in this repo. Manual browser verification and the curl smoke test in Step 4 are the acceptance criteria.

- [ ] **Step 1: Find the exact insertion point**

In `assets/script.js`, find this block (around line 2403):

```javascript
              '<div class="notif-save-row">'+
                '<button class="btn btn-primary notif-save" data-service="'+svc.id+'">'+
                  '<i class="fas fa-floppy-disk"></i> Save '+svc.title+
                '</button>'+
              '</div>'+
```

- [ ] **Step 2: Add the "Send Test" button to the `notif-save-row` HTML**

Replace those 5 lines with:

```javascript
              '<div class="notif-save-row">'+
                '<button class="btn btn-primary notif-save" data-service="'+svc.id+'">'+
                  '<i class="fas fa-floppy-disk"></i> Save '+svc.title+
                '</button>'+
                '<button class="btn btn-secondary notif-test" data-service="'+svc.id+'">'+
                  '<i class="fas fa-paper-plane"></i> Send Test'+
                '</button>'+
              '</div>'+
```

- [ ] **Step 3: Add the click handler after the existing save button handler**

Find this block (around line 2434). Note the `card` variable is in scope here — this is inside the `services.forEach(function(svc) { ... })` loop that builds each notification card:

```javascript
        };   // ← end of .notif-save onclick handler

        container.appendChild(card);   // ← insert BEFORE this line
    });
}
```

Insert the following immediately **before** `container.appendChild(card);`:

```javascript
        // Test button — saves first (await), then fires test POST
        card.querySelector('.notif-test').onclick = async function() {
            try {
                if(!_settingsCfg) _settingsCfg = {};
                _settingsCfg.notifications = _settingsCfg.notifications || {};
                var enableChk = card.querySelector('.notif-enable');
                var evtChecks = Array.from(card.querySelectorAll('.notif-event:checked'))
                                    .map(function(c){ return c.value; });
                var values = svc.gatherValues();
                values.enabled = enableChk ? enableChk.checked : false;
                values.events  = evtChecks;
                _settingsCfg.notifications[svc.id] = values;
                await saveConfig(_settingsCfg);
            } catch(saveErr) {
                showSettingsToast('Save failed before test: ' + saveErr.message, true);
                return;
            }
            try {
                var r = await fetch('./config/notifications/test', {
                    method: 'POST',
                    headers: { 'X-Settings-Password': _getSettingsPw() }
                });
                var data = await r.json();
                var svcResult = data[svc.id];
                if (svcResult === 'ok') {
                    showSettingsToast(svc.title + ': Test sent \u2713');
                } else {
                    showSettingsToast(svc.title + ': ' + (svcResult || 'no response'), true);
                }
            } catch(err) {
                showSettingsToast('Test failed: ' + err.message, true);
            }
        };
```

- [ ] **Step 4: Verify with curl (backend route smoke test)**

Start the miner in a separate terminal, then run:

```bash
# If no settings_password is configured (default):
curl -s -X POST http://localhost:5000/config/notifications/test | python -m json.tool

# If a settings_password IS configured, include it:
curl -s -X POST http://localhost:5000/config/notifications/test \
     -H "X-Settings-Password: YOUR_PASSWORD_HERE" | python -m json.tool
```

Expected output (with Discord configured and enabled):
```json
{
    "discord": "ok"
}
```

Or if all providers are disabled:
```json
{}
```

A `{"error": "Unauthorized..."}` response means the password header is missing or wrong — check `settings_password` in `config.json`.

- [ ] **Step 5: Commit**

```bash
git add assets/script.js
git commit -m "feat: script.js — add 'Send Test' button with await-save sequencing to notification cards"
```

---

## Task 7: End-to-end verification

- [ ] **Step 1: Run the full test suite one final time**

```bash
python -m pytest tests/test_notifications.py -v
```

Expected: all 18 tests `PASSED`, 0 failures.

- [ ] **Step 2: Manual smoke test with Discord**

With a valid Discord webhook URL in `config.json` (password header optional — omit if no password set):

```bash
curl -s -X POST http://localhost:5000/config/notifications/test \
     -H "X-Settings-Password: YOUR_PASSWORD_HERE" | python -m json.tool
```

Expected: `{"discord": "ok"}` and a message appears in your Discord channel.

- [ ] **Step 3: Manual smoke test with Matrix**

With valid Matrix credentials in `config.json`:

```bash
curl -s -X POST http://localhost:5000/config/notifications/test \
     -H "X-Settings-Password: YOUR_PASSWORD_HERE" | python -m json.tool
```

Expected: `{"matrix": "ok"}` and message appears in the room.

- [ ] **Step 4: Verify hot-reload (startup → UI save → no restart)**

1. Start the miner. Confirm no Discord/Matrix notifications are active (empty `notifications` in config).
2. Open the web UI → Settings → Notifications tab.
3. Enable Discord, enter webhook URL, click **Save Discord**.
4. Wait ~3 seconds (config_watcher polling interval).
5. Click **Send Test**.
6. Confirm the test message arrives in Discord — without having restarted the miner.

- [ ] **Step 5: Final commit**

```bash
git add tests/test_notifications.py
git commit -m "test: final notification system test suite"
```
