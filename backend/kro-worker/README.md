# KRO live-check worker

Воркер раз в 1–2 минуты читает очередь проверки каналов (лист **check_queue** в Google Sheets), запускает **check_once.py** (Telethon) для проверки канала и дописывает в **scam_base** только подтверждённые каналы. Так пользователь может ввести любую ссылку (в т.ч. `t.me/+invite`) и через 1–2 минуты получить честный ответ: канал подтверждён или подтверждений пока недостаточно.

**Полная настройка (вариант Б — Telethon на твоей машине/VPS):** см. [KRO_TELETHON_ВАРИАНТ_B.md](KRO_TELETHON_ВАРИАНТ_B.md).

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `KRO_SHEET_ID` | ID Google-таблицы (как в бэкенде). |
| `KRO_CHECK_QUEUE_RANGE` | Диапазон очереди, например `check_queue!A2:B`. |
| `KRO_SCAM_BASE_RANGE` | Диапазон базы, например `scam_base!A2:H`. |
| `KRO_REPORTS_RANGE` | Диапазон листа с жалобами, по умолчанию `A2:F`. |
| `KRO_UNCONFIRMED_RANGE` | Опциональный лист для неподтверждённых результатов, например `unconfirmed_results!A2:K`. |
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
export KRO_REPORTS_RANGE="A2:F"
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
- **scam_base**: одна строка добавляется только для подтверждённого канала. Критерии: возраст до 14 дней, есть VIP от 10000₽ или long/short сигналы, и минимум 2 жалобы.
- **unconfirmed_results**: опциональный лист для каналов, которые были проверены, но не прошли 3 критерия. Это убирает мусор `unknown` из основной базы.

## Документ «Источники и данные» (7 блоков)

Полный цикл мониторинга (TGStat, Telega, жалобы) и обновление Google Doc выполняет **run_12h_monitor.py** (по крону в 11:00 и 23:00 MSK). Текст документа формируется в формате 7 блоков (см. `docs/ru/СТРУКТУРА_ОТЧЁТА_ЦИКЛ_7_БЛОКОВ.md`).

**Чтобы один раз подставить в документ новую структуру** (без полного сбора данных), запустите с включённым интернетом:

```bash
cd backend/kro-worker
python3 update_sources_doc_once.py
```

Нужны переменные: `KRO_SOURCES_DOC_ID`, `KRO_GOOGLE_CREDENTIALS_JSON` (или путь в `GOOGLE_APPLICATION_CREDENTIALS`). После выполнения откройте документ по ссылке из вывода и обновите страницу (F5).
