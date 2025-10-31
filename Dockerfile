# syntax=docker/dockerfile:1

# Build stage for frontend
FROM node:20-bookworm AS frontend-builder
WORKDIR /app/catflix_frontend

# Enable pnpm
RUN corepack enable pnpm

COPY catflix_frontend/package.json catflix_frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --shamefully-hoist

COPY catflix_frontend/ ./
RUN pnpm run build

# Runtime stage for backend + encoder
FROM node:20-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Enable pnpm
RUN corepack enable pnpm

COPY catflix_backend/package.json catflix_backend/pnpm-lock.yaml ./catflix_backend/
WORKDIR /app/catflix_backend
RUN pnpm install --frozen-lockfile --prod

WORKDIR /app
COPY catflix_backend ./catflix_backend
COPY catflix_encoding ./catflix_encoding
COPY --from=frontend-builder /app/catflix_frontend/build ./catflix_backend/frontend/build

# share backend dependencies with encoder worker
RUN ln -s /app/catflix_backend/node_modules /app/catflix_encoding/node_modules

WORKDIR /app/catflix_backend

ENV PORT=3004

EXPOSE 3004

CMD ["node", "server.js"]
