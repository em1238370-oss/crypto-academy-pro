# API Documentation

## Base URL
- **Production:** https://crypto-academy-pro.onrender.com
- **Local:** http://localhost:4000

---

## Authentication
Currently uses `userId` parameter for user identification. In production, implement proper authentication.

---

## Endpoints

### 1. Get User Status

**GET** `/api/status`

Get user subscription and trial status.

#### Query Parameters
- `userId` (required) - User identifier

#### Response
```json
{
  "userId": "user123",
  "freeTrialEndsAt": "2024-01-02T12:00:00.000Z",
  "subscriptionActiveUntil": null,
  "hasAccess": true
}
```

#### Status Codes
- `200` - Success
- `400` - Missing userId parameter

---

### 2. Chat API

**POST** `/api/chat`

Send message to AI chat assistant (Mistral AI).

#### Request Body
```json
{
  "userId": "user123",
  "question": "What is Bitcoin?"
}
```

#### Response
```json
{
  "response": "Bitcoin is a decentralized digital currency...",
  "hasAccess": true
}
```

#### Status Codes
- `200` - Success
- `400` - Missing required fields
- `403` - Subscription expired
- `500` - AI service error

#### Notes
- Requires active subscription or free trial
- Uses Mistral AI for responses
- Rate limiting may apply

---

### 3. Create Crypto Payment Invoice

**POST** `/api/create-crypto-invoice`

Create a payment invoice for cryptocurrency payment (CryptoCloud).

#### Request Body
```json
{
  "userId": "user123",
  "amount": 10.00,
  "currency": "USD"
}
```

#### Response
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

#### Status Codes
- `200` - Invoice created
- `400` - Invalid request
- `500` - Payment service error

---

### 4. Check Payment Status

**GET** `/api/check-payment/:orderId`

Check status of a payment invoice.

#### URL Parameters
- `orderId` (required) - Order identifier

#### Response
```json
{
  "orderId": "order_456",
  "status": "paid",
  "paidAt": "2024-01-01T12:00:00.000Z"
}
```

#### Status Codes
- `200` - Success
- `404` - Order not found
- `500` - Payment service error

#### Status Values
- `pending` - Payment not received
- `paid` - Payment confirmed
- `expired` - Invoice expired
- `failed` - Payment failed

---

### 5. Create Card Payment

**POST** `/api/create-card-payment`

Create a payment for card payment (CloudPayments).

#### Request Body
```json
{
  "userId": "user123",
  "amount": 10.00,
  "currency": "USD"
}
```

#### Response
```json
{
  "paymentId": "payment_123",
  "amount": "10.00",
  "currency": "USD",
  "redirectUrl": "https://cloudpayments.ru/..."
}
```

#### Status Codes
- `200` - Payment created
- `400` - Invalid request
- `500` - Payment service error

---

### 6. Webhook - Payment Callback

**POST** `/api/webhook/payment`

Webhook endpoint for payment service callbacks.

#### Request Body
Varies by payment provider (CryptoCloud or CloudPayments).

#### Response
```json
{
  "success": true,
  "message": "Payment processed"
}
```

#### Status Codes
- `200` - Webhook processed
- `400` - Invalid webhook data
- `500` - Processing error

---

## Error Responses

All endpoints may return error responses in this format:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

### Common Error Codes
- `MISSING_USER_ID` - userId parameter required
- `SUBSCRIPTION_EXPIRED` - User subscription has expired
- `PAYMENT_FAILED` - Payment processing failed
- `INVALID_REQUEST` - Invalid request parameters
- `SERVICE_UNAVAILABLE` - External service unavailable

---

## Rate Limiting

- Chat API: 10 requests per minute per user
- Payment APIs: 5 requests per minute per user

---

## Environment Variables

Required environment variables for API functionality:

```env
MISTRAL_API_KEY=your_mistral_key
CRYPTOCLOUD_API_KEY=your_cryptocloud_key
CRYPTOCLOUD_SHOP_ID=your_shop_id
CLOUDPAYMENTS_PUBLIC_ID=your_public_id
CLOUDPAYMENTS_API_SECRET=your_api_secret
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

# Test status endpoint
curl http://localhost:4000/api/status?userId=test123

# Test chat endpoint
curl -X POST http://localhost:4000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"userId":"test123","question":"What is Bitcoin?"}'
```

---

## Security Notes

1. **User Authentication:** Currently uses simple userId. Implement proper authentication in production.
2. **API Keys:** Never expose API keys in client-side code.
3. **Webhooks:** Verify webhook signatures from payment providers.
4. **Rate Limiting:** Implement rate limiting to prevent abuse.
5. **HTTPS:** Always use HTTPS in production.

---

## Future Improvements

- [ ] Implement JWT authentication
- [ ] Add request rate limiting middleware
- [ ] Add API versioning
- [ ] Add comprehensive error logging
- [ ] Add API documentation (Swagger/OpenAPI)

