# 🚀 CloudPayments Quick Start Guide

## ⚡ Fast Setup (5 minutes)

### 1. Register on CloudPayments
- Go to: **https://cloudpayments.ru/**
- Click: **"Регистрация"** (Registration)
- Business type: **"Образовательные услуги"** (Educational services)

### 2. Get API Keys
- Settings → API
- Copy **Public ID** and **API Secret**

### 3. Add to `.env` file
```env
CLOUDPAYMENTS_PUBLIC_ID=your_public_id_here
CLOUDPAYMENTS_API_SECRET=your_api_secret_here
```

### 4. Restart Server
```bash
cd backend
npm start
```

### 5. Test Payment
- Use test card: `4111 1111 1111 1111`
- Any CVV, any future expiry date
- Payment should work!

---

## 🌍 Supported Countries

✅ **Russia, Belarus, Kazakhstan, China, India, Turkey, UAE, Brazil, Iran, and 20+ more friendly countries**

---

## 💳 Card Types Supported

- ✅ Visa
- ✅ Mastercard
- ✅ МИР (Russia)
- ✅ UnionPay (China)
- ✅ JCB (Japan)

---

## 📝 Current Status

- ✅ Code is ready in `scripts/chatbot.js`
- ✅ Backend endpoint ready in `server.js`
- ⏳ **Need:** API keys from CloudPayments
- ⏳ **Need:** Add keys to `.env` file

---

## 🎯 Next Steps

1. Register on CloudPayments.ru
2. Get API keys
3. Add to `.env`
4. Restart server
5. Test payment
6. Go live! 🎉

