# API Reference Documentation

## Base URLs
- **Production:** https://crypto-academy-pro.onrender.com
- **Local Development:** http://localhost:4000

## Authentication
Currently uses `userId` parameter for user identification.  
**Note:** In production, implement proper JWT authentication.

---

## Endpoints

### 1. Get User Status
**GET** `/api/status`

Get user subscription and trial status.

**Query Parameters:**
- `userId` (required) - User identifier string

**Response:**
```json
{
  "userId": "user123",
  "freeTrialEndsAt": "2024-01-02T12:00:00.000Z",
  "subscriptionActiveUntil": null,
  "hasAccess": true
}
```

**Status Codes:**
- `200` - Success
- `400` - Missing userId parameter

**Why This Endpoint?**
- Check subscription status
- Display trial time remaining
- Control feature access

---

### 2. Chat API
**POST** `/api/chat`

Send message to AI chat assistant (Mistral AI).

**Request Body:**
```json
{
  "userId": "user123",
  "question": "What is Bitcoin?"
}
```

**Response:**
```json
{
  "response": "Bitcoin is a decentralized digital currency...",
  "hasAccess": true
}
```

**Status Codes:**
- `200` - Success
- `400` - Missing required fields
- `403` - Subscription expired
- `500` - AI service error

**Why Mistral AI?**
- High-quality responses
- Understands crypto terminology
- Fast response times
- Good pricing

**Rate Limiting:**
- 10 requests per minute per user
- Prevents abuse
- Keeps costs manageable

---

### 3. Create Crypto Payment Invoice
**POST** `/api/create-crypto-invoice`

Create payment invoice for cryptocurrency (CryptoCloud).

**Request Body:**
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

**Why CryptoCloud?**
- Easy integration
- Supports USDT
- Good documentation
- Reliable service

**Invoice Expiration:**
- 1 hour default
- Prevents stale invoices
- User can create new one

---

### 4. Check Payment Status
**GET** `/api/check-payment/:orderId`

Check status of payment invoice.

**URL Parameters:**
- `orderId` (required) - Order identifier

**Response:**
```json
{
  "orderId": "order_456",
  "status": "paid",
  "paidAt": "2024-01-01T12:00:00.000Z"
}
```

**Status Values:**
- `pending` - Payment not received
- `paid` - Payment confirmed
- `expired` - Invoice expired
- `failed` - Payment failed

---

### 5. Create Card Payment
**POST** `/api/create-card-payment`

Create payment for card payment (CloudPayments).

**Request Body:**
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

**Why CloudPayments?**
- Supports Visa/Mastercard
- Good for Russian market
- Reliable processing
- Easy integration

---

### 6. Webhook - Payment Callback
**POST** `/api/webhook/payment`

Webhook endpoint for payment service callbacks.

**Request Body:**
Varies by payment provider (CryptoCloud or CloudPayments).

**Response:**
```json
{
  "success": true,
  "message": "Payment processed"
}
```

**Security:**
- Verify webhook signatures
- Validate payment amounts
- Check for duplicates

---

## Error Responses

All endpoints return errors in this format:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

**Common Error Codes:**
- `MISSING_USER_ID` - userId parameter required
- `SUBSCRIPTION_EXPIRED` - User subscription expired
- `PAYMENT_FAILED` - Payment processing failed
- `INVALID_REQUEST` - Invalid request parameters
- `SERVICE_UNAVAILABLE` - External service unavailable

---

## Environment Variables

```env
# AI Service
MISTRAL_API_KEY=your_mistral_key

# Crypto Payments
CRYPTOCLOUD_API_KEY=your_cryptocloud_key
CRYPTOCLOUD_SHOP_ID=your_shop_id

# Card Payments
CLOUDPAYMENTS_PUBLIC_ID=your_public_id
CLOUDPAYMENTS_API_SECRET=your_api_secret

# Application
APP_BASE_URL=https://crypto-academy-pro.onrender.com
SUBSCRIPTION_PRICE_USD=10
SUBSCRIPTION_PERIOD_DAYS=30
FREE_TRIAL_HOURS=24
```

---

## Testing

### Local Testing
```bash
# Start server
node server.js

# Test status
curl http://localhost:4000/api/status?userId=test123

# Test chat
curl -X POST http://localhost:4000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"userId":"test123","question":"What is Bitcoin?"}'
```

---

## Security Notes

1. **User Authentication:** Currently simple userId. Implement JWT in production.
2. **API Keys:** Never expose in client-side code.
3. **Webhooks:** Always verify signatures.
4. **Rate Limiting:** Implement to prevent abuse.
5. **HTTPS:** Always use in production.

---

## Future Improvements

- [ ] JWT authentication
- [ ] Rate limiting middleware
- [ ] API versioning
- [ ] Comprehensive error logging
- [ ] Swagger/OpenAPI documentation

---

**Next:** See [05_PAYMENT_INTEGRATION.md](./05_PAYMENT_INTEGRATION.md) for payment details.

