# Stripe Payment Gateway Setup Guide

## Overview
Stripe is an international payment gateway that accepts American and European cards (Visa, Mastercard, American Express). It's widely recognized and trusted globally.

**Important Note:** Stripe has restrictions on Russian cards due to sanctions. For Russian users, we recommend using crypto payments (USDT) or NOWPayments, which accepts Russian cards.

## Step-by-Step Setup

### 1. Create Stripe Account
1. Go to https://stripe.com
2. Click "Start now" or "Sign up"
3. Enter your email address and create a password
4. Verify your email

### 2. Complete Business Information
1. **Business type:** Select "SaaS and Web Services" or "I'm an individual"
2. **Business website:** Enter your actual domain (e.g., `https://yourdomain.com`)
   - Note: `localhost` is not accepted. Use your real domain or a placeholder like `https://example.com` for testing
3. **Business description:** Describe your crypto education platform
4. **Country:** Select your country

### 3. Identity Verification
1. **For individuals:**
   - Provide your full name
   - Date of birth
   - Address
   - Phone number
   - Government-issued ID (passport, driver's license, etc.)

2. **For businesses:**
   - Company name and registration number
   - Business address
   - Tax ID
   - Business representative information
   - Business documents

### 4. Get API Keys
1. Go to **Developers** → **API keys** in your Stripe dashboard
2. You'll see two keys:
   - **Publishable key** (starts with `pk_test_` for test mode, `pk_live_` for live mode)
   - **Secret key** (starts with `sk_test_` for test mode, `sk_live_` for live mode)
3. Copy both keys

### 5. Configure Environment Variables
Add these to your `.env` file:

```env
STRIPE_PUBLISHABLE_KEY=pk_test_... (or pk_live_...)
STRIPE_SECRET_KEY=sk_test_... (or sk_live_...)
STRIPE_MODE=test (or live)
```

### 6. Enable Card Payments
1. In Stripe dashboard, go to **Settings** → **Payment methods**
2. Enable **Cards** (Visa, Mastercard, American Express)
3. Configure your payment settings

### 7. Test Mode vs Live Mode
- **Test mode:** Use `pk_test_` and `sk_test_` keys for testing
- **Live mode:** Use `pk_live_` and `sk_live_` keys for production
- Switch between modes in the Stripe dashboard

## Important Notes

### For Russian Users
- Stripe **does not accept Russian cards** due to sanctions
- Russian users should use:
  - **Crypto payments (USDT)** via CryptoCloud
  - **NOWPayments** (accepts Russian cards + crypto)

### Supported Cards
- ✅ Visa (all countries except Russia)
- ✅ Mastercard (all countries except Russia)
- ✅ American Express
- ✅ Discover
- ✅ Diners Club
- ✅ JCB

### Supported Countries
Stripe accepts cards from most countries, but has restrictions on:
- ❌ Russia
- ❌ Some sanctioned countries

## Testing
1. Use Stripe test cards: https://stripe.com/docs/testing
2. Test successful payments: `4242 4242 4242 4242`
3. Test declined payments: `4000 0000 0000 0002`
4. Use any future expiry date and any 3-digit CVC

## Support
- Stripe Documentation: https://stripe.com/docs
- Stripe Support: https://support.stripe.com

