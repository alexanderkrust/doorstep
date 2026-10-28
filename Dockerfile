# doorstep: Autosuggest-API auf OSM-Basis, ein Image, keine externen Dienste.
#
#   docker build -t meine-api .
#   docker run -p 2322:2322 -v data:/data meine-api
#
# Debian statt Alpine: osmium-tool kommt direkt aus den Debian-Paketen. SQLite steckt
# als `node:sqlite` in Node selbst (mit FTS5 und R*Tree), es wird nichts nativ gebaut.
ARG NODE_IMAGE=node:24.22.1-trixie-slim

# --- Stage 1: TypeScript bauen ---------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Stage 2: nur Produktions-Abhängigkeiten -----------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- Stage 3: Laufzeit-Image ---------------------------------------------------------
FROM ${NODE_IMAGE}
RUN apt-get update \
  && apt-get install -y --no-install-recommends osmium-tool \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
  DATA_DIR=/data \
  PORT=2322 \
  AUTO_IMPORT=true

COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/healthcheck.js ./docker/healthcheck.js
COPY docker/entrypoint.sh /usr/local/bin/doorstep
RUN chmod 0755 /usr/local/bin/doorstep \
  && mkdir -p /data \
  && chown node:node /data

# Nicht-Root-Nutzer aus dem Node-Image (uid 1000).
USER node
VOLUME /data
EXPOSE 2322

# /health antwortet, sobald die API läuft, auch während des ersten Imports
# (Felder `index` und `importing` zeigen den Stand).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.js"]

ENTRYPOINT ["doorstep"]
CMD ["serve"]
