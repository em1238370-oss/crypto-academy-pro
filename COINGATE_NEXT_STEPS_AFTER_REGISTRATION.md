# 🚀 CoinGate - Next Steps After Registration

## ✅ Current Status:

- ✅ Business Account created
- ✅ Registration completed
- ⏳ Verification skipped (can do later)
- ✅ Ready to get API keys and integrate!

---

## 🔑 Step 1: Get API Keys

### How to Get API Keys:

1. **Login to CoinGate Business Account**
   - You're already logged in ✅

2. **Go to "Integrations" section**
   - Click "Integrations" in left sidebar (icon: `<>`)

3. **Find API section**
   - Look for "API" or "API Keys" or "Developer"
   - Or "Settings" → "API"

4. **Create API Key**
   - Click "Create API Key" or "Generate Token"
   - Choose permissions:
     - ✅ **Invoice** (create payment invoices)
     - ✅ **Payment** (process payments)
     - ✅ **Webhook** (receive payment notifications)

5. **Copy these values:**
   - **API Key** (Secret token - save immediately!)
   - **Merchant ID** (Your shop ID - usually visible in dashboard)

**⚠️ IMPORTANT:** Save API Key immediately! You won't see it again.

---

## ⚙️ Step 2: Add to Environment File

Once you have API keys, add to `/backend/.env`:

```env
# CoinGate card payments (international)
COINGATE_API_KEY=your_api_key_here
COINGATE_MERCHANT_ID=your_merchant_id_here
COINGATE_MODE=sandbox  # Use 'sandbox' for testing, 'live' for production
```

---

## 🔧 Step 3: Integration Code

I'll create integration code that:
- Creates payment invoices via CoinGate API
- Opens CoinGate payment page (cards or crypto)
- Handles webhooks/callbacks
- Activates subscriptions after payment

---

## 📋 Checklist:

- [ ] Go to "Integrations" section
- [ ] Find API/Developer section
- [ ] Create API Key
- [ ] Copy API Key and Merchant ID
- [ ] Add to `.env` file
- [ ] Tell me when ready - I'll integrate!

---

## 💡 What You'll See in Integrations:

- API documentation
- API keys section
- Webhook settings
- Test mode / Live mode toggle

---

## 🎯 Next Steps:

1. **Get API keys** from Integrations section
2. **Send me the keys** (I'll integrate)
3. **Test payment flow** with sandbox mode
4. **Go live** when ready!

---

**Go to "Integrations" section and get API keys!**

