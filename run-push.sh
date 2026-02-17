#!/bin/bash
# Запусти этот скрипт в Терминале (не в Cursor): ./run-push.sh
# Или: bash run-push.sh

cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1"

echo "→ git pull --rebase origin main"
git pull --rebase origin main || { echo "Ошибка при pull. Проверь интернет и конфликтующие файлы."; exit 1; }

echo ""
echo "→ git push origin main"
git push origin main || { echo "Ошибка при push."; exit 1; }

echo ""
echo "Готово. Сайт обновится через 1–2 мин: https://crypto-academy-pro.onrender.com"
