#!/bin/bash
# Запуск 12ч монитора из любой папки. Скрипт лежит в backend/kro-worker/
DIR="$(cd "$(dirname "$0")/backend/kro-worker" && pwd)"
cd "$DIR"
[ -f .env ] && set -a && source .env && set +a
# Чтобы Python точно нашёл ключ Google
[ -f "$DIR/credentials.json" ] && export GOOGLE_APPLICATION_CREDENTIALS="$DIR/credentials.json"
python3 run_12h_monitor.py
exit $?
