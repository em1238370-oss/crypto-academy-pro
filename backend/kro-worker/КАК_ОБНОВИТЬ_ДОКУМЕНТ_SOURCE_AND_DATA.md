# Как обновить документ SOURCE & DATA

Документ **SOURCE & DATA** в Google Docs обновляется **только при запуске** скрипта `run_12h_monitor.py`. Пока скрипт не запущен — в документе остаются старые данные и старая структура.

## Расписание циклов (11:00 и 23:00 MSK)

- **Циклы:** 11:00 и 23:00 MSK (два раза в сутки).
- **К 11:55 / 23:55 MSK** — документ SOURCE & DATA готов на проверку (живой лог, SOURCE & DATA 1–3, расчёт, чеклист).
- **12:00–12:15 / 00:00–00:15** — твоя проверка (чеклист в документе).
- **12:15 / 00:15** — отправка JSON на сайт: POST на `https://crypto-academy-pro.onrender.com/api/kro/update` (или `/api/update`). Можно отправить вручную или настроить скрипт: задать `KRO_SITE_UPDATE_URL` — тогда скрипт сам сделает POST после записи JSON.

**Cron (11:00 и 23:00 MSK = 08:00 и 20:00 UTC при MSK=UTC+3):**

```bash
0 8,20 * * * cd /path/to/backend/kro-worker && python3 run_12h_monitor.py
```

## API для сайта

- **POST /api/kro/update** (или **POST /api/update**)  
  Принимает JSON: `timestamp`, `new_scam_channels`, `losses_12h`, `telegram_channels`, `courses_products`, `top3_today` (массив строк). Сохраняет данные в `backend/data/kro-12h-stats.json`. Опционально: в env задать `KRO_UPDATE_SECRET` — тогда запрос должен содержать заголовок `Authorization: Bearer <секрет>` или query-параметр `secret=...`.

- **GET /api/kro/live-counter**  
  Возвращает данные для главной страницы (приоритет: чтение из `kro-12h-stats.json`, иначе из Google Sheets). Поддерживает поля `new_scam_channels`, `courses_products`, `top3_today`.

## Что нужно для обновления

1. **Актуальный код**  
   Убедись, что у тебя подтянута последняя версия из GitHub (структура: заголовок, живой лог, SOURCE & DATA 1–3, расчёт для сайта, чеклист проверки).

2. **Переменные окружения** (в `.env` в корне проекта или в `backend/kro-worker/`):
   - `KRO_SOURCES_DOC_ID` — ID документа Google Docs (из ссылки: `https://docs.google.com/document/d/**ЭТОТ_ID**/edit`).
   - `KRO_GOOGLE_CREDENTIALS_JSON` — JSON ключа сервисного аккаунта Google (или `GOOGLE_APPLICATION_CREDENTIALS` и путь к файлу ключа).
   - Для сбора жалоб из Telegram: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `KRO_SOURCE_CHANNELS` (чаты через запятую).
   - Для TGStat (по желанию): настройки `tgstat_client`.
   - Опционально: `KRO_SITE_UPDATE_URL` (URL для POST после записи JSON, например `https://crypto-academy-pro.onrender.com/api/kro/update`), `KRO_SITE_UPDATE_SECRET` (если на сервере задан `KRO_UPDATE_SECRET`).

3. **Доступ к документу**  
   В Google Docs открой документ → Поделиться → добавь **email сервисного аккаунта** (из JSON ключа, поле `client_email`) с правом «Редактор».

## Запуск вручную (чтобы документ обновился сейчас)

Из папки проекта:

```bash
cd ~/Documents/GitHub/crypto-academy-pro/backend/kro-worker
python3 run_12h_monitor.py
```

Скрипт:
- соберёт данные из TGStat, Telega и чатов (если настроены);
- перезапишет документ по `KRO_SOURCES_DOC_ID` новым текстом: период, живой лог, SOURCE & DATA (TGStat, Telega, чаты), расчёт для сайта, чеклист проверки;
- обновит `backend/data/kro-12h-stats.json` (в т.ч. поля `new_scam_channels`, `courses_products`, `top3_today`);
- при заданном `KRO_SITE_UPDATE_URL` отправит POST на сайт.

Если скрипт запускается по крону (11:00 и 23:00 MSK), на той машине должна быть **новая версия** `run_12h_monitor.py` (деплой или git pull).
