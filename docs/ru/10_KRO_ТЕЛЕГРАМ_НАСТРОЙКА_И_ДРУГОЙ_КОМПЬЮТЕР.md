# KRO и Telegram: полная настройка и работа с другого компьютера

Этот документ описывает всё, что сделано с Telegram для проверки каналов крипты, и как перенести работу на другой компьютер или восстановить настройку с нуля.

---

## 1. Что сделано с Telegram (кратко)

- **Проверка каналов по ссылке**  
  Пользователь вводит любую ссылку на канал (например `https://t.me/crypto_channel` или `t.me/+inviteHash`). Сайт проверяет канал: сначала по базе в Google Таблице (**scam_base**), при отсутствии — живая проверка через Telegram API (Telethon).

- **Живая проверка**  
  - Синхронно: бэкенд может вызвать `backend/kro-worker/check_once.py` (таймаут до 60 сек) и сразу вернуть результат.  
  - Через очередь: если синхронно не успело или воркер не настроен, канал попадает в лист **check_queue**; воркер раз в **60 секунд** обрабатывает очередь и дописывает результат в **scam_base**. Пользователю на сайте показывается: *«Проверяем канал по Telegram. Подождите 1–3 минуты и нажмите «Проверить» снова.»*

- **Поиск по каналу**  
  В базе **scam_base** поиск по каналу выполняется по ключу **channelMatchKey** (username или invite), чтобы корректно находить записи по разным форматам ссылок.

- **Telegram-сессии**  
  - Вход по **QR-коду**: скрипт `backend/kro-worker/login_via_qr.py` (см. `ВХОД_ПО_QR.md`).  
  - Сессия из **Telegram Desktop**: скрипт `backend/kro-worker/convert_desktop_session.py` создаёт `kro_worker.session` из данных Desktop (см. `СЕССИЯ_ИЗ_TELEGRAM_DESKTOP.md`).

- **Зависимости**  
  В `backend/kro-worker/requirements.txt` добавлены Telethon, OpenTele и всё необходимое для воркера.

- **Скрипты запуска**  
  - `run_with_env.py` — загружает переменные из файла `env` и запускает переданную команду.  
  - `run_worker_loop.sh` — цикл: раз в 60 секунд запуск воркера (удобно для локального запуска).

---

## 2. Ссылки (репозиторий и сайт)

| Что | Ссылка |
|-----|--------|
| Репозиторий GitHub | https://github.com/em1238370-oss/crypto-academy-pro |
| Сайт (после деплоя на Render) | https://crypto-academy-pro.onrender.com |
| Деплой | При пуше в `main` на GitHub сервис на Render автоматически обновляется. |

Панель Render: зайти в свой аккаунт Render и открыть сервис `crypto-academy-pro` для просмотра логов и переменных окружения.

---

## 3. Работа с другого компьютера (пошагово)

Чтобы зайти с другого компьютера и чтобы сайт и проверка каналов работали, нужно: (1) код из GitHub, (2) секреты и сессию Telegram локально, (3) при необходимости — запуск воркера.

### 3.1. Код проекта

На новом компьютере:

```bash
git clone https://github.com/em1238370-oss/crypto-academy-pro.git
cd crypto-academy-pro
```

Дальнейшие обновления: `git pull origin main`.

**Важно:** В репозиторий **не** должны попадать файлы с секретами и окружением. Они уже добавлены в `.gitignore`:

- `backend/kro-worker/env`
- `backend/kro-worker/venv/`
- `backend/kro-worker/credentials.json`
- `backend/kro-worker/*.session`
- `backend/kro-worker/*.png`

На новом компьютере эти файлы нужно создать/получить заново (см. ниже).

### 3.2. Переменные окружения (секреты)

Секреты хранятся **только локально** (и на Render для бэкенда сайта). В репозитории лежит только шаблон.

**Бэкенд сайта (Render):**  
В панели Render у сервиса `crypto-academy-pro` в разделе **Environment** должны быть заданы переменные из корневого `.env.example` (в т.ч. `KRO_SHEET_ID`, `KRO_GOOGLE_CREDENTIALS_JSON` или доступ к Google, при необходимости `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` если на Render включена синхронная проверка). Подробно: `backend/KRO_SETUP.md`, `RENDER_ENV_VARIABLES.md`.

**Воркер (твой компьютер или VPS):**  
В папке `backend/kro-worker/` создайте файл **`env`** (без расширения), скопировав `backend/kro-worker/.env.example` и заполнив значения. Не коммитить этот файл.

| Переменная | Где взять |
|------------|-----------|
| `TELEGRAM_API_ID` | https://my.telegram.org → API development tools → своё приложение → API ID |
| `TELEGRAM_API_HASH` | Там же → API Hash |
| `KRO_SHEET_ID` | Из URL таблицы: `https://docs.google.com/spreadsheets/d/<KRO_SHEET_ID>/edit` |
| `KRO_CHECK_QUEUE_RANGE` | Обычно `check_queue!A2:B` |
| `KRO_SCAM_BASE_RANGE` | Обычно `scam_base!A2:H` |
| Доступ к Google Sheets | Либо `KRO_GOOGLE_CREDENTIALS_JSON` (JSON сервисного аккаунта в одну строку), либо файл `credentials.json` и переменная `GOOGLE_APPLICATION_CREDENTIALS` с путём к нему |

Подробно: `backend/kro-worker/ENV_КАК_ЗАПОЛНИТЬ.md`.

