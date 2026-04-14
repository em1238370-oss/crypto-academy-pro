import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, join, sep } from 'path';
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

// Карточка объекта из scam_base (до static — путь /channel/… не является файлом)
app.get(/^\/channel\/(.+)$/, (req, res, next) => {
  const tail = req.path.replace(/^\/channel\//i, '');
  if (!tail || tail.includes('..') || /%2e%2e/i.test(tail)) {
    return next();
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile('channel.html', { root: join(__dirname, '..') });
});

// /monitor до express.static — всегда свежий monitor.html + no-store (иначе залипает старый inline-скрипт)
app.get('/monitor', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile('monitor.html', { root: join(__dirname, '..') });
});

// Serve static files from parent directory (HTML, CSS, JS)
app.use(
  express.static(join(__dirname, '..'), {
    setHeaders(res, filePath) {
      const name = basename(filePath);
      if (name === 'index.html' || name === 'monitor.html' || name === 'channel.html') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
      }
      const root = join(__dirname, '..');
      if (filePath.startsWith(root + sep) && filePath.endsWith('.js')) {
        const rel = filePath.slice(root.length + 1);
        if (rel.startsWith('scripts' + sep)) {
          res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        }
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
const kroChannelsWatchRange = process.env.KRO_CHANNELS_WATCH_RANGE || 'channels_watch!A2:P';
const kroChannelsNetworkRange = process.env.KRO_CHANNELS_NETWORK_RANGE || 'channels_network!A2:G';
const kroMetaRange = process.env.KRO_META_RANGE || 'kro_meta!A:B';
const kroCheckQueueRange = process.env.KRO_CHECK_QUEUE_RANGE || '';
/** Окно истории постов для живой проверки (check_once): только 30, 180 или 365. По умолчанию год — главный сценарий «полная проверка канала». */
const kroCheckOncePeriodDaysParsed = parseInt(process.env.KRO_CHECK_ONCE_PERIOD_DAYS || '365', 10);
const kroCheckOncePeriodDays = [30, 180, 365].includes(kroCheckOncePeriodDaysParsed) ? kroCheckOncePeriodDaysParsed : 30;
const kroCheckOnceTimeoutMsParsed = parseInt(process.env.KRO_CHECK_ONCE_TIMEOUT_MS || '', 10);
/** Полная выборка Telegram может занять минуты — не обрывать раньше 2 мин и позже 20 мин. */
const kroCheckOnceTimeoutMs = Number.isFinite(kroCheckOnceTimeoutMsParsed) && kroCheckOnceTimeoutMsParsed >= 120000 && kroCheckOnceTimeoutMsParsed <= 1200000
  ? kroCheckOnceTimeoutMsParsed
  : 600000;

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

function ruPoKanalamPhrase(n) {
  const k = Math.max(0, Math.floor(Number(n) || 0));
  if (k === 0) return '0 каналам';
  const m = k % 100;
  const m1 = k % 10;
  if (m > 10 && m < 20) return `${k} каналам`;
  if (m1 === 1) return `${k} каналу`;
  return `${k} каналам`;
}

/** Текст шок-блока на главной: сумма total_loss_rub по всей dedup-базе scam_base. */
function buildKroDocumentedShockText(lossesRub, channelCount) {
  const loss = Math.max(0, Math.round(Number(lossesRub) || 0));
  const ch = Math.max(0, Math.floor(Number(channelCount) || 0));
  if (ch <= 0 && loss <= 0) return null;
  return `Всего задокументировано потерь: ${loss.toLocaleString('ru-RU')} ₽ по ${ruPoKanalamPhrase(ch)}.`;
}
// Без TTL: live-counter и kro_meta всегда читаются из Sheets на каждый запрос (иначе после деплоя
// или смены таблицы возможен устаревший снимок; in-memory кеш не заменяет CDN).
const LIVE_COUNTER_CACHE_TTL_MS = 0;
let kroLiveCounterCache = { payload: null, ts: 0 };

function resetKroLiveCounterCache() {
  kroLiveCounterCache = { payload: null, ts: 0 };
}

// Новый процесс Node = старт после деплоя (Render и т.д.) — сброс кеша live-counter.
resetKroLiveCounterCache();

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
    const n = normalizeTelegramTmeUrl(raw) || raw;
    const seg = (n.replace(/^https?:\/\/t\.me\//i, '').split('/')[0] || '').replace(/^@+/, '');
    return seg ? `@${seg}` : `@${raw.replace(/^@+/, '')}`;
  }
  return `@${raw.replace(/^@+/, '')}`;
}

function channelUrlForMonitorCase(ch) {
  const raw = String(ch || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    const n = normalizeTelegramTmeUrl(raw);
    return n || raw;
  }
  const name = raw.replace(/^@+/, '').replace(/^%40+/i, '');
  return name ? `https://t.me/${name}` : '';
}

/** Extract http(s) URLs from a string (evidence, primary source cell). */
function collectUrlsFromString(s) {
  if (!s || typeof s !== 'string') return [];
  const matches = s.match(/https?:\/\/[^\s\])'"<>|]+/g) || [];
  return matches.map((m) => m.replace(/[),.;]+$/g, ''));
}

/** Синхронно с monitor.html: путь t.me без @ и без %40 в сегментах. */
function telegramPathSegmentsForTme(pathname) {
  let pathRaw = pathname || '/';
  try {
    pathRaw = decodeURIComponent(pathRaw);
  } catch {
    /* ignore */
  }
  pathRaw = pathRaw.replace(/\/@+/g, '/');
  return pathRaw
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      const q = seg.indexOf('?');
      const base = q >= 0 ? seg.slice(0, q) : seg;
      return base.replace(/^@+/, '').replace(/^(%40)+/gi, '');
    })
    .filter(Boolean);
}

/** tg://resolve?domain=username → https://t.me/username */
function normalizeTgResolveToHttps(raw) {
  const s = String(raw || '').trim();
  if (!/^tg:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    if ((u.hostname || '').toLowerCase() !== 'resolve') return '';
    const domain = String(u.searchParams.get('domain') || '')
      .trim()
      .replace(/^@+/, '')
      .replace(/^(%40)+/gi, '');
    if (/^[a-zA-Z0-9_]{3,64}$/.test(domain)) return `https://t.me/${domain}`;
  } catch {
    /* ignore */
  }
  return '';
}

/** https://t.me/username, никогда https://t.me/@username (иначе Telegram показывает «канал не существует»). */
function normalizeTelegramTmeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u = s;
  if (!/^https?:\/\//i.test(u)) {
    if (/^t\.me\//i.test(u)) u = `https://${u}`;
    else if (/^telegram\.me\//i.test(u)) u = `https://${u}`;
    else return '';
  }
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 't.me' && host !== 'telegram.me') return '';
    const search = parsed.search || '';
    const segments = telegramPathSegmentsForTme(parsed.pathname || '/');
    if (!segments.length) return '';
    const p0 = segments[0];
    const p1 = segments[1] || '';
    if (p0.toLowerCase() === 'joinchat' && p1) {
      const jh = p1.replace(/^@+/, '').replace(/^(%40)+/gi, '');
      if (!/^[\w-]+$/.test(jh)) return '';
      return `https://t.me/joinchat/${jh}${search}`;
    }
    if (p0.charAt(0) === '+') {
      const inv = p0.slice(1).replace(/^@+/, '').replace(/^(%40)+/gi, '');
      if (!/^[\w-]+$/.test(inv)) return '';
      return `https://t.me/+${inv}${search}`;
    }
    if (p0 === 's' && p1) {
      const un = p1.replace(/^@+/, '').replace(/^(%40)+/gi, '');
      if (!/^[a-zA-Z0-9_]{3,64}$/.test(un)) return '';
      return `https://t.me/${un}${search}`;
    }
    return `https://t.me/${segments.join('/')}${search}`;
  } catch {
    return '';
  }
}

/**
 * Очистка ссылки из Sheets: путь t.me без @/%40, telegram.me → t.me, tg://resolve → https.
 * Не-телеграм http(s) возвращает как есть; голый @username → https://t.me/username.
 */
function cleanTelegramLink(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const fromTg = normalizeTgResolveToHttps(s);
  if (fromTg) return fromTg;
  if (/^tg:\/\//i.test(s)) return '';
  if (/t\.me|telegram\.me/i.test(s)) {
    const n = normalizeTelegramTmeUrl(s);
    return n || s;
  }
  const bare = s.replace(/^@+/, '').replace(/^(%40)+/gi, '');
  if (
    /^[a-zA-Z0-9_]{3,64}$/.test(bare) &&
    !/^https?:\/\//i.test(s) &&
    !s.includes('/')
  ) {
    return `https://t.me/${bare}`;
  }
  return s;
}

function maybeNormalizeSheetTelegramLink(link) {
  return cleanTelegramLink(String(link || '').trim());
}

function parseScamBaseTotalLossRub(row) {
  if (!row) return 0;
  if (row._schema === 'v2') {
    return Math.max(0, Math.round(Number(row.total_loss_rub) || 0));
  }
  const raw = String(row.total_loss ?? '')
    .replace(/\s/g, '')
    .replace(/,/g, '.');
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function scamBaseRowHasEvidenceOrLoss(row) {
  const loss = parseScamBaseTotalLossRub(row);
  const ev = String(row.source_evidence || '').trim();
  return loss > 0 || ev.length > 0;
}

function pickScamBaseCaseSource(row) {
  const urls = [
    ...new Set([
      ...collectUrlsFromString(row.source_evidence || ''),
      ...collectUrlsFromString(row.source_primary || ''),
    ]),
  ];
  const external = urls.find((u) => !/t\.me\//i.test(u));
  if (external) return { url: external, kind: 'external' };
  const link = maybeNormalizeSheetTelegramLink(String(row.link || '').trim());
  if (/^https?:\/\//i.test(link)) return { url: link, kind: 'telegram' };
  if (urls.length) {
    const u0 = urls[0];
    const u0n = /t\.me|telegram\.me/i.test(u0) ? normalizeTelegramTmeUrl(u0) || u0 : u0;
    return { url: u0n, kind: 'telegram' };
  }
  const slug = encodeURIComponent(String(row.username || '').trim().replace(/^@+/, ''));
  if (slug) return { url: `/channel/${slug}`, kind: 'monitor' };
  return { url: '/monitor#data-scam', kind: 'monitor' };
}

function buildMonitorCaseSummaryFromScamRow(row) {
  const complaints = Math.max(0, Math.floor(Number(row.complaints) || 0));
  const losses = parseScamBaseTotalLossRub(row);
  const ot = String(row.object_type || '').trim();
  const st = String(row.status || '').trim();
  let s;
  if (row._schema === 'v2') {
    if (complaints > 0 && losses > 0) {
      s = `По каналу — ${complaints} ${ruComplaintsWord(complaints)}, в суммах фигурирует порядка ${fmtRubSpaces(losses)} ₽.`;
    } else if (complaints > 0) {
      s = `В открытых источниках и форме по каналу зафиксировано ${complaints} ${ruComplaintsWord(complaints)}.`;
    } else if (losses > 0) {
      s = `В базе зафиксированы потери порядка ${fmtRubSpaces(losses)} ₽.`;
    } else if (String(row.source_evidence || '').trim()) {
      const ev = String(row.source_evidence || '')
        .trim()
        .replace(/\s+/g, ' ');
      s = ev.length > 220 ? `${ev.slice(0, 217)}…` : ev;
    } else if (ot || st) {
      s = [ot && `Тип: ${ot}`, st && `Статус: ${st}`].filter(Boolean).join('. ');
      if (s) s += '.';
      else s = 'Запись в базе подтверждённых объектов — детали в таблице и карточке канала.';
    } else {
      s = 'Запись в базе подтверждённых объектов — детали в таблице и карточке канала.';
    }
  } else {
    if (complaints > 0 && losses > 0) {
      s = `По каналу — ${complaints} ${ruComplaintsWord(complaints)}, сумма потерь около ${fmtRubSpaces(losses)} ₽.`;
    } else if (losses > 0) {
      s = `В базе указаны потери порядка ${fmtRubSpaces(losses)} ₽.`;
    } else if (complaints > 0) {
      s = `Зафиксировано ${complaints} ${ruComplaintsWord(complaints)}.`;
    } else {
      s = 'Канал в базе скам-объектов (запись в устаревшем формате).';
    }
  }
  if (s.length > 280) return `${s.slice(0, 277)}…`;
  return s;
}

function scamRowToMonitorCase(row) {
  const channel = String(row.username || '').trim();
  const lossRub = parseScamBaseTotalLossRub(row);
  const link = String(row.link || '').trim();
  const channel_url = /^https?:\/\//i.test(link) ? link : channelUrlForMonitorCase(channel);
  const src = pickScamBaseCaseSource(row);
  return {
    channel,
    channel_label: channelLabelForMonitorCase(channel),
    channel_url,
    loss_rub: lossRub,
    summary: buildMonitorCaseSummaryFromScamRow(row),
    source_url: src.url,
    source_kind: src.kind,
  };
}

/** Время строки scam_base для сортировки «сначала новее»: detected_at, иначе created_at. */
function scamBaseRowSortMs(row) {
  if (!row) return 0;
  const d = parseScamDetectedAtMs(row);
  if (d) return d;
  const c = (row.created_at || '').toString().trim();
  if (c) {
    const p = Date.parse(c);
    if (Number.isFinite(p)) return p;
  }
  return 0;
}

/**
 * Карточки «Последние случаи» на /monitor: только scam_base.
 * Сначала до N самых свежих по дате с total_loss > 0 или непустым source_evidence;
 * если таких меньше N — добираем самыми свежими по дате из остальных.
 */
function buildMonitorRecentCasesFromScamBase(scamRows, limit = 3) {
  const rows = (scamRows || []).filter(
    (r) => r && String(r.username || '').trim() && r.username !== 'username'
  );
  if (!rows.length) return [];

  const sortedAll = [...rows].sort((a, b) => scamBaseRowSortMs(b) - scamBaseRowSortMs(a));
  const preferred = sortedAll.filter(scamBaseRowHasEvidenceOrLoss);
  const picked = [];
  for (const r of preferred) {
    if (picked.length >= limit) break;
    picked.push(r);
  }
  if (picked.length < limit) {
    for (const r of sortedAll) {
      if (picked.length >= limit) break;
      if (picked.indexOf(r) !== -1) continue;
      picked.push(r);
    }
  }
  return picked.slice(0, limit).map(scamRowToMonitorCase);
}

const KRO_FALLBACK = {
  channelsToday: 0,
  channelsTotal: 0,
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

/**
 * В kro_meta ячейка last_cycle_at в API часто приходит как serial (дни от 30.12.1899), не как ISO.
 * Тогда new Date(String(serial)).getTime() === NaN и live-counter ошибочно берёт updatedAt из scam_base.
 */
function coerceKroMetaLastCycleAtToIso(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = (raw - 25569) * 86400 * 1000;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    if (Number.isFinite(n) && n > 20000 && n < 600000) {
      const ms = (n - 25569) * 86400 * 1000;
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }
  // Ручной ввод / документ: «07.04.2026 18:42 MSK» (фиксированное UTC+3)
  const msk = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*MSK$/i);
  if (msk) {
    const day = Number(msk[1]);
    const month = Number(msk[2]);
    const year = Number(msk[3]);
    const hour = Number(msk[4]);
    const minute = Number(msk[5]);
    const second = msk[6] ? Number(msk[6]) : 0;
    const utcMs = Date.UTC(year, month - 1, day, hour - 3, minute, second);
    if (Number.isFinite(utcMs)) return new Date(utcMs).toISOString();
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseKroCycleMetaRows(rows) {
  const values = {};
  for (const row of rows || []) {
    const key = String(row?.[0] || '').trim();
    const value = row?.[1];
    if (!key) continue;
    // Воркер пишет шапку «key | value» в A1:B1 — не кладём её в map как обычный ключ.
    if (/^key$/i.test(key) && String(value ?? '').trim().toLowerCase() === 'value') continue;
    values[key] = value;
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
  const rawLc = values.last_cycle_at;
  const isoLc = coerceKroMetaLastCycleAtToIso(rawLc);
  const last_cycle_at =
    isoLc || (rawLc != null && String(rawLc).trim() ? String(rawLc).trim() : null);
  const rawNic = values.new_in_cycle;
  let new_in_cycle = 0;
  if (rawNic != null && rawNic !== '') {
    const n = parseInt(String(rawNic).replace(/\s/g, ''), 10);
    if (Number.isFinite(n) && n >= 0) new_in_cycle = n;
  }
  let false_positive_signals = 0;
  const rawFp = values.false_positive_signals;
  if (rawFp != null && rawFp !== '') {
    const n = parseInt(String(rawFp).replace(/\s/g, ''), 10);
    if (Number.isFinite(n) && n >= 0) false_positive_signals = n;
  }
  let avg_source_weight = null;
  const rawAw = values.avg_source_weight;
  if (rawAw != null && String(rawAw).trim() !== '') {
    const a = parseFloat(String(rawAw).replace(',', '.'));
    if (Number.isFinite(a)) avg_source_weight = a;
  }
  let channels_with_complaints_only = 0;
  const rawCo = values.channels_with_complaints_only;
  if (rawCo != null && rawCo !== '') {
    const n2 = parseInt(String(rawCo).replace(/\s/g, ''), 10);
    if (Number.isFinite(n2) && n2 >= 0) channels_with_complaints_only = n2;
  }
  let avg_complaint_quality = null;
  const rawAq = values.avg_complaint_quality;
  if (rawAq != null && String(rawAq).trim() !== '') {
    const aq = parseFloat(String(rawAq).replace(',', '.'));
    if (Number.isFinite(aq)) avg_complaint_quality = aq;
  }
  let scam_base_rows_below_min_weight = 0;
  const rawBw = values.scam_base_rows_below_min_weight;
  if (rawBw != null && rawBw !== '') {
    const nb = parseInt(String(rawBw).replace(/\s/g, ''), 10);
    if (Number.isFinite(nb) && nb >= 0) scam_base_rows_below_min_weight = nb;
  }
  let channels_network_edges = 0;
  const rawNe = values.channels_network_edges;
  if (rawNe != null && rawNe !== '') {
    const ne = parseInt(String(rawNe).replace(/\s/g, ''), 10);
    if (Number.isFinite(ne) && ne >= 0) channels_network_edges = ne;
  }
  let min_source_weight_policy = null;
  const rawMw = values.min_source_weight_policy;
  if (rawMw != null && String(rawMw).trim() !== '') {
    const mw = parseFloat(String(rawMw).replace(',', '.'));
    if (Number.isFinite(mw)) min_source_weight_policy = mw;
  }
  let young_with_complaints_in_base = 0;
  const rawYw = values.young_with_complaints_in_base;
  if (rawYw != null && rawYw !== '') {
    const yw = parseInt(String(rawYw).replace(/\s/g, ''), 10);
    if (Number.isFinite(yw) && yw >= 0) young_with_complaints_in_base = yw;
  }
  let channels_scanned_in_cycle = 0;
  const rawScan = values.channels_scanned_in_cycle;
  if (rawScan != null && rawScan !== '') {
    const sc = parseInt(String(rawScan).replace(/\s/g, ''), 10);
    if (Number.isFinite(sc) && sc >= 0) channels_scanned_in_cycle = sc;
  }
  return {
    last_cycle_at,
    new_in_cycle,
    channels_scanned_in_cycle,
    sources_checked,
    false_positive_signals,
    avg_source_weight,
    channels_with_complaints_only,
    avg_complaint_quality,
    scam_base_rows_below_min_weight,
    channels_network_edges,
    min_source_weight_policy,
    young_with_complaints_in_base,
  };
}

const KRO_META_EMPTY = {
  last_cycle_at: null,
  new_in_cycle: 0,
  channels_scanned_in_cycle: 0,
  sources_checked: [],
  false_positive_signals: 0,
  avg_source_weight: null,
  channels_with_complaints_only: 0,
  avg_complaint_quality: null,
  scam_base_rows_below_min_weight: 0,
  channels_network_edges: 0,
  min_source_weight_policy: null,
  young_with_complaints_in_base: 0,
};

async function readKroCycleMetaFromSheets(sheetsClient) {
  if (!sheetsClient || !kroSheetId) {
    return { ...KRO_META_EMPTY };
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
    return { ...KRO_META_EMPTY };
  }
}

function normalizeKroShockText(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return /73\s+человек.*гаранти[яи]\s+прибыли/i.test(value) ? KRO_PENDING_REPORT_TEXT : value;
}

function hasKroVisibleData(data) {
  if (!data || typeof data !== 'object') return false;
  const channelsToday = pickFirstNumber(data.new_scam_channels, data.new_scams, data.channelsToday);
  const scanned = pickFirstNumber(data.channels_scanned_in_cycle);
  const totalLost = pickFirstNumber(data.losses_12h, data.totalLost);
  const telegramCount = pickFirstNumber(data.telegram_channels, data.telegramCount);
  const coursesCount = pickFirstNumber(data.courses_products, data.courses, data.coursesCount);
  const top3 = Array.isArray(data.display_top3) && data.display_top3.length ? data.display_top3 : data.top3;
  const channelsTotal = pickFirstNumber(data.channelsTotal);
  return (
    Number(channelsToday || 0) > 0 ||
    Number(scanned || 0) > 0 ||
    Number(channelsTotal || 0) > 0 ||
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
    channelsTotal: pickFirstNumber(data.channelsTotal),
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
    channelsTotal: pickFirstNumber(data.channelsTotal),
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
  const scanned = pickFirstNumber(data.channels_scanned_in_cycle);
  const losses12h = pickFirstNumber(data.losses_12h, data.totalLost);
  const telegramChannels = pickFirstNumber(data.telegram_channels, data.telegramCount);
  const coursesProducts = pickFirstNumber(data.courses_products, data.courses, data.coursesCount);
  const primaryTop3 = Array.isArray(data.display_top3) && data.display_top3.length ? data.display_top3 : data.top3;
  return (
    Number(newScamChannels || 0) === 0 &&
    Number(scanned || 0) === 0 &&
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

function scamBaseRowLooksV2(row) {
  if (!row || row.length < 13) return false;
  const detected = (row[2] || '').toString().trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(detected)) return true;
  if (/^\d{4}-\d{2}-\d{2}[ ]\d{2}:\d{2}/.test(detected)) return true;
  // Лист часто хранит дату обнаружения как 03.04.2026 — без этого всё уходило в v1 и пропадало с монитора.
  if (/^\d{1,2}\.\d{1,2}\.\d{4}/.test(detected)) return true;
  const link = (row[1] || '').toString().trim();
  if (/^https?:\/\//i.test(link)) return true;
  return false;
}

function parseScamBaseRow(row) {
  const username = (row[0] || '').toString().trim();
  // Detect schema version by column count:
  // new v2 (13-14 cols A–N): username | link | detected_at | created_at | channel_age_days | object_type | vip_price | complaints | total_loss_rub | source_primary | source_evidence | cycle_window | status | content_analysis
  // old v1 (8 cols):      username | risk_score | ads_per_week | bot_pct | vip_price | complaints | total_loss | verdict
  if (scamBaseRowLooksV2(row)) {
    // new v2 schema
    const link = cleanTelegramLink((row[1] || '').toString().trim());
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

const REQUIRED_CRYPTO_HINTS = [
  'крипта', 'крипто', 'crypto', 'bitcoin', 'btc', 'usdt', 'трейдинг', 'trading',
  'обменник', 'exchange', 'инвестиции', 'инвест', 'сигнал', 'signal',
];
const NON_CRYPTO_HINTS = [
  'недвижим', 'квартир', 'новострой', 'ипотек', 'риелт', 'аренд',
  'автомоб', 'машин', 'дилер', 'real estate', 'car ', 'mortgage',
  'футбол', 'футболь', 'fc ', 'чемпионат мира', 'premier league', 'soccer',
];

function isCryptoContextAllowed(...parts) {
  const blob = parts.map((x) => (x == null ? '' : String(x))).join(' ').toLowerCase();
  if (!blob.trim()) return false;
  if (NON_CRYPTO_HINTS.some((h) => blob.includes(h))) return false;
  return REQUIRED_CRYPTO_HINTS.some((h) => blob.includes(h));
}

/** Явно не крипто-вертикаль (недвижимость, авто и т.д.) — для публичного счётчика и монитора. */
function isBlatantNonCryptoVerticalInScamBaseRow(...parts) {
  const blob = parts.map((x) => (x == null ? '' : String(x))).join(' ').toLowerCase();
  if (!blob.trim()) return false;
  return NON_CRYPTO_HINTS.some((h) => blob.includes(h));
}

function normalizeRiskStatusByLoss(totalLossRub, status) {
  const base = (status || '').toString().trim();
  const loss = Number(totalLossRub) || 0;
  const low = normalizeKroStatusBlob(base);
  const isConfirmedScam = low.includes('подтвержд') && low.includes('скам');
  if (loss > 0) {
    if (isConfirmedScam) return base;
    if (!base || base === 'без нарушений' || base === 'под наблюдением') return 'в риске';
    if (low.includes('в риске')) return base;
    if (low.includes('не по теме')) return 'в риске';
    return 'в риске';
  }
  return base || 'под наблюдением';
}

function statusWithLossFloor(status, totalLossRub) {
  return normalizeRiskStatusByLoss(totalLossRub, status);
}

/** Нормализация статуса: NFKC, NBSP→пробел, схлопывание пробелов — чтобы ловить «не по теме» и off_topic стабильно. */
function normalizeKroStatusBlob(s) {
  return (s ?? '')
    .toString()
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Статус «не по теме» — не показываем в публичном API (главная, монитор). */
function isOffTopicScamBaseStatus(status, verdict) {
  const blob = normalizeKroStatusBlob(`${status ?? ''} ${verdict ?? ''}`);
  return (
    blob.includes('не по теме') ||
    blob.includes('off_topic') ||
    blob.includes('off topic') ||
    blob.includes('непотеме')
  );
}

function buildStatusSummary(rows) {
  const summary = {
    confirmed_scam: 0,
    at_risk: 0,
    under_watch: 0,
    no_violations: 0,
    off_topic: 0,
    unknown: 0,
  };
  for (const row of rows || []) {
    const s = normalizeKroStatusBlob(row?.status || '');
    if (s.includes('подтвержд') && s.includes('скам')) {
      summary.confirmed_scam += 1;
    } else if (s.includes('в риске')) {
      summary.at_risk += 1;
    } else if (s.includes('под наблюдением')) {
      summary.under_watch += 1;
    } else if (s.includes('без нарушений') || s.includes('без риска')) {
      summary.no_violations += 1;
    } else if (
      s.includes('не по теме') ||
      s.includes('off_topic') ||
      s.includes('off topic') ||
      s.includes('непотеме')
    ) {
      summary.off_topic += 1;
    } else {
      summary.unknown += 1;
    }
  }
  return summary;
}

function isVisibleScamStatus(status) {
  const s = (status || '').toString().trim().toLowerCase();
  if (!s) return true;
  if (s.includes('удал')) return false;
  if (s.includes('неактив')) return false;
  return true;
}

/** Одна строка на канал: оставляем самую свежую по дате обнаружения (дубликаты в листе не раздувают API/монитор). */
function dedupeScamBaseRowsByChannelLatest(rows) {
  const byChannel = new Map();
  for (const row of rows || []) {
    const key = channelMatchKey(row.username);
    if (!key) continue;
    const prev = byChannel.get(key);
    if (!prev || parseScamDetectedAtMs(row) >= parseScamDetectedAtMs(prev)) {
      byChannel.set(key, row);
    }
  }
  return Array.from(byChannel.values()).sort(
    (a, b) => parseScamDetectedAtMs(b) - parseScamDetectedAtMs(a),
  );
}

/** Тот же набор строк scam_base, что и в GET /api/kro/live-counter (главная и цифры). */
function isScamBaseRowInLiveCounterDataset(r) {
  if (!r || !r.username) return false;
  if (kroUsernameGloballyExcluded(r.username)) return false;
  // Старый лист (8 колонок): только осмысленные подтверждённые строки.
  if (r._schema === 'v1') {
    if (!isUsableScamBaseRow(r)) return false;
    if (isOffTopicScamBaseStatus(null, r.verdict)) return false;
    if (gamblingTopicHit(r.username, r.verdict, r.vip_price, r.total_loss, r.bot_pct)) return false;
    return !isBlatantNonCryptoVerticalInScamBaseRow(
      r.username,
      r.verdict,
      r.vip_price,
      r.total_loss
    );
  }
  if (r._schema !== 'v2' || !isVisibleScamStatus(r.status)) return false;
  if (isOffTopicScamBaseStatus(r.status, null)) return false;
  if (
    gamblingTopicHit(
      r.username,
      r.object_type,
      r.source_primary,
      r.source_evidence,
      r.content_analysis
    )
  ) {
    return false;
  }
  // Строка уже попала в scam_base после отбора — не требуем повторно слова «крипта» в ячейках,
  // иначе монитор и главная оказываются пустыми при коротком @username и ссылке без ключевых слов.
  if (
    isBlatantNonCryptoVerticalInScamBaseRow(
      r.username,
      r.object_type,
      r.source_primary,
      r.source_evidence,
      r.content_analysis
    )
  ) {
    return false;
  }
  return true;
}

/** Число строк на листе отчётов (первая вкладка), source = form — жалобы через форму сайта. */
async function countReportsFormRows(client) {
  if (!client || !kroSheetId) return null;
  try {
    const response = await client.sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: 'A2:I'
    });
    const rows = response.data.values || [];
    let n = 0;
    for (const r of rows) {
      const src = (r[3] || '').toString().trim().toLowerCase();
      if (src === 'form') n += 1;
    }
    return n;
  } catch (e) {
    console.warn('countReportsFormRows:', e?.message);
    return null;
  }
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
      ? 'Ленту постов сейчас не удалось подключить; ниже сохранённые данные по этой записи.'
      : 'Разбор постов для этой записи ещё не загружен; ниже сохранённые поля.',
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
  const link = maybeNormalizeSheetTelegramLink((row[1] || '').toString().trim());
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
  const status_reason = (row[13] || '').toString().trim();
  const evidence_url = (row[14] || '').toString().trim();
  const last_checked_at = (row[15] || '').toString().trim();
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
    status_reason,
    evidence_url,
    last_checked_at,
    object_type: 'широкий мониторинг',
    verdict: 'watch',
    _schema: 'watch_v2',
  };
}

function isVisibleChannelsWatchRow(row) {
  if (!row || !row.username) return false;
  if (kroUsernameGloballyExcluded(row.username)) return false;
  if (!isVisibleScamStatus(row.status)) return false;
  if (isOffTopicScamBaseStatus(row.status, row.verdict)) return false;
  if (
    gamblingTopicHit(
      row.username,
      row.source_primary,
      row.activity_summary,
      row.reviews_summary,
      row.source_evidence,
      row.status_reason,
      row.evidence_url,
    )
  ) {
    return false;
  }
  if (
    isBlatantNonCryptoVerticalInScamBaseRow(
      row.username,
      row.source_primary,
      row.activity_summary,
      row.reviews_summary,
      row.source_evidence,
      row.status_reason,
      row.evidence_url,
    )
  ) {
    return false;
  }
  return isCryptoContextAllowed(
    row.username,
    row.source_primary,
    row.activity_summary,
    row.reviews_summary,
    row.source_evidence,
    row.status_reason,
  );
}

function kroWatchRowFreshnessMs(w) {
  if (!w) return 0;
  const lc = Date.parse((w.last_checked_at || '').trim());
  const lcMs = Number.isFinite(lc) ? lc : 0;
  return Math.max(parseScamDetectedAtMs(w), lcMs);
}

/** Последняя видимая строка channels_watch по ключу канала (как в мониторинге). */
async function fetchLatestChannelsWatchRowForKey(client, key) {
  if (!client || !kroSheetId || !key || !kroChannelsWatchRange) return null;
  try {
    const resp = await client.sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: kroChannelsWatchRange,
    });
    const raw = resp.data.values || [];
    let best = null;
    let bestMs = -1;
    for (const row of raw) {
      const r = parseChannelsWatchRow(row);
      if (!r || !r.username) continue;
      if (channelMatchKey(r.username) !== key) continue;
      if (!isVisibleChannelsWatchRow(r)) continue;
      const ms = kroWatchRowFreshnessMs(r);
      if (ms >= bestMs) {
        bestMs = ms;
        best = r;
      }
    }
    return best;
  } catch (e) {
    console.warn('fetchLatestChannelsWatchRowForKey:', e?.message);
    return null;
  }
}

function kroV0TrimSentence(s, maxLen) {
  const t = (s || '').toString().replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** Подмешивает в уже собранный analysis сигналы широкого мониторинга (без смены схемы). */
/** Когда в scam_base нет строки — поясняем, что отчёт всё равно строится (живая проверка + мониторинг). */
function kroV0PrependNoScamBaseCardNote(analysis) {
  if (!analysis || typeof analysis !== 'object') return;
  const line =
    'В подтверждённой базе scam_base этой записи не было — ниже разовая проверка ленты Telegram и данные широкого мониторинга (если строка есть).';
  const bi = Array.isArray(analysis.basic_info) ? analysis.basic_info : [];
  if (bi.some((x) => /scam_base.*не было|разовая проверка ленты/i.test(String(x)))) return;
  analysis.basic_info = [line, ...bi].slice(0, 5);
}

function kroV0EnrichAnalysisWithWatch(analysis, watch) {
  if (!analysis || typeof analysis !== 'object' || !watch) return;
  const st = (watch.status || '').toString().trim();
  const lc = (watch.last_checked_at || '').toString().trim();
  let watchHead = '';
  if (st || lc) {
    watchHead = `Широкий мониторинг: «${st || '—'}»${lc ? `, обновлено ${lc}` : ''}.`;
  }
  const actLine = kroV0TrimSentence(watch.activity_summary, 190);
  const actBullet = actLine ? `Активность по циклам мониторинга: ${actLine}` : '';
  const rwLine = kroV0TrimSentence(watch.reviews_summary, 170);
  const tiesBullet = rwLine ? `Репутация/связи (мониторинг): ${rwLine}` : '';
  const wc = Number(watch.complaints) || 0;
  const watchCompl = wc > 0 ? `В строке широкого мониторинга: ${wc} жалоб(ы).` : '';
  const srLine = kroV0TrimSentence(watch.status_reason, 150);
  const reasonBullet = srLine ? `Пояснение статуса: ${srLine}` : '';

  if (watchHead) {
    analysis.basic_info = [watchHead, ...(analysis.basic_info || [])].slice(0, 5);
  }
  if (actBullet) {
    analysis.content_behavior = [actBullet, ...(analysis.content_behavior || [])].slice(0, 3);
  }
  const ex = [...(analysis.external_reports || [])];
  if (watchCompl) ex.unshift(watchCompl);
  if (reasonBullet && ex.length < 2) ex.push(reasonBullet);
  analysis.external_reports = ex.slice(0, 2);
  const ti = [...(analysis.ties_risk_factors || [])];
  if (tiesBullet) ti.unshift(tiesBullet);
  analysis.ties_risk_factors = ti.slice(0, 2);

  const src = Array.isArray(analysis.sources) ? analysis.sources : [];
  if (!src.includes('широкий мониторинг')) analysis.sources = [...src, 'широкий мониторинг'];
}

function buildVisibleChannelsWatchSummary(rows) {
  const filteredRows = (rows || []).filter(isVisibleChannelsWatchRow);
  const byChannel = new Map();
  for (const row of filteredRows) {
    const key = channelMatchKey(row.username);
    if (!key) continue;
    const prev = byChannel.get(key);
    if (!prev || parseScamDetectedAtMs(row) >= parseScamDetectedAtMs(prev)) {
      byChannel.set(key, row);
    }
  }
  const latestRows = Array.from(byChannel.values());
  const statusSummary = buildStatusSummary(latestRows);
  return {
    visible_total: latestRows.length,
    under_watch_total: statusSummary.under_watch,
    status_summary: statusSummary,
  };
}

function parseChannelsNetworkRow(row) {
  const source_channel = (row[0] || '').toString().trim();
  const target_channel = (row[1] || '').toString().trim();
  if (!source_channel || !target_channel) return null;
  const postRaw = (row[6] || '').toString().trim();
  return {
    source_channel,
    target_channel,
    relation: (row[2] || '').toString().trim(),
    detected_at: (row[3] || '').toString().trim(),
    last_post_at: (row[4] || '').toString().trim(),
    evidence: (row[5] || '').toString().trim(),
    post_url: maybeNormalizeSheetTelegramLink(postRaw) || postRaw,
  };
}

/**
 * Build live-counter payload from scam_base v2 rows (подтверждённые объекты, дедуп по каналу).
 * Всегда возвращает объект; при пустой базе — нули и honest_zero.
 */
function buildLiveCounterFromScamBase(parsedRows) {
  // ПРАВИЛО: показываем только проверенные данные с источниками
  // Принцип проекта: лучше меньше но правда
  // Каналы со статусом 'не по теме' скрыты от пользователя (isScamBaseRowInLiveCounterDataset)
  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;

  // All confirmed rows (v2 schema) — survive restarts, not limited by time window
  const filteredRows = parsedRows.filter(isScamBaseRowInLiveCounterDataset);
  const byChannel = new Map();
  for (const row of filteredRows) {
    const key = channelMatchKey(row.username);
    if (!key) continue;
    const prev = byChannel.get(key);
    if (!prev || parseScamDetectedAtMs(row) >= parseScamDetectedAtMs(prev)) {
      byChannel.set(key, row);
    }
  }
  const allRows = Array.from(byChannel.values());
  const channels_total = allRows.length;

  // Сумма total_loss_rub по всей dedup-базе (имя поля losses_12h — историческое).
  const losses_12h = allRows.reduce((s, r) => s + (r.total_loss_rub || 0), 0);

  // telegramCount = ALL confirmed telegram signal channels in scam_base
  const telegram_channels = allRows.filter(r =>
    (r.object_type || '').toLowerCase().includes('сигнал') || !(r.object_type || '').trim()
  ).length;
  const courses_products = allRows.filter(r =>
    ['курс', 'сайт', 'обучен', 'обменник', 'инвест'].some(kw => (r.object_type || '').toLowerCase().includes(kw))
  ).length;

  // Top-3 from all rows by total loss
  const complaints_received = allRows.reduce((s, r) => s + (Number(r.complaints) || 0), 0);

  const top3 = [...allRows]
    .sort((a, b) => (b.total_loss_rub || 0) - (a.total_loss_rub || 0))
    .slice(0, 3)
    .map(r => ({
      channel: r.username,
      sum: r.total_loss_rub || 0,
      status: statusWithLossFloor(r.status, r.total_loss_rub || 0),
      link: r.link || ''
    }));

  const latestDetected = allRows.reduce((best, r) => {
    try { const t = new Date(r.detected_at || 0).getTime(); return t > best ? t : best; } catch { return best; }
  }, 0);

  const isHonestZero = channels_total === 0;
  const status_summary = buildStatusSummary(allRows);
  return {
    channels_total,
    new_scam_channels: channels_total,
    losses_12h,
    telegram_channels,
    courses_products,
    complaints_received,
    top3,
    status_summary,
    publishStatus: isHonestZero ? 'honest_zero' : 'valid',
    isHonestZero,
    updatedAt: latestDetected ? new Date(latestDetected).toISOString() : new Date().toISOString(),
    sourceCaption: `Данные из Google Sheets scam_base · ${allRows.length} каналов подтверждено · источники: web-мониторинг и форма жалоб`,
  };
}

/** Скользящее окно 12 ч по колонке «дата обнаружения» (detected_at) в scam_base. */
const KRO_SCAM_BASE_ROLLING_12H_MS = 12 * 60 * 60 * 1000;

function kroScamBaseReasonSummaryLine(r) {
  const ot = (r?.object_type || '').toString().trim();
  const sp = (r?.source_primary || '').toString().trim();
  const ev = (r?.source_evidence || '').toString().trim().replace(/\s+/g, ' ');
  const parts = [];
  if (ot) parts.push(`Тип объекта: ${ot}`);
  if (sp) parts.push(`Первоисточник: ${sp}`);
  if (ev) parts.push(`Цитата/доказательства: ${ev.length > 220 ? `${ev.slice(0, 217)}…` : ev}`);
  return parts.join(' · ') || 'Подтверждённая запись в scam_base';
}

/**
 * Метрики «за последние 12 ч» по дате обнаружения (не за всю историю листа).
 */
function buildScamBase12hRollup(parsedRows, nowMs = Date.now()) {
  const cutoff = nowMs - KRO_SCAM_BASE_ROLLING_12H_MS;
  const filtered = (parsedRows || [])
    .filter(isScamBaseRowInLiveCounterDataset)
    .filter((row) => parseScamDetectedAtMs(row) >= cutoff);
  const byChannel = new Map();
  for (const row of filtered) {
    const key = channelMatchKey(row.username);
    if (!key) continue;
    const prev = byChannel.get(key);
    if (!prev || parseScamDetectedAtMs(row) >= parseScamDetectedAtMs(prev)) {
      byChannel.set(key, row);
    }
  }
  const rows = Array.from(byChannel.values());
  const lossesSum = rows.reduce((s, r) => s + (r.total_loss_rub || 0), 0);
  const telegramCount = rows.filter(
    (r) => (r.object_type || '').toLowerCase().includes('сигнал') || !(r.object_type || '').trim()
  ).length;
  const coursesCount = rows.filter((r) =>
    ['курс', 'сайт', 'обучен', 'обменник', 'инвест'].some((kw) => (r.object_type || '').toLowerCase().includes(kw))
  ).length;
  const complaintsSum = rows.reduce((s, r) => s + (Number(r.complaints) || 0), 0);
  const top3 = [...rows]
    .sort((a, b) => (b.total_loss_rub || 0) - (a.total_loss_rub || 0))
    .slice(0, 3)
    .map((r) => ({
      channel: r.username,
      sum: r.total_loss_rub || 0,
      status: statusWithLossFloor(r.status, r.total_loss_rub || 0),
      link: r.link || '',
    }));
  return {
    uniqueChannels: rows.length,
    lossesSum,
    telegramCount,
    coursesCount,
    complaintsSum,
    top3,
    rowSnapshots: rows,
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
    return 'Быстрая проверка сейчас недоступна (нет нужных библиотек на сервере). Канал можно поставить в очередь и проверить позже.';
  }
  if (/telegram not configured/i.test(text)) {
    return 'Проверка из браузера сейчас не настроена (нет ключей Telegram на сервере).';
  }
  if (/channel not found or inaccessible/i.test(text)) {
    return 'Канал не найден или к нему нет доступа.';
  }
  return text.split('\n').slice(-1)[0].trim() || text;
}

const KRO_V0_STATUS = {
  watch: 'под наблюдением',
  risk: 'в риске',
  scam: 'подтверждённый скам',
  clean: 'на текущий момент нарушений не видно',
};

function kroV0CleanEvidenceQuotes(evidence) {
  const parts = (evidence || '')
    .toString()
    .replace(/Источник:\s*/gi, '')
    .split(/\s*\|\s*|\s*;\s*|\n+/);
  const codeLike = /function\s*\(|=>|<\/?script|javascript:/i;
  const out = [];
  for (const p0 of parts) {
    const p = p0.replace(/https?:\/\/[^\s|;]+/gi, '').replace(/\s+/g, ' ').trim();
    if (p.length < 22 || p.length > 520) continue;
    if (codeLike.test(p)) continue;
    if (!/[а-яёА-ЯЁ]/.test(p) && p.length < 100) continue;
    out.push(p);
    if (out.length >= 4) break;
  }
  return out;
}

function kroV0RiskBulletsFromScamBaseRow(r) {
  const bullets = [];
  if (!r) return bullets;
  const ot = (r.object_type || '').toString().trim();
  if (ot && ot !== '—' && !/^\d+$/.test(ot)) bullets.push(`Тип в карточке: ${ot}.`);
  const complaints = r.complaints;
  if (complaints != null && complaints !== '' && !Number.isNaN(Number(complaints)) && Number(complaints) > 0) {
    bullets.push(`Учтено жалоб: ${Number(complaints)}.`);
  }
  const loss = Number(r.total_loss_rub);
  if (Number.isFinite(loss) && loss > 0) {
    bullets.push(`Сумма потерь по жалобам: ${loss.toLocaleString('ru-RU')} ₽.`);
  }
  const quotes = kroV0CleanEvidenceQuotes(r.source_evidence || '');
  if (quotes[0]) bullets.push(`Цитата из материалов: «${quotes[0]}».`);
  try {
    const caRaw = (r.content_analysis || '').toString().trim();
    if (caRaw) {
      const ca = JSON.parse(caRaw);
      const kws = ca && ca.keywords;
      if (kws && typeof kws === 'object') {
        const hits = Object.keys(kws).filter((k) => Number(kws[k]) > 0);
        if (hits.length) bullets.push(`Чаще всплывают темы: ${hits.slice(0, 5).join(', ')}.`);
      }
    }
  } catch (_) {
    /* ignore */
  }
  return bullets;
}

function kroV0MapScamBaseStatusToConclusion(status, verdict, totalLossRub) {
  const adjusted = statusWithLossFloor(status, totalLossRub);
  const s = normalizeKroStatusBlob(adjusted);
  if (s.includes('подтвержд') && s.includes('скам')) return KRO_V0_STATUS.scam;
  if (s.includes('в риске')) return KRO_V0_STATUS.risk;
  if (s.includes('без нарушений') || s.includes('без риска')) return KRO_V0_STATUS.clean;
  const v = normalizeKroStatusBlob(verdict);
  if (v.includes('scam') || v.includes('скам')) return KRO_V0_STATUS.scam;
  return KRO_V0_STATUS.watch;
}

function kroV0HumanVerdictLabel(verdict) {
  const x = (verdict || '').toString().trim().toLowerCase();
  if (x === 'grey') return 'много поводов насторожиться, но это ещё не «подтверждённый скам»';
  if (x === 'safe') return 'по автоматической формуле ближе к спокойному профилю';
  if (x === 'scam') return 'по автоматической формуле ближе к высокому риску';
  return verdict || '';
}

function kroV0ConclusionFromLiveParsed(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return {
      status: KRO_V0_STATUS.watch,
      reasons: [
        'Живая проверка не вернула данные (сессия Telegram, доступ к каналу или обрыв по времени). Обновите страницу через минуту или запустите проверку с главной ещё раз.',
      ],
    };
  }
  if (parsed.not_crypto) {
    return {
      status: KRO_V0_STATUS.clean,
      reasons: [
        'По выборке постов канал не похож на крипто‑тему: мы такие каналы в этой проверке не классифицируем как «скам».',
      ],
    };
  }
  if (parsed.found !== true) {
    const err = normalizeCheckOnceError(parsed.error) || 'Проверка не дала результата.';
    const low = `${err}`.toLowerCase();
    const looksUnavailable =
      low.includes('telethon') ||
      low.includes('telegram') ||
      low.includes('ключ') ||
      low.includes('не настро') ||
      low.includes('очеред') ||
      low.includes('kro-login') ||
      low.includes('войдите');
    return {
      status: looksUnavailable ? KRO_V0_STATUS.watch : KRO_V0_STATUS.clean,
      reasons: [err],
    };
  }
  if (parsed.is_confirmed === true || parsed.verdict === 'scam') {
    const reasons = [];
    if (parsed.is_confirmed === true) {
      reasons.push('Совпали три строгих условия: молодой канал, явный платный/сигнальный оффер и минимум две жалобы из отчётов.');
    }
    if (parsed.complaints != null) reasons.push(`В отчётах учтено жалоб: ${parsed.complaints}.`);
    if (parsed.total_loss) reasons.push(`По жалобам указана сумма: ${parsed.total_loss}.`);
    if (parsed.risk_score != null) reasons.push(`По последним постам сводная оценка риска: ${parsed.risk_score} из 100.`);
    return { status: KRO_V0_STATUS.scam, reasons: reasons.slice(0, 4) };
  }
  const rl = (parsed.risk_level || '').toString().trim();
  if (rl === 'в риске') {
    const reasons = [];
    if (parsed.complaints != null) {
      reasons.push(`В отчётах людей уже ${parsed.complaints} жалоб(а), плюс в ленте есть сигналы/VIP.`);
    }
    if (Array.isArray(parsed.risk_evidence) && parsed.risk_evidence.length) {
      reasons.push('В текстах есть давление, сигналы или обещания «лёгких» денег — сочетается с жалобами.');
    }
    if (parsed.only_profits_flag) reasons.push('Почти только «профиты», про минусы почти не говорят.');
    if (parsed.has_signal_offer) reasons.push('Есть явные призывы к сделкам «купи/продай» или похожий оффер.');
    return { status: KRO_V0_STATUS.risk, reasons: reasons.slice(0, 4) };
  }
  if (rl === 'поведенческий риск') {
    const reasons = [];
    if (parsed.fomo_pct != null) reasons.push(`Сильное «успей/последний шанс»: примерно в ${parsed.fomo_pct}% постов выборки.`);
    if (Array.isArray(parsed.shame_phrases_detected) && parsed.shame_phrases_detected.length) {
      reasons.push('Есть «стыдящие» обращения к аудитории.');
    }
    if (parsed.ads_ratio != null) reasons.push(`Много постов похоже на рекламу и продажу: ~${parsed.ads_ratio}% выборки.`);
    if (Array.isArray(parsed.risk_evidence) && parsed.risk_evidence.length) {
      reasons.push('Плюс типичные маркеры давления в текстах.');
    }
    return { status: KRO_V0_STATUS.risk, reasons: reasons.slice(0, 4) };
  }
  if (rl === 'под наблюдением') {
    const reasons = [];
    if (parsed.complaints === 1) reasons.push('Жалоба пока одна — это зона внимания, а не «жёсткий» уровень.');
    if (parsed.has_signal_offer) reasons.push('В постах есть признаки сигнального предложения.');
    if (parsed.vip_price && String(parsed.vip_price).trim() && String(parsed.vip_price).trim() !== '—') {
      reasons.push(`Заметен платный формат/VIP: ${String(parsed.vip_price).trim()}.`);
    }
    if (parsed.risk_verdict) {
      const hv = kroV0HumanVerdictLabel(parsed.risk_verdict);
      if (hv) reasons.push(`Автоматическая оценка по постам: ${hv}.`);
    }
    if (!reasons.length) reasons.push('Есть отдельные тревожные признаки, но без набора для более жёсткого вывода.');
    return { status: KRO_V0_STATUS.watch, reasons: reasons.slice(0, 4) };
  }
  if (rl === 'нет риска') {
    const reasons = [];
    if (parsed.risk_verdict) {
      const hv = kroV0HumanVerdictLabel(parsed.risk_verdict);
      if (hv) reasons.push(`Автоматическая оценка по постам: ${hv}.`);
    }
    if (parsed.risk_score != null) reasons.push(`Сводный балл по постам: ${parsed.risk_score} из 100.`);
    reasons.push('По выбранным правилам нет картины «давление + жалобы» или сильного поведенческого давления.');
    return { status: KRO_V0_STATUS.clean, reasons: reasons.slice(0, 4) };
  }
  const reasons = [];
  if (parsed.risk_score != null) reasons.push(`Сводный балл по постам: ${parsed.risk_score} из 100.`);
  if (parsed.risk_verdict) {
    const hv = kroV0HumanVerdictLabel(parsed.risk_verdict);
    if (hv) reasons.push(`Автоматическая оценка по постам: ${hv}.`);
  }
  return { status: KRO_V0_STATUS.watch, reasons: reasons.slice(0, 4) };
}

function kroV0BuildAnalysisFromScamBaseProfile(profile, extra) {
  const r = profile;
  const username = (r?.username || '').toString().trim() || (extra && extra.channel_key) || '';
  const lossRub = Number(r?.total_loss_rub) || 0;
  const conclusion = {
    status: kroV0MapScamBaseStatusToConclusion(r?.status, r?.verdict, lossRub),
    reasons: [],
  };
  if (r?._schema === 'v2') {
    if (Number.isFinite(lossRub) && lossRub > 0) {
      conclusion.reasons.push(`В карточке указаны потери по жалобам: ${lossRub.toLocaleString('ru-RU')} ₽.`);
    }
    if (r.complaints != null && r.complaints !== '') conclusion.reasons.push(`Учтено жалоб: ${r.complaints}.`);
    const st = (r.status || '').toString().trim();
    if (st) conclusion.reasons.push(`Статус в нашей базе: «${st}».`);
    const sp = (r.source_primary || '').toString().trim();
    if (sp && sp !== '—') conclusion.reasons.push(`Есть указание на первоисточник/публикацию: ${sp}.`);
  } else {
    if (r?.risk_score != null) conclusion.reasons.push(`В старой карточке указан риск: ${r.risk_score} из 100.`);
    if (r?.verdict) conclusion.reasons.push(`Вердикт в карточке: ${r.verdict}.`);
    if (r?.complaints != null) conclusion.reasons.push(`Жалоб в карточке: ${r.complaints}.`);
    if (r?.total_loss) conclusion.reasons.push(`Потери в карточке: ${r.total_loss}.`);
  }
  conclusion.reasons = conclusion.reasons.filter(Boolean).slice(0, 4);

  const riskBullets = kroV0RiskBulletsFromScamBaseRow(r);
  const baseInfo = [];
  baseInfo.push(`Канал: ${username || '—'}`);
  baseInfo.push('Карточка из мониторинга: сводка по циклам (не один день), метрики по тексту ленты; медиа без подписи в текст не входят.');
  if (r?.link) baseInfo.push(`Открыть в Telegram: ${r.link}`);
  if (r?._schema === 'v2') {
    if (r.detected_at) baseInfo.push(`В учёте с: ${r.detected_at}`);
    if (r.channel_age_days != null && r.channel_age_days !== '') {
      baseInfo.push(`Возраст канала (по данным карточки): ~${r.channel_age_days} дн.`);
    }
  } else {
    const bits = [];
    if (r?.risk_score != null) bits.push(`риск ${r.risk_score}/100`);
    if (r?.ads_per_week != null) bits.push(`много «продающих» постов: ~${r.ads_per_week} за неделю`);
    if (r?.bot_pct) bits.push(`похожие ответы: ${r.bot_pct}`);
    if (bits.length) baseInfo.push(`Кратко по карточке: ${bits.join('; ')}.`);
  }

  const content = [];
  if (r?._schema === 'v2') {
    if (r.vip_price && String(r.vip_price).trim() && String(r.vip_price).trim() !== '—') {
      content.push(`Платный формат / VIP: ${r.vip_price}.`);
    }
  } else {
    if (r?.vip_price) content.push(`Платный формат / VIP: ${r.vip_price}.`);
  }
  for (const b of riskBullets.slice(0, 3)) {
    if (!content.includes(b)) content.push(b);
  }

  const external = [];
  const sp = (r?.source_primary || '').toString().trim();
  const ev = (r?.source_evidence || '').toString().trim();
  const jcParts = [];
  if (r?.complaints != null && r.complaints !== '') jcParts.push(`жалоб: ${r.complaints}`);
  if (Number.isFinite(lossRub) && lossRub > 0) jcParts.push(`потери: ${lossRub.toLocaleString('ru-RU')} ₽`);
  if (jcParts.length) external.push(`Люди в отчётах: ${jcParts.join(', ')}.`);
  if (sp && sp !== '—') external.push(`Источник: ${sp}`);
  if (ev && ev !== '—') external.push('Есть текст и ссылки — подробности внизу страницы в блоке про базу.');

  const network = [];
  try {
    const caRaw = (r?.content_analysis || '').toString().trim();
    if (caRaw) {
      const ca = JSON.parse(caRaw);
      const pc = ca?.promoted_channels;
      if (Array.isArray(pc) && pc.length) {
        network.push(`Связи: в постах светятся другие каналы (${pc.slice(0, 3).join(', ')}).`);
      }
    }
  } catch (_) {
    /* ignore */
  }
  if (!network.length) {
    network.push('Явной «карты связей» в карточке нет.');
  }

  while (baseInfo.length > 5) baseInfo.pop();
  while (content.length > 3) content.pop();
  while (external.length > 2) external.pop();
  while (network.length > 2) network.pop();

  return {
    v: 0,
    channel_key: (extra && extra.channel_key) || channelMatchKey(username) || username,
    generated_at: new Date().toISOString(),
    sources: ['публичная база'],
    basic_info: baseInfo,
    content_behavior: content,
    external_reports: external,
    ties_risk_factors: network,
    conclusion,
  };
}

function kroV0BuildAnalysisFromLiveParsed(parsed, channelKey) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const username = (p.username || '').toString().trim();
  const conclusion = kroV0ConclusionFromLiveParsed(p);

  const baseInfo = [];
  baseInfo.push(`Канал: ${username || (channelKey ? `@${channelKey}` : '—')}`);
  const winD = Number(p.analysis_window_days);
  const postsN = Number(p.posts_fetched);
  const limitsNote = ' Учитываем текст постов и ответы; голос, видео и вложения без подписи не входят.';
  if (Number.isFinite(winD) && winD > 0 && Number.isFinite(postsN) && postsN >= 0) {
    baseInfo.push(
      `Поведение за период (не один пост): окно до ${winD} дн., ~${postsN} сообщ. с текстом; часть метрик — по последним 7 дням.${limitsNote}`,
    );
  } else {
    baseInfo.push(
      `Поведение за период (не один пост): выборка за несколько недель и отдельно последние 7 дней для части метрик.${limitsNote}`,
    );
  }
  if (p.title) baseInfo.push(`Название в Telegram: ${p.title}`);
  if (p.channel_age_days != null) baseInfo.push(`Возраст канала (оценка): ${p.channel_age_days} дн.`);
  const hv = p.risk_verdict ? kroV0HumanVerdictLabel(p.risk_verdict) : '';
  if (p.risk_score != null && hv) {
    baseInfo.push(`Сводка по ленте: ${p.risk_score} из 100 — ${hv}.`);
  } else if (p.risk_score != null) {
    baseInfo.push(`Сводка по ленте: ${p.risk_score} из 100.`);
  } else if (hv) {
    baseInfo.push(`Предварительно по ленте: ${hv}.`);
  }
  if (p.read_only) baseInfo.push('Для страницы отчёта в таблицы ничего не записывали.');

  const content = [];
  const behaviorBits = [];
  if (p.ads_per_week != null) behaviorBits.push(`за 7 дней много «продающих» постов (~${p.ads_per_week})`);
  if (p.ads_ratio != null) behaviorBits.push(`в выборке окна «продажа» ~${p.ads_ratio}%`);
  if (p.fomo_pct != null) behaviorBits.push(`«успей/последний шанс» ~${p.fomo_pct}% постов`);
  if (behaviorBits.length) content.push(`Поведение: ${behaviorBits.join(', ')}.`);
  if (p.bot_pct != null && p.bot_pct !== '') {
    content.push(`Ответы под постами часто одинаковые: ${p.bot_pct}.`);
  }
  if (p.only_profits_flag) content.push('Почти только «профиты», про минусы почти не говорят.');
  if (Array.isArray(p.sample_posts) && p.sample_posts.length && content.length < 3) {
    const s0 = String(p.sample_posts[0] || '');
    content.push(`Пример из ленты: «${s0.slice(0, 100)}${s0.length > 100 ? '…' : ''}»`);
  }
  while (content.length > 3) content.pop();

  const external = [];
  const jc = [];
  if (p.complaints != null) jc.push(`жалоб: ${p.complaints}`);
  if (p.total_loss) jc.push(`сумма: ${p.total_loss}`);
  if (jc.length) external.push(`От людей в отчётах: ${jc.join(', ')}.`);
  else external.push('Жалоб в отчётах пока не видно — или они не подтянулись.');

  const network = [];
  const promos = [];
  if (p.promoted_channels_count != null && p.promoted_channels_count > 0) {
    promos.push(`${p.promoted_channels_count} упоминаний`);
  }
  if (Array.isArray(p.promoted_channels_sample) && p.promoted_channels_sample.length) {
    promos.push(`например: ${p.promoted_channels_sample.slice(0, 3).join(', ')}`);
  }
  if (promos.length) network.push(`Связи: ${promos.join('; ')}.`);
  if (
    p.subscriber_growth_per_day != null ||
    (p.growth_anomaly != null && Number(p.growth_anomaly) > 0) ||
    p.reach_ratio != null
  ) {
    network.push('По открытой статистике — нетипичные скачки роста или охвата (дополнительный сигнал).');
  }
  if (!network.length) network.push('Связи с другими каналами по данным не выделены.');
  while (network.length > 2) network.pop();

  while (baseInfo.length > 5) baseInfo.pop();
  while (external.length > 2) external.pop();

  return {
    v: 0,
    channel_key: channelKey || channelMatchKey(username) || username,
    generated_at: new Date().toISOString(),
    sources: ['живая проверка Telegram'],
    basic_info: baseInfo,
    content_behavior: content,
    external_reports: external,
    ties_risk_factors: network,
    conclusion,
  };
}

function kroRunCheckOnce(channel, opts) {
  const readOnly = !!(opts && opts.readOnly);
  const scriptPath = join(__dirname, 'kro-worker', 'check_once.py');
  if (!(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && fs.existsSync(scriptPath))) {
    return { ok: false, error: 'Живая проверка на сервере не настроена (нет ключей Telegram или скрипта).', parsed: null, stderr: '' };
  }
  try {
    const child = spawnSync('python3', [scriptPath, channel, String(kroCheckOncePeriodDays)], {
      cwd: join(__dirname, 'kro-worker'),
      timeout: kroCheckOnceTimeoutMs,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(readOnly ? { KRO_CHECK_ONCE_NO_WRITE: '1' } : {}),
      },
    });
    const stdout = (child.stdout || '').trim();
    const stderr = (child.stderr || '').trim();
    const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
    if (!line) {
      return {
        ok: false,
        error: normalizeCheckOnceError(stderr) || (child.status !== 0 ? 'Проверка не завершилась' : 'Пустой ответ проверки'),
        parsed: null,
        stderr,
      };
    }
    try {
      const parsed = JSON.parse(line);
      return { ok: true, error: null, parsed, stderr };
    } catch (e) {
      return { ok: false, error: normalizeCheckOnceError(stderr) || 'Не удалось разобрать ответ проверки', parsed: null, stderr };
    }
  } catch (e) {
    return { ok: false, error: normalizeCheckOnceError(e.message) || 'Проверка не запустилась', parsed: null, stderr: '' };
  }
}

/** Для UI главной страницы: период и объём выборки без парсинга текста basic_info. */
function kroLiveMetricsFromParsed(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed;
  return {
    found: p.found === true,
    username: (p.username || '').toString().trim() || null,
    analysis_window_days: Number.isFinite(Number(p.analysis_window_days)) ? Number(p.analysis_window_days) : null,
    posts_fetched: Number.isFinite(Number(p.posts_fetched)) ? Number(p.posts_fetched) : null,
    read_only: !!p.read_only,
  };
}

function looksLikeSiteHostname(s) {
  const t = (s || '').toString().trim().toLowerCase().replace(/\.$/, '');
  if (!t || /\s|\/|@/.test(t)) return false;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(t);
}

const KRO_OBJECT_TYPE_RISK_PREFIX = {
  'крипто-обменник': 'Признаки риска (крипто-обменник): обещает завышенный спред (часто 9–15% и выше), требует дополнительную оплату для вывода, ссылается на AML-блокировку средств.',
  'инвест-бот': 'Признаки риска (инвест-бот): обещает процент в день, требует пополнить депозит, блокирует вывод.',
};

function riskPrefixForObjectType(ot) {
  const t = (ot || '').toString().trim().toLowerCase();
  for (const [k, v] of Object.entries(KRO_OBJECT_TYPE_RISK_PREFIX)) {
    if (k.toLowerCase() === t) return v;
  }
  return '';
}

function inferObjectTypeForPromote(channelValue, explicit) {
  const ex = (explicit || '').toString().trim();
  if (ex) return ex;
  const s = (channelValue || '').toString().trim().toLowerCase();
  if (!s) return 'сигнал-канал';
  if (s.startsWith('http://') || s.startsWith('https://')) {
    if (s.includes('t.me/')) return 'сигнал-канал';
    return 'крипто-обменник';
  }
  if (looksLikeSiteHostname(s)) {
    if (/(?:^|[._-])bot(?:[._-]|$)|\.bot\.|bot\.(io|com|net|org|ru|app)\b/i.test(s)) return 'инвест-бот';
    return 'крипто-обменник';
  }
  return 'сигнал-канал';
}

function scamBaseDisplayLinkForPromote(channelValue, explicitOt) {
  let raw = (channelValue || '').toString().trim();
  const ot = (explicitOt || '').toString().trim();
  if (!raw) return { display: '', link: '', objectType: 'сигнал-канал' };
  let low = raw.toLowerCase();
  if (low.startsWith('http://') || low.startsWith('https://')) {
    if (low.includes('t.me/')) {
      const idx = low.indexOf('t.me/');
      raw = raw.slice(idx);
      low = raw.toLowerCase();
    } else {
      try {
        const u = new URL(low);
        const host = u.hostname.toLowerCase();
        if (host) {
          return {
            display: host,
            link: `https://${host}`,
            objectType: inferObjectTypeForPromote(host, ot),
          };
        }
      } catch {
        /* fallthrough */
      }
      return { display: raw, link: raw, objectType: inferObjectTypeForPromote(raw, ot) };
    }
  }
  if (looksLikeSiteHostname(raw)) {
    const host = low.replace(/\.$/, '');
    return {
      display: host,
      link: `https://${host}`,
      objectType: inferObjectTypeForPromote(host, ot),
    };
  }
  if (low.startsWith('t.me/+')) {
    const link = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return { display: raw, link, objectType: inferObjectTypeForPromote(raw, ot) };
  }
  if (low.startsWith('t.me/')) {
    const parts = low.split('/').filter(Boolean);
    let slug = parts[1] || '';
    if (slug === 's' && parts[2]) slug = parts[2];
    slug = (slug || '').split('?')[0];
    return {
      display: `@${slug}`,
      link: `https://t.me/${slug}`,
      objectType: inferObjectTypeForPromote(slug, ot),
    };
  }
  let key = low.startsWith('@') ? low.slice(1) : low;
  key = key.split('/')[0].split('?')[0];
  return {
    display: `@${key}`,
    link: `https://t.me/${key}`,
    objectType: inferObjectTypeForPromote(key, ot),
  };
}

function normalizeChannel(channel) {
  const s = (channel || '').toString().trim().replace(/\s/g, '');
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    try {
      const u = new URL(lower);
      if (u.hostname) return u.hostname.toLowerCase();
    } catch {
      /* fallthrough */
    }
  }
  if (looksLikeSiteHostname(s)) {
    return lower.replace(/\.$/, '');
  }
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

/** Canonical form for matching report row channel to requested channel (@name vs t.me/name / сайт). */
function channelMatchKey(channel) {
  const s = (channel || '').toString().trim().toLowerCase().replace(/\s/g, '');
  if (!s) return '';
  if (s.startsWith('http://') || s.startsWith('https://')) {
    try {
      const u = new URL(s);
      if (u.hostname) return u.hostname.toLowerCase();
    } catch {
      /* fallthrough */
    }
  }
  if (looksLikeSiteHostname(s)) return s.replace(/\.$/, '');
  if (s.startsWith('t.me/+')) return s;
  if (s.startsWith('t.me/')) return s.slice(6);
  return s.startsWith('@') ? s.slice(1) : s;
}

/** Единый список с backend/kro-worker/kro_permanent_blocklist.json (не дублировать в коде). */
let KRO_PERMANENT_BLOCKLIST;
try {
  const raw = JSON.parse(readFileSync(join(__dirname, 'kro-worker', 'kro_permanent_blocklist.json'), 'utf8'));
  KRO_PERMANENT_BLOCKLIST = new Set(
    (Array.isArray(raw) ? raw : []).map((u) => channelMatchKey(String(u))).filter(Boolean)
  );
} catch (e) {
  console.warn('KRO_PERMANENT_BLOCKLIST: failed to load kro_permanent_blocklist.json', e?.message);
  KRO_PERMANENT_BLOCKLIST = new Set();
}

/** Синхронно с kro_tme_http_gate.tme_http_gate_for_scam_base_write (только публичный HTML t.me). */
/** Синхронно с backend/kro-worker/kro_tme_http_gate.SCAM_BASE_HTTP_CRYPTO_TERMS (ТЗ KRO фильтр 4). */
const KRO_TME_HTTP_GATE_CRYPTO = [
  'крипт', 'bitcoin', 'btc', 'usdt', 'трейд', 'сигнал', 'invest', 'trade', 'форекс', 'обменник',
  'binance', 'bybit', 'биткоин', 'альткоин', 'депозит', 'профит', 'лонг', 'шорт', 'фьючерс', 'спот',
  'defi', 'nft', 'токен', 'майнинг', 'crypto', 'signal', 'forex', 'бинанс',
];
/** Синхронно с kro_tme_http_gate.gambling_topic_match — не в scam_base / не промо. */
const KRO_GAMBLING_SUBSTR = [
  'казино', 'букмекер', 'букмекеры', 'букмекерская', 'рулетка', 'покер', 'слоты',
  'gambling', 'casino', 'slots', 'bookmaker', 'bookmakers',
];

function gamblingTopicHit(...parts) {
  const blob = parts.map((x) => (x == null ? '' : String(x))).join(' ');
  if (!blob.trim()) return null;
  const low = blob.toLowerCase();
  for (const s of KRO_GAMBLING_SUBSTR) {
    if (low.includes(s)) return s;
  }
  const stavkiRe = /(?<![\u0400-\u04FFa-z])ставки(?![\u0400-\u04FFa-z])|(?<![\u0400-\u04FFa-z])ставка(?![\u0400-\u04FFa-z])/i;
  const st = stavkiRe.exec(blob);
  if (st) return st[0].toLowerCase();
  const reEn = /\b(?:gambling|casinos?|roulette|poker|slots?|bookmakers?|betting|bets?)\b|\bbet\b/gi;
  const me = reEn.exec(blob);
  return me ? me[0].toLowerCase() : null;
}

/** Синхронно с kro_tme_http_gate.off_topic_business_match — только для текста с реальной страницы t.me */
function kroOffTopicBusinessHit(blob) {
  const low = (blob || '').toString().toLowerCase();
  if (!low.trim()) return null;
  const ru = [
    'poizon', 'одежда', 'мода', 'кроссовки', 'обувь', 'fashion', 'shoes', 'sneakers', 'streetwear', 'дроп', 'лимитка',
    'коллаб', 'коллаборация', 'найк', 'адидас', 'nike', 'adidas', 'jordan', 'yeezy', 'supreme',
    'сникер', 'кросовки',
    'бренд одежды', 'одяг', 'кросівки',
    'бренд', 'бутик', 'магазин одежды',
    'ресторан', 'доставка еды', 'суши', 'пицца', 'кафе', 'food delivery',
    'квартира', 'аренда', 'продажа квартир', 'недвижимость', 'риэлтор', 'жильё', 'жилье',
    'продажа авто', 'автосалон', 'машина купить',
    'вакансия', 'найм', 'работа в',
    'футбол', 'футболь', 'чемпионат мира',
  ];
  for (const s of ru) {
    if (low.includes(s)) return s;
  }
  if (/\bhr\b/i.test(blob || '')) return 'hr';
  const reEn =
    /\b(?:poizon|sneakers?|sneakerhead|streetwear|collab(?:oration)?|nike|adidas|jordan|yeezy|supreme|fashion|shoes?|boutique|restaurant|pizza|sushi|cafe|food\s+delivery|real\s*estate|realtor|apartment\s+rent|car\s+sale|dealer|vacanc(?:y|ies)|hiring|recruit(?:er|ment)|football|soccer)\b/i;
  const m = reEn.exec(blob || '');
  return m ? m[0].toLowerCase() : null;
}
const KRO_TME_HTTP_GATE_MIN_SUBS = 100;
const KRO_TME_HTTP_GATE_MAX_POST_DAYS = 60;

function _extractTgmeSlugFromLink(link) {
  const s = (link || '').toString().trim().toLowerCase();
  if (!s.includes('t.me/')) return '';
  if (s.includes('t.me/+')) return '';
  const m = s.match(/t\.me\/(?:s\/)?([^/?#]+)/);
  return m ? m[1].replace(/^@/, '') : '';
}

function _stripTags(html) {
  return (html || '').toString().replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

function _kroSlugLooksLikeBot(slug, objectType) {
  const s = (slug || '').toLowerCase().replace(/\/$/, '');
  if (s.endsWith('bot') || s.endsWith('_bot')) return true;
  const ot = (objectType || '').toLowerCase().replace(/\s+/g, '');
  if (ot.includes('инвест-бот') || ot.includes('инвестбот')) return true;
  const otRaw = (objectType || '').toLowerCase();
  if (otRaw.includes('бот') && !otRaw.includes('канал')) return true;
  return false;
}

function _kroHtmlBotStartVisible(html, low) {
  if (low.includes('tgme_page_error')) return false;
  if (low.includes('chat not found') || low.includes('bot was blocked')) return false;
  if (low.includes('?start=') && (low.includes('t.me/') || low.includes('telegram.me'))) return true;
  const re = /<a[^>]+class="[^"]*tgme_action_button[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let mm;
  while ((mm = re.exec(html)) !== null) {
    const inner = (mm[1] || '').toLowerCase();
    const full = mm[0].toLowerCase();
    if (full.includes('?start=') || full.includes('start=')) return true;
    if (['start', 'запустить', 'открыть', 'open', 'launch'].some((w) => inner.includes(w))) return true;
  }
  return false;
}

/**
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
async function passesKroTmeHttpGateForScamBase(link, _contentBlob, objectType = '') {
  void _contentBlob;
  const L = (link || '').toString().trim().toLowerCase();
  if (!L.includes('t.me/')) {
    return { ok: true, reason: 'not_telegram' };
  }
  if (L.includes('t.me/+')) {
    return { ok: false, reason: 'invite_link_not_supported' };
  }
  const slug = _extractTgmeSlugFromLink(link);
  if (!slug) {
    return { ok: true, reason: 'not_telegram' };
  }
  const isBot = _kroSlugLooksLikeBot(slug, objectType);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
  };
  let html = '';
  let status = 0;
  for (const url of [`https://t.me/s/${slug}`, `https://t.me/${slug}`]) {
    try {
      const res = await axios.get(url, { headers, timeout: 22000, validateStatus: () => true });
      status = res.status;
      html = typeof res.data === 'string' ? res.data : '';
      if (status === 200 && html.length > 200) break;
    } catch {
      /* try next URL */
    }
  }
  if (status !== 200 || html.length < 200) {
    return { ok: false, reason: 'tme_unavailable_or_no_public_page' };
  }

  const low = html.toLowerCase();
  if (
    low.includes('tgme_page_error') ||
    low.includes("doesn't exist") ||
    low.includes('does not exist') ||
    low.includes('username is not available') ||
    low.includes('channel is private') ||
    low.includes('канал недоступен') ||
    low.includes('пользователь не найден') ||
    low.includes('не существует')
  ) {
    return { ok: false, reason: 'tme_unavailable_or_no_public_page' };
  }

  const descMatch = html.match(/class="tgme_page_description"[^>]*>([\s\S]*?)<\/div>/i);
  const desc = descMatch ? _stripTags(descMatch[1]).toLowerCase() : '';
  const postsChunk = low.split('tgme_widget_message').slice(0, 60).join(' ');
  const tmeCore = `${desc} ${postsChunk}`;
  const otTme = kroOffTopicBusinessHit(tmeCore);
  if (otTme) {
    return { ok: false, reason: `blocked_offtopic_tme_${otTme}` };
  }

  if (isBot) {
    if (!_kroHtmlBotStartVisible(html, low)) {
      return { ok: false, reason: 'tme_bot_not_working_no_start' };
    }
    const gBot = gamblingTopicHit(tmeCore, link, objectType);
    if (gBot) {
      return { ok: false, reason: `blocked_gambling_tme_${gBot}` };
    }
    const hasCryptoBot = KRO_TME_HTTP_GATE_CRYPTO.some((t) => tmeCore.includes(t));
    if (!hasCryptoBot) {
      return { ok: false, reason: 'tme_no_crypto_terms_in_desc_or_posts' };
    }
    const dtReBot = /datetime="([^"]+)"/g;
    let lastB = null;
    let mb;
    while ((mb = dtReBot.exec(html)) !== null) {
      try {
        const d = new Date(mb[1].replace(/\+00:00$/, 'Z'));
        if (!Number.isNaN(d.getTime()) && (!lastB || d > lastB)) lastB = d;
      } catch {
        /* ignore */
      }
    }
    if (lastB != null) {
      const ageDaysB = (Date.now() - lastB.getTime()) / 864e5;
      if (ageDaysB > KRO_TME_HTTP_GATE_MAX_POST_DAYS) {
        return { ok: false, reason: `tme_no_fresh_post_${KRO_TME_HTTP_GATE_MAX_POST_DAYS}d` };
      }
    }
    const hackedB = ['взлом', 'взломан', 'hacked', 'канал взломали', 'аккаунт взломан'];
    if (hackedB.some((h) => postsChunk.includes(h))) {
      return { ok: false, reason: 'tme_channel_reported_hacked' };
    }
    return { ok: true, reason: 'ok_tme_http_gate_bot' };
  }

  const extraMatch = html.match(/class="tgme_page_extra"[^>]*>([\s\S]*?)<\/div>/i);
  const extraText = extraMatch ? _stripTags(extraMatch[1]).toLowerCase() : '';
  const hasSubsHint = extraText.includes('подписчик') || extraText.includes('subscriber');
  if (
    (extraText.includes('last seen') ||
      extraText.includes('was online') ||
      /\bonline\b/.test(extraText) ||
      extraText.includes('в сети') ||
      extraText.includes('заходил') ||
      extraText.includes('заходила')) &&
    !hasSubsHint
  ) {
    return { ok: false, reason: 'tme_personal_account_not_channel' };
  }
  if (/"type"\s*:\s*"user"/.test(low) && !hasSubsHint) {
    return { ok: false, reason: 'tme_personal_account_not_channel' };
  }

  let subs = null;
  const subM =
    extraText.match(/([\d\s\u00a0.,]+)\s*([km])?\s*(?:subscribers|subscriber|подписчик)/i) ||
    extraText.match(/([\d\s\u00a0.,]+)\s*([km])?\b/);
  if (subM) {
    let v = parseFloat(subM[1].replace(/\s/g, '').replace(',', '.'));
    const suf = (subM[2] || '').toLowerCase();
    if (suf === 'k') v *= 1000;
    if (suf === 'm') v *= 1e6;
    if (Number.isFinite(v)) subs = Math.round(v);
  }
  if (subs == null) {
    return { ok: false, reason: 'tme_subscribers_not_visible_reject' };
  }
  if (subs < KRO_TME_HTTP_GATE_MIN_SUBS) {
    return { ok: false, reason: `tme_subscribers_below_${KRO_TME_HTTP_GATE_MIN_SUBS}` };
  }

  const gCh = gamblingTopicHit(tmeCore, link, objectType);
  if (gCh) {
    return { ok: false, reason: `blocked_gambling_tme_${gCh}` };
  }
  const hasCrypto = KRO_TME_HTTP_GATE_CRYPTO.some((t) => tmeCore.includes(t));
  if (!hasCrypto) {
    return { ok: false, reason: 'tme_no_crypto_terms_in_desc_or_posts' };
  }

  const dtRe = /datetime="([^"]+)"/g;
  let last = null;
  let m;
  while ((m = dtRe.exec(html)) !== null) {
    try {
      const d = new Date(m[1].replace(/\+00:00$/, 'Z'));
      if (!Number.isNaN(d.getTime()) && (!last || d > last)) last = d;
    } catch {
      /* ignore */
    }
  }
  if (!last) {
    return { ok: false, reason: 'tme_no_public_posts_or_dates' };
  }
  const ageDays = (Date.now() - last.getTime()) / 864e5;
  if (ageDays > KRO_TME_HTTP_GATE_MAX_POST_DAYS) {
    return { ok: false, reason: `tme_no_fresh_post_${KRO_TME_HTTP_GATE_MAX_POST_DAYS}d` };
  }

  const hacked = ['взлом', 'взломан', 'hacked', 'канал взломали', 'аккаунт взломан'];
  if (hacked.some((h) => postsChunk.includes(h))) {
    return { ok: false, reason: 'tme_channel_reported_hacked' };
  }

  return { ok: true, reason: 'ok_tme_http_gate' };
}

/** Паритет с kro_source_policy / run_12h_monitor: promote в scam_base с сайта. */
function looksLikeTelegramChannelRef(...parts) {
  const blob = parts.map((x) => (x == null ? '' : String(x))).join(' ').toLowerCase();
  if (blob.includes('t.me/')) return true;
  return /(^|\s)@[a-z0-9_]{4,}\b/.test(blob);
}

const _KRO_HUB_SLUGS_PROMOTE = new Set([
  'blacklist-telegram',
  'proverka-telegram',
  'wp-admin',
  'feed',
  'category',
  'author',
  'page',
  'tag',
]);

function kroDedicatedVkladerWeight(low) {
  const m = low.match(/vklader\.com\/([a-z][a-z0-9_]{3,31})(?:\/|\?|$)/);
  if (m && !_KRO_HUB_SLUGS_PROMOTE.has(m[1].toLowerCase())) return 2;
  return 0;
}

function kroTelltrueNetWeight(low) {
  return low.includes('telltrue.net') ? 2 : 0;
}

/** Качество текста жалобы 1.0…3.0 (паритет с kro_source_policy.score_complaint_quality). */
function kroScoreComplaintQualityRaw(text) {
  const t = (text || '').trim();
  if (!t) return 0;
  const low = t.toLowerCase();
  let score = 0;
  if (/\d[\d\s\u00a0.,]*\s*(?:₽|р\.|руб|rub|usd|\$|\beur\b)/i.test(t)) score += 0.5;
  const scheme = ['оплат', 'vip', 'вип', 'подписк', 'перевёл', 'перевел', 'схем', 'депозит', 'инвест', 'сигнал', 'гарант', 'курс', 'обучен'];
  if (scheme.some((m) => low.includes(m))) score += 0.5;
  const action = ['заблок', 'удалил', 'не отвеч', 'обман', 'кинул', 'кидал', 'слил', 'мошен', 'не вернул', 'пропал'];
  if (action.some((m) => low.includes(m))) score += 0.5;
  if (t.length > 100) score += 0.5;
  return Math.min(2, score);
}

function kroScoreComplaintQuality(text) {
  return Math.min(3, 1 + kroScoreComplaintQualityRaw(text));
}

/** Бонус по объединённым описаниям жалоб (до +1.5), паритет с kro_source_policy._complaint_texts_joined_quality_bonus. */
function kroComplaintTextsJoinedBonus(joined) {
  const raw = (joined || '').trim();
  if (raw.length < 20) return 0;
  const chunks = raw.split(/[\n;•|]+/).map((p) => p.trim()).filter((p) => p.length > 15).slice(0, 8);
  const use = chunks.length ? chunks : [raw.slice(0, 800)];
  const avgQ = use.reduce((s, c) => s + kroScoreComplaintQuality(c), 0) / use.length;
  return Math.min(1.5, Math.max(0, (avgQ - 1) * 0.75));
}

/** Форма: с описанием — 1.5 + 0.5×kroScoreComplaintQuality; без — 1 (паритет с kro_source_policy). */
function kroFormComplaintRowWeights(reports) {
  let w = 0;
  for (const row of reports || []) {
    const src = (row.source || '').trim().toLowerCase();
    if (src !== 'form' && !src.endsWith('form')) continue;
    const d = (row.description || '').trim();
    w += d ? 1.5 + 0.5 * kroScoreComplaintQuality(d) : 1;
  }
  return w;
}

const KRO_MIN_SOURCE_WEIGHT_SCAM_BASE = 3;

function kroComputeSourceWeightForPromote(reports, sourceEvidence) {
  const blob = `form+web ${sourceEvidence || ''}`.toLowerCase();
  let w = 0;
  if (blob.includes('stop-scam1.com') || blob.includes('stop-scam1')) w += 3;
  if (blob.includes('fin-obzor.net') || blob.includes('fin-obzor')) w += 3;
  w += kroDedicatedVkladerWeight(blob);
  w += kroTelltrueNetWeight(blob);
  w += kroFormComplaintRowWeights(reports);
  const joined = (reports || []).map((r) => (r.description || '').trim()).filter(Boolean).join('\n');
  w += kroComplaintTextsJoinedBonus(joined);
  return w;
}

function kroSourceSignalACryptoFromParts(sourcePrimary, sourceEvidence, objectType, complaintJoined) {
  const blob = [sourcePrimary, sourceEvidence, objectType, complaintJoined].map(String).join(' ').toLowerCase();
  if (!blob.trim()) return false;
  return KRO_TME_HTTP_GATE_CRYPTO.some((t) => blob.includes(t));
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
  const checkingMessage = 'Полная проверка канала по Telegram может занять до 10 минут (зависит от размера канала и очереди). Обновите страницу или нажмите «Проверить» снова.';
  if (!kroScamBaseRange || !kroSheetId) {
    return res.json({
      found: false,
      channel,
      pending: true,
      message: checkingMessage,
      analysis: {
        v: 0,
        channel_key: channelMatchKey(channel) || channel,
        generated_at: new Date().toISOString(),
        sources: ['настройки сервера'],
        basic_info: ['Сейчас не подключена таблица с базой — сравнить канал с карточками нельзя.'],
        content_behavior: [],
        external_reports: [],
        ties_risk_factors: [],
        conclusion: {
          status: KRO_V0_STATUS.watch,
          reasons: ['Проверка отложена: нет доступа к Google Sheets. Попробуйте позже или через мониторинг.'],
        },
      },
    });
  }
  try {
    const client = await getKroSheetsClient();
    if (!client) {
      return res.json({
        found: false,
        channel,
        pending: true,
        message: checkingMessage,
        analysis: {
          v: 0,
          channel_key: channelMatchKey(channel) || channel,
          generated_at: new Date().toISOString(),
          sources: ['настройки сервера'],
          basic_info: ['Не удалось подключиться к таблице (нет доступа к Google).'],
          content_behavior: [],
          external_reports: [],
          ties_risk_factors: [],
          conclusion: {
            status: KRO_V0_STATUS.watch,
            reasons: ['Сервис временно не может прочитать базу — попробуйте чуть позже.'],
          },
        },
      });
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
        if (!isScamBaseRowInLiveCounterDataset(row)) {
          continue;
        }
        let complaints = row.complaints;
        let total_loss = row.total_loss;
        let total_loss_rub = row._schema === 'v2' ? row.total_loss_rub : null;
        const empty = (v) => v == null || v === '' || (typeof v === 'string' && v.trim() === '—');
        if (row._schema === 'v2') {
          if (empty(complaints) || !Number.isFinite(Number(total_loss_rub)) || Number(total_loss_rub) <= 0) {
            const report = await getComplaintsAndLossForChannel(client, channel);
            if (report.complaints != null) complaints = report.complaints;
            if (report.total_loss != null) total_loss = report.total_loss;
            if (report.total_loss != null) {
              const digits = String(report.total_loss).replace(/[^\d]/g, '');
              total_loss_rub = digits ? parseInt(digits, 10) : total_loss_rub;
            }
          } else {
            total_loss = (() => {
              const n = Number(total_loss_rub) || 0;
              if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}млн₽`;
              if (n >= 1000) return `${Math.round(n / 1000)}к₽`;
              return `${n}₽`;
            })();
          }
        } else if (empty(complaints) || empty(total_loss)) {
          const report = await getComplaintsAndLossForChannel(client, channel);
          if (report.complaints != null) complaints = report.complaints;
          if (report.total_loss != null) total_loss = report.total_loss;
        }
        const profileForAnalysis = enrichScamBaseContentAnalysisForMonitor(
          row._schema === 'v2'
            ? { ...row, complaints, total_loss_rub: Number.isFinite(Number(total_loss_rub)) ? Number(total_loss_rub) : row.total_loss_rub, total_loss }
            : { ...row, complaints, total_loss },
        );
        const analysis = kroV0BuildAnalysisFromScamBaseProfile(profileForAnalysis, { channel_key: requestKey });
        const watchRowHit = await fetchLatestChannelsWatchRowForKey(client, requestKey);
        if (watchRowHit) kroV0EnrichAnalysisWithWatch(analysis, watchRowHit);
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
          analysis,
        });
      }
    }

    let checkOnceError = null;
    const once = kroRunCheckOnce(channel, { readOnly: false });
    if (once.stderr) console.error('KRO check_once stderr:', once.stderr);
    const parsed = once.parsed;
    if (parsed && parsed.not_crypto) {
      const notCryptoAnalysis = kroV0BuildAnalysisFromLiveParsed(parsed, requestKey);
      const watchRowNc = await fetchLatestChannelsWatchRowForKey(client, requestKey);
      if (watchRowNc) kroV0EnrichAnalysisWithWatch(notCryptoAnalysis, watchRowNc);
      return res.json({
        found: false,
        pending: false,
        channel,
        message: parsed.error || 'Канал не связан с криптой, поэтому в мониторинг не попадает.',
        analysis: notCryptoAnalysis,
      });
    }
    if (once.ok && parsed && parsed.found === true && parsed.is_confirmed === true) {
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
      const analysis = kroV0BuildAnalysisFromLiveParsed(
        { ...parsed, complaints, total_loss, risk_score, is_confirmed: true, verdict: 'scam' },
        requestKey,
      );
      const watchRowCf = await fetchLatestChannelsWatchRowForKey(client, requestKey);
      if (watchRowCf) kroV0EnrichAnalysisWithWatch(analysis, watchRowCf);
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
        channel_age_days: parsed.channel_age_days,
        risk_level: parsed.risk_level,
        risk_evidence: parsed.risk_evidence,
        confirmation_checks: parsed.confirmation_checks,
        confirmation_status: parsed.confirmation_status,
        analysis,
      });
    }
    if (once.ok && parsed && parsed.found === true && parsed.is_confirmed === false) {
      const notConfirmedAnalysis = kroV0BuildAnalysisFromLiveParsed(parsed, requestKey);
      const watchRowNcf = await fetchLatestChannelsWatchRowForKey(client, requestKey);
      if (watchRowNcf) kroV0EnrichAnalysisWithWatch(notConfirmedAnalysis, watchRowNcf);
      return res.json({
        found: false,
        pending: false,
        channel,
        message: parsed.message || 'Канал проверен, но пока не проходит 3 критерия подтверждённого скам-канала.',
        confirmation_status: parsed.confirmation_status || 'not_confirmed',
        confirmation_checks: parsed.confirmation_checks || undefined,
        missing_criteria: parsed.missing_criteria || undefined,
        username: parsed.username,
        risk_score: parsed.risk_score,
        ads_per_week: parsed.ads_per_week,
        bot_pct: parsed.bot_pct,
        vip_price: parsed.vip_price,
        complaints: parsed.complaints,
        total_loss: parsed.total_loss,
        verdict: parsed.verdict,
        risk_verdict: parsed.risk_verdict,
        risk_level: parsed.risk_level,
        risk_evidence: parsed.risk_evidence,
        fomo_pct: parsed.fomo_pct,
        shame_phrases_detected: parsed.shame_phrases_detected,
        ads_ratio: parsed.ads_ratio,
        only_profits_flag: parsed.only_profits_flag,
        promoted_channels_count: parsed.promoted_channels_count,
        promoted_channels_sample: parsed.promoted_channels_sample,
        subscriber_growth_per_day: parsed.subscriber_growth_per_day,
        growth_anomaly: parsed.growth_anomaly,
        reach_ratio: parsed.reach_ratio,
        channel_age_days: parsed.channel_age_days,
        has_signal_offer: parsed.has_signal_offer,
        sample_posts: parsed.sample_posts,
        analysis: notConfirmedAnalysis,
      });
    }
    if (once.ok && parsed && parsed.found === false && parsed.error) {
      checkOnceError = normalizeCheckOnceError(parsed.error);
    } else if (!once.ok) {
      checkOnceError = once.error || null;
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
      ? `Не удалось проверить канал: ${checkOnceError}${kroCheckQueueRange ? ' Канал добавлен в очередь — попробуйте снова через несколько минут (до ~10).' : ''}`
      : checkingMessage;
    const analysis = {
      v: 0,
      channel_key: requestKey || channelMatchKey(channel) || channel,
      generated_at: new Date().toISOString(),
      sources: checkOnceError ? [] : ['ожидание проверки'],
      basic_info: [
        `Запрос: ${channel}`,
        checkOnceError
          ? `Что случилось: ${checkOnceError}`
          : 'Проверка ещё не завершилась — это нормально для «тяжёлых» каналов.',
      ],
      content_behavior: [],
      external_reports: [],
      ties_risk_factors: [],
      conclusion: {
        status: KRO_V0_STATUS.watch,
        reasons: [
          checkOnceError
            ? `Сначала разберёмся с ошибкой: ${checkOnceError}`
            : 'Пока нет устойчивого результата по постам — это состояние ожидания, не вывод «всё чисто».',
          kroCheckQueueRange
            ? 'Канал поставлен в очередь: откройте отчёт снова через несколько минут (полный проход — до ~10).'
            : 'Очередь не настроена — остаётся дождаться фонового цикла мониторинга.',
        ].filter(Boolean),
      },
    };
    const watchRowQueue = await fetchLatestChannelsWatchRowForKey(client, requestKey);
    if (watchRowQueue) kroV0EnrichAnalysisWithWatch(analysis, watchRowQueue);
    return res.json({
      found: false,
      pending: !!kroCheckQueueRange,
      channel,
      message: finalMessage,
      error_detail: checkOnceError || undefined,
      analysis,
    });
  } catch (e) {
    console.error('KRO check error:', e);
    return res.status(500).json({
      found: false,
      channel,
      pending: true,
      message: checkingMessage,
      error: 'internal_error',
      analysis: {
        v: 0,
        channel_key: channelMatchKey(channel) || channel,
        generated_at: new Date().toISOString(),
        sources: [],
        basic_info: ['На сервере произошла внутренняя ошибка при проверке.'],
        content_behavior: [],
        external_reports: [],
        ties_risk_factors: [],
        conclusion: {
          status: KRO_V0_STATUS.watch,
          reasons: ['Попробуйте ещё раз чуть позже.'],
        },
      },
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
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  try {
    const fresh = String(req.query.fresh || '').toLowerCase();
    const forceFresh = fresh === '1' || fresh === 'true' || fresh === 'yes';
    if (!forceFresh && kroLiveCounterCache.payload && (Date.now() - kroLiveCounterCache.ts) < LIVE_COUNTER_CACHE_TTL_MS) {
      return res.json(kroLiveCounterCache.payload);
    }
    // Единственный источник данных: Google Sheets scam_base.
    // Никакого кеша, никаких файлов, никаких fallback — только реальные данные из таблицы.
    const sheetsClient = await getKroSheetsClient();
    if (sheetsClient) {
      const cycleMeta = await readKroCycleMetaFromSheets(sheetsClient);
      const sheetName = kroScamBaseRange.split('!')[0] || 'scam_base';
      const metaSheetName = kroMetaRange.split('!')[0] || 'kro_meta';
      console.log(`[KRO live-counter] reading from Sheets: ${kroSheetId} / ${sheetName}`);
      console.log('KRO META SOURCE: reading from', `Google Sheets ${metaSheetName}`, cycleMeta.last_cycle_at);
      const [sheetResp, watchResp] = await Promise.all([
        sheetsClient.sheets.spreadsheets.values.get({
          spreadsheetId: kroSheetId,
          range: kroScamBaseRange
        }),
        sheetsClient.sheets.spreadsheets.values.get({
          spreadsheetId: kroSheetId,
          range: kroChannelsWatchRange
        }),
      ]);
      const rawRows = sheetResp.data.values || [];
      const dataRows = rawRows.length ? rawRows.slice(1) : [];
      const parsedRows = dataRows.map(parseScamBaseRow).filter(r => r.username && r.username !== 'username');
      console.log(`[KRO live-counter] parsed ${parsedRows.length} rows from scam_base (header row skipped)`);
      const watchRawRows = watchResp.data.values || [];
      const channelsWatch = watchRawRows
        .map(parseChannelsWatchRow)
        .filter((r) => r && r.username && r.username !== 'username');
      const watchSummary = buildVisibleChannelsWatchSummary(channelsWatch);
      const scamBaseCounter = buildLiveCounterFromScamBase(parsedRows);
      const roll12 = buildScamBase12hRollup(parsedRows);
      const top3AllTime = Array.isArray(scamBaseCounter.top3) ? scamBaseCounter.top3 : [];
      console.log('TOP3 (вся база по потерям):', JSON.stringify(top3AllTime.slice(0, 3)));
      const metaStr = cycleMeta.last_cycle_at;
      const cycleTs = metaStr ? Date.parse(metaStr) : NaN;
      const rowTs = scamBaseCounter.updatedAt ? Date.parse(scamBaseCounter.updatedAt) : NaN;
      const displayUpdatedAt =
        Number.isFinite(cycleTs) && Number.isFinite(rowTs)
          ? (cycleTs >= rowTs ? metaStr : scamBaseCounter.updatedAt)
          : (metaStr || scamBaseCounter.updatedAt || null);
      const newInCycle = Math.max(0, Math.floor(Number(cycleMeta.new_in_cycle) || 0));
      const channelsScanned = Math.max(0, Math.floor(Number(cycleMeta.channels_scanned_in_cycle) || 0));
      const channelsTodayVal = channelsScanned > 0 ? channelsScanned : newInCycle;
      const reportsFormCount = await countReportsFormRows(sheetsClient);
      // Главная — большая цифра: только new_in_cycle из kro_meta (не окно 12 ч по дате обнаружения в scam_base).
      const caption12 = `Потери за 12 ч: ${roll12.lossesSum.toLocaleString('ru-RU')} ₽ · в базе: ${scamBaseCounter.channels_total}.`;
      const totalLostAllTime = scamBaseCounter.losses_12h;
      const shockTextLive =
        buildKroDocumentedShockText(totalLostAllTime, scamBaseCounter.channels_total) || KRO_PENDING_REPORT_TEXT;
      const payload = {
        channelsToday: channelsTodayVal,
        new_in_cycle_meta: newInCycle,
        channels_scanned_in_cycle: channelsScanned,
        channelsTotal: scamBaseCounter.channels_total,
        totalLost: totalLostAllTime,
        telegramCount: roll12.telegramCount,
        coursesCount: roll12.coursesCount,
        /** Сумма числового столбца по строкам базы (не число людей и не строки листа reports). */
        mentions_in_sources_sum: scamBaseCounter.complaints_received,
        complaints_received: scamBaseCounter.complaints_received,
        /** Строки на листе отчётов с source=form (форма на сайте). */
        reports_via_form_count: reportsFormCount != null ? reportsFormCount : 0,
        complaints_12h: roll12.complaintsSum,
        victims_12h: null,
        shockText: shockTextLive,
        top3: top3AllTime,
        report_doc_url: KRO_SOURCES_DOC_URL,
        sourceCaption: caption12,
        status_summary: buildStatusSummary(roll12.rowSnapshots),
        status_summary_all_time: scamBaseCounter.status_summary,
        watch_under_observation_total: watchSummary.under_watch_total,
        watch_visible_total: watchSummary.visible_total,
        watch_status_summary: watchSummary.status_summary,
        publishStatus: scamBaseCounter.isHonestZero && roll12.uniqueChannels === 0 ? 'honest_zero' : scamBaseCounter.publishStatus,
        isHonestZero: scamBaseCounter.isHonestZero && roll12.uniqueChannels === 0,
        siteNotice: null,
        lastValidUpdatedAt: displayUpdatedAt,
        updatedAt: displayUpdatedAt,
        last_cycle_at: cycleMeta.last_cycle_at,
        new_in_cycle: newInCycle,
        channels_scanned_in_cycle: channelsScanned,
        sources_checked: cycleMeta.sources_checked,
        rollup_12h: {
          losses_rub: roll12.lossesSum,
          mentions_in_sources_sum: roll12.complaintsSum,
          telegram: roll12.telegramCount,
          courses: roll12.coursesCount,
        },
      };
      kroLiveCounterCache = { payload, ts: Date.now() };
      return res.json(payload);
    } else {
      console.warn('[KRO live-counter] no Sheets client — KRO_GOOGLE_CREDENTIALS_JSON not set on Render?');
    }

    // Sheets недоступен — честный ноль с пояснением
    const cycleMeta = { last_cycle_at: null, new_in_cycle: 0, sources_checked: [] };
    console.log('KRO META SOURCE: reading from', 'unavailable (no Sheets client)');
    return res.json({
      channelsToday: 0,
      new_in_cycle_meta: 0,
      channels_scanned_in_cycle: 0,
      channelsTotal: 0,
      totalLost: 0,
      telegramCount: 0,
      coursesCount: 0,
      mentions_in_sources_sum: 0,
      complaints_received: 0,
      reports_via_form_count: 0,
      complaints_12h: 0,
      victims_12h: null,
      shockText: KRO_PENDING_REPORT_TEXT,
      top3: [],
      report_doc_url: KRO_SOURCES_DOC_URL,
      sourceCaption: 'Мониторинг запущен — данные после первого цикла.',
      status_summary: buildStatusSummary([]),
      status_summary_all_time: buildStatusSummary([]),
      watch_under_observation_total: 0,
      watch_visible_total: 0,
      watch_status_summary: buildStatusSummary([]),
      publishStatus: 'honest_zero',
      isHonestZero: true,
      siteNotice: null,
      lastValidUpdatedAt: null,
      updatedAt: null,
      last_cycle_at: cycleMeta.last_cycle_at,
      new_in_cycle: cycleMeta.new_in_cycle,
      sources_checked: cycleMeta.sources_checked,
      rollup_12h: {
        losses_rub: 0,
        mentions_in_sources_sum: 0,
        telegram: 0,
        courses: 0,
      },
    });
  } catch (e) {
    console.error('KRO live-counter error:', e);
    const cycleMeta = { last_cycle_at: null, new_in_cycle: 0, sources_checked: [] };
    console.log('KRO META SOURCE: reading from', 'unavailable (exception path)');
    res.json({
      channelsToday: 0,
      new_in_cycle_meta: 0,
      channels_scanned_in_cycle: 0,
      channelsTotal: 0,
      totalLost: 0,
      telegramCount: 0,
      coursesCount: 0,
      mentions_in_sources_sum: 0,
      complaints_received: 0,
      reports_via_form_count: 0,
      complaints_12h: 0,
      victims_12h: null,
      shockText: KRO_PENDING_REPORT_TEXT,
      top3: [],
      report_doc_url: KRO_SOURCES_DOC_URL,
      sourceCaption: 'Мониторинг запущен — данные после первого цикла.',
      status_summary: buildStatusSummary([]),
      status_summary_all_time: buildStatusSummary([]),
      watch_under_observation_total: 0,
      watch_visible_total: 0,
      watch_status_summary: buildStatusSummary([]),
      publishStatus: 'honest_zero',
      isHonestZero: true,
      siteNotice: null,
      lastValidUpdatedAt: null,
      updatedAt: null,
      last_cycle_at: cycleMeta.last_cycle_at,
      new_in_cycle: cycleMeta.new_in_cycle,
      sources_checked: cycleMeta.sources_checked,
      rollup_12h: {
        losses_rub: 0,
        mentions_in_sources_sum: 0,
        telegram: 0,
        courses: 0,
      },
    });
  }
});

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
        range: kroMetaRange
      }),
      sheetsClient.sheets.spreadsheets.values.get({
        spreadsheetId: kroSheetId,
        range: 'kro_history!A:F'
      })
    ]);

    if (scamResp.status === 'rejected') {
      console.error('KRO monitor-data: scam_base Sheets read failed:', scamResp.reason);
    }

    // scam_base rows (skip header)
    const scamRawRows = scamResp.status === 'fulfilled' ? (scamResp.value.data.values || []) : [];
    const scamHeaderSkipped = scamRawRows.length > 0 ? scamRawRows.slice(1) : [];
    const scamRowsAll = scamHeaderSkipped
      .map(parseScamBaseRow)
      .filter(r => r.username && r.username !== 'username')
      .map(enrichScamBaseContentAnalysisForMonitor);
    const scamRows = dedupeScamBaseRowsByChannelLatest(
      scamRowsAll.filter(isScamBaseRowInLiveCounterDataset),
    );

    const watchRawRows = watchResp.status === 'fulfilled' ? (watchResp.value.data.values || []) : [];
    const channelsWatch = watchRawRows
      .map(parseChannelsWatchRow)
      .filter((r) => r && r.username && r.username !== 'username')
      .filter(isVisibleChannelsWatchRow);

    const networkRawRows = networkResp.status === 'fulfilled' ? (networkResp.value.data.values || []) : [];
    const channelsNetwork = networkRawRows
      .map(parseChannelsNetworkRow)
      .filter((r) => r && r.source_channel && r.target_channel);

    // kro_meta
    const metaRows = metaResp.status === 'fulfilled' ? (metaResp.value.data.values || []) : [];
    const metaBase = parseKroCycleMetaRows(metaRows);
    const freshness = parseCycleFreshnessMeta(metaBase.last_cycle_at);
    const meta = { ...metaBase, ...freshness };

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

    const recent_cases = buildMonitorRecentCasesFromScamBase(scamRows, 3);
    const status_summary = buildStatusSummary(scamRows);
    const parsedForLive = scamHeaderSkipped
      .map(parseScamBaseRow)
      .filter((r) => r.username && r.username !== 'username');
    const liveFromBase = buildLiveCounterFromScamBase(parsedForLive);
    const nowMs = Date.now();
    const roll12 = buildScamBase12hRollup(parsedForLive, nowMs);
    const cutoff12 = nowMs - KRO_SCAM_BASE_ROLLING_12H_MS;
    const findings12h = [...scamRows]
      .filter((r) => parseScamDetectedAtMs(r) >= cutoff12)
      .sort((a, b) => parseScamDetectedAtMs(b) - parseScamDetectedAtMs(a))
      .map((r) => ({
        username: r.username,
        link: r.link || '',
        detected_at: r.detected_at || '',
        object_type: r.object_type || '',
        source_primary: r.source_primary || '',
        source_evidence: r.source_evidence || '',
        status: r.status || '',
        complaints: r.complaints != null ? r.complaints : null,
        total_loss_rub: r.total_loss_rub != null ? r.total_loss_rub : 0,
        reason_summary: kroScamBaseReasonSummaryLine(r),
      }));

    return res.json({
      scam_base: scamRows,
      /** Алиас для отладки и клиентов, ожидающих поле `rows` (то же, что scam_base после фильтров). */
      rows: scamRows,
      scam_base_sheet_rows: scamHeaderSkipped.length,
      scam_base_after_filter: scamRows.length,
      channels_watch: channelsWatch,
      channels_network: channelsNetwork,
      meta,
      status_summary,
      channels_total: liveFromBase.channels_total,
      confirmed_status_summary: liveFromBase.status_summary,
      confirmed_status_summary_12h: buildStatusSummary(roll12.rowSnapshots),
      rollup_12h: {
        losses_rub: roll12.lossesSum,
        mentions_in_sources_sum: roll12.complaintsSum,
        telegram: roll12.telegramCount,
        courses: roll12.coursesCount,
      },
      findings_12h: findings12h,
      history,
      recent_cases
    });
  } catch (e) {
    console.error('KRO monitor-data error:', e);
    return res.status(500).json({ error: 'internal error', detail: e.message });
  }
});

/** Для выбора самой свежей строки при дубликатах в scam_base. */
function parseScamDetectedAtMs(row) {
  if (!row) return 0;
  const s = (row.detected_at || '').toString().trim();
  if (!s) return 0;
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return iso;
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) {
    const d = Date.parse(
      `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}T12:00:00.000Z`
    );
    return Number.isFinite(d) ? d : 0;
  }
  return 0;
}

function parseCycleFreshnessMeta(lastCycleAtRaw) {
  const raw = (lastCycleAtRaw || '').toString().trim();
  const parsed = Date.parse(raw);
  if (!raw || !Number.isFinite(parsed)) {
    return {
      cycle_age_hours: null,
      cycle_stale: true,
      cycle_warning: 'данные могут быть устаревшими',
    };
  }
  const ageMs = Math.max(0, Date.now() - parsed);
  const ageHours = Math.round((ageMs / (60 * 60 * 1000)) * 10) / 10;
  const stale = ageMs > 13 * 60 * 60 * 1000;
  return {
    cycle_age_hours: ageHours,
    cycle_stale: stale,
    cycle_warning: stale ? 'данные могут быть устаревшими' : '',
  };
}

// GET /api/kro/channel-profile?u=… — одна запись scam_base (последняя по дате обнаружения при нескольких строках)
app.get('/api/kro/channel-profile', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  const rawQ = (req.query.u ?? '').toString().trim();
  if (!rawQ || rawQ.length > 220) {
    return res.status(400).json({ error: 'bad_request', message: 'query parameter u is required' });
  }
  let decoded = rawQ;
  try {
    decoded = decodeURIComponent(rawQ.replace(/\+/g, ' '));
  } catch {
    decoded = rawQ;
  }
  decoded = decoded.replace(/^@+/, '').replace(/^(%40)+/gi, '').trim();
  const key = channelMatchKey(decoded);
  if (!key) {
    return res.status(400).json({ error: 'bad_request', message: 'invalid channel key' });
  }
  try {
    const sheetsClient = await getKroSheetsClient();
    if (!sheetsClient || !kroSheetId) {
      const analysis = {
        v: 0,
        channel_key: key,
        generated_at: new Date().toISOString(),
        sources: ['настройки сервера'],
        basic_info: [`Канал: @${decoded}`, 'Таблица с базой сейчас не подключена — сравнить с карточкой нельзя.'],
        content_behavior: [],
        external_reports: [],
        ties_risk_factors: [],
        conclusion: {
          status: KRO_V0_STATUS.watch,
          reasons: ['Проверка отложена: нет доступа к Google Sheets. Попробуйте позже.'],
        },
      };
      return res.status(200).json({
        profile: null,
        merged_rows: undefined,
        risk_index: null,
        risk_index_max: 100,
        false_positive_count: 0,
        analysis,
        live_metrics: null,
      });
    }
    const scamResp = await sheetsClient.sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: kroScamBaseRange
    });
    const scamRawRows = scamResp.data.values || [];
    const scamRows = scamRawRows
      .slice(1)
      .map(parseScamBaseRow)
      .filter((r) => r.username && r.username !== 'username')
      .map(enrichScamBaseContentAnalysisForMonitor);
    const matches = scamRows.filter((r) => channelMatchKey(r.username) === key);
    if (!matches.length) {
      const channelForOnce = /^t\.me\//i.test(decoded) || decoded.includes('+')
        ? decoded
        : `@${decoded}`;
      const once = kroRunCheckOnce(channelForOnce, { readOnly: true });
      if (once.stderr) console.error('KRO channel-profile check_once stderr:', once.stderr);
      const analysis = kroV0BuildAnalysisFromLiveParsed(once.parsed, key);
      kroV0PrependNoScamBaseCardNote(analysis);
      const watchRowCp0 = await fetchLatestChannelsWatchRowForKey(sheetsClient, key);
      if (watchRowCp0) kroV0EnrichAnalysisWithWatch(analysis, watchRowCp0);
      return res.status(200).json({
        profile: null,
        merged_rows: undefined,
        risk_index: null,
        risk_index_max: 100,
        false_positive_count: 0,
        analysis,
        live_metrics: kroLiveMetricsFromParsed(once.parsed),
      });
    }
    const bestAny = matches.reduce((best, cur) =>
      parseScamDetectedAtMs(cur) >= parseScamDetectedAtMs(best) ? cur : best
    );
    const liveMatches = matches.filter((r) => isScamBaseRowInLiveCounterDataset(r));
    if (!liveMatches.length) {
      const channelForOnce = /^t\.me\//i.test(decoded) || decoded.includes('+')
        ? decoded
        : `@${decoded}`;
      const once = kroRunCheckOnce(channelForOnce, { readOnly: true });
      if (once.stderr) console.error('KRO channel-profile check_once stderr:', once.stderr);
      const liveAnalysis = kroV0BuildAnalysisFromLiveParsed(once.parsed, key);
      const analysis = {
        ...liveAnalysis,
        basic_info: [
          `В таблице есть ${matches.length} запис(и) по этому каналу, но в публичном мониторе они скрыты общими правилами — ниже показана быстрая проверка по постам.`,
          `Для справки, в «сырой» строке статус выглядит как: «${(bestAny.status || bestAny.verdict || '—')}».`,
        ].concat(liveAnalysis.basic_info || []),
      };
      const watchRowCp1 = await fetchLatestChannelsWatchRowForKey(sheetsClient, key);
      if (watchRowCp1) kroV0EnrichAnalysisWithWatch(analysis, watchRowCp1);
      return res.status(200).json({
        profile: null,
        merged_rows: matches.length > 1 ? matches.length : undefined,
        risk_index: null,
        risk_index_max: 100,
        false_positive_count: 0,
        analysis,
        live_metrics: kroLiveMetricsFromParsed(once.parsed),
      });
    }
    const profile = liveMatches.reduce((best, cur) =>
      parseScamDetectedAtMs(cur) >= parseScamDetectedAtMs(best) ? cur : best
    );
    const reportsForChannel = await getAllReportsForChannel(sheetsClient, profile.username);
    const risk_index = computeKroRiskIndex(profile, reportsForChannel);
    const false_positive_count = reportsForChannel.filter(
      (r) => (r.source || '').toLowerCase() === 'false_positive'
    ).length;
    const profileForAnalysis = enrichScamBaseContentAnalysisForMonitor(profile);
    const analysis = kroV0BuildAnalysisFromScamBaseProfile(profileForAnalysis, { channel_key: key });
    const watchRowCp2 = await fetchLatestChannelsWatchRowForKey(sheetsClient, key);
    if (watchRowCp2) kroV0EnrichAnalysisWithWatch(analysis, watchRowCp2);
    return res.json({
      profile,
      merged_rows: matches.length > 1 ? matches.length : undefined,
      risk_index,
      risk_index_max: 100,
      false_positive_count,
      analysis,
      live_metrics: null,
    });
  } catch (e) {
    console.error('KRO channel-profile error:', e);
    return res.status(200).json({
      profile: null,
      merged_rows: undefined,
      risk_index: null,
      risk_index_max: 100,
      false_positive_count: 0,
      analysis: {
        v: 0,
        channel_key: key,
        generated_at: new Date().toISOString(),
        sources: [],
        basic_info: ['Не удалось загрузить данные из таблицы.'],
        content_behavior: [],
        external_reports: [],
        ties_risk_factors: [],
        conclusion: {
          status: KRO_V0_STATUS.watch,
          reasons: ['Сервис не смог прочитать базу — попробуйте обновить страницу позже.'],
        },
      },
      live_metrics: null,
      error: 'internal_error',
    });
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
    resetKroLiveCounterCache();
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
      range: 'A2:I'
    });
    const rows = response.data.values || [];
    const key = channelMatchKey(channel);
    if (!key) return [];
    return rows.filter(r => channelMatchKey((r[1] || '').toString()) === key).map(r => ({
      date: (r[0] || '').toString().trim(),
      channel: (r[1] || '').toString().trim(),
      sum: parseInt((r[2] || '0').toString().replace(/\s/g, ''), 10) || 0,
      source: (r[3] || '').toString().trim(),
      status: (r[4] || '').toString().trim(),
      reporter: (r[5] || '').toString().trim(),
      description: (r[6] || '').toString().trim(),
      proof_url: (r[7] || '').toString().trim(),
      object_type: (r[8] || '').toString().trim(),
    }));
  } catch (e) {
    return [];
  }
}

/** Маркеры URL разоблачителей для индекса риска (должны пересекаться с source_evidence / source_primary). */
const KRO_WHISTLEBLOWER_RISK_MARKERS = [
  'stop-scam',
  'fin-obzor',
  'vklader',
  'telltrue',
  'forteck',
  'cryptorussia',
  'brokers-check',
  'kurs.expert',
];

/** True если в жалобах или evidence есть ссылка/упоминание сайта-разоблачителя (паритет с worker). */
function kroBlobHasWhistleblowerMarker(blob) {
  const low = String(blob || '').toLowerCase();
  if (!low.trim()) return false;
  return KRO_WHISTLEBLOWER_RISK_MARKERS.some((m) => low.includes(String(m).toLowerCase()));
}

function kroReportsHaveWhistleblowerEvidence(reports, sourceEvidence) {
  const parts = [];
  for (const r of reports || []) {
    parts.push((r.description || '').trim(), (r.proof_url || '').trim(), (r.source || '').trim());
  }
  parts.push(sourceEvidence || '');
  return kroBlobHasWhistleblowerMarker(parts.join(' '));
}

function computeKroRiskIndex(profile, reports) {
  let score = 0;
  let red = 0;
  let yellow = 0;
  const caRaw = profile && profile.content_analysis;
  try {
    const ca = typeof caRaw === 'string' ? JSON.parse(caRaw || '{}') : caRaw || {};
    const ur = ca.unified_risk || {};
    const reds = ur.red_flags;
    const yellows = ur.yellow_flags;
    red = Array.isArray(reds) ? reds.length : (Number(ur.red_count) || 0);
    yellow = Array.isArray(yellows) ? yellows.length : (Number(ur.yellow_count) || 0);
  } catch (_) {
    /* ignore */
  }
  score += red * 20 + yellow * 10;
  const repList = Array.isArray(reports) ? reports : [];
  const formCount = repList.filter((r) => (r.source || '').toLowerCase() === 'form').length;
  const sheetComplaints = Number(profile && profile.complaints) || 0;
  const userComplaintUnits = Math.max(formCount, sheetComplaints);
  score += userComplaintUnits * 15;
  const blob = `${profile && profile.source_primary ? profile.source_primary : ''} ${profile && profile.source_evidence ? profile.source_evidence : ''}`.toLowerCase();
  if (KRO_WHISTLEBLOWER_RISK_MARKERS.some((m) => blob.includes(m))) {
    score += 25;
  }
  return Math.min(100, score);
}

/**
 * После ≥3 отчётов false_positive — статус «под наблюдением», в доказательствах — «оспаривается».
 */
async function applyFalsePositiveDowngradeIfNeeded(client, channel) {
  if (!client || !kroSheetId) {
    return { false_positive_count: 0, downgraded: false };
  }
  const reports = await getAllReportsForChannel(client, channel);
  const fpCount = reports.filter((r) => (r.source || '').toLowerCase() === 'false_positive').length;
  if (fpCount < 3) {
    return { false_positive_count: fpCount, downgraded: false };
  }
  const sheetName = kroScamBaseSheet;
  const key = channelMatchKey(channel);
  try {
    const resp = await client.sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: `${sheetName}!A2:N`,
    });
    const rows = resp.data.values || [];
    const data = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (channelMatchKey((row[0] || '').toString()) !== key) {
        continue;
      }
      const rowNum = i + 2;
      const currentEv = (row[10] || '').toString();
      const newEv = currentEv.includes('оспаривается')
        ? currentEv
        : `${currentEv}${currentEv ? ' ' : ''}(оспаривается)`.trim();
      data.push({ range: `${sheetName}!M${rowNum}`, values: [['под наблюдением']] });
      data.push({ range: `${sheetName}!K${rowNum}`, values: [[newEv]] });
    }
    if (data.length) {
      await client.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: kroSheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data,
        },
      });
    }
    return { false_positive_count: fpCount, downgraded: data.length > 0 };
  } catch (e) {
    console.error('[KRO] applyFalsePositiveDowngradeIfNeeded:', e);
    return { false_positive_count: fpCount, downgraded: false };
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
  // Telegram / TON / крупные платформы (паритет с kro_false_positive_guards.py)
  'telegram', 'durov', 'toncoin', 'fragment', 'wallet',
  'instagram', 'tiktok', 'youtube', 'vk', 'ok',
  'proton',
  'whatsapp', 'viber', 'signal', 'discord', 'reddit',
  'twitter', 'x', 'facebook', 'meta',
  'google', 'apple', 'microsoft', 'amazon',
  'alibaba', 'aliexpress', 'wildberries', 'ozon',
  'avito', 'sbermegamarket',
]);

function kroUsernameGloballyExcluded(channel) {
  const key = channelMatchKey(channel);
  if (!key) return false;
  if (KRO_CHANNEL_EXCLUSION.has(key)) return true;
  if (KRO_PERMANENT_BLOCKLIST.has(key)) return true;
  if (key.startsWith('poizon')) return true;
  return false;
}

async function checkAndPromoteToScamBase(client, channel) {
  if (!client || !kroSheetId || !kroScamBaseRange) return;
  if (kroUsernameGloballyExcluded(channel)) {
    console.log(`[KRO] ${channel} — глобальное исключение (платформа / Poizon* / blocklist / биржи), не промотируем в scam_base`);
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
    const explicitOt = reports.map(r => r.object_type).find(Boolean) || '';
    const { display, link, objectType } = scamBaseDisplayLinkForPromote(channel, explicitOt);
    const reportsGamblingBlob = reports
      .map((r) => `${r.description || ''} ${r.proof_url || ''} ${r.object_type || ''}`)
      .join(' ');
    let sourceEvidence = reports
      .slice(0, 3)
      .map((r) => r.description || r.proof_url)
      .filter(Boolean)
      .join('; ');
    const rp = riskPrefixForObjectType(objectType);
    if (rp) sourceEvidence = `${rp} | ${sourceEvidence}`.slice(0, 500);

    if (!kroReportsHaveWhistleblowerEvidence(reports, sourceEvidence)) {
      console.log(
        `[KRO] ${display} skipped: scam_base promotion requires external whistleblower URL (vklader, stop-scam1, …) in reports`,
      );
      return;
    }

    const isTg = looksLikeTelegramChannelRef(channel, display, link, objectType);
    if (isTg) {
      const complaintJoined = reports.map((r) => (r.description || '').trim()).filter(Boolean).join(' ');
      if (!kroSourceSignalACryptoFromParts('form+web', sourceEvidence, objectType, complaintJoined)) {
        console.log(`[KRO] ${display} skipped: no signal A (crypto markers in lead/complaints)`);
        return;
      }
      const wSrc = kroComputeSourceWeightForPromote(reports, sourceEvidence);
      if (wSrc < KRO_MIN_SOURCE_WEIGHT_SCAM_BASE - 1e-6) {
        console.log(`[KRO] ${display} skipped: source weight ${wSrc.toFixed(2)} < ${KRO_MIN_SOURCE_WEIGHT_SCAM_BASE}`);
        return;
      }
    } else {
      const gPromo = gamblingTopicHit(channel, display, link, objectType, reportsGamblingBlob);
      if (gPromo) {
        console.log(`[KRO] ${display} skipped: gambling topic (${gPromo})`);
        return;
      }
      const otHit = kroOffTopicBusinessHit(reportsGamblingBlob);
      if (otHit) {
        console.log(`[KRO] ${display} skipped: off-topic (${otHit})`);
        return;
      }
      if (!isCryptoContextAllowed(display, objectType, reports.map((r) => `${r.description || ''} ${r.proof_url || ''}`).join(' '))) {
        console.log(`[KRO] ${display} skipped: no crypto context for scam_base promotion`);
        return;
      }
    }

    const gate = await passesKroTmeHttpGateForScamBase(link, '', objectType);
    if (!gate.ok) {
      console.log(`[KRO] ${display} skipped: t.me HTTP gate ${gate.reason}`);
      return;
    }
    const cycleWindow = now.toISOString().slice(0, 10) + (now.getUTCHours() < 12 ? '_am' : '_pm');

    const sheetName = kroScamBaseRange.split('!')[0] || 'scam_base';
    const complaintsForSheet = uniqueCount;
    const effectiveStatus = statusWithLossFloor('в риске', totalLoss);
    const v2Row = [[
      display, link, detectedAt, '', '', objectType, '',
      complaintsForSheet, totalLoss, 'form', sourceEvidence, cycleWindow, effectiveStatus, ''
    ]];
    await client.sheets.spreadsheets.values.append({
      spreadsheetId: kroSheetId,
      range: `${sheetName}!A:N`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: v2Row }
    });
    console.log(`[KRO] Promoted ${display} to scam_base type=${objectType} (${uniqueCount} unique reporters, ${reports.length} rows, loss ${totalLoss}₽)`);
  } catch (e) {
    console.error('[KRO] checkAndPromoteToScamBase error:', e);
  }
}

app.post('/api/kro/report-scam', express.json(), async (req, res) => {
  const channelRaw = (req.body?.channel ?? '').toString().trim();
  const channel = normalizeChannel(channelRaw) || channelRaw.toLowerCase().replace(/\s/g, '');
  const sumRub = Number(req.body?.sumRub);
  const description = (req.body?.description ?? '').toString().trim();
  const proofUrl = (req.body?.proofUrl ?? '').toString().trim();
  const from = (req.body?.from ?? '').toString().trim();
  const objectType = (req.body?.objectType ?? '').toString().trim().slice(0, 80);
  if (!channel || !Number.isFinite(sumRub) || sumRub < 0) {
    return res.status(400).json({ error: 'channel and sumRub (non-negative number) are required' });
  }
  if (!description) {
    return res.status(400).json({ error: 'description is required' });
  }
  if (gamblingTopicHit(channelRaw, channel, description, proofUrl, objectType)) {
    return res.status(400).json({ error: 'off_topic_gambling' });
  }
  try {
    const client = await getKroSheetsClient();
    if (!client) {
      return res.status(503).json({ error: 'live_counter_not_configured' });
    }
    const today = getTodayMSK();
    // Schema A:I — D=source, E=status, F=reporter, G=description, H=proof_url, I=object_type (опц.)
    const row = [[today.dateKey, channel, sumRub, 'form', 'Активен', from || '', description, proofUrl || '', objectType]];
    await client.sheets.spreadsheets.values.append({
      spreadsheetId: kroSheetId,
      range: 'A:I',
      valueInputOption: 'RAW',
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

app.post('/api/kro/report-false-positive', express.json(), async (req, res) => {
  const channelRaw = (req.body?.channel ?? '').toString().trim();
  const channel = normalizeChannel(channelRaw) || channelRaw.toLowerCase().replace(/\s/g, '');
  if (!channel) {
    return res.status(400).json({ error: 'channel is required' });
  }
  try {
    const client = await getKroSheetsClient();
    if (!client) {
      return res.status(503).json({ error: 'live_counter_not_configured' });
    }
    const today = getTodayMSK();
    const desc =
      'false_positive: пользователь на странице канала отметил запись как ошибочную (честный канал).';
    const row = [[today.dateKey, channel, 0, 'false_positive', 'Активен', 'site_channel_page', desc, '', '']];
    await client.sheets.spreadsheets.values.append({
      spreadsheetId: kroSheetId,
      range: 'A:I',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: row },
    });
    const fpResult = await applyFalsePositiveDowngradeIfNeeded(client, channel);
    res.status(200).json({
      ok: true,
      false_positive_count: fpResult.false_positive_count,
      downgraded: fpResult.downgraded,
    });
  } catch (e) {
    console.error('KRO report-false-positive error:', e);
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
  resetKroLiveCounterCache();
  console.log('[KRO] live-counter cache reset on HTTP server listen (start / post-deploy process)');
  console.log(`✅ HTTP Backend listening on port ${PORT}`);
  console.log(`🌐 Access via: http://localhost:${PORT} or http://192.168.1.142:${PORT}`);
});

if (httpsOptions) {
  https.createServer(httpsOptions, app).listen(4443, '0.0.0.0', () => {
    resetKroLiveCounterCache();
    console.log('[KRO] live-counter cache reset on HTTPS server listen');
    console.log(`✅ HTTPS Backend listening on port 4443`);
    console.log(`🔒 Access via: https://localhost:4443 or https://192.168.1.142:4443`);
  });
}
