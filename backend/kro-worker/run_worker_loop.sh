#!/usr/bin/env bash
# KRO воркер: обработка check_queue (каждые 60с) + 12-часовой мониторинг (08:00 и 20:00 UTC).
# Использование: cd backend/kro-worker && ./run_worker_loop.sh
# Перед первым запуском: source venv, задать env (source .env или export ...).

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# На Render передаём session через env-переменную, а не файл в репозитории.
if [[ -n "${TELEGRAM_SESSION_B64:-}" ]]; then
  printf '%s' "$TELEGRAM_SESSION_B64" | base64 -d > /tmp/kro_worker.session
  export TELEGRAM_SESSION_NAME=/tmp/kro_worker
  echo "Telethon session restored to /tmp/kro_worker.session"
fi

INTERVAL="${KRO_WORKER_INTERVAL:-60}"
# Минимальный интервал между запусками 12h-монитора: 11 часов (39600с), чтобы не пропустить
# плановые окна 08:00 UTC и 20:00 UTC при небольших задержках.
MONITOR_MIN_INTERVAL=39600
LAST_MONITOR_FILE="/tmp/kro_last_monitor_run"

run_12h_monitor_if_due() {
  local now
  now=$(date +%s)
  local hour_utc
  hour_utc=$(date -u +%H)

  # Плановые окна: 08:00 UTC (11:00 MSK) и 20:00 UTC (23:00 MSK)
  if [[ "$hour_utc" != "08" && "$hour_utc" != "20" ]]; then
    return
  fi

  # Проверяем, не запускали ли монитор менее 11 часов назад
  if [[ -f "$LAST_MONITOR_FILE" ]]; then
    local last_run
    last_run=$(cat "$LAST_MONITOR_FILE")
    local elapsed=$(( now - last_run ))
    if (( elapsed < MONITOR_MIN_INTERVAL )); then
      return
    fi
  fi

  echo "$(date -u '+%Y-%m-%d %H:%M UTC') — Запуск 12h-мониторинга (run_12h_monitor.py)..."
  echo "$now" > "$LAST_MONITOR_FILE"
  python3 run_12h_monitor.py >> /tmp/kro_monitor.log 2>&1 &
  echo "run_12h_monitor.py запущен в фоне (PID $!). Лог: /tmp/kro_monitor.log"
}

echo "KRO worker loop: check_queue каждые ${INTERVAL}с, 12h-монитор в 08:00 и 20:00 UTC"
while true; do
  python3 worker.py
  run_12h_monitor_if_due
  sleep "$INTERVAL"
done
