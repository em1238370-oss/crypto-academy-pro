# Как отправить на GitHub и чтобы всё отображалось на сайте

Сайт: **https://crypto-academy-pro.onrender.com**  
Render подтягивает код из GitHub. Чтобы цифры на сайте обновились, нужно: обновить данные, закоммитить и отправить репозиторий на GitHub.

---

## Шаг 1 — обновить данные (скрипт)

Открой терминал и выполни **по очереди**:

```
cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1"
```

```
cd backend/kro-worker && python3 fetch_live_stats.py
```

Должно появиться: `Written: .../kro-reference-stats.json (channelsToday=..., telegramCount=...)`

---

## Шаг 2 — отправить на GitHub

В том же терминале (вернись в корень проекта, если нужно: `cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1"`):

```
git add .
```

```
git status
```

(Проверь, что в списке есть изменённые файлы, в т.ч. `backend/data/kro-reference-stats.json`.)

```
git commit -m "KRO: обновление данных из интернета и парсер"
```

```
git push origin main
```

(Если основная ветка у тебя не `main`, а `master`, замени на: `git push origin master`.)

---

## Шаг 3 — подождать деплой на Render

После `git push` Render сам запустит сборку и деплой (обычно 2–5 минут). Потом открой:

**https://crypto-academy-pro.onrender.com/index.html#checkers**

Блок «0 новых скам-каналов за день», «Потеряно ₽», «Telegram каналов» и т.д. должен подтянуть цифры из `kro-reference-stats.json`.

---

## Если на сайте всё ещё нули

- Убедись, что на Render в настройках сервиса **не заданы** `KRO_SHEET_ID` (или таблица пуста) — тогда бэкенд отдаёт данные из JSON.
- В Dashboard Render проверь, что последний деплой завершился без ошибок.
- Страница запрашивает `GET /api/kro/live-counter` — если бэкенд на другом домене, проверь CORS и правильный URL API в коде фронта.

---

## Кратко: одна вставка (всё подряд)

Скопируй и вставь в терминал **по одной строке** (каждая строка — Enter):

```
cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1"
```
```
cd backend/kro-worker && python3 fetch_live_stats.py
```
```
cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1"
```
```
git add .
```
```
git commit -m "KRO: обновление данных из интернета"
```
```
git push origin main
```

После успешного `git push` подожди 2–5 минут и обнови страницу на Render.
