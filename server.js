import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Disable strict CSP headers that block inline scripts
app.use((req, res, next) => {
  // Remove CSP header if set by Express middleware
  res.removeHeader('Content-Security-Policy');
  // Set a more permissive CSP for development
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https: fonts.googleapis.com; font-src 'self' https: fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https: api.mistral.ai api.cryptocloud.plus;");
  next();
});

// Serve static files (HTML, CSS, JS)
app.use(express.static(__dirname));

const mistralKey = process.env.MISTRAL_API_KEY;
const cryptocloudApiKey = process.env.CRYPTOCLOUD_API_KEY;
const cryptocloudShopId = process.env.CRYPTOCLOUD_SHOP_ID;
const cloudpaymentsPublicId = process.env.CLOUDPAYMENTS_PUBLIC_ID;
const cloudpaymentsApiSecret = process.env.CLOUDPAYMENTS_API_SECRET;
const subscriptionPriceUsd = parseFloat(process.env.SUBSCRIPTION_PRICE_USD ?? '10');
const subscriptionPeriodDays = parseInt(process.env.SUBSCRIPTION_PERIOD_DAYS ?? '30', 10);
const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:4000';

if (!mistralKey) {
 console.warn('⚠️  MISTRAL_API_KEY is not set. AI responses will fail until it is provided.');
}
if (!cryptocloudApiKey || !cryptocloudShopId) {
 console.warn('⚠️  CryptoCloud is not fully configured. Crypto payments will not work until CRYPTOCLOUD_API_KEY and CRYPTOCLOUD_SHOP_ID are set.');
}
if (!cloudpaymentsPublicId || !cloudpaymentsApiSecret) {
 console.warn('⚠️  CloudPayments is not fully configured. Card payments will not work until CLOUDPAYMENTS_PUBLIC_ID and CLOUDPAYMENTS_API_SECRET are set.');
}

// Simple in-memory store for demo purposes.
// Replace with a persistent database in production.
const users = new Map();
const invoices = new Map(); // orderId -> { userId, invoiceId }

const FREE_TRIAL_HOURS = parseInt(process.env.FREE_TRIAL_HOURS ?? '24', 10);

function ensureUser(userId) {
 if (!userId) return null;
 if (!users.has(userId)) {
   users.set(userId, {
     trialStartedAt: new Date(),
     subscriptionActiveUntil: null
   });
 }
 return users.get(userId);
}

function hasActiveAccess(userId) {
 const user = ensureUser(userId);
 if (!user) return false;

 const now = new Date();
 const trialEnd = new Date(user.trialStartedAt);
 trialEnd.setHours(trialEnd.getHours() + FREE_TRIAL_HOURS);

 const trialActive = now <= trialEnd;
 const subscriptionActive = user.subscriptionActiveUntil && now <= new Date(user.subscriptionActiveUntil);

 return trialActive || subscriptionActive;
}

app.get('/api/status', (req, res) => {
 const { userId } = req.query;
 if (!userId) {
   return res.status(400).json({ error: 'userId is required' });
 }
 const user = ensureUser(userId);
 const now = new Date();
 const trialEnd = new Date(user.trialStartedAt);
 trialEnd.setHours(trialEnd.getHours() + FREE_TRIAL_HOURS);

 res.json({
   userId,
   freeTrialEndsAt: trialEnd,
   subscriptionActiveUntil: user.subscriptionActiveUntil,
   hasAccess: hasActiveAccess(userId)
 });
});

app.post('/api/chat', async (req, res) => {
 const { userId, question } = req.body;
 if (!userId || !question) {
   return res.status(400).json({ error: 'userId and question are required' });
 }

 if (!hasActiveAccess(userId)) {
   return res.status(402).json({ error: 'subscription_required' });
 }

 if (!mistralKey) {
   return res.status(500).json({ error: 'AI provider is not configured' });
 }

 const systemPrompt = `You are a friendly and knowledgeable cryptocurrency expert assistant.
Answer in Russian when the question is in Russian, otherwise reply in English.
Keep answers concise (2-4 sentences) unless additional detail is requested.
Stay neutral, avoid financial advice, and encourage responsible investing.`;

 try {
   const aiResponse = await axios.post(
     'https://api.mistral.ai/v1/chat/completions',
     {
       model: 'mistral-small-latest',
       messages: [
         { role: 'system', content: systemPrompt },
         { role: 'user', content: question }
       ],
       temperature: 0.7,
       max_tokens: 500
     },
     {
       headers: {
         'Content-Type': 'application/json',
         Authorization: `Bearer ${mistralKey}`
       }
     }
   );

   const answer = aiResponse.data?.choices?.[0]?.message?.content ?? 'Не удалось получить ответ от AI.';
   res.json({ answer });
 } catch (error) {
   console.error('AI request failed:', error?.response?.data ?? error.message);
   res.status(500).json({ error: 'ai_failed' });
 }
});

