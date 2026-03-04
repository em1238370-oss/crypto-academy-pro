#!/bin/bash
# Публикация на сайт (12:00 и 00:00 MSK): читает kro-12h-stats.json и POST на KRO_SITE_UPDATE_URL
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
[ -f env ] && set -a && source env && set +a
export MODE=publish
exec python3 run_12h_monitor.py
