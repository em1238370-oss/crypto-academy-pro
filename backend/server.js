import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, join } from 'path';
import { spawnSync } from 'child_process';
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
app.use(
  express.static(join(__dirname, '..'), {
    setHeaders(res, filePath) {
      const name = basename(filePath);
      if (name === 'index.html' || name === 'monitor.html') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
      }
    },
  })
);

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
const kroSheetId = process.env.KRO_SHEET_ID || '1C1NQwqmLRg59xgplnz5PeghRxaR_YY2lfSWZAJae6qM';
const kroCredentialsJson = process.env.KRO_GOOGLE_CREDENTIALS_JSON;
const kroCredentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const kroScamBaseRangeRaw = process.env.KRO_SCAM_BASE_RANGE || 'scam_base!A2:N';
const kroScamBaseSheet = kroScamBaseRangeRaw.includes('!') ? kroScamBaseRangeRaw.split('!')[0] : 'scam_base';
const kroScamBaseRange = `${kroScamBaseSheet}!A:N`;
const kroChannelsWatchRange = process.env.KRO_CHANNELS_WATCH_RANGE || 'channels_watch!A2:M';
const kroChannelsNetworkRange = process.env.KRO_CHANNELS_NETWORK_RANGE || 'channels_network!A2:G';
const kroMetaRange = process.env.KRO_META_RANGE || 'kro_meta!A:B';
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
    console.warn('KRO: KRO_GOOGLE_CREDENTIALS_JSON and GOOGLE_APPLICATION_CREDENTIALS are not set');
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

const KRO_SOURCES_DOC_URL = '/monitor';
const KRO_REFERENCE_STATS_PATH = join(__dirname, 'data', 'kro-reference-stats.json');
const KRO_12H_STATS_PATH = join(__dirname, 'data', 'kro-12h-stats.json');
const KRO_PENDING_REPORT_TEXT = 'Данные появятся после первого верифицированного отчёта.';

/** URLs embedded in complaints_row fields (Python worker / kro-12h-stats.json). */
function collectComplaintRowUrls(row) {
  const out = [];
  const addStr = (v) => {
    if (!v || typeof v !== 'string') return;
    const matches = v.match(/https?:\/\/[^\s\])'"<>|]+/g) || [];
    matches.forEach((m) => out.push(m.replace(/[),.;]+$/g, '')));
  };
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') addStr(v);
    else if (Array.isArray(v)) v.forEach(walk);
  };
  if (!row || typeof row !== 'object') return out;
  walk(row.source_urls);
  walk(row.evidence_links);
  walk(row.source_url);
  walk(row.message_links);
  return out;
}

