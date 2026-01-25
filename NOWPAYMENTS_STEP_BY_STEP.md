# 📋 Пошаговая инструкция для диагностики NOWPayments

## 🔍 ШАГ 1: Проверьте переменные окружения на Render

### 1.1. Откройте Render Dashboard
**Ссылка:** https://dashboard.render.com/

### 1.2. Найдите ваш сервис
- В списке сервисов найдите `crypto-academy-pro` (или как называется ваш сервис)
- Нажмите на него

### 1.3. Откройте раздел Environment
- В левом меню нажмите **"Environment"**
- Или перейдите по ссылке: `https://dashboard.render.com/web/[ваш-сервис]/environment`

### 1.4. Проверьте следующие переменные:

Должны быть такие переменные:

```
NOWPAYMENTS_API_KEY=AWSK5JE-ZD5MGYE-QH1F0F2-BNHA3YA
NOWPAYMENTS_IPN_SECRET=b1GhzIDJRz7AIKZ9ZETY/ZiN2yx42Rgf
APP_BASE_URL=https://crypto-academy-pro.onrender.com
```

**⚠️ ВАЖНО:** 
- `APP_BASE_URL` должен быть `https://crypto-academy-pro.onrender.com`
- НЕ должен быть `http://localhost:4000`

### 1.5. Если переменных нет или они неправильные:
- Нажмите **"Add Environment Variable"**
- Добавьте каждую переменную отдельно
- После добавления всех переменных нажмите **"Save Changes"**
- Render автоматически перезапустит сервис

**✅ Что проверить:**
- [ ] Все три переменные присутствуют
- [ ] `APP_BASE_URL` начинается с `https://`
- [ ] Значения совпадают с теми, что указаны выше

---

## 🔍 ШАГ 2: Проверьте настройки аккаунта NOWPayments

### 2.1. Откройте NOWPayments Dashboard
**Ссылка:** https://nowpayments.io/dashboard

### 2.2. Проверьте Payment Methods

**Путь:** Settings → Payment Methods

**Ссылка:** https://nowpayments.io/dashboard/settings/payment-methods

**Что проверить:**
- ✅ Должна быть включена опция **"Credit/Debit Cards"** (Visa, Mastercard)
- ✅ Должна быть включена опция **"Cryptocurrencies"**

**Если не включены:**
- Включите их
- Нажмите **"Save"**

**📸 Сделайте скриншот этого раздела и пришлите мне!**

### 2.3. Проверьте API Keys

**Путь:** Settings → API

**Ссылка:** https://nowpayments.io/dashboard/settings/api

**Что проверить:**
- ✅ Должен быть активный API Key
- ✅ API Key должен иметь права: **"View"** и **"Create Payments"**
- ✅ API Key должен совпадать с `NOWPAYMENTS_API_KEY` на Render

**Если API Key не совпадает:**
- Создайте новый API Key
- Скопируйте его
- Обновите на Render (ШАГ 1.5)

### 2.4. Проверьте IPN Settings

**Путь:** Settings → IPN Settings

**Ссылка:** https://nowpayments.io/dashboard/settings/ipn

**Что проверить:**
- ✅ IPN должен быть включен (переключатель в положении **"ON"**)
- ✅ IPN URL должен быть: `https://crypto-academy-pro.onrender.com/api/payments/nowpayments/callback`
- ✅ IPN Secret должен совпадать с `NOWPAYMENTS_IPN_SECRET` на Render

**Если IPN URL неправильный:**
- Введите правильный URL: `https://crypto-academy-pro.onrender.com/api/payments/nowpayments/callback`
- Нажмите **"Save"**

**Если IPN Secret не совпадает:**
- Нажмите **"Generate IPN Secret"** (или "Regenerate")
- Скопируйте новый Secret
- Обновите на Render (ШАГ 1.5)

### 2.5. Проверьте доступные валюты

**Путь:** Settings → Payments → Payment details

**Ссылка:** https://nowpayments.io/dashboard/settings/payments

**Что проверить:**
- ✅ В списке валют должна быть **USDT** (или `usdttrc20`, `usdterc20`)
- ✅ USDT должна быть **включена** для приема платежей

**Если USDT не включена:**
- Найдите USDT в списке
- Включите переключатель рядом с ней
- Нажмите **"Save"**

**📸 Сделайте скриншот списка валют и пришлите мне!**

---

## 🔍 ШАГ 3: Проверьте логи на Render

### 3.1. Откройте логи сервиса

**Путь:** Render Dashboard → ваш сервис → Logs

**Ссылка:** `https://dashboard.render.com/web/[ваш-сервис]/logs`

### 3.2. Попробуйте создать платеж

1. Откройте сайт: **https://crypto-academy-pro.onrender.com**
2. Нажмите на чат-бот (кружок в правом нижнем углу)
3. Нажмите кнопку **"Pay with Crypto"** (или "Pay with Card")
4. Подождите несколько секунд

### 3.3. Скопируйте логи

В разделе Logs на Render найдите и скопируйте **все строки**, которые содержат:

- `Creating NOWPayments invoice with payload:`
- `NOWPayments response data:`
- `❌ NOWPayments invoice error:`
- `pay_currency`
- `Error status:`

**📋 Скопируйте эти логи и пришлите мне!**

---

## 🔍 ШАГ 4: Проверьте консоль браузера

### 4.1. Откройте сайт и консоль разработчика

1. Откройте сайт: **https://crypto-academy-pro.onrender.com**
2. Нажмите **F12** (или **Cmd+Option+I** на Mac)
3. Откроется окно разработчика

### 4.2. Проверьте вкладку Console

1. Перейдите на вкладку **"Console"**
2. Попробуйте создать платеж (нажмите "Pay with Crypto")
3. Скопируйте **все красные ошибки**, которые появятся

**📋 Скопируйте ошибки из Console и пришлите мне!**

### 4.3. Проверьте вкладку Network

1. Перейдите на вкладку **"Network"**
2. Очистите список (кнопка 🚫 или **Ctrl+R**)
3. Попробуйте создать платеж (нажмите "Pay with Crypto")
4. Найдите запрос к `/api/payments/nowpayments/invoice`
5. Нажмите на этот запрос
6. Откройте вкладку **"Payload"** (или "Request")
7. Скопируйте содержимое
8. Откройте вкладку **"Response"** (или "Preview")
9. Скопируйте содержимое

**📋 Скопируйте Payload и Response и пришлите мне!**

---

## 📤 Что мне нужно прислать:

После выполнения всех шагов, пришлите мне:

1. ✅ **Скриншот** раздела "Payment Methods" в NOWPayments
2. ✅ **Скриншот** списка валют в NOWPayments (особенно USDT)
3. ✅ **Логи с Render** (ШАГ 3.3)
4. ✅ **Ошибки из Console** браузера (ШАГ 4.2)
5. ✅ **Payload и Response** из Network (ШАГ 4.3)
6. ✅ **Точный текст ошибки**, который видит пользователь на сайте

---

## ⚡ Быстрая проверка (если нет времени на все шаги):

**Минимум, что нужно проверить:**

1. ✅ **Render Environment** → `APP_BASE_URL` должен быть `https://crypto-academy-pro.onrender.com`
2. ✅ **NOWPayments Payment Methods** → должны быть включены Cards и Crypto
3. ✅ **Логи Render** → скопировать ошибку после попытки создать платеж

**Пришлите хотя бы это, и я смогу начать диагностику!**


