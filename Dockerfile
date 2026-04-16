# Проверка любого канала: Node (API) + Python 3 + Telethon (живая проверка check_once).
# На Render выберите Environment: Docker и этот Dockerfile (или подключите render.yaml).
FROM node:20-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1

WORKDIR /app
COPY . .

WORKDIR /app/backend
RUN npm ci 2>/dev/null || npm install --production

# Telethon и зависимости kro-worker (обязательно для /api/kro/channel-profile).
RUN pip3 install --no-cache-dir --break-system-packages -r kro-worker/requirements.txt \
  || pip3 install --no-cache-dir -r kro-worker/requirements.txt

WORKDIR /app/backend
EXPOSE 4000
ENV NODE_ENV=production
CMD ["node", "server.js"]
