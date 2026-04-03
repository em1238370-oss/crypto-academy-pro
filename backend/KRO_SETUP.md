# KRO: антискам-счётчик и проверка каналов

Настройка бэкенда и Google Sheets для Фишки 1 (живой счётчик, форма жалоб, API проверки канала).

---

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `KRO_SHEET_ID` | ID Google-таблицы (из URL: `https://docs.google.com/spreadsheets/d/<KRO_SHEET_ID>/edit`). Обязателен для live-counter и report-scam. |
| `KRO_GOOGLE_CREDENTIALS_JSON` | JSON сервисного аккаунта Google (строка). Альтернатива: использовать файл и указать путь в `GOOGLE_APPLICATION_CREDENTIALS`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Путь к файлу `credentials.json` сервисного аккаунта. Используется, если `KRO_GOOGLE_CREDENTIALS_JSON` не задан. |
| `KRO_SCAM_BASE_RANGE` | Диапазон листа «база каналов» для API проверки. Например: `scam_base!A2:H` или `Sheet2!A2:H`. Если не задан, `GET /api/kro/check` всегда возвращает `found: false`. В этот лист теперь попадают только подтверждённые каналы. |
| `KRO_CHECK_QUEUE_RANGE` | Диапазон листа «очередь проверки» для живой проверки. Например: `check_queue!A2:B`. Если задан, при отсутствии канала в базе он добавляется в очередь; воркер (Python + Telethon) раз в 1–2 мин проверяет канал и дописывает результат в scam_base. |
| `KRO_REPORTS_RANGE` | Диапазон листа с жалобами и суммами потерь, по умолчанию `A2:F`. Используется для подсчёта жалоб по каналу. |
| `KRO_UNCONFIRMED_RANGE` | Необязательный лист для неподтверждённых результатов. Например: `unconfirmed_results!A2:K`. Сюда можно складывать каналы, которые проверены, но не прошли 3 критерия. |
| `KRO_EXCHANGER_BASE_RANGE` | Диапазон листа «база обменников» для проверки по ссылке. Например: `exchanger_base!A2:E`. Колонки: A — URL/домен, B — название, C — risk_score, D — total_loss, E — verdict. Если не задан, `GET /api/kro/check-exchanger` возвращает «не найден». |
| `KRO_SOURCES_DOC_ID` | ID Google Doc для единого документа «Источники и данные». При каждом запуске `run_12h_monitor.py` документ обновляется: все источники, ссылки и ссылка на последний автоотчёт. Из URL: `.../document/d/<KRO_SOURCES_DOC_ID>/edit`. |

### Где взять ключ Google и как узнать `client_email`

