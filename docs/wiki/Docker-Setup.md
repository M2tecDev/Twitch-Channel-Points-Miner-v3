# Docker Setup

The recommended way to run CPM v3 in production is via Docker.  
The image is published to both **Docker Hub** and **GitHub Container Registry (GHCR)**.

---

## Quick Start

```bash
# 1. Clone the repo (or just grab the two files below)
git clone https://github.com/M2tecDev/Twitch-Channel-Points-Miner-v3
cd Twitch-Channel-Points-Miner-v3

# 2. Create your config
cp config.json.example config.json
# → edit config.json with your Twitch username and streamer list

# 3. Start
docker compose up -d

# 4. Check logs
docker compose logs -f

# 5. Open the Web UI
# http://localhost:5000
```

---

## Volume Structure

The Docker image follows a strict **code in image / data on host** split:

| Host path | Container path | Purpose |
|-----------|---------------|---------|
| `./config.json` | `/app/config.json` | Bot configuration (read-only) |
| `./data/cookies/` | `/app/cookies/` | Twitch auth cookies (`<username>.pkl`) |
| `./data/logs/` | `/app/logs/` | Rotating log files |
| `./data/analytics/` | `/app/analytics/` | Analytics SQLite databases |

The `data/` sub-directories are created automatically on first run.

---

## docker-compose.yml Reference

```yaml
services:
  miner:
    image: ghcr.io/m2tecdev/twitch-channel-points-miner-v3:latest
    # build: { context: . }   ← uncomment to build locally
    container_name: tcpm-miner
    restart: unless-stopped
    stop_signal: SIGINT        # wrapper.py catches KeyboardInterrupt
    stop_grace_period: 30s
    environment:
      TZ: Europe/Berlin        # adjust to your timezone
    volumes:
      - ./config.json:/app/config.json:ro
      - ./data/cookies:/app/cookies
      - ./data/logs:/app/logs
      - ./data/analytics:/app/analytics
    ports:
      - "5000:5000"
    healthcheck:
      test: ["CMD", "python", "-c",
             "import urllib.request; urllib.request.urlopen('http://localhost:5000/')"]
      interval: 30s
      timeout: 10s
      start_period: 90s
      retries: 3
```

> **Note:** Remove or comment out the `healthcheck` block if `enable_analytics` is `false`  
> in your `config.json` – the endpoint won't be available in that case.

---

## Building Locally

```bash
docker build -t tcpm-v3 .

# or with BuildKit cache
DOCKER_BUILDKIT=1 docker build -t tcpm-v3 .
```

The Dockerfile uses a **multi-stage build**:

| Stage | Base image | Purpose |
|-------|-----------|---------|
| `builder` | `python:3.12-slim` | Installs all Python deps with build tools |
| final | `python:3.12-slim` | Copies compiled packages, no build tools |

Estimated final image size: **~250–300 MB**.

---

## Multi-Platform (ARM / Raspberry Pi)

The CI pipeline builds for `linux/amd64`, `linux/arm64`, and `linux/arm/v7` automatically.  
To build multi-platform locally:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  --build-arg BUILDX_QEMU_ENV=true \
  -t tcpm-v3 .
```

---

## First Login / Cookie Generation

On first start, the bot will prompt you to authorize via **Twitch Device Flow**:

1. Watch the container logs: `docker compose logs -f`
2. Open `https://www.twitch.tv/activate` in your browser
3. Enter the code shown in the logs
4. The bot generates `data/cookies/<username>.pkl` and continues automatically

The cookie file is reused on all subsequent starts.

---

## Useful Commands

```bash
# Start in background
docker compose up -d

# Follow logs
docker compose logs -f

# Graceful stop (wrapper.py flushes and exits cleanly)
docker compose stop

# Restart after config.json change
docker compose restart

# Pull latest image
docker compose pull && docker compose up -d

# Remove container + volumes (WARNING: deletes cookies/logs/analytics)
docker compose down -v
```

---

## Disabling the Healthcheck

If you set `enable_analytics: false` in `config.json`, comment out the healthcheck in `docker-compose.yml`:

```yaml
# healthcheck:
#   test: [...]
```

---

## Running Without Docker Compose (bare `docker run`)

```bash
docker run -d \
  --name tcpm-miner \
  --restart unless-stopped \
  --stop-signal SIGINT \
  -e TZ=Europe/Berlin \
  -v "$(pwd)/config.json:/app/config.json:ro" \
  -v "$(pwd)/data/cookies:/app/cookies" \
  -v "$(pwd)/data/logs:/app/logs" \
  -v "$(pwd)/data/analytics:/app/analytics" \
  -p 5000:5000 \
  ghcr.io/m2tecdev/twitch-channel-points-miner-v3:latest
```
