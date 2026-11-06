# syntax=docker/dockerfile:1
#
# Node spike worker (ADR-0019). Build from benchmarks/runtime-test/worker-node:
#
#   docker build -t ads-spike-worker-node .
#
# Debian, not Alpine: @livekit/rtc-node ships its native FFI library only for glibc
# (linux-x64-gnu, linux-arm64-gnu), so there is no musl build to run on Alpine.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src src
RUN npx tsc && npm prune --omit=dev

# Runtime: Node, the compiled JS and the production dependencies.
FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/worker.js"]
