# --- Build the dashboard ---
FROM node:22-bookworm-slim AS client
WORKDIR /app/client
# Node's fast disk reader corrupts secure downloads inside some Docker setups.
ENV UV_USE_IO_URING=0
COPY client/package.json ./
COPY client/package-lock.json ./
RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm config set fetch-timeout 600000 \
  && i=0; until npm ci; do \
       i=$((i+1)); \
       if [ "$i" -ge 4 ]; then exit 1; fi; \
       echo "npm ci failed, retrying ($i)"; \
       sleep 15; \
     done
COPY client/ ./
RUN npm run build

# --- Server ---
FROM node:22-bookworm-slim
WORKDIR /app/server
ENV UV_USE_IO_URING=0
# ffmpeg reads WhatsApp/Telegram voice notes for speech-to-text.
# Retry downloads: on slow connections the Debian mirror sometimes drops them half way.
RUN printf 'Acquire::Retries "10";\nAcquire::http::Timeout "60";\n' > /etc/apt/apt.conf.d/80-retries \
  && apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates ffmpeg curl \
  && rm -rf /var/lib/apt/lists/*
# Piper gives the AI its own voice (text-to-speech on this computer). Voices download on first use.
ARG TARGETARCH
RUN case "$TARGETARCH" in arm64) A=aarch64 ;; *) A=x86_64 ;; esac \
  && curl -fsSL --retry 5 --retry-delay 3 "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_$A.tar.gz" | tar -xz -C /opt \
  && test -x /opt/piper/piper
COPY server/package.json ./
COPY server/package-lock.json ./
# The speech engine ships binaries for every OS; keep only Linux to save ~200 MB.
RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm config set fetch-timeout 600000 \
  && i=0; until npm ci --omit=dev; do \
       i=$((i+1)); \
       if [ "$i" -ge 4 ]; then exit 1; fi; \
       echo "npm ci failed, retrying ($i)"; \
       sleep 15; \
     done \
  && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32
COPY server/ ./
COPY --from=client /app/client/dist /app/client/dist

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    CLIENT_DIR=/app/client/dist
VOLUME /data
EXPOSE 3000
CMD ["node", "src/index.js"]
