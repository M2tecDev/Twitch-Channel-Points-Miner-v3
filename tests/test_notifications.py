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
