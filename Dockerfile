# Amigos Share · Stremio em contêiner. Uso pessoal: publique as portas só em
# 127.0.0.1 (veja docker-compose.yml e scripts/docker.sh). Nunca exponha à internet.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    ASCSTREMIO_CONTAINER=1 \
    DATA_DIR=/data \
    PORT=7000 BRIDGE_PORT=7010 CONFIG_PORT=7020 TORRENT_PORT=7030
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7000 7010 7020 7030
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7010/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGINT
CMD ["node", "--max-http-header-size=65536", "src/index.js"]
