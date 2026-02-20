# Фишка 1 (KRO): что нужно найти и настроить — по пунктам

Чеклист по плану MVP. Всё по пунктам: что искать, где взять, куда подставить.

---

## 1. Google Таблица (Sheets)

**Что нужно:** одна Google-таблица с тремя листами (или больше).

**Где взять:** [Google Sheets](https://sheets.google.com) → создать новую таблицу.

**Что сделать:**
- **Лист 1** (первый лист): отчёты и жалобы.  
  Колонки A–F: дата | канал | сумма ₽ | тип | статус | от кого.  
  Первая строка — заголовки, данные с A2.  
  Подробно: [backend/KRO_SETUP.md](backend/KRO_SETUP.md) раздел «Лист 1: отчёты».

- **Лист 2:** база каналов **scam_base**.  
  Колонки A–H: username | risk_score | ads_per_week | bot_pct | vip_price | complaints | total_loss | verdict.  
  В колонке I можно добавить формулу риска (см. KRO_SETUP.md).  
  Подробно: KRO_SETUP.md раздел «Лист 2: scam_base».

- **Лист 3 (опционально):** очередь проверки **check_queue**.  
  Колонки A–B: channel | added_at.  
  Нужен только если включена живая проверка через воркер.  
  Подробно: KRO_SETUP.md раздел «Лист 3: check_queue».

- **Лист обменников (опционально):** для проверки обменников по ссылке.  
  Колонки A–E: URL/домен | название | risk_score | total_loss | verdict.  
  Подробно: KRO_SETUP.md, переменная `KRO_EXCHANGER_BASE_RANGE`.

**Что скопировать:** из URL таблицы нужен **ID таблицы**:
- URL вида: `https://docs.google.com/spreadsheets/d/XXXXXXXXXX/edit`
- ID = `XXXXXXXXXX` (часть между `/d/` и `/edit`).
- Этот ID понадобится для переменной `KRO_SHEET_ID`.

---

## 2. Сервисный аккаунт Google (доступ к Sheets из бэкенда)

**Что нужно:** JSON-ключ сервисного аккаунта Google с доступом к Google Sheets API.

**Где взять:**
1. [Google Cloud Console](https://console.cloud.google.com) → выбери проект (или создай).
2. «APIs & Services» → «Library» → найди «Google Sheets API» → включи.
3. «APIs & Services» → «Credentials» → «Create Credentials» → «Service account».
4. Создай сервисный аккаунт, скачай JSON-ключ (кнопка «Keys» → Add Key → JSON).
5. В Google-таблице: «Поделиться» → добавь email сервисного аккаунта (из JSON, поле `client_email`) с правом «Редактор».

**Что скопировать:**
- Либо **весь содержимое JSON-файла** одной строкой — для переменной `KRO_GOOGLE_CREDENTIALS_JSON`.
- Либо положи файл на сервер и укажи путь в переменной `GOOGLE_APPLICATION_CREDENTIALS`.

---

## 3. Переменные окружения (Render или локально)

**Что нужно:** задать переменные в Render (Environment) или в `.env` локально.

**Список по пунктам:**

| № | Переменная | Что подставить | Обязательно |
|---|------------|----------------|--------------|
| 1 | `KRO_SHEET_ID` | ID таблицы из п. 1 | да |
| 2 | `KRO_GOOGLE_CREDENTIALS_JSON` | Строка JSON сервисного аккаунта из п. 2 | да (или п. 3а) |
| 3а | `GOOGLE_APPLICATION_CREDENTIALS` | Путь к файлу `credentials.json` | если не используешь п. 2 |
| 4 | `KRO_SCAM_BASE_RANGE` | Диапазон листа scam_base, например `scam_base!A2:H` или `Sheet2!A2:H` | да |
| 5 | `KRO_CHECK_QUEUE_RANGE` | Если есть очередь: `check_queue!A2:B` | нет |
| 6 | `KRO_EXCHANGER_BASE_RANGE` | Если проверяешь обменники: `exchanger_base!A2:E` | нет |

**Для живой проверки канала (Telethon) на сервере:**

| № | Переменная | Где взять |
|---|------------|-----------|
| 7 | `TELEGRAM_API_ID` | [my.telegram.org](https://my.telegram.org) → API development tools → создай приложение → api_id |
| 8 | `TELEGRAM_API_HASH` | Там же → api_hash |

На Render вызов Python (check_once) может не работать — тогда используй очередь + воркер на своей машине.

---

## 4. Telegram-бот (команды /check и /report)

**Что нужно:** токен бота и URL бэкенда.

**Где взять токен:** [@BotFather](https://t.me/BotFather) в Telegram → /newbot → следуй шагам → получишь токен вида `123456:ABC-DEF...`.

**Что задать в переменных (на сервере, где крутится бот, или в Render если бот там):**

| № | Переменная | Что подставить |
|---|------------|----------------|
| 1 | `KRO_BOT_TOKEN` или `BOT_TOKEN` | Токен от BotFather |
| 2 | `KRO_API_URL` | URL бэкенда, например `https://crypto-academy-pro.onrender.com` (без слэша в конце) |

Бот вызывает `GET /api/kro/check` и `POST /api/kro/report-scam` на этот URL. Бэкенд должен быть доступен по этому адресу.

---

## 5. Заполнение базы (50 каналов для MVP)

**Что нужно:** чтобы в листе **scam_base** было примерно 50 строк с каналами (username, risk_score, ads_per_week, bot_pct, vip_price, complaints, total_loss, verdict).

**Где взять данные:**
- Внести вручную из известных тебе каналов.
- Либо проверять каналы через сайт (поле «Проверить канал»): если включена живая проверка (Telethon), после проверки результат можно вручную перенести в таблицу; либо настроить воркер, который дописывает в scam_base.

**Шаблон строки:** см. [backend/KRO_SETUP.md](backend/KRO_SETUP.md) — таблица с примерами @TONPumpKing, @CryptoElite, @RealTraderPro.

---

## 6. Итоговая проверка

После того как всё найдено и подставлено:

1. **Сайт:** открыть главную → блок «Проверить канал» → ввести @username из scam_base → нажать «Проверить». Должен вернуться риск, причины, потери, вердикт.
2. **Форма жалоб:** «Сообщить о разводе» → заполнить канал, сумму → отправить. В листе отчётов (лист 1) должна появиться новая строка.
3. **Живой счётчик:** на главной блок «LIVE», «Топ-3 сегодня» — цифры подтягиваются из листа отчётов. Если лист пустой или только что создан — могут быть нули или fallback.
4. **Бот:** в Telegram написать боту `/check @username` (подставь канал из scam_base). Бот должен ответить анализом с риском и вердиктом.

---

## Кратко: что куда

- **KRO_SHEET_ID** — из URL Google-таблицы.
- **KRO_GOOGLE_CREDENTIALS_JSON** — JSON сервисного аккаунта (или файл и **GOOGLE_APPLICATION_CREDENTIALS**).
- **KRO_SCAM_BASE_RANGE** — имя и диапазон листа scam_base, например `scam_base!A2:H`.
- **KRO_BOT_TOKEN** / **KRO_API_URL** — для бота: токен BotFather и URL твоего бэкенда.
- **TELEGRAM_API_ID** / **TELEGRAM_API_HASH** — только если нужна живая проверка через Telethon на сервере.

Если что-то из списка не используешь (например, обменники или очередь), соответствующие переменные можно не задавать.
