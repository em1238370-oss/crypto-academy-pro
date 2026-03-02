#!/bin/bash
# Запуск сбора (11:00 и 23:00 MSK). По плану: сбор → Doc «Источники и данные» → kro-12h-stats-pending.json
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
[ -f env ] && set -a && source env && set +a
export MODE=collect
exec python3 run_12h_monitor.py