function pickMonitorCaseSource(row, reportDocUrl) {
  const urls = [...new Set(collectComplaintRowUrls(row))];
  const external = urls.find((u) => !/t\.me\//i.test(u));
  if (external) return { url: external, kind: 'external' };
  if (urls.length) return { url: urls[0], kind: 'telegram' };
  const doc = String(reportDocUrl || '').trim();
  if (/^https?:\/\//i.test(doc)) return { url: doc, kind: 'report' };
  return { url: '/monitor#data-scam', kind: 'monitor' };
}

function ruComplaintsWord(n) {
  const abs = Math.abs(Math.floor(n)) % 100;
  const mod10 = abs % 10;
  if (abs >= 11 && abs <= 14) return 'жалоб';
  if (mod10 === 1) return 'жалоба';
  if (mod10 >= 2 && mod10 <= 4) return 'жалобы';
  return 'жалоб';
}

function fmtRubSpaces(n) {
  const x = Math.round(Number(n) || 0);
  if (!Number.isFinite(x) || x < 0) return '0';
  return x.toLocaleString('ru-RU');
}

function buildMonitorCaseSummary(row) {
  const complaints = Math.max(0, Math.floor(Number(row.complaints) || 0));
  const losses = Math.max(0, Math.round(Number(row.losses) || 0));
  const qg = String(row.query_group || '').trim();
  let s;
  if (complaints > 0 && losses > 0) {
    s = `По каналу — ${complaints} ${ruComplaintsWord(complaints)}, в суммах фигурирует порядка ${fmtRubSpaces(losses)} ₽`;
    if (qg && qg !== 'жалобы/обсуждения') s += ` (${qg})`;
    s += '.';
  } else if (complaints > 0) {
    s = `В открытых источниках и форме по каналу зафиксировано ${complaints} ${ruComplaintsWord(complaints)}.`;
  } else if (losses > 0) {
    s = `В сводке мониторинга указаны потери порядка ${fmtRubSpaces(losses)} ₽.`;
  } else {
    s = 'Канал попал в сводку мониторинга по сигналам из открытых площадок и пользовательских обращений.';
  }
  if (s.length > 240) return `${s.slice(0, 237)}…`;
  return s;
}

function channelLabelForMonitorCase(ch) {
  const raw = String(ch || '').trim();
  if (!raw) return '—';
  if (raw.startsWith('@')) return raw;
  if (/^https?:\/\/t\.me\//i.test(raw)) {
    return `@${raw.replace(/^https?:\/\/t\.me\//i, '').replace(/\/$/, '')}`;
  }
  return `@${raw.replace(/^@+/, '')}`;
}

function channelUrlForMonitorCase(ch) {
  const raw = String(ch || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const name = raw.replace(/^@+/, '');
  return name ? `https://t.me/${name}` : '';
}

/** Top N complaint aggregates from kro-12h-stats.json for /monitor story cards. */
function buildMonitorRecentCases(statsData, limit = 3) {
  const rows = Array.isArray(statsData?.complaints_rows) ? statsData.complaints_rows : [];
  const reportDoc = statsData?.report_doc_url || '';
  const sorted = [...rows]
    .filter((r) => r && String(r.channel || '').trim())
    .sort((a, b) => (Number(b.losses) || 0) - (Number(a.losses) || 0));
  const out = [];
  for (const r of sorted) {
    if (out.length >= limit) break;
    const channel = String(r.channel || '').trim();
    const losses = Math.max(0, Math.round(Number(r.losses) || 0));
    const src = pickMonitorCaseSource(r, reportDoc);
    out.push({
      channel,
      channel_label: channelLabelForMonitorCase(channel),
      channel_url: channelUrlForMonitorCase(channel),
      loss_rub: losses,
      summary: buildMonitorCaseSummary(r),
      source_url: src.url,
      source_kind: src.kind
    });
  }
  return out;
}

const KRO_FALLBACK = {
  channelsToday: 0,
  totalLost: 0,
  telegramCount: 0,
  coursesCount: 0,
  victims_12h: 0,
  shockText: KRO_PENDING_REPORT_TEXT,
  report_doc_url: KRO_SOURCES_DOC_URL,
  publishStatus: 'honest_zero',
  isHonestZero: true,
  top3: []
};

function readJsonFileSafe(path, label) {
  try {
    if (!fs.existsSync(path)) return null;
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    console.warn(`KRO ${label}: invalid JSON`, e?.message);
    return null;
  }
}

function parseKroCycleMetaRows(rows) {
  const values = {};
  for (const row of rows || []) {
    const key = String(row?.[0] || '').trim();
    const value = row?.[1];
    if (key) values[key] = value;
  }
  let sources_checked = [];
  if (typeof values.sources_checked === 'string' && values.sources_checked.trim()) {
    try {
      const parsed = JSON.parse(values.sources_checked);
      if (Array.isArray(parsed)) {
        sources_checked = parsed.map((item) => ({
          name: String(item?.name || '').trim(),
          status: String(item?.status || 'not_found').trim(),
          count: Number(item?.count || 0) || 0,
        })).filter((item) => item.name);
      }
    } catch (e) {
      console.warn('KRO cycle meta parse failed:', e?.message);
    }
  }
  return {
    last_cycle_at: values.last_cycle_at ? String(values.last_cycle_at) : null,
    new_in_cycle: Number(values.new_in_cycle || 0) || 0,
    sources_checked,
  };
}

async function readKroCycleMetaFromSheets(sheetsClient) {
  if (!sheetsClient || !kroSheetId) {
    return { last_cycle_at: null, new_in_cycle: 0, sources_checked: [] };
  }
  try {
    const sheetName = kroMetaRange.split('!')[0] || 'kro_meta';
    const resp = await sheetsClient.sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: `${sheetName}!A:B`
    });
    return parseKroCycleMetaRows(resp.data.values || []);
  } catch (e) {
    console.warn('KRO cycle meta read failed:', e?.message);
    return { last_cycle_at: null, new_in_cycle: 0, sources_checked: [] };
  }
}

function normalizeKroShockText(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return /73\s+человек.*гаранти[яи]\s+прибыли/i.test(value) ? KRO_PENDING_REPORT_TEXT : value;
}

function hasKroVisibleData(data) {
  if (!data || typeof data !== 'object') return false;
  const channelsToday = pickFirstNumber(data.new_scam_channels, data.new_scams, data.channelsToday);
  const totalLost = pickFirstNumber(data.losses_12h, data.totalLost);
  const telegramCount = pickFirstNumber(data.telegram_channels, data.telegramCount);
  const coursesCount = pickFirstNumber(data.courses_products, data.courses, data.coursesCount);
  const top3 = Array.isArray(data.display_top3) && data.display_top3.length ? data.display_top3 : data.top3;
  return (
    Number(channelsToday || 0) > 0 ||
    Number(totalLost || 0) > 0 ||
    Number(telegramCount || 0) > 0 ||
    Number(coursesCount || 0) > 0 ||
    (Array.isArray(top3) && top3.length > 0)
  );
}

function buildKroLiveResponse(data, options = {}) {
  if (!data || typeof data !== 'object') return null;
  const defaultPublishStatus = options.defaultPublishStatus || 'valid';
  const explicitPublishStatus = typeof data.publishStatus === 'string' ? data.publishStatus : null;
  const publishStatus = explicitPublishStatus || defaultPublishStatus;
  if (isKroZeroSnapshot(data) && publishStatus !== 'honest_zero') {
    return null;
  }
  if (!hasKroVisibleData(data) && publishStatus !== 'honest_zero') {
    return null;
  }

  const channelsToday = pickFirstNumber(data.new_scam_channels, data.new_scams, data.channelsToday);
  const totalLost = pickFirstNumber(data.losses_12h, data.totalLost);
  const telegramCount = pickFirstNumber(data.telegram_channels, data.telegramCount);
  const coursesCount = pickFirstNumber(data.courses_products, data.courses, data.coursesCount);
  const victims12h = pickFirstNumber(data.victims_12h, data.victims24h);
  const shockText = normalizeKroShockText(data.shockText) || buildKroShockText(victims12h, publishStatus);

  let top3 = [];
  const primaryTop3 = Array.isArray(data.display_top3) && data.display_top3.length ? data.display_top3 : data.top3;
  if (Array.isArray(primaryTop3) && primaryTop3.length && typeof primaryTop3[0] === 'object' && (primaryTop3[0].sum !== undefined || primaryTop3[0].channel)) {
    top3 = primaryTop3.slice(0, 3).map((r) => ({
      channel: r.channel || r.name || '—',
      sum: typeof r.sum === 'number' ? r.sum : (r.losses || 0),
      status: r.status || 'Активен'
    }));
  } else if (Array.isArray(data.top3_today) && data.top3_today.length) {
    top3 = data.top3_today.slice(0, 3).map((s) => ({
      channel: typeof s === 'string' ? s : (s && s.channel) || '—',
      sum: 0,
      status: 'Активен'
    }));
  }

  return {
    channelsToday,
    totalLost,
    telegramCount,
    coursesCount,
    victims_12h: victims12h,
    shockText,
    top3,
    report_doc_url: data.report_doc_url || KRO_SOURCES_DOC_URL,
    sourceCaption: data.sourceCaption || (Array.isArray(data.sources) ? data.sources.join(', ') : null),
    evidence_summary: data.evidence_summary || {},
    risk_rows: Array.isArray(data.risk_rows) ? data.risk_rows.slice(0, 10) : [],
    complaints_rows: Array.isArray(data.complaints_rows) ? data.complaints_rows.slice(0, 10) : [],
    publishStatus,
    isHonestZero: Boolean(data.isHonestZero),
    siteNotice: options.siteNotice !== undefined ? options.siteNotice : (data.siteNotice || null),
    lastValidUpdatedAt: data.lastValidUpdatedAt || data.updatedAt || data.timestamp || null,
    updatedAt: data.updatedAt || data.timestamp || data.lastValidUpdatedAt || null
  };
}

function buildKroReferenceSnapshot(data) {
  const victims12h = pickFirstNumber(data.victims_12h, data.victims24h);
  return {
    source: 'site_snapshot',
    sourceCaption: data.sourceCaption || 'Последний подтверждённый снимок для сайта.',
    channelsToday: pickFirstNumber(data.new_scam_channels, data.new_scams, data.channelsToday),
    totalLost: pickFirstNumber(data.losses_12h, data.totalLost),
    telegramCount: pickFirstNumber(data.telegram_channels, data.telegramCount),
    coursesCount: pickFirstNumber(data.courses_products, data.courses, data.coursesCount),
    victims_12h: victims12h,
    shockText: normalizeKroShockText(data.shockText) || buildKroShockText(victims12h, data.publishStatus || 'valid'),
    top3: Array.isArray(data.display_top3) && data.display_top3.length ? data.display_top3.slice(0, 3) : (Array.isArray(data.top3) ? data.top3.slice(0, 3) : []),
    report_doc_url: data.report_doc_url || KRO_SOURCES_DOC_URL,
    publishStatus: data.publishStatus || 'valid',
    updatedAt: data.updatedAt || data.timestamp || new Date().toISOString(),
    lastValidUpdatedAt: data.lastValidUpdatedAt || data.updatedAt || data.timestamp || new Date().toISOString()
  };
}

function buildKroShockText(victims12h, publishStatus) {
  const n = Number(victims12h) || 0;
  if (n <= 0) {
    return publishStatus === 'honest_zero'
      ? 'Новых подтверждённых жалоб за этот период не зафиксировано'
      : 'Нет новых жалоб за 12 ч';
  }
  if (n === 1) return '1 человек купил «гарантию прибыли»';
  if (n >= 2 && n <= 4) return n + ' человека купили «гарантию прибыли»';
  return n + ' человек купили «гарантию прибыли»';
}

function isKroZeroSnapshot(data) {
  if (!data || typeof data !== 'object') return false;
  const newScamChannels = pickFirstNumber(data.new_scam_channels, data.new_scams, data.channelsToday);
  const losses12h = pickFirstNumber(data.losses_12h, data.totalLost);
  const telegramChannels = pickFirstNumber(data.telegram_channels, data.telegramCount);
  const coursesProducts = pickFirstNumber(data.courses_products, data.courses, data.coursesCount);
  const primaryTop3 = Array.isArray(data.display_top3) && data.display_top3.length ? data.display_top3 : data.top3;
  return (
    Number(newScamChannels || 0) === 0 &&
    Number(losses12h || 0) === 0 &&
    Number(telegramChannels || 0) === 0 &&
    Number(coursesProducts || 0) === 0 &&
    (!Array.isArray(primaryTop3) || primaryTop3.length === 0)
  );
}

function pickFirstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

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

/** Парсит bot_pct: "78%" или "78" → число 0–100. */
function parseBotPct(bot_pct) {
  if (bot_pct == null || bot_pct === '') return null;
  const s = (bot_pct).toString().trim().replace(/%/g, '');
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

/** Парсит vip_price: "7000₽", "7000" → число. */
function parseVipPrice(vip_price) {
  if (vip_price == null || vip_price === '') return null;
  const s = (vip_price).toString().replace(/\s/g, '').replace(/[^\d]/g, '');
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Формула риска MVP: реклама×0.4 + боты×0.3 + жалобы×0.2 (нормализовано к 0–100), +10 если vip > 5000.
 * Вход: ads_per_week (0–25 типично), bot_pct (0–100), complaints (0–50 типично), vip_price (строка или число).
 */
function computeRiskScoreFromFeatures(ads_per_week, bot_pct, complaints, vip_price) {
  const ads = Math.min(25, Math.max(0, ads_per_week ?? 0));
  const botNum = parseBotPct(bot_pct);
  const bots = botNum != null ? botNum : 0;
  const comp = Math.min(50, Math.max(0, complaints ?? 0));
  const vipNum = typeof vip_price === 'number' ? vip_price : parseVipPrice(vip_price);
  const vipBonus = (vipNum != null && vipNum > 5000) ? 10 : 0;
  const risk = Math.round((ads / 25) * 40 + (bots / 100) * 30 + (comp / 50) * 30 + vipBonus);
  return Math.min(100, Math.max(0, risk));
}

function parseScamBaseRow(row) {
  const username = (row[0] || '').toString().trim();
  // Detect schema version by column count:
  // new v2 (13-14 cols A–N): username | link | detected_at | created_at | channel_age_days | object_type | vip_price | complaints | total_loss_rub | source_primary | source_evidence | cycle_window | status | content_analysis
  // old v1 (8 cols):      username | risk_score | ads_per_week | bot_pct | vip_price | complaints | total_loss | verdict
  if (row.length >= 13 && /^\d{4}-\d{2}-\d{2}T/.test((row[2] || '').toString())) {
    // new v2 schema
    const link = (row[1] || '').toString().trim();
    const detected_at = (row[2] || '').toString().trim();
    const created_at = (row[3] || '').toString().trim();
    const channel_age_days = parseInt((row[4] ?? '').toString(), 10);
    const object_type = (row[5] || '').toString().trim();
    const vip_price = (row[6] || '').toString().trim();
    const complaints = parseInt((row[7] ?? '').toString().replace(/\s/g, ''), 10);
    const total_loss_rub = parseInt((row[8] ?? '').toString().replace(/\s/g, ''), 10);
    const source_primary = (row[9] || '').toString().trim();
    const cycle_window = (row[11] || '').toString().trim();
    const status = (row[12] || '').toString().trim();
    const source_evidence = (row[10] || '').toString().trim();
    const content_analysis = (row[13] || '').toString().trim();
    return {
      username, link, detected_at, created_at,
      channel_age_days: Number.isFinite(channel_age_days) ? channel_age_days : null,
      object_type, vip_price,
      complaints: Number.isFinite(complaints) ? complaints : null,
      total_loss_rub: Number.isFinite(total_loss_rub) ? total_loss_rub : 0,
      source_primary, source_evidence, cycle_window, status, content_analysis,
      verdict: 'confirmed', _schema: 'v2'
    };
  }
  // old v1 schema (backward compat)
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
  return {
    username, risk_score: Number.isFinite(risk_score) ? risk_score : null,
    ads_per_week: Number.isFinite(ads_per_week) ? ads_per_week : null,
    bot_pct, vip_price,
    complaints: Number.isFinite(complaints) ? complaints : null,
    total_loss, verdict, _schema: 'v1'
  };
}

/** Честный fallback для монитора: без разбора постов, только поля строки scam_base. */
function buildSheetOnlyContentAnalysisV2(row, fetchFailed) {
  const facts = {
    object_type: row.object_type || '',
    vip_price: row.vip_price || '',
    complaints: row.complaints != null ? row.complaints : '',
    total_loss_rub: row.total_loss_rub ?? 0,
    source_primary: row.source_primary || '',
    status: row.status || '',
  };
  return {
    source: 'sheet_only',
    activity: 'неизвестен',
    posts_analyzed: 0,
    keywords: {},
    fetch_failed: fetchFailed,
    note: fetchFailed
      ? 'Не удалось получить ленту публичных постов; ниже только поля из строки таблицы.'
      : 'В таблице ещё нет разбора постов; ниже те же поля, что в строке.',
    sheet_facts: facts,
  };
}

function enrichScamBaseContentAnalysisForMonitor(row) {
  if (row._schema !== 'v2') return row;
  const ca = (row.content_analysis || '').trim();
  if (ca && ca !== 'недоступен') {
    try {
      const j = JSON.parse(ca);
      if (j && typeof j === 'object' && !Array.isArray(j)) return row;
    } catch (_) {
      /* подменим на структурированный fallback */
    }
  }
  const fetchFailed = ca === 'недоступен';
  const payload = buildSheetOnlyContentAnalysisV2(row, fetchFailed);
  return { ...row, content_analysis: JSON.stringify(payload) };
}

function parseChannelsWatchRow(row) {
  const username = (row[0] || '').toString().trim();
  if (!username) return null;
  const link = (row[1] || '').toString().trim();
  const detected_at = (row[2] || '').toString().trim();
  const created_at = (row[3] || '').toString().trim();
  const channel_age_days = parseInt((row[4] ?? '').toString(), 10);
  const source_primary = (row[5] || '').toString().trim();
  const vip_price = (row[6] || '').toString().trim();
  const complaints = parseInt((row[7] ?? '').toString().replace(/\s/g, ''), 10);
  const activity_summary = (row[8] || '').toString().trim();
  const reviews_summary = (row[9] || '').toString().trim();
  const source_evidence = (row[10] || '').toString().trim();
  const cycle_window = (row[11] || '').toString().trim();
  const status = (row[12] || '').toString().trim();
  return {
    username,
    link,
    detected_at,
    created_at,
    channel_age_days: Number.isFinite(channel_age_days) ? channel_age_days : null,
    source_primary,
    vip_price,
    complaints: Number.isFinite(complaints) ? complaints : 0,
    activity_summary,
    reviews_summary,
    source_evidence,
    cycle_window,
    status,
    verdict: 'watch',
    _schema: 'watch_v1',
  };
}

function parseChannelsNetworkRow(row) {
  const source_channel = (row[0] || '').toString().trim();
  const target_channel = (row[1] || '').toString().trim();
  if (!source_channel || !target_channel) return null;
  return {
    source_channel,
    target_channel,
    relation: (row[2] || '').toString().trim(),
    detected_at: (row[3] || '').toString().trim(),
    last_post_at: (row[4] || '').toString().trim(),
    evidence: (row[5] || '').toString().trim(),
    post_url: (row[6] || '').toString().trim(),
  };
}

/**
 * Build live-counter payload from scam_base v2 rows (confirmed objects from last 12h).
 * Falls back to null if no v2 rows are recent enough.
 */
function buildLiveCounterFromScamBase(parsedRows) {
  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;

  // All confirmed rows (v2 schema) — survive restarts, not limited by time window
  const allRows = parsedRows.filter(r => r._schema === 'v2' && r.username);
  if (!allRows.length) return null;

  // channelsToday = все подтверждённые каналы в базе (не только за 24ч)
  // publishStatus: valid если база не пустая
  const new_scam_channels = allRows.length;
  const losses_12h = allRows.reduce((s, r) => s + (r.total_loss_rub || 0), 0);

  // telegramCount = ALL confirmed telegram signal channels in scam_base
  const telegram_channels = allRows.filter(r =>
    (r.object_type || '').toLowerCase().includes('сигнал') || !(r.object_type || '').trim()
  ).length;
  const courses_products = allRows.filter(r =>
    ['курс', 'сайт', 'обучен'].some(kw => (r.object_type || '').toLowerCase().includes(kw))
  ).length;

  // Top-3 from all rows by total loss
  const complaints_received = allRows.reduce((s, r) => s + (Number(r.complaints) || 0), 0);

  const top3 = [...allRows]
    .sort((a, b) => (b.total_loss_rub || 0) - (a.total_loss_rub || 0))
    .slice(0, 3)
    .map(r => ({ channel: r.username, sum: r.total_loss_rub || 0, status: r.status || 'в риске', link: r.link || '' }));

  const latestDetected = allRows.reduce((best, r) => {
    try { const t = new Date(r.detected_at || 0).getTime(); return t > best ? t : best; } catch { return best; }
  }, 0);

  const isHonestZero = new_scam_channels === 0;
  return {
    new_scam_channels,
    losses_12h,
    telegram_channels,
    courses_products,
    complaints_received,
    top3,
    publishStatus: isHonestZero ? 'honest_zero' : 'valid',
    isHonestZero,
    updatedAt: latestDetected ? new Date(latestDetected).toISOString() : new Date().toISOString(),
    sourceCaption: `Данные из Google Sheets scam_base · ${allRows.length} каналов подтверждено · источники: web-мониторинг и форма жалоб`,
  };
}

function isUsableScamBaseRow(row) {
  const verdict = (row?.verdict || '').toString().trim().toLowerCase();
  if (!verdict) return false;
  if (verdict === 'unknown' || verdict === 'not_confirmed') return false;
  return true;
}

function normalizeCheckOnceError(error) {
  const text = (error || '').toString().trim();
  if (!text) return null;
  if (/No module named ['"]telethon['"]|ModuleNotFoundError:.*telethon/i.test(text)) {
    return 'На web-сервисе не установлен Telethon, поэтому быстрая проверка недоступна. Канал будет проверен воркером через очередь.';
  }
  if (/telegram not configured/i.test(text)) {
    return 'На web-сервисе ещё не настроены Telegram API ключи для мгновенной проверки.';
  }
  if (/channel not found or inaccessible/i.test(text)) {
    return 'Канал не найден или к нему нет доступа.';
  }
  return text.split('\n').slice(-1)[0].trim() || text;
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
  const checkingMessage = 'Проверяем канал по Telegram. Подождите 1–2 минуты и нажмите «Проверить» снова.';
  if (!kroScamBaseRange || !kroSheetId) {
    return res.json({ found: false, channel, pending: true, message: checkingMessage });
  }
  try {
    const client = await getKroSheetsClient();
    if (!client) {
      return res.json({ found: false, channel, pending: true, message: checkingMessage });
    }
    const response = await client.sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: kroScamBaseRange
    });
    const rows = response.data.values || [];
    const requestKey = channelMatchKey(channel);
    for (let i = 0; i < rows.length; i++) {
      const row = parseScamBaseRow(rows[i]);
      if (requestKey && channelMatchKey(row.username) === requestKey) {
        if (!isUsableScamBaseRow(row)) {
          continue;
        }
        let complaints = row.complaints;
        let total_loss = row.total_loss;
        const empty = (v) => v == null || v === '' || (typeof v === 'string' && v.trim() === '—');
        if (empty(complaints) || empty(total_loss)) {
          const report = await getComplaintsAndLossForChannel(client, channel);
          if (report.complaints != null) complaints = report.complaints;
          if (report.total_loss != null) total_loss = report.total_loss;
        }
        return res.json({
          found: true,
          username: row.username,
          risk_score: row.risk_score,
          ads_per_week: row.ads_per_week,
          bot_pct: row.bot_pct,
          vip_price: row.vip_price,
          complaints,
          total_loss,
          verdict: row.verdict
        });
      }
    }

    const scriptPath = join(__dirname, 'kro-worker', 'check_once.py');
    const hasPython = (process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && fs.existsSync(scriptPath));
    let checkOnceError = null;
    if (hasPython) {
      try {
        const child = spawnSync('python3', [scriptPath, channel], {
          cwd: join(__dirname, 'kro-worker'),
          timeout: 60000,
          encoding: 'utf8',
          env: { ...process.env }
        });
        const stdout = (child.stdout || '').trim();
        const stderr = (child.stderr || '').trim();
        const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
        if (line) {
          try {
            const parsed = JSON.parse(line);
            if (parsed && parsed.not_crypto) {
              return res.json({
                found: false,
                pending: false,
                channel,
                message: parsed.error || 'Канал не связан с криптой, поэтому в мониторинг не попадает.'
              });
            }
            if (parsed && parsed.found === true && parsed.is_confirmed === true) {
              let complaints = parsed.complaints;
              let total_loss = parsed.total_loss;
              const empty = (v) => v == null || v === '' || (typeof v === 'string' && v.trim() === '—');
              if (empty(complaints) || empty(total_loss)) {
                const report = await getComplaintsAndLossForChannel(client, channel);
                if (report.complaints != null) complaints = report.complaints;
                if (report.total_loss != null) total_loss = report.total_loss;
              }
              const risk_score = parsed.risk_score != null
                ? parsed.risk_score
                : computeRiskScoreFromFeatures(parsed.ads_per_week, parsed.bot_pct, complaints ?? parsed.complaints, parsed.vip_price);
              return res.json({
                found: true,
                username: parsed.username,
                risk_score,
                ads_per_week: parsed.ads_per_week,
                bot_pct: parsed.bot_pct,
                vip_price: parsed.vip_price,
                complaints,
                total_loss,
                verdict: parsed.verdict,
                is_confirmed: true,
                fomo_pct: parsed.fomo_pct,
                shame_phrases_detected: parsed.shame_phrases_detected,
                ads_ratio: parsed.ads_ratio,
                only_profits_flag: parsed.only_profits_flag,
                promoted_channels_count: parsed.promoted_channels_count,
                promoted_channels_sample: parsed.promoted_channels_sample,
                subscriber_growth_per_day: parsed.subscriber_growth_per_day,
                growth_anomaly: parsed.growth_anomaly,
                reach_ratio: parsed.reach_ratio,
                channel_age_days: parsed.channel_age_days
              });
            }
            if (parsed && parsed.found === true && parsed.is_confirmed === false) {
              return res.json({
                found: false,
                pending: false,
                channel,
                message: parsed.message || 'Канал проверен, но пока не проходит 3 критерия подтверждённого скам-канала.',
                confirmation_status: parsed.confirmation_status || 'not_confirmed',
                confirmation_checks: parsed.confirmation_checks || undefined,
                missing_criteria: parsed.missing_criteria || undefined
              });
            }
            if (parsed && parsed.found === false && parsed.error) {
              checkOnceError = normalizeCheckOnceError(parsed.error);
            }
          } catch (parseErr) {
            console.error('KRO check_once parse error:', parseErr.message);
            checkOnceError = normalizeCheckOnceError(stderr) || 'Ошибка ответа скрипта';
          }
        } else {
          checkOnceError = normalizeCheckOnceError(stderr) || (child.status !== 0 ? 'Скрипт завершился с ошибкой' : null);
        }
        if (stderr) console.error('KRO check_once stderr:', stderr);
      } catch (e) {
        console.error('KRO check_once error:', e.message);
        checkOnceError = normalizeCheckOnceError(e.message) || 'Запуск проверки не удался';
      }
    } else {
      checkOnceError = 'На сервере не настроены TELEGRAM_API_ID/Telethon — живая проверка недоступна.';
    }

    if (kroCheckQueueRange && client) {
      try {
        await client.sheets.spreadsheets.values.append({
          spreadsheetId: kroSheetId,
          range: kroCheckQueueRange,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [[channel, new Date().toISOString()]] }
        });
      } catch (e) {
        console.error('KRO check queue append error:', e);
      }
    }
    const finalMessage = checkOnceError
      ? `Не удалось проверить канал: ${checkOnceError}${kroCheckQueueRange ? ' Канал добавлен в очередь — попробуйте нажать «Проверить» через 1–2 минуты.' : ''}`
      : checkingMessage;
    return res.json({
      found: false,
      pending: !!kroCheckQueueRange,
      channel,
      message: finalMessage,
      error_detail: checkOnceError || undefined
    });
  } catch (e) {
    console.error('KRO check error:', e);
    return res.status(500).json({ found: false, channel, pending: true, message: checkingMessage, error: 'internal_error' });
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
    // Единственный источник данных: Google Sheets scam_base.
    // Никакого кеша, никаких файлов, никаких fallback — только реальные данные из таблицы.
    const sheetsClient = await getKroSheetsClient();
    if (sheetsClient) {
      const cycleMeta = await readKroCycleMetaFromSheets(sheetsClient);
      const sheetName = kroScamBaseRange.split('!')[0] || 'scam_base';
      const metaSheetName = kroMetaRange.split('!')[0] || 'kro_meta';
      console.log(`[KRO live-counter] reading from Sheets: ${kroSheetId} / ${sheetName}`);
      console.log('KRO META SOURCE: reading from', `Google Sheets ${metaSheetName}`, cycleMeta.last_cycle_at);
      const sheetResp = await sheetsClient.sheets.spreadsheets.values.get({
        spreadsheetId: kroSheetId,
        range: `${sheetName}!A:M`
      });
      const rawRows = sheetResp.data.values || [];
      const parsedRows = rawRows.map(parseScamBaseRow).filter(r => r.username && r.username !== 'username');
      console.log(`[KRO live-counter] parsed ${parsedRows.length} rows from scam_base`);
      const scamBaseCounter = buildLiveCounterFromScamBase(parsedRows);
      if (scamBaseCounter) {
        // Use last_cycle_at from kro_meta when it's newer than latest scam_base row
        const cycleTs = cycleMeta.last_cycle_at ? new Date(cycleMeta.last_cycle_at).getTime() : 0;
        const rowTs = scamBaseCounter.updatedAt ? new Date(scamBaseCounter.updatedAt).getTime() : 0;
        const bestUpdatedAt = cycleTs > rowTs ? cycleMeta.last_cycle_at : scamBaseCounter.updatedAt;
        return res.json({
          channelsToday: scamBaseCounter.new_scam_channels,
          totalLost: scamBaseCounter.losses_12h,
          telegramCount: scamBaseCounter.telegram_channels,
          coursesCount: scamBaseCounter.courses_products,
          complaints_received: scamBaseCounter.complaints_received,
          victims_12h: null,
          shockText: KRO_PENDING_REPORT_TEXT,
          top3: scamBaseCounter.top3,
          report_doc_url: KRO_SOURCES_DOC_URL,
          sourceCaption: scamBaseCounter.sourceCaption,
          publishStatus: scamBaseCounter.publishStatus,
          isHonestZero: scamBaseCounter.isHonestZero,
          siteNotice: null,
          lastValidUpdatedAt: bestUpdatedAt,
          updatedAt: bestUpdatedAt,
          last_cycle_at: cycleMeta.last_cycle_at,
          new_in_cycle: cycleMeta.new_in_cycle,
          sources_checked: cycleMeta.sources_checked
        });
      }
    } else {
      console.warn('[KRO live-counter] no Sheets client — KRO_GOOGLE_CREDENTIALS_JSON not set on Render?');
    }

    // Sheets недоступен — честный ноль с пояснением
    const cycleMeta = { last_cycle_at: null, new_in_cycle: 0, sources_checked: [] };
    console.log('KRO META SOURCE: reading from', 'unavailable (no Sheets client)');
    return res.json({
      channelsToday: 0,
      totalLost: 0,
      telegramCount: 0,
      coursesCount: 0,
      complaints_received: 0,
      victims_12h: null,
      shockText: KRO_PENDING_REPORT_TEXT,
      top3: [],
      report_doc_url: KRO_SOURCES_DOC_URL,
      sourceCaption: 'Мониторинг запущен. Первые данные появятся после завершения цикла проверки.',
      publishStatus: 'honest_zero',
      isHonestZero: true,
      siteNotice: null,
      lastValidUpdatedAt: null,
      updatedAt: null,
      last_cycle_at: cycleMeta.last_cycle_at,
      new_in_cycle: cycleMeta.new_in_cycle,
      sources_checked: cycleMeta.sources_checked
    });
  } catch (e) {
    console.error('KRO live-counter error:', e);
    const cycleMeta = { last_cycle_at: null, new_in_cycle: 0, sources_checked: [] };
    console.log('KRO META SOURCE: reading from', 'unavailable (exception path)');
    res.json({
      channelsToday: 0,
      totalLost: 0,
      telegramCount: 0,
      coursesCount: 0,
      complaints_received: 0,
      victims_12h: null,
      shockText: KRO_PENDING_REPORT_TEXT,
      top3: [],
      report_doc_url: KRO_SOURCES_DOC_URL,
      sourceCaption: 'Мониторинг запущен.',
      publishStatus: 'honest_zero',
      isHonestZero: true,
      siteNotice: null,
      lastValidUpdatedAt: null,
      updatedAt: null,
      last_cycle_at: cycleMeta.last_cycle_at,
      new_in_cycle: cycleMeta.new_in_cycle,
      sources_checked: cycleMeta.sources_checked
    });
  }
});

