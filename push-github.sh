#!/bin/bash
# Запусти в Терминале на Mac — тогда спросит только пароль (вставь токен GitHub)
cd /Users/macmini/crypto-website

# Чтобы не спрашивало "Username" (и не подставляло ссылку) — в адресе уже твой логин
git remote set-url origin https://em1238370-oss@github.com/em1238370-oss/crypto-academy-pro.git

echo "Отправка на GitHub..."
echo "Когда попросит Password — вставь свой GitHub токен (не пароль от аккаунта)."
echo ""
git push origin main

if [ $? -eq 0 ]; then
  echo ""
  echo "Готово. Сайт обновится на Render через 1–3 минуты."
else
  echo ""
  echo "Ошибка. В поле Password нужен токен: GitHub → Settings → Developer settings → Personal access tokens."
fi
