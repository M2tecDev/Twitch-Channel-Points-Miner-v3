# Notification System Fix — Design Spec
**Date:** 2026-03-25
**Branch:** claude/quirky-goldstine
**Approach:** A (minimal in-place fix, no new files)

---

## Problem

The web UI correctly saves notification settings (Discord, Matrix, etc.) into `config.json` under the `notifications` key, but the runtime never reads them. `run.py` constructs `LoggerSettings` with all notification providers hardcoded to `None`. As a result, no notifications are ever sent regardless of what the user configures.

**Secondary issues:**
- `config_watcher` only hot-reloads streamer settings; notification changes require a restart.
- `DEFAULT_CONFIG` in `config_routes.py` has no `notifications` key, so `GET /config` omits it on a fresh install, breaking UI card population.
- `Discord.py` sends `data=` (form-encoded) instead of `json=`; Discord accepts both for `content`-only payloads but `json=` is the correct/documented approach.
- `Matrix.py` does not normalise the homeserver URL; if the user types `https://host.example.com` the URL becomes `https://https://host.example.com/...` and fails silently.
- `Matrix.py` swallows login and send errors.
- No `POST /config/notifications/test` endpoint exists.
- The UI notification cards have no "Send Test" button.

---

## `config.json` notifications schema

The canonical shape of `config["notifications"]` (used by both `run.py` and `config_routes.py`):

```json
{
  "notifications": {
    "discord": {
      "enabled": true,
      "webhook_api": "https://discord.com/api/webhooks/...",
      "events": ["BET_WIN", "BET_LOSE", "STREAMER_ONLINE", "STREAMER_OFFLINE"]
    },
    "matrix": {
      "enabled": true,
      "username": "devbot",
      "password": "...",
      "homeserver": "koridev.tail183fd1.ts.net",
      "room_id": "!qSf0ebXa6XTRJXOsebxtCYOsZn7l23A7nSRFqo5PFjo",
      "events": ["STREAMER_ONLINE", "STREAMER_OFFLINE", "GAIN_FOR_CLAIM", "BET_LOSE"]
    },
    "telegram": {
      "enabled": false,
      "chat_id": "",
      "token": "",
      "disable_notification": false,
      "events": ["BET_WIN", "BET_LOSE", "STREAMER_ONLINE", "STREAMER_OFFLINE"]
    },
    "webhook": {
      "enabled": false,
      "endpoint": "",
      "method": "GET",
      "events": ["BET_WIN", "BET_LOSE"]
    },
    "pushover": {
      "enabled": false,
      "userkey": "",
      "token": "",
      "priority": 0,
      "sound": "pushover",
      "events": ["BET_WIN", "BET_LOSE"]
    },
    "gotify": {
      "enabled": false,
      "endpoint": "",
      "priority": 5,
      "events": ["BET_WIN", "BET_LOSE"]
    }
  }
}
```

**Provider constructor signatures (actual):**

| Provider | Constructor signature |
|----------|-----------------------|
| `Discord` | `Discord(webhook_api: str, events: list)` |
| `Matrix`  | `Matrix(username: str, password: str, homeserver: str, room_id: str, events: list)` |
| `Telegram`| `Telegram(chat_id: int, token: str, events: list, disable_notification: bool = False)` |
| `Webhook` | `Webhook(endpoint: str, method: str, events: list)` |
| `Pushover`| `Pushover(userkey: str, token: str, priority, sound, events: list)` — all required, no defaults |
| `Gotify`  | `Gotify(endpoint: str, priority: int, events: list)` — all required, no defaults |

---

## Architecture & Data Flow

```
config.json  (notifications key)
        │
        ├─► run.py startup
        │     build_notification_settings(cfg)
        │       → constructs Discord / Matrix / etc. objects
        │       → passed into LoggerSettings(discord=..., matrix=..., ...)
        │       → stored as Settings.logger
        │
        ├─► config_watcher thread (every 2 s, on mtime change)
        │     compares new notifications dict against _prev_notif_cfg snapshot
        │     if unchanged: skip (avoids Matrix re-login on every config save)
        │     if changed: rebuild affected providers, update Settings.logger.<provider>
        │
        └─► POST /config/notifications/test
              reads config.json directly (no miner state dependency)
              builds provider objects via _build_notif_objects()
              sends test message via _send_test_to() dispatcher
              returns { discord: "ok", matrix: "error: 403 Forbidden", ... }
```

