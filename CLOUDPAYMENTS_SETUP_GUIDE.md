# 💳 CloudPayments Setup Guide - Card Payments for Friendly Countries

## 🌍 Supported Countries (Friendly to Russia)

CloudPayments supports card payments from these countries:

### ✅ Fully Supported:
- 🇷🇺 **Russia** (Россия)
- 🇧🇾 **Belarus** (Беларусь)
- 🇰🇿 **Kazakhstan** (Казахстан)
- 🇰🇬 **Kyrgyzstan** (Кыргызстан)
- 🇦🇲 **Armenia** (Армения)
- 🇦🇿 **Azerbaijan** (Азербайджан)
- 🇹🇯 **Tajikistan** (Таджикистан)
- 🇺🇿 **Uzbekistan** (Узбекистан)
- 🇹🇷 **Turkey** (Турция)
- 🇨🇳 **China** (Китай)
- 🇮🇳 **India** (Индия)
- 🇧🇷 **Brazil** (Бразилия)
- 🇦🇪 **UAE** (ОАЭ)
- 🇸🇦 **Saudi Arabia** (Саудовская Аравия)
- 🇮🇷 **Iran** (Иран)
- 🇻🇳 **Vietnam** (Вьетнам)
- 🇹🇭 **Thailand** (Таиланд)
- 🇮🇩 **Indonesia** (Индонезия)
- 🇲🇾 **Malaysia** (Малайзия)
- 🇵🇭 **Philippines** (Филиппины)

### ⚠️ Limited Support:
- 🇪🇺 **European Union** (ЕС) - Some countries may have restrictions
- 🇺🇸 **USA** - May have restrictions depending on card type

---

## 🔑 Step 1: Get CloudPayments API Keys

### Registration:
1. Go to **https://cloudpayments.ru/**
2. Click **"Регистрация"** (Registration)
3. Fill in your business details:
   - Company name or Individual entrepreneur (ИП)
   - Contact information
   - Business type: **"Образовательные услуги"** (Educational services)
   - Website: Your crypto platform URL

### After Registration:
1. Go to **"Настройки"** (Settings) → **"API"**
2. You'll get:
   - **Public ID** (публичный ключ) - for frontend
   - **API Secret** (секретный ключ) - for backend (NEVER share!)

---

## ⚙️ Step 2: Configure Environment Variables

Add to `/backend/.env`:

```env
# CloudPayments card payments
CLOUDPAYMENTS_PUBLIC_ID=your_public_id_here
CLOUDPAYMENTS_API_SECRET=your_api_secret_here
```

**Example:**
```env
CLOUDPAYMENTS_PUBLIC_ID=pk_1234567890abcdef
CLOUDPAYMENTS_API_SECRET=sk_abcdef1234567890
```

---

## 🔧 Step 3: Configure Payment Widget

The code is already set up in `scripts/chatbot.js`. CloudPayments widget will:
- Accept cards from supported countries
- Support Visa, Mastercard, МИР
- Handle 3D Secure authentication
- Process payments in USD

### Current Configuration:
- **Currency:** USD
- **Widget:** CloudPayments mini widget
- **Callback URL:** `/api/payments/cloudpayments/callback`

---

## 📋 Step 4: Test Payment Flow

### Test Mode:
1. CloudPayments has a test mode
2. Use test cards:
   - **Success:** `4111 1111 1111 1111`
   - **Decline:** `4000 0000 0000 0002`
   - **3D Secure:** `4000 0000 0000 0002`
   - **CVV:** Any 3 digits
   - **Expiry:** Any future date

### Production Mode:
- After testing, switch to production
- Real cards will be processed
- Payments will be credited to your account

---

## 🌐 Step 5: Country Restrictions (Optional)

If you want to restrict to specific countries, you can add this to the widget configuration:

```javascript
widget.pay('charge', {
    // ... existing config ...
    restrictCountries: ['RU', 'BY', 'KZ', 'CN', 'IN', 'TR'] // ISO country codes
});
```

**Friendly Country Codes:**
- `RU` - Russia
- `BY` - Belarus
- `KZ` - Kazakhstan
- `KG` - Kyrgyzstan
- `AM` - Armenia
- `AZ` - Azerbaijan
- `TJ` - Tajikistan
- `UZ` - Uzbekistan
- `TR` - Turkey
- `CN` - China
- `IN` - India
- `BR` - Brazil
- `AE` - UAE
- `SA` - Saudi Arabia
- `IR` - Iran
- `VN` - Vietnam
- `TH` - Thailand
- `ID` - Indonesia
- `MY` - Malaysia
- `PH` - Philippines

---

## 💰 Fees and Commission

CloudPayments charges:
- **Russia:** ~2.5-3% per transaction
- **Other countries:** Varies by country (usually 2.5-4%)
- **Minimum commission:** Usually $0.10-0.30 per transaction

**For $10 subscription:**
- Commission: ~$0.25-0.40
- You receive: ~$9.60-9.75

---

## ✅ Checklist

- [ ] Registered on CloudPayments.ru
- [ ] Got Public ID and API Secret
- [ ] Added keys to `.env` file
- [ ] Restarted backend server
- [ ] Tested with test card
- [ ] Verified callback works
- [ ] Tested subscription activation
- [ ] Switched to production mode (when ready)

---

## 🚨 Important Notes

1. **API Secret** - NEVER commit to Git! Keep it in `.env` only
2. **HTTPS Required** - Production requires HTTPS (SSL certificate)
3. **Webhook URL** - Must be publicly accessible for callbacks
4. **Compliance** - Make sure your business complies with local laws
5. **Taxes** - You're responsible for tax reporting in your country

---

## 📞 Support

- **CloudPayments Support:** support@cloudpayments.ru
- **Documentation:** https://cloudpayments.ru/docs/
- **API Docs:** https://developers.cloudpayments.ru/

---

## 🔄 After Setup

1. Users from friendly countries can pay with cards
2. Payments are processed instantly
3. Subscription activates automatically after payment
4. You receive money in your CloudPayments account
5. Withdraw to your bank account (usually 1-3 business days)

