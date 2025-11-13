FROM node:20-alpine

WORKDIR /app

# Install git (required for autosync)
RUN apk add --no-cache git

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV NODE_ENV=production
CMD ["node", "index.js", "--watch"]
