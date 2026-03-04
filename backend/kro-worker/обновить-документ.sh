#!/bin/bash
# Обновить документ Source & Data. Запускать из любой папки:
#   ~/Documents/GitHub/crypto-academy-pro/backend/kro-worker/обновить-документ.sh
# или из корня проекта:  backend/kro-worker/обновить-документ.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
python3 update_sources_doc_once.py
