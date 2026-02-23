import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn, spawnSync } from 'child_process';
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
const newsApiKey = process.env.NEWS_API_KEY;
const theNewsApiKey = process.env.THENEWSAPI_KEY;

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
 // 
 // FINAL SOLUTION: Use correct currency codes based on payment method
 // - For CARDS: use 'usd' (same as price_currency) - allows direct card payment
 // - For CRYPTO: use 'usdttrc20' (USDT on Tron network) - most common and cheapest
 // 
 // NOWPayments requires specific blockchain codes:
 // - 'usdttrc20' for USDT on Tron (TRC20) - recommended
 // - 'usdterc20' for USDT on Ethereum (ERC20) - more expensive
 // - 'usdt' alone may not work
 if (userPaymentMethod === 'crypto') {
   // For crypto: use USDT on Tron network (TRC20)
   payload.pay_currency = 'usdttrc20';
 } else {
   // For cards: use 'usd' to allow direct card payment
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
             name: description || 'Prover Kriptu Subscription',
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

// --- Dynamic News (Regulation / Macro / Market + News heat) ---
const NEWS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache
const NEWS_FETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 min refresh — heat updates every 5 min
let articlesCache = null;
let articlesCacheTime = 0;

const FALLBACK_REGULATION = [
  'Watch major regulatory decisions (ETFs, licensing, bans) — they reshape liquidity and long-term risk, not just headlines.',
  'Key regulatory moves — ETF approvals, licensing, bans — affect liquidity and risk far beyond the headlines.',
  'Regulatory shifts (ETFs, licensing, bans) reshape liquidity and long-term risk. Headlines are just the surface.',
  'Major regulatory decisions — on ETFs, licensing, bans — drive liquidity and risk. Don\'t stop at the headline.',
  'ETF approvals, licensing, bans: regulatory moves that reshape liquidity and risk. Headlines only scratch the surface.',
  'Regulatory outcomes — ETF approvals, licensing, bans — determine liquidity dynamics and risk structure more than headlines.'
];
const FALLBACK_MACRO = [
  'Inflation prints, rates decisions, and dollar strength still drive risk appetite across all assets, including crypto.',
  'Fed decisions, inflation data, and dollar moves shape risk appetite for all assets — crypto included.',
  'Rates, inflation, and dollar strength drive risk appetite. Crypto follows the same macro forces.',
  'Macro prints — inflation, rates, dollar — still set risk appetite for crypto and all risk assets.',
  'Monetary policy, inflation releases, and FX dynamics govern risk appetite for crypto and traditional assets alike.',
  'FOMC outcomes, inflation prints, and dollar strength determine risk appetite for crypto and risk assets.'
];
const FALLBACK_MARKET = [
  'Funding, open interest, and liquidity in key pairs show whether news is truly backed by capital — or it\'s just narrative.',
  'Funding rates, open interest, and liquidity reveal if news is backed by real capital or just narrative.',
  'Check funding, open interest, and liquidity: they show whether news has capital behind it or is just noise.',
  'Funding, OI, and liquidity in major pairs separate news backed by capital from purely narrative-driven moves.',
  'Perpetual funding, aggregate open interest, and order-book liquidity indicate whether news has capital conviction.',
  'Derivatives funding, open interest, and spot liquidity reveal if news translates into real capital flows.'
];
function pickFallback(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function getRandomFallback() {
  return {
    regulation: { text: pickFallback(FALLBACK_REGULATION), url: null },
    macro: { text: pickFallback(FALLBACK_MACRO), url: null },
    market: { text: pickFallback(FALLBACK_MARKET), url: null },
    heat: ['calm', 'balanced', 'hot'][Math.floor(Math.random() * 3)]
  };
}

function categorizeArticle(title, desc) {
  const text = ((title || '') + ' ' + (desc || '')).toLowerCase();
  if (/\b(regulation|sec|etf|licensing|ban|approval|cftc|compliance|policy|legal|court|lawsuit|supervisory)\b/.test(text)) return 'regulation';
  if (/\b(inflation|rates|fed|fomc|dollar|macro|interest rate|gdp|cpi|employment|jobs|monetary)\b/.test(text)) return 'macro';
  if (/\b(funding|open interest|liquidity|volume|whale|exchange|derivatives|options|oi)\b/.test(text)) return 'market';
  return null;
}

function summarizeOne(article, maxLen = 200) {
  if (!article) return null;
  const title = (article.title || article.headline || '').trim();
  const desc = (article.description || article.snippet || article.summary || '').trim();
  let out = title || desc;
  if (!out) return null;
  if (out.length > maxLen) out = out.slice(0, maxLen - 3) + '…';
  return out;
}

// Use most recent article — reflects latest real news
function getLatestArticle(articles) {
  if (!articles || articles.length === 0) return null;
  return articles[0];
}

async function fetchNewsFromNewsApi() {
  if (!newsApiKey) return null;
  try {
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await axios.get(
      `https://newsapi.org/v2/everything?q=crypto OR bitcoin OR ethereum&from=${from}&sortBy=publishedAt&pageSize=50&language=en&apiKey=${newsApiKey}`,
      { timeout: 8000 }
    );
    return res.data?.articles || [];
  } catch (e) {
    console.warn('NewsAPI fetch failed:', e?.response?.status || e.message);
    return null;
  }
}

async function fetchNewsFromTheNewsApi() {
  if (!theNewsApiKey) return null;
  try {
    const res = await axios.get(
      `https://api.thenewsapi.net/crypto?apikey=${theNewsApiKey}&q=bitcoin OR ethereum OR crypto&langs=en&size=50`,
      { timeout: 8000 }
    );
    const results = res.data?.data?.results || res.data?.results || [];
    if (Array.isArray(results)) {
      return results.map(r => ({
        title: r.title || r.headline,
        description: r.description || r.summary || r.snippet,
        url: r.url,
        publishedAt: r.published_at || r.publishedAt || r.published
      }));
    }
    return null;
  } catch (e) {
    console.warn('TheNewsAPI fetch failed:', e?.response?.status || e.message);
    return null;
  }
}

async function refreshNewsCache() {
  let articles = await fetchNewsFromNewsApi();
  if (!articles || articles.length === 0) articles = await fetchNewsFromTheNewsApi();
  if (!articles || articles.length === 0) {
    if (articlesCache) return; // keep stale articles
    articlesCache = null;
    return;
  }
  // Sort by publishedAt descending (newest first)
  articles.sort((a, b) => {
    const ta = new Date(a.publishedAt || a.published_at || a.published || 0).getTime();
    const tb = new Date(b.publishedAt || b.published_at || b.published || 0).getTime();
    return tb - ta;
  });
  articlesCache = articles;
  articlesCacheTime = Date.now();
}

function buildDynamicResponse() {
  if (!articlesCache || articlesCache.length === 0) {
    return getRandomFallback();
  }
  // Articles are sorted by publishedAt (newest first)
  const reg = articlesCache.filter(a => categorizeArticle(a.title, a.description) === 'regulation');
  const macro = articlesCache.filter(a => categorizeArticle(a.title, a.description) === 'macro');
  const market = articlesCache.filter(a => categorizeArticle(a.title, a.description) === 'market');
  const total = articlesCache.length;
  const now = Date.now();
  const recentCount = articlesCache.filter(a => {
    const pub = a.publishedAt || a.published_at || a.published;
    if (!pub) return true;
    const t = new Date(pub).getTime();
    return now - t < 6 * 60 * 60 * 1000; // last 6 hours
  }).length;
  const veryRecentCount = articlesCache.filter(a => {
    const pub = a.publishedAt || a.published_at || a.published;
    if (!pub) return true;
    const t = new Date(pub).getTime();
    return now - t < 2 * 60 * 60 * 1000; // last 2 hours
  }).length;
  // News heat updates every 5 min — reacts quickly to news flow
  let heat = 'balanced';
  if (total >= 18 || recentCount >= 10 || veryRecentCount >= 3) heat = 'hot';
  else if (total <= 6 || recentCount <= 2 || veryRecentCount === 0) heat = 'calm';
  const defReg = pickFallback(FALLBACK_REGULATION);
  const defMacro = pickFallback(FALLBACK_MACRO);
  const defMarket = pickFallback(FALLBACK_MARKET);
  // Use most recent article per category — reflects latest real news
  const regArt = getLatestArticle(reg);
  const macroArt = getLatestArticle(macro);
  const marketArt = getLatestArticle(market);
  return {
    regulation: { text: summarizeOne(regArt) || defReg, url: regArt?.url || null },
    macro: { text: summarizeOne(macroArt) || defMacro, url: macroArt?.url || null },
    market: { text: summarizeOne(marketArt) || defMarket, url: marketArt?.url || null },
    heat
  };
}

app.get('/api/news/dynamic', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  try {
    if (!articlesCache || Date.now() - articlesCacheTime > NEWS_CACHE_TTL_MS) {
      await refreshNewsCache();
    }
    const data = buildDynamicResponse();
    res.json(data);
  } catch (e) {
    console.error('News dynamic error:', e);
    res.status(500).json(getRandomFallback());
  }
});

// Start periodic news refresh (every 5 min — heat reacts quickly)
if (newsApiKey || theNewsApiKey) {
  refreshNewsCache().then(() => console.log('✅ News cache initialized'));
  setInterval(refreshNewsCache, NEWS_FETCH_INTERVAL_MS);
} else {
  console.warn('⚠️ NEWS_API_KEY and THENEWSAPI_KEY not set. Dynamic news will use static fallback.');
}

// --- KRO Live Counter (Google Sheets) ---
const kroSheetId = process.env.KRO_SHEET_ID;
const kroCredentialsJson = process.env.KRO_GOOGLE_CREDENTIALS_JSON;
const kroCredentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const kroScamBaseRange = process.env.KRO_SCAM_BASE_RANGE || '';
const kroCheckQueueRange = process.env.KRO_CHECK_QUEUE_RANGE || '';

function getTodayMSK() {
  const d = new Date();
  const msk = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const day = String(msk.getDate()).padStart(2, '0');
  const month = String(msk.getMonth() + 1).padStart(2, '0');
  const year = msk.getFullYear();
  return { day, month, year, dateKey: `${day}.${month}.${year}`, dateShort: `${day}.${month}` };
}

async function getKroSheetsClient() {
  if (!kroSheetId) return null;
  let credentials;
  if (kroCredentialsJson) {
    try {
      credentials = JSON.parse(kroCredentialsJson);
    } catch (e) {
      console.warn('KRO: invalid KRO_GOOGLE_CREDENTIALS_JSON');
      return null;
    }
  } else if (kroCredentialsPath && fs.existsSync(kroCredentialsPath)) {
    credentials = JSON.parse(fs.readFileSync(kroCredentialsPath, 'utf8'));
  } else {
    return null;
  }
  try {
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    return { sheets };
  } catch (e) {
    console.warn('KRO Sheets init failed:', e.message);
    return null;
  }
}

const KRO_EMPTY = {
  channelsToday: 47,
  totalLost: 12847300,
  telegramCount: 37,
  coursesCount: 10,
  top3: [
    { channel: '@TONPumpElite', sum: 2100000, status: 'Удалён' },
    { channel: 'BTC Курс миллионера', sum: 847000, status: 'Активен' },
    { channel: 'crypto-fast.pro', sum: 673000, status: 'Блок' }
  ]
};

function parseSheetRow(row, headerIndex) {
  const dateVal = (row[0] || '').toString().trim();
  const channel = (row[1] || '').toString().trim();
  const sumRaw = (row[2] ?? '').toString().replace(/\s/g, '');
  const sum = parseInt(sumRaw, 10) || 0;
  const type = (row[3] || '').toString().trim();
  const status = (row[4] || '').toString().trim();
  const from = (row[5] || '').toString().trim();
  return { dateVal, channel, sum, type, status, from };
}

function isRowToday(dateVal, today) {
  if (!dateVal) return false;
  const s = dateVal.replace(/\s/g, '');
  return s === today.dateKey || s === today.dateShort || s.startsWith(today.dateShort + '.') || s.endsWith(today.dateShort);
}

const VERDICT_PHRASES = { scam: 'живут на VIP-подписках', grey: 'серая зона', safe: 'низкий риск' };

const BOTS_NO_DATA_PHRASE = 'боты: нет данных (доступ к комментариям канала через API отсутствует)';

function buildReasonsFromRow(row) {
  const reasons = [];
  if (row.ads_per_week != null) reasons.push(`реклама (${row.ads_per_week} постов/нед)`);
  reasons.push(row.bot_pct && row.bot_pct !== '—' ? `боты (${row.bot_pct})` : BOTS_NO_DATA_PHRASE);
  if (row.vip_price && row.vip_price !== '—') reasons.push(`VIP (${row.vip_price})`);
  return reasons.length ? reasons : ['нет данных'];
}

function parseScamBaseRow(row) {
  const username = (row[0] || '').toString().trim();
  const riskScoreRaw = (row[1] ?? '').toString().replace(/\s/g, '');
  const risk_score = parseInt(riskScoreRaw, 10);
  const adsPerWeekRaw = (row[2] ?? '').toString().replace(/\s/g, '');
  const ads_per_week = parseInt(adsPerWeekRaw, 10);
  const bot_pct = (row[3] ?? '').toString().trim();
  const vip_price = (row[4] ?? '').toString().trim();
  const complaintsRaw = (row[5] ?? '').toString().replace(/\s/g, '');
  const complaints = parseInt(complaintsRaw, 10);
  const total_loss = (row[6] ?? '').toString().trim();
  const verdict = (row[7] ?? '').toString().trim();
  return { username, risk_score: Number.isFinite(risk_score) ? risk_score : null, ads_per_week: Number.isFinite(ads_per_week) ? ads_per_week : null, bot_pct, vip_price, complaints: Number.isFinite(complaints) ? complaints : null, total_loss, verdict };
}

function normalizeChannel(channel) {
  const s = (channel || '').toString().trim().replace(/\s/g, '');
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower.startsWith('https://t.me/') || lower.startsWith('http://t.me/')) {
    const path = s.replace(/^https?:\/\/t\.me\//i, '').trim();
    if (path.startsWith('+')) return 't.me/' + path;
    return path ? (path.startsWith('@') ? path : '@' + path) : '';
  }
  if (lower.startsWith('t.me/')) {
    const path = s.replace(/^t\.me\//i, '').trim();
    if (path.startsWith('+')) return 't.me/' + path;
    return path ? (path.startsWith('@') ? path : '@' + path) : '';
  }
  return s.startsWith('@') ? s : '@' + s;
}

/** URL публичной страницы t.me для канала (без входа в Telegram можно получить title/description). */
function channelToTmeUrl(channel) {
  const n = normalizeChannel(channel);
  if (!n) return null;
  if (n.startsWith('t.me/')) return 'https://t.me/' + n.slice(6);
  const name = n.startsWith('@') ? n.slice(1) : n;
  return 'https://t.me/' + name;
}

/** Загрузить HTML страницы t.me и вытащить og:title и og:description (без логина). */
async function fetchTmePreview(channel) {
  const url = channelToTmeUrl(channel);
  if (!url) return null;
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0' },
      validateStatus: (s) => s >= 200 && s < 400
    });
    const html = response.data && typeof response.data === 'string' ? response.data : '';
    let title = null;
    let description = null;
    const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/) || html.match(/<meta\s+content="([^"]*)"\s+property="og:title"/);
    const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/) || html.match(/<meta\s+content="([^"]*)"\s+property="og:description"/);
    if (ogTitle) title = ogTitle[1].replace(/&quot;/g, '"').trim();
    if (ogDesc) description = ogDesc[1].replace(/&quot;/g, '"').trim();
    if (!title && html.includes('<title>')) {
      const titleTag = html.match(/<title>([^<]*)<\/title>/);
      if (titleTag) title = titleTag[1].replace(/&quot;/g, '"').trim();
    }
    if (title || description) return { title: title || null, description: description || null };
    return null;
  } catch (e) {
    return null;
  }
}

