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
