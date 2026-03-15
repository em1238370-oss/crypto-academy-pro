#!/usr/bin/env bash
# Запуск KRO воркера в цикле каждые 90 секунд.
# Использование: cd backend/kro-worker && ./run_worker_loop.sh
# Перед первым запуском: source venv, задать env (source .env или export ...).

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# На Render удобнее передавать session через env, а не через файл в репозитории.
if [[ -n "${TELEGRAM_SESSION_B64:-}" ]]; then
  printf '%s' "$TELEGRAM_SESSION_B64" | base64 -d > /tmp/kro_worker.session
  export TELEGRAM_SESSION_NAME=/tmp/kro_worker
  echo "Telethon session restored to /tmp/kro_worker.session"
fi

INTERVAL="${KRO_WORKER_INTERVAL:-60}"

echo "KRO worker loop: every ${INTERVAL}s (Ctrl+C to stop)"
while true; do
  python3 worker.py
  sleep "$INTERVAL"
done
