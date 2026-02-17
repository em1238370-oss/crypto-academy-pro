#!/bin/bash
# Команда для отправки изменений на GitHub
# Используйте эту команду в терминале или через GitHub Desktop

cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1"

echo "📤 Отправка изменений на GitHub..."
echo ""
echo "Текущий статус:"
git status --short
echo ""
echo "Последний коммит:"
git log --oneline -1
echo ""
echo "Отправка на GitHub..."
git push origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Успешно отправлено на GitHub!"
    echo "🌐 Сайт обновится на Render в течение 1-2 минут"
    echo "   URL: https://crypto-academy-pro.onrender.com/"
else
    echo ""
    echo "❌ Ошибка при отправке"
    echo "💡 Попробуйте:"
    echo "   1. Использовать GitHub Desktop"
    echo "   2. Или настроить GitHub credentials"
    echo "   3. Или выполнить: git push origin main"
fi

