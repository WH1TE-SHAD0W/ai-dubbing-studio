# syntax=docker/dockerfile:1
#
# The Hono API image. One container serves the API and the built PWA on one
# origin (ADR-0012). Build it from the repository root, as it needs the whole
# pnpm workspace:
#
#   docker build -f apps/api/Dockerfile -t ads-api .
#
# The API is bundled into one file, so the runtime image has no node_modules:
# just Node, server.mjs and the PWA. (Installing the API's production
# dependencies instead would also pull in better-auth's optional React and
# Vitest peers, which the workspace resolves for the web app.)

# Node 24 or later for argon2 in node:crypto (ADR-0003). 24 is the LTS that
# still ships Corepack; on 25+ install pnpm another way.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Manifests first, so the install layer stays cached until dependencies change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@ads/api..." --filter "@ads/web..."

COPY packages/contracts packages/contracts
COPY apps/web apps/web
COPY apps/api apps/api
RUN pnpm --filter @ads/web build && pnpm --filter @ads/api build

# Runtime: Node, the bundle and the PWA. No pnpm, no dependencies, no build tools.
FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/web \
    MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /repo/apps/api/dist/server.mjs ./server.mjs
COPY --from=build /repo/apps/web/dist ./web
# The .sql files aren't part of the bundle, so they're copied in as they are.
COPY --from=build /repo/apps/api/migrations ./migrations

USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
