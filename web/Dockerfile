# Multi-stage. Default (last) stage = dev so the base `docker compose up`
# (which builds ./web with no target) keeps the hot-reload Vite server
# unchanged. Production is an explicit target built by docker-compose.prod.yml.

# ---- build: produce static dist/ ----
FROM node:20-slim AS build
WORKDIR /app
# Vite inlines import.meta.env.VITE_* at build time, so these must be
# present here (not as runtime env on the nginx container).
ARG VITE_API_BASE=/api
ARG VITE_MAPBOX_TOKEN=
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# ---- prod: nginx serving dist + proxying /api ----
FROM nginx:1.27-alpine AS prod
COPY nginx.prod.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
# nginx:alpine's default CMD starts the server.

# ---- dev (default) ----
FROM node:20-slim AS dev
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 5173
# Dev server for the base compose; production is the `prod` stage above.
CMD ["npm", "run", "dev"]
