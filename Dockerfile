FROM node:20-bookworm-slim

WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y \
  chromium \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  --no-install-recommends && \
  rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY patches ./patches
RUN npm ci --omit=dev

COPY src ./src
COPY server.js ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true

EXPOSE 3000

CMD ["node", "server.js"]