// CryptoCloud invoice creation endpoint (for crypto payments only)
app.post('/api/payments/cryptocloud/invoice', async (req, res) => {
 const { userId } = req.body;

 if (!userId) {
   return res.status(400).json({ error: 'userId is required' });
 }

 if (!cryptocloudApiKey || !cryptocloudShopId) {
   return res.status(500).json({ error: 'cryptocloud_not_configured' });
 }

 const orderId = `order_${userId}_${Date.now()}`;
 const callbackUrl = `${appBaseUrl.replace(/\/$/, '')}/api/payments/cryptocloud/callback`;

 // CryptoCloud API format - only for crypto payments
 const payload = {
   shop_id: cryptocloudShopId,
   amount: subscriptionPriceUsd.toFixed(2),
   currency: 'USD', // Fiat currency (USD for dollar amount)
   to_currency: 'USDT', // Crypto currency to receive (USDT on TRX network)
   order_id: orderId,
   url_return: `${appBaseUrl.replace(/\/$/, '')}/payment-success`,
   url_callback: callbackUrl,
   test_mode: false // Explicitly disable test mode (if supported by API)
 };

 console.log('Creating CryptoCloud invoice with payload:', { ...payload });
 console.log('Using API endpoint: https://api.cryptocloud.plus/v2/invoice/create');

 try {
   const response = await axios.post(
     'https://api.cryptocloud.plus/v2/invoice/create',
     payload,
     {
       headers: {
         'Content-Type': 'application/json',
         'Authorization': `Token ${cryptocloudApiKey}`
       },
       timeout: 10000
     }
   );
  
   console.log('✅ CryptoCloud invoice created successfully');
   console.log('CryptoCloud response status:', response.status);
   console.log('CryptoCloud response data:', JSON.stringify(response.data, null, 2));

   const invoiceData = response.data;
  
   // CryptoCloud v2 API returns: { status: "success", result: { link: "...", uuid: "...", ... } }
   if (!invoiceData || invoiceData.status !== 'success' || !invoiceData.result) {
     throw new Error(invoiceData?.result?.currency || invoiceData?.message || 'Failed to create invoice');
   }

   const result = invoiceData.result;

   invoices.set(orderId, {
     userId,
     invoiceId: result.uuid ?? result.invoice_id ?? null
   });

   res.json({
     orderId,
     amount: result.amount ?? subscriptionPriceUsd,
     currency: result.currency?.code ?? 'USDT',
     invoiceId: result.uuid ?? result.invoice_id,
     paymentUrl: result.link ?? null // CryptoCloud returns payment link in result.link
   });
 } catch (error) {
   const errorDetails = error.response?.data ?? error.message;
   const errorStatus = error.response?.status;
   console.error('❌ CryptoCloud invoice error:', errorDetails);
   console.error('Error status:', errorStatus);
   console.error('Full error:', error);
  
   let userMessage = 'Failed to create invoice. Please try again later.';
  
   // Extract error message from CryptoCloud response
   if (errorDetails?.message) {
     userMessage = errorDetails.message;
   } else if (errorDetails?.error) {
     userMessage = errorDetails.error;
   } else if (typeof errorDetails === 'string') {
     userMessage = errorDetails;
   }
  
   if (errorStatus === 401 || errorStatus === 403) {
     userMessage = 'Authentication failed. Please check your CryptoCloud API key.';
   }
  
   res.status(500).json({
     error: 'cryptocloud_invoice_failed',
     details: typeof errorDetails === 'object' ? errorDetails : { message: errorDetails },
     status: errorStatus,
     message: userMessage
   });
 }
});

