#!/bin/bash
# Одна команда: коммит + push на GitHub
# Использование: ./deploy.sh "описание изменений"
# Или: ./deploy.sh  (автоописание по дате)

cd /Users/macmini/crypto-website

git remote set-url origin https://em1238370-oss@github.com/em1238370-oss/crypto-academy-pro.git

echo "🔄 Коммит и отправка на GitHub..."
git add -A

if [ -z "$(git status --porcelain)" ]; then
    echo "Нет изменений для коммита."
    UNPUSHED=$(git log origin/main..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')
    if [ "$UNPUSHED" -gt 0 ]; then
        echo "Отправка $UNPUSHED неотправленных коммитов..."
        git push origin main
    else
        echo "Всё уже отправлено."
    fi
    exit 0
fi

echo ""
echo "📋 Файлы:"
git status --short
echo ""

if [ -z "$1" ]; then
    COMMIT_MSG="Обновление: $(date '+%Y-%m-%d %H:%M')"
else
    COMMIT_MSG="$1"
fi

git commit -m "$COMMIT_MSG"
echo ""
echo "📤 Push на GitHub (Password = токен)..."
git push origin main

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Готово. Сайт обновится на Render через 1–3 минуты."
else
  echo ""
  echo "❌ Ошибка. В Password вставь GitHub токен (не пароль)."
fi
