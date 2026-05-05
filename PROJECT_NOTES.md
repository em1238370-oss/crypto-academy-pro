# 📝 Заметки по проекту Check your crypto

## 🗓️ История изменений

### [Дата] - [Что сделано]
- 

---

## 💡 Идеи для улучшения
- 

---

## 🐛 Известные проблемы
- 

---

## ✅ Сделано
- 2026-05-05 — Главная `POST /api/kro/analyze-channel`: только Google Sheets (`scam_base`, `channels_watch`, `reports`) + GET `https://vklader.com/{slug}` и `https://forteck.net/{slug}` + Claude за ~30 с (`KRO_HOME_QUICK_MS`, по умолчанию 30000). Без Telethon, без t.me, без записи в `kro_check_requests`. Ответ сразу; `read_path`: `sheets_sites_claude`.
- 2026-05-04 — `GET /api/kro/live-counter`: в JSON добавлены `sheets_available`, `live_counter_degraded`, `live_counter_note_ru` при недоступности Google Sheets; на главной показывается текст в `#kro-f1-system-note`, при сбое fetch — сообщение в том же блоке. В `kro-live-check.yml` комментарий: GitHub может не соблюдать cron каждые 2 мин для публичных репозиториев.
- 2026-05-04 — Render: исправлен `SyntaxError: Illegal return statement` в `server.js` (тело `kroHomeCriteriaStatusWordRu` оказалось вне `function` после правок чеклиста).
- 2026-05-04 — Деплой Render: Dockerfile на `node:22-bookworm` (как Native Node 22 в логах), `npm ci` только production и явный `pip` upgrade; при старте `Stripe` оборачивается в try/catch — неверный `STRIPE_SECRET_KEY` не должен завершать процесс с кодом 1.
- 2026-05-04 — Главная: блок доверия «Risk score / почему / цитаты / уверенность», «Как тебя могут пытаться обмануть», «Как мы анализируем»; API `trust_report`; во время ожидания — строка текущего этапа и пульс цепочки этапов.
- 2026-05-04 — `trust_report`: полный чек-лист из пяти факторов по тексту (да/частично/нет) + «голос редактора»; для режима без ленты — честные строки по жалобам и контексту.

---

## 📌 Важные заметки
- 

