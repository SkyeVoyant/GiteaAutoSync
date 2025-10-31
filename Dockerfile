FROM node:20-alpine

WORKDIR /app

# Install git (required for autosync)
RUN apk add --no-cache git

# Enable pnpm
RUN corepack enable pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile --prod

COPY . .

ENV NODE_ENV=production
CMD ["pnpm", "run", "start:watch"]
