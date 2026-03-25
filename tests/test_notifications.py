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


# ── run.py build_notification_settings tests ─────────────────

# We import directly from run.py — it's a script, not a module, but the
# function will be importable after we add it.
def _import_build_fn():
    """Imports build_notification_settings from run.py without executing main code."""
    # run.py executes on import; we need to stub out the TwitchChannelPointsMiner
    # instantiation. The easiest path is to exec only the function definitions.
    import ast, pathlib
    src = pathlib.Path("run.py").read_text(encoding="utf-8")
    tree = ast.parse(src)

    def _is_safe_assign(node):
        """Keep only simple constant-value assignments (e.g. CONFIG_PATH = ...)."""
        if not isinstance(node, ast.Assign):
            return False
        # Allow only if RHS contains no function calls
        return not any(isinstance(n, ast.Call) for n in ast.walk(node.value))

    # Collect only function definitions and safe imports/assignments
    filtered_body = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef,
                              ast.Import, ast.ImportFrom)):
            filtered_body.append(node)
        elif _is_safe_assign(node):
            filtered_body.append(node)

    filtered = ast.Module(body=filtered_body, type_ignores=[])
    import pathlib as _pl
    ns = {"__file__": str(_pl.Path("run.py").resolve())}
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
