# ⚙️ Переменные окружения для Render

## ✅ Сайт задеплоен!

**URL:** https://crypto-academy-pro.onrender.com

---

## 📋 Что нужно добавить в Render:

### В Render → Settings → Environment Variables:

1. **NOWPAYMENTS_API_KEY**
   - Value: `AWSK5JE-ZD5MGYE-QH1F0F2-BNHA3YA`

2. **NOWPAYMENTS_IPN_SECRET**
   - Value: `b1GhzIDJRz7AIKZ9ZETY/ZiN2yx42Rgf`

3. **APP_BASE_URL**
   - Value: `https://crypto-academy-pro.onrender.com`

4. **MISTRAL_API_KEY** (если есть)
   - Value: ваш ключ Mistral AI

5. **SUBSCRIPTION_PRICE_USD**
   - Value: `10`

6. **SUBSCRIPTION_PERIOD_DAYS**
   - Value: `30`

7. **FREE_TRIAL_HOURS**
   - Value: `24`

8. **PORT**
   - Value: `10000` (Render использует порт 10000)

---

## 🔔 Обновить Webhook URL в NOWPayments:

1. Откройте NOWPayments: https://nowpayments.io
2. Settings → Payments → Instant payment notifications
3. Измените Webhook URL на:
   ```
   https://crypto-academy-pro.onrender.com/api/payments/nowpayments/callback
   ```
4. Сохраните

---

## ✅ Готово!

После этого:
- Сайт будет доступен по ссылке
- Оплата картами заработает
- Чатбот будет работать

---

**Сейчас:** Добавьте переменные окружения в Render!

