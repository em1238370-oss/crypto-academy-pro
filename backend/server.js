import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Stripe from 'stripe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from parent directory (project root)
dotenv.config({ path: join(__dirname, '..', '.env') });

const app = express();
app.use(cors());
// Store raw body for NOWPayments webhook signature verification
app.use('/api/payments/nowpayments/callback', express.raw({ type: 'application/json' }));
app.use(express.json());

// Disable strict CSP headers that block inline scripts
app.use((req, res, next) => {
  // Remove CSP header if set by Express middleware
  res.removeHeader('Content-Security-Policy');
  // Set a more permissive CSP for development
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https: fonts.googleapis.com; font-src 'self' https: fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https: api.mistral.ai api.cryptocloud.plus;");
  next();
});

// Serve static files from parent directory (HTML, CSS, JS)
app.use(express.static(join(__dirname, '..')));

const mistralKey = process.env.MISTRAL_API_KEY;
const cryptocloudApiKey = process.env.CRYPTOCLOUD_API_KEY;
const cryptocloudShopId = process.env.CRYPTOCLOUD_SHOP_ID;
const cloudpaymentsPublicId = process.env.CLOUDPAYMENTS_PUBLIC_ID;
const cloudpaymentsApiSecret = process.env.CLOUDPAYMENTS_API_SECRET;
const coingateApiKey = process.env.COINGATE_API_KEY;
const coingateMode = process.env.COINGATE_MODE || 'live';
const coingateApiUrl = process.env.COINGATE_API_URL || 'https://api.coingate.com/v2';
const yookassaShopId = process.env.YOOKASSA_SHOP_ID;
const yookassaSecretKey = process.env.YOOKASSA_SECRET_KEY;
const nowpaymentsApiKey = process.env.NOWPAYMENTS_API_KEY;
const nowpaymentsIpnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
const stripeMode = process.env.STRIPE_MODE || 'test';
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey, { apiVersion: '2024-11-20.acacia' }) : null;
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
if (!coingateApiKey) {
 console.warn('⚠️  CoinGate is not fully configured. Card payments (European & American) will not work until COINGATE_API_KEY is set.');
}
if (!yookassaShopId || !yookassaSecretKey) {
 console.warn('⚠️  YooKassa is not fully configured. Card payments (Russia-friendly) will not work until YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY are set.');
}
if (!nowpaymentsApiKey) {
 console.warn('⚠️  NOWPayments is not fully configured. Card payments (international, Russia-friendly) will not work until NOWPAYMENTS_API_KEY is set.');
}
if (!stripeSecretKey || !stripePublishableKey) {
 console.warn('⚠️  Stripe is not fully configured. Card payments (US & European cards) will not work until STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are set.');
}

// Simple in-memory store for demo purposes.
// Replace with a persistent database in production.
const users = new Map();
const invoices = new Map(); // orderId -> { userId, invoiceId }

const FREE_TRIAL_HOURS = parseInt(process.env.FREE_TRIAL_HOURS ?? '24', 10);

function ensureUser(userId) {
 if (!userId) return null;
 if (!users.has(userId)) {
   // If FREE_TRIAL_HOURS is 0, set trialStartedAt to past so trial is immediately expired
   const trialStartedAt = FREE_TRIAL_HOURS === 0 
     ? new Date(Date.now() - 24 * 60 * 60 * 1000) // Set to 24 hours ago
     : new Date();
   users.set(userId, {
     trialStartedAt: trialStartedAt,
     subscriptionActiveUntil: null
   });
 }
 return users.get(userId);
}

function hasActiveAccess(userId) {
 const user = ensureUser(userId);
 if (!user) return false;

 // If FREE_TRIAL_HOURS is 0, user has no access (trial immediately expired)
 if (FREE_TRIAL_HOURS === 0) {
   if (user.subscriptionActiveUntil) {
     const subscriptionActive = new Date() <= new Date(user.subscriptionActiveUntil);
     return subscriptionActive === true; // Only subscription can give access
   }
   return false; // No subscription, no access
 }

 const now = new Date();
 const trialEnd = new Date(user.trialStartedAt);
 trialEnd.setHours(trialEnd.getHours() + FREE_TRIAL_HOURS);

 const trialActive = now <= trialEnd;
 const subscriptionActive = user.subscriptionActiveUntil && new Date() <= new Date(user.subscriptionActiveUntil);

 return trialActive || subscriptionActive === true;
}

