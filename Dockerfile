FROM node:22.21.1-alpine AS deps

WORKDIR /usr/src/app

ENV HUSKY=0

COPY package*.json ./
RUN npm ci --legacy-peer-deps

FROM node:22.21.1-alpine AS build

WORKDIR /usr/src/app

ENV HUSKY=0

COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22.21.1-alpine AS production

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV HUSKY=0

RUN apk add --no-cache ffmpeg

ARG APP_UID=1000
ARG APP_GID=1000
RUN addgroup -S -g ${APP_GID} appgroup && adduser -S -D -H -u ${APP_UID} -G appgroup appuser

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps && npm cache clean --force

COPY --chown=appuser:appgroup --from=build /usr/src/app/dist ./dist

RUN mkdir -p /usr/src/app/files && chown appuser:appgroup /usr/src/app/files

USER appuser

EXPOSE 3000

CMD ["npm", "run", "start:prod"]
