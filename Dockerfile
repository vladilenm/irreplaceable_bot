# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Native toolchain is the fallback when better-sqlite3 has no matching prebuild.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Runtime source configuration and LLM prompts are not bundled by TypeScript.
COPY config ./config
COPY prompts ./prompts

# SQLite runs as an unprivileged user and writes only to /app/data.
RUN addgroup -g 1001 -S botuser && \
    adduser -S botuser -u 1001 && \
    mkdir -p /app/data && \
    chown -R botuser:botuser /app/data
USER botuser

CMD ["node", "dist/index.js"]