`GlobalFormatter.discord()` / `.matrix()` in `logger.py` already guard with `is not None` checks — populating those slots at startup is the entire core fix. No changes to `logger.py`.

---

## File-by-File Changes

### `run.py`

**Add imports** at top (alongside existing imports):

```python
from TwitchChannelPointsMiner.classes.Discord import Discord
from TwitchChannelPointsMiner.classes.Matrix import Matrix
from TwitchChannelPointsMiner.classes.Telegram import Telegram
from TwitchChannelPointsMiner.classes.Webhook import Webhook
from TwitchChannelPointsMiner.classes.Pushover import Pushover
from TwitchChannelPointsMiner.classes.Gotify import Gotify
```

**Add `build_notification_settings(notif_cfg)`** alongside the existing builder helpers:

```python
def build_notification_settings(notif_cfg: dict) -> dict:
    """Returns provider_name → instance (or absent key if disabled/misconfigured)."""
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

**Update `TwitchChannelPointsMiner` constructor call** (replace the existing hardcoded `LoggerSettings` block):

```python
_notifs = build_notification_settings(config.get("notifications", {}))
twitch_miner = TwitchChannelPointsMiner(
    ...
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
    ...
)
```

**Extend `config_watcher`** — add a `_prev_notif_cfg` snapshot variable outside the loop and a delta-check inside:

```python
def config_watcher(miner):
    last_mtime = 0.0
    _prev_notif_cfg = {}          # <-- NEW: snapshot for delta-check
    log = logging.getLogger(__name__)
    while True:
        time.sleep(2)
        try:
            mtime = os.path.getmtime(CONFIG_PATH)
            if mtime == last_mtime:
                continue
            last_mtime = mtime
            config = load_config()

            # ── existing streamer hot-reload block (unchanged) ──
            ...

            # ── notification hot-reload ──
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
            log.warning(f"[ConfigWatcher] {exc}")
```

**Thread-safety note:** Each `Settings.logger.<slot> = new_obj` assignment is atomic at the CPython bytecode level (single `STORE_ATTR` opcode under the GIL). This protects against torn writes. However, `GlobalFormatter.format()` reads the slot and then calls `.send()` in two separate operations — a hot-reload between those two steps would cause the new object to receive the in-flight message, which is acceptable. A missed or doubled notification at the exact moment of reload is theoretically possible but not harmful. The delta-check ensures rebuilds only occur when the notification config actually changes, not on every streamer config save.

---

### `TwitchChannelPointsMiner/classes/Discord.py`

- Switch `data=` → `json=`.
- Wrap in try/except; log `r.status_code` + `r.text[:200]` if `not r.ok`.

```python
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

---

### `TwitchChannelPointsMiner/classes/Matrix.py`

