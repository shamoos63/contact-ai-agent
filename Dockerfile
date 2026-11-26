# --- Build the dashboard ---
FROM node:22-bookworm-slim AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# --- Server ---
FROM node:22-bookworm-slim
WORKDIR /app/server
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
COPY server/package.json server/package-lock.json ./
# The speech engine ships binaries for every OS; keep only Linux to save ~200 MB.
RUN npm ci --omit=dev \
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