// CryptoCloud callback endpoint
app.post('/api/payments/cryptocloud/callback', express.json(), (req, res) => {
 if (!cryptocloudApiKey || !cryptocloudShopId) {
   return res.status(500).json({ error: 'cryptocloud_not_configured' });
 }

 const { invoice_id, status, amount, currency, order_id } = req.body;
  console.log('CryptoCloud callback received:', { invoice_id, status, amount, currency, order_id });

 if (!order_id) {
   return res.status(400).json({ error: 'order_id is required' });
 }

 const invoice = invoices.get(order_id);
 if (!invoice) {
   console.warn('Invoice not found for order_id:', order_id);
   return res.status(404).json({ error: 'invoice_not_found' });
 }

 // If payment is successful, activate subscription
 if (status === 'paid' || status === 'success') {
   const user = ensureUser(invoice.userId);
   if (user) {
     const now = new Date();
     const newEndDate = new Date(now.getTime() + subscriptionPeriodDays * 24 * 60 * 60 * 1000);
     user.subscriptionActiveUntil = newEndDate;
     console.log(`✅ Subscription activated for user ${invoice.userId} until ${newEndDate}`);
   }
   invoices.delete(order_id);
 }

 res.json({ ok: true });
});

// CloudPayments invoice creation endpoint (for card payments)
app.post('/api/payments/cloudpayments/invoice', async (req, res) => {
 const { userId } = req.body;

 if (!userId) {
   return res.status(400).json({ error: 'userId is required' });
 }

 if (!cloudpaymentsPublicId || !cloudpaymentsApiSecret) {
   return res.status(503).json({
     error: 'cloudpayments_not_configured',
     message: 'Card payment is not available yet. Please use crypto payment.'
   });
 }

 const orderId = `order_${userId}_${Date.now()}`;
 const amount = subscriptionPriceUsd.toFixed(2);

 // CloudPayments uses payment link/widget approach
 // We'll return the public ID and order details for frontend to use
 invoices.set(orderId, {
   userId,
   invoiceId: orderId,
   paymentMethod: 'card'
 });

 res.json({
   orderId,
   amount,
   currency: 'USD',
   invoiceId: orderId,
   publicId: cloudpaymentsPublicId,
   paymentUrl: null // CloudPayments uses widget, not direct URL
 });
});

// CloudPayments callback endpoint
app.post('/api/payments/cloudpayments/callback', express.json(), (req, res) => {
 if (!cloudpaymentsApiSecret) {
   return res.status(500).json({ error: 'cloudpayments_not_configured' });
 }

 // Verify signature
 const body = JSON.stringify(req.body);
 const signature = req.headers['content-hmac'];
 const computedSignature = crypto
   .createHmac('sha256', cloudpaymentsApiSecret)
   .update(body)
   .digest('base64');

 if (signature !== computedSignature) {
   console.warn('⚠️  Invalid CloudPayments signature');
   return res.status(401).json({ error: 'invalid_signature' });
 }

 const { InvoiceId, Status, Amount, OrderId } = req.body;

 console.log('CloudPayments callback received:', { InvoiceId, Status, Amount, OrderId });

 if (!OrderId) {
   return res.status(400).json({ error: 'OrderId is required' });
 }

 const invoice = invoices.get(OrderId);
 if (!invoice) {
   console.warn('Invoice not found for OrderId:', OrderId);
   return res.status(404).json({ error: 'invoice_not_found' });
 }

 // If payment is successful, activate subscription
 if (Status === 'Completed' || Status === 'Authorized') {
   const user = ensureUser(invoice.userId);
   if (user) {
     const now = new Date();
     const newEndDate = new Date(now.getTime() + subscriptionPeriodDays * 24 * 60 * 60 * 1000);
     user.subscriptionActiveUntil = newEndDate;
     console.log(`✅ Subscription activated for user ${invoice.userId} until ${newEndDate}`);
   }
   invoices.delete(OrderId);
 }

 res.json({ code: 0 }); // CloudPayments expects { code: 0 } for success
});

app.use((err, req, res, next) => {
 if (err.type === 'entity.parse.failed') {
   return res.status(400).json({ error: 'invalid_json' });
 }
 console.error('Unhandled error:', err);
 res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
 console.log(`✅ Backend listening on port ${PORT}`);
});