/** Canonical form for matching report row channel to requested channel (@name vs t.me/name). */
function channelMatchKey(channel) {
  const s = (channel || '').toString().trim().toLowerCase().replace(/\s/g, '');
  if (!s) return '';
  if (s.startsWith('t.me/+')) return s;
  if (s.startsWith('t.me/')) return s.slice(6);
  return s.startsWith('@') ? s.slice(1) : s;
}

/** Get complaints count and total_loss from reports sheet (first sheet A2:F, B=channel, C=sum). */
async function getComplaintsAndLossForChannel(client, channel) {
  if (!client || !kroSheetId) return { complaints: null, total_loss: null };
  try {
    const response = await client.sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: 'A2:F'
    });
    const rows = response.data.values || [];
    const key = channelMatchKey(channel);
    if (!key) return { complaints: null, total_loss: null };
    let complaints = 0;
    let totalSum = 0;
    for (let i = 0; i < rows.length; i++) {
      const rowChannel = (rows[i][1] || '').toString().trim();
      const rowKey = channelMatchKey(rowChannel);
      if (!rowKey || rowKey !== key) continue;
      complaints += 1;
      const sumRaw = (rows[i][2] ?? '').toString().replace(/\s/g, '');
      totalSum += parseInt(sumRaw, 10) || 0;
    }
    if (complaints === 0) return { complaints: null, total_loss: null };
    const total_loss = totalSum >= 1000000
      ? (totalSum / 1000000).toFixed(1).replace(/\.0$/, '') + 'млн₽'
      : totalSum >= 1000
        ? (totalSum / 1000).toFixed(0) + 'к₽'
        : totalSum + '₽';
    return { complaints, total_loss };
  } catch (e) {
    return { complaints: null, total_loss: null };
  }
}

