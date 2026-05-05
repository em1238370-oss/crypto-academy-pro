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
- 2026-05-04 — Проверка канала на главной: серверный бюджет `POST /api/kro/analyze-channel` по умолчанию выровнен с окном до 7 минут (`KRO_ANALYZE_FAST_MAX_MS`); убран ранний ответ только по публичному снимку t.me/s, чтобы успевал Telethon; публичный снимок получает до 2 мин бюджета; ссылки `telegram.me/...` на главной нормализуются как t.me.
- 2026-05-05 — `analyze-channel`: резерв ~72% окна под Telethon (до ~5 мин), до двух проходов чтения ленты с полным оставшимся таймаутом; если Telethon не набрал 5 постов, но открытая страница дала ≥5 фрагментов — успешный ответ `read_path: public_snapshot` (ленту по тексту разобрали). Иначе по-прежнему fallback на жалобы/внешние источники.
- 2026-05-05 — Очередь `kro_check_requests` на Render: `POST /api/kro/process-live-queue` (секрет `KRO_LIVE_QUEUE_CRON_SECRET` в заголовке `X-KRO-LIVE-QUEUE-SECRET`) обрабатывает одну pending-строку без Telethon/t.me — только Google Sheets (scam_base, channels_watch, reports) и Claude; `GET /api/kro/internal/claude-ping` — мини-тест API. В `render.yaml` — памятка по Render Cron и curl.
- 2026-05-04 — `GET /api/kro/live-counter`: в JSON добавлены `sheets_available`, `live_counter_degraded`, `live_counter_note_ru` при недоступности Google Sheets; на главной показывается текст в `#kro-f1-system-note`, при сбое fetch — сообщение в том же блоке. В `kro-live-check.yml` комментарий: GitHub может не соблюдать cron каждые 2 мин для публичных репозиториев.
- 2026-05-04 — Render: исправлен `SyntaxError: Illegal return statement` в `server.js` (тело `kroHomeCriteriaStatusWordRu` оказалось вне `function` после правок чеклиста).
- 2026-05-04 — Деплой Render: Dockerfile на `node:22-bookworm` (как Native Node 22 в логах), `npm ci` только production и явный `pip` upgrade; при старте `Stripe` оборачивается в try/catch — неверный `STRIPE_SECRET_KEY` не должен завершать процесс с кодом 1.
- 2026-05-04 — `analyze-channel`: восстановлена `kroBuildParsedFromPublicSnapshotOnly` (раньше функция потерялась из-за обрыва кода — fallback на чтение открытой ленты `t.me/s` не вызывался); сбор публичных сниппетов запускается при нехватке текста от Telethon, если до дедлайна осталось >400 мс.
- 2026-05-04 — `analyze-channel` + `check_once.py`: режим `home_greedy` (батчи постов по monotonic-бюджету, ранний выход при стабильной тематике, фаза комментариев); `main()` вызывает `run_check_home_greedy` при `KRO_CHECK_ONCE_MODE=home_greedy`; на сервере сначала Telethon с резервом ~75% окна, затем при нехватке текста — `t.me/s` максимум 60 с; порог «живой ленты» снижен до 3 постов; `posts_fetched` в greedy = число текстовых единиц для отчёта.
- 2026-05-04 — Доработка greedy: ранний выход не обрывает сбор, если в бюджете ещё >~22 с и лента не прочитана глубоко; комментарии — до 120 постов; Node сливает `sample_posts` из `_sample_texts` при вызове с `KRO_HOME_GREEDY_KEEP_SAMPLE_TEXTS`, slack spawn timeout ~12% от бюджета Telethon.
- 2026-05-04 — Главная проверка канала: клиент ждёт POST до 10 мин (`__KRO_HOME_FETCH_MS`), чтобы не рвать ответ при жадном Telethon; на сервере — два прохода greedy при обрыве/малом тексте, больший spawn-slack, до 3 попыток `t.me/s` с дедупликацией; минимум текста для «живого» отчёта снижен до 1 фрагмента; при наличии ≥3 фрагментов с публичной страницы снимается флаг `not_crypto` для разбора текста.
- 2026-05-04 — Главная: блок доверия «Risk score / почему / цитаты / уверенность», «Как тебя могут пытаться обмануть», «Как мы анализируем»; API `trust_report`; во время ожидания — строка текущего этапа и пульс цепочки этапов.
- 2026-05-04 — `trust_report`: полный чек-лист из пяти факторов по тексту (да/частично/нет) + «голос редактора»; для режима без ленты — честные строки по жалобам и контексту.

---

## 📌 Важные заметки
- 

