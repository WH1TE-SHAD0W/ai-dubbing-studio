# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:stable-alpine
# Defaults; docker-compose / `docker run -e` override them. HOST_EMAIL and HOST_PASSWORD have no default on purpose.
ENV API_UPSTREAM=http://backend:8000 \
    NGINX_RESOLVER=127.0.0.11 \
    HOST_NAME=Host
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
