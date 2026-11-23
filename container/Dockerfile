# Compiles TypeScript and pre-caches the DuckDB httpfs extension so the
# runtime image never needs outbound access to extensions.duckdb.org.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

COPY docker/install-httpfs.mjs ./docker/install-httpfs.mjs
RUN node docker/install-httpfs.mjs /opt/duckdb-extensions

# ---------------------------------------------------------------------------

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DUCKDB_EXTENSION_DIR=/opt/duckdb-extensions

# node:22-slim has no system CA bundle; DuckDB's httpfs uses it (not Node's
# built-in roots), so without this every https:// read fails with
# "Problem with the SSL CA cert".
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /opt/duckdb-extensions /opt/duckdb-extensions

RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin appuser \
    && mkdir -p /data \
    && chown -R appuser:appuser /app /data /opt/duckdb-extensions

USER appuser
# Mount a volume here for AUTH_MODE=oauth-refresh's rotating credential file;
# unused (and safe to leave unmounted) for AUTH_MODE=dev-token.
VOLUME ["/data"]

# Bare health-check listener (src/health.ts) — not needed for a plain VPS/
# docker-compose deployment, but some container platforms (e.g. Cloudflare
# Containers) poll a port to decide the container finished starting.
EXPOSE 8080

ENTRYPOINT ["node", "dist/index.js"]
