FROM node:22.21.1-alpine AS base

WORKDIR /usr/src/app

ENV HUSKY=0

# ── Stage 1: Install ALL deps (dev + prod) for building ──────────────
FROM base AS deps

COPY package*.json ./
RUN npm ci --legacy-peer-deps --no-audit --fund=false \
    && rm -rf /tmp/* /root/.npm

# ── Stage 2: Build with SWC ──────────────────────────────────────────
FROM deps AS build

COPY . .
RUN npm run build

# ── Stage 3: Production deps only (clean install, no cross-stage COPY)
#    Avoids containerd/overlayfs bugs by NOT copying node_modules
#    between stages. A fresh npm ci is more reliable than COPY + prune.
FROM base AS prod-deps

COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps --no-audit --fund=false \
    && rm -rf /tmp/* /root/.npm

# ── Stage 4: Production image ────────────────────────────────────────
FROM base AS production

ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg

# Copy production-only node_modules (clean install, no devDeps)
COPY --from=prod-deps /usr/src/app/node_modules ./node_modules
COPY --from=prod-deps /usr/src/app/package*.json ./
COPY --chown=node:node --from=build /usr/src/app/dist ./dist

RUN mkdir -p /usr/src/app/files && chown node:node /usr/src/app/files

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/v1/health || exit 1

# Run node directly so Docker SIGTERM is forwarded to NestJS shutdown hooks
# NODE_ENV=production is already set via ENV directive above
CMD ["node", "dist/main"]
