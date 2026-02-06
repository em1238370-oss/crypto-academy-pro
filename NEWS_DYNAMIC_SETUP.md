# Dynamic News — Regulation / Macro / Market + News heat

## Что сделано

1. **Три блока** (Regulation, Macro, Market structure) — обновляются на основе реальных крипто-новостей
2. **News heat** (Calm / Balanced / Hot) — отражает «температуру» новостей по объёму статей
3. **Обновление** — кэш 10 мин, запрос к API каждые 30 мин (в рамках бесплатных лимитов)

## API ключи (уже добавлены в .env)

- **NewsAPI.org** — `NEWS_API_KEY`
- **TheNewsAPI.net** — `THENEWSAPI_KEY`

## Для Render

Добавь в **Environment Variables** (значения уже в локальном `.env`):

- `NEWS_API_KEY` — ключ NewsAPI.org
- `THENEWSAPI_KEY` — ключ TheNewsAPI.net

## Лимиты (бесплатные планы)

- **NewsAPI**: ~100 запросов/день
- **TheNewsAPI**: 100 кредитов/день, 10 статей за запрос

Обновление раз в 30 мин = 48 запросов/день — укладывается в лимиты.

## Безопасность

⚠️ Ключи были указаны в чате. Рекомендуется сменить их в личных кабинетах API после деплоя.
