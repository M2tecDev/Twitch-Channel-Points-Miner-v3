# Configuration Reference

All settings live in a single `config.json` in the project root.  
Copy `config.json.example` → `config.json` and fill in your credentials to get started.

---

## Miner Settings

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
| `password` | string | Twitch password – only needed for first login / cookie generation. |
| `settings_password` | string | If set, the Web UI Settings tab requires this password to unlock. |
| `claim_drops_startup` | bool | Claim available drops when the miner starts. |
| `enable_analytics` | bool | Enable the Web UI / analytics server. |
| `disable_ssl_cert_verification` | bool | Disable SSL cert checks (not recommended). |
| `disable_at_in_nickname` | bool | Remove the `@` prefix from nickname in notifications. |
| `priority` | array | Priority order. Values: `STREAK`, `DROPS`, `ORDER`, `POINTS_ASCENDING`, `POINTS_DESCENDING`. |

---

## Analytics Settings

```json
"analytics": {
  "host": "0.0.0.0",
  "port": 5000,
  "refresh": 5,
  "days_ago": 7
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `host` | `"0.0.0.0"` | Bind address. Use `127.0.0.1` to restrict to localhost. |
| `port` | `5000` | Web server port. |
| `refresh` | `5` | Dashboard auto-refresh interval in minutes. |
| `days_ago` | `7` | Default chart time range in days. |

---

## Global Streamer Settings

Applied to every streamer that has no per-streamer overrides.

```json
"global_settings": {
  "make_predictions": true,
  "follow_raid": true,
  "claim_drops": true,
  "claim_moments": true,
  "watch_streak": true,
  "community_goals": false,
  "chat": "ONLINE",
  "bet": { ... }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `make_predictions` | `true` | Place bets on channel predictions. |
| `follow_raid` | `true` | Follow raids (+250 points). |
| `claim_drops` | `true` | Claim Twitch drops when available. |
| `claim_moments` | `true` | Claim Twitch Moments automatically. |
| `watch_streak` | `true` | Prioritize catching the watch streak bonus. |
| `community_goals` | `false` | Contribute to community channel point goals. |
| `chat` | `"ONLINE"` | Chat presence: `ONLINE`, `OFFLINE`, or `ALWAYS`. |

---

## Bet Settings

Nested inside `global_settings.bet` (and optionally per-streamer `settings.bet`):

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

| Key | Default | Description |
|-----|---------|-------------|
| `strategy` | `"SMART"` | See Bet Strategies below. |
| `percentage` | `5` | Percentage of current points to wager. |
| `percentage_gap` | `20` | Minimum gap between outcome percentages before placing a bet. |
| `max_points` | `50000` | Maximum points to bet per prediction. |
| `minimum_points` | `0` | Only bet if your balance is above this threshold. |
| `stealth_mode` | `true` | Always bet the minimum amount to avoid detection. |
| `delay_mode` | `"FROM_END"` | `FROM_START` or `FROM_END` – when the delay timer starts. |
| `delay` | `6` | Seconds to wait before placing the bet. |
| `filter_condition` | `null` | Skip bets based on conditions (see below). |

### Filter Condition

```json
"filter_condition": {
  "by": "TOTAL_USERS",
  "where": "LTE",
  "value": 800
}
```

`by`: `PERCENTAGE_USERS`, `ODDS_PERCENTAGE`, `ODDS`, `TOP_POINTS`, `TOTAL_USERS`, `TOTAL_POINTS`, `DECISION_USERS`, `DECISION_POINTS`  
`where`: `LT`, `LTE`, `GT`, `GTE`

### Bet Strategies

| Strategy | Description |
|----------|-------------|
| `SMART` | Decides based on prediction timing and odds. |
| `MOST_VOTED` | Bets on the outcome with the most users. |
| `HIGH_ODDS` | Bets on the underdog (highest odds). |
| `PERCENTAGE` | Bets on the outcome with the highest odds percentage. |
| `SMART_MONEY` | Follows the largest individual bettors. |
| `NUMBER_1` .. `NUMBER_8` | Always bets on a specific outcome slot. |

---

## Streamers Array

```json
"streamers": [
  { "username": "streamer01", "enabled": true, "settings": null },
  {
    "username": "streamer02",
    "enabled": true,
    "settings": {
      "make_predictions": false,
      "bet": { "strategy": "HIGH_ODDS", "max_points": 10000 }
    }
  }
]
```

- `"settings": null` → use all global defaults.
- `"enabled": false` → keep in list without watching.
- Per-streamer `settings` only overrides the fields you specify; rest falls back to global.

> **Tip:** You can manage streamers from the Web UI Settings tab.  
> Streamer list changes trigger an automatic restart via `wrapper.py` (~10 seconds).

---

## Notifications

```json
"notifications": {
  "telegram": {
    "enabled": true,
    "chat_id": "123456789",
    "token": "YOUR_BOT_TOKEN",
    "disable_notification": false,
    "events": ["BET_WIN", "BET_LOSE", "STREAMER_ONLINE"]
  },
  "discord": {
    "enabled": true,
    "webhook_api": "https://discord.com/api/webhooks/...",
    "events": ["BET_WIN", "BET_LOSE"]
  }
}
```

| Service | Required fields |
|---------|----------------|
| **Telegram** | `chat_id`, `token` (from @BotFather) |
| **Discord** | `webhook_api` (Channel Settings → Integrations → Webhooks) |
| **Webhook** | `endpoint` URL, `method` (`GET` or `POST`) |
| **Matrix** | `username`, `password`, `homeserver`, `room_id` |
| **Pushover** | `userkey`, `token`, optional `priority` and `sound` |
| **Gotify** | `endpoint` (including `?token=...`), optional `priority` |

**Available events:**  
`STREAMER_ONLINE`, `STREAMER_OFFLINE`, `GAIN_FOR_RAID`, `GAIN_FOR_CLAIM`, `GAIN_FOR_WATCH`,
`BET_WIN`, `BET_LOSE`, `BET_REFUND`, `BET_FILTERS`, `BET_GENERAL`, `BET_FAILED`, `BET_START`,
`BONUS_CLAIM`, `MOMENT_CLAIM`, `JOIN_RAID`, `DROP_CLAIM`, `DROP_STATUS`, `CHAT_MENTION`

---

## Priority System

| Value | Description |
|-------|-------------|
| `STREAK` | Prioritize streamers where a watch streak bonus is available. |
| `DROPS` | Prioritize streamers with active drop campaigns. |
| `ORDER` | Follow the order in the `streamers` array. |
| `POINTS_ASCENDING` | Prioritize channels where you have the fewest points. |
| `POINTS_DESCENDING` | Prioritize channels where you have the most points. |

Stack them: `["STREAK", "DROPS", "ORDER"]` = streak first, drops as tiebreaker, list order last.
