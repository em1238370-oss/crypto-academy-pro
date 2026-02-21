# KRO live-check worker

Воркер раз в 1–2 минуты читает очередь проверки каналов (лист **check_queue** в Google Sheets), запускает **check_once.py** (Telethon) для проверки канала и дописывает результат в **scam_base**. Так пользователь может ввести любую ссылку (в т.ч. `t.me/+invite`) и через 1–2 минуты получить оценку.

**Полная настройка (вариант Б — Telethon на твоей машине/VPS):** см. [KRO_TELETHON_ВАРИАНТ_B.md](KRO_TELETHON_ВАРИАНТ_B.md).

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `KRO_SHEET_ID` | ID Google-таблицы (как в бэкенде). |
| `KRO_CHECK_QUEUE_RANGE` | Диапазон очереди, например `check_queue!A2:B`. |
| `KRO_SCAM_BASE_RANGE` | Диапазон базы, например `scam_base!A2:H`. |
| `KRO_GOOGLE_CREDENTIALS_JSON` или `GOOGLE_APPLICATION_CREDENTIALS` | Доступ к Google Sheets (как в KRO_SETUP.md). |
| `TELEGRAM_API_ID` | API ID приложения (my.telegram.org). |
| `TELEGRAM_API_HASH` | API Hash приложения. |
| `TELEGRAM_SESSION_NAME` | Имя файла сессии Telethon (по умолчанию `kro_worker`). |

## Установка и первый запуск

```bash
cd backend/kro-worker
pip install -r requirements.txt
```

При **первом** запуске Telethon запросит вход в аккаунт Telegram (номер телефона, код). Сессия сохранится в файл `kro_worker.session` — дальше запуск уже без ввода.

```bash
export KRO_SHEET_ID="..."
export KRO_CHECK_QUEUE_RANGE="check_queue!A2:B"
export KRO_SCAM_BASE_RANGE="scam_base!A2:H"
export TELEGRAM_API_ID="..."
export TELEGRAM_API_HASH="..."
# и при необходимости GOOGLE_APPLICATION_CREDENTIALS или KRO_GOOGLE_CREDENTIALS_JSON

python worker.py
```

## Запуск по расписанию (каждые 2 минуты)

**cron:**

```cron
*/2 * * * * cd /path/to/project/backend/kro-worker && /path/to/python worker.py >> /tmp/kro-worker.log 2>&1
```

Или скрипт-цикл (рекомендуется):

```bash
./run_worker_loop.sh
```

Интервал по умолчанию 90 с; можно задать: `KRO_WORKER_INTERVAL=120 ./run_worker_loop.sh`.

## Формат данных

- **Очередь** (check_queue): колонки A = channel (@username или t.me/+hash), B = added_at.
- **scam_base**: одна строка добавляется с полями username, risk_score, ads_per_week, bot_pct, vip_price, complaints, total_loss, verdict. Для живой проверки complaints и total_loss заполняются «—»; risk и verdict считаются по ключевым словам в сообщениях канала.
