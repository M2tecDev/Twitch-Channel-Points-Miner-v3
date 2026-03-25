# =============================================================================
# Twitch-Channel-Points-Miner-v3  –  Dockerfile
# Strategy: Multi-Stage Build
#   Stage 1 (builder)  – compile/install all Python dependencies
#   Stage 2 (final)    – lean runtime image, only what's needed to run
#
# Persistent user-data (mount as volumes, never baked into the image):
#   /app/config.json   – bot configuration
#   /app/cookies/      – Twitch auth cookies  (<username>.pkl)
#   /app/logs/         – rotating log files
#   /app/analytics/    – analytics SQLite databases
# =============================================================================

# ── Stage 1 : Builder ─────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

ARG BUILDX_QEMU_ENV

WORKDIR /build

# Build-time dependencies  (not needed at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        g++ \
        libffi-dev \
        libssl-dev \
        zlib1g-dev \
        libjpeg-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Install packages into a separate prefix so we can COPY them cleanly
# CRYPTOGRAPHY_DONT_BUILD_RUST avoids the heavy Rust toolchain on most arches.
RUN CRYPTOGRAPHY_DONT_BUILD_RUST=1 \
    pip install --no-cache-dir --prefix=/install \
        # 32-bit QEMU environments need an older cryptography build
        $([ "${BUILDX_QEMU_ENV}" = "true" ] && [ "$(getconf LONG_BIT)" = "32" ] \
            && echo "cryptography==3.3.2" || true) \
    && pip install --no-cache-dir --prefix=/install -r requirements.txt


# ── Stage 2 : Final runtime image ─────────────────────────────────────────────
FROM python:3.12-slim

LABEL org.opencontainers.image.title="Twitch-Channel-Points-Miner-v3" \
      org.opencontainers.image.description="Automated Twitch Channel Points Miner – v3" \
      org.opencontainers.image.url="https://github.com/M2tecDev/Twitch-Channel-Points-Miner-v3" \
      org.opencontainers.image.licenses="MIT"

# Runtime-only shared libraries (no -dev packages, no compiler)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libjpeg62-turbo \
    && rm -rf /var/lib/apt/lists/*

# Pull compiled Python packages from the builder stage
COPY --from=builder /install /usr/local

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
# Analytics web UI  (Flask)
EXPOSE 5000

# ── Health check ──────────────────────────────────────────────────────────────
# Pings the analytics endpoint.  Disable this if enable_analytics=false.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD python - <<'EOF'
import urllib.request, sys
try:
    urllib.request.urlopen("http://localhost:5000/", timeout=8)
    sys.exit(0)
except Exception:
    sys.exit(1)
EOF

# ── Entry point ───────────────────────────────────────────────────────────────
# wrapper.py supervises run.py and handles:
#   • auto-restart on crash
#   • graceful restart when the streamer list in config.json changes
# run.py handles hot-reload of bet/notification settings (no restart needed).
ENTRYPOINT ["python", "wrapper.py"]
