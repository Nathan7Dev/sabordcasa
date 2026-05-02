FROM node:20-slim

# Ferramentas necessárias para compilar better-sqlite3 (módulo nativo)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make gcc g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia só o package.json primeiro — camada de cache separada
COPY server/package*.json ./server/
RUN npm install --prefix server --omit=dev

# Copia o restante do projeto
COPY . .

CMD ["node", "server/src/index.js"]