// Serve /monitor page
app.get('/monitor', (req, res) =>
  res.sendFile('monitor.html', { root: join(__dirname, '..') }));

// GET /api/kro/monitor-data — full data for the /monitor dashboard
// Returns: scam_base, channels_watch, channels_network, kro_meta, kro_history
app.get('/api/kro/monitor-data', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  try {
    const sheetsClient = await getKroSheetsClient();
    if (!sheetsClient || !kroSheetId) {
      return res.status(503).json({ error: 'Google Sheets not configured' });
    }

    const [scamResp, watchResp, networkResp, metaResp, historyResp] = await Promise.allSettled([
      sheetsClient.sheets.spreadsheets.values.get({
        spreadsheetId: kroSheetId,
        range: kroScamBaseRange
      }),
      sheetsClient.sheets.spreadsheets.values.get({
        spreadsheetId: kroSheetId,
        range: kroChannelsWatchRange
      }),
      sheetsClient.sheets.spreadsheets.values.get({
        spreadsheetId: kroSheetId,
        range: kroChannelsNetworkRange
      }),
      sheetsClient.sheets.spreadsheets.values.get({
        spreadsheetId: kroSheetId,
        range: 'kro_meta!A:B'
      }),
      sheetsClient.sheets.spreadsheets.values.get({
        spreadsheetId: kroSheetId,
        range: 'kro_history!A:F'
      })
    ]);

    // scam_base rows (skip header)
    const scamRawRows = scamResp.status === 'fulfilled' ? (scamResp.value.data.values || []) : [];
    const scamRows = scamRawRows
      .slice(1)
      .map(parseScamBaseRow)
      .filter(r => r.username && r.username !== 'username')
      .map(enrichScamBaseContentAnalysisForMonitor);

    const watchRawRows = watchResp.status === 'fulfilled' ? (watchResp.value.data.values || []) : [];
    const channelsWatch = watchRawRows
      .map(parseChannelsWatchRow)
      .filter((r) => r && r.username && r.username !== 'username');

    const networkRawRows = networkResp.status === 'fulfilled' ? (networkResp.value.data.values || []) : [];
    const channelsNetwork = networkRawRows
      .map(parseChannelsNetworkRow)
      .filter((r) => r && r.source_channel && r.target_channel);

    // kro_meta
    const metaRows = metaResp.status === 'fulfilled' ? (metaResp.value.data.values || []) : [];
    const meta = parseKroCycleMetaRows(metaRows);

    // kro_history rows (skip header row if present)
    const histRawRows = historyResp.status === 'fulfilled' ? (historyResp.value.data.values || []) : [];
    const history = histRawRows
      .filter(r => r[0] && r[0] !== 'cycle_at')
      .map(r => ({
        cycle_at: (r[0] || '').toString().trim(),
        new_in_cycle: Number(r[1] || 0),
        sources_summary: (r[2] || '').toString().trim(),
        channels_added: (r[3] || '').toString().trim(),
        status: (r[4] || '').toString().trim(),
        notes: (r[5] || '').toString().trim()
      }))
      .reverse(); // newest first

    const statsSnapshot = readJsonFileSafe(KRO_12H_STATS_PATH, '12h-stats') || {};
    const recent_cases = buildMonitorRecentCases(statsSnapshot, 3);

    return res.json({
      scam_base: scamRows,
      channels_watch: channelsWatch,
      channels_network: channelsNetwork,
      meta,
      history,
      recent_cases
    });
  } catch (e) {
    console.error('KRO monitor-data error:', e);
    return res.status(500).json({ error: 'internal error', detail: e.message });
  }
});

