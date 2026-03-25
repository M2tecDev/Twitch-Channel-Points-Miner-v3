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