app.get('/api/status', (req, res) => {
 const { userId } = req.query;
 if (!userId) {
   return res.status(400).json({ error: 'userId is required' });
 }
 const user = ensureUser(userId);
 const now = new Date();
 
 // If FREE_TRIAL_HOURS is 0, set trialEnd to past to ensure it's expired
 let trialEnd;
 if (FREE_TRIAL_HOURS === 0) {
   trialEnd = new Date(now.getTime() - 1000); // 1 second ago
 } else {
   trialEnd = new Date(user.trialStartedAt);
   trialEnd.setHours(trialEnd.getHours() + FREE_TRIAL_HOURS);
 }

 const hasAccess = hasActiveAccess(userId);
 
 res.json({
   userId,
   freeTrialEndsAt: trialEnd,
   subscriptionActiveUntil: user.subscriptionActiveUntil,
   hasAccess: hasAccess === true // Ensure boolean, not null/undefined
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

// CoinGate invoice creation endpoint (for European & American cards)
app.post('/api/payments/coingate/invoice', async (req, res) => {
 const { userId, amount, description } = req.body;

 if (!userId) {
   return res.status(400).json({ error: 'userId is required' });
 }

 if (!coingateApiKey) {
   return res.status(500).json({ error: 'coingate_not_configured' });
 }

 const orderId = `order_${userId}_${Date.now()}`;
 const invoiceAmount = amount ? parseFloat(amount) : subscriptionPriceUsd;
 const callbackUrl = `${appBaseUrl.replace(/\/$/, '')}/api/payments/coingate/callback`;
 const successUrl = `${appBaseUrl.replace(/\/$/, '')}/payment-success`;
 const cancelUrl = `${appBaseUrl.replace(/\/$/, '')}/payment-cancel`;

 // CoinGate API v2 format
 const payload = {
   order_id: orderId,
   price_amount: invoiceAmount.toFixed(2),
   price_currency: 'USD',
   receive_currency: 'USD', // Accept USD (cards will be converted)
   title: description || `Subscription - $${invoiceAmount.toFixed(2)}`,
   description: description || `Payment for subscription - $${invoiceAmount.toFixed(2)}`,
   callback_url: callbackUrl,
   success_url: successUrl,
   cancel_url: cancelUrl,
   token: orderId
 };

 console.log('Creating CoinGate invoice with payload:', { ...payload, order_id: orderId });

 try {
   const apiUrl = coingateMode === 'sandbox' 
     ? 'https://api-sandbox.coingate.com/v2/orders'
     : `${coingateApiUrl}/orders`;

   const response = await axios.post(apiUrl, payload, {
     headers: {
       'Content-Type': 'application/json',
       'Authorization': `Token ${coingateApiKey}`
     },
     timeout: 10000
   });

   console.log('✅ CoinGate invoice created successfully');
   console.log('CoinGate response status:', response.status);
   console.log('CoinGate response data:', JSON.stringify(response.data, null, 2));

   const invoiceData = response.data;

   if (!invoiceData || !invoiceData.id) {
     throw new Error(invoiceData?.message || 'Failed to create invoice');
   }

   invoices.set(orderId, {
     userId,
     invoiceId: invoiceData.id.toString(),
     paymentMethod: 'coingate'
   });

   res.json({
     orderId,
     amount: invoiceAmount.toFixed(2),
     currency: 'USD',
     invoiceId: invoiceData.id.toString(),
     paymentUrl: invoiceData.payment_url || invoiceData.url || null
   });
 } catch (error) {
   const errorDetails = error.response?.data ?? error.message;
   const errorStatus = error.response?.status;
   console.error('❌ CoinGate invoice error:', errorDetails);
   console.error('Error status:', errorStatus);
   console.error('Full error:', error);

   let userMessage = 'Failed to create invoice. Please try again later.';

   if (errorDetails?.message) {
     userMessage = errorDetails.message;
   } else if (errorDetails?.error) {
     userMessage = errorDetails.error;
   } else if (typeof errorDetails === 'string') {
     userMessage = errorDetails;
   }

  if (errorStatus === 401 || errorStatus === 403) {
    userMessage = 'Authentication failed. Please check your CoinGate API key.';
    console.error('⚠️  CoinGate API authentication failed. Possible issues:');
    console.error('   1. API key is invalid or expired');
    console.error('   2. API key is for sandbox but using live mode (or vice versa)');
    console.error('   3. API key needs to be regenerated in CoinGate dashboard');
    console.error('   4. Check if API key has correct permissions');
    console.error(`   Current mode: ${coingateMode}`);
    console.error(`   API URL: ${apiUrl}`);
  }

   res.status(500).json({
     error: 'coingate_invoice_failed',
     details: typeof errorDetails === 'object' ? errorDetails : { message: errorDetails },
     status: errorStatus,
     message: userMessage
   });
 }
});

// CoinGate callback endpoint
app.post('/api/payments/coingate/callback', express.json(), (req, res) => {
 if (!coingateApiKey) {
   return res.status(500).json({ error: 'coingate_not_configured' });
 }

 const { id, status, order_id, price_amount, price_currency } = req.body;
 console.log('CoinGate callback received:', { id, status, order_id, price_amount, price_currency });

 if (!order_id) {
   return res.status(400).json({ error: 'order_id is required' });
 }

 const invoice = invoices.get(order_id);
 if (!invoice) {
   console.warn('Invoice not found for order_id:', order_id);
   return res.status(404).json({ error: 'invoice_not_found' });
 }

 // CoinGate status: 'paid', 'pending', 'invalid', 'expired', 'canceled', 'refunded'
 if (status === 'paid') {
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

// YooKassa invoice creation endpoint (for Russian-friendly card payments)
app.post('/api/payments/yookassa/invoice', async (req, res) => {
 const { userId, amount, description } = req.body;

 if (!userId) {
   return res.status(400).json({ error: 'userId is required' });
 }

 if (!yookassaShopId || !yookassaSecretKey) {
   return res.status(500).json({ 
     error: 'yookassa_not_configured',
     message: 'YooKassa is not configured. Please contact support.'
   });
 }

 const orderId = `order_${userId}_${Date.now()}`;
 const invoiceAmount = amount ? parseFloat(amount) : subscriptionPriceUsd;
 const callbackUrl = `${appBaseUrl.replace(/\/$/, '')}/api/payments/yookassa/callback`;
 const returnUrl = `${appBaseUrl.replace(/\/$/, '')}/payment-success`;

 // YooKassa API format
 const payload = {
   amount: {
     value: invoiceAmount.toFixed(2),
     currency: 'USD'
   },
   confirmation: {
     type: 'redirect',
     return_url: returnUrl
   },
   capture: true,
   description: description || `Subscription - $${invoiceAmount.toFixed(2)}`,
   metadata: {
     order_id: orderId,
     user_id: userId
   }
 };

 console.log('Creating YooKassa payment with payload:', { ...payload, order_id: orderId });

 try {
   const apiUrl = 'https://api.yookassa.ru/v3/payments';
   
   const authString = Buffer.from(`${yookassaShopId}:${yookassaSecretKey}`).toString('base64');
   
   const response = await axios.post(apiUrl, payload, {
     headers: {
       'Content-Type': 'application/json',
       'Authorization': `Basic ${authString}`,
       'Idempotence-Key': orderId
     },
     timeout: 10000
   });

   console.log('✅ YooKassa payment created successfully');
   console.log('YooKassa response status:', response.status);
   console.log('YooKassa response data:', JSON.stringify(response.data, null, 2));

   const paymentData = response.data;

   if (!paymentData || !paymentData.id) {
     throw new Error(paymentData?.description || 'Failed to create payment');
   }

   invoices.set(orderId, {
     userId,
     invoiceId: paymentData.id.toString(),
     paymentMethod: 'yookassa'
   });

   res.json({
     orderId,
     amount: invoiceAmount.toFixed(2),
     currency: 'USD',
     invoiceId: paymentData.id.toString(),
     paymentUrl: paymentData.confirmation?.confirmation_url || null
   });
 } catch (error) {
   const errorDetails = error.response?.data ?? error.message;
   const errorStatus = error.response?.status;
   console.error('❌ YooKassa payment error:', errorDetails);
   console.error('Error status:', errorStatus);
   console.error('Full error:', error);

   let userMessage = 'Failed to create payment. Please try again later.';

   if (errorDetails?.description) {
     userMessage = errorDetails.description;
   } else if (errorDetails?.message) {
     userMessage = errorDetails.message;
   } else if (errorDetails?.error) {
     userMessage = errorDetails.error;
   } else if (typeof errorDetails === 'string') {
     userMessage = errorDetails;
   }

   if (errorStatus === 401 || errorStatus === 403) {
     userMessage = 'Authentication failed. Please check your YooKassa credentials.';
     console.error('⚠️  YooKassa API authentication failed. Possible issues:');
     console.error('   1. Shop ID or Secret Key is invalid');
     console.error('   2. Check if credentials are correct in YooKassa dashboard');
   }

   res.status(500).json({
     error: 'yookassa_payment_failed',
     details: typeof errorDetails === 'object' ? errorDetails : { message: errorDetails },
     status: errorStatus,
     message: userMessage
   });
 }
});

// YooKassa callback endpoint
app.post('/api/payments/yookassa/callback', express.json(), (req, res) => {
 if (!yookassaSecretKey) {
   return res.status(500).json({ error: 'yookassa_not_configured' });
 }

 const { event, object } = req.body;
 console.log('YooKassa callback received:', { event, object });

 if (!object || !object.metadata || !object.metadata.order_id) {
   return res.status(400).json({ error: 'order_id is required' });
 }

 const orderId = object.metadata.order_id;
 const invoice = invoices.get(orderId);
 
 if (!invoice) {
   console.warn('Invoice not found for order_id:', orderId);
   return res.status(404).json({ error: 'invoice_not_found' });
 }

 // YooKassa event: 'payment.succeeded', 'payment.canceled', 'payment.waiting_for_capture'
 if (event === 'payment.succeeded' && object.status === 'succeeded') {
   const user = ensureUser(invoice.userId);
   if (user) {
     const now = new Date();
     const newEndDate = new Date(now.getTime() + subscriptionPeriodDays * 24 * 60 * 60 * 1000);
     user.subscriptionActiveUntil = newEndDate;
     console.log(`✅ Subscription activated for user ${invoice.userId} until ${newEndDate}`);
   }
   invoices.delete(orderId);
 }

 res.json({ ok: true });
});

// NOWPayments invoice creation endpoint (international brand, Russia-friendly, accepts cards + crypto)
app.post('/api/payments/nowpayments/invoice', async (req, res) => {
 const { userId, amount, description, paymentMethod } = req.body;

 if (!userId) {
   return res.status(400).json({ error: 'userId is required' });
 }

 if (!nowpaymentsApiKey) {
   return res.status(500).json({ 
     error: 'nowpayments_not_configured',
     message: 'NOWPayments is not configured. Please contact support.'
   });
 }

 const orderId = `order_${userId}_${Date.now()}`;
 const invoiceAmount = amount ? parseFloat(amount) : subscriptionPriceUsd;
 const callbackUrl = `${appBaseUrl.replace(/\/$/, '')}/api/payments/nowpayments/callback`;
 const successUrl = `${appBaseUrl.replace(/\/$/, '')}/payment-success`;
 const cancelUrl = `${appBaseUrl.replace(/\/$/, '')}/payment-cancel`;

 // NOWPayments API format
 // For card payments, NOWPayments automatically enables cards if account is verified
 // Cards (Visa, Mastercard) are available through their payment page
 // 
 // IMPORTANT: pay_currency handling based on NOWPayments API documentation:
 // - If omitted: user can choose any payment method (cards + crypto) - BEST OPTION
 // - If empty string "": may cause "pay_currency is required" error
 // - If specific currency (e.g., "usdt"): only that crypto currency
 // 
 // Strategy: Omit pay_currency completely to allow both cards and crypto
 const userPaymentMethod = paymentMethod || 'any'; // 'crypto', 'card', or 'any'
 
 const payload = {
   price_amount: invoiceAmount,
   price_currency: 'usd',
   order_id: orderId,
   order_description: description || `Subscription - $${invoiceAmount.toFixed(2)}`,
   ipn_callback_url: callbackUrl,
   success_url: successUrl,
   cancel_url: cancelUrl,
   is_fixed_rate: false,
   is_fee_paid_by_user: false
 };
 
 // IMPORTANT: pay_currency is REQUIRED by NOWPayments API
 // Strategy based on payment method:
 // - For 'card' or 'any': use 'usd' (same as price_currency) - allows card payments
 // - For 'crypto': use 'usdt' - but this may cause "Can not get estimate" error
 // 
 // If 'usdt' causes estimate error, user can still choose USDT on payment page
 // by switching from the default currency
 if (userPaymentMethod === 'crypto') {
   payload.pay_currency = 'usdt'; // Try USDT for crypto payments
 } else {
   // For cards: use 'usd' to allow direct card payment
   // User can still switch to crypto (USDT) on NOWPayments payment page
   payload.pay_currency = 'usd';
 }

 console.log('Creating NOWPayments invoice with payload:', { ...payload, order_id: orderId });
 console.log('Payment method requested:', userPaymentMethod);
 console.log('pay_currency set to:', payload.pay_currency);

 try {
   const apiUrl = 'https://api.nowpayments.io/v1/payment';
   
   const response = await axios.post(apiUrl, payload, {
     headers: {
       'Content-Type': 'application/json',
       'x-api-key': nowpaymentsApiKey
     },
     timeout: 10000
   });

   console.log('✅ NOWPayments invoice created successfully');
   console.log('NOWPayments response status:', response.status);
   console.log('NOWPayments response data:', JSON.stringify(response.data, null, 2));

   const paymentData = response.data;

   if (!paymentData || !paymentData.payment_id) {
     throw new Error(paymentData?.message || 'Failed to create payment');
   }

   invoices.set(orderId, {
     userId,
     invoiceId: paymentData.payment_id.toString(),
     paymentMethod: 'nowpayments'
   });

   res.json({
     orderId,
     amount: invoiceAmount.toFixed(2),
     currency: 'USD',
     invoiceId: paymentData.payment_id.toString(),
     paymentUrl: paymentData.pay_url || paymentData.invoice_url || null
   });
 } catch (error) {
   const errorDetails = error.response?.data ?? error.message;
   const errorStatus = error.response?.status;
   console.error('❌ NOWPayments invoice error:', errorDetails);
   console.error('Error status:', errorStatus);
   console.error('Full error:', error);

   let userMessage = 'Failed to create payment. Please try again later.';

   if (errorDetails?.message) {
     userMessage = errorDetails.message;
   } else if (errorDetails?.error) {
     userMessage = errorDetails.error;
   } else if (typeof errorDetails === 'string') {
     userMessage = errorDetails;
   }

   if (errorStatus === 401 || errorStatus === 403) {
     userMessage = 'Authentication failed. Please check your NOWPayments API key.';
     console.error('⚠️  NOWPayments API authentication failed. Possible issues:');
     console.error('   1. API key is invalid or expired');
     console.error('   2. Check if API key has correct permissions');
   }

   res.status(500).json({
     error: 'nowpayments_invoice_failed',
     details: typeof errorDetails === 'object' ? errorDetails : { message: errorDetails },
     status: errorStatus,
     message: userMessage
   });
 }
});

// NOWPayments callback endpoint
app.post('/api/payments/nowpayments/callback', express.raw({ type: 'application/json' }), (req, res) => {
 if (!nowpaymentsIpnSecret) {
   return res.status(500).json({ error: 'nowpayments_not_configured' });
 }

 // Verify IPN signature for security
 const signature = req.headers['x-nowpayments-sig'];
 const rawBody = req.body.toString();
 
 if (signature && nowpaymentsIpnSecret) {
   const expectedSignature = crypto
     .createHmac('sha512', nowpaymentsIpnSecret)
     .update(rawBody)
     .digest('hex');
   
   if (signature !== expectedSignature) {
     console.error('❌ NOWPayments IPN signature verification failed');
     return res.status(401).json({ error: 'invalid_signature' });
   }
 }

 // Parse JSON body
 let body;
 try {
   body = JSON.parse(rawBody);
 } catch (e) {
   console.error('Failed to parse NOWPayments callback body:', e);
   return res.status(400).json({ error: 'invalid_json' });
 }

 const { payment_id, payment_status, order_id } = body;
 console.log('NOWPayments callback received:', { payment_id, payment_status, order_id });

 if (!order_id) {
   return res.status(400).json({ error: 'order_id is required' });
 }

 const invoice = invoices.get(order_id);
 
 if (!invoice) {
   console.warn('Invoice not found for order_id:', order_id);
   return res.status(404).json({ error: 'invoice_not_found' });
 }

 // NOWPayments status: 'waiting', 'confirming', 'confirmed', 'sending', 'partially_paid', 'finished', 'failed', 'refunded', 'expired'
 if (payment_status === 'finished' || payment_status === 'confirmed') {
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

// Stripe payment endpoint (for US & European cards - international brand)
app.post('/api/payments/stripe/invoice', async (req, res) => {
 const { userId, amount, description } = req.body;

 if (!userId) {
   return res.status(400).json({ error: 'userId is required' });
 }

 if (!stripe || !stripeSecretKey) {
   return res.status(500).json({ 
     error: 'stripe_not_configured',
     message: 'Stripe is not configured. Please contact support.'
   });
 }

 const orderId = `order_${userId}_${Date.now()}`;
 const invoiceAmount = amount ? parseFloat(amount) : subscriptionPriceUsd;
 const successUrl = `${appBaseUrl.replace(/\/$/, '')}/payment-success?session_id={CHECKOUT_SESSION_ID}`;
 const cancelUrl = `${appBaseUrl.replace(/\/$/, '')}/payment-cancel`;

 try {
   const session = await stripe.checkout.sessions.create({
     payment_method_types: ['card'],
     line_items: [
       {
         price_data: {
           currency: 'usd',
           product_data: {
             name: description || 'Crypto Academy Pro Subscription',
             description: `Monthly subscription - $${invoiceAmount.toFixed(2)}`
           },
           unit_amount: Math.round(invoiceAmount * 100), // Stripe uses cents
         },
         quantity: 1,
       },
     ],
     mode: 'payment',
     success_url: successUrl,
     cancel_url: cancelUrl,
     client_reference_id: orderId,
     metadata: {
       userId: userId,
       orderId: orderId
     }
   });

   invoices.set(orderId, {
     userId,
     invoiceId: session.id,
     paymentMethod: 'stripe'
   });

   res.json({
     orderId,
     amount: invoiceAmount.toFixed(2),
     currency: 'USD',
     invoiceId: session.id,
     paymentUrl: session.url,
     publishableKey: stripePublishableKey
   });
 } catch (error) {
   console.error('❌ Stripe invoice error:', error);
   res.status(500).json({
     error: 'stripe_invoice_failed',
     details: error.message,
     message: 'Failed to create payment. Please try again later.'
   });
 }
});

// Stripe webhook endpoint (for payment confirmation)
app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
 if (!stripe || !stripeSecretKey) {
   return res.status(500).json({ error: 'stripe_not_configured' });
 }

 const sig = req.headers['stripe-signature'];
 let event;

 try {
   const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
   if (!webhookSecret) {
     console.warn('⚠️  STRIPE_WEBHOOK_SECRET is not set. Webhook verification will fail.');
     return res.status(400).json({ error: 'webhook_secret_not_configured' });
   }
   event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
 } catch (err) {
   console.error('❌ Stripe webhook signature verification failed:', err.message);
   return res.status(400).json({ error: 'webhook_signature_verification_failed' });
 }

 if (event.type === 'checkout.session.completed') {
   const session = event.data.object;
   const orderId = session.client_reference_id;
   const userId = session.metadata?.userId;

   if (orderId && userId) {
     const invoice = invoices.get(orderId);
     if (invoice) {
       const user = ensureUser(userId);
       if (user) {
         const now = new Date();
         const newEndDate = new Date(now.getTime() + subscriptionPeriodDays * 24 * 60 * 60 * 1000);
         user.subscriptionActiveUntil = newEndDate;
         console.log(`✅ Subscription activated for user ${userId} until ${newEndDate} via Stripe`);
       }
       invoices.delete(orderId);
     }
   }
 }

 res.json({ received: true });
});

app.use((err, req, res, next) => {
 if (err.type === 'entity.parse.failed') {
   return res.status(400).json({ error: 'invalid_json' });
 }
 console.error('Unhandled error:', err);
 res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 4000;

// Try to load SSL certificates for HTTPS
let httpsOptions = null;
const keyPath = join(__dirname, '..', 'key.pem');
const certPath = join(__dirname, '..', 'cert.pem');

try {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    console.log('✅ SSL certificates found, starting HTTPS server');
  }
} catch (error) {
  console.warn('⚠️  Could not load SSL certificates, starting HTTP server:', error.message);
}

// Start both HTTP and HTTPS servers
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ HTTP Backend listening on port ${PORT}`);
  console.log(`🌐 Access via: http://localhost:${PORT} or http://192.168.1.142:${PORT}`);
});

if (httpsOptions) {
  https.createServer(httpsOptions, app).listen(4443, '0.0.0.0', () => {
    console.log(`✅ HTTPS Backend listening on port 4443`);
    console.log(`🔒 Access via: https://localhost:4443 or https://192.168.1.142:4443`);
  });
}
