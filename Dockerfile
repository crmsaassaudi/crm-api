# syntax=docker/dockerfile:1
# NOTE: If buildx is unavailable, remove the syntax directive above
# and the --mount flags below, then set DOCKER_BUILDKIT=0.

FROM node:22.21.1-alpine AS base

WORKDIR /usr/src/app

ENV HUSKY=0

FROM base AS deps

COPY package*.json ./
RUN npm ci --legacy-peer-deps --no-audit --fund=false

FROM deps AS build

COPY . .
RUN npm run build

FROM base AS production

ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps --no-audit --fund=false

COPY --chown=node:node --from=build /usr/src/app/dist ./dist

RUN mkdir -p /usr/src/app/files && chown node:node /usr/src/app/files

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/v1/health || exit 1

# Run node directly so Docker SIGTERM is forwarded to NestJS shutdown hooks
# NODE_ENV=production is already set via ENV directive above
CMD ["node", "dist/main"]
