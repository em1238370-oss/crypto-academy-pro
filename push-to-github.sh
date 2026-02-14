#!/bin/bash
# Отправка в GitHub
# Запуск: ./push-to-github.sh
# Или с сообщением: ./push-to-github.sh "описание изменений"

cd "$(dirname "$0")"
MSG="${1:-Update}"

echo "📂 $(pwd)"
echo "📋 git status"
git status
echo ""
echo "➕ git add -A"
git add -A
echo "💾 git commit -m \"$MSG\""
git commit -m "$MSG" || echo "(Нет изменений)"
echo "🚀 git push origin main"
git push origin main
echo "✅ Готово!"
