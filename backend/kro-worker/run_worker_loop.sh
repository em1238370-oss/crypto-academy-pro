#!/usr/bin/env bash
# Запуск KRO воркера в цикле каждые 90 секунд.
# Использование: cd backend/kro-worker && ./run_worker_loop.sh
# Перед первым запуском: source venv, задать env (source .env или export ...).

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

INTERVAL="${KRO_WORKER_INTERVAL:-60}"

echo "KRO worker loop: every ${INTERVAL}s (Ctrl+C to stop)"
while true; do
  python3 worker.py
  sleep "$INTERVAL"
done