1. [Google Cloud Console](https://console.cloud.google.com/) → ваш проект → **IAM и администрирование** → **Сервисные аккаунты** → нужная учётная запись → **Ключи** → **Добавить ключ** → JSON. Сохраните файл локально, например как `backend/kro-worker/credentials.json` (не коммитьте в git).

2. В JSON есть поле **`client_email`** (вида `name@project-id.iam.gserviceaccount.com`). Этот адрес нужно **добавить в доступ** к таблице: в Google Sheets **Настройки доступа** → вставить email → роль **Редактор**.

3. Секрет GitHub **`KRO_GOOGLE_CREDENTIALS_BASE64`** никто извне (включая ассистента) прочитать не может. Чтобы увидеть `client_email` **у себя**, после экспорта секрета в переменную выполните:

```bash
echo "$KRO_GOOGLE_CREDENTIALS_BASE64" | base64 -d | python3 -c "import sys,json; print(json.load(sys.stdin).get('client_email',''))"
```

(На macOS при необходимости используйте `base64 -D`.)

---

## Живая проверка каналов (без базы)

Пользователь может ввести **любую** ссылку (например `https://t.me/+7qOXr33dDTZjNDAy` или `@channel`). Канал не обязан быть заранее в базе.

### Синхронная проверка (один запрос — сразу результат)

При отсутствии канала в **scam_base** бэкенд может сразу выполнить живую проверку в том же запросе, вызвав скрипт `kro-worker/check_once.py` (Python 3 + Telethon). Для этого на сервере должны быть:

- Python 3 и зависимости из `kro-worker/requirements.txt`
- Переменные окружения: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`
- При первом запуске — выполнен вход в Telethon (сессия сохраняется в `kro-worker`)

Таймаут вызова — 60 секунд. Результат (риск, причины, вердикт) возвращается клиенту без ожидания и повторного нажатия «Проверить». Опционально при заданных `KRO_SHEET_ID` и `KRO_SCAM_BASE_RANGE` скрипт дописывает строку в scam_base.

### Очередь и воркер (запасной вариант)

Если включена очередь (`KRO_CHECK_QUEUE_RANGE`) и синхронный вызов не сработал (таймаут, канал недоступен, Python/Telethon не настроены):

1. Канал добавляется в лист **check_queue**, пользователю показывается: *«Проверяем канал по Telegram. Подождите 1–2 минуты и нажмите «Проверить» снова.»*
2. Воркер (см. `kro-worker/worker.py`) периодически читает очередь, подключается к Telegram и анализирует канал.
3. В **scam_base** дописывается только подтверждённый канал: возраст до 14 дней, есть VIP от 10000₽ или сигналы long/short, и есть минимум 2 жалобы реальных людей.
4. Если канал проверен, но не прошёл эти 3 критерия, API честно отвечает, что подтверждения недостаточно. Опционально такая запись может попасть в `KRO_UNCONFIRMED_RANGE`.
5. При повторном нажатии «Проверить» подтверждённый канал уже будет в базе.

Ссылки вида `t.me/username` и `t.me/+inviteHash` парсятся автоматически (не показывается «@https://t.me/...»).

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

## Лист 2: scam_base (база подтверждённых каналов — v2 схема)

Используется эндпоинтом `GET /api/kro/check?channel=@username` и заполняется автоматически из `run_12h_monitor.py` и `check_once.py`.

Переменная `KRO_SCAM_BASE_RANGE` должна указывать на этот лист. Пример: `scam_base!A2:M`.

**Колонки A:M (первая строка — заголовки, данные со второй строки):**

| A: username | B: link | C: detected_at | D: created_at | E: channel_age_days | F: object_type | G: vip_price | H: complaints | I: total_loss_rub | J: source_primary | K: source_evidence | L: cycle_window | M: status |
|-------------|---------|----------------|---------------|----------------------|----------------|--------------|---------------|-------------------|-------------------|--------------------|-----------------|-----------|
| @TONPumpKing | https://t.me/TONPumpKing | 2026-03-13T12:01:00Z | 2026-03-02T00:00:00Z | 11 | сигнал-канал | 12000₽ | 4 | 2100000 | https://tgstat.ru/... | https://t.me/... | 2026-03-13_pm | в риске |
| @SignalTrapRu | https://t.me/SignalTrapRu | 2026-03-13T12:01:00Z | 2026-03-05T00:00:00Z | 8 | сигнал-канал | 15000₽ | 3 | 847000 | https://tgstat.ru/... | | 2026-03-13_pm | в риске |

**Описание полей:**
- `username` — @username канала
- `link` — полный URL t.me/username
- `detected_at` — ISO 8601 UTC, когда зафиксирован в цикле
- `created_at` — ISO 8601 UTC, дата создания канала
- `channel_age_days` — возраст в днях (< 14 для скам)
- `object_type` — `сигнал-канал` / `курс/сайт` / `сигнал-канал (закрытый)`
- `vip_price` — цена VIP если есть
- `complaints` — число жалоб ≥ 2
- `total_loss_rub` — сумма потерь в ₽ (целое число)
- `source_primary` — основная ссылка-источник (TGStat)
- `source_evidence` — дополнительные доказательства через "; "
- `cycle_window` — `YYYY-MM-DD_am` или `YYYY-MM-DD_pm`
- `status` — `в риске` / `под наблюдением` / `без риска`

> ⚠️ Старые строки v1 (8 колонок) в базе игнорируются в live-counter, но по-прежнему используются в `/api/kro/check` для совместимости.

**Формула риска (опционально, в колонке I):**

```
=(C2*0.4)+(D2*0.3)+(F2*0.2)+(IF(E2>5000;0.1;0))
```

- `risk_score` можно считать вручную или по формуле в Sheets.
- Этот лист больше не должен хранить `unknown` как автоматическую заглушку. Если подтверждения недостаточно, запись сюда не добавляется.
- Для API проверки задайте диапазон, например: **`scam_base!A2:H`** (если лист называется «scam_base») или **`Sheet2!A2:H`** (второй лист по умолчанию).

---

## Лист 3: check_queue (очередь живой проверки)

Используется, когда включена живая проверка (`KRO_CHECK_QUEUE_RANGE`). Воркер читает этот лист и дописывает результаты в scam_base.

**Колонки A:B (заголовки в первой строке, данные с A2):**

| A: channel | B: added_at |
|------------|-------------|
| @CryptoChannel | 2026-02-18T12:00:00.000Z |
| t.me/+7qOXr33dDTZjNDAy | 2026-02-18T12:01:00.000Z |

- **channel** — идентификатор канала (@username или t.me/+invite).
- **added_at** — время добавления в очередь (ISO).

Задайте диапазон, например: **`check_queue!A2:B`**.

---

## Лист 3b: unconfirmed_results (необязательно)

Если хотите видеть всё, что было проверено, но не прошло строгую верификацию, создайте отдельный лист и задайте переменную **`KRO_UNCONFIRMED_RANGE`**, например `unconfirmed_results!A2:K`.

Автосоздание листа и заголовков:

```bash
cd backend/kro-worker
KRO_UNCONFIRMED_RANGE="unconfirmed_results!A2:K" python3 ensure_unconfirmed_sheet.py
```

Рекомендуемые колонки:

| A: username | B: confirmation_status | C: channel_age_days | D: vip_price | E: complaints | F: has_signal_offer | G: age_ok | H: offer_ok | I: complaints_ok | J: missing_criteria | K: checked_at |
|-------------|-------------------------|---------------------|--------------|---------------|---------------------|-----------|-------------|------------------|---------------------|---------------|

---

## Лист 4: exchanger_base (база обменников)

Используется эндпоинтом `GET /api/kro/check-exchanger?url=...`. Нужен только если включена проверка обменников по ссылке (`KRO_EXCHANGER_BASE_RANGE`).

**Колонки A:E (первая строка — заголовки, данные со второй):**

| A: URL/домен      | B: название    | C: risk_score | D: total_loss | E: verdict |
|-------------------|----------------|---------------|---------------|------------|
| bestchange.ru     | BestChange     | 15            | 0₽            | safe       |
| scam-exchanger.io | ScamExchanger  | 92            | 1.2млн₽       | scam       |

- **A** — URL или домен (для сопоставления с запросом пользователя).
- **B** — человекочитаемое название.
- **C** — оценка риска 0–100.
- **D** — сумма потерь по жалобам (строка, например «1.2млн₽»).
- **E** — вердикт (scam / grey / safe и т.п.).

Задайте диапазон в переменной **`KRO_EXCHANGER_BASE_RANGE`**, например: **`exchanger_base!A2:E`**.

---

## API

- **GET /api/kro/live-counter** — агрегаты для Фишки 1 (количество каналов за день, потери, Топ-3). Читает лист отчётов A2:F.
- **POST /api/kro/report-scam** — принять жалобу (channel, sumRub, from). Добавляет строку в лист отчётов.
- **GET /api/kro/check?channel=@username** (или `channel=https://t.me/...`, `channel=t.me/+invite`) — проверка канала по базе scam_base; при отсутствии в базе — синхронный вызов `check_once.py` (живая проверка через Telethon). Ссылки t.me парсятся автоматически. Ответ для подтверждённого канала: `{ found, username, risk_score, ads_per_week, bot_pct, vip_price, complaints, total_loss, verdict }`. Если канал проверен, но не прошёл 3 критерия, API возвращает честный ответ `{ found: false, pending: false, message, confirmation_status, missing_criteria }`. Поля «жалобы» и «потери» при пустых значениях в базе подставляются из листа отчётов (A2:F) по совпадению канала. При недоступности живой проверки и заданном `KRO_CHECK_QUEUE_RANGE`: `{ found: false, pending: true, channel, message }` — канал ставится в очередь, пользователю нужно нажать «Проверить» снова через 1–2 минуты.
- **GET /api/kro/check-exchanger?url=...** — проверка обменника по ссылке (база задаётся через `KRO_EXCHANGER_BASE_RANGE`). Ответ: `{ found, url?, name?, risk_score?, total_loss?, verdict? }` или `{ found: false, message }`.
- **POST /api/kro/check-screenshot** — тело JSON `{ image: "data:image/...;base64,..." }`. Распознавание скрина через Mistral Vision: извлечение @ников, t.me и URL обменников. Ответ: `{ extracted: ["@channel", "https://..."] }`. На сайте по первому извлечённому выполняется проверка канала или обменника.
- **GET /api/kro/daily-stats** — статистика за 12 ч (из `backend/data/kro-12h-stats.json`): `new_scams`, `losses_12h`, `victims_12h`, `top3`, `report_doc_url`. Файл обновляется скриптом `run_12h_monitor.py`.

---

## Автомониторинг каждые 12 ч (run_12h_monitor)

Скрипт `kro-worker/run_12h_monitor.py` собирает данные из TGStat, Telega.io и Telegram-чатов за последние 12 ч, применяет критерии скама, пишет отчёт в Google Docs и обновляет `backend/data/kro-12h-stats.json`. Сайт показывает блок «За 12 часов» и ссылку на отчёт через `GET /api/kro/daily-stats`.

**Автозапуск (по плану, двухфазный цикл MSK):**
- **11:00 и 23:00 MSK** — сбор: `run_12h_collect.sh` (TGStat, Telega, Telegram → Doc «Источники и данные» + pending).
- **12:15 и 00:15 MSK** — публикация: `run_12h_publish.sh` (pending → `kro-12h-stats.json` для сайта).

**Как включить:** скопировать 4 строки из `backend/kro-worker/CRONTAB_12h.txt` в crontab: `crontab -e` → вставить строки (без строк, начинающихся с `#`). Либо одной командой из корня проекта: `(crontab -l 2>/dev/null; grep -v '^#' backend/kro-worker/CRONTAB_12h.txt | grep -v '^$') | crontab -`. Логи: `backend/kro-worker/log_collect.txt` и `log_publish.txt`.

Нужны: `TGSTAT_API_KEY`, `KRO_SOURCE_CHANNELS`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `KRO_SHEET_ID`, `KRO_SOURCES_DOC_ID`, учётные данные Google; в Cloud — Google Docs API.

**Единый Google Doc «Источники и данные»:** если задан **`KRO_SOURCES_DOC_ID`** (ID из URL: `https://docs.google.com/document/d/<ID>/edit`), скрипт при каждом запуске обновляет этот документ: вставляет текст со всеми источниками и ссылками (Vklader, TGRev, TGStat, Telega.io, Telegram, таблица) и ссылку на последний автоотчёт. Вся информация приходит в один документ.

Как создать документ: (1) В Google Drive создайте новый Google Doc (можно пустой). (2) Скопируйте ID из URL: в адресе после `/d/` и до `/edit`. (3) Дайте доступ на редактирование сервисному аккаунту (email из `client_email` в JSON ключа). (4) В `.env` добавьте `KRO_SOURCES_DOC_ID=ваш_id`. При следующем запуске скрипта документ будет заполнен и далее обновляться при каждом запуске.
