# 💳 Payeer Setup Guide - International Cards (No IP Required)

## 🎯 Why Payeer?

- ✅ **No IP required** - Register as individual
- ✅ **Accepts international cards** - Europe, USA, worldwide
- ✅ **Works from Russia** - No problems
- ✅ **Simple registration** - 1-2 days verification
- ✅ **Good API** - Easy integration
- ✅ **Subscription support** - Perfect for $10/month bot

---

## 📋 Step 1: Registration

### 1. Go to Payeer
- **Website:** https://payeer.com/
- Click **"Регистрация"** (Registration)

### 2. Fill Registration Form
- **Email:** Your email
- **Password:** Strong password
- **Phone:** Your phone number
- **Country:** Your country
- **Type:** Individual (not business)

### 3. Verify Account
- Check email for verification link
- Verify phone number (SMS code)
- Upload ID document (passport or driver's license)
- Wait 1-2 days for approval

---

## 🔑 Step 2: Get API Keys

### 1. Login to Payeer
- Go to: https://payeer.com/account/

### 2. Enable API
- Go to **"Настройки"** (Settings)
- Find **"API"** section
- Click **"Создать ключ"** (Create key)

### 3. Get Credentials
You'll get:
- **Merchant ID** (ID магазина)
- **Secret Key** (Секретный ключ)
- **API Key** (API ключ)

**Save these!** You'll need them for integration.

---

## ⚙️ Step 3: Configure Environment

Add to `/backend/.env`:

```env
# Payeer card payments (international)
PAYEER_MERCHANT_ID=your_merchant_id
PAYEER_SECRET_KEY=your_secret_key
PAYEER_API_KEY=your_api_key
PAYEER_SHOP_ID=your_shop_id
```

---

## 🔧 Step 4: Integration Code

I'll create integration code that:
- Creates payment invoices
- Opens Payeer payment page
- Handles callbacks
- Activates subscriptions after payment

---

## 💰 Fees

- **Card payments:** 2.5-3% per transaction
- **For $10 subscription:** ~$0.25-0.30 commission
- **You receive:** ~$9.70-9.75

---

## 🌍 Supported Cards

- ✅ **Visa** (all countries)
- ✅ **Mastercard** (all countries)
- ✅ **МИР** (Russia)
- ✅ **UnionPay** (China)
- ✅ **JCB** (Japan)

---

## 📝 Supported Countries

Payeer accepts cards from:
- ✅ **Europe:** All EU countries, UK, Switzerland, etc.
- ✅ **USA:** All states
- ✅ **Russia & CIS:** All countries
- ✅ **Asia:** China, India, Japan, etc.
- ✅ **Other:** Most countries worldwide

---

## ✅ Checklist

- [ ] Registered on Payeer.com
- [ ] Verified account (1-2 days)
- [ ] Got API keys (Merchant ID, Secret Key, API Key)
- [ ] Added keys to `.env` file
- [ ] Integration code ready (I'll create it)
- [ ] Tested with test payment
- [ ] Verified subscription activation
- [ ] Ready for production!

---

## 🚨 Important Notes

1. **Verification required** - Need to upload ID
2. **Processing time** - 1-2 business days for approval
3. **HTTPS required** - Production needs SSL certificate
4. **Webhook URL** - Must be publicly accessible
5. **Compliance** - Follow local laws

---

## 📞 Support

- **Payeer Support:** support@payeer.com
- **Documentation:** https://payeer.com/api/
- **FAQ:** https://payeer.com/ru/help/

---

## 🎯 Next Steps After Registration

1. Wait for account verification (1-2 days)
2. Get API keys from dashboard
3. Send me the keys (I'll integrate)
4. Test payment flow
5. Go live! 🚀

