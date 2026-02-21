# Проверка: всё из env_для_crypto_academy.txt перенесено в .env

Файл проекта: **`crypto-academy-pro1/.env`** (в корне проекта)

Дата проверки: 21.02.2026

---

## ✅ Что есть в .env (всё перенесено)

| Раздел из документа | Переменные | Статус |
|--------------------|------------|--------|
| **Mistral AI** | `MISTRAL_API_KEY` | ✅ есть (плейсхолдер) |
| **CryptoCloud** | `CRYPTOCLOUD_API_KEY`, `CRYPTOCLOUD_SHOP_ID` | ✅ есть (плейсхолдеры) |
| **CloudPayments** | `CLOUDPAYMENTS_PUBLIC_ID`, `CLOUDPAYMENTS_API_SECRET` | ✅ есть (плейсхолдеры) |
| **NOWPayments** | `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` | ✅ есть (ключи заполнены) |
| **Подписка** | `SUBSCRIPTION_PRICE_USD=10`, `SUBSCRIPTION_PERIOD_DAYS=30`, `FREE_TRIAL_HOURS=24` | ✅ есть |
| **Сервер** | `PORT=4000`, `APP_BASE_URL=http://localhost:4000` | ✅ есть |
| **KRO Google** | `KRO_SHEET_ID`, `KRO_SCAM_BASE_RANGE`, `KRO_CHECK_QUEUE_RANGE` | ✅ есть |
| **KRO Google credentials** | `KRO_GOOGLE_CREDENTIALS_JSON` (весь JSON одной строкой) | ✅ есть |
| **Telegram** | `TELEGRAM_API_ID=12768690`, `TELEGRAM_API_HASH=7c85f4ac3da945983d72d69fbf4485c5` | ✅ есть |
| **CoinGecko** | `COINGECKO_API_KEY=CG-x4dsnMhdLf4rNZykXP6dPvp8` | ✅ есть |
| **CoinDesk** | `COINDESK_API_KEY=945cf14f737adbb447cc74fc9ee7aa3f39e38d5aaef02b9bbdc9c29575d5eca3` | ✅ есть |

---

**Итог:** в `.env` проекта находится всё нужное из документа env_для_crypto_academy.txt. Программа читает переменные из этого файла.