**Add `import logging` at top** (it's already present).

**Homeserver normalisation in `__init__`** — strip any existing protocol prefix, then store the bare hostname. The existing URL construction strings (`f"https://{self.homeserver}/..."`) are left as-is; normalisation ensures `self.homeserver` never carries a protocol prefix.

```python
hs = homeserver.strip().rstrip("/")
if "://" in hs:
    hs = hs.split("://", 1)[1]
self.homeserver = hs          # stored as bare hostname, used in f"https://{self.homeserver}/..."
```

**Wrap login in try/except with detailed error logging:**

```python
log = logging.getLogger(__name__)
try:
    resp = requests.post(
        url=f"https://{self.homeserver}/_matrix/client/r0/login",
        json={"user": username, "password": password, "type": "m.login.password"},
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
```

**Wrap `send()` in try/except; guard if `access_token` is None:**

```python
def send(self, message: str, event: Events) -> None:
    if str(event) not in self.events or not self.access_token:
        return
    try:
        r = requests.post(
            url=f"https://{self.homeserver}/_matrix/client/r0/rooms/{self.room_id}/send/m.room.message?access_token={self.access_token}",
            json={"body": dedent(message), "msgtype": "m.text"},
        )
        if not r.ok:
            logging.getLogger(__name__).warning(
                f"Matrix send {r.status_code}: {r.text[:200]}"
            )
    except Exception as e:
        logging.getLogger(__name__).warning(f"Matrix send failed: {e}")
```

No changes to message format — `m.room.message` + `msgtype: "m.text"` is correct. No `formatted_body` (no Markdown pipeline).

---

### `TwitchChannelPointsMiner/classes/routes/config_routes.py`

#### 1. `DEFAULT_CONFIG` — add `notifications` key

Exact structure matching the `NOTIF_DEFAULT` object in `script.js`:

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

#### 2. Add imports

```python
from TwitchChannelPointsMiner.classes.Settings import Events
from TwitchChannelPointsMiner.classes.Discord import Discord
from TwitchChannelPointsMiner.classes.Matrix import Matrix
from TwitchChannelPointsMiner.classes.Telegram import Telegram
from TwitchChannelPointsMiner.classes.Webhook import Webhook
from TwitchChannelPointsMiner.classes.Pushover import Pushover
from TwitchChannelPointsMiner.classes.Gotify import Gotify
```

#### 3. `_build_notif_objects(notif_cfg)` — private helper

Same logic as `build_notification_settings()` in `run.py`. Justified duplication: `config_routes.py` cannot import from `run.py` (circular — `run.py` is the entry point, not a module). The function is ~35 lines and contains no independent logic beyond field access.

#### 4. `_send_test_to(service, cfg, msg)` — HTTP dispatcher for the test route

This function fires the HTTP request directly, bypassing `send()` (which filters by event list). Each provider case:

```python
def _send_test_to(service: str, cfg: dict, msg: str) -> None:
    """Fires the provider's HTTP request directly, bypassing event-list filter."""
    if service == "discord":
        r = requests.post(
            url=cfg["webhook_api"],
            json={"content": msg, "username": "Twitch Channel Points Miner",
                  "avatar_url": "https://i.imgur.com/X9fEkhT.png"},
        )
        r.raise_for_status()

    elif service == "matrix":
        # Matrix requires a login to get an access_token first.
        # We construct a temporary Matrix object (triggers one login HTTP call).
        from urllib.parse import quote
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
        room = quote(cfg["room_id"])
        r = requests.post(
            url=f"https://{hs}/_matrix/client/r0/rooms/{room}/send/m.room.message?access_token={token}",
            json={"body": msg, "msgtype": "m.text"},
        )
        r.raise_for_status()

    elif service == "telegram":
        r = requests.post(
            url=f"https://api.telegram.org/bot{cfg['token']}/sendMessage",
            data={"chat_id": cfg["chat_id"], "text": msg,
                  "disable_web_page_preview": True,
                  "disable_notification": cfg.get("disable_notification", False)},
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
            data={"user": cfg["userkey"], "token": cfg["token"], "message": msg,
                  "title": "Twitch Channel Points Miner",
                  "priority": cfg.get("priority", 0),
                  "sound": cfg.get("sound", "pushover")},
        )
        r.raise_for_status()

    elif service == "gotify":
        r = requests.post(
            url=cfg["endpoint"],
            data={"message": msg, "priority": cfg.get("priority", 5)},
        )
        r.raise_for_status()

    else:
        raise ValueError(f"Unknown service: {service}")
```

#### 5. `test_notifications()` route function

```python
def test_notifications():
    if not _check_auth():
        return _auth_error()

    cfg = _load_or_default()
    notif_cfg = cfg.get("notifications", {})
    TEST_MESSAGE = "🔔 Test Notification from Twitch Channel Points Miner"

    results = {}
    for service, provider_cfg in notif_cfg.items():
        if not provider_cfg.get("enabled"):
            continue
        try:
            _send_test_to(service, provider_cfg, TEST_MESSAGE)
            results[service] = "ok"
        except Exception as e:
            results[service] = f"error: {e}"

    return Response(json.dumps(results), status=200, mimetype="application/json")
```

---

### `TwitchChannelPointsMiner/classes/AnalyticsServer.py`

Add one import and one `add_url_rule`:

```python
from TwitchChannelPointsMiner.classes.routes.config_routes import (
    ...
    test_notifications,   # add to existing import
)

self.app.add_url_rule(
    "/config/notifications/test",
    "test_notifications",
    test_notifications,
    methods=["POST"]
)
```

---

### `assets/script.js`

**Add "Send Test" button** inside `notif-save-row`, after the existing Save button:

```javascript
'<div class="notif-save-row">'+
  '<button class="btn btn-primary notif-save" data-service="'+svc.id+'">'+
    '<i class="fas fa-floppy-disk"></i> Save '+svc.title+
  '</button>'+
  '<button class="btn btn-secondary notif-test" data-service="'+svc.id+'">'+
    '<i class="fas fa-paper-plane"></i> Send Test'+
  '</button>'+
'</div>';
```

**Click handler** — `await`s the save response before firing the test (no fixed timer):

```javascript
card.querySelector('.notif-test').onclick = async function() {
    // Persist current form values first; await completion before testing
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
        await saveConfig(_settingsCfg);     // await ensures save is complete before test
    } catch(saveErr) {
        showSettingsToast('Save failed before test: ' + saveErr.message, true);
        return;
    }

    // Now fire the test
    try {
        var r = await fetch('./config/notifications/test', {
            method: 'POST',
            headers: { 'X-Settings-Password': _getSettingsPw() }  // uses _getSettingsPw() helper
        });
        var data = await r.json();
        var svcResult = data[svc.id];
        if (svcResult === 'ok') {
            showSettingsToast(svc.title + ': Test sent ✓');
        } else {
            showSettingsToast(svc.title + ': ' + (svcResult || 'no response'), true);
        }
    } catch(err) {
        showSettingsToast('Test failed: ' + err.message, true);
    }
};
```

**Key points:**
- Inline save logic (mirrors the existing `.notif-save` handler) so the save is `await`-able without triggering a separate click.
- `_getSettingsPw()` is the existing helper at `script.js:1561` that returns `window._settingsPassword || ''`.
- No CSS changes needed — `btn btn-secondary` already exists.

---

## Files Changed

| File | Change |
|------|--------|
| `run.py` | Add `build_notification_settings()`, update `LoggerSettings` call, extend `config_watcher` with delta-check |
| `TwitchChannelPointsMiner/classes/Discord.py` | `data=` → `json=`, add error logging |
| `TwitchChannelPointsMiner/classes/Matrix.py` | Homeserver normalisation (before `self.homeserver` assignment), login/send error handling |
| `TwitchChannelPointsMiner/classes/routes/config_routes.py` | `DEFAULT_CONFIG` notifications schema, `_build_notif_objects()`, `_send_test_to()`, `test_notifications()` route |
| `TwitchChannelPointsMiner/classes/AnalyticsServer.py` | Register `/config/notifications/test` route |
| `assets/script.js` | Add "Send Test" button + `await`-based click handler to each notification card |

---

## Implementation Notes

**`_prev_notif_cfg` initialisation:** Pass the startup `config.get("notifications", {})` as a second argument to `config_watcher()`, and assign it to `_prev_notif_cfg` at the top of the function. This prevents a spurious rebuild (and Matrix re-login) on the first hot-reload after startup. The thread start call becomes `threading.Thread(target=config_watcher, args=(twitch_miner, config.get("notifications", {})), ...)` and the function signature becomes `def config_watcher(miner, startup_notif_cfg):` with `_prev_notif_cfg = startup_notif_cfg` as the initial value.

**`_send_test_to` error propagation:** `_send_test_to()` raises on failure (`raise_for_status()`, `ValueError`). `test_notifications()` wraps each call in `try/except Exception as e` and stores `f"error: {e}"` in the results dict. No error causes the route to return a non-200 status — the route always returns HTTP 200 with a per-provider result dict. This mirrors how the UI shows per-service feedback without a top-level failure state.

**Matrix login in `_send_test_to`:** The login HTTP call is intentionally duplicated inline. `_send_test_to` is a one-off test dispatcher, not on the hot path. Reusing `Matrix.__init__` would be cleaner but would require constructing a full object and managing the side-effect login. The inline approach keeps the test route self-contained and explicit. Both paths use identical normalisation logic (strip protocol, prepend `https://`).

**Delta-check and enabled/disabled transitions:** `new_notif_cfg != _prev_notif_cfg` is a full dict comparison. Toggling a provider's `enabled` flag changes the dict value, so the delta-check correctly triggers a rebuild (assigning `None` for disabled providers via `.get()` returning `None`).

**Webhook query param format:** `endpoint + "?" + urlencode({"event_name": "TEST", "message": msg})`. The `event_name` and `message` keys match the existing `Webhook.send()` implementation.

**Gotify/Pushover parameter defaults:** Gotify `priority` range is 1–10 (higher = more urgent); 5 is the Gotify default. Pushover `sound: "pushover"` is the API's default sound name. Neither requires validation — the respective APIs handle out-of-range values gracefully (Gotify clamps, Pushover falls back to default).

---

## Out of Scope

- `formatted_body` / Markdown in Matrix messages (no Markdown pipeline exists).
- Webhook URL-encoding — a pre-existing issue unrelated to the current breakage.
- Pushover / Gotify class-level error handling — not broken, handled by builder guards.
- Webhook method validation beyond GET/POST — existing `Webhook.send()` already raises `ValueError` for unknown methods.
