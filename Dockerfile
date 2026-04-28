# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# v2.0 SETUP-05: native build deps for better-sqlite3 fallback path.
# 99% of installs use the linuxmusl-x64 prebuild for ABI 115; toolchain
# exists for the failure mode (network hiccup, ABI drift).
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

# v2.0 SETUP-07: pre-create /app/data with botuser ownership BEFORE USER directive.
# When bind-mount overlay arrives empty, container inherits these perms;
# when bind-mount has host perms, host-side `chown -R 1001:1001 ./data` covers it
# (documented in Phase 0-Ops checklist).
RUN addgroup -g 1001 -S botuser && \
    adduser -S botuser -u 1001 && \
    mkdir -p /app/data && \
    chown -R botuser:botuser /app/data
USER botuser

CMD ["node", "dist/index.js"]
