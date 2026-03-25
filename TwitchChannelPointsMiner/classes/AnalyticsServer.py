# -*- coding: utf-8 -*-
"""
AnalyticsServer — Flask web server for the CPM v3 dashboard.

Routes are split into:
  routes/config_routes.py    — Config CRUD (get, save, add, patch, delete streamer)
  routes/analytics_routes.py — Analytics data (streamers, JSON, bets, summary, status)
"""
import logging
import os
from pathlib import Path
from threading import Thread

from flask import Flask, Response, cli, request

from TwitchChannelPointsMiner.classes.routes.config_routes import (
    get_config,
    save_config,
    add_streamer,
    patch_streamer,
    delete_streamer,
    test_notifications,
)
from TwitchChannelPointsMiner.classes.routes.analytics_routes import (
    index,
    streamers,
    read_json,
    json_all,
    make_status_handler,
    bets,
    summary,
)
from TwitchChannelPointsMiner.utils import download_file

cli.show_server_banner = lambda *_: None
logger = logging.getLogger(__name__)


# ── Assets ────────────────────────────────────────────────────

def download_assets(assets_folder, required_files):
    Path(assets_folder).mkdir(parents=True, exist_ok=True)
    for f in required_files:
        if not os.path.isfile(os.path.join(assets_folder, f)):
            if download_file(os.path.join("assets", f), os.path.join(assets_folder, f)):
                logger.info(f"Downloaded {f}")


def check_assets():
    required = ["banner.png", "charts.html", "script.js", "style.css", "dark-theme.css"]
    folder   = os.path.join(Path().absolute(), "assets")
    if not os.path.isdir(folder):
        download_assets(folder, required)
    else:
        for f in required:
            if not os.path.isfile(os.path.join(folder, f)):
                download_assets(folder, required)
                break


last_sent_log_index = 0


# ── Server class ──────────────────────────────────────────────

class AnalyticsServer(Thread):
    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 5000,
        refresh: int = 5,
        days_ago: int = 7,
        username: str = None,
        miner=None,
    ):
        super(AnalyticsServer, self).__init__()
        check_assets()

        self.host     = host
        self.port     = port
        self.refresh  = refresh
        self.days_ago = days_ago
        self.username = username
        self.miner    = miner
        _miner        = self.miner

        def generate_log():
            global last_sent_log_index
            last_received = int(request.args.get("lastIndex", last_sent_log_index))
            log_path = os.path.join(Path().absolute(), "logs", f"{username}.log")
            try:
                with open(log_path, "r", encoding="utf-8") as lf:
                    content = lf.read()
                new_entries         = content[last_received:]
                last_sent_log_index = len(content)
                return Response(new_entries, status=200, mimetype="text/plain")
            except FileNotFoundError:
                return Response("Log file not found.", status=404, mimetype="text/plain")

        self.app = Flask(
            __name__,
            template_folder=os.path.join(Path().absolute(), "assets"),
            static_folder=os.path.join(Path().absolute(), "assets"),
        )

        # ── Analytics routes ──────────────────────────────
        self.app.add_url_rule("/",                         "index",      index,       defaults={"refresh": refresh, "days_ago": days_ago}, methods=["GET"])
        self.app.add_url_rule("/streamers",                "streamers",  streamers,   methods=["GET"])
        self.app.add_url_rule("/json/<string:streamer>",   "json",       read_json,   methods=["GET"])
        self.app.add_url_rule("/json_all",                 "json_all",   json_all,    methods=["GET"])
        self.app.add_url_rule("/log",                      "log",        generate_log, methods=["GET"])
        self.app.add_url_rule("/status",                   "status",     make_status_handler(_miner), methods=["GET"])
        self.app.add_url_rule("/bets",                     "bets",       bets,        methods=["GET"])
        self.app.add_url_rule("/summary",                  "summary",    summary,     methods=["GET"])

        # ── Config CRUD routes ────────────────────────────
        self.app.add_url_rule("/config",                            "get_config",     get_config,      methods=["GET"])
        self.app.add_url_rule("/config",                            "save_config",    save_config,     methods=["POST"])
        self.app.add_url_rule("/config/streamer",                   "add_streamer",   add_streamer,    methods=["POST"])
        self.app.add_url_rule("/config/streamer/<string:username>", "patch_streamer", patch_streamer,  methods=["PATCH"])
        self.app.add_url_rule("/config/streamer/<string:username>", "del_streamer",   delete_streamer, methods=["DELETE"])
        self.app.add_url_rule("/config/notifications/test",         "test_notifications", test_notifications, methods=["POST"])

    def run(self):
        logger.info(f"Analytics running on http://{self.host}:{self.port}/",
                    extra={"emoji": ":globe_with_meridians:"})
        self.app.run(host=self.host, port=self.port, threaded=True, debug=False)