// POST /api/kro/update и /api/update — принять JSON для сайта (12:00 и 00:00 MSK), записать в kro-12h-stats.json
// Спецификация: timestamp, new_scam_channels, losses_12h, telegram_channels, courses_products, top3_today[]
// Опционально: KRO_UPDATE_SECRET в env — тогда заголовок Authorization: Bearer <secret> или ?secret=...
function handleKroUpdate(req, res) {
  const secret = process.env.KRO_UPDATE_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const qSecret = req.query.secret || req.query.kro_secret;
    if (bearer !== secret && qSecret !== secret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }
  const body = req.body || {};
  const incomingPublishStatus = body.publishStatus != null ? String(body.publishStatus) : null;
  const newScamChannels = Number(body.new_scam_channels);
  const losses12h = Number(body.losses_12h);
  const telegramChannels = Number(body.telegram_channels);
  const coursesProducts = Number(body.courses_products);
  const top3Today = Array.isArray(body.top3_today) ? body.top3_today.map((s) => String(s == null ? '' : s)) : [];
  const evidenceSummary = body.evidence_summary && typeof body.evidence_summary === 'object' ? body.evidence_summary : {};
  const riskRows = Array.isArray(body.risk_rows) ? body.risk_rows.slice(0, 50) : [];
  const complaintsRows = Array.isArray(body.complaints_rows) ? body.complaints_rows.slice(0, 50) : [];
  const displayTop3 = Array.isArray(body.display_top3) ? body.display_top3.slice(0, 3) : [];
  const sourcesChecked = Array.isArray(body.sources_checked) ? body.sources_checked.slice(0, 10).map((item) => ({
    name: String(item?.name || '').trim(),
    status: String(item?.status || 'not_found').trim(),
    count: Number(item?.count || 0) || 0,
  })).filter((item) => item.name) : [];
  const lastCycleAt = body.last_cycle_at != null ? String(body.last_cycle_at) : null;
  const newInCycle = Number(body.new_in_cycle || 0) || 0;
  if (!Number.isFinite(newScamChannels) || !Number.isFinite(losses12h)) {
    return res.status(400).json({ error: 'new_scam_channels and losses_12h required as numbers' });
  }
  const zeroSnapshot = (
    newScamChannels === 0 &&
    losses12h === 0 &&
    Number(telegramChannels || 0) === 0 &&
    Number(coursesProducts || 0) === 0 &&
    top3Today.length === 0 &&
    (!Array.isArray(body.top3) || body.top3.length === 0) &&
    displayTop3.length === 0
  );
  if (zeroSnapshot && incomingPublishStatus !== 'honest_zero') {
    return res.status(409).json({
      error: 'unsafe_zero_snapshot_blocked',
      message: 'Refusing to overwrite site data with a zero snapshot without honest_zero status.'
    });
  }
  let top3 = top3Today.slice(0, 3).map((ch) => ({ channel: ch, sum: 0, status: 'Активен' }));
  if (Array.isArray(body.top3) && body.top3.length && typeof body.top3[0] === 'object') {
    top3 = body.top3.slice(0, 3).map((t) => ({
      channel: t.channel || t.name || '—',
      sum: typeof t.sum === 'number' ? t.sum : (t.losses || 0),
      status: t.status || 'Активен'
    }));
  }
  const payload = {
    timestamp: body.timestamp || new Date().toISOString(),
    new_scam_channels: newScamChannels,
    new_scams: newScamChannels,
    losses_12h: losses12h,
    telegram_channels: Number.isFinite(telegramChannels) ? telegramChannels : null,
    courses_products: Number.isFinite(coursesProducts) ? coursesProducts : 0,
    courses: Number.isFinite(coursesProducts) ? coursesProducts : 0,
    top3_today: top3Today.slice(0, 3),
    top3,
    display_top3: displayTop3,
    updatedAt: body.timestamp || new Date().toISOString(),
    evidence_summary: evidenceSummary,
    risk_rows: riskRows,
    complaints_rows: complaintsRows
  };
  if (lastCycleAt != null) payload.last_cycle_at = lastCycleAt;
  payload.new_in_cycle = newInCycle;
  payload.sources_checked = sourcesChecked;
  if (body.report_doc_url != null) payload.report_doc_url = String(body.report_doc_url);
  if (Number.isFinite(Number(body.victims_12h))) payload.victims_12h = Number(body.victims_12h);
  if (body.sourceCaption != null) payload.sourceCaption = String(body.sourceCaption);
  if (incomingPublishStatus != null) payload.publishStatus = incomingPublishStatus;
  if (body.siteNotice != null) payload.siteNotice = String(body.siteNotice);
  if (body.lastValidUpdatedAt != null) payload.lastValidUpdatedAt = String(body.lastValidUpdatedAt);
  if (body.isHonestZero != null) payload.isHonestZero = Boolean(body.isHonestZero);
  if (body.historyContext && typeof body.historyContext === 'object') payload.historyContext = body.historyContext;
  if (body.selfCheck && typeof body.selfCheck === 'object') payload.selfCheck = body.selfCheck;
  try {
    const dataDir = join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(KRO_12H_STATS_PATH, JSON.stringify(payload, null, 2), 'utf8');
    const referenceSnapshot = buildKroReferenceSnapshot(payload);
    fs.writeFileSync(KRO_REFERENCE_STATS_PATH, JSON.stringify(referenceSnapshot, null, 2), 'utf8');
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('KRO update write error:', e);
    res.status(500).json({ error: 'write_failed' });
  }
}
app.post('/api/kro/update', express.json(), handleKroUpdate);
app.post('/api/update', express.json(), handleKroUpdate);

