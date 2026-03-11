#!/bin/bash
# Обновить блок «События за период» в Google Doc. Запускать из корня проекта:
#   ./run_update_live_log.sh
# или: bash run_update_live_log.sh
cd "$(dirname "$0")/backend/kro-worker" || exit 1
python3 -W ignore::FutureWarning -W ignore::UserWarning update_live_log_5min.py
