# Twitch Channel Points Miner v3

[![Python](https://img.shields.io/badge/python-%3E%3D3.9-blue)](https://www.python.org/)
[![License](https://img.shields.io/github/license/M2tecDev/Twitch-Channel-Points-Miner-v3)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/M2tecDev/Twitch-Channel-Points-Miner-v3)](https://github.com/M2tecDev/Twitch-Channel-Points-Miner-v3/commits/master)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://github.com/M2tecDev/Twitch-Channel-Points-Miner-v3/pkgs/container/twitch-channel-points-miner-v3)

Automatically watches Twitch streams to farm channel points — claims bonuses, follows raids, and places predictions. This is a **v3 fork** with a completely redesigned Web UI, `config.json`-driven setup, hot-reload, and Docker support, based on [rdavydov/Twitch-Channel-Points-Miner-v2](https://github.com/rdavydov/Twitch-Channel-Points-Miner-v2).

---

## What's new in v3

- **No more editing `run.py`** — all configuration lives in a single `config.json`
- **Completely redesigned Web UI** — Dashboard, per-streamer charts, Compare view, Bet History, Settings panel
- **`wrapper.py`** — supervised restart manager: auto-restarts on crash, graceful restart on streamer list changes
- **Hot-reload** — bet strategy, settings, notifications apply in-memory within ~2 seconds, no restart needed
- **Settings via Web UI** — manage streamers, global settings, and all 6 notification services from the browser
- **Password-protected settings** — optional `settings_password` locks the Settings panel
- **Docker-first** — official multi-platform image (amd64 · arm64 · armv7) on GHCR and Docker Hub
- **Theme switcher** — Dark / Light mode + 3 accent themes (Gold, Red, Purple)

---

## Quick Start

### Option A — Docker (recommended)

```bash
cp config.json.example config.json
# edit config.json: set your Twitch username and add streamers
docker compose up -d
```

Open the Web UI at **http://localhost:5000**.  
→ Full Docker guide: [`docs/wiki/Docker-Setup.md`](docs/wiki/Docker-Setup.md)

### Option B — Local Python

```bash
git clone https://github.com/M2tecDev/Twitch-Channel-Points-Miner-v3
cd Twitch-Channel-Points-Miner-v3
pip install -r requirements.txt
cp config.json.example config.json
# edit config.json
python wrapper.py
```

Requires **Python ≥ 3.9**.

---

## Configuration

All settings live in `config.json`. Copy `config.json.example` as a starting point.

The minimum you need to set:

```json
{
  "miner": { "username": "your-twitch-username" },
  "streamers": [
    { "username": "streamer01", "enabled": true }
  ]
}
```

→ Full configuration reference: [`docs/wiki/Configuration.md`](docs/wiki/Configuration.md)

---

## How It Works

```
wrapper.py          ← start this
  └── run.py        ← launched as subprocess
        ├── config watcher thread   (hot-reloads settings every 2s)
        ├── WebSocket pool          (Twitch PubSub)
        ├── minute watcher thread   (sends watch events)
        └── Flask analytics server  (Web UI on :5000)
```

| Change type | Handler | Restart? |
|-------------|---------|----------|
| Bet strategy, toggles, notifications | `run.py` config watcher | No — applied in ~2s |
| Add / remove / enable / disable streamer | `wrapper.py` | Yes — auto-restart in ~10s |
| Miner credentials (`username`, `password`) | — | Manual restart required |

---

## Web UI

Five views accessible at `http://localhost:5000`:

**Dashboard** · **Streamer Detail** · **Compare** · **Bet History** · **Settings**

Features: Dark/Light mode · 3 accent themes · live online/offline indicators · application log viewer · mobile-responsive layout.

---

## Bet Strategies

`SMART` · `MOST_VOTED` · `HIGH_ODDS` · `PERCENTAGE` · `SMART_MONEY` · `NUMBER_1`–`NUMBER_8`

→ Details and filter conditions in [`docs/wiki/Configuration.md`](docs/wiki/Configuration.md#bet-strategies)

---

## Notification Services

Telegram · Discord · Generic Webhook · Matrix · Pushover · Gotify

All configurable from the Web UI or directly in `config.json`.  
→ Setup guide in [`docs/wiki/Configuration.md`](docs/wiki/Configuration.md#notifications)

---

## Credits

- Originally created by [Tkd-Alex (Alessandro Maggio)](https://github.com/Tkd-Alex/Twitch-Channel-Points-Miner-v2)
- Maintained and extended by [rdavydov (Roman Davydov)](https://github.com/rdavydov/Twitch-Channel-Points-Miner-v2)
- v3 Web UI, config.json system, wrapper, hot-reload, and Docker support by Kori

---

## Disclaimer

This project is provided "as is" for educational purposes. Use at your own risk. The developers are not responsible for any consequences including account bans or loss of channel points. Please respect Twitch's Terms of Service.
