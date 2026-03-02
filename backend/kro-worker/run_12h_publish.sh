#!/bin/bash
# Публикация JSON (12:15 и 00:15 MSK). По плану: pending → kro-12h-stats.json для сайта
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
[ -f env ] && set -a && source env && set +a
export MODE=publish
exec python3 run_12h_monitor.py
