# ─── BUILD STAGE ──────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ─── RUNTIME STAGE ────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# non-root user for security ✅
RUN addgroup -S search && adduser -S search -G search

# copy deps from builder ✅
COPY --from=builder /app/node_modules ./node_modules

# copy app source ✅
COPY --chown=search:search . .

# create all writable directories ✅
# volumes will mount over these in production ✅
RUN mkdir -p \
  logs \
  multiTenantLogs \
  learned \
  sync_state \
  data && \
  chown -R search:search \
  logs multiTenantLogs learned sync_state data

USER search

EXPOSE 3000

# health check ✅
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
