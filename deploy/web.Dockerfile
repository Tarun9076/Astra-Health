# ASTRA HEALTH web app: built with Vite, served by Caddy, which also proxies the two backends and gets
# an HTTPS certificate automatically (the camera coach and the watch need HTTPS). Context: the repo root.
FROM node:24-alpine AS build
WORKDIR /app
# the emergency procedures are bundled into the app from protocols/
COPY protocols protocols
COPY apps/web/package.json apps/web/package-lock.json apps/web/
RUN cd apps/web && npm ci
COPY apps/web apps/web
RUN cd apps/web && npm run build

FROM caddy:2.10-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
