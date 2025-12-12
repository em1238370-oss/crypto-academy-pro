# 💳 CoinGate Setup Guide - No Passport Required

## 🎯 Why CoinGate?

- ✅ **No passport required** - Just email verification
- ✅ **Accepts international cards** - Europe, USA, worldwide
- ✅ **Also accepts crypto** - Bonus feature!
- ✅ **Very simple registration** - Just email
- ✅ **Works from Russia** - No problems
- ✅ **Good API** - Perfect for subscriptions
- ✅ **Reasonable fees** - 3% for cards

---

## 📋 Step 1: Registration (5 minutes)

### 1. Go to CoinGate
- **Website:** https://coingate.com/
- Click **"Sign Up"** (top right)

### 2. Fill Registration Form
- **Email:** Your email address
- **Password:** Strong password
- **Country:** Your country (any country works)
- **Type:** Individual or Business (your choice)

### 3. Verify Email
- Check your email
- Click verification link
- **That's it!** No passport, no ID needed initially

### 4. Complete Profile (Optional)
- Add basic info (name, etc.)
- No documents required for basic account

---

## 🔑 Step 2: Get API Keys

### 1. Login to CoinGate
- Go to: https://coingate.com/account

### 2. Enable API
- Go to **"API"** section in dashboard
- Click **"Create API Key"**
- Choose permissions: **"Invoice"** and **"Payment"**

### 3. Get Credentials
You'll get:
- **API Key** (Secret key)
- **Merchant ID** (Your shop ID)

**Save these!** You'll need them for integration.

---

## ⚙️ Step 3: Configure Environment

Add to `/backend/.env`:

```env
# CoinGate card payments (international, no passport)
COINGATE_API_KEY=your_api_key_here
COINGATE_MERCHANT_ID=your_merchant_id_here
COINGATE_MODE=live  # or 'sandbox' for testing
```

---

## 🔧 Step 4: Integration Code

I'll create integration code that:
- Creates payment invoices via CoinGate API
- Opens CoinGate payment page (cards or crypto)
- Handles webhooks/callbacks
- Activates subscriptions after payment

---

## 💰 Fees

- **Card payments:** ~3% per transaction
- **Crypto payments:** ~1% per transaction (lower!)
- **For $10 subscription:**
  - Card: ~$0.30 commission, you receive ~$9.70
  - Crypto: ~$0.10 commission, you receive ~$9.90

---

## 🌍 Supported Cards

- ✅ **Visa** (all countries)
- ✅ **Mastercard** (all countries)
- ✅ **Amex** (American Express)
- ✅ **UnionPay** (China)
- ✅ **JCB** (Japan)
- ✅ **Discover** (USA)

---

## 🌍 Supported Countries

CoinGate accepts payments from:
- ✅ **Europe:** All EU countries, UK, Switzerland, etc.
- ✅ **USA:** All states
- ✅ **Russia & CIS:** All countries
- ✅ **Asia:** China, India, Japan, etc.
- ✅ **Other:** Most countries worldwide

---

## 💎 Bonus: Crypto Support

CoinGate also accepts:
- ✅ Bitcoin (BTC)
- ✅ Ethereum (ETH)
- ✅ USDT, USDC
- ✅ And 70+ other cryptocurrencies!

Users can choose: **Pay with card OR crypto!**

---

## ✅ Checklist

- [ ] Registered on coingate.com (just email)
- [ ] Verified email
- [ ] Got API keys (API Key, Merchant ID)
- [ ] Added keys to `.env` file
- [ ] Integration code ready (I'll create it)
- [ ] Tested with test payment
- [ ] Verified subscription activation
- [ ] Ready for production!

---

## 🚨 Important Notes

1. **No passport needed** - Just email verification
2. **Processing time** - Instant (just email verification)
3. **HTTPS required** - Production needs SSL certificate
4. **Webhook URL** - Must be publicly accessible
5. **Compliance** - Follow local laws

---

## 📞 Support

- **CoinGate Support:** support@coingate.com
- **Documentation:** https://developer.coingate.com/
- **FAQ:** https://coingate.com/help

---

## 🎯 Next Steps After Registration

1. Verify email (instant)
2. Get API keys from dashboard
3. Send me the keys (I'll integrate)
4. Test payment flow
5. Go live! 🚀

---

## 💡 Why CoinGate is Perfect for You:

1. ✅ **No passport** - Just email
2. ✅ **International cards** - Europe, USA
3. ✅ **Works from Russia** - No problems
4. ✅ **Also crypto** - Bonus feature
5. ✅ **Simple setup** - 1 day
6. ✅ **Good API** - Perfect for subscriptions
7. ✅ **Reasonable fees** - 3% for cards

**This is the best choice for your situation!**

