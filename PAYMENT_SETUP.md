# Настройка оплаты для чат-бота

## Текущая ситуация

В коде уже реализована интеграция с **NOWPayments** для оплаты картами и криптовалютой. NOWPayments поддерживает:
- ✅ Карты Visa/Mastercard (международные, включая российские)
- ✅ Криптовалюты (USDT, Bitcoin и др.)
- ✅ Работает для пользователей из России

## Что нужно настроить

### 1. Получить API ключи от NOWPayments

1. Зарегистрируйтесь на https://nowpayments.io
2. Перейдите в Dashboard → API Settings
3. Скопируйте:
   - **API Key** (для создания платежей)
   - **IPN Secret Key** (для верификации webhook'ов)

### 2. Настроить переменные окружения на Render

В панели Render:
1. Откройте ваш сервис (backend)
2. Перейдите в **Environment** (Переменные окружения)
3. Добавьте следующие переменные:

```
NOWPAYMENTS_API_KEY=ваш_api_ключ_здесь
NOWPAYMENTS_IPN_SECRET=ваш_ipn_secret_здесь
APP_BASE_URL=https://crypto-academy-pro.onrender.com
SUBSCRIPTION_PRICE_USD=10
SUBSCRIPTION_PERIOD_DAYS=30
```

### 3. Настроить Webhook в NOWPayments

1. В Dashboard NOWPayments перейдите в **Settings → IPN (Instant Payment Notifications)**
2. Укажите IPN URL:
   ```
   https://crypto-academy-pro.onrender.com/api/payments/nowpayments/callback
   ```
3. Включите IPN для статусов:
   - `finished` (платеж завершен)
   - `confirmed` (платеж подтвержден)
4. **ВАЖНО:** Убедитесь, что IPN Secret Key совпадает с `NOWPAYMENTS_IPN_SECRET` в Render

### 4. Проверить настройки

После настройки:
1. Перезапустите сервис на Render
2. Откройте сайт и попробуйте нажать кнопку оплаты в чат-боте
3. Проверьте логи на Render - должны быть сообщения о создании платежа

## Как работает оплата

1. Пользователь нажимает кнопку "Pay with Crypto" или "Pay with Card"
2. Фронтенд отправляет запрос на `/api/payments/nowpayments/invoice`
3. Бэкенд создает платеж в NOWPayments и возвращает URL для оплаты
4. Пользователь переходит на страницу оплаты NOWPayments
5. После оплаты NOWPayments отправляет webhook на `/api/payments/nowpayments/callback`
6. Бэкенд активирует подписку для пользователя

## Отладка

Если оплата не работает:

1. **Проверьте логи на Render:**
   - Должны быть сообщения "Creating NOWPayments invoice..."
   - Если есть ошибки - скопируйте их

2. **Проверьте переменные окружения:**
   - Убедитесь, что `NOWPAYMENTS_API_KEY` и `NOWPAYMENTS_IPN_SECRET` установлены
   - Проверьте, что `APP_BASE_URL` указывает на правильный домен

3. **Проверьте webhook:**
   - В Dashboard NOWPayments проверьте, что IPN URL правильный
   - Проверьте логи на Render при тестовой оплате

## Альтернативные платежные системы

Если NOWPayments не подходит, в коде также есть поддержка:
- **CryptoCloud** (только криптовалюта)
- **CloudPayments** (только карты, для России)
- **CoinGate** (карты и криптовалюта, для Европы/США)
- **YooKassa** (карты, для России)
- **Stripe** (карты, для США/Европы)

Но NOWPayments - лучший вариант, так как поддерживает и карты, и крипту, и работает для России.

