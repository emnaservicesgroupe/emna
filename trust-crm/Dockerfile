# VITA / EMNA CRM - production image (Task 20). Built by deploy/hostinger/docker-compose.yml.
# - Node 22 (slim), production dependencies only (npm ci --omit=dev), runtime files only (no tests/docs/.env)
# - runs as the unprivileged "node" user; uploads live in the /data/storage volume
# - entrypoint: preflight + database init/migrations (idempotent), then server.js (graceful SIGTERM)
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=5000 \
    STORAGE_DIR=/data/storage \
    NODE_OPTIONS=--max-old-space-size=512
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json package-lock.json app.js db.js server.js ./
COPY --chown=root:root ai ./ai
COPY --chown=root:root jobs ./jobs
COPY --chown=root:root middleware ./middleware
COPY --chown=root:root models ./models
COPY --chown=root:root modules ./modules
COPY --chown=root:root public ./public
COPY --chown=root:root routes ./routes
COPY --chown=root:root scripts ./scripts
COPY --chown=root:root sql ./sql
COPY --chown=root:root utils ./utils
# Application code is owned by root and read-only for the app user; only /data/storage is writable.
RUN mkdir -p /data/storage \
    && chown node:node /data/storage \
    && chmod 700 /data/storage \
    && chmod 755 /app/scripts/docker-entrypoint.sh
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
