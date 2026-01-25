# 🔍 Чеклист для диагностики NOWPayments

## ✅ Шаг 1: Проверьте переменные окружения на Render

Зайдите в **Render Dashboard** → ваш сервис → **Environment** и убедитесь, что есть:

```
NOWPAYMENTS_API_KEY=AWSK5JE-ZD5MGYE-QH1F0F2-BNHA3YA
NOWPAYMENTS_IPN_SECRET=b1GhzIDJRz7AIKZ9ZETY/ZiN2yx42Rgf
APP_BASE_URL=https://crypto-academy-pro.onrender.com
```

**ВАЖНО:** `APP_BASE_URL` должен быть `https://crypto-academy-pro.onrender.com`, НЕ `localhost`!

---

## ✅ Шаг 2: Проверьте настройки аккаунта NOWPayments

Зайдите в **NOWPayments Dashboard** и проверьте:

### 2.1. Payment Methods
- **Settings** → **Payment Methods**
- ✅ Должны быть включены **"Credit/Debit Cards"**
- ✅ Должны быть включены **"Cryptocurrencies"**
- **Пришлите скриншот этого раздела!**

### 2.2. API Keys
- **Settings** → **API**
- ✅ Должен быть активный API Key с правами "View" и "Create Payments"
- ✅ API Key должен совпадать с `NOWPAYMENTS_API_KEY` на Render

### 2.3. IPN Settings
- **Settings** → **IPN Settings**
- ✅ IPN должен быть включен (ON)
- ✅ IPN URL должен быть: `https://crypto-academy-pro.onrender.com/api/payments/nowpayments/callback`
- ✅ IPN Secret должен совпадать с `NOWPAYMENTS_IPN_SECRET` на Render

### 2.4. Available Currencies
- **Settings** → **Payments** → **Payment details**
- ✅ Убедитесь, что **USDT** (или `usdttrc20`) включен для приема платежей
- **Пришлите список доступных валют!**

---

## ✅ Шаг 3: Проверьте логи на Render

1. Зайдите в **Render Dashboard** → ваш сервис → **Logs**
2. Попробуйте создать платеж (нажмите "Pay with Crypto" или "Pay with Card")
3. Скопируйте **все сообщения** из логов, которые начинаются с:
   - "Creating NOWPayments invoice with payload:"
   - "NOWPayments response data:"
   - "❌ NOWPayments invoice error:"
4. **Пришлите эти логи!**

---

## ✅ Шаг 4: Проверьте консоль браузера

1. Откройте сайт: `https://crypto-academy-pro.onrender.com`
2. Нажмите **F12** (откроется консоль разработчика)
3. Перейдите на вкладку **Console**
4. Попробуйте создать платеж
5. Скопируйте **все ошибки** из консоли
6. Перейдите на вкладку **Network**
7. Найдите запрос к `/api/payments/nowpayments/invoice`
8. Откройте его и скопируйте:
   - **Request Payload** (что отправляется)
   - **Response** (что приходит в ответ)
9. **Пришлите эти данные!**

---

## 📋 Что мне нужно от вас:

1. ✅ **Скриншот** раздела "Payment Methods" в NOWPayments Dashboard
2. ✅ **Список доступных валют** в NOWPayments (особенно USDT)
3. ✅ **Логи с Render** (после попытки создать платеж)
4. ✅ **Ответ из консоли браузера** (Network tab → `/api/payments/nowpayments/invoice`)
5. ✅ **Точный текст ошибки**, который видит пользователь

---

## 🔧 Что я проверю:

1. Правильность кода валюты (`usdttrc20` vs `usdt`)
2. Формат запроса к API NOWPayments
3. Обработку ошибок
4. Настройку переменных окружения

**Пришлите все данные, и я найду проблему!**


