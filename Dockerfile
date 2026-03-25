# =============================================================================
# Twitch-Channel-Points-Miner-v3  –  Dockerfile
# Strategy: Multi-Stage Build  (builder → slim runtime)
#
# Persistent user-data – mount as volumes, never baked into the image:
#   /app/config.json   – bot configuration
#   /app/cookies/      – Twitch auth cookies  (<username>.pkl)
#   /app/logs/         – rotating log files
#   /app/analytics/    – analytics SQLite databases
# =============================================================================

# ── Stage 1 : Builder ─────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /build

# Build-time dependencies (compiler + headers for native extensions)
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        g++ \
        libffi-dev \
        libssl-dev \
        zlib1g-dev \
        libjpeg-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Virtualenv-Pattern: Standard für Multi-Stage-Python-Builds.
# Alle Pakete landen in /venv, werden 1:1 in die Final-Stage kopiert.
# CRYPTOGRAPHY_DONT_BUILD_RUST=1 vermeidet den Rust-Toolchain auf allen Arches.
RUN python -m venv /venv \
    && /venv/bin/pip install --no-cache-dir --upgrade pip \
    && CRYPTOGRAPHY_DONT_BUILD_RUST=1 \
       /venv/bin/pip install --no-cache-dir -r requirements.txt


# ── Stage 2 : Final runtime image ─────────────────────────────────────────────
FROM python:3.12-slim

LABEL org.opencontainers.image.title="Twitch-Channel-Points-Miner-v3" \
      org.opencontainers.image.description="Automated Twitch Channel Points Miner – v3" \
      org.opencontainers.image.url="https://github.com/M2tecDev/Twitch-Channel-Points-Miner-v3" \
      org.opencontainers.image.licenses="MIT"

# Runtime shared libraries only (no compiler, no -dev packages)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libjpeg62-turbo \
    && rm -rf /var/lib/apt/lists/*

# Virtualenv aus dem Builder übernehmen und aktivieren
COPY --from=builder /venv /venv
ENV PATH="/venv/bin:$PATH"

WORKDIR /app

# ── Application code (fixed inside the image) ─────────────────────────────────
COPY TwitchChannelPointsMiner/ ./TwitchChannelPointsMiner/
COPY assets/                   ./assets/
COPY run.py wrapper.py         ./

# ── Security: run as an unprivileged user ─────────────────────────────────────
RUN useradd -r -u 1000 -m -s /usr/sbin/nologin miner \
    && mkdir -p /app/logs /app/cookies /app/analytics \
    && chown -R miner:miner /app

USER miner

# ── Networking ────────────────────────────────────────────────────────────────
EXPOSE 5000

# ── Health check ──────────────────────────────────────────────────────────────
# Entfernen/auskommentieren wenn enable_analytics=false in config.json.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5000/', timeout=8)"

# ── Entry point ───────────────────────────────────────────────────────────────
# wrapper.py überwacht run.py:
#   • Auto-Restart bei Absturz
#   • Graceful Restart bei Streamer-Listen-Änderung in config.json
#   • Fängt SIGINT und SIGTERM für sauberes Docker-Shutdown
ENTRYPOINT ["python", "wrapper.py"]
