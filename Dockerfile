FROM node:20-slim

# Apenas ferramentas de build para o better-sqlite3 (módulo nativo)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make gcc g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package*.json ./server/
RUN npm install --prefix server --omit=dev

COPY . .

CMD ["node", "server/src/index.js"]
