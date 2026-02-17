# Как обновить сайт и проверить GitHub

## 1. Проверить, что на GitHub есть последний коммит

1. Открой в браузере: **https://github.com/em1238370-oss/crypto-academy-pro**
2. Убедись, что открыта ветка **main** (выпадающий список с ветками сверху).
3. На главной странице репозитория посмотри блок **Commits** (или перейди по вкладке **Commits**).
4. Самый верхний коммит должен быть: **«Разрешить конфликт: оставить Шаг 1 Крипта без розовых очков»** (автор и дата — когда ты пушил).

Если этого коммита нет — значит в GitHub попала не эта папка. Тогда пуш нужно сделать из этой папки в терминале (см. раздел 3).

---

## 2. Обновить сайт на Render (кнопка «обновить»)

Render не всегда сразу подхватывает push. Деплой можно запустить вручную:

1. Зайди на **https://dashboard.render.com**
2. Войди в свой аккаунт.
3. Открой сервис **crypto-academy-pro** (или как он у тебя назван).
4. Вверху страницы сервиса найди кнопку **«Manual Deploy»** (или **«Deploy»**).
5. Нажми **«Deploy latest commit»** (или **«Clear build cache & deploy»**, если нужна чистая сборка).

После этого Render заново соберёт и задеплоит проект. Статус деплоя виден на той же странице (логи и «Live» при успехе). Сайт: **https://crypto-academy-pro.onrender.com**

Если кнопки **Manual Deploy** нет — посмотри в меню сервиса (три точки или вкладки): часто деплой лежит в **«Deploys»** или **«Settings»**.

---

## 3. Если на GitHub нет обновлений — отправить код из этой папки

Открой **Терминал** (не в Cursor, а системный Terminal на Mac) и выполни по шагам:

```bash
cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1"
git status
git log --oneline -2
```

Если в `git log` видишь коммит **«Разрешить конфликт: оставить Шаг 1 Крипта без розовых очков»**, отправь его на GitHub:

```bash
git push origin main
```

Если Git напишет, что ветка «behind» (отстаёт), сначала подтяни изменения (без rebase):

```bash
git pull origin main
```

Если появятся конфликты — напиши, разберём. Если pull прошёл без конфликтов, затем снова:

```bash
git push origin main
```

После успешного `git push` обнови страницу репозитория на GitHub — новый коммит должен появиться. Дальше либо подожди авто-деплой Render (1–2 минуты), либо сделай **Manual Deploy** по шагам из раздела 2.

---

## 4. Шпаргалка: команды для терминала (копируй и вставляй)

Переход в папку проекта:
```bash
cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1"
```

Проверить статус и последние коммиты:
```bash
git status
git log --oneline -3
```

Добавить все изменённые файлы и закоммитить (подставь своё сообщение):
```bash
git add .
git commit -m "Описание изменений"
```

Или добавить только конкретные файлы:
```bash
git add index.html styles.css
git commit -m "Дизайн главной по документу анализа"
```

Подтянуть изменения с GitHub (без rebase):
```bash
git pull origin main
```

Отправить свои коммиты на GitHub:
```bash
git push origin main
```

Полная последовательность: сохранить изменения, отправить на GitHub:
```bash
cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1"
git add .
git status
git commit -m "Твоё сообщение коммита"
git pull origin main
git push origin main
```

Запустить сайт локально через бэкенд (порт 4000):
```bash
cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1"
cd backend && npm start
```
(Сайт откроется по адресу http://localhost:4000 — в браузере введи его вручную.)

---

## Ссылки

- **Репозиторий:** https://github.com/em1238370-oss/crypto-academy-pro  
- **Сайт:** https://crypto-academy-pro.onrender.com  
- **Панель Render:** https://dashboard.render.com  
