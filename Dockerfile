FROM node:22.21.1-alpine AS base

WORKDIR /usr/src/app

ENV HUSKY=0

# ── Stage 1: Install, build, then prune in-place ─────────────────────
#    All three operations happen in the same stage to avoid cross-stage
#    COPY of the full (dev + prod) node_modules tree.
#    After pruning, @angular-devkit and other deeply-nested devDeps
#    are removed, making the final COPY --from safe.
FROM base AS build

COPY package*.json ./
RUN npm ci --legacy-peer-deps --no-audit --fund=false

COPY . .
RUN npm run build \
    && npm prune --omit=dev --legacy-peer-deps \
    && find node_modules -xtype l -delete 2>/dev/null || true \
    && rm -rf /tmp/* /root/.npm

# ── Stage 2: Production image ────────────────────────────────────────
FROM base AS production

ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg

# Copy pruned (prod-only) node_modules — devDeps already removed
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/package*.json ./
COPY --chown=node:node --from=build /usr/src/app/dist ./dist
COPY --chown=node:node --from=build /usr/src/app/public ./public

RUN mkdir -p /usr/src/app/files && chown node:node /usr/src/app/files

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/v1/health || exit 1

# Run node directly so Docker SIGTERM is forwarded to NestJS shutdown hooks
CMD ["node", "dist/main"]
