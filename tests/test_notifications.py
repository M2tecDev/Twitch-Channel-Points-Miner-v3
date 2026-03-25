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
