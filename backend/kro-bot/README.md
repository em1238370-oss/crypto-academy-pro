# KRO Telegram Bot

Бот для проверки Telegram-каналов по базе антискама. Вызывает API бэкенда `GET /api/kro/check`.

## Установка

```bash
cd backend/kro-bot
pip install -r requirements.txt
```

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `KRO_BOT_TOKEN` или `BOT_TOKEN` | Токен бота от [@BotFather](https://t.me/BotFather). |
| `KRO_API_URL` | URL бэкенда (по умолчанию `http://localhost:4000`). |

## Запуск

```bash
export KRO_BOT_TOKEN="123:ABC..."
export KRO_API_URL="https://your-backend.example.com"
python bot.py
```

Убедитесь, что бэкенд запущен и настроен лист scam_base (`KRO_SCAM_BASE_RANGE`), иначе `/check` всегда будет отвечать «не найден».

## Команды

- **/check @username** — проверка канала (риск, реклама, боты, жалобы, вердикт).
- **/report** — подсказка отправить жалобу через сайт.
- **/start**, **/help** — краткая справка.
