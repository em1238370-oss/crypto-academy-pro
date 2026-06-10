# Проверка любого канала: Node (API) + Python 3 + Telethon (живая проверка check_once).
# На Render: Environment = Docker, Dockerfile path = ./Dockerfile, Root = repo root (как в render.yaml).
# Версия Node совпадает с типичным Native Node на Render (22.x), чтобы не было сюрпризов при сравнении логов.
FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1
# Все Python-команды внутри venv
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

WORKDIR /app
COPY . .

WORKDIR /app/backend
RUN npm ci --omit=dev --no-audit --no-fund 2>/dev/null \
  || npm install --omit=dev --no-audit --no-fund

# Telethon и зависимости kro-worker (обязательно для /api/kro/channel-profile).
RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
  && pip install --no-cache-dir -r kro-worker/requirements.txt

WORKDIR /app/backend
EXPOSE 4000
ENV NODE_ENV=production
CMD ["node", "server.js"]
