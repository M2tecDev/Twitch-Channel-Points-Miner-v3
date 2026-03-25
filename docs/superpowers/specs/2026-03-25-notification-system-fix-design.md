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
- `Matrix.py` hardcodes `https://` prefix without stripping an existing protocol from the homeserver value; errors during login or send are swallowed silently.
- No `POST /config/notifications/test` endpoint exists; there is no way to verify a webhook works without waiting for a real event.
- The UI notification cards have no "Send Test" button.

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
        │     reads notifications key
        │     rebuilds each provider object
        │     updates Settings.logger.<provider> in place
        │
        └─► POST /config/notifications/test
              reads config.json directly (no miner state dependency)
              builds provider objects via _build_notif_objects()
              sends test message to every enabled provider
              returns { discord: "ok", matrix: "error: 403 Forbidden", ... }
```

`GlobalFormatter.discord()` / `.matrix()` in `logger.py` already guard with `is not None` checks — populating those slots at startup is the entire core fix. No changes to `logger.py`.

---

## File-by-File Changes

### `run.py`

**Add imports** at top:
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
    """Returns provider_name → instance (or absent key if disabled/missing)."""
    result = {}
    if not notif_cfg:
        return result

    dc = notif_cfg.get("discord", {})
    if dc.get("enabled") and dc.get("webhook_api"):
        result["discord"] = Discord(dc["webhook_api"], dc.get("events", []))

    mx = notif_cfg.get("matrix", {})
    if mx.get("enabled") and mx.get("homeserver") and mx.get("room_id"):
        result["matrix"] = Matrix(
            mx["username"], mx["password"],
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
            po["userkey"], po["token"], po.get("events", [])
        )

    gt = notif_cfg.get("gotify", {})
    if gt.get("enabled") and gt.get("endpoint"):
        result["gotify"] = Gotify(gt["endpoint"], gt.get("events", []))

    return result
```

**Update `TwitchChannelPointsMiner` constructor call** to pass notification objects:

```python
_notifs = build_notification_settings(config.get("notifications", {}))
logger_settings = LoggerSettings(
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
)
```

**Extend `config_watcher`** — after the existing streamer settings block:

```python
new_notifs = build_notification_settings(config.get("notifications", {}))
Settings.logger.discord  = new_notifs.get("discord")
Settings.logger.matrix   = new_notifs.get("matrix")
Settings.logger.telegram = new_notifs.get("telegram")
Settings.logger.webhook  = new_notifs.get("webhook")
Settings.logger.pushover = new_notifs.get("pushover")
Settings.logger.gotify   = new_notifs.get("gotify")
```

Thread-safety: GIL protects individual slot assignments. Worst case is one in-flight notification uses a stale object during a reload — acceptable.

---

### `TwitchChannelPointsMiner/classes/Discord.py`

- Switch `data=` → `json=` in `requests.post`.
- Wrap the request in try/except; log `r.status_code` + `r.text[:200]` if `not r.ok`.

---

### `TwitchChannelPointsMiner/classes/Matrix.py`

**Homeserver URL normalisation** in `__init__` (before the login request):

```python
hs = homeserver.strip().rstrip("/")
if "://" in hs:
    hs = hs.split("://", 1)[1]
self.homeserver = hs
```

**Error handling** — wrap the login request in try/except:

```python
try:
    body = requests.post(
        url=f"https://{self.homeserver}/_matrix/client/r0/login",
        json={"user": username, "password": password, "type": "m.login.password"},
        timeout=10,
    ).json()
    self.access_token = body.get("access_token")
    if not self.access_token:
        log.warning("Matrix login failed — check username/password/homeserver. "
                    f"Response: {body}")
except Exception as e:
    log.warning(f"Matrix login error: {e}")
    self.access_token = None
```

**`send()`** — guard if `access_token` is None; wrap in try/except with status check.

No changes to message format — `m.room.message` + `msgtype: "m.text"` is already correct. No `formatted_body` (no Markdown in the message pipeline).

---

### `TwitchChannelPointsMiner/classes/routes/config_routes.py`

**`DEFAULT_CONFIG`** — add full `notifications` schema:

