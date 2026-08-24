# Pinned userspace client used only when TELEGRAM_PROXY_VLESS_URL is supplied.
FROM ghcr.io/xtls/xray-core:26.3.27@sha256:592ec4d11f656db95598d01e76dbcc6e002d67360b96a5436500a938230f52c7 AS xray

# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY --from=xray /usr/local/bin/xray /usr/local/bin/xray

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Runtime source configuration and LLM prompts are not bundled by TypeScript.
COPY config ./config
COPY prompts ./prompts

RUN addgroup -g 1001 -S botuser && \
    adduser -S botuser -u 1001
USER botuser

CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
