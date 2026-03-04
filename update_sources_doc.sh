#!/bin/bash
# Обновить Google Doc «Источники и данные» до структуры 7 блоков.
# Запуск из любой папки: из корня проекта — ./update_sources_doc.sh
# или: bash /полный/путь/crypto-academy-pro/update_sources_doc.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/backend/kro-worker" || { echo "Ошибка: не найден backend/kro-worker"; exit 1; }
python3 update_sources_doc_once.py
exit $?
