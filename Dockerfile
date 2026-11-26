# Node 22 LTS. better-sqlite3 ships prebuilt binaries for it; the build tools are only
# used as a fallback if a prebuilt binary cannot be downloaded.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json server.js ./
COPY public ./public
RUN mkdir -p /data
EXPOSE 3000
# Run node directly (not through npm) so SIGTERM from Render reaches the process.
CMD ["node", "server.js"]
