# Что ввести в терминале для проверки каналов

Чтобы по ссылке сразу получать результат (риск, вердикт и т.д.), один раз войди в Telegram. Открой **Терминал** и выполняй по порядку.

---

## Самый простой способ (из корня проекта)

Перейди в папку проекта и выполни одну команду:

```bash
cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1"
node scripts/kro-login.js
```

Дальше введи номер телефона (+79...) и **код из приложения Telegram** (5 цифр). Код приходит в Telegram на телефоне или в **Telegram Desktop** (если ты залогинен там, в т.ч. по QR-коду). После сообщения «Готово! Сессия сохранена.» в папке `backend/kro-worker` появится файл `kro_worker.session` — перезапусти бэкенд, проверка по ссылке заработает.

---

## Если node scripts/kro-login.js не сработал — по шагам

### Шаг 1. Перейти в папку воркера и установить зависимости

Скопируй и вставь целиком, нажми Enter:

```bash
cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1/backend/kro-worker" && pip3 install -r requirements.txt
```

Если появится ошибка «pip3: command not found», попробуй:

```bash
cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1/backend/kro-worker" && pip install -r requirements.txt
```

Дождись окончания установки.

---

## Шаг 2. Один раз войти в Telegram (создать сессию)

Скопируй и вставь целиком, нажми Enter:

```bash
cd "/path/to/crypto-academy-pro/backend/kro-worker" && set -a && source .env 2>/dev/null || source env 2>/dev/null; set +a && python3 -c "
from telethon import TelegramClient
import os
client = TelegramClient('kro_worker', int(os.environ['TELEGRAM_API_ID']), os.environ['TELEGRAM_API_HASH'])
import asyncio
asyncio.run(client.start())
print('Готово! Сессия сохранена.')
"
```
(В `.env` или `env` в этой папке должны быть заданы `TELEGRAM_API_ID` и `TELEGRAM_API_HASH`.)

- Телеграм попросит **номер телефона** (в формате +79xxxxxxxxx).
- Потом придёт **код** в приложение Telegram — введи его в терминал.

После этого появится надпись **«Готово! Сессия сохранена.»** — больше вводить ничего не нужно.

---

## Шаг 3. Проверить, что сессия создана

В папке `backend/kro-worker` должен появиться файл **`kro_worker.session`**. Если его нет — вход не завершён, повтори шаг 2 (номер + код из Telegram или Telegram Desktop).

## Шаг 4. Перезапустить бэкенд

Если сервер уже запущен — останови его (Ctrl+C в терминале, где он работает) и запусти снова.  
После этого при вставке ссылки на канал и нажатии «Проверить» должен сразу приходить результат (риск, вердикт, потери).
