# 🚀 БЫСТРЫЙ СТАРТ - ЧТО ДЕЛАТЬ СЕЙЧАС

## ✅ ШАГ 1: Проверить Render Environment Variables

Зайти в Render Dashboard → Ваш сервис → Environment → Проверить:

```
APP_BASE_URL=https://crypto-academy-pro.onrender.com
PORT=10000
NOWPAYMENTS_API_KEY=ваш_ключ
NOWPAYMENTS_IPN_SECRET=ваш_секрет
MISTRAL_API_KEY=ваш_ключ
```

**Если чего-то нет - добавить!**

---

## ✅ ШАГ 2: Настроить NOWPayments Webhook

1. Зайти в NOWPayments Dashboard: https://nowpayments.io
2. Settings → IPN (Instant Payment Notifications)
3. Установить:
   - **IPN URL:** `https://crypto-academy-pro.onrender.com/api/payments/nowpayments/callback`
   - **IPN Secret:** должен совпадать с `NOWPAYMENTS_IPN_SECRET` в Render

---

## ✅ ШАГ 3: Проверить работу сайта

1. Открыть: https://crypto-academy-pro.onrender.com
2. Проверить чатбот - написать сообщение
3. Попробовать создать платеж (тестовый режим)
4. Проверить логи в Render - есть ли ошибки?

---

## ✅ ШАГ 4: Если что-то не работает

### Проблема: Сайт не открывается
- Проверить, что сервис запущен в Render
- Проверить логи на ошибки
- Убедиться, что порт правильный

### Проблема: Чатбот не отвечает
- Проверить `MISTRAL_API_KEY` в Render
- Проверить логи - есть ли ошибки API?

### Проблема: Платеж не создается
- Проверить `NOWPAYMENTS_API_KEY` в Render
- Проверить логи - какая ошибка?
- Убедиться, что аккаунт NOWPayments верифицирован

### Проблема: Webhook не работает
- Проверить `NOWPAYMENTS_IPN_SECRET` в Render
- Проверить URL webhook в NOWPayments
- Проверить логи - приходят ли запросы?

---

## 📞 КОНТАКТЫ И ПОМОЩЬ

- **Render Support:** https://render.com/docs
- **NOWPayments Docs:** https://documenter.getpostman.com/view/7907941/T1LJjU52
- **Mistral AI Docs:** https://docs.mistral.ai

---

**Готов помочь с настройкой! Просто скажи, что нужно сделать дальше! 🚀**


