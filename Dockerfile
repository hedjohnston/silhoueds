# Silhoueds — one Node process, SQLite on a mounted volume.
#
# The database and uploaded images live in /data, which must be a persistent volume. Without
# one, every deploy starts with an empty game.

FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public
COPY admin ./admin

# Where the data lives. Mount a volume here.
ENV SILHOUEDS_DB=/data/silhoueds.db \
    SILHOUEDS_UPLOADS=/data/uploads \
    PORT=3000

EXPOSE 3000

# Node 22.5+ is required for the built-in SQLite; the warning it prints is expected.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]
