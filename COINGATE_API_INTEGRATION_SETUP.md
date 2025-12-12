# 🔧 CoinGate API Integration Setup - For European & American Cards

## 🎯 Goal:
- ✅ Accept European cards (Visa, Mastercard)
- ✅ Accept American cards (Visa, Mastercard, Amex)
- ✅ For bot subscription ($10/month)
- ✅ For training modules ($15, $25)

---

## 📋 Step 1: Choose Integration Method

**On the "Merchant tools" page, you see 3 options:**

1. **Plugins** - For ready-made platforms (WooCommerce, etc.)
2. **API integration** ⭐ **THIS ONE!** - For custom websites (what you need!)
3. **Payment button** - For simple websites

### ✅ Action:
**Click "Add API integration" button** (light purple button with plus icon)

**Why API integration:**
- ✅ You have custom website
- ✅ Need to integrate with your bot subscription system
- ✅ Need to handle callbacks and activate subscriptions
- ✅ Full control over payment flow

---

## 🔑 Step 2: Get API Credentials

After clicking "Add API integration", you'll see:

### What You'll Get:
1. **API Key** (Secret token)
   - For authenticating API requests
   - Keep it secret!

2. **Merchant ID** (Shop ID)
   - Your unique merchant identifier
   - Usually visible in dashboard

3. **API Endpoint**
   - Base URL: `https://api.coingate.com/v2/`
   - For creating invoices, checking status, etc.

---

## ⚙️ Step 3: Configure for Your Use Case

### What We Need:
- ✅ Create payment invoices ($10, $15, $25)
- ✅ Accept cards (Europe, USA)
- ✅ Accept crypto (bonus!)
- ✅ Handle payment callbacks
- ✅ Activate subscriptions after payment

---

## 📝 Step 4: Add to Environment File

Once you have API credentials, add to `/backend/.env`:

```env
# CoinGate API integration (European & American cards)
COINGATE_API_KEY=your_api_key_here
COINGATE_MERCHANT_ID=your_merchant_id_here
COINGATE_MODE=sandbox  # Use 'sandbox' for testing, 'live' for production
COINGATE_API_URL=https://api.coingate.com/v2/
```

---

## 🔧 Step 5: Integration Code

I'll create integration code that:

1. **Creates invoices** via CoinGate API
   - For bot subscription: $10/month
   - For training module 1: $15
   - For training module 2: $25

2. **Opens payment page**
   - Users can pay with card (Europe, USA)
   - Or with crypto (bonus!)

3. **Handles webhooks**
   - Receives payment notifications
   - Activates subscriptions automatically

4. **Checks payment status**
   - Verifies if payment completed
   - Updates user access

---

## 🌍 Supported Payment Methods:

### Cards (What You Need):
- ✅ **Visa** (Europe, USA, worldwide)
- ✅ **Mastercard** (Europe, USA, worldwide)
- ✅ **Amex** (American Express - USA)
- ✅ **UnionPay** (China)
- ✅ **JCB** (Japan)

### Crypto (Bonus):
- ✅ Bitcoin (BTC)
- ✅ Ethereum (ETH)
- ✅ USDT, USDC
- ✅ 70+ other cryptocurrencies

---

## 📋 Checklist:

- [ ] Click "Add API integration" button
- [ ] Get API Key and Merchant ID
- [ ] Copy API credentials
- [ ] Send me the credentials
- [ ] I'll integrate CoinGate API
- [ ] Test with sandbox mode
- [ ] Go live for European & American cards!

---

## 🎯 What Happens Next:

1. **You click "Add API integration"**
2. **Get API credentials**
3. **Send me the keys**
4. **I integrate CoinGate API into your code**
5. **Users can pay with European & American cards!**

---

**Click "Add API integration" and get your API credentials!**

