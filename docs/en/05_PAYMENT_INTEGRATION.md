# Payment Integration Documentation

## Overview
Crypto Academy Pro supports two payment methods:
1. **Cryptocurrency (USDT)** via CryptoCloud
2. **Card (Visa/Mastercard)** via CloudPayments

## Why Two Payment Methods?

### Crypto Payments
- **Pros:** Lower fees, instant, crypto-native
- **Cons:** Less familiar to some users
- **Target:** Crypto-savvy users

### Card Payments
- **Pros:** Familiar, easy, widely accepted
- **Cons:** Higher fees, longer processing
- **Target:** General audience

## Subscription Pricing

### Free Trial
- **Duration:** 24 hours
- **Access:** All features
- **Purpose:** Let users experience value

### Monthly Subscription
- **Price:** $10 USD/month
- **Billing:** Recurring monthly
- **Payment Methods:** Crypto or Card

### Feature Tiers
- **Free:** News, Risk Distribution, Crypto Basics
- **Paid ($15/mo):** Crypto Coach, Smart Alerts, Cross Wallet
- **Premium ($25/mo):** AI Emotional Tracker, Investor Psychology, Predictive AI

## CryptoCloud Integration

### Setup Requirements
1. CryptoCloud account
2. API Key (`CRYPTOCLOUD_API_KEY`)
3. Shop ID (`CRYPTOCLOUD_SHOP_ID`)

### Why CryptoCloud?
- Easy integration
- Good documentation
- Supports USDT
- Reliable service

### Payment Flow

1. **Create Invoice**
   - User clicks "Pay with Crypto"
   - Backend creates invoice via CryptoCloud API
   - Returns payment address and link

2. **User Pays**
   - User sends USDT to address
   - Or uses payment link

3. **Verification**
   - CryptoCloud webhook notifies server
   - Server verifies payment
   - Subscription activated

4. **Check Status**
   - User can check payment status
   - System polls for updates

### Invoice Expiration
- Default: 1 hour
- User can create new invoice if expired

## CloudPayments Integration

### Setup Requirements
1. CloudPayments account
2. Public ID (`CLOUDPAYMENTS_PUBLIC_ID`)
3. API Secret (`CLOUDPAYMENTS_API_SECRET`)

### Why CloudPayments?
- Supports Visa/Mastercard
- Good for Russian market
- Reliable processing
- Easy integration

### Payment Flow

1. **Create Payment**
   - User clicks "Pay with Card"
   - Backend creates payment via CloudPayments API
   - Returns redirect URL

2. **User Redirected**
   - User redirected to CloudPayments checkout
   - Enters card details
   - Completes payment

3. **Callback**
   - CloudPayments webhook notifies server
   - Server verifies payment
   - Subscription activated

## Payment UI Components

### Payment Modal
- Shows payment amount
- Displays payment address (crypto) or redirect (card)
- Copy address button
- Payment link
- Status updates

### Subscription Banner
- Shows subscription status
- "Pay with Crypto" button
- Displays free trial information

### Chat Widget Payment
- Payment buttons in chat when subscription expires
- Two options: Crypto or Card
- Direct payment flow

## Webhook Handling

### CryptoCloud Webhook
**Endpoint:** `POST /api/webhook/payment`

**Verification:**
- Verify webhook signature
- Check invoice status
- Activate subscription on success

### CloudPayments Webhook
**Endpoint:** `POST /api/webhook/payment`

**Verification:**
- Verify webhook signature
- Check payment status
- Activate subscription on success

## Subscription Management

### User Storage
Currently uses in-memory storage (`Map`).  
**Production:** Use database (PostgreSQL/MongoDB).

### Subscription States
1. **Free Trial:** Active for 24 hours
2. **Active Subscription:** Paid subscription active
3. **Expired:** No active subscription

### Subscription Activation
- Automatic after payment confirmation
- Extends for subscription period (30 days)
- Recurring billing handled by payment providers

## Environment Variables

```env
# CryptoCloud
CRYPTOCLOUD_API_KEY=your_api_key
CRYPTOCLOUD_SHOP_ID=your_shop_id

# CloudPayments
CLOUDPAYMENTS_PUBLIC_ID=your_public_id
CLOUDPAYMENTS_API_SECRET=your_api_secret

# Subscription Settings
SUBSCRIPTION_PRICE_USD=10
SUBSCRIPTION_PERIOD_DAYS=30
FREE_TRIAL_HOURS=24
```

## Error Handling

### Payment Errors
- **Invoice Creation Failed:** Retry or contact support
- **Payment Timeout:** Create new invoice
- **Payment Failed:** Show error message, allow retry

### User Experience
- Clear error messages
- Retry options
- Support contact information

## Security Considerations

1. **API Keys:** Never expose in client-side code
2. **Webhook Verification:** Always verify signatures
3. **Payment Amounts:** Validate server-side
4. **User IDs:** Implement proper authentication
5. **HTTPS:** Always use in production

## Testing

### Test Crypto Payment
1. Create invoice via API
2. Use test USDT address
3. Verify webhook received
4. Check subscription activated

### Test Card Payment
1. Create payment via API
2. Use CloudPayments test cards
3. Complete test payment
4. Verify subscription activated

## Future Improvements

- [ ] Recurring subscription management
- [ ] Subscription cancellation
- [ ] Payment history
- [ ] Invoice management
- [ ] Refund handling
- [ ] Multiple currency support

---

**Next:** See [06_ARCHITECTURE.md](./06_ARCHITECTURE.md) for technical architecture.

