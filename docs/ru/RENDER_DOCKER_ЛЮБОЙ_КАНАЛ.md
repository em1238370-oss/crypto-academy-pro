# Проверка любого канала на Render (Docker + Telethon)

Чтобы по ссылке **любой** канал (например `t.me/topslivs`) сразу получать результат **без воркера на своём ПК**, сервис на Render должен уметь запускать живую проверку (Python + Telethon). Для этого деплой делают через **Docker**.

---

## 1. Переключить сервис на Docker

- Render → твой сервис → **Settings**.
- **Environment**: выбери **Docker** (вместо Native).
- Сохрани. Render будет собирать образ из **Dockerfile** в корне репозитория.

После деплоя в контейнере будут и Node (API), и Python 3 с Telethon.

---

## 2. Переменные окружения (как и раньше)

В **Environment** должны быть:

- `KRO_SHEET_ID` — ID таблицы (например `1C1NQwqmLRg59xgplnz5PeghRxaR_YY2lfSWZAJae6qM`).
- `KRO_GOOGLE_CREDENTIALS_JSON` — JSON сервисного аккаунта одной строкой.
- `KRO_SCAM_BASE_RANGE` — `scam_base!A2:H`.
- `KRO_CHECK_QUEUE_RANGE` — по желанию, например `check_queue!A2:B`.

Для **живой проверки любого канала** добавь:

- `TELEGRAM_API_ID` — число (получить на my.telegram.org).
- `TELEGRAM_API_HASH` — строка.

---

## 3. Сессия Telegram (Secret File)

Скрипт `check_once.py` входит в Telegram под твоим аккаунтом. Один раз нужно создать файл сессии и положить его в контейнер.

**На своём компьютере:**

1. В папке `backend/kro-worker` выполни вход (номер + код из Telegram):
   ```bash
   cd backend/kro-worker
   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... python3 check_once.py @durov
   ```
2. После успешного входа появится файл `kro_worker.session`.

**На Render:**

- **Dashboard** → сервис → **Environment** → **Secret Files**.
- **Add Secret File**:
  - **Filename:** в контейнере файл должен лежать по пути `backend/kro-worker/kro_worker.session`. На Render укажи этот путь так, как просит интерфейс (иногда нужен полный путь, например `/app/backend/kro-worker/kro_worker.session`).
  - **Contents:** содержимое файла `kro_worker.session` (скопируй или загрузи файл).

После деплоя живая проверка любого канала будет работать.

---

## 4. Итог

- **Без Docker** (только Node): каналы из таблицы проверяются; для остальных — очередь, нужен воркер у себя или «Проверить» снова через 1–2 минуты после воркера.
- **С Docker + TELEGRAM_* + сессия**: можно ввести **любую** ссылку (`@channel`, `t.me/канал`, `t.me/+invite`) и сразу получить оценку риска по сообщениям.

Ошибки из прошлого (KRO_SHEET_ID с опечаткой, неверный лист) описаны в [ЧЕКЛИСТ_ИСПРАВИТЬ_ОШИБКУ_ПРОВЕРКИ_КАНАЛА.md](./ЧЕКЛИСТ_ИСПРАВИТЬ_ОШИБКУ_ПРОВЕРКИ_КАНАЛА.md).