```python
"notifications": {
    "discord":  {"enabled": False, "webhook_api": "",
                 "events": ["BET_WIN", "BET_LOSE", "STREAMER_ONLINE", "STREAMER_OFFLINE"]},
    "matrix":   {"enabled": False, "username": "", "password": "",
                 "homeserver": "", "room_id": "",
                 "events": ["BET_WIN", "BET_LOSE", "STREAMER_ONLINE", "STREAMER_OFFLINE"]},
    "telegram": {"enabled": False, "chat_id": "", "token": "",
                 "disable_notification": False,
                 "events": ["BET_WIN", "BET_LOSE", "STREAMER_ONLINE", "STREAMER_OFFLINE"]},
    "webhook":  {"enabled": False, "endpoint": "", "method": "GET",
                 "events": ["BET_WIN", "BET_LOSE"]},
    "pushover": {"enabled": False, "userkey": "", "token": "",
                 "events": ["BET_WIN", "BET_LOSE"]},
    "gotify":   {"enabled": False, "endpoint": "", "token": "",
                 "events": ["BET_WIN", "BET_LOSE"]},
},
```

**Add `_build_notif_objects(notif_cfg)`** — a private copy of the builder used only by the test route (avoids importing from `run.py`; ~30 lines, same logic).

**Add `test_notifications()`** route function:

```python
def test_notifications():
    if not _check_auth():
        return _auth_error()
    cfg = _load_or_default()
    notif_cfg = cfg.get("notifications", {})
    objects = _build_notif_objects(notif_cfg)

    TEST_MESSAGE = "🔔 Test Notification from Twitch Channel Points Miner"
    TEST_EVENT   = Events.BONUS_CLAIM  # always in default event lists

    results = {}
    for name, obj in objects.items():
        try:
            obj.send(TEST_MESSAGE, TEST_EVENT)
            results[name] = "ok"
        except Exception as e:
            results[name] = f"error: {e}"

    return Response(json.dumps(results), status=200, mimetype="application/json")
```

**Note on test event:** The test sends `Events.BONUS_CLAIM`. For this to reach every provider, each provider's event list must include `BONUS_CLAIM`. The test route therefore temporarily overrides the event filter — it calls `obj.send()` but the `send()` method checks `str(event) in self.events`. To bypass this cleanly, the test route directly calls the underlying HTTP logic rather than `send()`. Alternatively, `BONUS_CLAIM` is added to every provider's default event list in `DEFAULT_CONFIG`. The simpler path: inject a sentinel event that's always present, or call the requests directly. **Decision: call `requests.post` directly in the test route using the provider's config dict** — avoids patching `send()` signatures and is the most explicit.

Revised test route approach:

```python
for name, notif_cfg_entry in notif_cfg.items():
    if not notif_cfg_entry.get("enabled"):
        continue
    try:
        _send_test_to(name, notif_cfg_entry, TEST_MESSAGE)
        results[name] = "ok"
    except Exception as e:
        results[name] = f"error: {e}"
```

Where `_send_test_to(service, cfg, msg)` is a small dispatcher that knows how to fire each provider directly.

---

### `TwitchChannelPointsMiner/classes/AnalyticsServer.py`

Add one import and one `add_url_rule`:

```python
from TwitchChannelPointsMiner.classes.routes.config_routes import test_notifications

self.app.add_url_rule(
    "/config/notifications/test",
    "test_notifications",
    test_notifications,
    methods=["POST"]
)
```

---

### `assets/script.js`

Add a **"Send Test"** button inside `notif-save-row` for each notification card. The click handler:

1. Triggers `.notif-save` click (persist current form values first).
2. Waits 600 ms for the save to complete.
3. Calls `POST /config/notifications/test` with `X-Settings-Password` header.
4. Reads `response[svc.id]` and shows a success or error toast.

No CSS changes needed — `btn btn-secondary` already exists.

---

## Files Changed

| File | Change |
|------|--------|
| `run.py` | Add `build_notification_settings()`, update `LoggerSettings` call, extend `config_watcher` |
| `TwitchChannelPointsMiner/classes/Discord.py` | `data=` → `json=`, add error logging |
| `TwitchChannelPointsMiner/classes/Matrix.py` | Homeserver normalisation, login/send error handling |
| `TwitchChannelPointsMiner/classes/routes/config_routes.py` | `DEFAULT_CONFIG` notifications schema, `_build_notif_objects()`, `test_notifications()` route |
| `TwitchChannelPointsMiner/classes/AnalyticsServer.py` | Register `/config/notifications/test` route |
| `assets/script.js` | Add "Send Test" button + click handler to each notification card |

---

## Out of Scope

- `formatted_body` / Markdown in Matrix messages (no Markdown pipeline exists).
- Pushover / Gotify — fixed by the same `build_notification_settings()` path; no class-level changes needed unless bugs surface.
- Webhook URL-encoding — a pre-existing issue not related to the current breakage.