app.get('/api/kro/check', async (req, res) => {
  const raw = (req.query.channel ?? '').toString().trim();
  const channel = normalizeChannel(raw);
  if (!channel) {
    return res.status(400).json({ error: 'channel query is required', found: false });
  }
  const periodRaw = (req.query.period ?? '30').toString().trim();
  const period = ['30', '180', '365'].includes(periodRaw) ? periodRaw : '30';
  const noConfigMessage = 'Не настроена база каналов (KRO_SHEET_ID или Google credentials). Добавьте настройки в .env.';
  if (!kroScamBaseRange || !kroSheetId) {
    return res.json({ found: false, channel, message: noConfigMessage });
  }
  try {
    const client = await getKroSheetsClient();
    if (!client) {
      return res.json({ found: false, channel, message: noConfigMessage });
    }
    let rows;
    try {
      const response = await client.sheets.spreadsheets.values.get({
        spreadsheetId: kroSheetId,
        range: kroScamBaseRange
      });
      rows = response.data.values || [];
    } catch (sheetErr) {
      console.error('KRO check: Google Sheets read error', sheetErr.message);
      return res.json({
        found: false,
        channel,
        message: 'Не удалось прочитать базу каналов. Проверьте в Render переменные KRO_SHEET_ID и KRO_SCAM_BASE_RANGE (имя листа должно совпадать с таблицей, например scam_base!A2:H).'
      });
    }

    const scriptPath = join(__dirname, 'kro-worker', 'check_once.py');
    const hasPython = (process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && fs.existsSync(scriptPath));
    const CHECK_ONCE_TIMEOUT_MS = 120000;

    function runCheckOnceAsync() {
      return new Promise((resolve) => {
        if (!hasPython) {
          resolve({ error: 'На сервере не настроены TELEGRAM_API_ID/Telethon — живая проверка недоступна.' });
          return;
        }
        const child = spawn('python3', [scriptPath, channel, period], {
          cwd: join(__dirname, 'kro-worker'),
          encoding: 'utf8',
          env: { ...process.env }
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        child.stderr?.on('data', (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          resolve({ error: 'Проверка по Telegram заняла больше 2 минут. Данные с t.me выше; полный разбор — после настройки воркера или повторите позже.', timeout: true });
        }, CHECK_ONCE_TIMEOUT_MS);
        child.on('close', (code) => {
          clearTimeout(timer);
          const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
          if (line) {
            try {
              const parsed = JSON.parse(line);
              if (parsed && parsed.found === true && (parsed.risk_score != null || parsed.verdict)) {
                resolve({ found: true, parsed });
                return;
              }
              if (parsed && parsed.found === false && parsed.not_crypto) {
                resolve({ not_crypto: true, message: parsed.error || 'Мы проверяем только каналы, связанные с криптой. Другие не проверяем.' });
                return;
              }
              if (parsed && parsed.found === false && parsed.error) resolve({ error: parsed.error });
              else resolve({ error: stderr || 'Ошибка ответа скрипта' });
            } catch (e) {
              resolve({ error: stderr || 'Ошибка ответа скрипта' });
            }
          } else resolve({ error: stderr || (code !== 0 ? 'Скрипт завершился с ошибкой' : null) });
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({ error: err.message || 'Запуск проверки не удался' });
        });
      });
    }

    const [tmePreview, checkOnceResult] = await Promise.all([
      fetchTmePreview(channel).catch(() => null),
      runCheckOnceAsync()
    ]);

    if (checkOnceResult?.found === true && checkOnceResult.parsed) {
      let complaints = checkOnceResult.parsed.complaints;
      let total_loss = checkOnceResult.parsed.total_loss;
      const empty = (v) => v == null || v === '' || (typeof v === 'string' && v.trim() === '—');
      if (empty(complaints) || empty(total_loss)) {
        const report = await getComplaintsAndLossForChannel(client, channel);
        if (report.complaints != null) complaints = report.complaints;
        if (report.total_loss != null) total_loss = report.total_loss;
      }
      const p = checkOnceResult.parsed;
      return res.json({
        found: true,
        username: p.username,
        risk_score: p.risk_score,
        ads_per_week: p.ads_per_week,
        bot_pct: p.bot_pct,
        vip_price: p.vip_price,
        complaints,
        total_loss,
        verdict: p.verdict,
        verdict_phrase: p.verdict_phrase || VERDICT_PHRASES[p.verdict] || p.verdict,
        reasons: p.reasons || buildReasonsFromRow(p),
        risk_pct: p.risk_pct,
        period_days: p.period_days != null ? p.period_days : 30,
        tme_preview: tmePreview || undefined,
        messages_analyzed: p.messages_analyzed ?? undefined,
        replies_count: p.replies_count ?? undefined,
        risk_explanation: p.risk_explanation || undefined
      });
    }
    if (checkOnceResult?.not_crypto) {
      return res.json({
        found: false,
        not_crypto: true,
        channel,
        message: checkOnceResult.message || 'Мы проверяем только каналы, связанные с криптой/скрипторием. Другие не проверяем.'
      });
    }

    const checkOnceError = checkOnceResult?.error || null;

    // По таблице — только если живая проверка не дала результата (нет Python или ошибка)
    const channelLower = channel.toLowerCase();
    for (let i = 0; i < rows.length; i++) {
      const rawRow = rows[i];
      if (!rawRow || !Array.isArray(rawRow)) continue;
      const row = parseScamBaseRow(rawRow);
      const rowChannel = (row.username || '').toLowerCase();
      if (rowChannel === channelLower || rowChannel === channelLower.slice(1)) {
        let complaints = row.complaints;
        let total_loss = row.total_loss;
        const empty = (v) => v == null || v === '' || (typeof v === 'string' && v.trim() === '—');
        if (empty(complaints) || empty(total_loss)) {
          const report = await getComplaintsAndLossForChannel(client, channel);
          if (report.complaints != null) complaints = report.complaints;
          if (report.total_loss != null) total_loss = report.total_loss;
        }
        const verdict_phrase = (row.verdict && row.verdict.trim()) ? (VERDICT_PHRASES[row.verdict] || row.verdict) : 'Вердикт не определён (в базе не заполнен). Запустите проверку по Telegram или заполните столбец в таблице.';
        const reasons = buildReasonsFromRow(row);
        const tmePreview = await fetchTmePreview(channel).catch(() => null);
        const risk_explanation = 'Оценка из базы проверенных каналов. Значение было загружено при предыдущей проверке по Telegram или внесено вручную в таблицу.';
        const loss_explanation = (complaints == null && (total_loss == null || String(total_loss).trim() === '' || String(total_loss).trim() === '—')) ? 'По этому каналу жалоб в форме «Сообщить о разводе» пока не поступало.' : undefined;
        return res.json({
          found: true,
          username: row.username,
          risk_score: row.risk_score,
          ads_per_week: row.ads_per_week,
          bot_pct: row.bot_pct,
          vip_price: row.vip_price,
          complaints,
          total_loss,
          verdict: row.verdict,
          verdict_phrase,
          reasons,
          period_days: parseInt(period, 10) || 30,
          tme_preview: tmePreview || undefined,
          risk_explanation,
          loss_explanation
        });
      }
    }

    let addedToQueue = false;
    if (kroCheckQueueRange && client) {
      try {
        await client.sheets.spreadsheets.values.append({
          spreadsheetId: kroSheetId,
          range: kroCheckQueueRange,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [[channel, new Date().toISOString()]] }
        });
        addedToQueue = true;
      } catch (e) {
        console.error('KRO check queue append error:', e);
      }
    }
    const needLogin = checkOnceError && (checkOnceError.includes('kro-login') || checkOnceError.includes('войдите в Telegram'));
    let complaintsFromReports = null;
    let totalLossFromReports = null;
    if (client && (tmePreview || needLogin)) {
      const report = await getComplaintsAndLossForChannel(client, channel);
      complaintsFromReports = report.complaints;
      totalLossFromReports = report.total_loss;
    }
    const finalMessage = tmePreview
      ? (tmePreview.title ? `Канал: ${tmePreview.title}.` : '') +
        (tmePreview.description ? ` ${tmePreview.description.slice(0, 200)}${tmePreview.description.length > 200 ? '…' : ''}.` : '') +
        (complaintsFromReports != null && complaintsFromReports > 0 ? ` По жалобам: ${complaintsFromReports}, потери: ${totalLossFromReports || '—'}.` : '') +
        (checkOnceError && checkOnceError.includes('Таймаут') ? ' Проверка по Telegram заняла больше 25 сек.' : '') +
        ' Оценка риска по сообщениям — после настройки входа в Telegram.'
      : checkOnceError
        ? (needLogin
            ? 'Чтобы по ссылке сразу получать результат, один раз войди в Telegram (команда ниже).'
            : `Канал не найден в базе. ${checkOnceError}`)
        : 'Канал не найден в базе. Не удалось загрузить данные с t.me — проверьте ссылку или попробуйте позже.';
    return res.json({
      found: false,
      pending: addedToQueue || (!!kroCheckQueueRange && !!client),
      channel,
      message: finalMessage,
      error_detail: checkOnceError || undefined,
      needLogin: needLogin || undefined,
      tme_preview: tmePreview || undefined,
      complaints: complaintsFromReports ?? undefined,
      total_loss: totalLossFromReports ?? undefined
    });
  } catch (e) {
    console.error('KRO check error:', e);
    const errMsg = (e && e.message) ? e.message : String(e);
    return res.json({
      found: false,
      channel,
      message: 'Ошибка при проверке канала: ' + (errMsg.length > 120 ? errMsg.slice(0, 120) + '…' : errMsg) + '. Проверьте в Render переменные KRO_* и логи сервиса.'
    });
  }
});

app.get('/api/kro/check-exchanger', async (req, res) => {
  const url = (req.query.url ?? '').toString().trim();
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return res.status(400).json({ error: 'url query required (http/https)', found: false });
  }
  const kroExchangerRange = process.env.KRO_EXCHANGER_BASE_RANGE || '';
  if (!kroExchangerRange || !kroSheetId) {
    return res.json({
      found: false,
      url,
      message: 'Обменник в базе не найден. Отправьте жалобу через форму ниже — добавим в отчёт.'
    });
  }
  try {
    const client = await getKroSheetsClient();
    if (!client) {
      return res.json({ found: false, url, message: 'Обменник в базе не найден.' });
    }
    const response = await client.sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: kroExchangerRange
    });
    const rows = response.data.values || [];
    const urlLower = url.toLowerCase();
    for (let i = 0; i < rows.length; i++) {
      const rowUrl = (rows[i][0] || '').toString().trim().toLowerCase();
      const rowName = (rows[i][1] || '').toString().trim();
      if (rowUrl && (urlLower.includes(rowUrl) || rowUrl.includes(urlLower))) {
        const risk = parseInt((rows[i][2] || '').toString(), 10);
        const totalLoss = (rows[i][3] || '').toString().trim();
        const verdict = (rows[i][4] || '').toString().trim();
        return res.json({
          found: true,
          url: rowUrl,
          name: rowName,
          risk_score: Number.isFinite(risk) ? risk : null,
          total_loss: totalLoss,
          verdict: verdict
        });
      }
    }
    return res.json({
      found: false,
      url,
      message: 'Обменник в базе не найден. Отправьте жалобу через форму ниже — добавим в отчёт.'
    });
  } catch (e) {
    console.error('KRO check-exchanger error:', e);
    return res.status(500).json({ found: false, url, error: 'internal_error' });
  }
});

