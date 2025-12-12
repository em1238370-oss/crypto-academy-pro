# 🚀 CoinGate Step-by-Step Registration Guide

## 📋 Step 1: Choose Account Type

**✅ SELECT: "Business Account"**

Why:
- Personal Account = Only for exchanging crypto (not for accepting payments)
- Business Account = For accepting payments (what you need!)

---

## 📝 Step 2: Fill Business Registration Form

After clicking "Business Account", you'll see a form. Fill it:

### Required Fields:
1. **Email:** Your email address
2. **Password:** Strong password (8+ characters)
3. **Company Name:** 
   - Use: "Crypto Academy Pro" or "CRYPTO" or your business name
   - If you don't have a company, use your name + "Education Platform"
4. **Website:** 
   - Your website URL (e.g., your domain or localhost for testing)
   - If testing: `http://localhost:4000` or your actual domain
5. **Country:** Your country
6. **Business Type:** 
   - Choose: "Education" or "Software/SaaS" or "Digital Services"
7. **Description:**
   - "Educational cryptocurrency platform with AI chatbot subscription and training modules"

### Optional Fields (can skip for now):
- Phone number
- Address
- Tax ID (if you have one)

---

## ✅ Step 3: Verify Email

1. Check your email inbox
2. Find email from CoinGate
3. Click verification link
4. Account will be activated

---

## 🔑 Step 4: Get API Keys

After email verification:

1. **Login** to CoinGate: https://coingate.com/account
2. Go to **"API"** section (in dashboard menu)
3. Click **"Create API Key"** or **"Generate API Token"**
4. Choose permissions:
   - ✅ **Invoice** (create payment invoices)
   - ✅ **Payment** (process payments)
   - ✅ **Webhook** (receive payment notifications)
5. Copy these values:
   - **API Key** (Secret token)
   - **Merchant ID** (Your shop ID - usually visible in dashboard)

**⚠️ IMPORTANT:** Save API Key immediately! You won't see it again.

---

## ⚙️ Step 5: Add to Environment File

Once you have API keys, add them to `/backend/.env`:

```env
# CoinGate card payments (international, no passport)
COINGATE_API_KEY=your_api_key_here
COINGATE_MERCHANT_ID=your_merchant_id_here
COINGATE_MODE=sandbox  # Use 'sandbox' for testing, 'live' for production
```

---

## 🧪 Step 6: Test Mode

CoinGate has **Sandbox** (test) mode:
- Use **sandbox** mode first to test
- Test with fake cards (they'll provide test card numbers)
- Switch to **live** mode when ready for real payments

---

## 📋 Checklist

- [ ] Selected "Business Account"
- [ ] Filled registration form
- [ ] Verified email
- [ ] Logged into dashboard
- [ ] Created API key
- [ ] Copied API Key and Merchant ID
- [ ] Added to `.env` file
- [ ] Ready for integration!

---

## 🎯 What Happens Next?

After you get API keys:
1. Send me the API Key and Merchant ID
2. I'll integrate CoinGate into your code
3. I'll set it up for bot subscription ($10/month)
4. We'll test with sandbox mode
5. Switch to live mode when ready!

---

## ⚠️ Important Notes

1. **Business Account** is required for accepting payments
2. **No passport needed** - Just email verification
3. **Sandbox mode** - Test first before going live
4. **API Key** - Keep it secret, never share publicly
5. **HTTPS required** - For production (live mode)

---

## 📞 If You Have Questions

- **CoinGate Support:** support@coingate.com
- **Documentation:** https://developer.coingate.com/
- **Or ask me!** I'll help you through each step.

