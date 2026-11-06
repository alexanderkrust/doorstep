# doorstep: Autosuggest API based on OSM, one image, no external services.
#
#   docker build -t doorstep-api .
#   docker run -p 2322:2322 -v data:/data doorstep-api
#
# Debian instead of Alpine: osmium-tool comes straight from the Debian packages. SQLite is
# built into Node as `node:sqlite` (with FTS5 and R*Tree); nothing is compiled natively.
ARG NODE_IMAGE=node:24.22.2-trixie-slim

# --- Stage 1: build TypeScript ---------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Stage 2: production dependencies only --------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- Stage 3: runtime image -------------------------------------------------------
# Debian security updates are installed at build time, so the image does not wait for the
# next Node release. npm, npx, corepack and yarn are only needed to build; they are removed
# because the vulnerability scan finds outdated packages bundled in npm, and nothing at
# runtime uses them (the entry point calls node directly).
FROM ${NODE_IMAGE}
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends osmium-tool \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg

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

# Non-root user from the Node image (uid 1000).
USER node
VOLUME /data
EXPOSE 2322

# /health answers as soon as the API is running, also during the first import
# (the `index` and `importing` fields show the state).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.js"]

ENTRYPOINT ["doorstep"]
CMD ["serve"]
