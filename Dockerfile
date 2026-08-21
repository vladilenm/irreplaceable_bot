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
