#!/bin/bash
# Полная настройка и вход в Telegram для проверки каналов.
# Запуск: из корня проекта выполни:  bash backend/kro-worker/kro-telegram-login.sh

set -e
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
echo "Папка проекта: $ROOT"
echo "Папка воркера: $(pwd)"
echo ""

echo "Шаг 1/2: Устанавливаю зависимости Python..."
if command -v python3 &>/dev/null; then
  python3 -m pip install -r requirements.txt
else
  echo "Ошибка: python3 не найден. Установи Python 3 и запусти снова."
  exit 1
fi
echo ""

echo "Шаг 2/2: Вход в Telegram."
echo "Сейчас попросят номер телефона (+79...) и код из приложения Telegram (5 цифр)."
echo ""
python3 login_telegram.py

echo ""
echo "Если выше написано «Готово! Сессия сохранена» — перезапусти бэкенд и проверяй канал по ссылке."
