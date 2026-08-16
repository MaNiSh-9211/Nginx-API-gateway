# syntax=docker/dockerfile:1
# UAM frontend — React SPA behind nginx with same-origin gateway proxy (ADR-0052).

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* .npmrc ./
RUN npm install
COPY . .
# Same-origin: browser calls /api/* → nginx → gateway → uam-backend
ENV VITE_API_URL=/api
RUN npx vite build

FROM nginx:1.27-alpine
RUN apk add --no-cache gettext \
    && rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY cloudflare/cdn-static.conf /etc/nginx/cloudflare/cdn-static.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN sed -i 's/\r$//' /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:80/ >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