### 3.3. Сессия Telegram (один раз на каждом компьютере)

Воркер подключается к Telegram от имени твоего аккаунта. Для этого нужен файл сессии (например `kro_worker.session`) в `backend/kro-worker/`.

**Вариант A — вход по QR (без номера телефона):**

```bash
cd backend/kro-worker
# env уже заполнен (TELEGRAM_API_ID, TELEGRAM_API_HASH)
python login_via_qr.py
```

Следуйте инструкциям на экране и сохраните полученный файл сессии. Подробно: `backend/kro-worker/ВХОД_ПО_QR.md`.

**Вариант B — сессия из Telegram Desktop:**

Если на этом же компьютере установлен Telegram Desktop и ты уже вошла, можно сконвертировать его сессию в `kro_worker.session`:

- Инструкция: `backend/kro-worker/СЕССИЯ_ИЗ_TELEGRAM_DESKTOP.md`
- Скрипт: `backend/kro-worker/convert_desktop_session.py`

После этого файл `kro_worker.session` положить в `backend/kro-worker/` и не коммитить.

### 3.4. Запуск воркера на этом компьютере

```bash
cd backend/kro-worker
pip install -r requirements.txt   # один раз
# Загрузить env и запустить воркер один раз:
python run_with_env.py python worker.py
# Или запуск в цикле каждые 60 секунд:
./run_worker_loop.sh
```

Без запущенного воркера живая проверка через очередь тоже будет работать, но только после того, как воркер хотя бы раз обработает очередь (можно запустить на любом компьютере, где есть доступ к той же таблице и есть сессия Telegram).

### 3.5. Обновление сайта (деплой)

- Сделать изменения в коде, закоммитить и выполнить **push в ветку `main`** репозитория `em1238370-oss/crypto-academy-pro`.  
- Render автоматически подхватит изменения и задеплоит сайт.  
- Если используете GitHub Desktop: выбрать репозиторий `crypto-academy-pro`, ветку `main`, нажать **Push origin**.  
- Если push не проходит (авторизация): см. `GITHUB_PUSH_ИНСТРУКЦИЯ.md` (токен или SSH).

---

## 4. Документы в проекте (где что искать)

Всё это уже лежит в репозитории; после `git clone` будет доступно и на другом компьютере.

**KRO и Telegram — настройка:**

| Файл | О чём |
|------|--------|
| `backend/KRO_SETUP.md` | Переменные окружения, листы таблицы, API проверки каналов и обменников |
| `backend/kro-worker/README.md` | Воркер: установка, переменные, запуск, cron |
| `backend/kro-worker/.env.example` | Шаблон файла `env` для воркера |
| `backend/kro-worker/ENV_КАК_ЗАПОЛНИТЬ.md` | Как заполнить переменные воркера |
| `backend/kro-worker/ВХОД_ПО_QR.md` | Вход в Telegram по QR-коду для сессии |
| `backend/kro-worker/СЕССИЯ_ИЗ_TELEGRAM_DESKTOP.md` | Получение сессии из Telegram Desktop |
| `backend/kro-worker/ЕСЛИ_КОД_НЕ_ПРИХОДИТ.md` | Если не приходит код при входе в Telegram |
| `backend/kro-worker/KRO_TELETHON_ВАРИАНТ_B.md` | Полная настройка Telethon (вариант Б) |

**KRO — таблица и данные:**

| Файл | О чём |
|------|--------|
| `KRO_ДАННЫЕ_ДЛЯ_ТАБЛИЦЫ.md` | Какие данные нужны для таблицы |
| `KRO_ЗАЧЕМ_ТАБЛИЦА_СХЕМА.md` | Зачем таблица и общая схема |
| `KRO_ТРЕБОВАНИЯ_К_ТАБЛИЦЕ.md` | Требования к листам и колонкам |
| `KRO_КАК_ИСПРАВИТЬ_ЛИСТ_1.md` | Как исправить Лист 1 |
| `KRO_ЧТО_НУЖНО_НАЙТИ.md` | Что нужно найти для настройки |

**GitHub и деплой:**

| Файл | О чём |
|------|--------|
| `GITHUB_PUSH_ИНСТРУКЦИЯ.md` | Как настроить push (токен, SSH), если не пушится |
| `КАК_ОБНОВИТЬ_САЙТ_И_GITHUB.md` | Обновление сайта и GitHub |
| `RENDER_ENV_VARIABLES.md` | Переменные окружения на Render |

---

## 5. Краткий чеклист «с другого компьютера»

1. Клонировать репозиторий: `git clone https://github.com/em1238370-oss/crypto-academy-pro.git`
2. Создать `backend/kro-worker/env` из `.env.example`, заполнить (API ID/Hash, KRO_SHEET_ID, диапазоны, Google credentials).
3. Получить сессию Telegram: QR (`login_via_qr.py`) или из Desktop (`convert_desktop_session.py`), положить `kro_worker.session` в `backend/kro-worker/`.
4. Установить зависимости: `cd backend/kro-worker && pip install -r requirements.txt`
5. Запустить воркер при необходимости: `python run_with_env.py python worker.py` или `./run_worker_loop.sh`
6. Сайт уже работает на Render; обновления кода — через `git pull` и при необходимости push с этого компьютера (см. `GITHUB_PUSH_ИНСТРУКЦИЯ.md`).

Секреты (`env`, `credentials.json`, `*.session`, `venv/`) не коммитить — они только локально на каждом компьютере.
