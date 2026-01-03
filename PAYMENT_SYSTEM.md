# Payment System Documentation

## Overview
Crypto Academy Pro supports two payment methods:
1. **Cryptocurrency payments** (USDT) via CryptoCloud
2. **Card payments** (Visa/Mastercard) via CloudPayments

---

## Subscription Pricing

### Free Trial
- **Duration:** 24 hours
- **Access:** All features
- **Auto-expires:** After trial period

### Monthly Subscription
- **Price:** $10 USD/month
- **Billing:** Recurring monthly
- **Payment Methods:** Crypto or Card

### Feature Tiers
- **Free:** News, Risk Distribution, Crypto Basics
- **Paid ($15/mo):** Crypto Coach, Smart Alerts, Cross Wallet
- **Premium ($25/mo):** AI Emotional Tracker, Investor Psychology, Predictive AI

---

## Cryptocurrency Payments (CryptoCloud)

### Setup Requirements
1. CryptoCloud account
2. API Key (`CRYPTOCLOUD_API_KEY`)
3. Shop ID (`CRYPTOCLOUD_SHOP_ID`)

### Payment Flow

#### 1. Create Invoice
**Endpoint:** `POST /api/create-crypto-invoice`

**Request:**
```json
{
  "userId": "user123",
  "amount": 10.00,
  "currency": "USD"
}
```

**Response:**
```json
{
  "invoiceId": "invoice_123",
  "orderId": "order_456",
  "amount": "10.00",
  "currency": "USD",
  "address": "0x1234...",
  "paymentLink": "https://pay.cryptocloud.plus/...",
  "expiresAt": "2024-01-02T12:00:00.000Z"
}
```

#### 2. User Pays
- User sends USDT to provided address
- Or uses payment link for easier payment

#### 3. Payment Verification
- CryptoCloud webhook notifies server
- Server verifies payment
- Subscription activated automatically

#### 4. Check Status
**Endpoint:** `GET /api/check-payment/:orderId`

Returns payment status: `pending`, `paid`, `expired`, or `failed`

### Invoice Expiration
- Invoices expire after 1 hour
- User can create new invoice if expired

---

## Card Payments (CloudPayments)

### Setup Requirements
1. CloudPayments account
2. Public ID (`CLOUDPAYMENTS_PUBLIC_ID`)
3. API Secret (`CLOUDPAYMENTS_API_SECRET`)

### Payment Flow

#### 1. Create Payment
**Endpoint:** `POST /api/create-card-payment`

**Request:**
```json
{
  "userId": "user123",
  "amount": 10.00,
  "currency": "USD"
}
```

**Response:**
```json
{
  "paymentId": "payment_123",
  "amount": "10.00",
  "currency": "USD",
  "redirectUrl": "https://cloudpayments.ru/..."
}
```

#### 2. User Redirected
- User redirected to CloudPayments checkout
- Enters card details
- Completes payment

#### 3. Payment Callback
- CloudPayments webhook notifies server
- Server verifies payment
- Subscription activated

### Supported Cards
- Visa
- Mastercard
- Other cards supported by CloudPayments

---

## Payment UI Components

### Payment Modal
Located in `index.html`:
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

---

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

---

## Subscription Management

### User Storage
Currently uses in-memory storage (`Map`). In production, use database.

### Subscription States
1. **Free Trial:** Active for 24 hours
2. **Active Subscription:** Paid subscription active
3. **Expired:** No active subscription

### Subscription Activation
- Automatic after payment confirmation
- Extends for subscription period (30 days)
- Recurring billing handled by payment providers

---

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

---

## Error Handling

### Payment Errors
- **Invoice Creation Failed:** Retry or contact support
- **Payment Timeout:** Create new invoice
- **Payment Failed:** Show error message, allow retry

### User Experience
- Clear error messages
- Retry options
- Support contact information

---

## Security Considerations

1. **API Keys:** Never expose in client-side code
2. **Webhook Verification:** Always verify webhook signatures
3. **Payment Amounts:** Validate amounts server-side
4. **User IDs:** Implement proper user authentication
5. **HTTPS:** Always use HTTPS in production

---

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

### Test Cards (CloudPayments)
- Success: `4111 1111 1111 1111`
- Decline: `4000 0000 0000 0002`

---

## Future Improvements

- [ ] Recurring subscription management
- [ ] Subscription cancellation
- [ ] Payment history
- [ ] Invoice management
- [ ] Refund handling
- [ ] Multiple currency support
- [ ] Payment method preferences

---

## Support

For payment issues:
1. Check payment status via API
2. Verify webhook received
3. Check payment provider dashboard
4. Contact payment provider support if needed

