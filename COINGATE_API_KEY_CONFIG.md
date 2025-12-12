# 🔑 CoinGate API Key Configuration - Fill This Form

## 🎯 Fill API Key Configuration Form:

### Settings Section:

**Title*** (Required):
```
Crypto Academy Pro API
```
(Or: "Bot Subscription API" or "Payment Integration API")

**Whitelisted IP addresses:**
- Already has: `127.0.0.1` (localhost - for testing)
- You can leave it as is ✅
- Or add your server IP later (for production)

**Display header title on invoice:**
- Leave toggle OFF (gray) ✅
- Or turn ON if you want title on invoices

---

### Advanced Options:

**Underpaid cover percentage (%):**
- Leave empty ✅
- Or enter `0` if you want exact payment only

---

### Paid Notifications:

**Send notification each time payment is received:**
- ✅ **Turn ON** (toggle to ON/blue)
- This will send notifications when payments are received
- Important for activating subscriptions!

---

### Callback Format ⚠️ IMPORTANT:

**Current:** "Form encoding" is selected (purple dot)

**❌ WRONG for API integration!**

**✅ CORRECT:**
- **Select "JSON"** (application/json)
- This is required for API integration!
- Form encoding is only for plugins

**Why JSON:**
- ✅ API integration uses JSON
- ✅ Easier to parse in code
- ✅ Standard format for APIs
- ✅ Better for webhooks

---

## 📋 Complete Form Summary:

```
Title: Crypto Academy Pro API
Whitelisted IP: 127.0.0.1 (leave as is)
Display header: OFF (or ON if you want)
Underpaid cover: (leave empty)
Paid notifications: ON ✅ (turn on!)
Callback format: JSON ✅ (select JSON!)
```

---

## ✅ Step-by-Step:

1. **Title:**
   - Enter: `Crypto Academy Pro API`

2. **Whitelisted IP:**
   - Leave `127.0.0.1` as is (for testing)

3. **Display header:**
   - Leave OFF (or turn ON if you want)

4. **Underpaid cover:**
   - Leave empty

5. **Paid notifications:**
   - ✅ **Turn ON** (toggle to blue/ON)

6. **Callback format:**
   - ❌ Currently: "Form encoding" (wrong!)
   - ✅ **Select "JSON"** (application/json)

7. **Click "Create authorization token"** (purple button, bottom right)

---

## ⚠️ CRITICAL: Callback Format

**MUST SELECT JSON!**

- ❌ Form encoding = Only for plugins
- ✅ JSON = For API integration (what you need!)

**Action:**
- Click "JSON" radio button
- This is essential for API integration!

---

## 🔑 After Creating Token:

You'll get:
- **API Key** (Authorization token)
- **Merchant ID** (if not already visible)
- **Save immediately!**

---

## 📝 Quick Checklist:

- [ ] Title: `Crypto Academy Pro API`
- [ ] Whitelisted IP: `127.0.0.1` (leave as is)
- [ ] Paid notifications: **ON** ✅
- [ ] Callback format: **JSON** ✅ (IMPORTANT!)
- [ ] Click "Create authorization token"

---

**Fill the form, select JSON, and create token!**

