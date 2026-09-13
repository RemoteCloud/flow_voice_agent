# Flow Voice — one image, one process, one port, one volume (spec 14).
#   docker build -f deploy/Dockerfile -t maranics/flow-voice:0.1 .
#   docker run -d --name flow-voice -p 8443:8443 -v flowvoice-data:/data --env-file deploy/.env maranics/flow-voice:0.1
#
# Speech: v1 runs STT/TTS on the audio endpoint (browser / Android) by default. Point STT_ENDPOINT
# at a faster-whisper / whisper.cpp server (or bundle one in a derived image, see deploy/README.md)
# for server-side transcription. Nothing is fetched at runtime.

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server ./server
COPY web ./web
COPY scripts ./scripts
RUN node scripts/build-server.mjs && npx vite build web

FROM node:22-alpine
LABEL org.opencontainers.image.title="Flow Voice" \
      org.opencontainers.image.description="Closed-loop voice service for Maranics Flow checklists" \
      org.opencontainers.image.source="https://github.com/mattiason/flow_voice_agent"
RUN apk add --no-cache tini wget && mkdir -p /data /app/public && chown -R node:node /data /app
WORKDIR /app
COPY --from=build --chown=node:node /src/dist/server.mjs /src/dist/server.mjs.map ./
COPY --from=build --chown=node:node /src/dist/public ./public
COPY --chown=node:node deploy/data-template ./data-template
USER node
ENV NODE_ENV=production \
    HUB_HOST=0.0.0.0 \
    HUB_PORT=8443 \
    HUB_DATA_DIR=/data \
    HUB_PUBLIC_DIR=/app/public
EXPOSE 8443
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8443/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# seed portable config files (stations.json, mappings.json, profiles/) on first start, then run
CMD ["sh", "-c", "for f in stations.json mappings.json; do [ -f /data/$f ] || cp data-template/$f /data/$f; done; [ -d /data/profiles ] || cp -r data-template/profiles /data/profiles; exec node server.mjs"]
