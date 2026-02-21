# Telethon на твоей машине или VPS (вариант Б)

Живая проверка каналов через Telegram выполняется **не на Render**, а у тебя: на компьютере или VPS. Сайт на Render только добавляет канал в очередь; воркер на твоей стороне раз в 1–2 минуты забирает задачу, проверяет канал через Telethon и дописывает результат в таблицу. Пользователь нажимает «Проверить» ещё раз и видит результат.

---

## 1. Что нужно подготовить

### 1.1 Telegram API (обязательно)

1. Зайди на [my.telegram.org](https://my.telegram.org), войди по номеру телефона.
2. Открой **API development tools**.
3. Создай приложение (любое название, short name можно любое).
4. Скопируй **API ID** (число) и **API Hash** (строка). Они понадобятся для переменных `TELEGRAM_API_ID` и `TELEGRAM_API_HASH`.

### 1.2 Google таблица

- Та же таблица, что и для бэкенда (тот же `KRO_SHEET_ID`).
- Лист **check_queue**: колонки A = `channel`, B = `added_at` (заголовок в первой строке). Данные можно не заполнять — воркер и сайт сами пишут туда каналы.
- Лист **scam_base**: в него воркер дописывает результаты (как уже настроено в KRO_SETUP.md).
- Доступ к таблице: через **KRO_GOOGLE_CREDENTIALS_JSON** (строка JSON ключа сервисного аккаунта) или **GOOGLE_APPLICATION_CREDENTIALS** (путь к файлу JSON). Сервисный аккаунт должен иметь доступ на редактирование таблицы.

### 1.3 Render: включить очередь

В настройках сервиса на Render добавь переменную окружения:

- **KRO_CHECK_QUEUE_RANGE** = `check_queue!A2:B`  
  (если лист очереди называется иначе — укажи его имя, например `Лист 3!A2:B`)

Без этой переменной сайт не будет добавлять каналы в очередь, и воркеру будет нечего обрабатывать.

---

## 2. Установка на твоей машине или VPS

### 2.1 Клонируй репозиторий (если ещё не клонирован)

```bash
cd /path/to/your/work
git clone <твой репозиторий> crypto-academy-pro
cd crypto-academy-pro/backend/kro-worker
```

### 2.2 Python и зависимости

Нужен Python 3.8+.

```bash
cd backend/kro-worker
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 2.3 Переменные окружения

Создай файл `.env` в `backend/kro-worker/` (или экспортируй переменные в shell). **Не коммить .env в git.**

Пример `.env`:

```bash
# Telegram (my.telegram.org)
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890

# Таблица (те же значения, что на Render)
KRO_SHEET_ID=1C1NQwqmLRg59xgplnz5PeghRxaR_YY2lfSWZAJae6qM
KRO_CHECK_QUEUE_RANGE=check_queue!A2:B
KRO_SCAM_BASE_RANGE=scam_base!A2:H

# Google: либо JSON в одной строке, либо путь к файлу
KRO_GOOGLE_CREDENTIALS_JSON={"type":"service_account",...}
# или
# GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json

# Имя сессии Telethon (по умолчанию kro_worker → файл kro_worker.session)
# TELEGRAM_SESSION_NAME=kro_worker
```

Подгрузить переменные перед запуском (файл может называться `.env` или `env`):

```bash
set -a && source .env && set +a
# если файл назван просто env (без точки):
# set -a && source env && set +a
```

Или экспортируй переменные вручную.

---

## 3. Первый вход Telethon (создание сессии)

При **первом** запуске Telethon попросит войти в Telegram: номер телефона и код из приложения. Сессия сохранится в файл `kro_worker.session` в папке `backend/kro-worker/`. Дальше запуски уже без ввода.

Удобнее всего один раз запустить проверку одного канала вручную:

```bash
cd backend/kro-worker
source venv/bin/activate
# подгрузи .env (source .env или export ...)
python3 check_once.py @durov
```

Введи номер телефона и код. В конце должна появиться строка JSON с `"found": true` (или `false` для несуществующего канала). После этого файл `kro_worker.session` создан, его можно использовать для воркера.

---

## 4. Запуск воркера

Воркер раз в цикле читает очередь, вызывает `check_once.py` для первого канала в списке, дописывает результат в scam_base и удаляет задачу из очереди.

### Вариант A: скрипт-цикл (рекомендуется)

В терминале (или в tmux/screen на VPS):

```bash
cd backend/kro-worker
source venv/bin/activate
source .env   # или экспорт переменных
chmod +x run_worker_loop.sh
./run_worker_loop.sh
```

Скрипт запускает `worker.py` каждые 90 секунд. Логи идут в stdout/stderr. Для фонового запуска на VPS используй `tmux` или `screen`.

### Вариант B: cron (каждые 2 минуты)

```bash
crontab -e
```

Добавь строку (подставь свой путь и python):

```cron
*/2 * * * * cd /path/to/crypto-academy-pro/backend/kro-worker && /path/to/venv/bin/python worker.py >> /tmp/kro-worker.log 2>&1
```

Пример с venv в проекте:

```cron
*/2 * * * * cd /home/user/crypto-academy-pro/backend/kro-worker && ./venv/bin/python worker.py >> /tmp/kro-worker.log 2>&1
```

### Вариант C: вручную по одному запуску

```bash
cd backend/kro-worker
source venv/bin/activate
# .env загружен
python3 worker.py
```

Запускать раз в 1–2 минуты вручную или своим скриптом.

---

## 5. Как это работает для пользователя

1. Пользователь на сайте вводит @username или ссылку и нажимает «Проверить».
2. Бэкенд на Render ищет канал в **scam_base**. Если находит — сразу отдаёт результат.
3. Если не находит и на Render **нет** Telethon (как в варианте Б), бэкенд при наличии **KRO_CHECK_QUEUE_RANGE** добавляет канал в лист **check_queue** и пишет: «Проверяем канал по Telegram. Подождите 1–2 минуты и нажмите «Проверить» снова».
4. Твой воркер раз в 1–2 минуты забирает первую строку из check_queue, запускает `check_once.py` с этим каналом. check_once заходит в Telegram, считает риск, реклам/неделя, % ботов, цену VIP, вердикт и **сам дописывает** строку в scam_base.
5. Пользователь через 1–2 минуты снова нажимает «Проверить» — канал уже в scam_base, сайт отдаёт результат.

---

## 6. Проверка

- Добавь в таблицу вручную в **check_queue** одну строку: A = `@durov`, B = любая дата/время.
- Запусти воркер один раз: `python3 worker.py`.
- В консоли должно появиться что-то вроде `Processed: @durov -> safe` (или grey/scam).
- В листе check_queue эта строка исчезнет, в **scam_base** появится новая строка с результатом.
- На сайте введи тот же канал и нажми «Проверить» — должен отобразиться только что записанный результат.

---

## 7. Частые проблемы

| Проблема | Что проверить |
|----------|----------------|
| «Telethon not configured» / «channel required» | В той же среде, где запускаешь worker, заданы TELEGRAM_API_ID и TELEGRAM_API_HASH. |
| При первом запуске check_once просит телефон | Это нормально; один раз введи номер и код, создастся kro_worker.session. |
| «Google Sheets credentials not found» | KRO_GOOGLE_CREDENTIALS_JSON (или GOOGLE_APPLICATION_CREDENTIALS) и KRO_SHEET_ID заданы; сервисный аккаунт имеет доступ к таблице. |
| На сайте «канал добавлен в очередь», но результат не появляется | На машине, где крутится воркер, запускается worker.py (или run_worker_loop.sh), та же таблица (KRO_SHEET_ID) и тот же лист очереди (KRO_CHECK_QUEUE_RANGE). Проверь, что в check_queue действительно появляется строка при проверке с сайта. |
| Ошибка «Session file not found» / не логинится | Один раз выполни `python3 check_once.py @durov` в той же папке и войди в аккаунт — создастся kro_worker.session. |

---

## 8. Безопасность

- Файл **kro_worker.session** даёт доступ к твоему Telegram-аккаунту. Храни его только на своей машине/VPS, не выкладывай в репозиторий. В `.gitignore` уже должен быть `*.session`.
- **TELEGRAM_API_HASH** и **KRO_GOOGLE_CREDENTIALS_JSON** не должны попадать в публичный репозиторий; храни их в `.env` или в секретах окружения на VPS.
