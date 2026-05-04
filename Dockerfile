FROM node:20-slim

# Instala Chromium do sistema + dependências necessárias + ferramentas de build (better-sqlite3)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       chromium \
       ca-certificates \
       fonts-liberation \
       libasound2 \
       libatk-bridge2.0-0 \
       libatk1.0-0 \
       libcups2 \
       libdbus-1-3 \
       libgbm1 \
       libgtk-3-0 \
       libnspr4 \
       libnss3 \
       libxcomposite1 \
       libxdamage1 \
       libxrandr2 \
       xdg-utils \
       python3 make gcc g++ \
    && rm -rf /var/lib/apt/lists/*

# Usa o Chromium do sistema — evita baixar o bundled do Puppeteer (~300MB a menos)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY server/package*.json ./server/
RUN npm install --prefix server --omit=dev

COPY . .

CMD ["node", "server/src/index.js"]