/**
 * Reads all reports for a given channel from the reports sheet (A2:H).
 * Returns array of { date, channel, sum, source, reporter, description, proof_url }.
 */
async function getAllReportsForChannel(client, channel) {
  if (!client || !kroSheetId) return [];
  try {
    const response = await client.sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: 'A2:H'
    });
    const rows = response.data.values || [];
    const key = channelMatchKey(channel);
    if (!key) return [];
    return rows.filter(r => channelMatchKey((r[1] || '').toString()) === key).map(r => ({
      date: (r[0] || '').toString().trim(),
      channel: (r[1] || '').toString().trim(),
      sum: parseInt((r[2] || '0').toString().replace(/\s/g, ''), 10) || 0,
      source: (r[3] || '').toString().trim(),
      reporter: (r[5] || '').toString().trim(),
      description: (r[6] || '').toString().trim(),
      proof_url: (r[7] || '').toString().trim(),
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Checks if a channel is already in scam_base.
 * Returns true if found with any confirmed/risk status.
 */
async function isChannelInScamBase(client, channel) {
  if (!client || !kroSheetId || !kroScamBaseRange) return false;
  try {
    const sheetName = kroScamBaseRange.split('!')[0] || 'scam_base';
    const response = await client.sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: `${sheetName}!A2:M`
    });
    const rows = response.data.values || [];
    const key = channelMatchKey(channel);
    return rows.some(r => channelMatchKey((r[0] || '').toString()) === key);
  } catch (e) {
    return false;
  }
}

/**
 * Promotes a channel to scam_base when it reaches ≥2 unique reports.
 * Unique = distinct reporter names; if all anonymous, each row counts separately.
 * Writes a v2 schema row with status 'в риске'.
 */
/**
 * Channels that must NEVER be added to scam_base.
 * Anti-scam projects, major exchanges, analytics services.
 * Use the normalised key (lowercase, no leading @).
 */
const KRO_CHANNEL_EXCLUSION = new Set([
  // Anti-scam / watchdog projects
  'cryptoscammsup', 'crypt0scamm', 'publicryptoscamm',
  'scamrsalert', 'crypto_police_list', 'scamalyst',
  // Major legitimate exchanges
  'binance', 'bybit', 'okx', 'kucoin', 'huobi', 'coinbase', 'gate_io',
  // Analytics / directory services
  'tgstat', 'telemetr', 'telega', 'telegaio',
  // Generic / service names that must never be treated as scam channels
  'gmail', 'feel340', 'support', 'admin',
]);

async function checkAndPromoteToScamBase(client, channel) {
  if (!client || !kroSheetId || !kroScamBaseRange) return;
  // Never promote excluded channels (anti-scam projects, major exchanges, etc.)
  if (KRO_CHANNEL_EXCLUSION.has(channelMatchKey(channel))) {
    console.log(`[KRO] ${channel} is in exclusion list — skipping scam_base promotion`);
    return;
  }
  try {
    const reports = await getAllReportsForChannel(client, channel);
    if (reports.length < 2) return;

    // Count unique reporters: by name if non-empty, otherwise each row is unique
    const namedReporters = reports.map(r => r.reporter).filter(Boolean);
    const uniqueCount = namedReporters.length > 0
      ? new Set(namedReporters).size + (reports.length - namedReporters.length)
      : reports.length;

    if (uniqueCount < 2) return;
    if (await isChannelInScamBase(client, channel)) return;

    const now = new Date();
    const detectedAt = now.toISOString().replace('.000', '');
    const totalLoss = reports.reduce((s, r) => s + (r.sum || 0), 0);
    const complaints = reports.length;
    const normalizedCh = channel.startsWith('@') ? channel : '@' + channel.replace(/^t\.me\//, '');
    const link = 'https://t.me/' + normalizedCh.replace(/^@/, '');
    const sourceEvidence = reports.slice(0, 3).map(r => r.description || r.proof_url).filter(Boolean).join('; ');
    const cycleWindow = now.toISOString().slice(0, 10) + (now.getUTCHours() < 12 ? '_am' : '_pm');

    const sheetName = kroScamBaseRange.split('!')[0] || 'scam_base';
    const v2Row = [[
      normalizedCh, link, detectedAt, '', '', 'сигнал-канал', '',
      complaints, totalLoss, 'form', sourceEvidence, cycleWindow, 'в риске'
    ]];
    await client.sheets.spreadsheets.values.append({
      spreadsheetId: kroSheetId,
      range: `${sheetName}!A:M`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: v2Row }
    });
    console.log(`[KRO] Promoted ${normalizedCh} to scam_base (${uniqueCount} reports, loss ${totalLoss}₽)`);
  } catch (e) {
    console.error('[KRO] checkAndPromoteToScamBase error:', e);
  }
}

app.post('/api/kro/report-scam', express.json(), async (req, res) => {
  const channel = (req.body?.channel ?? '').toString().trim();
  const sumRub = Number(req.body?.sumRub);
  const description = (req.body?.description ?? '').toString().trim();
  const proofUrl = (req.body?.proofUrl ?? '').toString().trim();
  const from = (req.body?.from ?? '').toString().trim();
  if (!channel || !Number.isFinite(sumRub) || sumRub < 0) {
    return res.status(400).json({ error: 'channel and sumRub (non-negative number) are required' });
  }
  if (!description) {
    return res.status(400).json({ error: 'description is required' });
  }
  try {
    const client = await getKroSheetsClient();
    if (!client) {
      return res.status(503).json({ error: 'live_counter_not_configured' });
    }
    const today = getTodayMSK();
    // Schema A:H — columns D=source, E=status, F=reporter, G=description, H=proof_url
    const row = [[today.dateKey, channel, sumRub, 'form', 'Активен', from || '', description, proofUrl || '']];
    await client.sheets.spreadsheets.values.append({
      spreadsheetId: kroSheetId,
      range: 'A:H',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: row }
    });
    // Auto-promote to scam_base if ≥2 unique reporters
    await checkAndPromoteToScamBase(client, channel);
    const report = await getComplaintsAndLossForChannel(client, channel);
    res.status(200).json({
      ok: true,
      complaints: report.complaints ?? null,
      total_loss: report.total_loss ?? null
    });
  } catch (e) {
    console.error('KRO report-scam error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// 12h stats для сайта (из run_12h_monitor.py → kro-12h-stats.json)
app.get('/api/kro/daily-stats', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  try {
    const p = join(__dirname, 'data', 'kro-12h-stats.json');
    if (!fs.existsSync(p)) {
      return res.json({
        new_scams: 0,
        losses_12h: 0,
        victims_12h: 0,
        telegram_channels: null,
        courses: null,
        timestamp: null,
        top3: [],
        report_doc_url: null,
        sourceCaption: null,
        evidence_summary: {},
        risk_rows: [],
        complaints_rows: [],
        updatedAt: null
      });
    }
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    const losses12h = data.losses_12h ?? data.losses ?? 0;
    res.json({
      new_scams: data.new_scams ?? 0,
      losses_12h: losses12h,
      victims_12h: data.victims_12h ?? 0,
      telegram_channels: data.telegram_channels ?? null,
      courses: data.courses ?? null,
      timestamp: data.timestamp || null,
      top3: Array.isArray(data.top3) ? data.top3 : [],
      report_doc_url: data.report_doc_url || null,
      sourceCaption: data.sourceCaption || (data.sources ? data.sources.join(', ') : null),
      evidence_summary: data.evidence_summary || {},
      risk_rows: Array.isArray(data.risk_rows) ? data.risk_rows : [],
      complaints_rows: Array.isArray(data.complaints_rows) ? data.complaints_rows : [],
      updatedAt: data.updatedAt || data.timestamp || null
    });
  } catch (e) {
    console.error('KRO daily-stats error:', e);
    res.json({
      new_scams: 0,
      losses_12h: 0,
      victims_12h: 0,
      telegram_channels: null,
      courses: null,
      timestamp: null,
      top3: [],
      report_doc_url: null,
      sourceCaption: null,
      evidence_summary: {},
      risk_rows: [],
      complaints_rows: [],
      updatedAt: null
    });
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
