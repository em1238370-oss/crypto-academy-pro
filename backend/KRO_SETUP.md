# KRO: антискам-счётчик и проверка каналов

Настройка бэкенда и Google Sheets для Фишки 1 (живой счётчик, форма жалоб, API проверки канала).

---

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `KRO_SHEET_ID` | ID Google-таблицы (из URL: `https://docs.google.com/spreadsheets/d/<KRO_SHEET_ID>/edit`). Обязателен для live-counter и report-scam. |
| `KRO_GOOGLE_CREDENTIALS_JSON` | JSON сервисного аккаунта Google (строка). Альтернатива: использовать файл и указать путь в `GOOGLE_APPLICATION_CREDENTIALS`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Путь к файлу `credentials.json` сервисного аккаунта. Используется, если `KRO_GOOGLE_CREDENTIALS_JSON` не задан. |
| `KRO_SCAM_BASE_RANGE` | Диапазон листа «база каналов» для API проверки. Например: `scam_base!A2:H` или `Sheet2!A2:H`. Если не задан, `GET /api/kro/check` всегда возвращает `found: false`. |

---

## Лист 1: отчёты (live-counter и форма жалоб)

Используется эндпоинтами `/api/kro/live-counter` и `/api/kro/report-scam`.

**Колонки A:F (первая строка — заголовки, данные с A2):**

| A: дата | B: канал | C: сумма ₽ | D: тип | E: статус | F: от кого |
|---------|----------|------------|--------|-----------|------------|
| 17.02.2026 | @channel | 50000 | TG | Активен | аноним |

- **Дата** — в формате ДД.ММ.ГГГГ или ДД.ММ (для «сегодня»).
- **Сумма** — число (только цифры).
- Форма «Сообщить о разводе» добавляет новую строку в этот лист.

---

## Лист 2: scam_base (база для проверки каналов)

Используется эндпоинтом `GET /api/kro/check?channel=@username`.

Создайте второй лист в той же таблице (или отдельную таблицу и укажите её ID в `KRO_SHEET_ID` для check — тогда нужна отдельная переменная; в текущей реализации используется тот же `KRO_SHEET_ID`, а диапазон задаётся через `KRO_SCAM_BASE_RANGE`).

**Колонки A:H (первая строка — заголовки, данные со второй):**

| A: username | B: risk_score | C: ads_per_week | D: bot_pct | E: vip_price | F: complaints | G: total_loss | H: verdict |
|-------------|---------------|-----------------|------------|--------------|---------------|---------------|------------|
| @TONPumpKing | 87 | 14 | 78% | 7000₽ | 23 | 2.1млн₽ | scam |
| @CryptoElite | 45 | 7 | 32% | 4900₽ | 4 | 847к₽ | grey |
| @RealTraderPro | 12 | 1 | 8% | нет | 0 | 0₽ | safe |

**Формула риска (опционально, в колонке I):**

```
=(C2*0.4)+(D2*0.3)+(F2*0.2)+(IF(E2>5000;0.1;0))
```

- `risk_score` можно считать вручную или по формуле в Sheets.
- Для API проверки задайте диапазон, например: **`scam_base!A2:H`** (если лист называется «scam_base») или **`Sheet2!A2:H`** (второй лист по умолчанию).

---

## API

- **GET /api/kro/live-counter** — агрегаты для Фишки 1 (количество каналов за день, потери, Топ-3). Читает лист отчётов A2:F.
- **POST /api/kro/report-scam** — принять жалобу (channel, sumRub, from). Добавляет строку в лист отчётов.
- **GET /api/kro/check?channel=@username** — проверка канала по базе scam_base. Ответ: `{ found, username?, risk_score?, ads_per_week?, bot_pct?, vip_price?, complaints?, total_loss?, verdict? }` или `{ found: false, channel }`.
