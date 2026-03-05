# Twitch Channel Points Miner v3

[![Python](https://img.shields.io/badge/python-%3E%3D3.9-blue)](https://www.python.org/)
[![License](https://img.shields.io/github/license/M2tecDev/Twitch-Channel-Points-Miner-v3)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/M2tecDev/Twitch-Channel-Points-Miner-v3)](https://github.com/M2tecDev/Twitch-Channel-Points-Miner-v3/commits/master)

A simple script that will watch a stream for you and earn the channel points. It can wait for a streamer to go live (+450 points when the stream starts), it will automatically click the bonus button (+50 points), and it will follow raids (+250 points).

This is a **v3 fork** with a completely redesigned Web UI, `config.json`-driven setup, hot-reload, a supervised wrapper, and much more — based on [rdavydov/Twitch-Channel-Points-Miner-v2](https://github.com/rdavydov/Twitch-Channel-Points-Miner-v2) (originally by [Tkd-Alex](https://github.com/Tkd-Alex/Twitch-Channel-Points-Miner-v2)).

---

## What's new in v3

- **No more editing `run.py`** — all configuration lives in a single `config.json` (credentials, global settings, per-streamer overrides, notifications).
- **Completely redesigned Web UI** — Dashboard overview, per-streamer detail charts, Compare view, Bet History with filters, and a full Settings panel.
- **`wrapper.py`** — Supervised restart manager: auto-restarts on crash, gracefully restarts when the streamer list changes, and leaves settings changes to the in-memory hot-reload.
- **Hot-reload** — Changes to global settings, bet strategy, or per-streamer overrides are applied in-memory within ~2 seconds. No restart needed.
- **Settings via Web UI** — Global defaults, per-streamer settings, add/remove/enable/disable streamers, and notifications — all from the browser.
- **Password-protected settings** — Optional `settings_password` in `config.json` locks the Settings panel behind a password prompt.
- **6 notification services** configurable from the UI: Telegram, Discord, Generic Webhook, Matrix, Pushover, Gotify.
- **Theme switcher** — Dark / Light mode + 3 accent themes (Gold, Red, Purple).
- **Live status indicators** — Sidebar shows online/offline status per streamer in real-time.
- **Application log viewer** — Expandable log panel in the footer with pause/resume and auto-scroll.

---

## Table of Contents

- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration (`config.json`)](#configuration-configjson)
  - [Miner Settings](#miner-settings)
  - [Analytics Settings](#analytics-settings)
  - [Global Streamer Settings](#global-streamer-settings)
  - [Bet Settings](#bet-settings)
  - [Streamers](#streamers)
  - [Notifications](#notifications)
  - [Settings Password](#settings-password)
- [How It Works](#how-it-works)
  - [`wrapper.py` — Supervised Restart Manager](#wrapperpy--supervised-restart-manager)
  - [Hot-Reload vs. Restart](#hot-reload-vs-restart)
- [Web UI](#web-ui)
- [Bet Strategies](#bet-strategies)
- [Notifications](#notifications-1)
- [Priority System](#priority-system)
- [Docker](#docker)
- [Credits](#credits)
- [Disclaimer](#disclaimer)

---

## Requirements

- Python >= 3.9
- Dependencies from `requirements.txt`:
  `requests`, `websocket-client`, `pillow`, `python-dateutil`, `emoji`, `millify`, `pre-commit`, `colorama`, `flask`, `irc`, `pandas`, `pytz`, `validators`

---

## Quick Start

1. **Clone this repository**

   ```bash
   git clone https://github.com/M2tecDev/Twitch-Channel-Points-Miner-v3
   cd Twitch-Channel-Points-Miner-v3
   ```

2. **Install dependencies**

   ```bash
   pip install -r requirements.txt
   ```

   > If you have problems, try a virtual environment:
   > ```bash
   > python -m venv venv
   > source venv/bin/activate   # Linux/macOS
   > venv\Scripts\activate      # Windows
   > pip install -r requirements.txt
   > ```

3. **Create your config**

   Copy the example and fill in your credentials:

   ```bash
   cp config.json.example config.json
   ```

   At minimum, set your Twitch `username` in the `miner` block and add streamers to the `streamers` array.

4. **Start mining!**

   ```bash
   python wrapper.py
   ```

   The wrapper will launch `run.py`, monitor for crashes, and handle streamer list changes automatically.

5. **Open the Web UI**

   Navigate to `http://localhost:5000` (or whatever host/port you configured in `analytics`).

---

## Configuration (`config.json`)

All settings are in a single JSON file. Below is the full structure with explanations.

### Miner Settings

```json
"miner": {
  "username": "your-twitch-username",
  "password": "your-optional-password",
  "settings_password": "optional-ui-password",
  "claim_drops_startup": false,
  "enable_analytics": true,
  "disable_ssl_cert_verification": false,
  "disable_at_in_nickname": false,
  "priority": ["STREAK", "DROPS", "ORDER"]
}
```

| Key | Type | Description |
|-----|------|-------------|
| `username` | string | **Required.** Your Twitch username. |
| `password` | string | Your Twitch password (only needed for first login / cookie generation). |
| `settings_password` | string | If set, the Web UI Settings tab requires this password to unlock. |
| `claim_drops_startup` | bool | Claim available drops when the miner starts. |
| `enable_analytics` | bool | Enable the Web UI / analytics server. |
| `disable_ssl_cert_verification` | bool | Disable SSL cert checks (not recommended). |
| `disable_at_in_nickname` | bool | Remove the `@` prefix from nickname in notifications. |
| `priority` | array | Priority order for watching streamers. Values: `STREAK`, `DROPS`, `ORDER`, `POINTS_OF_CHANNEL`, `SMART`. |

### Analytics Settings

```json
"analytics": {
  "host": "0.0.0.0",
  "port": 5000,
  "refresh": 5,
  "days_ago": 7
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `host` | string | `"0.0.0.0"` | Bind address for the web server. |
| `port` | int | `5000` | Port for the web server. |
| `refresh` | int | `5` | Auto-refresh interval in minutes for the dashboard. |
| `days_ago` | int | `7` | Default time range (in days) for charts. |

### Global Streamer Settings

These defaults apply to every streamer that doesn't have individual overrides.

```json
"global_settings": {
  "make_predictions": true,
  "follow_raid": true,
  "claim_drops": true,
  "claim_moments": true,
  "watch_streak": true,
  "community_goals": false,
  "chat": "ONLINE"
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `make_predictions` | bool | `true` | Place bets on channel predictions. |
| `follow_raid` | bool | `true` | Follow raids to earn +250 bonus points. |
| `claim_drops` | bool | `true` | Claim Twitch drops when available. |
| `claim_moments` | bool | `true` | Claim Twitch Moments automatically. |
| `watch_streak` | bool | `true` | Prioritize catching the watch streak bonus. |
| `community_goals` | bool | `false` | Contribute to community channel point goals. |
| `chat` | string | `"ONLINE"` | Chat presence: `ONLINE`, `OFFLINE`, or `ALWAYS`. |

### Bet Settings

Nested inside `global_settings.bet`:

```json
"bet": {
  "strategy": "SMART",
  "percentage": 5,
  "percentage_gap": 20,
  "max_points": 50000,
  "minimum_points": 0,
  "stealth_mode": true,
  "delay_mode": "FROM_END",
  "delay": 6,
  "filter_condition": null
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `strategy` | string | `"SMART"` | Bet strategy — see [Bet Strategies](#bet-strategies). |
| `percentage` | int | `5` | Percentage of your current points to wager. |
| `percentage_gap` | int | `20` | Minimum gap between outcome percentages before placing a bet. |
| `max_points` | int | `50000` | Maximum points to bet in a single prediction. |
| `minimum_points` | int | `0` | Only bet if your balance is above this threshold. |
| `stealth_mode` | bool | `true` | Always bet the minimum amount to avoid detection. |
| `delay_mode` | string | `"FROM_END"` | `FROM_START` or `FROM_END` — when the delay timer starts. |
| `delay` | int | `6` | Seconds to wait before placing the bet. |
| `filter_condition` | object/null | `null` | Advanced filter — skip bets based on conditions. |

### Streamers

An array of streamers to watch. Each entry can optionally override global settings:

```json
"streamers": [
  {
    "username": "streamer01",
    "enabled": true,
    "settings": null
  },
  {
    "username": "streamer02",
    "enabled": true,
    "settings": {
      "make_predictions": false,
      "bet": {
        "strategy": "HIGH_ODDS",
        "max_points": 10000,
        "minimum_points": 5000
      }
    }
  }
]
```

- Set `"settings": null` to use global defaults for that streamer.
- Set `"enabled": false` to keep a streamer in your list without actually watching them.
- Any field you specify in `settings` overrides only that field — the rest falls back to global.

> **Tip:** You can add, remove, and toggle streamers directly from the Web UI Settings tab. Changes to the streamer list trigger an automatic restart via `wrapper.py` (~10 seconds).

### Notifications

Notifications are configured in a `notifications` block (also editable from the Web UI):

```json
"notifications": {
  "telegram": {
    "enabled": true,
    "chat_id": "123456789",
    "token": "YOUR_BOT_TOKEN",
    "disable_notification": false,
    "events": ["BET_WIN", "BET_LOSE", "STREAMER_ONLINE", "STREAMER_OFFLINE"]
  },
  "discord": {
    "enabled": true,
    "webhook_api": "https://discord.com/api/webhooks/...",
    "events": ["BET_WIN", "BET_LOSE"]
  }
}
```

**Supported services:** Telegram, Discord, Generic Webhook, Matrix, Pushover, Gotify.

**Available events:**
`STREAMER_ONLINE`, `STREAMER_OFFLINE`, `GAIN_FOR_RAID`, `GAIN_FOR_CLAIM`, `GAIN_FOR_WATCH`, `BET_WIN`, `BET_LOSE`, `BET_REFUND`, `BET_FILTERS`, `BET_GENERAL`, `BET_FAILED`, `BET_START`, `BONUS_CLAIM`, `MOMENT_CLAIM`, `JOIN_RAID`, `DROP_CLAIM`, `DROP_STATUS`, `CHAT_MENTION`

### Settings Password

If `settings_password` is set (either in `miner.settings_password` or top-level `settings_password`), the Settings panel in the Web UI will require this password before allowing changes. All write endpoints (`POST`, `PATCH`, `DELETE`) check the password via the `X-Settings-Password` HTTP header.

---

## How It Works

### `wrapper.py` — Supervised Restart Manager

Instead of running `run.py` directly, use `wrapper.py`:

```bash
python wrapper.py
```

What it does:

1. **Launches `run.py`** as a subprocess.
2. **Auto-restarts on crash** — if `run.py` exits unexpectedly, it restarts after 5 seconds.
3. **Graceful restart on streamer list changes** — if you add, remove, or toggle streamers in `config.json` (via UI or manually), `wrapper.py` terminates `run.py` and restarts it after a 10-second delay.
4. **Ignores settings-only changes** — bet strategy, percentages, toggles, etc. are hot-reloaded by `run.py` itself without any restart.

### Hot-Reload vs. Restart

| Change type | Handled by | Restart? |
|-------------|-----------|----------|
| Global settings (bet strategy, predictions, etc.) | `run.py` config watcher | No — applied in-memory within ~2s |
| Per-streamer settings overrides | `run.py` config watcher | No |
| **Add / remove / enable / disable streamer** | `wrapper.py` | **Yes** — automatic restart in ~10s |
| Miner credentials (`username`, `password`) | Manual restart required | Yes |

---

## Web UI

The analytics Web UI runs on Flask and provides five main views:

**Dashboard** — Overview with total points, total gained, best/worst streamer, bet stats, and a combined chart for all streamers.

**Streamer Detail** — Click any streamer in the sidebar to see their individual point history chart with annotations (bets, raids, claims, etc.) on a timeline.

**Compare** — Select multiple streamers from the sidebar to compare their point history on a single chart.

**Bet History** — Aggregated table of all predictions across all streamers, with summary stats (total bets, wins, losses, win rate) and filters by streamer and result.

**Settings** — Three tabs:
- *Global Defaults* — All the global streamer settings and bet configuration.
- *Streamers* — Add, remove, enable/disable streamers and configure per-streamer overrides.
- *Notifications* — Configure Telegram, Discord, Webhook, Matrix, Pushover, and Gotify with per-service event selection.

**Additional features:**
- Dark / Light mode toggle
- 3 accent color themes (Gold, Red, Purple)
- Collapsible sidebar with search and sorting (name, points, last activity)
- Live online/offline status dots (polled every 30s)
- Application log viewer in the footer (pause/resume, auto-scroll)
- Responsive design for mobile

---

## Bet Strategies

| Strategy | Description |
|----------|-------------|
| `SMART` | Decides based on prediction window timing and odds. |
| `MOST_VOTED` | Bets on the outcome with the most users. |
| `HIGH_ODDS` | Bets on the underdog (highest odds). |
| `PERCENTAGE` | Bets on the outcome with the highest odds percentage. |
| `SMART_MONEY` | Follows the largest individual bettors (top predictors). |
| `NUMBER_1` .. `NUMBER_8` | Always bets on a specific outcome slot. |

---

## Notifications

All six services can be configured from the Web UI or directly in `config.json`:

| Service | Required fields |
|---------|----------------|
| **Telegram** | `chat_id`, `token` (from @BotFather). Optional: `disable_notification`. |
| **Discord** | `webhook_api` (from Channel Settings → Integrations → Webhooks). |
| **Generic Webhook** | `endpoint` URL, `method` (`GET` or `POST`). |
| **Matrix** | `username`, `password`, `homeserver`, `room_id`. |
| **Pushover** | `userkey`, `token`, optional `priority` and `sound`. |
| **Gotify** | `endpoint` (including `?token=...`), optional `priority`. |

Each service has its own `events` array so you can choose exactly which events trigger a notification.

---

## Priority System

Twitch allows watching a maximum of two channels at once. The `priority` setting in the miner config determines which two streamers are watched when more than two are online:

| Priority | Description |
|----------|-------------|
| `STREAK` | Prioritize streamers where a watch streak bonus is available. |
| `DROPS` | Prioritize streamers with active drop campaigns. |
| `ORDER` | Follow the order of the streamers list in `config.json`. |
| `POINTS_OF_CHANNEL` | Prioritize channels where you have the fewest points. |
| `SMART` | Automatically picks the best combination. |

The `priority` field is an array, so you can stack them: `["STREAK", "DROPS", "ORDER"]` means streak first, then drops, then list order as tiebreaker.

---

## Docker

> **Coming soon** — Docker support is planned but not yet adapted for the v3 config.json workflow. For now, please use the manual installation described above.

---

## Credits

- Originally created by [Tkd-Alex (Alessandro Maggio)](https://github.com/Tkd-Alex/Twitch-Channel-Points-Miner-v2)
- Maintained and extended by [rdavydov (Roman Davydov)](https://github.com/rdavydov/Twitch-Channel-Points-Miner-v2)
- v3 Web UI, config.json system, wrapper, and hot-reload by Kori

---

## Disclaimer

This project is provided "as is" for educational purposes. Use it at your own risk. The developers are not responsible for any consequences resulting from the use of this software, including but not limited to account bans or loss of channel points. Please respect Twitch's Terms of Service.