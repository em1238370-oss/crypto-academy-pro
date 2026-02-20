# Сессия из Telegram Desktop — без кода в приложении

Если код для входа в Telethon не приходит (Telegram с 2023 года не шлёт коды по SMS для сторонних приложений), можно взять **уже авторизованную сессию** из **Telegram Desktop**. Код вводить не нужно.

---

## Что нужно

1. **Telegram Desktop** установлен на этом же компьютере.
2. Ты в нём **уже залогинена** (тот аккаунт, с которого не приходит код — зайди в него через Telegram Desktop на Mac, код приходит в приложение на телефоне или в другой сессии).
3. Файл **env** в папке `backend/kro-worker` с заполненными TELEGRAM_API_ID и TELEGRAM_API_HASH.

---

## Шаги

### 1. Установи opentele

```bash
cd /Users/elizavetamedvedeva/Documents/GitHub/crypto-academy-pro/backend/kro-worker
source venv/bin/activate
pip install opentele
```

### 2. Закрой Telegram Desktop

Перед конвертацией **полностью закрой** приложение Telegram Desktop (Cmd+Q), иначе папка tdata может быть заблокирована.

### 3. Запусти конвертацию

```bash
set -a && source env && set +a
python3 convert_desktop_session.py
```

Скрипт ищет папку **tdata** по пути:
`~/Library/Application Support/Telegram Desktop/tdata`

Если в конце будет сообщение «Готово. Сессия сохранена: ... kro_worker.session» — сессия создана.

### 4. Важно: API для этой сессии

Сессия из Telegram Desktop создаётся с **официальным API Telegram Desktop**. В файле **env** для работы воркера с этой сессией нужны такие значения:

```
TELEGRAM_API_ID=2040
TELEGRAM_API_HASH=b18441a1ff607e10a989891a5462e627
```

(Оставь свои KRO_SHEET_ID, KRO_GOOGLE_CREDENTIALS_JSON и т.д.; поменяй только эти две строки для Telegram.)

Сохрани env и запускай дальше.

### 5. Дальше как обычно

```bash
python3 run_with_env.py @durov
```
(код вводить не нужно — сессия уже есть)

```bash
./run_worker_loop.sh
```

---

## Если папка tdata в другом месте

Задай переменную перед запуском:

```bash
export TDATA_PATH=/полный/путь/к/папке/tdata
python3 convert_desktop_session.py
```

---

## Важно

- Конвертация просто **копирует** сессию из Telegram Desktop в формат Telethon. Аккаунт не дублируется, вход не сбрасывается.
- Файл **kro_worker.session** храни в безопасности (не выкладывай в интернет) — он даёт доступ к аккаунту.
