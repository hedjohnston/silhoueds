# Silhoueds — one Node process, SQLite on a mounted volume.
#
# The database and uploaded images live in /data, which must be a persistent volume. Without
# one, every deploy starts with an empty game.

FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Set to "true" to also install onnxruntime-node and sharp, which power the automatic
# cut-a-silhouette-from-a-photo fallback. Off by default: it adds a few hundred MB, and the
# admin takes uploaded silhouettes anyway.
ARG INCLUDE_AUTOCUT=false

COPY package.json package-lock.json ./
RUN if [ "$INCLUDE_AUTOCUT" = "true" ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm ci --omit=optional --ignore-scripts --no-audit --no-fund; \
    fi

COPY server ./server
COPY public ./public
COPY admin ./admin
COPY tools ./tools

# Where the data lives. Mount a volume here.
ENV SILHOUEDS_DB=/data/silhoueds.db \
    SILHOUEDS_UPLOADS=/data/uploads \
    SILHOUEDS_MODEL_PATH=/app/models/u2netp.onnx \
    PORT=3000

EXPOSE 3000

# Node 22.5+ is required for the built-in SQLite; the warning it prints is expected.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]
