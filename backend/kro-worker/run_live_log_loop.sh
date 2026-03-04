#!/bin/bash
# Каждые 5 минут запускает update_live_log_5min.py (жирная строка в документе).
# Запуск: из этой папки выполни   bash run_live_log_loop.sh
# Чтобы работало в фоне:   nohup bash run_live_log_loop.sh > live_log_loop.log 2>&1 &
cd "$(dirname "$0")"
while true; do
  python3 update_live_log_5min.py
  sleep 300
done
