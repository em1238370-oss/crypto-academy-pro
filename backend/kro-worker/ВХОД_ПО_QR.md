# Вход по QR-коду — без кода в приложении

Вместо кода из Telegram можно войти по **QR-коду**: открываешь Telegram на телефоне, сканируешь QR — сессия создаётся без ввода кода.

---

## Что нужно

- Файл **env** с **TELEGRAM_API_ID** и **TELEGRAM_API_HASH** (твои с my.telegram.org, не 2040).
- Telegram на телефоне с уже залогиненным аккаунтом.

---

## Шаги

### 1. Установи библиотеку для QR (один раз)

```bash
cd /Users/elizavetamedvedeva/Documents/GitHub/crypto-academy-pro/backend/kro-worker
source venv/bin/activate
pip install "qrcode[pil]"
```

### 2. Запусти вход по QR

```bash
set -a && source env && set +a
python3 login_via_qr.py
```

### 3. Что будет

- Откроется **окно с QR-кодом** (или в терминале появится ссылка, если окно не открылось).
- На **телефоне** открой Telegram → **Настройки** → **Устройства** → **Подключить устройство** (или **Link Desktop Device**).
- **Отсканируй QR** камерой через интерфейс Telegram.
- В терминале появится «Вход выполнен» — сессия сохранена в `kro_worker.session`.

### 4. Если включён пароль 2FA

Скрипт спросит пароль облачной пароль — введи его в терминале.

### 5. Дальше

```bash
python3 run_with_env.py @durov
./run_worker_loop.sh
```

Код вводить больше не нужно — используется созданная сессия.

---

## Важно

- В **env** для этого способа оставь **свой** TELEGRAM_API_ID и TELEGRAM_API_HASH (12768690 и твой hash), не подменяй на 2040.
- QR действует примерно 30 секунд. Если не успела — запусти `python3 login_via_qr.py` ещё раз и отсканируй новый QR.
