# syntax=docker/dockerfile:1
#
# One image for the live-track tools (host.ts, dispatch.ts, listener.ts).
# Node 24 runs the TypeScript directly (type stripping), so there is no build step.
# Debian, because @livekit/rtc-node has no musl build.
FROM node:24-bookworm-slim
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund
COPY *.ts ./
USER node