app.post('/api/kro/check-screenshot', express.json({ limit: '10mb' }), async (req, res) => {
  const imageDataUrl = (req.body?.image ?? '').toString().trim();
  if (!imageDataUrl || (!imageDataUrl.startsWith('data:image/') || imageDataUrl.indexOf('base64,') === -1)) {
    return res.status(400).json({ error: 'image (data URL) required', extracted: [] });
  }
  if (!mistralKey) {
    return res.status(500).json({ error: 'AI not configured', extracted: [] });
  }
  try {
    const aiResponse = await axios.post(
      'https://api.mistral.ai/v1/chat/completions',
      {
        model: 'mistral-small-latest',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Look at this image. Extract ONLY: Telegram @usernames (e.g. @ChannelName), t.me links (full URL or t.me/xxx), or crypto exchanger/swap site URLs (http/https). Return one per line, nothing else. If none found, return exactly: NONE'
              },
              { type: 'image_url', image_url: imageDataUrl }
            ]
          }
        ],
        max_tokens: 300
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mistralKey}`
        }
      }
    );
    const raw = aiResponse.data?.choices?.[0]?.message?.content ?? '';
    const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const extracted = lines.filter((s) => s !== 'NONE' && (s.startsWith('@') || /t\.me\//i.test(s) || /^https?:\/\//i.test(s)));
    res.json({ extracted });
  } catch (e) {
    console.error('KRO check-screenshot error:', e?.response?.data ?? e.message);
    res.status(500).json({ error: 'vision_failed', extracted: [] });
  }
});

app.get('/api/kro/live-counter', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  try {
    const client = await getKroSheetsClient();
    if (!client) {
      return res.json(KRO_EMPTY);
    }
    const today = getTodayMSK();
    const range = 'A2:F';
    const response = await client.sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range
    });
    const rows = response.data.values || [];
    const data = rows.map((r) => parseSheetRow(r));
    const todayRows = data.filter((r) => isRowToday(r.dateVal, today));
    const channelsToday = todayRows.length;
    const totalLost = data.reduce((acc, r) => acc + r.sum, 0);
    const telegramCount = data.filter((r) => /^TG$/i.test(r.type)).length;
    const coursesCount = data.filter((r) => /курс|фейк|course/i.test(r.type)).length;
    const top3 = todayRows
      .sort((a, b) => b.sum - a.sum)
      .slice(0, 3)
      .map((r) => ({ channel: r.channel, sum: r.sum, status: r.status || 'Активен' }));
    res.json({
      channelsToday,
      totalLost,
      telegramCount,
      coursesCount,
      top3: top3.length ? top3 : KRO_EMPTY.top3
    });
  } catch (e) {
    console.error('KRO live-counter error:', e);
    res.json(KRO_EMPTY);
  }
});

app.post('/api/kro/report-scam', express.json(), async (req, res) => {
  const channel = (req.body?.channel ?? '').toString().trim();
  const sumRub = Number(req.body?.sumRub);
  const from = (req.body?.from ?? '').toString().trim();
  if (!channel || !Number.isFinite(sumRub) || sumRub < 0) {
    return res.status(400).json({ error: 'channel and sumRub (non-negative number) are required' });
  }
  try {
    const client = await getKroSheetsClient();
    if (!client) {
      return res.status(503).json({ error: 'live_counter_not_configured' });
    }
    const today = getTodayMSK();
    const row = [[today.dateKey, channel, sumRub, 'TG', 'Активен', from || '']];
    await client.sheets.spreadsheets.values.append({
      spreadsheetId: kroSheetId,
      range: 'A:F',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: row }
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('KRO report-scam error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
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
