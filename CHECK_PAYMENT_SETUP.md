# ✅ Проверка настройки оплаты NOWPayments

## 🔑 Ключи уже есть в проекте:

✅ **NOWPAYMENTS_API_KEY:** `AWSK5JE-ZD5MGYE-QH1F0F2-BNHA3YA`
✅ **NOWPAYMENTS_IPN_SECRET:** `b1GhzIDJRz7AIKZ9ZETY/ZiN2yx42Rgf`
✅ **Public Key:** `ecf4be3b-4684-4096-9c57-91551274fff9`

## ⚠️ Что нужно проверить:

### 1. Переменные окружения на Render

Убедитесь, что в Render добавлены:
- `NOWPAYMENTS_API_KEY` = `AWSK5JE-ZD5MGYE-QH1F0F2-BNHA3YA`
- `NOWPAYMENTS_IPN_SECRET` = `b1GhzIDJRz7AIKZ9ZETY/ZiN2yx42Rgf`
- `APP_BASE_URL` = `https://crypto-academy-pro.onrender.com` (ВАЖНО: не localhost!)

### 2. Webhook в NOWPayments Dashboard

1. Зайдите на https://nowpayments.io
2. Перейдите в **Settings → IPN (Instant Payment Notifications)**
3. Проверьте, что указан URL:
   ```
   https://crypto-academy-pro.onrender.com/api/payments/nowpayments/callback
   ```
4. Проверьте, что IPN Secret совпадает с `b1GhzIDJRz7AIKZ9ZETY/ZiN2yx42Rgf`

### 3. Ошибка "Cannot GET" - это нормально!

Если вы видите ошибку "Cannot GET /api/payments/nowpayments/callback" при открытии в браузере - это **нормально**! 

Этот endpoint принимает только **POST** запросы (webhook от NOWPayments), а не GET. Браузер отправляет GET, поэтому и ошибка.

**Webhook будет работать правильно**, когда NOWPayments отправит POST запрос после оплаты.

## 🧪 Как проверить, что всё работает:

1. Откройте сайт: https://crypto-academy-pro.onrender.com
2. Откройте чат-бот
3. Нажмите кнопку "Pay with Crypto" или "Pay with Card"
4. Должна открыться страница оплаты NOWPayments
5. Проверьте логи на Render - должны быть сообщения:
   - "Creating NOWPayments invoice..."
   - "✅ NOWPayments invoice created successfully"

## 🔍 Если оплата не работает:

1. **Проверьте логи на Render:**
   - Откройте Render Dashboard → ваш сервис → Logs
   - Ищите сообщения об ошибках

2. **Проверьте переменные окружения:**
   - Убедитесь, что `APP_BASE_URL` = `https://crypto-academy-pro.onrender.com` (не localhost!)
   - Убедитесь, что ключи добавлены

3. **Проверьте webhook в NOWPayments:**
   - URL должен быть: `https://crypto-academy-pro.onrender.com/api/payments/nowpayments/callback`
   - IPN Secret должен совпадать

