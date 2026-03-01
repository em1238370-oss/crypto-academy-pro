# Проверка любого канала: Node (API) + Python 3 + Telethon (живая проверка)
FROM node:20-bookworm

# Python 3 и pip для kro-worker/check_once.py
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

WORKDIR /app/backend
RUN npm ci 2>/dev/null || npm install --production

# Зависимости для живой проверки каналов (Telethon)
RUN pip3 install --break-system-packages -r kro-worker/requirements.txt 2>/dev/null || pip3 install -r kro-worker/requirements.txt

WORKDIR /app/backend
EXPOSE 4000
ENV NODE_ENV=production
CMD ["node", "server.js"]
