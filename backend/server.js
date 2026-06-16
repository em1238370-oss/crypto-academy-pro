import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, join, sep } from 'path';
import { spawn, spawnSync } from 'child_process';
import Stripe from 'stripe';
import { kroDetectSchemesInTexts, kroFindSchemeByName, kroDetectSoftPatternSignals } from './kro-schemes/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const perfNow = () => (globalThis.performance && typeof globalThis.performance.now === 'function'
  ? globalThis.performance.now()
  : Date.now());

// Load .env from parent directory (project root)
dotenv.config({ path: join(__dirname, '..', '.env') });

const app = express();
app.set('trust proxy', 1);
app.use(cors());
// Store raw body for NOWPayments webhook signature verification
app.use('/api/payments/nowpayments/callback', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'crypto-academy-pro' });
});

// Disable strict CSP headers that block inline scripts
app.use((req, res, next) => {
  // Remove CSP header if set by Express middleware
  res.removeHeader('Content-Security-Policy');
  // Set a more permissive CSP for development
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https: fonts.googleapis.com; font-src 'self' https: fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https: api.mistral.ai api.cryptocloud.plus;");
  next();
});

// Редирект /channel?u=ник → /channel/ник (хэш #… в HTTP не приходит — для BYO добавляем ?byo=1)
app.get(['/channel', '/channel/'], (req, res) => {
  const q = req.query || {};
  const raw = (q.u != null ? String(q.u) : q.channel != null ? String(q.channel) : '').trim().replace(/^@+/, '');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  if (!raw) {
    return res.redirect(302, '/');
  }
  const slug = encodeURIComponent(raw);
  const byoOn = String(q.byo ?? '') === '1';
  const dest = byoOn ? `/channel/${slug}?byo=1` : `/channel/${slug}`;
  return res.redirect(302, dest);
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

app.get('/check', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile('check.html', { root: join(__dirname, '..') });
});

// Serve static files from parent directory (HTML, CSS, JS)
app.use(
  express.static(join(__dirname, '..'), {
    setHeaders(res, filePath) {
      const name = basename(filePath);
      if (name === 'index.html' || name === 'monitor.html' || name === 'channel.html' || name === 'check.html') {
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
/** Неверный ключ не должен ронять весь процесс при старте (Render exit 1). */
let stripe = null;
if (stripeSecretKey) {
  try {
    stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-11-20.acacia' });
  } catch (e) {
    console.warn('⚠️ Stripe: STRIPE_SECRET_KEY не принят SDK — платежи Stripe отключены до исправления ключа:', e && e.message ? String(e.message) : e);
  }
}
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
const kroCheckRequestsRange = process.env.KRO_CHECK_REQUESTS_RANGE || 'kro_check_requests!A2:E';
const kroCheckQueueRange = process.env.KRO_CHECK_QUEUE_RANGE || 'kro_check_queue!A2:G';
const kroCheckResultsRange = process.env.KRO_CHECK_RESULTS_RANGE || 'kro_check_results!A2:I';
/** Короткий снимок строк Sheets в памяти — меньше таймаутов на Render и быстрее ответ при серии запросов. */
const KRO_SHEETS_SNAPSHOT_CACHE_MS = Math.max(3000, parseInt(process.env.KRO_SHEETS_SNAPSHOT_CACHE_MS || '40000', 10));
let kroScamBaseValuesCache = { ts: 0, values: /** @type {string[][] | null} */ (null) };
let kroReportsRowsCache = { ts: 0, rows: /** @type {string[][] | null} */ (null) };
let kroChannelsWatchRawCache = { ts: 0, raw: /** @type {string[][] | null} */ (null) };

async function kroFetchScamBaseValuesCached(client) {
  if (!client || !kroSheetId) return [];
  const now = Date.now();
  if (kroScamBaseValuesCache.values && now - kroScamBaseValuesCache.ts < KRO_SHEETS_SNAPSHOT_CACHE_MS) {
    return kroScamBaseValuesCache.values;
  }
  const scamResp = await client.sheets.spreadsheets.values.get({
    spreadsheetId: kroSheetId,
    range: kroScamBaseRange,
  });
  const values = scamResp.data.values || [];
  kroScamBaseValuesCache = { ts: now, values };
  return values;
}

async function kroFetchReportsRowsCached(client) {
  if (!client || !kroSheetId) return [];
  const now = Date.now();
  if (kroReportsRowsCache.rows && now - kroReportsRowsCache.ts < KRO_SHEETS_SNAPSHOT_CACHE_MS) {
    return kroReportsRowsCache.rows;
  }
  const response = await client.sheets.spreadsheets.values.get({
    spreadsheetId: kroSheetId,
    range: 'A2:I',
  });
  const rows = response.data.values || [];
  kroReportsRowsCache = { ts: now, rows };
  return rows;
}

async function kroFetchChannelsWatchRawCached(client) {
  if (!client || !kroSheetId || !kroChannelsWatchRange) return [];
  const now = Date.now();
  if (kroChannelsWatchRawCache.raw && now - kroChannelsWatchRawCache.ts < KRO_SHEETS_SNAPSHOT_CACHE_MS) {
    return kroChannelsWatchRawCache.raw;
  }
  const resp = await client.sheets.spreadsheets.values.get({
    spreadsheetId: kroSheetId,
    range: kroChannelsWatchRange,
  });
  const raw = resp.data.values || [];
  kroChannelsWatchRawCache = { ts: now, raw };
  return raw;
}

/** Окно истории постов для живой проверки (check_once): 30, 90, 180 или 365. По умолчанию — 6 месяцев (180 дн.). */
const kroCheckOncePeriodDaysParsed = parseInt(process.env.KRO_CHECK_ONCE_PERIOD_DAYS || '180', 10);
const kroCheckOncePeriodDays = [30, 180, 365].includes(kroCheckOncePeriodDaysParsed) ? kroCheckOncePeriodDaysParsed : 180;
const kroCheckOnceTimeoutMsParsed = parseInt(process.env.KRO_CHECK_ONCE_TIMEOUT_MS || '', 10);
/** Дефолт check_once без явного timeoutMs: до 3 мин (быстрые сценарии). */
const kroCheckOnceTimeoutMs = Number.isFinite(kroCheckOnceTimeoutMsParsed) && kroCheckOnceTimeoutMsParsed >= 120000 && kroCheckOnceTimeoutMsParsed <= 1800000
  ? kroCheckOnceTimeoutMsParsed
  : 180000;
/** Быстрый слой на главной (?home_quick_live=1): верхняя граница чтения ленты (по умолчанию 45 с). */
const kroHomeQuickLiveTimeoutMsParsed = parseInt(process.env.KRO_HOME_QUICK_LIVE_TIMEOUT_MS || '45000', 10);
const kroHomeQuickLiveTimeoutMs =
  Number.isFinite(kroHomeQuickLiveTimeoutMsParsed) && kroHomeQuickLiveTimeoutMsParsed >= 15000 && kroHomeQuickLiveTimeoutMsParsed <= 120000
    ? kroHomeQuickLiveTimeoutMsParsed
    : 45000;
/** Fast на главной: жёсткий end-to-end лимит выполнения и ожидания (по умолчанию 7 минут). */
const kroAnalyzeFastMaxMsParsed = parseInt(process.env.KRO_ANALYZE_FAST_MAX_MS || '420000', 10);
const KRO_ANALYZE_FAST_MAX_MS =
  Number.isFinite(kroAnalyzeFastMaxMsParsed) && kroAnalyzeFastMaxMsParsed >= 60000 && kroAnalyzeFastMaxMsParsed <= 1800000
    ? kroAnalyzeFastMaxMsParsed
    : 420000;
/** POST /api/kro/analyze-channel: бюджет времени на public snapshot + Telethon + вспомогательные шаги (по умолчанию = окно fast, до 7 мин). */
const kroAnalyzeChannelSyncMsParsed = parseInt(process.env.KRO_ANALYZE_CHANNEL_SYNC_MS || '', 10);
const KRO_ANALYZE_CHANNEL_SYNC_MS =
  Number.isFinite(kroAnalyzeChannelSyncMsParsed) &&
    kroAnalyzeChannelSyncMsParsed >= 30000 &&
    kroAnalyzeChannelSyncMsParsed <= KRO_ANALYZE_FAST_MAX_MS
    ? kroAnalyzeChannelSyncMsParsed
    : KRO_ANALYZE_FAST_MAX_MS;
/** Главная «Проверь гуру»: по умолчанию сначала лента (Telethon + t.me/s до KRO_ANALYZE_CHANNEL_SYNC_MS). Значение `quick_sheets_only` — только таблицы + сайты + Claude (~KRO_HOME_QUICK_MS). */
const kroHomeAnalyzeMode = (process.env.KRO_HOME_ANALYZE_MODE || 'live_first').trim().toLowerCase();
const kroHomeQuickMsParsed = parseInt(process.env.KRO_HOME_QUICK_MS || '30000', 10);
const KRO_HOME_QUICK_MS =
  Number.isFinite(kroHomeQuickMsParsed) && kroHomeQuickMsParsed >= 8000 && kroHomeQuickMsParsed <= 120000
    ? kroHomeQuickMsParsed
    : 30000;
/** Бюджет HTTP-пробы публичной страницы t.me/s при вводе «название без @» (по умолчанию ~14 с). */
const kroPlainTitleResolveMsParsed = parseInt(process.env.KRO_PLAIN_TITLE_RESOLVE_MS || '14000', 10);
const KRO_PLAIN_TITLE_RESOLVE_MS =
  Number.isFinite(kroPlainTitleResolveMsParsed) && kroPlainTitleResolveMsParsed >= 4000 && kroPlainTitleResolveMsParsed <= 25000
    ? kroPlainTitleResolveMsParsed
    : 14000;
/** Целевой минимум постов с текстом на главной (Telethon + t.me/s), пока не исчерпан бюджет sync (~7 мин). */
const kroHomeAnalyzeMinPostsParsed = parseInt(process.env.KRO_HOME_ANALYZE_MIN_POSTS || '', 10);
const KRO_HOME_ANALYZE_MIN_POSTS =
  Number.isFinite(kroHomeAnalyzeMinPostsParsed) && kroHomeAnalyzeMinPostsParsed >= 5 && kroHomeAnalyzeMinPostsParsed <= 40
    ? kroHomeAnalyzeMinPostsParsed
    : 25;
/** Инвайт t.me/+: `manual_first` (по умолчанию) — без Telethon, быстрый слой + честный CTA со скриншотами; `try_telethon_first` — сначала живой разбор как у публичных каналов. */
const kroInviteClosedChannelMode = (process.env.KRO_INVITE_CLOSED_CHANNEL_MODE || 'manual_first').trim().toLowerCase();
const kroScreenshotHelpBotUrl = String(process.env.KRO_SCREENSHOT_HELP_BOT_URL || '').trim();
const kroScreenshotHelpFormUrl = String(process.env.KRO_SCREENSHOT_HELP_FORM_URL || '').trim();
const KRO_CLOSED_INVITE_NOTICE_RU =
  String(process.env.KRO_CLOSED_INVITE_NOTICE_RU || '').trim() ||
  'Это закрытый канал. Мы не можем прочитать его автоматически. Но ты можешь помочь — перешли нам 5–10 скриншотов постов из этого канала (бот или форма ниже), и мы доразберём и риски вручную по фактам.';
/** Инвайт: один GET к HTML Google (часто блокируется). Включить явно: KRO_INVITE_GOOGLE_SITE_SEARCH=1 */
const KRO_INVITE_GOOGLE_SITE_SEARCH = String(process.env.KRO_INVITE_GOOGLE_SITE_SEARCH || '').trim() === '1';
/** Инвайт: доп. один запрос к HTML DuckDuckGo (по умолчанию вкл.; отключить: KRO_INVITE_DDG_HTML_SEARCH=0) */
const KRO_INVITE_DDG_HTML_SEARCH = String(process.env.KRO_INVITE_DDG_HTML_SEARCH || '1').trim() !== '0';
/** Глубокий анализ ленты: верхняя граница ~30 мин, горизонт до 6 мес. (periodDays 180 в вызове). */
const kroDeepCheckOnceTimeoutMsParsed = parseInt(process.env.KRO_DEEP_CHECK_ONCE_TIMEOUT_MS || '1800000', 10);
const kroDeepCheckOnceTimeoutMs =
  Number.isFinite(kroDeepCheckOnceTimeoutMsParsed) && kroDeepCheckOnceTimeoutMsParsed >= 120000 && kroDeepCheckOnceTimeoutMsParsed <= 1800000
    ? kroDeepCheckOnceTimeoutMsParsed
    : 1800000;

/** Лимит Telegram (FLOOD_WAIT) для текущей сессии — глубокий прогон бессмысленен до наступления этого времени. */
let kroTelegramFloodUntilMs = 0;
/** @type {{ channel_key: string | null, flood_wait_seconds: number | null, recorded_at: string | null }} */
let kroTelegramFloodMeta = { channel_key: null, flood_wait_seconds: null, recorded_at: null };

function kroRecordTelegramFloodWait(channelKey, floodWaitSeconds) {
  const sec = Number(floodWaitSeconds);
  if (!Number.isFinite(sec) || sec <= 0) return;
  const until = Date.now() + sec * 1000;
  if (until > kroTelegramFloodUntilMs) {
    kroTelegramFloodUntilMs = until;
    kroTelegramFloodMeta = {
      channel_key: channelKey || null,
      flood_wait_seconds: Math.round(sec),
      recorded_at: new Date().toISOString(),
    };
  }
}

function kroGetTelegramFloodState() {
  if (Date.now() >= kroTelegramFloodUntilMs) {
    return { active: false, deep_available_at: null, meta: null };
  }
  return {
    active: true,
    deep_available_at: new Date(kroTelegramFloodUntilMs).toISOString(),
    meta: kroTelegramFloodMeta,
  };
}

/** Мягкие лимиты deep до FLOOD_WAIT Telegram (in-memory, на процесс). */
const KRO_DEEP_CLIENT_WINDOW_MS = Math.max(300000, parseInt(process.env.KRO_DEEP_CLIENT_WINDOW_MS || `${2 * 60 * 60 * 1000}`, 10));
const KRO_DEEP_CLIENT_MAX = Math.max(1, parseInt(process.env.KRO_DEEP_CLIENT_MAX || '4', 10));
const KRO_DEEP_GLOBAL_WINDOW_MS = Math.max(120000, parseInt(process.env.KRO_DEEP_GLOBAL_WINDOW_MS || `${60 * 60 * 1000}`, 10));
const KRO_DEEP_GLOBAL_MAX = Math.max(3, parseInt(process.env.KRO_DEEP_GLOBAL_MAX || '28', 10));
const KRO_DEEP_GLOBAL_SOFT_RATIO = Math.min(0.99, Math.max(0.5, parseFloat(process.env.KRO_DEEP_GLOBAL_SOFT_RATIO || '0.85')));
const KRO_DEEP_CACHE_TTL_MS = Math.max(300000, parseInt(process.env.KRO_DEEP_CACHE_TTL_MS || `${2 * 60 * 60 * 1000}`, 10));
/** После «мягкого» TTL кэш всё ещё отдаём как stale (без нового API), пока не истёк жёсткий срок. */
const KRO_DEEP_CACHE_HARD_EXPIRE_MS = Math.max(
  KRO_DEEP_CACHE_TTL_MS,
  parseInt(process.env.KRO_DEEP_CACHE_HARD_EXPIRE_MS || `${7 * 24 * 60 * 60 * 1000}`, 10),
);
/** Пауза между задачами очереди deep — снижает пики к Telegram. */
const KRO_DEEP_QUEUE_INTER_JOB_MS = Math.max(0, parseInt(process.env.KRO_DEEP_QUEUE_INTER_JOB_MS || '1500', 10));
/** Сколько каналов одного пользователя может одновременно стоять в очереди deep (плюс один в работе у воркера). */
const KRO_DEEP_CLIENT_MAX_QUEUE = Math.max(1, parseInt(process.env.KRO_DEEP_CLIENT_MAX_QUEUE || '4', 10));
/**
 * Если оценка ожидания в серверной очереди (не длительность самого прогона!) больше этого порога —
 * не ставим заявку в очередь, отдаём fast и просим зайти позже / BYO. Это не «обрубить анализ через N минут».
 */
const KRO_DEEP_QUEUE_MAX_ETA_MINUTES = Math.max(15, parseInt(process.env.KRO_DEEP_QUEUE_MAX_ETA_MINUTES || '30', 10));
/** Если задан — POST /api/kro/ops/deep-breathe с Authorization: Bearer <secret> (без секрета маршрут 404). */
const KRO_DEEP_OPS_SECRET = (process.env.KRO_DEEP_OPS_SECRET || '').toString().trim();

const KRO_DEEP_CACHE_SERVABLE = new Set(['ok', 'incomplete', 'not_applicable']);

const kroDeepGlobalRuns = [];
const kroDeepClientRuns = new Map();
/** @type {Map<string, { ts: number, once: object, parsedOnce: object, deepStatus: string, deepAvailableAt: string | null }>} */
const kroDeepChannelCache = new Map();

function kroDeepPruneTimestamps(arr, windowMs) {
  const cut = Date.now() - windowMs;
  return arr.filter((t) => t > cut);
}

function kroDeepGetClientId(req) {
  const xf = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  const ip = xf || req.socket?.remoteAddress || req.ip || '';
  return ip || 'unknown';
}

/** Глубокий анализ через сессию пользователя (Telethon StringSession): без очереди сервера и без записи в общий deep-кэш. */
const KRO_BYO_DEEP_ENABLED = (process.env.KRO_BYO_DEEP_ENABLED ?? '1').toString().trim() !== '0';
const KRO_BYO_SESSION_TTL_MS = Math.max(
  5 * 60 * 1000,
  parseInt(process.env.KRO_BYO_SESSION_TTL_MS || `${30 * 60 * 1000}`, 10),
);
const KRO_BYO_REGISTER_PER_HOUR = Math.max(3, parseInt(process.env.KRO_BYO_REGISTER_PER_HOUR || '24', 10));
/** @type {Map<string, { sessionString: string, createdAt: number }>} */
const kroByoSessionStore = new Map();
/** @type {Map<string, { windowStart: number, count: number }>} */
const kroByoRegisterHits = new Map();

function kroByoPruneStore() {
  const now = Date.now();
  for (const [k, v] of kroByoSessionStore) {
    if (now - v.createdAt > KRO_BYO_SESSION_TTL_MS) kroByoSessionStore.delete(k);
  }
}

function kroByoGetSession(token) {
  kroByoPruneStore();
  const t = (token || '').toString().trim();
  if (!t.startsWith('kro_byo_')) return null;
  const row = kroByoSessionStore.get(t);
  if (!row) return null;
  if (Date.now() - row.createdAt > KRO_BYO_SESSION_TTL_MS) {
    kroByoSessionStore.delete(t);
    return null;
  }
  return row;
}

function kroByoAllowRegister(ip) {
  const now = Date.now();
  const hour = 3600000;
  const id = (ip || 'unknown').toString();
  let w = kroByoRegisterHits.get(id);
  if (!w || now - w.windowStart > hour) {
    kroByoRegisterHits.set(id, { windowStart: now, count: 1 });
    return true;
  }
  if (w.count >= KRO_BYO_REGISTER_PER_HOUR) return false;
  w.count += 1;
  return true;
}

function kroTelethonSpawnEnv(readOnly, sessionString, extraEnv) {
  const s = (sessionString || '').toString().trim();
  const extra = extraEnv && typeof extraEnv === 'object' ? extraEnv : {};
  const base = {
    ...process.env,
    ...(readOnly ? { KRO_CHECK_ONCE_NO_WRITE: '1' } : {}),
    ...extra,
  };
  if (!s) return base;
  return {
    ...base,
    KRO_TELEGRAM_SESSION_STRING: s,
    TELEGRAM_SESSION_STRING: s,
    TELEGRAM_SESSION_B64: '',
  };
}

function kroDeepPeekGlobalRuns() {
  const pruned = kroDeepPruneTimestamps(kroDeepGlobalRuns, KRO_DEEP_GLOBAL_WINDOW_MS);
  kroDeepGlobalRuns.length = 0;
  kroDeepGlobalRuns.push(...pruned);
  return kroDeepGlobalRuns;
}

function kroDeepPeekClientRuns(clientId) {
  const id = (clientId || '').toString() || 'unknown';
  const pruned = kroDeepPruneTimestamps(kroDeepClientRuns.get(id) || [], KRO_DEEP_CLIENT_WINDOW_MS);
  kroDeepClientRuns.set(id, pruned);
  return pruned;
}

function kroDeepGlobalLoadSnapshot() {
  const runs = kroDeepPeekGlobalRuns();
  const n = runs.length;
  const softN = Math.max(1, Math.floor(KRO_DEEP_GLOBAL_MAX * KRO_DEEP_GLOBAL_SOFT_RATIO));
  const pct = KRO_DEEP_GLOBAL_MAX > 0 ? Math.min(100, Math.round((100 * n) / KRO_DEEP_GLOBAL_MAX)) : 0;
  return {
    deep_runs_in_window: n,
    deep_window_max: KRO_DEEP_GLOBAL_MAX,
    deep_window_minutes: Math.round(KRO_DEEP_GLOBAL_WINDOW_MS / 60000),
    deep_global_load_percent: pct,
    deep_global_load_high: n >= softN,
  };
}

function kroDeepAllowNewTelegramDeep(clientId) {
  kroDeepPeekGlobalRuns();
  const g = kroDeepGlobalRuns.length;
  const softCap = Math.max(1, Math.floor(KRO_DEEP_GLOBAL_MAX * KRO_DEEP_GLOBAL_SOFT_RATIO));
  if (g >= softCap) {
    const oldest = g ? Math.min(...kroDeepGlobalRuns) : Date.now();
    const retryMs = Math.max(60000, KRO_DEEP_GLOBAL_WINDOW_MS - (Date.now() - oldest));
    const mins = Math.max(1, Math.ceil(retryMs / 60000));
    return {
      allowed: false,
      scope: 'global',
      message_ru:
        'Сейчас очень много глубоких проверок на сервисе. Чтобы Telegram не ввёл длительную блокировку (FLOOD_WAIT), новые глубокие запросы временно ограничены. Быстрый отчёт доступен; глубокий анализ попробуйте позже (ориентировочно через '
        + mins
        + ' мин).',
      wait_minutes_approx: mins,
      wait_seconds_approx: Math.ceil(retryMs / 1000),
    };
  }
  const cr = kroDeepPeekClientRuns(clientId);
  if (cr.length >= KRO_DEEP_CLIENT_MAX) {
    const oldestC = Math.min(...cr);
    const retryMs = Math.max(60000, KRO_DEEP_CLIENT_WINDOW_MS - (Date.now() - oldestC));
    const mins = Math.max(1, Math.ceil(retryMs / 60000));
    return {
      allowed: false,
      scope: 'client',
      message_ru:
        'Вы уже запустили несколько глубоких проверок за последнее время. Чтобы не упереться в лимиты Telegram, подождите ещё примерно '
        + mins
        + ' мин. Быстрый отчёт выше можно смотреть без ограничений.',
      wait_minutes_approx: mins,
      wait_seconds_approx: Math.ceil(retryMs / 1000),
    };
  }
  return { allowed: true };
}

function kroDeepRecordSuccessfulTelegramDeep(clientId) {
  const now = Date.now();
  kroDeepGlobalRuns.push(now);
  const id = (clientId || '').toString() || 'unknown';
  const arr = kroDeepClientRuns.get(id) || [];
  arr.push(now);
  kroDeepClientRuns.set(id, kroDeepPruneTimestamps(arr, KRO_DEEP_CLIENT_WINDOW_MS));
}

function kroDeepCacheResolve(channelKey) {
  const k = (channelKey || '').toString().trim();
  if (!k) return null;
  const e = kroDeepChannelCache.get(k);
  if (!e) return null;
  const age = Date.now() - e.ts;
  if (age > KRO_DEEP_CACHE_HARD_EXPIRE_MS) {
    kroDeepChannelCache.delete(k);
    return null;
  }
  return { k, entry: e, fresh: age <= KRO_DEEP_CACHE_TTL_MS, age_ms: age };
}

/** Только «свежий» слой кэша (как раньше): для мест, где stale не подходит. */
function kroDeepCacheGet(channelKey) {
  const r = kroDeepCacheResolve(channelKey);
  if (!r || !r.fresh) return null;
  return r.entry;
}

function kroDeepCacheServableResolved(channelKey) {
  const r = kroDeepCacheResolve(channelKey);
  if (!r) return null;
  if (!KRO_DEEP_CACHE_SERVABLE.has(String(r.entry.deepStatus || ''))) return null;
  return r;
}

function kroDeepCacheSet(channelKey, payload) {
  const k = (channelKey || '').toString().trim();
  if (!k) return;
  kroDeepChannelCache.set(k, { ts: Date.now(), ...payload });
}

/** Подсказка для UI: в кэше уже есть пригодный deep (свежий или stale). */
function kroDeepCacheHintForKey(channelKey) {
  const r = kroDeepCacheServableResolved(channelKey);
  if (!r) return null;
  return {
    has_fresh_deep: r.fresh,
    has_stale_deep: !r.fresh,
    age_ms: r.age_ms,
    cached_deep_status: r.entry.deepStatus || null,
  };
}

/** Очередь глубоких проверок при глобальной перегрузке (один воркер, без блокировки event loop). */
const kroDeepWaitQueue = [];
let kroDeepQueueWorkerBusy = false;
/** @type {{ channelKey: string, channelForOnce: string, clientId: string, enqueuedAt: number } | null} */
let kroDeepQueueActiveJob = null;

function kroDeepComputeQueueEtaMinutes(position) {
  const pos = Math.max(1, Number(position) || 1);
  /** ~2 мин на позицию + доля таймаута check_once; занижать нельзя — люди планируют время. */
  return Math.max(2, pos * 2 + Math.ceil(kroCheckOnceTimeoutMs / 60000 / 4));
}

function kroDeepClientQueueDepth(clientId) {
  const cid = (clientId || '').toString() || 'unknown';
  let n = kroDeepWaitQueue.filter((j) => j.clientId === cid).length;
  if (kroDeepQueueWorkerBusy && kroDeepQueueActiveJob && kroDeepQueueActiveJob.clientId === cid) {
    n += 1;
  }
  return n;
}

/** Для mode=fast на главной: канал уже в серверной очереди deep или для него идёт check_once. */
function kroDeepPendingGateForChannelKey(channelKey) {
  const k = (channelKey || '').toString().trim();
  if (!k) return null;
  if (kroDeepQueueActiveJob && kroDeepQueueActiveJob.channelKey === k) {
    const runMin = Math.max(2, Math.ceil(kroCheckOnceTimeoutMs / 60000));
    return {
      deep_queued: true,
      deep_queue_running: true,
      deep_queue_position: 1,
      deep_queue_eta_minutes: runMin,
      suggested_refresh_seconds: 45,
      message_ru: `Глубокий анализ @${k} сейчас выполняется на сервере (чтение ленты Telegram). Обычно до ~${runMin} мин — откройте страницу канала и при необходимости обновите её.`,
    };
  }
  const idx = kroDeepWaitQueue.findIndex((j) => j.channelKey === k);
  if (idx < 0) return null;
  const position = idx + 1;
  const eta = kroDeepComputeQueueEtaMinutes(position);
  const retryAfterMs = Math.min(600000, Math.max(45000, Math.round(eta * 30000)));
  const suggestedSec = Math.min(600, Math.max(30, Math.round(retryAfterMs / 1000)));
  return {
    deep_queued: true,
    deep_queue_position: position,
    deep_queue_eta_minutes: eta,
    suggested_refresh_seconds: suggestedSec,
    message_ru: `Глубокий анализ @${k} в серверной очереди: позиция ~${position}, ориентировочно ~${eta} мин до начала чтения ленты.`,
  };
}

function kroDeepEnqueue(channelKey, channelForOnce, clientId) {
  const k = (channelKey || '').toString().trim();
  const cf = (channelForOnce || '').toString().trim();
  const cid = (clientId || '').toString() || 'unknown';
  const existing = kroDeepWaitQueue.findIndex((j) => j.channelKey === k);
  if (existing >= 0) {
    const position = existing + 1;
    const eta = kroDeepComputeQueueEtaMinutes(position);
    const retryAfterMs = Math.min(600000, Math.max(45000, Math.round(eta * 30000)));
    const suggestedSec = Math.min(600, Math.max(30, Math.round(retryAfterMs / 1000)));
    return {
      position,
      eta_minutes: eta,
      deduped: true,
      retry_after_ms: retryAfterMs,
      suggested_refresh_seconds: suggestedSec,
    };
  }
  const depth = kroDeepClientQueueDepth(clientId);
  if (depth >= KRO_DEEP_CLIENT_MAX_QUEUE) {
    return {
      rejected: true,
      reject_reason: 'client_queue_full',
      client_queue_max: KRO_DEEP_CLIENT_MAX_QUEUE,
      message_ru:
        `У вас уже ${depth} канал(а) в серверной очереди глубокого анализа или в обработке — одновременно не больше ${KRO_DEEP_CLIENT_MAX_QUEUE}. Дождитесь завершения одного из прогонов либо откройте страницу канала и запустите глубокий через свой Telegram (BYO) — без общей очереди сервера. Быстрый отчёт выше доступен сразу.`,
    };
  }
  const wouldPosition = kroDeepWaitQueue.length + 1;
  const wouldEta = kroDeepComputeQueueEtaMinutes(wouldPosition);
  if (wouldEta > KRO_DEEP_QUEUE_MAX_ETA_MINUTES) {
    return {
      rejected: true,
      reject_reason: 'eta_too_long',
      eta_minutes: wouldEta,
      queue_max_eta_minutes: KRO_DEEP_QUEUE_MAX_ETA_MINUTES,
      message_ru:
        `Очередь глубокого анализа на сервере сейчас очень длинная: до вашего канала ориентировочно ~${wouldEta} мин. Мы не предлагаем встраиваться в онлайн‑ожидание дольше ~${KRO_DEEP_QUEUE_MAX_ETA_MINUTES} мин — ниже быстрый отчёт. Попробуйте позже или на странице канала подключите глубокий через свой Telegram (BYO), минуя эту очередь.`,
    };
  }
  kroDeepWaitQueue.push({ channelKey: k, channelForOnce: cf || k, clientId: cid, enqueuedAt: Date.now() });
  const position = kroDeepWaitQueue.length;
  const eta = kroDeepComputeQueueEtaMinutes(position);
  const retryAfterMs = Math.min(600000, Math.max(45000, Math.round(eta * 30000)));
  const suggestedSec = Math.min(600, Math.max(30, Math.round(retryAfterMs / 1000)));
  kroDeepProcessQueueSoon();
  return {
    position,
    eta_minutes: eta,
    deduped: false,
    retry_after_ms: retryAfterMs,
    suggested_refresh_seconds: suggestedSec,
  };
}

function kroDeepProcessQueueSoon() {
  void kroDeepDrainQueue();
}

async function kroDeepDrainQueue() {
  if (kroDeepQueueWorkerBusy) return;
  if (!kroDeepWaitQueue.length) return;
  if (kroGetTelegramFloodState().active) {
    setTimeout(() => kroDeepProcessQueueSoon(), 45000);
    return;
  }
  kroDeepPeekGlobalRuns();
  const softCap = Math.max(1, Math.floor(KRO_DEEP_GLOBAL_MAX * KRO_DEEP_GLOBAL_SOFT_RATIO));
  if (kroDeepGlobalRuns.length >= softCap) {
    setTimeout(() => kroDeepProcessQueueSoon(), 60000);
    return;
  }
  kroDeepQueueWorkerBusy = true;
  const job = kroDeepWaitQueue.shift();
  kroDeepQueueActiveJob = job || null;
  if (!job) {
    kroDeepQueueWorkerBusy = false;
    kroDeepQueueActiveJob = null;
    return;
  }
  try {
    const once = await kroRunCheckOnceAsync(job.channelForOnce, { readOnly: true });
    if (once.stderr) console.error('KRO queue check_once stderr:', once.stderr);
    const parsedOnce = kroNormalizeCheckOnceForAnalysis(once);
    if (parsedOnce.telegram_rate_limited) {
      kroRecordTelegramFloodWait(job.channelKey, parsedOnce.flood_wait_seconds);
      kroDeepWaitQueue.unshift(job);
      return;
    }
    kroDeepRecordSuccessfulTelegramDeep(job.clientId);
    let deepStatus = 'failed';
    const deepAvailableAt = null;
    if (once.ok !== true) {
      deepStatus = 'failed';
    } else if (parsedOnce.not_crypto) {
      deepStatus = 'not_applicable';
    } else if (parsedOnce.found === true) {
      deepStatus = 'ok';
    } else {
      deepStatus = 'incomplete';
    }
    if (['ok', 'incomplete', 'not_applicable'].includes(deepStatus)) {
      kroDeepCacheSet(job.channelKey, { once, parsedOnce, deepStatus, deepAvailableAt });
    }
  } catch (e) {
    console.error('KRO deep queue job error:', e?.message || e);
  } finally {
    kroDeepQueueActiveJob = null;
    kroDeepQueueWorkerBusy = false;
    if (kroDeepWaitQueue.length) {
      if (KRO_DEEP_QUEUE_INTER_JOB_MS > 0) {
        setTimeout(() => kroDeepProcessQueueSoon(), KRO_DEEP_QUEUE_INTER_JOB_MS);
      } else {
        setImmediate(() => kroDeepProcessQueueSoon());
      }
    }
  }
}

function kroSyntheticQueuedParsed(channelKey, position, etaMinutes, suggestedRefreshSeconds) {
  const pos = Math.max(1, Number(position) || 1);
  const eta = Math.max(2, Number(etaMinutes) || 5);
  const sec = Number(suggestedRefreshSeconds);
  const pollSec = Number.isFinite(sec) && sec > 0 ? Math.min(600, Math.max(30, Math.round(sec))) : Math.min(300, Math.max(45, Math.ceil(eta * 25)));
  return {
    found: false,
    deep_queued: true,
    deep_queue_position: pos,
    deep_queue_eta_minutes: eta,
    deep_queue_suggested_poll_seconds: pollSec,
    username: channelKey ? `@${channelKey}` : null,
    error: `Глубокий анализ в очереди: позиция ${pos}, ориентировочно ${eta} мин. Обновите страницу примерно через ${pollSec} сек. или подождите — страница может обновиться сама.`,
    _check_once_ok: true,
  };
}

function kroSyntheticQueueRejectParsed(channelKey, q) {
  const msg = (q && q.message_ru) || 'Глубокий анализ сейчас недоступен в очереди.';
  return {
    found: false,
    deep_queue_rejected: true,
    deep_reject_reason: q && q.reject_reason ? String(q.reject_reason) : 'unknown',
    username: channelKey ? `@${channelKey}` : null,
    error: msg,
    _check_once_ok: true,
  };
}

function kroSyntheticServerDeepThrottleParsed(channelKey, messageRu) {
  return {
    found: false,
    telegram_rate_limited: false,
    server_deep_throttled: true,
    username: channelKey ? `@${channelKey}` : null,
    error: (messageRu || '').toString().trim() || 'Глубокий анализ временно ограничен на сервере.',
    _check_once_ok: true,
  };
}

function kroFormatIsoForMsk(iso) {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const s = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
    return `${s} МСК`;
  } catch {
    return '';
  }
}

/** Синтетический parsed для live_metrics, когда deep запрошен, но FLOOD_WAIT ещё активен (Python не дергаем). */
function kroSyntheticFloodParsedForDeepSkip(channelKey) {
  const st = kroGetTelegramFloodState();
  const sec = Math.max(0, Math.ceil((kroTelegramFloodUntilMs - Date.now()) / 1000));
  const iso = st.deep_available_at;
  const msk = iso ? kroFormatIsoForMsk(iso) : '';
  return {
    found: false,
    telegram_rate_limited: true,
    flood_wait_seconds: sec,
    username: channelKey ? `@${channelKey}` : null,
    error: msk
      ? `Для живого глубокого анализа сейчас действует лимит Telegram. Повторите полный прогон примерно после ${msk}.`
      : 'Для живого глубокого анализа сейчас действует лимит Telegram — подождите и повторите запрос.',
    _check_once_ok: true,
  };
}

/** Для фронта: можно ли сейчас запускать глубокий прогон (наши лимиты + FLOOD_WAIT Telegram). */
function kroBuildChannelProfileDeepGate(extra) {
  const load = kroDeepGlobalLoadSnapshot();
  const ex = extra && typeof extra === 'object' ? extra : null;
  const st = kroGetTelegramFloodState();
  // Очередь / прогон именно для этого канала важнее глобального FLOOD: иначе fast channel-profile
  // терял deep_queued в JSON, хотя канал реально в kroDeepWaitQueue или в kroDeepQueueActiveJob.
  if (ex && ex.deep_queued === true) {
    const pos = ex.deep_queue_position != null ? Number(ex.deep_queue_position) : null;
    const eta = ex.deep_queue_eta_minutes != null ? Number(ex.deep_queue_eta_minutes) : null;
    const sref = ex.suggested_refresh_seconds != null ? Number(ex.suggested_refresh_seconds) : null;
    return {
      can_run_deep: false,
      telegram_flood_active: false,
      server_throttle_active: false,
      deep_queued: true,
      deep_queue_position: Number.isFinite(pos) ? pos : null,
      deep_queue_eta_minutes: Number.isFinite(eta) ? eta : null,
      suggested_refresh_seconds: Number.isFinite(sref) ? sref : null,
      server_throttle_scope: null,
      retry_after_iso: null,
      retry_after_msk: null,
      wait_seconds_approx: Number.isFinite(eta) ? Math.max(60, eta * 60) : null,
      wait_minutes_approx: Number.isFinite(eta) ? eta : null,
      deep_queue_running: ex.deep_queue_running === true,
      message_ru:
        (ex.message_ru || '').toString().trim() ||
        'Глубокий анализ поставлен в очередь из‑за высокой нагрузки; быстрый отчёт доступен сразу.',
      load,
    };
  }
  if (st.active) {
    const sec = Math.max(0, Math.ceil((kroTelegramFloodUntilMs - Date.now()) / 1000));
    const iso = st.deep_available_at;
    const msk = iso ? kroFormatIsoForMsk(iso) : '';
    const mins = Math.max(1, Math.ceil(sec / 60));
    return {
      can_run_deep: false,
      telegram_flood_active: true,
      server_throttle_active: false,
      deep_queued: false,
      deep_queue_position: null,
      deep_queue_eta_minutes: null,
      suggested_refresh_seconds: null,
      server_throttle_scope: null,
      retry_after_iso: iso,
      retry_after_msk: msk || null,
      wait_seconds_approx: sec,
      wait_minutes_approx: mins,
      message_ru: msk
        ? `Telegram ограничил количество запросов к каналам. Глубокое чтение ленты сейчас недоступно; ориентировочно снова можно попробовать после ${msk} (через ≈${mins} мин).`
        : `Telegram ограничил количество запросов к каналам. Подождите около ${mins} мин. и откройте страницу канала снова.`,
      load,
    };
  }
  if (ex && ex.server_deep_blocked === true) {
    return {
      can_run_deep: false,
      telegram_flood_active: false,
      server_throttle_active: true,
      deep_queued: false,
      deep_queue_position: null,
      deep_queue_eta_minutes: null,
      suggested_refresh_seconds: null,
      server_throttle_scope: ex.server_throttle_scope || null,
      retry_after_iso: null,
      retry_after_msk: null,
      wait_seconds_approx: ex.wait_seconds_approx != null ? Number(ex.wait_seconds_approx) : null,
      wait_minutes_approx: ex.wait_minutes_approx != null ? Number(ex.wait_minutes_approx) : null,
      message_ru: ex.message_ru || 'Глубокий анализ временно ограничен.',
      load,
    };
  }
  return {
    can_run_deep: true,
    telegram_flood_active: false,
    server_throttle_active: false,
    deep_queued: false,
    deep_queue_position: null,
    deep_queue_eta_minutes: null,
    suggested_refresh_seconds: null,
    server_throttle_scope: null,
    retry_after_iso: null,
    retry_after_msk: null,
    wait_seconds_approx: null,
    wait_minutes_approx: null,
    message_ru: null,
    load,
  };
}

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

/**
 * Если цикл давно не обновлял kro_meta — честное предупреждение на главной (siteNotice),
 * чтобы не спорить с ощущением «всё застыло» из‑за путаницы метрик или упавшего workflow.
 */
function kroBuildStaleCycleSiteNotice(metaLastCycleRaw, displayUpdatedAtStr, scamBaseUpdatedAtStr, warnHours) {
  const wh = Number(warnHours);
  if (!Number.isFinite(wh) || wh <= 0) return null;
  const fromMeta = coerceKroMetaLastCycleAtToIso(metaLastCycleRaw);
  let iso = fromMeta;
  if (!iso && displayUpdatedAtStr) {
    const p = Date.parse(String(displayUpdatedAtStr));
    if (Number.isFinite(p)) iso = new Date(p).toISOString();
  }
  if (!iso && scamBaseUpdatedAtStr) {
    const p = Date.parse(String(scamBaseUpdatedAtStr));
    if (Number.isFinite(p)) iso = new Date(p).toISOString();
  }
  if (!iso) {
    const rawMeta = metaLastCycleRaw != null ? String(metaLastCycleRaw).trim() : '';
    if (rawMeta) {
      return (
        'Дата last_cycle_at в kro_meta не распознана (ожидается ISO или ДД.ММ.ГГГГ ЧЧ:ММ MSK). ' +
        'Проверьте ячейку и workflow «KRO 12h Monitor».'
      );
    }
    return null;
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const ageH = (Date.now() - ms) / 3600000;
  if (ageH <= wh) return null;
  return (
    `Мониторинг не отчитывался ${ageH.toFixed(1)} ч (норма: каждые ~12 ч, порог предупреждения ${wh} ч). ` +
    'Проверьте workflow «KRO 12h Monitor», при необходимости «KRO Monitor Watchdog» и лист kro_meta в Google Sheets.'
  );
}

/**
 * Минимум каналов за 12ч цикл: строго больше пяти ⇒ min=6.
 * either — ок, если new_in_cycle >= min ИЛИ channels_scanned_in_cycle >= min (реалистично при строгой базе).
 * new_in_base | scanned | both — см. KRO_CYCLE_VOLUME_METRIC.
 */
function kroEvalCycleVolume(newInCycle, channelsScanned, minRequired, metricRaw) {
  const min = Math.max(0, Math.floor(Number(minRequired) || 0));
  const nic = Math.max(0, Math.floor(Number(newInCycle) || 0));
  const scan = Math.max(0, Math.floor(Number(channelsScanned) || 0));
  const m = String(metricRaw || 'either').trim().toLowerCase();
  if (min <= 0) {
    return {
      ok: true,
      actual: Math.max(nic, scan),
      new_in_base: nic,
      scanned: scan,
      min: 0,
      metric: m,
    };
  }
  let ok = true;
  let actual = Math.max(nic, scan);
  if (m === 'new_in_base') {
    actual = nic;
    ok = nic >= min;
  } else if (m === 'scanned') {
    actual = scan;
    ok = scan >= min;
  } else if (m === 'both') {
    ok = nic >= min && scan >= min;
    actual = nic;
  } else {
    ok = nic >= min || scan >= min;
    actual = Math.max(nic, scan);
  }
  return { ok, actual, new_in_base: nic, scanned: scan, min, metric: m };
}

function kroReadMinChannelsPerCycleFromEnv() {
  const raw = process.env.KRO_MIN_CHANNELS_FOUND_PER_CYCLE;
  if (raw === undefined || raw === '') return 6;
  const n = parseInt(String(raw).replace(/\s/g, ''), 10);
  if (!Number.isFinite(n) || n < 0) return 6;
  return n;
}

function kroBuildCycleVolumeNotice(vol) {
  if (!vol || vol.min <= 0 || vol.ok) return null;
  const nic = vol.new_in_base;
  const scan = vol.scanned;
  let modeRu =
    'нужно минимум ' +
    vol.min +
    ' по правилу проекта: хотя бы одна метрика — новые в базу (new_in_cycle) или просмотрено за цикл (channels_scanned_in_cycle)';
  if (vol.metric === 'new_in_base') {
    modeRu = `нужно минимум ${vol.min} новых в подтверждённую базу за цикл (new_in_cycle)`;
  } else if (vol.metric === 'scanned') {
    modeRu = `нужно минимум ${vol.min} каналов, просмотренных за цикл (channels_scanned_in_cycle)`;
  } else if (vol.metric === 'both') {
    modeRu = `нужно минимум ${vol.min} и по new_in_cycle, и по channels_scanned_in_cycle`;
  }
  return (
    `За последний 12‑часовой цикл недостаточно находок: ${modeRu}. Сейчас: новых в базу — ${nic}, просмотрено — ${scan}. Проверьте «KRO 12h Monitor» и воркер.`
  );
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
  const strMeta = (k) => {
    const v = values[k];
    if (v == null) return '';
    return String(v).trim();
  };
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
    monitor_run_status: strMeta('monitor_run_status'),
    monitor_run_started_at: strMeta('monitor_run_started_at'),
    monitor_current_phase: strMeta('monitor_current_phase'),
    monitor_current_channel: strMeta('monitor_current_channel'),
    monitor_current_detail: strMeta('monitor_current_detail'),
    monitor_filters_summary: strMeta('monitor_filters_summary'),
    monitor_result_targets: strMeta('monitor_result_targets'),
    monitor_progress_updated_at: strMeta('monitor_progress_updated_at'),
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
  monitor_run_status: '',
  monitor_run_started_at: '',
  monitor_current_phase: '',
  monitor_current_channel: '',
  monitor_current_detail: '',
  monitor_filters_summary: '',
  monitor_result_targets: '',
  monitor_progress_updated_at: '',
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
    const raw = await kroFetchChannelsWatchRawCached(client);
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
/** Раньше добавляли пояснение про отсутствие строки в scam_base — убрано из UI как служебный шум. */
function kroV0PrependNoScamBaseCardNote(_analysis, _opts) {
  /* no-op */
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
  const watchCompl = wc > 0 ? `По данным мониторинга: ${wc} жалоб(ы).` : '';
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

/** Сколько пунктов в conclusion.reasons отдаём в отчёт (схема та же — массив строк). */
const KRO_V0_MAX_CONCLUSION_REASONS = 6;

function kroLiveParsedWindowPosts(p) {
  const winD = Number(p && p.analysis_window_days);
  const postsN = Number(p && p.posts_fetched);
  return {
    winD: Number.isFinite(winD) && winD > 0 ? winD : null,
    postsN: Number.isFinite(postsN) && postsN >= 0 ? postsN : null,
  };
}

/** Когда вывод по «живой» ленте статистически тонкий — просим не путать с полной гарантией. */
function kroLiveSampleLimitedDetail(p) {
  const { winD, postsN } = kroLiveParsedWindowPosts(p);
  if (postsN == null || !Number.isFinite(Number(p.posts_fetched))) {
    return { limited: true, detail: 'объём текстовой выборки в ответе не определён — трактуем вывод осторожно' };
  }
  if (postsN < 18) {
    return { limited: true, detail: `мало постов с текстом (~${postsN})` };
  }
  if (winD != null && winD >= 90 && postsN < 42) {
    return {
      limited: true,
      detail: `за длинный период (~${winD} дн.) относительно мало текстовых постов (~${postsN}) — канал редко пишет или много сообщений без текста в подписи`,
    };
  }
  return { limited: false, detail: '' };
}

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
  if (ot && ot !== '—' && !/^\d+$/.test(ot)) bullets.push(`Тип в сводке: ${ot}.`);
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
        'Это не «всё отлично» — просто другой предмет проверки: правила крипто‑скама здесь почти не применимы, смотрите сами тематику.',
      ].slice(0, KRO_V0_MAX_CONCLUSION_REASONS),
    };
  }
  if (parsed.telegram_rate_limited === true) {
    const msg =
      parsed.error != null && String(parsed.error).trim()
        ? String(parsed.error).trim()
        : 'Telegram временно ограничил частоту запросов для этого аккаунта (FLOOD_WAIT). Повторите проверку позже — это не бан.';
    return {
      status: KRO_V0_STATUS.watch,
      reasons: [msg].slice(0, KRO_V0_MAX_CONCLUSION_REASONS),
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
    return { status: KRO_V0_STATUS.scam, reasons: reasons.slice(0, KRO_V0_MAX_CONCLUSION_REASONS) };
  }
  const rl = (parsed.risk_level || '').toString().trim();
  const { winD, postsN } = kroLiveParsedWindowPosts(parsed);
  const lim = kroLiveSampleLimitedDetail(parsed);
  if (rl === 'в риске') {
    const reasons = [];
    if (winD != null && postsN != null) {
      reasons.push(`Опирались на ~${postsN} постов с текстом за окно до ${winD} дн. (медиа без подписи не входят).`);
    }
    if (lim.limited) {
      reasons.push(
        `Ограничение выборки: ${lim.detail}. Вывод сильнее опирается на жалобы и явные маркеры, чем на «тон» при малой ленте.`,
      );
    }
    if (parsed.complaints != null) {
      reasons.push(`В отчётах людей уже ${parsed.complaints} жалоб(а), плюс в ленте есть сигналы/VIP.`);
    }
    if (Array.isArray(parsed.risk_evidence) && parsed.risk_evidence.length) {
      reasons.push('В текстах есть давление, сигналы или обещания «лёгких» денег — сочетается с жалобами.');
    }
    if (parsed.only_profits_flag) reasons.push('Почти только «профиты», про минусы почти не говорят.');
    if (parsed.has_signal_offer) reasons.push('Есть явные призывы к сделкам «купи/продай» или похожий оффер.');
    return { status: KRO_V0_STATUS.risk, reasons: reasons.slice(0, KRO_V0_MAX_CONCLUSION_REASONS) };
  }
  if (rl === 'поведенческий риск') {
    const reasons = [];
    if (winD != null && postsN != null) {
      reasons.push(`Считали метрики по ~${postsN} текстовым постам, окно до ${winD} дн.`);
    }
    if (parsed.fomo_pct != null) reasons.push(`Сильное «успей/последний шанс»: примерно в ${parsed.fomo_pct}% постов выборки.`);
    if (Array.isArray(parsed.shame_phrases_detected) && parsed.shame_phrases_detected.length) {
      reasons.push('Есть «стыдящие» обращения к аудитории.');
    }
    if (parsed.ads_ratio != null) reasons.push(`Много постов похоже на рекламу и продажу: ~${parsed.ads_ratio}% выборки.`);
    if (Array.isArray(parsed.risk_evidence) && parsed.risk_evidence.length) {
      reasons.push('Плюс типичные маркеры давления в текстах.');
    }
    return { status: KRO_V0_STATUS.risk, reasons: reasons.slice(0, KRO_V0_MAX_CONCLUSION_REASONS) };
  }
  if (rl === 'под наблюдением') {
    const reasons = [];
    if (winD != null && postsN != null) {
      reasons.push(`Лента: ~${postsN} постов с текстом, окно до ${winD} дн.; часть метрик — по последним 7 дням.`);
    }
    if (lim.limited) {
      reasons.push(
        `Честно про данные: ${lim.detail}. Статус «под наблюдением» здесь — про отдельные сигналы, а не про «всё идеально проверено годами».`,
      );
    }
    if (parsed.complaints === 1) reasons.push('Жалоба пока одна — это зона внимания, а не «жёсткий» уровень.');
    if (parsed.has_signal_offer) reasons.push('В постах есть признаки сигнального предложения.');
    if (parsed.vip_price && String(parsed.vip_price).trim() && String(parsed.vip_price).trim() !== '—') {
      reasons.push(`Заметен платный формат/VIP: ${String(parsed.vip_price).trim()}.`);
    }
    if (parsed.risk_verdict) {
      const hv = kroV0HumanVerdictLabel(parsed.risk_verdict);
      if (hv) reasons.push(`Автоматическая оценка по постам: ${hv}.`);
    }
    const fomoW = Number(parsed.fomo_pct);
    if (Number.isFinite(fomoW) && fomoW > 0 && fomoW < 25) {
      reasons.push(`Слабый фон: «срочность» встречается примерно в ${fomoW}% постов — до отдельного уровня риска не дотягивает само по себе.`);
    }
    if (!reasons.length) reasons.push('Есть отдельные тревожные признаки, но без набора для более жёсткого вывода.');
    return { status: KRO_V0_STATUS.watch, reasons: reasons.slice(0, KRO_V0_MAX_CONCLUSION_REASONS) };
  }
  if (rl === 'нет риска') {
    const reasons = [];
    if (winD != null && postsN != null) {
      reasons.push(
        `По тексту ленты прошли автоматические правила на ~${postsN} сообщениях с текстом за окно до ${winD} дн. (голос/видео без подписи не читаем).`,
      );
    } else if (postsN != null) {
      reasons.push(`В выборке около ${postsN} постов с текстом; границы окна по дням в ответе не переданы — смотрим на метрики и жалобы как есть.`);
    }
    if (lim.limited) {
      reasons.push(
        `Ограничение видимости: ${lim.detail}. Серьёзных красных флагов по правилам не найдено, но это не равно «гарантированно безопасно» — вывод узкий и честный.`,
      );
    }
    const cRaw = parsed.complaints;
    const cNum = cRaw != null && cRaw !== '' ? Number(cRaw) : NaN;
    if (!Number.isFinite(cNum)) {
      reasons.push(
        'Жалобы в отчётах: не удалось получить цифру по каналу в этом ответе — про «ноль жалоб» не заявляем, смотрите блок про жалобы ниже.',
      );
    } else if (cNum === 0) {
      reasons.push(
        'В учтённых обращениях людей по этому каналу сейчас 0 жалоб на потери/скам — это только то, что пришло в сервис, не «весь интернет».',
      );
    } else {
      reasons.push(
        `В отчётах указано жалоб: ${cNum} — формула всё равно даёт «нет риска», потому что нет связки с жёстким поведенческим набором; детали в разделе про жалобы.`,
      );
    }
    const calmBits = [];
    if (!parsed.has_signal_offer) {
      calmBits.push('нет выделенных «сигнальных» призывов в духе «купи/продай по нашей подписке» в фокусе проверок');
    }
    if (!parsed.only_profits_flag) {
      calmBits.push('нет картины «почти только скрины профита, про минусы почти не говорят»');
    }
    if (calmBits.length) {
      reasons.push(`Спокойные сигналы по тексту: ${calmBits.join('; ')}.`);
    }
    const weakBits = [];
    const fomoN = Number(parsed.fomo_pct);
    if (Number.isFinite(fomoN) && fomoN > 0 && fomoN < 22) {
      weakBits.push(`редкие «срочные» формулировки (~${fomoN}% постов)`);
    }
    const adsN = Number(parsed.ads_ratio);
    if (Number.isFinite(adsN) && adsN >= 12 && adsN < 55) {
      weakBits.push(`часть постов похожа на рекламу/продажу (~${adsN}% в окне)`);
    }
    if (weakBits.length) {
      reasons.push(`Слабые отметины (сами по себе не переводят в риск): ${weakBits.join(', ')}.`);
    }
    if (parsed.risk_score != null) reasons.push(`Сводный балл по постам: ${parsed.risk_score} из 100.`);
    if (parsed.risk_verdict) {
      const hv = kroV0HumanVerdictLabel(parsed.risk_verdict);
      if (hv) reasons.push(`Автоматическая оценка по постам: ${hv}.`);
    }
    reasons.push(
      'Итог по правилам: нет картины «давление + жалобы» или сильного поведенческого склона — поэтому статус ближе к спокойному, без «всё идеально в жизни».',
    );
    return { status: KRO_V0_STATUS.clean, reasons: reasons.filter(Boolean).slice(0, KRO_V0_MAX_CONCLUSION_REASONS) };
  }
  const reasons = [];
  if (winD != null && postsN != null) {
    reasons.push(`Выборка: ~${postsN} текстовых постов, окно до ${winD} дн.`);
  }
  if (lim.limited) {
    reasons.push(`Данных по ленте мало или выборка узкая (${lim.detail}) — статус осторожный, пока картина не разъединилась по правилам.`);
  }
  if (parsed.risk_score != null) reasons.push(`Сводный балл по постам: ${parsed.risk_score} из 100.`);
  if (parsed.risk_verdict) {
    const hv = kroV0HumanVerdictLabel(parsed.risk_verdict);
    if (hv) reasons.push(`Автоматическая оценка по постам: ${hv}.`);
  }
  if (Array.isArray(parsed.risk_evidence) && parsed.risk_evidence.length) {
    reasons.push(`Автоматика отметила маркеры: ${parsed.risk_evidence.slice(0, 3).join('; ')}.`);
  }
  if (!reasons.length) {
    reasons.push('Правила не свели канал к одному из жёстких уровней — оставляем в зоне внимания до большей ясности.');
  }
  return { status: KRO_V0_STATUS.watch, reasons: reasons.slice(0, KRO_V0_MAX_CONCLUSION_REASONS) };
}

function kroV0BuildAnalysisFromScamBaseProfile(profile, extra) {
  const r = profile;
  const username = (r?.username || '').toString().trim() || (extra && extra.channel_key) || '';
  const lossRub = Number(r?.total_loss_rub) || 0;
  const conclusion = {
    status: kroV0MapScamBaseStatusToConclusion(r?.status, r?.verdict, lossRub),
    reasons: [],
  };
  const cardSpeedNote =
    'Сводка из мониторинга каналов: в этом запросе ленту в Telegram заново не читали — ответ может прийти быстро, это уже накопленный цикл проверок.';
  if (r?._schema === 'v2') {
    if (Number.isFinite(lossRub) && lossRub > 0) {
      conclusion.reasons.push(`В сводке указаны потери по жалобам: ${lossRub.toLocaleString('ru-RU')} ₽.`);
    }
    if (r.complaints != null && r.complaints !== '') conclusion.reasons.push(`Учтено жалоб: ${r.complaints}.`);
    const st = (r.status || '').toString().trim();
    if (st) conclusion.reasons.push(`Статус в мониторинге: «${st}».`);
    const sp = (r.source_primary || '').toString().trim();
    if (sp && sp !== '—') conclusion.reasons.push(`Есть указание на первоисточник/публикацию: ${sp}.`);
  } else {
    if (r?.risk_score != null) conclusion.reasons.push(`В старой сводке указан риск: ${r.risk_score} из 100.`);
    if (r?.verdict) conclusion.reasons.push(`Вердикт в сводке: ${r.verdict}.`);
    if (r?.complaints != null) conclusion.reasons.push(`Жалоб в сводке: ${r.complaints}.`);
    if (r?.total_loss) conclusion.reasons.push(`Потери в сводке: ${r.total_loss}.`);
  }
  const tailClean =
    conclusion.status === KRO_V0_STATUS.clean &&
    (r?.complaints == null || Number(r.complaints) === 0) &&
    !(Number.isFinite(lossRub) && lossRub > 0)
      ? [
          'По сводке нет зафиксированных жалоб на потери — плюс к спокойствию, но не замена собственной осторожности и чтения условий.',
        ]
      : [];
  conclusion.reasons = [cardSpeedNote, ...conclusion.reasons, ...tailClean].filter(Boolean).slice(0, KRO_V0_MAX_CONCLUSION_REASONS);

  const riskBullets = kroV0RiskBulletsFromScamBaseRow(r);
  const baseInfo = [];
  baseInfo.push(`Канал: ${username || '—'}`);
  baseInfo.push('Сводка мониторинга: циклы проверок (не один день), метрики по тексту ленты; медиа без подписи в текст не входят.');
  baseInfo.push(
    'Если нужна «прямо сейчас» свежая лента — откройте страницу канала и глубокий режим или смотрите дату последнего цикла в сводке.',
  );
  if (r?.link) baseInfo.push(`Открыть в Telegram: ${r.link}`);
  if (r?._schema === 'v2') {
    if (r.detected_at) baseInfo.push(`В учёте с: ${r.detected_at}`);
    if (r.channel_age_days != null && r.channel_age_days !== '') {
      baseInfo.push(`Возраст канала (по данным мониторинга): ~${r.channel_age_days} дн.`);
    }
  } else {
    const bits = [];
    if (r?.risk_score != null) bits.push(`риск ${r.risk_score}/100`);
    if (r?.ads_per_week != null) bits.push(`много «продающих» постов: ~${r.ads_per_week} за неделю`);
    if (r?.bot_pct) bits.push(`похожие ответы: ${r.bot_pct}`);
    if (bits.length) baseInfo.push(`Кратко по сводке: ${bits.join('; ')}.`);
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
  if (ev && ev !== '—') external.push('Есть текст и ссылки — подробности внизу страницы в блоке деталей.');

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
    network.push('Явной «карты связей» в сводке нет.');
  }

  while (baseInfo.length > 6) baseInfo.pop();
  while (content.length > 4) content.pop();
  while (external.length > 3) external.pop();
  while (network.length > 3) network.pop();

  return {
    v: 0,
    channel_key: (extra && extra.channel_key) || channelMatchKey(username) || username,
    generated_at: new Date().toISOString(),
    sources: ['мониторинг каналов'],
    basic_info: baseInfo,
    content_behavior: content,
    external_reports: external,
    ties_risk_factors: network,
    conclusion,
  };
}

function kroV0PrependFastModeNote(analysis, profile) {
  if (!analysis || typeof analysis !== 'object') return;
  const p = profile && typeof profile === 'object' ? profile : null;
  const key = (analysis.channel_key || '').toString().trim();
  const uname =
    (p?.username || '').toString().trim() || (key ? `@${key}` : 'канал');
  const st = p ? (p.status || p.verdict || '').toString().trim() : '';
  const complaints = p && p.complaints != null && p.complaints !== '' ? String(p.complaints).trim() : '';
  const lossRub = p ? Number(p.total_loss_rub) : NaN;
  const bits = [];
  if (st) bits.push(`в мониторинге статус «${st}»`);
  if (complaints && complaints !== '—') bits.push(`жалоб учтено: ${complaints}`);
  if (Number.isFinite(lossRub) && lossRub > 0) {
    bits.push(`потери по данным мониторинга: ${lossRub.toLocaleString('ru-RU')} ₽`);
  }
  const line = bits.length
    ? `${uname}: быстрый режим — жалобы и мониторинг (${bits.join('; ')}); полную ленту Telegram в этом запросе не перечитывали.`
    : `${uname}: быстрый режим — жалобы и мониторинг; полную ленту Telegram в этом запросе не перечитывали.`;
  const bi = Array.isArray(analysis.basic_info) ? analysis.basic_info : [];
  if (bi.some((x) => /^Быстрый режим/i.test(String(x)))) return;
  analysis.basic_info = [line, ...bi].slice(0, 8);
}

function kroV0MergeDeepRateLimitIntoAnalysis(analysis, deepAvailableAtIso) {
  if (!analysis || typeof analysis !== 'object') return;
  const msk = deepAvailableAtIso ? kroFormatIsoForMsk(deepAvailableAtIso) : '';
  const msg = msk
    ? `Запрошен полный разбор ленты, но Telegram сейчас ограничивает частоту запросов. Повторить можно примерно после ${msk}. Ниже — краткий отчёт по жалобам и мониторингу без полной выборки постов.`
    : 'Запрошен полный разбор ленты, но сейчас действует лимит Telegram — ниже краткий отчёт по жалобам и мониторингу.';
  const c = analysis.conclusion && typeof analysis.conclusion === 'object' ? analysis.conclusion : { status: KRO_V0_STATUS.watch, reasons: [] };
  analysis.conclusion = {
    ...c,
    status: KRO_V0_STATUS.watch,
    reasons: [msg, ...(Array.isArray(c.reasons) ? c.reasons : [])].slice(0, KRO_V0_MAX_CONCLUSION_REASONS),
  };
  const head =
    'Полный разбор ленты в этом запросе недоступен из‑за лимита Telegram. Показан краткий отчёт без полной выборки постов.';
  analysis.basic_info = [head, ...(Array.isArray(analysis.basic_info) ? analysis.basic_info : [])].slice(0, 8);
  const src = Array.isArray(analysis.sources) ? analysis.sources : [];
  if (!src.some((x) => /лимит.*telegram|telegram.*лимит/i.test(String(x)))) {
    analysis.sources = [...src, 'Telegram: лимит запросов'];
  }
}

function kroV0MergeServerDeepThrottleIntoAnalysis(analysis, userMessage) {
  if (!analysis || typeof analysis !== 'object') return;
  const msg =
    (userMessage || '').toString().trim() ||
    'Глубокий анализ сейчас ограничен на сервере, чтобы не исчерпать лимиты Telegram. Ниже — быстрый отчёт; глубокая выборка ленты в этом запросе не выполнялась.';
  const c = analysis.conclusion && typeof analysis.conclusion === 'object' ? analysis.conclusion : { status: KRO_V0_STATUS.watch, reasons: [] };
  analysis.conclusion = {
    ...c,
    status: KRO_V0_STATUS.watch,
    reasons: [msg, ...(Array.isArray(c.reasons) ? c.reasons : [])].slice(0, KRO_V0_MAX_CONCLUSION_REASONS),
  };
  const src = Array.isArray(analysis.sources) ? analysis.sources : [];
  if (!src.some((x) => /лимит сервиса/i.test(String(x)))) {
    analysis.sources = [...src, 'лимит сервиса (глубокие проверки)'];
  }
}

function kroV0MergeQueuedDeepIntoAnalysis(analysis, userMessage) {
  if (!analysis || typeof analysis !== 'object') return;
  const msg =
    (userMessage || '').toString().trim() ||
    'Глубокий анализ поставлен в очередь из‑за высокой нагрузки. Ниже — быстрый отчёт; полная выборка ленты выполнится в фоне — обновите страницу через несколько минут.';
  const c = analysis.conclusion && typeof analysis.conclusion === 'object' ? analysis.conclusion : { status: KRO_V0_STATUS.watch, reasons: [] };
  analysis.conclusion = {
    ...c,
    status: KRO_V0_STATUS.watch,
    reasons: [msg, ...(Array.isArray(c.reasons) ? c.reasons : [])].slice(0, KRO_V0_MAX_CONCLUSION_REASONS),
  };
  const src = Array.isArray(analysis.sources) ? analysis.sources : [];
  if (!src.some((x) => /в очереди/i.test(String(x)))) {
    analysis.sources = [...src, 'проверка Telegram (в очереди)'];
  }
}

/**
 * Канал без публичной карточки в мониторинге: быстрый ответ по жалобам и сводке channels_watch (без техно‑текста про таблицы).
 * @param {object|null} watchRow — последняя видимая строка channels_watch (если уже загружена).
 */
async function kroV0BuildFastAnalysisNoLive(client, channelKey, decodedQuery, watchRow) {
  const displayCh =
    /^t\.me\//i.test(decodedQuery) || decodedQuery.includes('+') ? decodedQuery : `@${channelKey}`;
  const reports = client && kroSheetId ? await getAllReportsForChannel(client, displayCh) : [];
  const nonFp = reports.filter((r) => (r.source || '').toLowerCase() !== 'false_positive');
  const complaintsSum = nonFp.reduce((s, r) => s + (Number(r.sum) || 0), 0);
  const sumsPos = nonFp.map((r) => Number(r.sum) || 0).filter((x) => x > 0);
  const sumMin = sumsPos.length ? Math.min(...sumsPos) : 0;
  const sumMax = sumsPos.length ? Math.max(...sumsPos) : 0;

  const tmeS = channelKey ? `https://t.me/s/${channelKey}` : '';
  const baseInfo = [];
  baseInfo.push(`Канал ${displayCh}: жалобы в сервис и сводка широкого мониторинга — в том же отчёте ниже.`);
  if (tmeS) {
    baseInfo.push(`Публичная лента в браузере: ${tmeS} — можно быстро пролистать последние посты глазами.`);
  }

  let _kro_watch_baked = false;
  if (watchRow && (watchRow.username || '').toString().trim()) {
    _kro_watch_baked = true;
    const st = (watchRow.status || '').toString().trim();
    const wc = Number(watchRow.complaints) || 0;
    const lc = (watchRow.last_checked_at || '').toString().trim();
    const parts = [`Мониторинг: ${displayCh}`];
    if (st) parts.push(`статус «${st}»`);
    if (wc > 0) parts.push(`жалоб в сводке: ${wc}`);
    if (lc) parts.push(`обновлено ${lc}`);
    baseInfo.push(parts.join(' · ') + '.');
  } else {
    baseInfo.push(
      `По широкому мониторингу для ${displayCh} в этой выборке нет сигнала — ориентируемся на жалобы и на ссылку на ленту выше.`,
    );
  }

  const external = [];
  if (nonFp.length) {
    const extParts = [`Жалобы и обращения по каналу: ${nonFp.length} записей.`];
    if (complaintsSum > 0) {
      extParts.push(`суммы по обращениям ~${complaintsSum.toLocaleString('ru-RU')} усл. ед.`);
    }
    if (sumMin > 0 && sumMax > 0 && sumMin !== sumMax) {
      extParts.push(`разброс ${sumMin.toLocaleString('ru-RU')}–${sumMax.toLocaleString('ru-RU')} усл. ед.`);
    }
    external.push(extParts.join(' '));
  } else {
    external.push(
      `Обращений с тем же каналом в принятых жалобах сейчас нет — весь интернет мы не сканируем, только то, что прислали люди в сервис.`,
    );
  }

  const content = [];
  if (nonFp.length) {
    const r0 = nonFp[0];
    const ot = (r0.object_type || '').toString().trim();
    const src = (r0.source || '').toString().trim();
    const dt = (r0.date || '').toString().trim();
    const bits = [];
    if (ot) bits.push(`тип обращения: «${ot}»`);
    if (src) bits.push(`источник: ${src}`);
    if (dt) bits.push(`дата: ${dt}`);
    if (bits.length) content.push(bits.join(' · ') + '.');
  }
  content.push(
    'Реклама в ленте, «сигнальные» формулировки и разбор текстов: при живом срезе смотрим в выборке; полный архив до 6 мес. — на странице канала (глубокий режим).',
  );

  const ties = [];
  if (watchRow && (watchRow.reviews_summary || '').toString().trim()) {
    ties.push(`Связи/репутация (мониторинг): ${kroV0TrimSentence(watchRow.reviews_summary, 200)}`);
  } else if (watchRow && (watchRow.activity_summary || '').toString().trim()) {
    ties.push(`Активность (мониторинг): ${kroV0TrimSentence(watchRow.activity_summary, 200)}`);
  }
  ties.push('Автоматический «граф связей» без живой выборки постов не строим — так честнее.');

  let status = KRO_V0_STATUS.watch;
  const reasons = [];
  if (complaintsSum > 0 || nonFp.length >= 2) {
    status = KRO_V0_STATUS.risk;
    reasons.push(
      `По ${displayCh} в открытых отчётах есть заметные сигналы — осторожность и проверка первоисточников уместны.`,
    );
  } else if (nonFp.length === 1) {
    status = KRO_V0_STATUS.watch;
    reasons.push(
      `Одно обращение в жалобах — картина неполная; для полной ленты откройте страницу канала и глубокий анализ.`,
    );
  } else {
    status = KRO_V0_STATUS.watch;
    reasons.push(
      `По ${displayCh} мало сигналов: в жалобах пусто, без живого среза ленты это не «всё чисто», а «мало данных». При сомнениях смотрите ленту или глубокий режим на странице канала.`,
    );
  }
  if (complaintsSum > 0) {
    reasons.push(`Суммы в отчётах (усл. ед.): ~${complaintsSum.toLocaleString('ru-RU')}.`);
  }

  const out = {
    v: 0,
    channel_key: channelKey,
    generated_at: new Date().toISOString(),
    sources: ['отчёты пользователей', 'широкий мониторинг'],
    basic_info: baseInfo.slice(0, 5),
    content_behavior: content.slice(0, 4),
    external_reports: external,
    ties_risk_factors: ties.slice(0, 4),
    conclusion: { status, reasons: reasons.slice(0, KRO_V0_MAX_CONCLUSION_REASONS) },
  };
  if (_kro_watch_baked) out._kro_watch_baked = true;

  // ---- AI upgrade: жалобы из интернета + t.me/s + Mistral → v:0 → v:1 ----
  if (channelKey) {
    try {
      const aiDeadline = Date.now() + 22000;
      // Запускаем поиск жалоб и AI анализ ПАРАЛЛЕЛЬНО — экономим время
      const [complaintsSettled, pbSettled] = await Promise.allSettled([
        kroFetchChannelComplaintsFromWeb(channelKey),
        kroBuildPersonBehindFromPublicSnapshot(
          displayCh,
          `https://t.me/s/${channelKey}`,
          aiDeadline,
          `fast-${channelKey}`,
          [],
        ),
      ]);

      const complaints = complaintsSettled.status === 'fulfilled' ? (complaintsSettled.value || []) : [];
      const pb = pbSettled.status === 'fulfilled' ? pbSettled.value : null;

      // --- Если AI нашёл имя автора — ищем жалобы ещё и по нему ---
      if (pb && pb.who && pb.who !== 'Аноним' && pb.who !== 'anonymous_hidden') {
        try {
          const personComplaints = await kroFetchChannelComplaintsFromWeb(channelKey, pb.who);
          const existingKeys = new Set(complaints.map((c) => (c.link || c.title || '').trim()));
          for (const c of personComplaints) {
            const k = (c.link || c.title || '').trim();
            if (k && !existingKeys.has(k)) {
              existingKeys.add(k);
              complaints.push(c);
            }
          }
          // Пересортируем: специфичные для канала — первыми
          complaints.sort((a, b) => (b._channel_specific ? 1 : 0) - (a._channel_specific ? 1 : 0));
          console.log(`[KRO fast-ai ${channelKey}] complaints_after_person_search=${complaints.length}`);
        } catch { /* продолжаем */ }
      }

      // --- Жалобы из интернета ---
      // ВАЖНО: показываем ТОЛЬКО жалобы, которые реально упоминают именно этот канал/автора
      // (_channel_specific). Общие статьи про скам в Telegram НИКОГДА не должны попадать
      // в отчёт как будто это найдено про конкретный канал — это клевета на человека.
      // Если специфичных жалоб нет — просто ничего не показываем (не пишем общие как fallback).
      if (complaints.length > 0) {
        const specificOnes = complaints.filter((c) => c._channel_specific);
        if (specificOnes.length > 0) {
          out.web_complaints = specificOnes;
          const webLines = specificOnes.slice(0, 3).map((c) => {
            const src = c.link ? ` (${c.link.replace(/^https?:\/\//, '').split('/')[0]})` : '';
            return `Интернет${src}: ${String(c.snippet || c.title || '').slice(0, 200)}`;
          });
          out.external_reports = [...webLines, ...out.external_reports].slice(0, 5);
          out.sources = [...(out.sources || []), 'веб-поиск жалоб'];
        }
        console.log(`[KRO fast-ai ${channelKey}] complaints_found=${complaints.length} specific=${specificOnes.length}`);
      }

      if (pb && (pb.verdict || pb.who)) {
        // basic_info: кто за каналом
        const pbInfo = [];
        if (pb.who && pb.who !== 'anonymous_hidden') pbInfo.push(`Автор / кто за каналом: ${pb.who}.`);
        if (pb.claimed_background && pb.claimed_background !== 'Не упоминается') {
          pbInfo.push(`Заявленный опыт: ${pb.claimed_background}.`);
        }
        if (pb.claimed_path && pb.claimed_path !== 'Не упоминается') {
          pbInfo.push(`Путь в крипте: ${pb.claimed_path}.`);
        }
        if (pb.description) pbInfo.push(`Описание канала: ${String(pb.description).slice(0, 200)}`);
        out.basic_info = [...pbInfo, ...out.basic_info].slice(0, 5);

        // content_behavior: business_model + red_flags
        const pbContent = [];
        if (pb.business_model) pbContent.push(`Бизнес-модель: ${pb.business_model}.`);
        if (pb.red_flags && pb.red_flags !== 'Явных манипулятивных схем не найдено') {
          pbContent.push(`Схемы манипуляций: ${String(pb.red_flags).slice(0, 300)}`);
        }
        if (pbContent.length) out.content_behavior = [...pbContent, ...out.content_behavior].slice(0, 4);

        // ties_risk_factors: reveal_moment + соцсети
        const pbTies = [];
        if (pb.reveal_moment) pbTies.push(`Скрытая механика: ${pb.reveal_moment}`);
        const pbLinks = (pb.social_links || []).map((l) => `${l.label}: ${l.url}`).join(', ');
        if (pbLinks) pbTies.push(`Соцсети из описания: ${pbLinks}`);
        if (pbTies.length) out.ties_risk_factors = [...pbTies, ...out.ties_risk_factors].slice(0, 4);

        // conclusion: статус + причины из Mistral
        if (pb.verdict) {
          const vl = pb.verdict.toLowerCase();
          let aiStatus = out.conclusion.status;
          if (vl.startsWith('не плати') || vl.startsWith('уйди') || vl.startsWith('опасно')) {
            aiStatus = KRO_V0_STATUS.risk;
          } else if (vl.startsWith('скам') || vl.startsWith('подтверждённый')) {
            aiStatus = KRO_V0_STATUS.scam;
          } else if (vl.startsWith('смотри бесплатно')) {
            aiStatus = KRO_V0_STATUS.watch;
          }
          const aiReasons = [pb.verdict];
          if (pb.next_action) aiReasons.push(`Рекомендация: ${pb.next_action}`);
          out.conclusion = {
            status: aiStatus,
            reasons: [...aiReasons, ...out.conclusion.reasons].slice(0, KRO_V0_MAX_CONCLUSION_REASONS),
          };
        }

        out.v = 1;
        out.sources = [...(out.sources || []), 't.me/s публичная лента', 'Mistral AI'];
        if (pb.data_confidence) out._data_confidence = pb.data_confidence;
        if (Array.isArray(pb.web_evidence) && pb.web_evidence.length) {
          out._web_evidence = pb.web_evidence;
        }
        console.log(
          `[KRO fast-ai ${channelKey}] upgraded to v:1 verdict=${String(pb.verdict || '').slice(0, 80)}`,
        );
      }
    } catch (eFast) {
      console.warn(
        `[KRO fast-ai ${channelKey}] error=${eFast && eFast.message ? String(eFast.message) : 'failed'}`,
      );
    }
  }
  // ---- конец AI upgrade ----

  return out;
}

function kroV0BuildAnalysisFromLiveParsed(parsed, channelKey) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const username = (p.username || '').toString().trim();
  const conclusion = kroV0ConclusionFromLiveParsed(p);

  const baseInfo = [];
  baseInfo.push(`Канал: ${username || (channelKey ? `@${channelKey}` : '—')}`);
  if (p.found !== true && !p.not_crypto) {
    baseInfo.push(
      'За отведённое время не удалось охватить всю ленту целиком — ниже сокращённый, но честный вывод по доступной выборке.',
    );
  }
  const winD = Number(p.analysis_window_days);
  const postsN = Number(p.posts_fetched);
  const limLive = kroLiveSampleLimitedDetail(p);
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
  if (p.found === true && limLive.limited) {
    baseInfo.push(
      `Ограничение данных: ${limLive.detail}. Ниже — что всё равно удалось проверить по тексту и отчётам; вывод узкий и честный, без имитации «полного года каждого слова».`,
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
  if (p.read_only) baseInfo.push('Это отчёт для просмотра: мы никуда у вас ничего не записываем.');

  const content = [];
  if (p.found === true && !p.not_crypto) {
    const calm = [];
    if (!p.has_signal_offer) calm.push('нет выделенных «сигнальных» призывов в критериях проверки');
    if (!p.only_profits_flag) calm.push('нет картины «одни профиты без минусов»');
    const c0 = p.complaints != null && p.complaints !== '' ? Number(p.complaints) : NaN;
    if (Number.isFinite(c0) && c0 === 0) calm.push('0 жалоб в учтённых обращениях');
    if (calm.length) {
      content.push(`Спокойнее по автоматическим правилам: ${calm.join('; ')}.`);
    }
    const weak = [];
    const fomoV = Number(p.fomo_pct);
    if (Number.isFinite(fomoV) && fomoV > 0 && fomoV < 24) {
      weak.push(`редкие «срочные» формулировки (~${fomoV}% постов)`);
    }
    const adsV = Number(p.ads_ratio);
    if (Number.isFinite(adsV) && adsV >= 10 && adsV < 58) {
      weak.push(`доля «продающего» тона ~${adsV}% в окне`);
    }
    if (p.has_signal_offer && weak.length < 2) {
      weak.push('есть маркеры сигнального оффера — смотрите сами условия');
    }
    if (weak.length) {
      content.push(`Слабые отметины (сами по себе не равны скаму): ${weak.join(', ')}.`);
    }
  }
  const behaviorBits = [];
  if (p.ads_per_week != null) behaviorBits.push(`за 7 дней много «продающих» постов (~${p.ads_per_week})`);
  if (p.ads_ratio != null) behaviorBits.push(`в выборке окна «продажа» ~${p.ads_ratio}%`);
  if (p.fomo_pct != null) behaviorBits.push(`«успей/последний шанс» ~${p.fomo_pct}% постов`);
  if (behaviorBits.length) content.push(`Поведение (метрики): ${behaviorBits.join(', ')}.`);
  if (p.bot_pct != null && p.bot_pct !== '') {
    content.push(`Ответы под постами часто одинаковые: ${p.bot_pct}.`);
  }
  if (p.only_profits_flag) content.push('Почти только «профиты», про минусы почти не говорят.');
  if (Array.isArray(p.sample_posts) && p.sample_posts.length && content.length < 5) {
    const s0 = String(p.sample_posts[0] || '');
    content.push(`Пример из ленты: «${s0.slice(0, 100)}${s0.length > 100 ? '…' : ''}»`);
  }
  while (content.length > 5) content.pop();

  const external = [];
  const jc = [];
  if (p.complaints != null && p.complaints !== '') jc.push(`жалоб: ${p.complaints}`);
  if (p.total_loss) jc.push(`сумма: ${p.total_loss}`);
  if (jc.length) external.push(`От людей в отчётах: ${jc.join(', ')}.`);
  else {
    external.push(
      'По открытым жалобам в сервисе для этого канала в этом ответе цифра не подтянулась — либо обращений не было, либо они ещё не учтены здесь.',
    );
  }
  if (p.complaints != null && p.complaints !== '' && Number(p.complaints) === 0) {
    external.push(
      'Ноль жалоб в наших отчётах — это плюс к спокойствию, но не доказательство «всё чисто везде»; жалобы могут быть вне нашей выборки.',
    );
  }

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
  if (!network.length) network.push('Продвижение других каналов в тексте выборки явно не выделено.');
  while (network.length > 3) network.pop();

  while (baseInfo.length > 6) baseInfo.pop();
  while (external.length > 3) external.pop();

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

/** Главная (?home_quick_live=1): добавить в fast‑отчёт живой срез ленты (~90 дн.) поверх жалоб/мониторинга. */
function kroV0MergeHomeQuickLiveIntoFastAnalysis(analysis, homeParsed, channelKey) {
  if (!analysis || !homeParsed || homeParsed.telegram_rate_limited || homeParsed.not_crypto) return;
  if (homeParsed._check_once_ok !== true) return;
  let live;
  try {
    live = kroV0BuildAnalysisFromLiveParsed(homeParsed, channelKey);
  } catch {
    return;
  }
  if (!live || typeof live !== 'object') return;
  const head =
    'Добавлен текст из открытой ленты (до ~3 мес.) рядом с жалобами и мониторингом.';
  const biLive = Array.isArray(live.basic_info) ? live.basic_info.slice(0, 4) : [];
  const cbLive = Array.isArray(live.content_behavior) ? live.content_behavior.slice(0, 3) : [];
  analysis.basic_info = [head, ...biLive, ...(Array.isArray(analysis.basic_info) ? analysis.basic_info : [])].slice(
    0,
    12,
  );
  analysis.content_behavior = [...cbLive, ...(Array.isArray(analysis.content_behavior) ? analysis.content_behavior : [])].slice(
    0,
    10,
  );
  const src = Array.isArray(analysis.sources) ? analysis.sources : [];
  if (!src.some((s) => String(s).toLowerCase().includes('telegram'))) {
    analysis.sources = ['проверка через Telegram', ...src];
  }
}

function kroRunCheckOnce(channel, opts) {
  const readOnly = !!(opts && opts.readOnly);
  const sessionString = opts && opts.telegramSessionString ? String(opts.telegramSessionString) : '';
  const periodOpt = opts && Number(opts.periodDays);
  const allowedPeriods = [30, 90, 180, 365];
  const periodDays = allowedPeriods.includes(periodOpt) ? periodOpt : kroCheckOncePeriodDays;
  const timeoutOpt = opts && Number(opts.timeoutMs);
  const timeoutMs =
    Number.isFinite(timeoutOpt) && timeoutOpt >= 5000 && timeoutOpt <= 1800000 ? timeoutOpt : kroCheckOnceTimeoutMs;
  const checkOnceEnv = opts && opts.checkOnceEnv && typeof opts.checkOnceEnv === 'object' ? opts.checkOnceEnv : null;
  const scriptPath = join(__dirname, 'kro-worker', 'check_once.py');
  if (!(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && fs.existsSync(scriptPath))) {
    return { ok: false, error: 'Живая проверка на сервере не настроена (нет ключей Telegram или скрипта).', parsed: null, stderr: '' };
  }
  try {
    const child = spawnSync('python3', [scriptPath, channel, String(periodDays)], {
      cwd: join(__dirname, 'kro-worker'),
      timeout: timeoutMs,
      encoding: 'utf8',
      env: kroTelethonSpawnEnv(readOnly, sessionString, checkOnceEnv),
    });
    if (child.error && child.error.code === 'ETIMEDOUT') {
      const sec = Math.max(1, Math.round(timeoutMs / 1000));
      return {
        ok: false,
        timedOut: true,
        error: `Чтение ленты остановлено по лимиту времени (${sec} с).`,
        parsed: null,
        stderr: (child.stderr || '').trim(),
      };
    }
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

function kroRunCheckOnceAsync(channel, opts) {
  const readOnly = !!(opts && opts.readOnly);
  const sessionString = opts && opts.telegramSessionString ? String(opts.telegramSessionString) : '';
  const periodOpt = opts && Number(opts.periodDays);
  const allowedPeriods = [30, 90, 180, 365];
  const periodDays = allowedPeriods.includes(periodOpt) ? periodOpt : kroCheckOncePeriodDays;
  const timeoutOpt = opts && Number(opts.timeoutMs);
  const timeoutMs =
    Number.isFinite(timeoutOpt) && timeoutOpt >= 5000 && timeoutOpt <= 1800000 ? timeoutOpt : kroCheckOnceTimeoutMs;
  const scriptPath = join(__dirname, 'kro-worker', 'check_once.py');
  if (!(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && fs.existsSync(scriptPath))) {
    return Promise.resolve({
      ok: false,
      error: 'Живая проверка на сервере не настроена (нет ключей Telegram или скрипта).',
      parsed: null,
      stderr: '',
    });
  }
  return new Promise((resolve) => {
    const child = spawn('python3', [scriptPath, channel, String(periodDays)], {
      cwd: join(__dirname, 'kro-worker'),
      env: kroTelethonSpawnEnv(readOnly, sessionString),
    });
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const t = setTimeout(() => {
      killedByTimeout = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, error: normalizeCheckOnceError(e.message) || 'Проверка не запустилась', parsed: null, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      stdout = (stdout || '').trim();
      stderr = (stderr || '').trim();
      if (killedByTimeout) {
        const sec = Math.max(1, Math.round(timeoutMs / 1000));
        resolve({
          ok: false,
          timedOut: true,
          error: `Чтение ленты остановлено по лимиту времени (${sec} с).`,
          parsed: null,
          stderr,
        });
        return;
      }
      const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
      if (!line) {
        resolve({
          ok: false,
          error:
            normalizeCheckOnceError(stderr) || (code !== 0 ? 'Проверка не завершилась' : 'Пустой ответ проверки'),
          parsed: null,
          stderr,
        });
        return;
      }
      try {
        const parsed = JSON.parse(line);
        resolve({ ok: true, error: null, parsed, stderr });
      } catch {
        resolve({
          ok: false,
          error: normalizeCheckOnceError(stderr) || 'Не удалось разобрать ответ проверки',
          parsed: null,
          stderr,
        });
      }
    });
  });
}

/**
 * Единый объект для отчёта: при сбое check_once не теряем причину (иначе в UI «пустой шаблон»).
 */
function kroNormalizeCheckOnceForAnalysis(once) {
  const o = once && typeof once === 'object' ? once : { ok: false, parsed: null, error: 'Нет ответа проверки' };
  if (o.ok === true && o.parsed && typeof o.parsed === 'object') {
    return { ...o.parsed, _check_once_ok: true };
  }
  const base = o.parsed && typeof o.parsed === 'object' ? { ...o.parsed } : {};
  const errRaw = base.error != null && String(base.error).trim() !== '' ? base.error : o.error;
  const err =
    normalizeCheckOnceError(errRaw) ||
    (typeof errRaw === 'string' && errRaw.trim() ? errRaw.trim() : '') ||
    'Живая проверка на сервере не завершилась (нет данных от скрипта Telegram).';
  return {
    ...base,
    found: false,
    error: err,
    _check_once_ok: false,
    check_once_timed_out: o.timedOut === true,
  };
}

/** Для UI главной страницы: период и объём выборки без парсинга текста basic_info. */
function kroLiveMetricsFromParsed(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed;
  const complaintsRaw = p.complaints;
  const complaintsNum = complaintsRaw == null || complaintsRaw === '' || complaintsRaw === '—'
    ? null
    : Number(complaintsRaw);
  return {
    found: p.found === true,
    check_once_ok: p._check_once_ok === true,
    username: (p.username || '').toString().trim() || null,
    analysis_window_days: Number.isFinite(Number(p.analysis_window_days)) ? Number(p.analysis_window_days) : null,
    posts_fetched: Number.isFinite(Number(p.posts_fetched)) ? Number(p.posts_fetched) : null,
    posts_limit_used: Number.isFinite(Number(p.posts_limit_used)) ? Number(p.posts_limit_used) : null,
    complaints_count: Number.isFinite(complaintsNum) ? complaintsNum : null,
    read_only: !!p.read_only,
    telegram_rate_limited: p.telegram_rate_limited === true,
    server_deep_throttled: p.server_deep_throttled === true,
    deep_queued: p.deep_queued === true,
    deep_queue_rejected: p.deep_queue_rejected === true,
    deep_reject_reason: (p.deep_reject_reason || '').toString().trim() || null,
    deep_queue_position: Number.isFinite(Number(p.deep_queue_position)) ? Number(p.deep_queue_position) : null,
    deep_queue_eta_minutes: Number.isFinite(Number(p.deep_queue_eta_minutes)) ? Number(p.deep_queue_eta_minutes) : null,
    deep_queue_suggested_poll_seconds: Number.isFinite(Number(p.deep_queue_suggested_poll_seconds))
      ? Number(p.deep_queue_suggested_poll_seconds)
      : null,
    flood_wait_seconds: Number.isFinite(Number(p.flood_wait_seconds)) ? Number(p.flood_wait_seconds) : null,
    deep_timed_out: p.check_once_timed_out === true,
    live_check_error:
      p._check_once_ok === true
        ? p.telegram_rate_limited === true && p.error != null
          ? String(p.error)
          : p.server_deep_throttled === true && p.error != null
            ? String(p.error)
            : p.deep_queue_rejected === true && p.error != null
              ? String(p.error)
              : p.deep_queued === true && p.error != null
                ? String(p.error)
                : null
        : p.error != null
          ? String(p.error)
          : null,
  };
}

function kroChannelProfileLiveMetrics(parsed, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const p = parsed && typeof parsed === 'object' ? parsed : { found: false, _check_once_ok: false };
  const base = kroLiveMetricsFromParsed(p);
  const out = base || {
    found: false,
    check_once_ok: false,
    username: null,
    analysis_window_days: null,
    posts_fetched: null,
    posts_limit_used: null,
    complaints_count: null,
    read_only: false,
    telegram_rate_limited: false,
    server_deep_throttled: false,
    deep_queued: false,
    deep_queue_rejected: false,
    deep_reject_reason: null,
    deep_queue_position: null,
    deep_queue_eta_minutes: null,
    deep_queue_suggested_poll_seconds: null,
    flood_wait_seconds: null,
    deep_timed_out: false,
    live_check_error: null,
  };
  const at = o.deepAvailableAt != null && o.deepAvailableAt !== '' ? String(o.deepAvailableAt) : null;
  return {
    ...out,
    mode: o.mode === 'deep' ? 'deep' : 'fast',
    deep_ran: o.deepRan === true,
    deep_status: o.deepStatus != null ? o.deepStatus : null,
    deep_available_at: at,
    deep_available_at_msk: at ? kroFormatIsoForMsk(at) || null : null,
    deep_max_wait_minutes: o.mode === 'deep' ? 30 : null,
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

/**
 * Разбор https://t.me/… / telegram.me в форму, совместимую с normalizeChannel / check_once.
 * Возвращает null если URL не про Telegram (тогда вызывающий может взять hostname как сайт).
 * Пустая строка — только домен без пути (невалидный ввод канала).
 */
function kroTelegramRefFromHttpUrl(urlString) {
  try {
    const u = new URL(String(urlString || '').trim());
    const host = (u.hostname || '').toLowerCase().replace(/\.$/, '');
    if (host !== 't.me' && host !== 'telegram.me' && host !== 'telegram.dog') return null;
    let path = (u.pathname || '/').replace(/^\/+/, '').trim();
    path = path.split('?')[0].split('#')[0];
    if (!path) return '';
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return '';
    if (parts[0].startsWith('+')) return `t.me/${parts[0]}`;
    if (parts[0] === 'joinchat' && parts[1]) return `t.me/joinchat/${parts[1]}`;
    if (parts[0] === 's' && parts[1]) {
      const slug = parts[1];
      return slug.startsWith('@') ? slug : `@${slug}`;
    }
    const slug = parts[0];
    return slug.startsWith('@') ? slug : `@${slug}`;
  } catch {
    return null;
  }
}

function normalizeChannel(channel) {
  const s = (channel || '').toString().trim().replace(/\s/g, '');
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    /* Инвайт-хеш t.me/+… чувствителен к регистру — не lowercasить URL целиком. */
    const tgRef = kroTelegramRefFromHttpUrl(s);
    if (tgRef !== null) return tgRef;
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
    const tgRef = kroTelegramRefFromHttpUrl(s);
    if (tgRef !== null) {
      if (!tgRef) return '';
      return channelMatchKey(tgRef);
    }
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

/** Подпись канала в UI analyze-channel: инвайт-ссылки без ложного «@ник». */
function kroAnalyzeChannelUiLabel(normalized, key) {
  const kn = String(key || '').trim().toLowerCase();
  if (kn.startsWith('t.me/+')) {
    const n = String(normalized || '').trim();
    let h = '';
    if (/^https?:\/\//i.test(n)) {
      try {
        const u = new URL(n);
        const p = (u.pathname || '').replace(/^\//, '');
        if (p.startsWith('+')) h = p.slice(1);
      } catch {
        h = '';
      }
    } else {
      h = n.replace(/^t\.me\/\+/i, '');
    }
    const vis = h.length > 22 ? `${h.slice(0, 14)}…${h.slice(-6)}` : h;
    return vis ? `Приватный канал (инвайт …${vis})` : 'Приватный канал (инвайт-ссылка)';
  }
  const n = String(normalized || '').trim();
  return n.startsWith('@') ? n : `@${key}`;
}

function kroExtractTelegramPublicSlug(channelRef) {
  const raw = String(channelRef || '').trim();
  if (!raw) return '';
  /* Публичная страница t.me/s недоступна для приватных инвайт-ссылок. */
  if (/t\.me\/\+/i.test(raw)) return '';
  const m = raw.match(/(?:https?:\/\/)?t\.me\/(?:s\/)?([^/?#\s]+)/i);
  if (m && m[1]) return String(m[1]).replace(/^@+/, '').trim().toLowerCase();
  return raw.replace(/^@+/, '').replace(/^t\.me\//i, '').replace(/^s\//i, '').trim().toLowerCase();
}

/** Публичный @username Telegram: 5–32 символов, латиница, цифры и _. */
function kroIsValidTelegramPublicUsernameKey(key) {
  const s = String(key || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_]{4,31}$/.test(s);
}

function kroRawInputLooksLikeExplicitTelegramRef(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/t\.me\//i.test(s) || /telegram\.me\//i.test(s)) return true;
  return false;
}

const KRO_RU_LAT_LOWER = {
  щ: 'sch',
  ё: 'e',
  й: 'i',
  ъ: '',
  ь: '',
  ы: 'y',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ж: 'zh',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  з: 'z',
  и: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
};

function kroTransliterateRuToLatinLoose(str) {
  let out = '';
  for (const ch of String(str || '')) {
    const low = ch.toLowerCase();
    if (KRO_RU_LAT_LOWER[low] !== undefined) {
      out += KRO_RU_LAT_LOWER[low];
      continue;
    }
    if (/[a-z0-9]/i.test(ch)) {
      out += ch.toLowerCase();
      continue;
    }
    if (/\s/.test(ch)) {
      out += ' ';
      continue;
    }
    out += ' ';
  }
  return out.replace(/\s+/g, ' ').trim();
}

function kroSlugifyTelegramUsernameCandidate(rawPhrase) {
  let t = kroTransliterateRuToLatinLoose(String(rawPhrase || '')).toLowerCase();
  t = t.replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (t.length > 32) t = t.slice(0, 32).replace(/_+$/g, '');
  if (t.length && /^[0-9_]/.test(t)) t = `x_${t}`.replace(/_+/g, '_').slice(0, 32).replace(/_+$/g, '');
  return t;
}

function kroCollectTelegramUsernameCandidatesFromPlainTitle(rawInput) {
  const base = String(rawInput || '').replace(/^@+/u, '').trim();
  if (!base) return [];
  const seen = new Set();
  const out = [];
  const push = (x) => {
    const s = String(x || '').trim().toLowerCase();
    if (!kroIsValidTelegramPublicUsernameKey(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  const nospace = base.replace(/\s+/g, '');
  push(kroSlugifyTelegramUsernameCandidate(nospace));
  const parts = base.split(/\s+/u).filter(Boolean);
  if (parts.length > 1) {
    push(kroSlugifyTelegramUsernameCandidate(parts.join(' ')));
    push(kroSlugifyTelegramUsernameCandidate(parts.join('_')));
    const first = kroSlugifyTelegramUsernameCandidate(parts[0]);
    const last = kroSlugifyTelegramUsernameCandidate(parts[parts.length - 1]);
    if (first.length >= 5 && last.length >= 5 && first !== last) {
      const combo = `${first}_${last}`.slice(0, 32).replace(/_+$/g, '');
      push(combo);
    }
  }
  return out;
}

function kroShouldAttemptResolvePlainTitleToSlug(rawInput, key) {
  const raw = String(rawInput || '').trim();
  if (!raw || kroRawInputLooksLikeExplicitTelegramRef(raw)) return false;
  const kn = String(key || '').trim().toLowerCase();
  if (kn.startsWith('t.me/+')) return false;
  if (/\s/u.test(raw)) return true;
  if (!kroIsValidTelegramPublicUsernameKey(kn)) return true;
  return false;
}

async function kroResolveTelegramPublicSlugFromPlainTitle(rawInput, opts) {
  const analyzeLogId = opts && opts.analyzeLogId ? String(opts.analyzeLogId) : 'resolve';
  const budgetMs = Math.min(22000, Math.max(5000, Number(opts && opts.budgetMs) || KRO_PLAIN_TITLE_RESOLVE_MS));
  const candidates = kroCollectTelegramUsernameCandidatesFromPlainTitle(rawInput);
  if (!candidates.length) return null;
  const n = Math.min(8, candidates.length);
  const per = Math.max(2500, Math.floor(budgetMs / n));
  const tried = [];
  for (const slug of candidates.slice(0, 8)) {
    tried.push(slug);
    const snap = await kroFetchTelegramPublicSnapshot(`@${slug}`, {
      timeoutMs: per,
      logLabel: `${analyzeLogId}:plain_title_probe@${slug}`,
    });
    if (snap && Array.isArray(snap.snippets) && snap.snippets.length) {
      console.log(`[KRO plain-title-resolve ${analyzeLogId}] hit slug=${slug} snippets=${snap.snippets.length}`);
      return {
        resolved_slug: slug,
        input_raw: String(rawInput || '').trim(),
        tried_slugs: tried,
        page_title_ru: snap.title ? String(snap.title).slice(0, 140) : null,
        method: 't_me_s_snapshot_probe',
      };
    }
  }
  console.log(`[KRO plain-title-resolve ${analyzeLogId}] miss tried=${tried.join(',')}`);
  return null;
}

/** Несколько формулировок для site search (?s=): кириллица + латиница после транслитерации. */
function kroSiteSearchQueriesVariants(opts) {
  const hintSan = String((opts && opts.hintSan) || '').trim();
  const slugKey = String((opts && opts.slugKey) || '').trim();
  const out = [];
  const add = (x) => {
    const t = String(x || '').trim();
    if (t.length >= 3 && !out.includes(t)) out.push(t);
  };
  add(hintSan);
  add(slugKey);
  const lat = kroTransliterateRuToLatinLoose(hintSan).replace(/\s+/g, ' ').trim();
  if (lat.length >= 3 && lat.toLowerCase() !== hintSan.toLowerCase()) add(lat);
  return out.slice(0, 4);
}

async function kroFetchSiteSearchMentionsMulti(queries, budgetMs) {
  const qs = [...new Set((queries || []).map((x) => String(x || '').trim()).filter((x) => x.length >= 3))].slice(0, 4);
  if (!qs.length) return [];
  const base = Math.min(9000, Math.max(1200, Number(budgetMs) || 3500));
  const per = Math.max(900, Math.floor(base / qs.length));
  const merged = [];
  for (const q of qs) {
    const chunk = await kroFetchSiteSearchMentionsQuery(q, per);
    for (const row of chunk) merged.push({ ...row, search_query: q });
  }
  return merged;
}

function kroStripHtmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Строка похожа на скрипт, мета-тег или обрывок вёрстки — не показывать как «пост канала». */
function kroIsGarbagePublicSnapshotLine(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  const low = t.toLowerCase();
  const junkHints = [
    'window.',
    'window[',
    'document.',
    'postmessage',
    'json.stringify',
    'matchmedia',
    'prefers-color-scheme',
    'try{if(',
    'catch(',
    'function(',
    '=>',
    'addeventlistener',
    'web.telegram.org',
    'telegram.org/js',
    'web_app_open',
    'eventtype:',
    'viewport',
    'http-equiv',
    'charset=',
    'application/ld+json',
    '<script',
    '</script',
    'nonce=',
    'telegram-web-app',
    'data-telegram',
  ];
  if (junkHints.some((h) => low.includes(h))) return true;
  if (/^\s*</.test(t) || /\b<meta\s/i.test(low)) return true;
  if (/\bmeta\s+name\s*=\s*["']?twitter/i.test(low)) return true;
  if (/\b(property|name)\s*=\s*["']og:/i.test(low)) return true;
  if (/^["']?twitter:description/i.test(low)) return true;
  const letters = (t.match(/[a-zа-яёії]/gi) || []).length;
  const alnum = (t.match(/[0-9a-zа-яёії]/gi) || []).length;
  if (t.length >= 35 && alnum > 0 && letters / t.length < 0.22 && /[{}\[\];]|&&|\|\|/.test(t)) return true;
  return false;
}

/** Достаём человекочитаемое описание канала из meta (не сырой тег). */
function kroExtractPublicChannelDescriptionFromHtml(html) {
  const raw = String(html || '');
  const patterns = [
    /<meta\s+property="og:description"\s+content="([^"]*)"/i,
    /<meta\s+property='og:description'\s+content='([^']*)'/i,
    /<meta\s+name="twitter:description"\s+content="([^"]*)"/i,
    /<meta\s+name='twitter:description'\s+content='([^']*)'/i,
    /<meta\s+name="description"\s+content="([^"]*)"/i,
  ];
  for (const rx of patterns) {
    const m = raw.match(rx);
    if (!m || !m[1]) continue;
    let t = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    t = kroStripHtmlToText(t).trim();
    if (t.length >= 24 && !kroIsGarbagePublicSnapshotLine(t)) return t;
  }
  return '';
}

function kroExtractSocialLinksFromHtml(html) {
  if (!html) return [];
  const links = [];
  const seen = new Set();
  const PATTERNS = [
    { re: /https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reel\/|explore\/)[a-zA-Z0-9_.]{3,}/gi, label: 'Instagram' },
    { re: /https?:\/\/(?:www\.)?youtube\.com\/(?:@|c\/|channel\/|user\/)[a-zA-Z0-9_\-]+/gi, label: 'YouTube' },
    { re: /https?:\/\/youtu\.be\/[a-zA-Z0-9_\-]+/gi, label: 'YouTube' },
    { re: /https?:\/\/(?:x|twitter)\.com\/[a-zA-Z0-9_]{1,15}/gi, label: 'Twitter/X' },
    { re: /https?:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9_.]+/gi, label: 'TikTok' },
    { re: /https?:\/\/(?:www\.)?vk\.com\/[a-zA-Z0-9_]+/gi, label: 'ВКонтакте' },
    { re: /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_\-]+/gi, label: 'LinkedIn' },
    { re: /https?:\/\/t\.me\/\+[a-zA-Z0-9_\-]+/gi, label: 'Telegram VIP' },
  ];
  const SKIP = /t\.me\/(?!\+)|telegram\.|google\.|fonts\.|cdn\.|cloudflare\.|apple\.|gstatic\./i;
  const allText = html + ' ' + html.replace(/<[^>]+>/g, ' ');
  for (const { re, label } of PATTERNS) {
    for (const url of (allText.match(re) || [])) {
      const clean = url.replace(/['")\s<>]+$/, '').replace(/&amp;/g, '&');
      if (!seen.has(clean) && clean.length < 200 && !SKIP.test(clean)) {
        seen.add(clean);
        links.push({ url: clean, label });
      }
    }
  }
  const SOCIAL = /instagram\.|youtube\.|youtu\.be|twitter\.|x\.com|tiktok\.|vk\.com|linkedin\.|t\.me|telegram\.|google\.|fonts\.|cloudflare\.|cdn\.|apple\./i;
  for (const h of (allText.match(/href="(https?:\/\/[^"]{4,180})"/gi) || [])) {
    const m = h.match(/href="(https?:\/\/[^"]+)"/i);
    if (!m) continue;
    const url = m[1].replace(/&amp;/g, '&');
    if (!SOCIAL.test(url) && !seen.has(url)) {
      seen.add(url);
      links.push({ url, label: 'Сайт' });
    }
  }
  return links.slice(0, 8);
}

function kroSerperSearchEndpoint() {
  return String(process.env.SERPER_API_URL || 'https://api.serper.dev/search').trim();
}

/** Один запрос Serper; без SERPER_API_KEY — пустой массив. */
async function kroSerperWebSearch(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const r = await axios.post(
      kroSerperSearchEndpoint(),
      { q, num: 5 },
      {
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
        timeout: 10000,
      },
    );
    const organic = Array.isArray(r.data?.organic) ? r.data.organic : [];
    return organic
      .slice(0, 5)
      .map((item) => ({
        title: String(item.title || '').trim(),
        link: String(item.link || '').trim(),
        snippet: String(item.snippet || '').trim(),
      }))
      .filter((x) => x.title || x.snippet);
  } catch {
    return [];
  }
}

function kroFormatSerperHits(label, hits) {
  if (!hits.length) return '';
  return (
    `${label}:\n`
    + hits
      .map((h, i) => {
        const head = `${i + 1}. ${h.title || '—'}${h.link ? ` — ${h.link}` : ''}`;
        const body = h.snippet ? `\n   ${h.snippet.slice(0, 220)}` : '';
        return head + body;
      })
      .join('\n')
  );
}

/**
 * Значимые токены имени/ника для проверки релевантности (длина >= 3).
 * Если имя слишком общее/короткое (нет токенов) — считаем его непроверяемым.
 */
function kroNameTokens(name) {
  return String(name || '')
    .replace(/\(.*?\)/g, ' ')
    .split(/[^a-zA-Zа-яА-ЯёЁ0-9_]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3);
}

/** true только если ВСЕ значимые токены имени реально встречаются в тексте как подстрока. */
function kroTextMentionsPerson(text, nameTokens) {
  if (!Array.isArray(nameTokens) || !nameTokens.length) return false;
  const low = String(text || '').toLowerCase();
  return nameTokens.every((t) => low.includes(t));
}

/** true если в тексте есть хоть один контекстный маркер (телеграм/крипто/скам и т.п.). */
const KRO_CONTEXT_KEYWORDS = [
  'telegram', 'телеграм', 'крипто', 'crypto', 'скам', 'мошен', 'обман',
  'отзыв', 'канал', 'трейд', 'инвест', 'развод', 'кинул',
];
function kroTextHasContext(text) {
  const low = String(text || '').toLowerCase();
  return KRO_CONTEXT_KEYWORDS.some((k) => low.includes(k));
}

/**
 * Второй проход веб-поиска — по найденному имени/нику автора.
 * Запускается ПОСЛЕ Mistral, только если who — реальный человек (не Аноним).
 * ВАЖНО: каждый результат проверяется на реальное упоминание имени — иначе
 * на странице показывались общие статьи про скам в Telegram как будто это
 * «найдено про автора», что является клеветой на конкретного человека/канал.
 * Если имя слишком общее (нет проверяемых токенов) или ни один результат не
 * прошёл проверку — возвращается пустой массив, и блок просто не показывается.
 * Возвращает массив { snippet, source } — до 5 результатов.
 */
async function kroSearchByPersonName(who) {
  const name = String(who || '').trim();
  if (!name || name.length < 3) return [];
  const skipValues = ['аноним', 'anonymous_hidden', 'аноним.', '—', '-', 'не упоминается'];
  if (skipValues.includes(name.toLowerCase())) return [];
  const nameTokens = kroNameTokens(name);
  if (!nameTokens.length) return []; // имя слишком общее — нельзя безопасно проверить релевантность
  const results = [];
  // DDG: ищем имя + телеграм + крипто
  try {
    const q = `${name} telegram крипто`;
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`;
    const r = await axios.get(url, { timeout: 5000 });
    const data = r.data && typeof r.data === 'object' ? r.data : {};
    const abstract = String(data.AbstractText || data.Abstract || '').trim();
    if (
      abstract && abstract.length > 20
      && kroTextMentionsPerson(abstract, nameTokens)
      && kroTextHasContext(abstract)
    ) {
      results.push({ snippet: abstract.slice(0, 280), source: 'DuckDuckGo' });
    }
    const related = [];
    kroCollectDuckDuckGoRelatedTexts(data.RelatedTopics, related, 8);
    for (const line of related) {
      if (
        line && line.length > 20
        && kroTextMentionsPerson(line, nameTokens)
        && kroTextHasContext(line)
      ) {
        results.push({ snippet: line.slice(0, 280), source: 'DuckDuckGo' });
      }
      if (results.length >= 3) break;
    }
  } catch { /* ignore */ }
  // Веб-поиск: ищем имя + мошенник/отзывы (Tavily → Google CSE → Serper)
  const hasAnySearch =
    process.env.TAVILY_API_KEY || process.env.GOOGLE_CSE_KEY || process.env.SERPER_API_KEY;
  if (hasAnySearch && results.length < 5) {
    try {
      const q = `"${name}" мошенник OR скам OR отзывы telegram`;
      const hits = await kroUnifiedWebSearch(q);
      for (const hit of (hits || [])) {
        const snippet = String(hit.snippet || hit.title || '').trim();
        const link = String(hit.link || '').trim();
        const combined = `${hit.title || ''} ${snippet}`;
        if (
          snippet && snippet.length > 15
          && kroTextMentionsPerson(combined, nameTokens)
        ) {
          results.push({ snippet: snippet.slice(0, 280), source: link || 'web' });
        }
        if (results.length >= 5) break;
      }
    } catch { /* ignore */ }
  }
  return results.slice(0, 5);
}

/**
 * Поиск через Tavily API (1000 бесплатных/мес).
 * Требует env TAVILY_API_KEY.
 */
async function kroTavilySearch(query) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const r = await axios.post(
      'https://api.tavily.com/search',
      { query: q, max_results: 5, search_depth: 'basic' },
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        timeout: 10000,
      },
    );
    const items = Array.isArray(r.data?.results) ? r.data.results : [];
    return items
      .slice(0, 5)
      .map((item) => ({
        title: String(item.title || '').trim(),
        link: String(item.url || '').trim(),
        snippet: String(item.content || '').trim().slice(0, 300),
      }))
      .filter((x) => x.title || x.snippet);
  } catch {
    return [];
  }
}

/**
 * Поиск через Google Custom Search API (3000 бесплатных/мес).
 * Требует env GOOGLE_CSE_KEY + GOOGLE_CSE_ID.
 */
async function kroGoogleCseSearch(query) {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) return [];
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const r = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: { key, cx, q, num: 5 },
      timeout: 10000,
    });
    const items = Array.isArray(r.data?.items) ? r.data.items : [];
    return items
      .slice(0, 5)
      .map((item) => ({
        title: String(item.title || '').trim(),
        link: String(item.link || '').trim(),
        snippet: String(item.snippet || '').trim(),
      }))
      .filter((x) => x.title || x.snippet);
  } catch {
    return [];
  }
}

/**
 * Единая точка веб-поиска: Tavily → Google CSE → Serper.
 * Использует первый доступный ключ.
 */
async function kroUnifiedWebSearch(query) {
  if (process.env.TAVILY_API_KEY) {
    const r = await kroTavilySearch(query);
    if (r.length > 0) return r;
  }
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_ID) {
    const r = await kroGoogleCseSearch(query);
    if (r.length > 0) return r;
  }
  if (process.env.SERPER_API_KEY) {
    return await kroSerperWebSearch(query);
  }
  return [];
}

/**
 * Целевой поиск жалоб на канал в интернете.
 * Ищет скам/мошенник/жалобы по трём запросам на mmgp.ru, pikabu, общий поиск.
 * Работает для ЛЮБОГО канала. Возвращает до 6 дедуплицированных сниппетов.
 */
async function kroFetchChannelComplaintsFromWeb(channelKey, personName) {
  const hasAnySearch =
    process.env.TAVILY_API_KEY || process.env.GOOGLE_CSE_KEY || process.env.SERPER_API_KEY;
  if (!hasAnySearch || !channelKey) return [];
  const slug = String(channelKey).trim().replace(/^@/, '').replace(/^t\.me\//i, '');
  if (!slug) return [];

  const queries = [
    `"@${slug}" скам мошенник жалоба развод потерял деньги`,
    `"${slug}" отзывы мошенник криптовалюта telegram`,
    `${slug} site:mmgp.ru OR site:pikabu.ru OR site:otzovik.com`,
    `"@${slug}" обман кинул не выплатил`,
  ];

  // Если знаем имя/ник автора — ищем жалобы и по нему
  if (personName && typeof personName === 'string' && personName.length > 3
      && personName !== 'Аноним' && personName !== 'anonymous_hidden') {
    // берём первое слово — обычно никнейм или имя
    const cleanName = personName.replace(/\(.*?\)/g, '').trim().split(/[\s,]+/)[0];
    if (cleanName && cleanName.length > 3) {
      queries.push(`"${cleanName}" скам мошенник крипта telegram жалоба`);
      queries.push(`"${cleanName}" site:mmgp.ru OR site:pikabu.ru`);
    }
  }

  const seen = new Set();
  const allResults = [];
  for (const q of queries) {
    if (allResults.length >= 8) break;
    try {
      const r = await kroUnifiedWebSearch(q);
      for (const item of r) {
        const key = (item.link || item.title || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        // Помечаем: упоминает ли результат именно этот канал (не общая статья).
        // Требуем минимальную длину токена — иначе короткий/общий slug или имя
        // ложно «совпадёт» с любой генерической статьёй про скам в Telegram.
        const textLow = `${item.title || ''} ${item.snippet || ''}`.toLowerCase();
        const slugLow = slug.toLowerCase();
        const personFirst = personName
          ? String(personName).toLowerCase().split(/[\s,]+/)[0]
          : '';
        item._channel_specific = Boolean(
          (slugLow.length >= 4 && (textLow.includes(slugLow) || textLow.includes(`@${slugLow}`)))
          || (personFirst.length >= 4 && textLow.includes(personFirst)),
        );
        allResults.push(item);
        if (allResults.length >= 8) break;
      }
    } catch {
      // не блокируем — продолжаем со следующим запросом
    }
  }
  // Специфичные для канала — первыми; общие статьи — в конце
  allResults.sort((a, b) => (b._channel_specific ? 1 : 0) - (a._channel_specific ? 1 : 0));
  return allResults;
}

/**
 * История канала: получить сигналы из публичной ленты t.me/s.
 * Возвращает { slug, earliest_date_iso, latest_date_iso, early_sample, recent_sample, used_jump }
 * или null, если датированных постов не найдено — никогда не выдумывает данные.
 */
async function kroFetchChannelHistorySignals(channelKey, opts) {
  try {
    const slug = kroExtractTelegramPublicSlug(channelKey);
    if (!slug) return null;

    const optObj = opts && typeof opts === 'object' ? opts : {};
    const timeoutMs = optObj.timeoutMs || 12000;

    // Запрос 1: обычная лента (последние посты) — через kroFetchTelegramPublicSnapshot
    const recentSnapPromise = kroFetchTelegramPublicSnapshot(slug, {
      timeoutMs,
      logLabel: `hist-${slug}:recent`,
    });

    // Запрос 2: ?before=50 — пытаемся получить ранние посты.
    // kroExtractTelegramPublicSlug срезает query-params, поэтому делаем прямой fetch.
    const earlyFetchPromise = (async () => {
      const url = `https://t.me/s/${encodeURIComponent(slug)}?before=50`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetch(url, {
          signal: ctl.signal,
          headers: {
            'user-agent': 'Mozilla/5.0 (compatible; KRO-Analyze/1.0)',
            accept: 'text/html,application/xhtml+xml,text/plain',
          },
        });
        if (!r.ok) return null;
        const html = await r.text();
        return kroExtractDatedPostsFromPublicHtml(html, slug);
      } catch (e) {
        console.warn(`[KRO history] ?before=50 error: ${e && e.message ? String(e.message) : 'failed'}`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();

    const [recentSnap, earlyDatedPosts] = await Promise.all([recentSnapPromise, earlyFetchPromise]);

    const recentDated = recentSnap && Array.isArray(recentSnap.dated_posts) ? recentSnap.dated_posts : [];
    const earlyDated = Array.isArray(earlyDatedPosts) ? earlyDatedPosts : [];

    // Объединяем, дедуплицируем по url или date+text
    const allDated = [];
    const seenKeys = new Set();
    const addPosts = (posts) => {
      for (const p of posts) {
        if (!p.date_iso) continue;
        const k = p.url || `${p.date_iso}|${(p.text || '').slice(0, 60)}`;
        if (seenKeys.has(k)) continue;
        seenKeys.add(k);
        allDated.push(p);
      }
    };
    addPosts(recentDated);
    addPosts(earlyDated);

    if (!allDated.length) return null;

    // Сортируем: ранние → новые
    allDated.sort((a, b) => new Date(a.date_iso).getTime() - new Date(b.date_iso).getTime());

    const earliest_date_iso = allDated[0].date_iso;
    const latest_date_iso = allDated[allDated.length - 1].date_iso;

    // Валидация: не принимаем будущие или невалидные даты
    const earliestMs = new Date(earliest_date_iso).getTime();
    if (!Number.isFinite(earliestMs) || earliestMs > Date.now()) return null;

    // early_sample: до 5 самых старых постов с непустым текстом
    const earlyPosts = allDated.filter((p) => p.text && p.text.length >= 10).slice(0, 5);
    // recent_sample: до 5 самых новых постов с непустым текстом
    const recentPosts = allDated.filter((p) => p.text && p.text.length >= 10).slice(-5).reverse();

    // used_jump=true если ?before= вернул хотя бы один пост старше самого раннего из обычного запроса
    const recentEarliestMs = recentDated.length
      ? Math.min(...recentDated.filter((p) => p.date_iso).map((p) => new Date(p.date_iso).getTime()).filter(Number.isFinite))
      : Infinity;
    const used_jump = Number.isFinite(recentEarliestMs) && earliestMs < recentEarliestMs;

    console.log(`[KRO history] ${slug} earliest=${earliest_date_iso} total_dated=${allDated.length} used_jump=${used_jump}`);
    return {
      slug,
      earliest_date_iso,
      latest_date_iso,
      early_sample: earlyPosts.map((p) => p.text),
      recent_sample: recentPosts.map((p) => p.text),
      used_jump,
    };
  } catch (e) {
    console.warn(`[KRO history] fetch error: ${e && e.message ? String(e.message) : 'failed'}`);
    return null;
  }
}

/**
 * Смена темы канала: спрашивает Mistral, есть ли явная смена тематики между старыми и новыми постами.
 * Возвращает { shift_detected: true, explanation } только при явном "yes" с объяснением.
 * При любой неопределённости или ошибке — null. Никогда не выдумывает факты.
 */
async function kroDetectChannelTopicShift(channelDisplay, earlySample, recentSample) {
  if (!process.env.MISTRAL_API_KEY) return null;
  if (!Array.isArray(earlySample) || earlySample.length < 2) return null;
  if (!Array.isArray(recentSample) || recentSample.length < 2) return null;

  const earlyText = earlySample.slice(0, 4).map((t, i) => `[${i + 1}] ${String(t).slice(0, 200)}`).join('\n');
  const recentText = recentSample.slice(0, 4).map((t, i) => `[${i + 1}] ${String(t).slice(0, 200)}`).join('\n');

  const prompt = `Ты аналитик безопасности. Проверь, изменилась ли тематика Telegram-канала «${channelDisplay}» между старыми и новыми постами.

СТАРЫЕ ПОСТЫ (ранние):
${earlyText}

НОВЫЕ ПОСТЫ (последние):
${recentText}

Ответь ТОЛЬКО в формате JSON (без текста вне JSON):
{"shift_detected":"yes"|"no","explanation":"конкретное описание что изменилось, или пустая строка если нет смены"}

Правила:
- "yes" ТОЛЬКО если тематика явно и конкретно изменилась (например: ранние посты про путешествия, новые про крипто-сигналы).
- Если тематика одна и та же, или данных недостаточно для вывода — строго "no".
- explanation при "yes" должен объяснять ЧТО именно изменилось конкретными словами, без домыслов.
- Запрещено угадывать или предполагать без прямых доказательств из текстов выше.`;

  try {
    const r = await axios.post(
      'https://api.mistral.ai/v1/chat/completions',
      {
        model: 'mistral-medium-latest',
        max_tokens: 250,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
        },
        timeout: 12000,
      },
    );
    const raw = (r.data?.choices?.[0]?.message?.content || '').trim();
    // Извлекаем JSON из ответа (модель иногда оборачивает в ```json ... ```)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.shift_detected !== 'yes') return null;
    const explanation = String(parsed.explanation || '').trim();
    if (!explanation || explanation.length < 10) return null;
    console.log(`[KRO history shift] ${channelDisplay} shift=yes explanation=${explanation.slice(0, 80)}`);
    return { shift_detected: true, explanation };
  } catch (e) {
    console.warn(`[KRO history shift] error: ${e && e.message ? String(e.message) : 'failed'}`);
    return null;
  }
}

/**
 * Обогащает объект analysis данными истории канала (channel_history).
 * Вызывается из channel-profile и analyze-channel.
 * Мутирует analysis на месте; при отсутствии данных ничего не добавляет.
 */
async function kroEnrichAnalysisWithChannelHistory(analysis, channelKey, channelDisplay) {
  if (!channelKey || !analysis || typeof analysis !== 'object') return;
  try {
    const hist = await kroFetchChannelHistorySignals(channelKey);
    if (!hist || !hist.earliest_date_iso) return;

    let shift = null;
    if (hist.early_sample.length >= 2 && hist.recent_sample.length >= 2) {
      shift = await kroDetectChannelTopicShift(channelDisplay || channelKey, hist.early_sample, hist.recent_sample);
    }

    analysis.channel_history = {
      earliest_post_date: hist.earliest_date_iso,
      latest_post_date: hist.latest_date_iso || null,
      used_jump: hist.used_jump || false,
      shift_detected: !!(shift && shift.shift_detected),
      shift_explanation: (shift && shift.explanation) || null,
    };

    if (!Array.isArray(analysis.sources)) analysis.sources = [];
    if (!analysis.sources.includes('история постов t.me/s')) {
      analysis.sources = [...analysis.sources, 'история постов t.me/s'];
    }

    // Добавляем предупреждение про смену темы в ties_risk_factors (формат «Заголовок: пояснение»
    // совместим с kroHomeTiesLinesToTrustFlags)
    if (shift && shift.explanation) {
      const shiftLine = `Возможная смена тематики: ${shift.explanation}`;
      const existingTies = Array.isArray(analysis.ties_risk_factors) ? analysis.ties_risk_factors : [];
      analysis.ties_risk_factors = [shiftLine, ...existingTies].slice(0, 5);
    }

    console.log(`[KRO history] enriched ${channelKey} earliest=${hist.earliest_date_iso} shift=${analysis.channel_history.shift_detected}`);
  } catch (e) {
    console.warn(`[KRO history] enrich error: ${e && e.message ? String(e.message) : 'failed'}`);
  }
}

/** Два поисковых запроса для блока «Кто за каналом»; без ключа — пустая строка. */
async function kroFetchPersonBehindWebContext(channelName, username) {
  const hasAnySearch =
    process.env.TAVILY_API_KEY || process.env.GOOGLE_CSE_KEY || process.env.SERPER_API_KEY;
  if (!hasAnySearch) return '';
  const name = String(channelName || '').trim();
  const user = String(username || '').replace(/^@/, '').trim();
  const queries = [];
  if (name) {
    queries.push(`"${name}" site:reddit.com OR "отзывы" OR "скам" OR "мошенник"`);
  }
  if (user) {
    queries.push(`${user} telegram`);
  }
  if (!queries.length) return '';
  const parts = [];
  for (const q of queries) {
    const hits = await kroUnifiedWebSearch(q);
    const block = kroFormatSerperHits(`Запрос: ${q}`, hits);
    if (block) parts.push(block);
  }
  return parts.join('\n\n').slice(0, 2400);
}

const KRO_PERSON_BEHIND_ANONYMOUS_HIDDEN_VERDICT =
  'Автор намеренно скрывает личность. Ни имени, ни соцсетей, ни следа в интернете. Анонимность = невозможность проверить и привлечь к ответственности. Это главный красный флаг.';

/** Синхронизировано с разделом «СПИСОК МАНИПУЛЯТИВНЫХ СХЕМ» в СТРАТЕГИЯ_ИНСТРУМЕНТ_1.md */
const KRO_PERSON_BEHIND_MANIP_SCHEMES_PROMPT = `СПИСОК МАНИПУЛЯТИВНЫХ СХЕМ — проверь каждый пост против них. Для каждой найденной назови схему и приведи цитату.

СХЕМЫ РОСТА АУДИТОРИИ (подозрительные):
— «Реферальная ловушка»: бесплатный доступ только если приведёшь друга/зарегистрируешься по ссылке
— «Сеть каналов»: продвигает свои же другие каналы, создаёт иллюзию независимых источников
— «Социальное доказательство»: «уже 5000 учеников», «300 человек в VIP» без проверяемых данных
— «Закрытый клуб»: намекает что бесплатная часть — только витрина, настоящее только за деньги

СХЕМЫ МАНИПУЛЯЦИИ ДОВЕРИЕМ:
— «Ложный авторитет»: заявляет опыт/образование без доказательств («10 лет в трейдинге»)
— «Только плюсы»: публикует скрины прибыли, убытки не показывает или упоминает вскользь
— «Личное участие»: «я сам вошёл», «вместе с вами» — создаёт ощущение что рискует своими деньгами
— «Неверифицируемые результаты»: скрины без даты, без счёта, без объяснения риска

СХЕМЫ ДАВЛЕНИЯ:
— «FOMO»: срочность, «последний шанс», «завтра поздно», «все уже в деле»
— «Стадный эффект»: «остальные уже зарабатывают, только ты нет»
— «Зависимость»: «без меня потеряешь», «только я понимаю этот рынок»
— «Воронка продаж»: бесплатный контент → платный VIP → дорогой курс → личный коучинг`;

function kroCollectDuckDuckGoRelatedTexts(topics, out, limit) {
  if (!Array.isArray(topics) || out.length >= limit) return;
  for (const item of topics) {
    if (out.length >= limit) break;
    const row = item && typeof item === 'object' ? item : null;
    if (!row) continue;
    const text = String(row.Text || '').trim();
    if (text) out.push(text);
    if (Array.isArray(row.Topics)) kroCollectDuckDuckGoRelatedTexts(row.Topics, out, limit);
  }
}

/** DuckDuckGo Instant Answer API — быстрый контекст перед Mistral (таймаут 4 с). */
async function kroFetchDuckDuckGoPersonContext(channelName) {
  const name = String(channelName || '').trim();
  if (!name) return '';
  const q = `${name} telegram`;
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`;
    const r = await axios.get(url, { timeout: 4000 });
    const data = r.data && typeof r.data === 'object' ? r.data : {};
    const parts = [];
    const abstract = String(data.AbstractText || data.Abstract || '').trim();
    if (abstract) parts.push(abstract);
    const related = [];
    kroCollectDuckDuckGoRelatedTexts(data.RelatedTopics, related, 6);
    for (const line of related) parts.push(line);
    return parts.filter(Boolean).slice(0, 8).join('\n').slice(0, 1800);
  } catch {
    return '';
  }
}

function kroNormalizePersonBehindPostTexts(postTexts) {
  const raw = Array.isArray(postTexts) ? postTexts : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const t = String(item || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 8 || seen.has(t)) continue;
    seen.add(t);
    out.push(t.slice(0, 700));
    if (out.length >= 30) break;
  }
  return out;
}

/**
 * Честная статистика охвата: сколько постов реально прочитано и за какой период (по датам, если есть).
 * Никогда не выдумывает — если дат нет, просто считает посты.
 */
function kroComputePersonBehindCoverage(postTexts, datedPosts) {
  const postsAnalyzed = kroNormalizePersonBehindPostTexts(postTexts).length;
  const dated = Array.isArray(datedPosts) ? datedPosts : [];
  const times = dated
    .map((p) => (p && p.date_iso ? new Date(p.date_iso).getTime() : NaN))
    .filter((t) => Number.isFinite(t));
  let daysSpan = null;
  if (times.length >= 2) {
    const spanMs = Math.max(...times) - Math.min(...times);
    daysSpan = Math.max(1, Math.round(spanMs / 86400000));
  }
  let note = '';
  if (postsAnalyzed > 0) {
    note = daysSpan
      ? `Проверено ${postsAnalyzed} ${kroPluralPostsRu(postsAnalyzed)} за ${daysSpan} ${kroPluralDaysRu(daysSpan)}`
      : `Проверено ${postsAnalyzed} ${kroPluralPostsRu(postsAnalyzed)}`;
  }
  return { posts_analyzed: postsAnalyzed, days_span: daysSpan, coverage_note_ru: note };
}

function kroPluralPostsRu(n) {
  const v = Math.abs(n) % 100;
  const v1 = v % 10;
  if (v > 10 && v < 20) return 'постов';
  if (v1 === 1) return 'пост';
  if (v1 >= 2 && v1 <= 4) return 'поста';
  return 'постов';
}

function kroPluralDaysRu(n) {
  const v = Math.abs(n) % 100;
  const v1 = v % 10;
  if (v > 10 && v < 20) return 'дней';
  if (v1 === 1) return 'день';
  if (v1 >= 2 && v1 <= 4) return 'дня';
  return 'дней';
}

/**
 * Проверяет, что цитата реально встречается в текстах постов (анти-выдумка: никогда не показываем
 * как «настоящую» цитату то, чего нет в реальных данных).
 */
function kroVerifyQuoteInPosts(quote, posts) {
  const q = String(quote || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!q || q.length < 6) return false;
  const arr = Array.isArray(posts) ? posts : [];
  const needle = q.slice(0, 80);
  return arr.some((p) => String(p || '').replace(/\s+/g, ' ').trim().toLowerCase().includes(needle));
}

/**
 * Нормализует red_flags_list от Mistral в формат [{name, quote, why}]:
 * — цитату, которую не получилось найти в реальных постах, стираем (пункт остаётся, если есть why) —
 *   так фейковая цитата никогда не покажется пользователю как настоящая;
 * — без постов цитат не бывает по определению;
 * — если AI не дал объяснение (why) — ищем схему по названию в schemes.json и берём её victim_risk.
 * Это не выдумывает новые факты — только дополняет уже найденный AI пункт готовой формулировкой риска.
 */
function kroNormalizeRedFlagsList(rawList, posts) {
  const arr = Array.isArray(rawList) ? rawList : [];
  const hasPosts = Array.isArray(posts) && posts.length > 0;
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!name) continue;
    let quote = String(item.quote || '').trim();
    if (!hasPosts) {
      quote = '';
    } else if (quote && !kroVerifyQuoteInPosts(quote, posts)) {
      quote = '';
    }
    let why = String(item.why || '').trim();
    if (!why) {
      try {
        const matched = kroFindSchemeByName(name);
        if (matched && matched.victim_risk) why = matched.victim_risk;
      } catch { /* нет схемы — оставляем why пустым, не выдумываем */ }
    }
    out.push({ name, quote: quote.slice(0, 220), why: why.slice(0, 300) });
    if (out.length >= 8) break;
  }
  return out;
}

/** Строковый red_flags (обратная совместимость со старыми потребителями) из структурированного списка. */
function kroFormatRedFlagsListToString(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return 'Явных манипулятивных схем не найдено';
  return arr
    .slice(0, 8)
    .map((h) => `[${h.name}]${h.quote ? `: «${h.quote}»` : ''}`)
    .join('; ');
}

/**
 * Объединяет red_flags_list от AI с находками keyword-детектора (kro-schemes) без дублей по названию.
 * Keyword-хиты добавляют только то, чего AI не назвал, и только с реальными цитатами из постов.
 *
 * Страховка от пустого «Схем не найдено»: если после AI+keyword слоёв список всё ещё почти
 * пустой (<2 флага), но реальных постов достаточно (>=5) для статистических выводов —
 * добавляем kroDetectSoftPatternSignals: эвристики по всей ленте (только прибыль без единого
 * убытка, нет предупреждений о риске, высокая доля продающих постов). Это не выдумка: каждый
 * сигнал считается из реально полученных текстов, а где сигнал — это отсутствие чего-то,
 * quote оставляем пустым (отсутствие нельзя процитировать), но why объясняет, на чём вывод.
 */
function kroMergeRedFlagsListWithKeywordHits(aiList, postTexts) {
  const posts = kroNormalizePersonBehindPostTexts(postTexts);
  const normalizedAi = kroNormalizeRedFlagsList(aiList, posts);
  let kwHits = [];
  if (posts.length) {
    try {
      kwHits = kroDetectSchemesInTexts(posts);
    } catch {
      kwHits = [];
    }
  }
  const seenNames = new Set(normalizedAi.map((x) => x.name.toLowerCase()));
  const merged = normalizedAi.slice();
  for (const h of kwHits) {
    const nameLow = String(h.name || '').toLowerCase();
    if (!nameLow || seenNames.has(nameLow)) continue;
    seenNames.add(nameLow);
    merged.push({
      name: h.name,
      quote: h.quote ? String(h.quote).slice(0, 220) : '',
      why: h.victim_risk || '',
    });
    if (merged.length >= 8) break;
  }

  if (merged.length < 2 && posts.length >= 5) {
    let softHits = [];
    try {
      softHits = kroDetectSoftPatternSignals(posts);
    } catch {
      softHits = [];
    }
    for (const h of softHits) {
      const nameLow = String(h.name || '').toLowerCase();
      if (!nameLow || seenNames.has(nameLow)) continue;
      seenNames.add(nameLow);
      merged.push({
        name: h.name,
        quote: h.quote ? String(h.quote).slice(0, 220) : '',
        why: h.why || '',
      });
      if (merged.length >= 8) break;
    }
  }

  return merged;
}

function kroFormatPersonBehindPostsBlock(postTexts) {
  const posts = kroNormalizePersonBehindPostTexts(postTexts);
  if (!posts.length) return '';
  return `\nРеальные посты канала (последние):\n${posts.map((p, i) => `[пост ${i + 1}] ${p}`).join('\n')}\n`;
}

function kroNormalizePersonBehindDataConfidence(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return '';
}

/** high — посты + соцсети; medium — в основном описание; low — только DDG или почти ничего. */
function kroInferPersonBehindDataConfidence({ posts, links, desc, ddgHasContent }) {
  const hasPosts = Array.isArray(posts) && posts.length > 0;
  const hasLinks = Array.isArray(links) && links.length > 0;
  const hasDesc = String(desc || '').trim().length >= 50;
  if (hasPosts && hasLinks) return 'high';
  if (hasDesc && !hasPosts && !hasLinks) return 'medium';
  if (ddgHasContent && !hasPosts && !hasLinks && !hasDesc) return 'low';
  if (hasDesc) return 'medium';
  return 'low';
}

async function kroAnalyzePersonBehind(channelName, description, socialLinks, username, postTexts) {
  const desc = String(description || '').trim();
  const links = Array.isArray(socialLinks) ? socialLinks : [];
  const posts = kroNormalizePersonBehindPostTexts(postTexts);
  const ddgContext = await kroFetchDuckDuckGoPersonContext(channelName);
  const ddgHasContent = ddgContext.length > 0;

  if (!ddgHasContent && links.length === 0 && desc.length < 50 && posts.length === 0) {
    return {
      who: 'anonymous_hidden',
      verdict:
        'Опасно — автор намеренно скрывает личность. Ни имени, ни соцсетей, ни следа в интернете — проверить и привлечь к ответственности невозможно.',
      reveal_moment:
        'Анонимность — не «загадка гуру», а способ исчезнуть с твоими деньгами, когда что-то пойдёт не так.',
      next_action: 'Не плати VIP и не переводи деньги, пока не знаешь кто стоит за каналом.',
      data_confidence: 'low',
      red_flags_list: [],
    };
  }

  const key = process.env.MISTRAL_API_KEY;
  if (!key || (!desc && !ddgHasContent && links.length === 0 && posts.length === 0)) return null;
  const socialStr = links.map((l) => `${l.label}: ${l.url}`).join(', ') || 'не найдено';
  const webContext = await kroFetchPersonBehindWebContext(channelName, username);
  const ddgBlock = ddgHasContent
    ? `\nНайдено в интернете: ${ddgContext}`
    : '';
  const webBlock = webContext
    ? `\nВеб-поиск (Serper, только как контекст — не выдумывай факты сверх сниппетов):\n${webContext}\nУчти результаты веб-поиска только если они явно про этот канал; иначе игнорируй.`
    : '';
  const postsBlock = kroFormatPersonBehindPostsBlock(posts);
  const prompt = `Отвечай как умный друг который уже посмотрел канал. Прямо, без отмазок. Твоя задача — дать человеку решение, не отчёт.

Ты аналитик крипто-каналов. Разбери кто стоит за каналом по описанию, соцсетям и реальным постам.
Канал: ${channelName}
Описание: ${desc.slice(0, 600) || 'не указано'}
Соцсети: ${socialStr}${ddgBlock}${webBlock}${postsBlock}
${KRO_PERSON_BEHIND_MANIP_SCHEMES_PROMPT}

В поле red_flags_list перечисли найденные схемы как массив объектов:
{"name":"точное название схемы из списка выше","quote":"точная цитата из поста — скопируй буквально, не перефразируй","why":"1 короткое предложение конкретно ПОЧЕМУ это рискует читателю деньгами или доверием"}
Каждая найденная схема — отдельный объект. Поле why ОБЯЗАТЕЛЬНО для каждого флага — без него флаг бесполезен.
Если схем нет — верни пустой массив: "red_flags_list":[].
Без постов цитату не пиши — оставь quote пустой строкой "", но если схема видна по описанию/соцсетям — всё равно укажи name и why.
Не выдумывай цитаты: если не уверен, что текст реально есть в посте — оставь quote пустым, а не приблизительным пересказом.

⚠️ ГЛАВНОЕ ПРАВИЛО: Пиши ТОЛЬКО то, что реально нашёл в постах и описании. Не выдумывай. Не предполагай. Если VIP, курсы, платный контент не упоминались в тексте — НЕ ПИШИ о них нигде: ни в verdict, ни в reveal_moment, ни в next_action, ни в business_model. Ошибка хуже чем «не знаю» — ложная информация уничтожает доверие.

verdict — начинается с решения («Не плати», «Уйди», «Смотри бесплатно», «Опасно» или похожее), затем 1-2 предложения ТОЛЬКО на основе найденных фактов. Если нет доказательств платного контента — не упоминай его. Если нет схем манипуляций — не придумывай. Пиши что реально нашёл.
reveal_moment — скрытая механика которую человек не видит сам, ТОЛЬКО если реально нашёл её в постах. Если не нашёл — пиши пустую строку "". Пример когда есть: «Их настоящий заработок — твой переход в Bybit. Ты продукт, не клиент.»
next_action — конкретное действие ТОЛЬКО на основе реальных фактов. Если VIP/курсы не упоминались — не пиши «не плати VIP». Пример без VIP: «Проверяй сигналы на малых суммах, не копируй вслепую». Пример с VIP: «Смотри бесплатно, не плати за закрытый канал».
business_model — что реально найдено в постах: «реклама», «партнёрские ссылки», «VIP-канал» (только если упоминается), «курсы» (только если упоминаются), «публичный контент без монетизации». НЕ угадывай.

Ответь ТОЛЬКО JSON без markdown:
{"who":"имя/псевдоним или Аноним","claimed_background":"заявленный опыт/образование или Не упоминается","claimed_path":"путь в крипте или Не упоминается","business_model":"что реально найдено: реклама / партнёрские ссылки / VIP (если есть) / курсы (если есть) / публичный контент без продаж","red_flags_list":[{"name":"...","quote":"...","why":"..."}],"verdict":"решение первым словом + объяснение","reveal_moment":"одна фраза — скрытая механика","next_action":"конкретное действие ТОЛЬКО на основе реальных фактов из постов","data_confidence":"high/medium/low — насколько уверен анализ: high если были посты + соцсети, medium если только описание, low если только DDG или ничего"}`;
  try {
    const r = await axios.post(
      'https://api.mistral.ai/v1/chat/completions',
      {
        model: 'mistral-medium-latest',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1700,
      },
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        timeout: 20000,
      },
    );
    const text = r.data?.choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const inferred = kroInferPersonBehindDataConfidence({
      posts,
      links,
      desc,
      ddgHasContent,
    });
    parsed.data_confidence = kroNormalizePersonBehindDataConfidence(parsed.data_confidence) || inferred;
    parsed.red_flags_list = kroMergeRedFlagsListWithKeywordHits(parsed.red_flags_list, posts);
    parsed.red_flags = kroFormatRedFlagsListToString(parsed.red_flags_list);
    // Второй поиск по найденному имени/нику — показываем что нашли в интернете
    const whoFound = String(parsed.who || '').trim();
    if (whoFound && whoFound !== 'Аноним' && whoFound !== 'anonymous_hidden' && whoFound.length > 3) {
      try {
        const webEvidence = await kroSearchByPersonName(whoFound);
        if (webEvidence.length) {
          parsed.web_evidence = webEvidence;
        }
      } catch { /* не блокируем основной ответ */ }
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Собирает person_behind из HTML публичной страницы t.me (snap.html) + тексты постов из ленты. */
async function kroBuildPersonBehindFromPublicSnapshot(channelDisplay, channelForOnce, deadline, analyzeLogId, postTexts) {
  const slug = kroExtractTelegramPublicSlug(channelForOnce);
  if (!slug || deadline - Date.now() < 1500) return null;
  const snap = await kroFetchTelegramPublicSnapshot(channelForOnce, {
    timeoutMs: Math.min(14000, Math.max(3000, deadline - Date.now() - 600)),
    logLabel: `${analyzeLogId}:person_behind`,
  });
  if (!snap || !snap.html) return null;
  const desc = kroExtractPublicChannelDescriptionFromHtml(snap.html);
  const socialLinks = kroExtractSocialLinksFromHtml(snap.html);
  // Если вызвали с пустым postTexts (напр. v0→v1 апгрейд) — не теряем уже собранные снэпшотом посты.
  const hasPassedPosts = Array.isArray(postTexts) && postTexts.length > 0;
  const posts = kroNormalizePersonBehindPostTexts(hasPassedPosts ? postTexts : snap.snippets);
  const aiProfile = await kroAnalyzePersonBehind(channelDisplay, desc || '', socialLinks, slug, posts);
  if (!aiProfile && !socialLinks.length && !desc && !posts.length) return null;
  const dataConfidence = kroNormalizePersonBehindDataConfidence(aiProfile && aiProfile.data_confidence)
    || kroInferPersonBehindDataConfidence({
      posts,
      links: socialLinks,
      desc,
      ddgHasContent: false,
    });
  const coverage = kroComputePersonBehindCoverage(posts, snap.dated_posts);
  const fallbackRedFlagsList = aiProfile ? [] : kroMergeRedFlagsListWithKeywordHits([], posts);
  return {
    ...(aiProfile || {
      who: 'Аноним',
      claimed_background: 'Не упоминается',
      claimed_path: 'Не упоминается',
      business_model: '',
      red_flags: kroFormatRedFlagsListToString(fallbackRedFlagsList),
      red_flags_list: fallbackRedFlagsList,
      verdict: desc ? desc.slice(0, 220) : '',
      reveal_moment: '',
      next_action: '',
      web_evidence: [],
      data_confidence: dataConfidence,
    }),
    data_confidence: dataConfidence,
    social_links: socialLinks,
    description: desc || '',
    posts_analyzed: coverage.posts_analyzed,
    days_span: coverage.days_span,
    coverage_note_ru: coverage.coverage_note_ru,
  };
}

async function kroFetchPersonBehindForAnalyzeChannel(opts) {
  const {
    pubSlugBootstrap,
    channelDisplay,
    channelForOnce,
    deadline,
    analyzeLogId,
    postTexts,
  } = opts || {};
  if (!pubSlugBootstrap) return null;
  try {
    const personBehind = await kroBuildPersonBehindFromPublicSnapshot(
      channelDisplay,
      channelForOnce,
      deadline,
      analyzeLogId,
      postTexts,
    );
    if (personBehind) {
      const postsN = kroNormalizePersonBehindPostTexts(postTexts).length;
      console.log(
        `[KRO analyze-channel ${analyzeLogId}] person_behind ok posts=${postsN} links=${(personBehind.social_links || []).length} verdict=${String(personBehind.verdict || '').slice(0, 80)}`,
      );
    }
    return personBehind;
  } catch (ePb) {
    console.warn(
      `[KRO analyze-channel ${analyzeLogId}] person_behind error=${ePb && ePb.message ? String(ePb.message) : 'failed'}`,
    );
    return null;
  }
}

/** Кэш цен CoinGecko: ключ coinId:dd-mm-yyyy → USD. */
const kroCoinGeckoPriceCache = new Map();

const KRO_SIGNAL_SYMBOL_TO_COINGECKO = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  DOT: 'polkadot',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  LINK: 'chainlink',
  LTC: 'litecoin',
  TRX: 'tron',
  SHIB: 'shiba-inu',
  TON: 'the-open-network',
  ATOM: 'cosmos',
  NEAR: 'near',
  APT: 'aptos',
  ARB: 'arbitrum',
  OP: 'optimism',
  USDT: 'tether',
  USDC: 'usd-coin',
};

const KRO_SIGNAL_KNOWN_SYMBOLS = Object.keys(KRO_SIGNAL_SYMBOL_TO_COINGECKO);

function kroSymbolToCoinGeckoId(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  return KRO_SIGNAL_SYMBOL_TO_COINGECKO[s] || null;
}

function kroParseSignalPriceNumber(raw) {
  const s = String(raw || '').trim().replace(/\s/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function kroParseTradingSignalsFromText(text) {
  const src = String(text || '').trim();
  if (src.length < 8) return [];
  const symAlt = KRO_SIGNAL_KNOWN_SYMBOLS.join('|');
  const out = [];
  const seen = new Set();
  const push = (sig) => {
    const key = `${sig.symbol}|${sig.side}|${sig.entry || ''}|${sig.target || ''}|${sig.snippet.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(sig);
  };

  const reSignalLine = new RegExp(
    `(?:сигнал|signal)\\s*[:\\-]?\\s*(${symAlt})[^\\d]{0,50}?(?:вход|entry)\\s*([\\d.,]+)(?:[^\\d]{0,80}?(?:цель|target|tp|тейк)\\s*([\\d.,]+))?`,
    'gi',
  );
  let m;
  while ((m = reSignalLine.exec(src)) !== null) {
    push({
      symbol: m[1].toUpperCase(),
      side: 'long',
      entry: kroParseSignalPriceNumber(m[2]),
      target: kroParseSignalPriceNumber(m[3]),
      snippet: src.length > 180 ? `${src.slice(0, 177)}…` : src,
    });
  }

  const reBuy = new RegExp(
    `(?:купил[аи]?|покупаю|buy(?:ing)?)\\s+(${symAlt})(?:[^\\d]{0,40}?(?:по|@|at)\\s*([\\d.,]+))?`,
    'gi',
  );
  while ((m = reBuy.exec(src)) !== null) {
    push({
      symbol: m[1].toUpperCase(),
      side: 'long',
      entry: kroParseSignalPriceNumber(m[2]),
      target: null,
      snippet: src.length > 180 ? `${src.slice(0, 177)}…` : src,
    });
  }

  const reEnter = new RegExp(
    `(?:вош[ёе]л[аи]?|заш[её]л[аи]?|entered|открыл[аи]?)\\s+(?:в\\s+)?(лонг|long|шорт|short)\\s+(${symAlt})(?:[^\\d]{0,40}?(?:по|@|вход|entry)\\s*([\\d.,]+))?`,
    'gi',
  );
  while ((m = reEnter.exec(src)) !== null) {
    const sideWord = String(m[1] || '').toLowerCase();
    push({
      symbol: m[2].toUpperCase(),
      side: sideWord.includes('шорт') || sideWord === 'short' ? 'short' : 'long',
      entry: kroParseSignalPriceNumber(m[3]),
      target: null,
      snippet: src.length > 180 ? `${src.slice(0, 177)}…` : src,
    });
  }

  const reSide = new RegExp(
    `(?:лонг|long|шорт|short)\\s+(${symAlt})(?:[^\\d]{0,40}?(?:по|@|вход|entry)\\s*([\\d.,]+))?(?:[^\\d]{0,60}?(?:цель|target|tp)\\s*([\\d.,]+))?`,
    'gi',
  );
  while ((m = reSide.exec(src)) !== null) {
    const sideWord = m[0].slice(0, 12).toLowerCase();
    push({
      symbol: m[1].toUpperCase(),
      side: sideWord.includes('шорт') || sideWord.includes('short') ? 'short' : 'long',
      entry: kroParseSignalPriceNumber(m[2]),
      target: kroParseSignalPriceNumber(m[3]),
      snippet: src.length > 180 ? `${src.slice(0, 177)}…` : src,
    });
  }

  return out.filter((x) => x.symbol && kroSymbolToCoinGeckoId(x.symbol));
}

function kroExtractDatedPostsFromPublicHtml(html, slug) {
  if (!html || html.length < 100) return [];
  const blocks = html.split('tgme_widget_message').slice(1);
  const posts = [];
  for (const block of blocks) {
    const dp = block.match(/data-post="([^"]+)"/i);
    const textM = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i);
    if (!textM) continue;
    const dtMatches = [...block.matchAll(/datetime="([^"]+)"/g)];
    const lastDt = dtMatches.length ? dtMatches[dtMatches.length - 1][1] : null;
    const text = kroStripHtmlToText(textM[1]).replace(/\s+/g, ' ').trim();
    const norm = kroNormalizePublicSnapshotLine(text, slug);
    if (!norm || norm.length < 12) continue;
    let date_iso = null;
    if (lastDt) {
      try {
        const d = new Date(lastDt.replace(/\+00:00$/, 'Z'));
        if (!Number.isNaN(d.getTime())) date_iso = d.toISOString();
      } catch {
        /* ignore */
      }
    }
    let url = null;
    if (dp && dp[1]) {
      const postRef = String(dp[1]).trim();
      if (/^[a-zA-Z0-9_]+\/\d+$/.test(postRef)) url = `https://t.me/${postRef}`;
    }
    if (!url) {
      const hrefM = block.match(/tgme_widget_message_date[^>]*href="(https?:\/\/t\.me\/[^"]+)"/i);
      if (hrefM && hrefM[1]) url = hrefM[1].split('?')[0];
    }
    posts.push({
      text: norm.length > 220 ? `${norm.slice(0, 217)}…` : norm,
      date_iso,
      url,
    });
  }
  const seen = new Set();
  return posts.filter((p) => {
    const k = `${p.date_iso || ''}|${p.text.slice(0, 120)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 120);
}

function kroNormalizeDatedPostsInput(parsedForFast, sampleForFast) {
  const dated = Array.isArray(parsedForFast && parsedForFast.sample_posts_dated)
    ? parsedForFast.sample_posts_dated
    : [];
  const out = [];
  const seen = new Set();
  for (const row of dated) {
    const text = String((row && row.text) || '').trim();
    const date_iso = row && row.date_iso ? String(row.date_iso).trim() : null;
    const url = row && row.url ? String(row.url).trim() : null;
    if (!text || text.length < 8) continue;
    const k = `${date_iso || ''}|${text.slice(0, 100)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ text, date_iso: date_iso || null, url: url || null });
  }
  if (out.length) return out;
  if (Array.isArray(sampleForFast)) {
    for (const raw of sampleForFast) {
      const text = String(raw || '').trim();
      if (text.length < 8) continue;
      const k = text.slice(0, 100);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ text, date_iso: null, url: null });
    }
  }
  return out;
}

function kroCoinGeckoDateParam(isoOrDate) {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function kroAddDaysIso(isoOrDate, days) {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

async function kroFetchCoinGeckoHistoryPriceUsd(coinId, dateParam) {
  const cacheKey = `${coinId}:${dateParam}`;
  if (kroCoinGeckoPriceCache.has(cacheKey)) {
    return kroCoinGeckoPriceCache.get(cacheKey);
  }
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/history?date=${encodeURIComponent(dateParam)}&localization=false`;
  try {
    const r = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'KRO-SignalAccuracy/1.0' },
    });
    if (!r.ok) {
      kroCoinGeckoPriceCache.set(cacheKey, null);
      return null;
    }
    const j = await r.json();
    const usd = j && j.market_data && j.market_data.current_price && j.market_data.current_price.usd;
    const price = Number(usd);
    const val = Number.isFinite(price) && price > 0 ? price : null;
    kroCoinGeckoPriceCache.set(cacheKey, val);
    return val;
  } catch {
    kroCoinGeckoPriceCache.set(cacheKey, null);
    return null;
  }
}

function kroEvaluateSignalOutcome(sig, priceAt, priceAfter7d) {
  if (!Number.isFinite(priceAt) || !Number.isFinite(priceAfter7d)) return 'inconclusive';
  const side = sig.side === 'short' ? 'short' : 'long';
  const entry = Number.isFinite(sig.entry) ? sig.entry : priceAt;
  const target = Number.isFinite(sig.target) ? sig.target : null;
  if (side === 'long') {
    if (target != null && priceAfter7d >= target) return 'hit';
    if (target != null && priceAfter7d < entry) return 'loss';
    if (target == null && priceAfter7d >= entry) return 'hit';
    if (target == null && priceAfter7d < entry) return 'loss';
    if (priceAfter7d >= entry) return 'hit';
    return 'loss';
  }
  if (target != null && priceAfter7d <= target) return 'hit';
  if (priceAfter7d > entry) return 'loss';
  if (priceAfter7d <= entry) return 'hit';
  return 'loss';
}

function kroDetectLossWarningsInPostTexts(postTexts) {
  const kws = [
    'убыт', 'минус', 'стоп', 'stop loss', 'stop-loss', 'слил', 'потер', 'loss',
    'убыток', 'просадк', 'закрыл в минус', 'не сработал', 'ошибся', 'ошиблись',
  ];
  const joined = (Array.isArray(postTexts) ? postTexts : []).join('\n').toLowerCase();
  return kws.some((kw) => joined.includes(kw));
}

function kroBuildSignalAccuracySummaryRu(hit, loss, total, inconclusive) {
  if (!total) return 'Явных торговых входов в постах не найдено.';
  const parts = [`Из ${total} сигналов: ${hit} сработали, ${loss} — убыток`];
  if (inconclusive > 0) parts.push(`${inconclusive} без проверки (нет даты или рано для +7 дней)`);
  return parts.join('; ') + '.';
}

async function kroBuildSignalAccuracy(datedPosts, parsedForFast, deadline) {
  const posts = Array.isArray(datedPosts) ? datedPosts : [];
  const postTexts = posts.map((p) => p.text).filter(Boolean);
  const warnsAboutLosses = kroDetectLossWarningsInPostTexts(postTexts);
  const onlyProfitsFlag = parsedForFast && parsedForFast.only_profits_flag === true;
  const onlyProfitsTone = onlyProfitsFlag || (!warnsAboutLosses && postTexts.some((t) => /профит|прибыл|\+[\d]|\bx\d\b|закрыл в плюс|take profit|tp hit/i.test(String(t))));

  const found = [];
  for (const post of posts) {
    const signals = kroParseTradingSignalsFromText(post.text);
    for (const sig of signals) {
      found.push({
        ...sig,
        post_date: post.date_iso || null,
      });
    }
  }

  const capped = found.slice(0, 8);
  const items = [];
  let hitCount = 0;
  let lossCount = 0;
  let inconclusiveCount = 0;
  let verifiedSignals = 0;

  for (const sig of capped) {
    const coinId = kroSymbolToCoinGeckoId(sig.symbol);
    let priceAt = null;
    let priceAfter7d = null;
    let outcome = 'inconclusive';

    if (coinId && sig.post_date) {
      const after7Iso = kroAddDaysIso(sig.post_date, 7);
      const nowMs = Date.now();
      const after7Ms = after7Iso ? new Date(after7Iso).getTime() : NaN;
      if (Number.isFinite(after7Ms) && after7Ms <= nowMs && deadline - Date.now() > 400) {
        const d0 = kroCoinGeckoDateParam(sig.post_date);
        const d7 = kroCoinGeckoDateParam(after7Iso);
        if (d0 && d7) {
          priceAt = await kroFetchCoinGeckoHistoryPriceUsd(coinId, d0);
          await new Promise((r) => setTimeout(r, 320));
          if (deadline - Date.now() > 200) {
            priceAfter7d = await kroFetchCoinGeckoHistoryPriceUsd(coinId, d7);
          }
          if (Number.isFinite(priceAt) && Number.isFinite(priceAfter7d)) {
            outcome = kroEvaluateSignalOutcome(sig, priceAt, priceAfter7d);
            verifiedSignals += 1;
            if (outcome === 'hit') hitCount += 1;
            else if (outcome === 'loss') lossCount += 1;
            else inconclusiveCount += 1;
          } else {
            inconclusiveCount += 1;
          }
        } else {
          inconclusiveCount += 1;
        }
      } else {
        inconclusiveCount += 1;
      }
    } else {
      inconclusiveCount += 1;
    }

    items.push({
      symbol: sig.symbol,
      side: sig.side,
      entry: sig.entry,
      target: sig.target,
      post_date: sig.post_date,
      price_at_signal: priceAt,
      price_after_7d: priceAfter7d,
      outcome,
      snippet: sig.snippet,
    });
    if (deadline - Date.now() < 300) break;
  }

  const totalSignals = found.length;
  const summaryRu = kroBuildSignalAccuracySummaryRu(hitCount, lossCount, totalSignals, inconclusiveCount);
  let lossWarningRu = '';
  if (onlyProfitsTone && !warnsAboutLosses) {
    lossWarningRu = 'В ленте в основном плюсы — автор почти не показывает убыточные сделки.';
  } else if (warnsAboutLosses) {
    lossWarningRu = 'Автор иногда пишет об убытках и стопах — это честнее, чем «только профит».';
  } else if (totalSignals > 0) {
    lossWarningRu = 'Явных постов об убытках в выборке не видно.';
  }

  return {
    total_signals: totalSignals,
    verified_signals: verifiedSignals,
    hit_count: hitCount,
    loss_count: lossCount,
    inconclusive_count: inconclusiveCount,
    summary_ru: summaryRu,
    warns_about_losses: warnsAboutLosses,
    only_profits_tone: onlyProfitsTone,
    loss_warning_ru: lossWarningRu,
    items,
    data_source: 'coingecko',
  };
}

async function kroFetchSignalAccuracyForAnalyzeChannel(opts) {
  const {
    parsedForFast,
    sampleForFast,
    deadline,
    analyzeLogId,
    channelForOnce,
    pubSlugBootstrap,
  } = opts || {};
  if (deadline - Date.now() < 1800) return null;
  try {
    let datedPosts = kroNormalizeDatedPostsInput(parsedForFast, sampleForFast);
    const hasDates = datedPosts.some((p) => p.date_iso);
    if (!hasDates && pubSlugBootstrap && channelForOnce && deadline - Date.now() > 2500) {
      const snap = await kroFetchTelegramPublicSnapshot(channelForOnce, {
        timeoutMs: Math.min(12000, Math.max(3000, deadline - Date.now() - 800)),
        logLabel: `${analyzeLogId}:signal_accuracy`,
      });
      if (snap && Array.isArray(snap.dated_posts) && snap.dated_posts.length) {
        datedPosts = snap.dated_posts;
      }
    }
    const signalAccuracy = await kroBuildSignalAccuracy(datedPosts, parsedForFast, deadline);
    if (signalAccuracy && signalAccuracy.total_signals > 0) {
      console.log(
        `[KRO analyze-channel ${analyzeLogId}] signal_accuracy total=${signalAccuracy.total_signals} verified=${signalAccuracy.verified_signals} hit=${signalAccuracy.hit_count} loss=${signalAccuracy.loss_count}`,
      );
    }
    if (!signalAccuracy) return null;
    const show = signalAccuracy.total_signals > 0
      || signalAccuracy.warns_about_losses
      || signalAccuracy.only_profits_tone
      || (signalAccuracy.loss_warning_ru && String(signalAccuracy.loss_warning_ru).trim());
    return show ? signalAccuracy : null;
  } catch (eSa) {
    console.warn(
      `[KRO analyze-channel ${analyzeLogId}] signal_accuracy error=${eSa && eSa.message ? String(eSa.message) : 'failed'}`,
    );
    return null;
  }
}

/** Параллельно person_behind и signal_accuracy для ответа analyze-channel. */
async function kroFetchAnalyzeChannelGlanceExtras(opts) {
  const [personBehind, signalAccuracy] = await Promise.all([
    kroFetchPersonBehindForAnalyzeChannel(opts),
    kroFetchSignalAccuracyForAnalyzeChannel(opts),
  ]);
  return { personBehind, signalAccuracy };
}

function kroNormalizePublicSnapshotLine(text, slug) {
  let s = kroStripHtmlToText(text)
    .replace(/^\s*<title>\s*/i, '')
    .replace(/\s*<\/title>\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (kroIsGarbagePublicSnapshotLine(s)) return '';
  const low = s.toLowerCase();
  const slugLow = String(slug || '').toLowerCase();
  const boilerplate = [
    'telegram: view @',
    'view in telegram',
    'preview channel',
    'open a channel via telegram app',
    'send message',
    'join channel',
    'telegram apps are open',
    'if you have telegram',
  ];
  if (!s || s.length < 20) return '';
  if (boilerplate.some((x) => low.includes(x))) return '';
  if (slugLow && (low === `telegram: view @${slugLow}` || low === `@${slugLow}`)) return '';
  if (/^(telegram|view|preview)\b/i.test(s) && s.length < 80) return '';
  return s;
}

function kroFilterPublicSnapshotSnippets(lines, slug) {
  return (Array.isArray(lines) ? lines : [])
    .map((x) => kroNormalizePublicSnapshotLine(x, slug))
    .filter(Boolean)
    .filter((x, i, a) => a.indexOf(x) === i)
    .slice(0, 14)
    .map((x) => (x.length > 260 ? `${x.slice(0, 257)}...` : x));
}

function kroAssessPublicSnapshotTexts(texts) {
  const joined = (Array.isArray(texts) ? texts : []).join(' \n ').toLowerCase();
  const hasRiskManagement = [
    'риск-менедж',
    'risk management',
    'стоп',
    'стоп-лосс',
    'stop loss',
    'риск на сделку',
    'тейк',
    'take profit',
    'безубыт',
    'инвалидац',
    'risk/reward',
  ].some((kw) => joined.includes(kw));
  const hasEducation = [
    'разбор',
    'обзор',
    'сценар',
    'почему',
    'логик',
    'контекст',
    'уровн',
    'структур',
    'тезис',
    'сетап',
  ].some((kw) => joined.includes(kw));
  const hasDisclaimer = [
    'не финансов',
    'не является инвестиционной рекомендацией',
    'dyor',
    'nfa',
    'not financial advice',
  ].some((kw) => joined.includes(kw));
  const positives = [];
  const cautions = [];
  const reasons = [];
  if (hasRiskManagement) {
    positives.push('В тексте есть стопы, риск на сделку или условия отмены идеи.');
    reasons.push('Есть элементы риск-менеджмента, а не только призыв «заходить».');
  } else {
    cautions.push('Не видно явных правил риска: стоп, доля на сделку, когда идея считается ошибочной.');
  }
  if (hasEducation) {
    positives.push('Посты больше похожи на разборы и объяснения, чем на короткие сигналы.');
    reasons.push('Заметны объяснения логики, а не только результат.');
  } else {
    cautions.push('Мало объяснений, зачем именно такой вход или сценарий.');
  }
  if (hasDisclaimer) {
    positives.push('Есть оговорки про риск или что это не инвестсовет — само по себе не гарантия качества, но тон мягче.');
  }
  return { positives, cautions, reasons, hasRiskManagement, hasEducation, hasDisclaimer };
}

function kroBuildFastChannelTopicSummary(texts) {
  const joined = (Array.isArray(texts) ? texts : []).join(' \n ').toLowerCase();
  const educationHits = ['разбор', 'обзор', 'сценар', 'почему', 'логик', 'контекст', 'уровн', 'структур', 'тезис', 'сетап']
    .filter((kw) => joined.includes(kw)).length;
  const signalHits = ['сигнал', 'лонг', 'шорт', 'вход', 'тейк', 'стоп', 'buy', 'sell']
    .filter((kw) => joined.includes(kw)).length;
  const promoHits = ['vip', 'вип', 'подписк', 'доступ', 'ссылка', 'реферал', 'реклама', 'биржа', 'регистр']
    .filter((kw) => joined.includes(kw)).length;
  if (educationHits >= signalHits && educationHits >= promoHits && educationHits > 0) {
    return 'Похоже на канал с разборами рынка и объяснением идей, а не только с короткими командами.';
  }
  if (signalHits > educationHits && signalHits >= promoHits && signalHits > 0) {
    return 'Похоже на канал, который в основном публикует торговые идеи, точки входа и сопровождение сделок.';
  }
  if (promoHits > 0 && promoHits >= signalHits && promoHits >= educationHits) {
    return 'Похоже на канал с заметной коммерческой подачей: продвижением услуг, доступов или внешних ссылок.';
  }
  return 'По этой выборке канал без одного ярко выраженного формата — в основном короткие комментарии.';
}

function kroPickFastCitations(texts, buckets, limit = 3) {
  const src = Array.isArray(texts) ? texts.map((x) => String(x || '').trim()).filter((x) => x.length >= 24) : [];
  const out = [];
  const seen = new Set();
  const addByKeywords = (keywords) => {
    for (const t of src) {
      const low = t.toLowerCase();
      if (!keywords.some((kw) => low.includes(kw))) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= limit) return true;
    }
    return false;
  };
  for (const kws of buckets || []) {
    if (addByKeywords(kws)) break;
  }
  if (out.length < limit) {
    for (const t of src) {
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= limit) break;
    }
  }
  return out.slice(0, limit);
}

function kroBuildFastCriteriaFromTexts(texts, opts = null) {
  const rawTexts = Array.isArray(texts) ? texts.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const joined = rawTexts.join(' \n ').toLowerCase();
  const meta = opts && typeof opts === 'object' ? opts : {};
  const assess = kroAssessPublicSnapshotTexts(rawTexts);
  const firstMatch = (kws) => rawTexts.find((t) => kws.some((kw) => t.toLowerCase().includes(kw))) || '';

  const vipKeywords = ['vip', 'вип', 'платн', 'подписк', 'доступ', 'закрыт'];
  const fomoKeywords = ['100%', 'без риска', 'гарант', 'точно заработа', 'срочно', 'успей', 'последний шанс', 'x2', 'x5', 'x10', 'икс', 'памп'];
  const promoKeywords = ['реклама', 'партнер', 'партнёр', 'ссылка', 'регистрац', 'реферал', 'биржа', 'обменник', 'доступ в канал'];

  const hasVip = vipKeywords.some((kw) => joined.includes(kw));
  const hasFomo = fomoKeywords.some((kw) => joined.includes(kw)) || Number(meta.fomoPct || 0) >= 20;
  const hasRiskManagement = !!assess.hasRiskManagement;
  const hasLogic = !!assess.hasEducation;
  const adsRatio = Number(meta.adsRatio);
  const hasAdsWords = promoKeywords.some((kw) => joined.includes(kw));
  const adsState = Number.isFinite(adsRatio)
    ? (adsRatio >= 40 ? 'high' : adsRatio >= 15 ? 'partial' : 'low')
    : (hasAdsWords ? 'partial' : 'low');
  const hasSignals = meta.hasSignalOffer === true || ['сигнал', 'вход', 'лонг', 'шорт', 'buy', 'sell'].some((kw) => joined.includes(kw));
  const onlyProfits = meta.onlyProfitsFlag === true;

  /** @type {Array<{key:string,label:string,status:'yes'|'no'|'partial', explanation:string}>} */
  const criteria = [];
  criteria.push({
    key: 'vip',
    label: 'Платный доступ и сигналы',
    status: hasVip ? 'yes' : 'no',
    explanation: hasVip
      ? `Заметны платный формат или закрытый клуб. Фрагмент: «${firstMatch(vipKeywords).slice(0, 150)}${firstMatch(vipKeywords).length > 150 ? '…' : ''}».`
      : 'В этой выборке не видно призывов купить VIP, подписку или закрытый доступ.',
  });
  criteria.push({
    key: 'fomo',
    label: 'Давление и обещания прибыли',
    status: hasFomo ? 'yes' : 'no',
    explanation: hasFomo
      ? `Есть нажим или обещания результата. Пример: «${firstMatch(fomoKeywords).slice(0, 150)}${firstMatch(fomoKeywords).length > 150 ? '…' : ''}».`
      : 'Нет явных «гарантий прибыли», жёсткого нажима и обещаний «икс» без объяснений.',
  });
  criteria.push({
    key: 'risk',
    label: 'Про риск в постах',
    status: hasRiskManagement ? 'yes' : 'no',
    explanation: hasRiskManagement
      ? 'Встречаются стопы, риск на сделку, тейк или условия отмены идеи.'
      : 'Почти не видно правил риска: стопы, доля на сделку, когда идея считается ошибочной.',
  });
  criteria.push({
    key: 'logic',
    label: 'Объясняют ли смысл',
    status: hasLogic ? 'yes' : 'partial',
    explanation: hasLogic
      ? 'Автор не только даёт тезис, но и объясняет логику или сценарий.'
      : 'Мало объяснений, почему именно такой сценарий; больше коротких фраз.',
  });
  criteria.push({
    key: 'ads',
    label: 'Реклама и ссылки',
    status: adsState === 'high' ? 'yes' : adsState === 'partial' ? 'partial' : 'no',
    explanation: adsState === 'high'
      ? `Заметна реклама, ссылки или продажа доступа${Number.isFinite(adsRatio) ? ` (ориентир ~${adsRatio}% выборки)` : ''}.`
      : adsState === 'partial'
        ? `Реклама и ссылки есть, но не на каждом шагу${Number.isFinite(adsRatio) ? ` (~${adsRatio}% выборки)` : ''}.`
        : 'Реклама и продажа доступа не выглядят главной темой этой выборки.',
  });

  let score10 = 3;
  if (hasVip) score10 += 2;
  if (hasFomo) score10 += 2;
  if (!hasRiskManagement) score10 += 1;
  if (!hasLogic) score10 += 1;
  if (adsState === 'high') score10 += 1;
  else if (adsState === 'partial') score10 += 1;
  if (onlyProfits && (hasVip || hasFomo)) score10 += 1;
  if (hasRiskManagement) score10 -= 1;
  if (hasLogic) score10 -= 1;
  score10 = Math.max(1, Math.min(10, score10));
  let channelType = 'в выборке разные сигналы — смотрим по пунктам ниже';
  if (score10 >= 8) channelType = 'по тексту много тревожного';
  else if (hasVip && hasFomo) channelType = 'заметны платный доступ и нажим';
  else if (hasLogic && hasRiskManagement && !hasVip && adsState === 'low' && score10 <= 4) {
    channelType = 'больше разборов, меньше навязчивой продажи';
  } else if (hasRiskManagement && !hasFomo && score10 <= 4) {
    channelType = 'есть правила риска, мало агрессии в подаче';
  }

  const summaryMain =
    score10 >= 8
      ? 'По этим постам насторожительно: давление, платный доступ или слабо проговорён риск.'
      : score10 >= 5
        ? 'Есть и полезное, и резкие формулировки или слабое объяснение риска — не спешите с деньгами.'
        : 'По этой выборке спокойнее: мало «гарантий» и грубого нажима.';
  const summaryTail = !hasRiskManagement
    ? 'Правила риска в тексте почти не видны — повторять сделки вслепую опасно.'
    : hasAdsWords || adsState !== 'low'
      ? 'Реклама или партнёрки есть — это часто нормально, смотрите, нет ли обещаний лёгких денег.'
      : 'Навязчивой рекламы в этой выборке мало.';

  return {
    criteria,
    score10,
    channelType,
    summaryLine: `${summaryMain} ${summaryTail}`.trim(),
    topicLine: kroBuildFastChannelTopicSummary(rawTexts),
    citations: kroPickFastCitations(
      rawTexts,
      [vipKeywords, fomoKeywords, ['стоп', 'риск', 'stop', 'sl'], ['почему', 'логика', 'сценар', 'обосн']],
      3,
    ),
    reasons: [
      summaryMain,
      hasRiskManagement
        ? 'В тексте есть хотя бы намёки на риск-менеджмент.'
        : 'Явных ограничителей риска не видно — копировать сделки без своей проверки рискованно.',
      hasLogic
        ? 'Автор местами объясняет логику, а не только даёт команды.'
        : 'Мало объяснений — доверять каждому тезису «как есть» не стоит.',
    ].filter(Boolean),
  };
}

function kroFormatFastCriteriaLines(criteria) {
  const word = (status) => {
    if (status === 'yes') return 'да';
    if (status === 'partial') return 'частично';
    return 'нет';
  };
  return (Array.isArray(criteria) ? criteria : []).map((item) => {
    const it = item && typeof item === 'object' ? item : {};
    const lab = it.label || 'Пункт';
    const exp = String(it.explanation || '').trim();
    return exp ? `${lab} — ${word(it.status)}. ${exp}` : `${lab} — ${word(it.status)}.`;
  });
}

function kroMapFastRisk10ToConclusion(score10, opts = null) {
  const n = Number(score10);
  const meta = opts && typeof opts === 'object' ? opts : {};
  if (meta.forceScam === true || n >= 9) return KRO_V0_STATUS.scam;
  if (n >= 5) return KRO_V0_STATUS.risk;
  return KRO_V0_STATUS.clean;
}

function kroMapFastRisk10ToUiStatus(score10) {
  const n = Number(score10);
  if (!Number.isFinite(n)) return { status: 'Оценка не готова', code: 'UNAVAILABLE' };
  if (n >= 9) return { status: 'Много тревожного в формулировках', code: 'DANGER' };
  if (n >= 5) return { status: 'Есть поводы насторожиться', code: 'SUSPICIOUS' };
  return { status: 'По тексту спокойнее', code: 'SAFE' };
}

/** True если выборка из ленты канала (Telethon и/или публичная страница), не только база/сайты. */
function kroHomeReadPathIsChannelFeedSample(readPathOut) {
  const p = String(readPathOut || '').trim();
  return p === 'telethon' || p === 'telethon+public_snapshot' || p === 'public_snapshot';
}

/** Короткая англ. подпись уровня для блока «как у брокерского отчёта» (0–100). */
function kroHomeTrustRiskBandEn(statusCode) {
  const c = String(statusCode || '').toUpperCase();
  if (c === 'INSUFFICIENT_FEED' || c === 'UNAVAILABLE') return 'Limited data';
  if (c === 'DANGER') return 'High risk';
  if (c === 'SUSPICIOUS') return 'Elevated risk';
  if (c === 'SAFE') return 'Lower risk';
  return 'Uncertain';
}

function kroHomeTrustClip(s, maxLen) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

/** Приветствия и пустой тон — не показываем как «доказательство». */
function kroHomeIsFluffQuote(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length < 14) return true;
  const low = t.toLowerCase();
  const fluffRe = /^(привет|здравствуйте|добрый день|доброе утро|добрый вечер|всем\s+салам|салам\s+брать|салам\s+сестр|друзья|дорогие|уважаемые|подписывайтесь|ставьте\s+лайк|лайк|репост|спасибо\s+за\s+внимание)[.!?\s]*$/i;
  if (fluffRe.test(t)) return true;
  if (/👋|🙏|❤️|🔥/.test(t) && t.length < 90) return true;
  const letters = (t.match(/[a-zа-яёії]/gi) || []).length;
  if (letters < 18 && t.length < 100) return true;
  const tradeHints = ['btc', 'eth', 'usdt', 'сделк', 'лонг', 'шорт', 'стоп', 'риск', 'график', 'цена', 'pump', 'dump', 'сигнал', 'buy', 'sell', 'tp', 'sl'];
  if (!tradeHints.some((w) => low.includes(w)) && letters < 40) return true;
  return false;
}

function kroHomeFilterStructuredQuote(s) {
  const t = String(s || '').trim();
  if (!t || kroHomeIsFluffQuote(t)) return '';
  return kroHomeTrustClip(t.replace(/\n/g, ' '), 200);
}

function kroHomeBestEvidenceQuoteFromFlags(flags) {
  const arr = Array.isArray(flags) ? flags : [];
  for (const f of arr) {
    const sn = f && f.evidence_snippet ? String(f.evidence_snippet).trim() : '';
    const q = kroHomeFilterStructuredQuote(sn);
    if (q) return { quote: q, title: String((f && f.title) || '').trim() };
  }
  return { quote: '', title: '' };
}

function kroHomeWhyLineFromCriteriaChecklist(rows) {
  const arr = Array.isArray(rows) ? rows : [];
  const byKey = (k) => arr.find((r) => r && r.key === k);
  const risk = byKey('risk');
  const logic = byKey('logic');
  const vip = byKey('vip');
  const fomo = byKey('fomo');
  const parts = [];
  if (risk && risk.status === 'no') parts.push('нет явных правил риска (стоп / сценарий выхода)');
  if (logic && (logic.status === 'no' || logic.status === 'partial')) parts.push('мало объяснения логики сделки');
  if (vip && vip.status === 'yes') parts.push('есть платный закрытый формат');
  if (fomo && fomo.status === 'yes') parts.push('есть нажим или обещания результата');
  if (!parts.length) return '';
  return `Почему оценка не «ноль» при спокойной ленте: ${parts.join('; ')}. Это не обвинение в скаме — предупреждение про копирование без своих правил.`;
}

/** Если нет VIP/гарантий/иксов — не раздуваем риск только из «сигнал» в тексте. */
function kroHomeCalmScoreIfNoStructuralTriggers(score10, criteriaRows) {
  const arr = Array.isArray(criteriaRows) ? criteriaRows : [];
  const st = (k) => {
    const r = arr.find((x) => x && x.key === k);
    return r && r.status ? r.status : 'no';
  };
  const hot = st('vip') === 'yes' || st('fomo') === 'yes';
  if (hot) return score10;
  let n = Number(score10);
  if (!Number.isFinite(n)) return score10;
  if (n >= 7) n = Math.min(n, 6);
  return Math.max(1, Math.min(10, n));
}

/** 1–2 строки «как вас могут вести» по сработавшим паттернам (без обвинений вне текста). */
function kroHomeDeceptionBulletsFromFlags(flags) {
  const arr = Array.isArray(flags) ? flags : [];
  const lines = [];
  const seen = new Set();
  const push = (s) => {
    const t = String(s || '').trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    lines.push(t);
  };
  for (const f of arr) {
    const code = String((f && f.code) || '').toLowerCase();
    if (code === 'guarantee') {
      push('Обещают результат «как по заказу» — чтобы вы поверили, что риск уже кто-то другой взял на себя.');
    } else if (code === 'x_promises') {
      push('Показывают огромные проценты без контекста объёма и просадок — мозг считает это «почти бесплатными деньгами».');
    } else if (code === 'fomo') {
      push('Давят сроком и страхом упустить — чтобы вы решили быстрее, чем успеете проверить факты.');
    } else if (code === 'vip_paid') {
      push('Уводят в закрытый формат за деньги — там проще продать следующий шаг без публичной ответственности.');
    } else if (code === 'signal_push') {
      push('Подменяют обучение коротким «сделай как я» — вы торгуете вслепую, не понимая сценария выхода.');
    }
    if (lines.length >= 4) break;
  }
  if (!lines.length) {
    push('Если в ленте мало явных триггеров, обман чаще прячут в личке, «менеджере» или следующем шаге воронки.');
  }
  return lines.slice(0, 4);
}

/** Строки ties_risk_factors «Заголовок: пояснение» → псевдо-флаги для trust_report (без цитаты). */
function kroHomeTiesLinesToTrustFlags(ties) {
  return (Array.isArray(ties) ? ties : []).slice(0, 6).map((line) => {
    const s = String(line || '').trim();
    const i = s.indexOf(':');
    const title = i > 0 ? s.slice(0, i).trim() : 'Замечание';
    const explanation = i > 0 ? s.slice(i + 1).trim() : s;
    return {
      code: 'context',
      title: title || 'Замечание',
      explanation: explanation || '',
      evidence_snippet: '',
    };
  });
}

/** Чек-лист для режима без ленты: жалобы + строки из ties + честные «не смотрели» по остальным пунктам. */
function kroHomeExternalChecklistRows(ties, complaintsCount) {
  const rows = [];
  const comp = Number(complaintsCount);
  if (Number.isFinite(comp) && comp >= 1) {
    rows.push({
      key: 'reports',
      label: 'Жалобы и заявки в сервисе',
      status: comp >= 2 ? 'yes' : 'partial',
      explanation:
        comp >= 2
          ? `В сервисе несколько записей по этому каналу (${comp}) — это сигнал внимательнее читать ленту самим.`
          : 'В сервисе есть хотя бы одна запись по каналу — смотрите блок с жалобами ниже.',
    });
  }
  for (const f of kroHomeTiesLinesToTrustFlags(ties)) {
    rows.push({
      key: 'context',
      label: f.title,
      status: 'partial',
      explanation: f.explanation || 'Контекст из сводки по каналу.',
    });
  }
  const padLabels = [
    ['vip', 'Платный доступ и сигналы'],
    ['fomo', 'Давление и обещания прибыли'],
    ['risk', 'Про риск в постах'],
    ['logic', 'Объясняют ли смысл'],
    ['ads', 'Реклама и ссылки'],
  ];
  let pi = 0;
  while (rows.length < 5 && pi < padLabels.length) {
    const [key, label] = padLabels[pi];
    pi += 1;
    rows.push({
      key,
      label,
      status: 'no',
      explanation: 'В этом ответе посты канала не читали — честно не придумываем «да/нет» по тексту.',
    });
  }
  return rows.slice(0, 6);
}

function kroHomeCriteriaStatusWordRu(status) {
  if (status === 'yes') return 'да';
  if (status === 'partial') return 'частично';
  return 'нет';
}

function kroHomeCriteriaToChecklist(criteria) {
  const arr = Array.isArray(criteria) ? criteria : [];
  return arr.map((it) => {
    const row = it && typeof it === 'object' ? it : {};
    const label = String(row.label || 'Пункт').trim();
    const verdict = kroHomeCriteriaStatusWordRu(row.status);
    const expl = kroHomeTrustClip(String(row.explanation || '').trim(), 420);
    return {
      key: String(row.key || '').trim() || null,
      label,
      verdict_ru: verdict,
      what_we_saw: expl || 'По этой выборке явных совпадений не нашли.',
    };
  });
}

/**
 * 5–7 «внутренних» категорий для слоя логики (показываются во вкладке «Доказательства»).
 */
function kroHomeBuildAnalysisDimensions(criteriaRows, flagArr, complaintsCount) {
  const cr = Array.isArray(criteriaRows) ? criteriaRows : [];
  const g = (k) => cr.find((x) => x && x.key === k);
  const st = (k) => {
    const r = g(k);
    return r && r.status ? r.status : 'no';
  };
  const verdictRu = (k) => kroHomeCriteriaStatusWordRu(st(k));
  const comp = Number(complaintsCount);
  const flags = Array.isArray(flagArr) ? flagArr : [];
  const hasCode = (c) => flags.some((f) => String((f && f.code) || '').toLowerCase() === c);
  const dim = [];
  dim.push({
    key: 'pressure',
    label: 'Давление и срочность',
    level: st('fomo') === 'yes' ? 'high' : 'low',
    verdict_ru: verdictRu('fomo'),
    note_ru: st('fomo') === 'yes'
      ? 'В тексте есть нажим «успей / сейчас / последний шанс» — типичный разгон эмоций перед решением.'
      : 'В этой выборке жёсткого нажима по срокам почти не видно.',
  });
  dim.push({
    key: 'profit_promises',
    label: 'Обещания прибыли',
    level: hasCode('guarantee') || hasCode('x_promises') ? 'high' : 'low',
    verdict_ru: hasCode('guarantee') || hasCode('x_promises') ? 'да' : 'нет',
    note_ru: hasCode('guarantee') || hasCode('x_promises')
      ? 'Есть формулировки про «гарантии», «иксы» или слишком ровный результат — в реальном рынке так не бывает без оговорок.'
      : 'Явных «гарантий дохода» и «иксов» в выборке не поймали.',
  });
  dim.push({
    key: 'risk_management',
    label: 'Управление риском в тексте',
    level: st('risk') === 'yes' ? 'low' : st('risk') === 'partial' ? 'mid' : 'high',
    verdict_ru: verdictRu('risk'),
    note_ru: st('risk') === 'yes'
      ? 'Встречаются стопы, риск на сделку или сценарий отмены идеи.'
      : 'Правила риска в постах почти не проговорены — при копировании вы остаетесь без карты.',
  });
  dim.push({
    key: 'signals_copy',
    label: 'Сигналы и слепое копирование',
    level: hasCode('signal_push') ? 'high' : 'mid',
    verdict_ru: hasCode('signal_push') ? 'да' : 'нет',
    note_ru: hasCode('signal_push')
      ? 'Есть короткие торговые команды без полного сценария — удобно копировать, но непонятно, где выход.'
      : 'Жёсткого «сигнал без контекста» в выборке мало; риск копирования всё равно остаётся, если нет своих правил.',
  });
  dim.push({
    key: 'vip_closed',
    label: 'Платный / закрытый доступ',
    level: st('vip') === 'yes' ? 'high' : 'low',
    verdict_ru: verdictRu('vip'),
    note_ru: st('vip') === 'yes'
      ? 'Заметен платный или закрытый формат — часто следующий шаг после «бесплатной» ленты.'
      : 'Прямых призывов к VIP в этой выборке почти нет.',
  });
  dim.push({
    key: 'social_proof',
    label: 'Социальное давление и «все так делают»',
    level: st('ads') === 'yes' || st('ads') === 'partial' ? 'mid' : 'low',
    verdict_ru: verdictRu('ads'),
    note_ru: st('ads') === 'yes' || st('ads') === 'partial'
      ? 'Много отсылок к партнёркам, ссылкам и чужим каналам — фон «все уже внутри» усиливается.'
      : 'Реклама и партнёрки в этой выборке не доминируют.',
  });
  dim.push({
    key: 'complaints',
    label: 'Жалобы в сервисе',
    level: Number.isFinite(comp) && comp >= 2 ? 'high' : comp >= 1 ? 'mid' : 'low',
    verdict_ru: comp >= 2 ? 'да' : comp >= 1 ? 'частично' : 'нет',
    note_ru: comp >= 2
      ? 'Несколько жалоб на канал в нашей базе — отдельный сигнал осторожности.'
      : comp >= 1
        ? 'Есть хотя бы одна жалоба — имеет смысл прочитать детали в карточке канала.'
        : 'В открытых жалобах по этому каналу пусто — опора в основном на текст ленты.',
  });
  return dim.slice(0, 7);
}

/**
 * Элементы для вкладки «Доказательства»: цитаты из флагов + при необходимости жалобы.
 * Если шаблоны не сработали, но выборка постов есть — показываем отрывки из тех же постов (честная иллюстрация тона).
 */
function kroHomeBuildEvidenceItems(flagArr, complaintsCount, citationFallbacks) {
  const out = [];
  const flags = Array.isArray(flagArr) ? flagArr : [];
  for (const f of flags) {
    const title = String((f && f.title) || (f && f.code) || 'Паттерн').trim();
    const sn = f && f.evidence_snippet ? kroHomeFilterStructuredQuote(String(f.evidence_snippet).trim()) : '';
    if (!sn) continue;
    out.push({
      kind: 'flag',
      title,
      quote_ru: sn,
      source_ru: 'Текст постов в выборке',
      why_ru: kroHomeTrustClip(String((f && f.explanation) || '').split(/\n\n+/)[0] || 'Совпадение с типичным приёмом в крипто-каналах.', 200),
    });
    if (out.length >= 5) break;
  }
  const comp = Number(complaintsCount);
  if (Number.isFinite(comp) && comp >= 1 && out.length < 6) {
    out.push({
      kind: 'complaints',
      title: 'Жалобы пользователей',
      quote_ru: '',
      source_ru: 'Лист reports в Google Sheets (сервис)',
      why_ru: `Зафиксировано жалоб: ${comp}. Откройте карточку канала для формулировок и дат.`,
    });
  }
  const cites = Array.isArray(citationFallbacks) ? citationFallbacks : [];
  if (out.length === 0 && cites.length) {
    for (const raw of cites) {
      const q = kroHomeFilterStructuredQuote(String(raw || ''));
      if (!q) continue;
      out.push({
        kind: 'feed_sample',
        title: 'Фрагмент из выборки постов',
        quote_ru: q,
        source_ru: 'Текст постов в выборке',
        why_ru:
          'Это не «улика» по шаблону VIP/гарантий, а реальный отрывок из прочитанной ленты — чтобы было видно формат и тон.',
      });
      if (out.length >= 4) break;
    }
  }
  return out.slice(0, 6);
}

/**
 * Главная: компактный «продуктовый» отчёт (v4) — риск, 3 причины, 1 пример, действие, без «процесса».
 */
function kroHomeThreeRiskBulletsFromCriteria(criteriaRows) {
  const cr = Array.isArray(criteriaRows) ? criteriaRows : [];
  const g = (k) => cr.find((x) => x && x.key === k);
  const risk = g('risk');
  const logic = g('logic');
  const fomo = g('fomo');
  const vip = g('vip');
  const br1 = risk && risk.status === 'yes'
    ? 'В тексте встречаются правила риска — всё равно сверяйте их со своей системой, без автопилота.'
    : 'В постах мало явных правил риска: стоп, доля капитала, когда идея считается ошибочной — при копировании легко потерять контроль.';
  const br2 = logic && logic.status === 'yes'
    ? 'Есть объяснения логики — это помогает не торговать вслепую, но ответственность за вход всё равно на вас.'
    : 'Мало объяснения «почему» — сигналы воспринимаются как «сделай как я», без сценария сделки и выхода.';
  const hot = (fomo && fomo.status === 'yes') || (vip && vip.status === 'yes');
  const br3 = hot
    ? 'Заметны платный закрытый формат или нажим — в таких историях чаще торопят с оплатой; имеет смысл остановиться и перепроверить.'
    : 'Даже без «красных» триггеров в ленте риск копирования остаётся: рынок не платит за чужие идеи без вашей дисциплины.';
  return [br1, br2, br3];
}

function kroHomeBuildTrustReportBundle(opts) {
  const {
    risk10,
    statusCode,
    flags,
    livePass,
    postsRead,
    complaintsCount,
    criteriaRows,
    voice,
    readPathOut,
    editor_voice_prefix_ru,
    citationFallbacks,
    trustSampleMaxChars,
  } = opts || {};
  const readPath = String(readPathOut || '').trim();
  const feedSample = kroHomeReadPathIsChannelFeedSample(readPath);
  const postsN = Number(postsRead) || 0;
  const maxSam = Number(trustSampleMaxChars) || 0;
  const flagArr = Array.isArray(flags) ? flags : [];
  const hasStrongEvidence = flagArr.some((f) => {
    const sn = f && f.evidence_snippet ? String(f.evidence_snippet).trim() : '';
    return kroHomeFilterStructuredQuote(sn).length >= 16;
  });
  /** Один пост, но длинный фрагмент из ленты — не считаем «пустой лентой». */
  const weakFeed =
    feedSample &&
    postsN === 1 &&
    !hasStrongEvidence &&
    maxSam < 140;

  const r10raw = Number(risk10);
  const r10 = Number.isFinite(r10raw) ? Math.max(1, Math.min(10, r10raw)) : null;
  let outStatusCode = String(statusCode || 'UNAVAILABLE').toUpperCase();
  let outRisk100 = r10 == null ? null : Math.round(r10 * 10);

  if (weakFeed) {
    outStatusCode = 'INSUFFICIENT_FEED';
    outRisk100 = null;
  } else if (r10 != null) {
    const calm = kroHomeCalmScoreIfNoStructuralTriggers(r10, criteriaRows);
    const stAdj = kroMapFastRisk10ToUiStatus(calm);
    outStatusCode = String(stAdj.code || outStatusCode).toUpperCase();
    outRisk100 = Math.round(calm * 10);
  }

  const bandEn = outRisk100 == null ? 'Limited data' : kroHomeTrustRiskBandEn(outStatusCode);
  const checklistFull = kroHomeCriteriaToChecklist(criteriaRows);
  const checklist = checklistFull.slice(0, 3).map((row) => ({
    ...row,
    what_we_saw: kroHomeTrustClip(String(row.what_we_saw || '').trim(), 220),
  }));

  const bestEv = kroHomeBestEvidenceQuoteFromFlags(flagArr);
  const topicLine = String(voice && voice.topicLine ? voice.topicLine : '').trim();
  const channelType = String(voice && voice.channelType ? voice.channelType : '').trim();
  const leadLine = String(voice && voice.leadLine ? voice.leadLine : '').trim();

  let exTitle = 'Фрагмент из ленты';
  let exQuoteInner = bestEv.quote;
  let exWhy = 'По этой фразе не видно полного сценария: вход, стоп, выход и размер риска.';
  if (bestEv.title) exTitle = bestEv.title;
  if (flagArr.length) {
    const f0 = flagArr[0];
    const expl0 = String((f0 && f0.explanation) || '').trim();
    const oneLine = expl0 ? kroHomeTrustClip(expl0.split(/\n\n+/)[0], 180) : '';
    if (oneLine) exWhy = oneLine;
  }
  if (!exQuoteInner) {
    exQuoteInner = kroHomeTrustClip(topicLine || channelType || leadLine, 200);
    exTitle = 'Что видно по формату';
    exWhy = 'Это похоже на короткое описание без правил сделки — как слабый ориентир для копирования.';
  }

  const patterns = [
    {
      title: exTitle,
      quote: exQuoteInner ? `«${exQuoteInner}»` : '',
      why_dangerous: exWhy,
    },
  ];

  const reasonsRu = kroHomeThreeRiskBulletsFromCriteria(criteriaRows);
  const whyScoreRu = kroHomeWhyLineFromCriteriaChecklist(criteriaRows);

  const editorVoice = [];
  const prefix = String(editor_voice_prefix_ru || '').trim();
  if (prefix) editorVoice.push(prefix);
  if (!livePass) {
    editorVoice.push(
      'Здесь использованы строки из базы сервиса и жалоб; свежие посты канала в этот ответ не подключали — при возможности сверьте формулировки на странице канала.',
    );
  }

  const comp = Number(complaintsCount);
  let impactHookRu = 'Если вы уже обжигались на рынке, этот блок — чтобы не платить дважды: спокойно сверить канал со своими правилами, а не с эмоцией.';
  if (Number.isFinite(comp) && comp >= 2) {
    impactHookRu = 'На канал есть несколько жалоб в сервисе — это повод отнестись к деньгам особенно осторожно и не спешить.';
  } else if (flagArr.some((f) => f && (f.code === 'guarantee' || f.code === 'x_promises'))) {
    impactHookRu = 'Обещания «лёгкой» прибыли почти всегда стоят дороже, чем кажется в посте — здесь лучше не торопиться.';
  } else if (flagArr.some((f) => f && f.code === 'fomo')) {
    impactHookRu = 'Срочность в ленте — повод сделать паузу: решения на нервах редко совпадают с вашим планом по риску.';
  }

  let riskLabelRu = '—';
  let riskEmoji = '⚪';
  if (outRisk100 != null) {
    if (outRisk100 >= 70) {
      riskLabelRu = 'ВЫСОКИЙ';
      riskEmoji = '🔴';
    } else if (outRisk100 >= 45) {
      riskLabelRu = 'УМЕРЕННЫЙ';
      riskEmoji = '🟡';
    } else {
      riskLabelRu = 'НИЖЕ СРЕДНЕГО';
      riskEmoji = '🟢';
    }
  }

  const cr = Array.isArray(criteriaRows) ? criteriaRows : [];
  const hasRiskManagement = cr.some((c) => c && c.key === 'risk' && c.status === 'yes');

  let headlineRu = 'Недостаточно данных для оценки по ленте';
  let sublineRu = 'Один короткий пост — цифру риска по ленте не показываем; ниже три причины осторожности и что делать.';
  let summaryRu = 'Нельзя честно свести доверие к каналу к одной цифре без нормальной выборки текста.';
  let forYouRu = 'Можно войти в сделку, не понимая сценария — это частый источник потерь, даже если автор не выглядит «скамером».';
  let rec = 'Не копируйте сделки без своих стопов, размера позиции и правила отмены идеи; при сомнениях — глубокая проверка.';
  let whenOkRu = 'Если у вас есть своя стратегия, журнал сделок и вы не копируете вслепую.';
  let whenDangerousRu = 'Если вы на эмоциях после потерь, новичок или повторяете чужие входы без риск‑менеджмента.';

  if (!weakFeed || hasStrongEvidence) {
    const r10disp = outRisk100 == null ? null : Math.round(outRisk100 / 10);
    let bandWord = 'ниже среднего';
    if (outRisk100 != null && outRisk100 >= 70) bandWord = 'высокий';
    else if (outRisk100 != null && outRisk100 >= 45) bandWord = 'средне-высокий';
    headlineRu = outRisk100 == null ? 'Оценка по контексту' : `${riskEmoji} Риск: ${r10disp}/10 (${bandWord})`;
    sublineRu = kroHomeTrustClip(
      leadLine
        || (hasRiskManagement
          ? 'Формат канала всё равно может подталкивать к копированию — решение о деньгах остаётся за вами.'
          : 'Канал даёт торговые идеи без чётких правил риска в тексте — копировать сделки вслепую опасно.'),
      220,
    );
    summaryRu = kroHomeTrustClip(
      flagArr.length
        ? 'В выборке есть формулировки, из‑за которых стоит остановиться перед входом или оплатой.'
        : 'Явных «скам‑триггеров» в выборке мало — основной риск в копировании без своих правил и в эмоциональном входе.',
      180,
    );
    forYouRu = !hasRiskManagement
      ? 'Легко войти в сделку без сценария и стопа — выше шанс ошибки и просадки депозита.'
      : 'Даже при упоминаниях риска ответственность за вход и размер позиции остаётся на вас.';
    if (outRisk100 != null && outRisk100 >= 70) {
      forYouRu = 'Высокий риск импульсивного входа и оплаты закрытого доступа без прозрачных правил от автора.';
    } else if (outRisk100 != null && outRisk100 >= 45) {
      forYouRu = 'Можно переоценить уверенность и зайти больше, чем позволяет ваш риск — типичная ловушка после стресса.';
    }
    rec =
      outRisk100 != null && outRisk100 >= 70
        ? 'Не переводите деньги и не оплачивайте VIP без независимой проверки; не копируйте без своих стопов.'
        : outRisk100 != null && outRisk100 >= 45
          ? 'Не копируйте сделки без своей стратегии, стопов и лимита на сделку.'
          : 'Зафиксируйте риск на сделку и правило выхода до входа — не после.';
  }

  const deceptionBullets = kroHomeDeceptionBulletsFromFlags(flagArr).slice(0, 1);

  const empathIntroRu =
    'Если вы устали от обещаний и потерь — это нормально. Сначала короткий вывод; ниже можно открыть «Подробно» или «Доказательства», если нужны детали.';

  const analysisDimensions = kroHomeBuildAnalysisDimensions(criteriaRows, flagArr, complaintsCount);
  const evidenceItems = kroHomeBuildEvidenceItems(flagArr, complaintsCount, citationFallbacks);

  const uiModes = {
    quick: {
      risk_headline_ru: headlineRu,
      subline_ru: kroHomeTrustClip(sublineRu, 200),
      reasons_ru: reasonsRu,
      for_you_ru: forYouRu,
      recommendation_ru: rec,
    },
    detailed: {
      empath_intro_ru: empathIntroRu,
      impact_hook_ru: impactHookRu,
      editor_voice_ru: editorVoice.filter(Boolean).slice(0, 2),
      summary_ru: summaryRu,
      when_ok_ru: whenOkRu,
      when_dangerous_ru: whenDangerousRu,
      why_score_ru: whyScoreRu,
      example_title_ru: exTitle,
      example_quote_ru: exQuoteInner,
      example_why_ru: exWhy,
      patterns,
      recommendation_ru: rec,
      how_bullets_ru: [
        'Ищем в тексте триггеры: гарантии, «иксы», VIP, срочность.',
        'Смотрим, есть ли риск‑менеджмент и объяснение логики сделки.',
        'Сверяем с жалобами в сервисе.',
      ],
    },
    evidence: {
      analysis_dimensions: analysisDimensions,
      evidence_items: evidenceItems,
    },
  };

  return {
    v: 5,
    read_path: readPath || null,
    insufficient_feed: weakFeed && !hasStrongEvidence,
    risk_score_100: outRisk100,
    risk_band_en: bandEn,
    status_code: outStatusCode,
    risk_label_ru: riskLabelRu,
    risk_emoji: riskEmoji,
    ui_modes: uiModes,
    default_mode: 'quick',
    analysis_dimensions: analysisDimensions,
    evidence_items: evidenceItems,
    empath_intro_ru: empathIntroRu,
    headline_ru: headlineRu,
    subline_ru: sublineRu,
    for_you_ru: forYouRu,
    reasons_ru: reasonsRu,
    example_title_ru: exTitle,
    example_quote_ru: exQuoteInner,
    example_why_ru: exWhy,
    when_ok_ru: whenOkRu,
    when_dangerous_ru: whenDangerousRu,
    impact_hook_ru: impactHookRu,
    why_score_ru: whyScoreRu,
    confidence_percent: null,
    confidence_note_ru: '',
    checklist,
    editor_voice_ru: editorVoice.filter(Boolean).slice(0, 2),
    patterns,
    summary_ru: summaryRu,
    recommendation_ru: rec,
    deception_narrative: {
      title: 'На что чаще ловят',
      hook: flagArr.length
        ? 'Типичная цепочка: эмоция → быстрый вход или оплата → потом сложно получить ответы и возврат.'
        : 'Даже «спокойная» лента не отменяет того, что решение о деньгах принимаете вы — и его лучше сверить с планом.',
      bullets: deceptionBullets.length ? deceptionBullets : ['Перед оплатой сделайте паузу и проверьте канал вне Telegram.'],
    },
    how_we_analyze_ru: [
      'Ищем в тексте триггеры: гарантии, «иксы», VIP, срочность.',
      'Смотрим, есть ли риск‑менеджмент и объяснение логики сделки.',
      'Сверяем с жалобами в сервисе.',
    ],
  };
}

function kroDeepMetric(payload, field) {
  const dm = payload && payload.deep_metrics && typeof payload.deep_metrics === 'object'
    ? payload.deep_metrics
    : {};
  const n = Number(dm[field]);
  return Number.isFinite(n) ? n : 0;
}

function kroCriteriaStatus(fastHuman, key) {
  const c = fastHuman && Array.isArray(fastHuman.criteria)
    ? fastHuman.criteria.find((x) => x && x.key === key)
    : null;
  return c && c.status ? c.status : 'no';
}

function kroWordHitsFromPayload(p) {
  const dm = p && p.deep_metrics && typeof p.deep_metrics === 'object' ? p.deep_metrics : {};
  const wh = p && p.language_word_hits && typeof p.language_word_hits === 'object' ? p.language_word_hits : {};
  return {
    profit_hits: Number(wh.profit_hits != null ? wh.profit_hits : dm.profit_word_hits) || 0,
    loss_hits: Number(wh.loss_hits != null ? wh.loss_hits : dm.loss_word_hits) || 0,
    guarantee_hits: Number(wh.guarantee_hits != null ? wh.guarantee_hits : dm.guarantee_word_hits) || 0,
    paid_hits: Number(wh.paid_hits != null ? wh.paid_hits : dm.paid_word_hits) || 0,
  };
}

/**
 * «Тяжёлые» сигналы в тексте постов — без них не поднимаем к красной зоне и не обвиняем в мошенничестве.
 */
function kroHasStrongPostEvidence(p, fastHuman) {
  const dm = p && p.deep_metrics && typeof p.deep_metrics === 'object' ? p.deep_metrics : {};
  const wh = kroWordHitsFromPayload(p);
  if (kroCriteriaStatus(fastHuman, 'fomo') === 'yes') return true;
  if ((Number(dm.urgency_posts_count) || 0) >= 2) return true;
  if ((Number(dm.guarantee_mentions_count) || 0) >= 2) return true;
  if (wh.guarantee_hits >= 3) return true;
  if (kroCriteriaStatus(fastHuman, 'vip') === 'yes'
    && (wh.guarantee_hits >= 1
      || kroCriteriaStatus(fastHuman, 'fomo') === 'yes'
      || (Number(dm.paid_access_mentions_count) || 0) >= 4)) return true;
  const pr = wh.profit_hits;
  const lo = wh.loss_hits;
  const pf = p.only_profits_flag === true;
  if (pf && pr >= 12 && lo <= 3 && (p.posts_fetched || 0) >= 25) return true;
  return false;
}

function kroMapRiskDisplayToUiStatus(risk, hasEvidence) {
  const n = Number(risk);
  if (!Number.isFinite(n)) return { status: 'Оценка не готова', code: 'UNAVAILABLE' };
  if (n < 4) return { status: 'Риск по тексту ниже', code: 'SAFE' };
  if (n < 7) return { status: 'Есть поводы насторожиться', code: 'SUSPICIOUS' };
  if (n >= 7 && hasEvidence) return { status: 'Много тревожного в формулировках', code: 'DANGER' };
  return { status: 'Есть поводы насторожиться', code: 'SUSPICIOUS' };
}

function kroConclusionStatusFromEvidence(risk, hasEvidence, opts) {
  const n = Number(risk);
  const o = opts && typeof opts === 'object' ? opts : {};
  if (o.forceScam === true && hasEvidence) return KRO_V0_STATUS.scam;
  if (!Number.isFinite(n)) return KRO_V0_STATUS.watch;
  if (n < 4) return KRO_V0_STATUS.clean;
  if (n < 7) return KRO_V0_STATUS.watch;
  if (n >= 7 && hasEvidence) return KRO_V0_STATUS.risk;
  return KRO_V0_STATUS.watch;
}

function kroBuildUserFacingLiveReport(payload, fastHuman, opts = null) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const meta = opts && typeof opts === 'object' ? opts : {};
  const risk = Number(fastHuman && fastHuman.score10);
  const postsRead = Number(meta.postsRead || p.posts_fetched || 0) || 0;
  const periodDays = Number(meta.periodDays || p.analysis_window_days || 0) || null;
  const hasEvidence = meta.hasPostEvidence === true;
  const wh = kroWordHitsFromPayload(p);
  const profitsCount = kroDeepMetric(p, 'profits_posts_count');
  const lossesCount = kroDeepMetric(p, 'losses_posts_count');
  const urgencyCount = kroDeepMetric(p, 'urgency_posts_count');
  const paidCount = kroDeepMetric(p, 'paid_access_mentions_count');
  const guaranteeCount = kroDeepMetric(p, 'guarantee_mentions_count');
  const marketDownCount = kroDeepMetric(p, 'market_downturn_posts_count');
  const riskMgmtCount = kroDeepMetric(p, 'risk_management_posts_count');
  const logicCount = kroDeepMetric(p, 'logic_explained_posts_count');
  const earlySales = kroDeepMetric(p, 'sales_tone_early_score');
  const recentSales = kroDeepMetric(p, 'sales_tone_recent_score');
  const scamSimilarity = p.scam_similarity && typeof p.scam_similarity === 'object' ? p.scam_similarity : null;
  const paidPhaseRaw = String((p.deep_metrics && p.deep_metrics.paid_access_start_phase) || '').toLowerCase();
  const paidPhase = paidPhaseRaw === 'early'
    ? 'сильнее в ранних постах'
    : (paidPhaseRaw === 'late'
      ? 'сильнее во второй половине ленты'
      : (paidPhaseRaw === 'middle' ? 'середина ленты' : 'в этой выборке не выделяется — решают отдельные фразы'));
  const ui = kroMapRiskDisplayToUiStatus(risk, hasEvidence);
  const ageDays = Number(p.channel_age_days);
  const promoted = Number(p.promoted_channels_count);
  const firstIm = Array.isArray(p.first_impression_posts)
    ? p.first_impression_posts.map((x) => String(x || '').trim()).filter(Boolean)
    : [];

  let tier = 'watch';
  let verdictColor = 'amber';
  if (Number.isFinite(risk) && risk < 4) {
    tier = 'calm';
    verdictColor = 'green';
  } else if (Number.isFinite(risk) && risk >= 7 && hasEvidence) {
    tier = 'danger';
    verdictColor = 'red';
  }

  const languageStory = `По смыслу: в ${postsRead} прочитанных постов в тексте на «плюс», иксы и идею заработка — ориентировочно ${wh.profit_hits} вхождений, про убыток, стоп, минусы — ${wh.loss_hits} вхождений; «гарантия/100%/без риска» — ${wh.guarantee_hits} вхождений; про оплату, подписку, доступ — ${wh.paid_hits} вхождений. Это счётчики слов, а не оценка личности автора. ${profitsCount} постов содержат «прибыль» по ключам, ${lossesCount} — «убыток» (по посту целиком).${lossesCount >= 4 ? ' Автор несколько раз отмечал минусы — с мошеннической схемой сокрытия убытков обычно плохо сочетается.' : ''}`;

  const act1Intro = 'Мы зашли в канал. Вот что видит любой подписчик, если открыть ленту (свежие посты сверху):';
  const act2Intro = `Мы просмотрели смысл в ${postsRead} постов за ${periodDays || 90} дн. (это ориентир, не обещание, что взяли “всё 2000”): как меняется тон, где появляются к продаже и “гарантии”, как про убытки.`;
  const act2PatternLines = [
    `Тон “продаж/давления” по оценке: вначале — ${earlySales}/100, сейчас — ${recentSales}/100.`
      + (recentSales > (earlySales + 12) ? ' Тон в свежей части заметно резче, чем в ранних постах — по текстам, не по “возрасту” канала.' : ' Резкого “переключения” на продавилово по счётчику нет, но важны конкретные фразы.'),
    `Перекос “в тело поста про прибыль” vs “пост про убыток” — ${profitsCount} к ${lossesCount}.${p.only_profits_flag && lossesCount < 2 ? ' Это повод внимательно смотреть, правда ли показывают слабые сделки — сами “иксы” не доказательство.' : ' У честного автора “минусы” встречаются чаще, чем у рекламы; но сам баланс зависит от ниши.'}`,
    `В метриках: постов с давлением/срочностью (по ключу) — ${urgencyCount}; обсуждений просадки/рынка “вниз” — ${marketDownCount}.`,
    `Смысл про стоп/риск в постах: ~${riskMgmtCount} “риск-менедж” поста; с объяснением логики/плана — ${logicCount}.${(Number.isFinite(promoted) && promoted > 0) ? ` Ссылки на ${Math.round(promoted)} другие каналы — сами по себе не подтверждение и не опровергают, это просто соседние площадки в тексте.` : ''}${Number.isFinite(ageDays) && ageDays > 0 ? ` Срок жизни канала ~${Math.round(ageDays)} дн. — нейтральный факт, не “скам”.` : ''}`,
    hasEvidence && scamSimilarity && scamSimilarity.label
      ? `Сравнение с базой (узор, не клеймо): ${String(scamSimilarity.label)}`
      : (scamSimilarity && scamSimilarity.label ? `Совпадения с “шаблоном” (если всплывают, без тяжёлых фраз): ${String(scamSimilarity.label)}` : ''),
  ].filter(Boolean);

  const honestByTier = tier === 'calm'
    ? 'Канал выглядит добросовестно. Явных “гарантий прибыли” и сильного давления в этой выборке нет. Памятка: риск всё равно в рынке, не в “нашем слове”.'
    : (tier === 'danger'
      ? 'В тексте есть сочетание: давление, гарантия результата или ярко выраженный перекос “только плюс”. Это именно смысловые, а не косвенные признаки. Не путай с “молодым” каналом или “рекламирует соседей” — сами по себе это ничего не делают.'
      : (Number.isFinite(risk) && risk >= 7 && !hasEvidence
        ? `Балл риска ${Math.round(risk)}/10 вытекает в основном из стиля, рекламы, сигналов и “дыр” риск-менеджмента в срезанной выборке, но в тексте не всплыла связка “гарантия+давление” или “стопов нет+только плюс”. Красного ярлыка не вешаем.`
        : 'Есть вопросы по смыслу. Не спеши с деньгами — сверяй: как показывают плохие сделки, говорит ли кто-то про риск.'));

  let sharpQuestion = 'Если вынесешь в сторону имя, аватар и “сколько дней” — останется в этом тексте доверие, которого ты требуешь от денег?';
  if (p.only_profits_flag && lossesCount <= 1 && postsRead > 20) {
    sharpQuestion = `Слов про прирост/«иксы» встретили сильно больше, а явных “минусов/стопов” мало. На твоей практике так ведёт реальный трейдер или прежде всего лента для подписок?`;
  } else if (wh.loss_hits >= 6) {
    sharpQuestion = 'Автор публично ссылается на плохие сделки и риск. Готов ли проверить его “на бумажке” без крупного депозита, потому что сам видишь, что “не только плюс”?';
  } else if (kroCriteriaStatus(fastHuman, 'fomo') === 'yes' || (Number(wh.guarantee_hits) || 0) >= 2) {
    sharpQuestion = 'Если убрать слова «срочно», «гарантия», «100%» — остались бы в постах цифры, по которым ты вошёл бы в сделку сам, без нажима «успей»?';
  }

  const headline = tier === 'calm'
    ? 'По тексту ленты: без “гарантийного” пласта'
    : (tier === 'danger'
      ? 'По смыслу: есть тяжёлые сигналы'
      : 'По смыслу: есть вопросы, но без “автомошенника”');

  const act3Body = [honestByTier, hasEvidence ? '' : 'Система нарочно не раздувает страх, если “грязь” в постах не подтвердилась. Базовое правило: “молодой/рекламирует/много цифр” ≠ скам.'].filter((x) => x && x.trim().length);
  const simpleConclusion = [fastHuman && fastHuman.summaryLine, act3Body.join(' ')].filter(Boolean).join(' ');

  const sample = Array.isArray(p.sample_posts) ? p.sample_posts.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const deepQuotes = [];
  const dm = p.deep_metrics && typeof p.deep_metrics === 'object' ? p.deep_metrics : {};
  for (const field of ['urgency_quotes', 'paid_access_quotes', 'guarantee_quotes', 'profit_vs_loss_quotes']) {
    const arr = Array.isArray(dm[field]) ? dm[field] : [];
    for (const q of arr) {
      const t = String(q || '').trim();
      if (!t) continue;
      if (!deepQuotes.includes(t)) deepQuotes.push(t);
      if (deepQuotes.length >= 4) break;
    }
  }
  const quotes = (deepQuotes.length ? deepQuotes : sample).slice(0, 5);
  const readSummary = `Прочитано с текстом ${postsRead} постов за ${periodDays || 90} дн. В словестный слой: «+»-лексика — ${wh.profit_hits} вхождений, «-»-лексика (убыт/стоп/миус) — ${wh.loss_hits} вхождений, «гарантия/100%» — ${wh.guarantee_hits}, “оплата/подписка/доступ” — ${wh.paid_hits}.`;

  let finalAdvice = '';
  if (Number.isFinite(risk) && risk < 4) {
    finalAdvice = 'Сохрани отчёт. Если пойдёшь в подписку, начни с суммы, которой не боишься; правило не про “трусости”, а про цифру.';
  } else if (tier === 'watch') {
    finalAdvice = 'Отложи “да/нет” на 24–48 ч., пересмотри 5–7 постов, которые мы цитировали, и сравни с нормой для обучающей/трейд-недели.';
  } else {
    finalAdvice = 'Если канал пишет с гарантией прибыли или “входи сейчас” — поставь “стоп-разговор” по деньгам до снятия этих смыслов.';
  }

  return {
    report_version: 'detective_v1',
    verdict: ui.status,
    verdict_code: ui.code,
    verdict_color: verdictColor,
    tier,
    has_post_evidence: hasEvidence,
    headline,
    intro: 'Мы ведём отчёт как дело: “что видит человек” → “что видно, когда вылезаешь из пары постов” → “чем закончим”.',
    risk_text: Number.isFinite(risk) ? `Смысловой индекс: ${Math.round(risk)}/10` : '',
    honest_assessment: honestByTier,
    language_story: languageStory,
    detective: {
      act1_title: 'Акт 1 — первое впечатление',
      act1_lead: act1Intro,
      act1_first_posts: firstIm.slice(0, 3),
      act2_title: 'Акт 2 — что всплывает глубже',
      act2_lead: act2Intro,
      act2_patterns: act2PatternLines,
      act3_title: 'Акт 3 — вывод по факту',
      act3_conclusion: act3Body,
      sharp_question: sharpQuestion,
    },
    facts: act2PatternLines.slice(0, 3),
    read_summary: readSummary,
    quotes,
    simple_conclusion: simpleConclusion,
    final_advice: finalAdvice,
    numbers: {
      profit_word_hits: wh.profit_hits,
      loss_word_hits: wh.loss_hits,
      guarantee_word_hits: wh.guarantee_hits,
      paid_word_hits: wh.paid_hits,
      profits_posts_count: profitsCount,
      losses_posts_count: lossesCount,
      urgency_posts_count: urgencyCount,
      paid_access_mentions_count: paidCount,
      guarantee_mentions_count: guaranteeCount,
    },
    time_analysis: {
      paid_access_start_phase: paidPhase,
      sales_tone_early_score: earlySales,
      sales_tone_recent_score: recentSales,
    },
    scam_similarity: scamSimilarity,
  };
}

async function kroHarvestPublicSnippetsUntilEnough(channelForOnce, deadline, minPosts, analyzeLogId) {
  const need = Math.max(1, Number(minPosts) || 1);
  const seen = new Set();
  const datedSeen = new Set();
  const out = [];
  const datedOut = [];
  const pushSnips = (arr) => {
    for (const raw of arr || []) {
      const t = String(raw || '').trim();
      if (t.length < 8) continue;
      const k = t.slice(0, 280);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= Math.min(160, need + 100)) return true;
    }
    return out.length >= need;
  };
  const pushDated = (rows) => {
    for (const row of rows || []) {
      const text = String((row && row.text) || '').trim();
      if (text.length < 8) continue;
      const k = `${row.date_iso || ''}|${text.slice(0, 100)}`;
      if (datedSeen.has(k)) continue;
      datedSeen.add(k);
      datedOut.push({
        text,
        date_iso: row.date_iso || null,
        url: row.url ? String(row.url).trim() : null,
      });
    }
  };
  for (let pass = 1; pass <= 5; pass++) {
    const remain = deadline - Date.now();
    if (remain < 400) break;
    const pubBudget = Math.min(60000, Math.max(1500, remain - 500));
    const snap = await kroFetchTelegramPublicSnapshot(channelForOnce, {
      timeoutMs: pubBudget,
      logLabel: `${analyzeLogId}:pub_harvest${pass}`,
    });
    if (snap && Array.isArray(snap.dated_posts) && snap.dated_posts.length) pushDated(snap.dated_posts);
    if (snap && Array.isArray(snap.snippets) && snap.snippets.length && pushSnips(snap.snippets)) break;
  }
  return out.length ? { snippets: out, dated_posts: datedOut } : null;
}

function kroUnwrapPublicHarvest(harvest) {
  if (!harvest) return { snippets: [], dated_posts: [] };
  if (Array.isArray(harvest)) return { snippets: harvest, dated_posts: [] };
  return {
    snippets: Array.isArray(harvest.snippets) ? harvest.snippets : [],
    dated_posts: Array.isArray(harvest.dated_posts) ? harvest.dated_posts : [],
  };
}

/**
 * Пока есть время в sync-окне — добираем публичные сниппеты, чтобы приблизиться к targetPosts (не выходим из deadline).
 */
async function kroHomeHarvestUntilTargetPosts(opts) {
  const {
    channelForOnce,
    deadline,
    analyzeLogId,
    targetPosts,
    parsed,
    minReadablePosts,
    channelDisplay,
  } = opts || {};
  let curParsed = parsed && typeof parsed === 'object' ? { ...parsed } : {};
  const tgt = Math.max(1, Number(targetPosts) || 1);
  const minR = Math.max(1, Number(minReadablePosts) || 1);
  let harvestedAgg = null;
  let iter = 0;
  while (deadline - Date.now() > 8000 && iter < 28) {
    iter += 1;
    const merged = kroHomeGreedyMergeSamplesFromParsed(curParsed, minR);
    const n = merged.length ? merged.length : (Number(curParsed.posts_fetched || 0) || 0);
    if (n >= tgt) break;
    const batchNeed = Math.min(tgt, Math.max(minR, n + 4));
    const more = await kroHarvestPublicSnippetsUntilEnough(
      channelForOnce,
      deadline,
      batchNeed,
      `${analyzeLogId}:fill${iter}`,
    );
    const moreHarvest = kroUnwrapPublicHarvest(more);
    if (!moreHarvest.snippets.length) break;
    if (!harvestedAgg) harvestedAgg = [];
    for (const s of moreHarvest.snippets) {
      const t = String(s || '').trim();
      if (!t) continue;
      if (harvestedAgg.some((x) => x.slice(0, 280) === t.slice(0, 280))) continue;
      harvestedAgg.push(t);
      if (harvestedAgg.length >= 220) break;
    }
    curParsed = kroMergeSnippetsIntoParsedBase(
      curParsed,
      moreHarvest.snippets,
      channelDisplay || channelForOnce,
      moreHarvest.dated_posts,
    );
    const merged2 = kroHomeGreedyMergeSamplesFromParsed(curParsed, minR);
    curParsed = { ...curParsed, sample_posts: merged2, posts_fetched: merged2.length };
    if (Array.isArray(curParsed._sample_texts)) delete curParsed._sample_texts;
    const n2 = merged2.length;
    if (n2 <= n) break;
  }
  return { parsed: curParsed, harvestedExtra: harvestedAgg };
}

async function kroFetchTelegramPublicSnapshot(channelRef, opts = null) {
  const slug = kroExtractTelegramPublicSlug(channelRef);
  if (!slug) return null;
  const optObj = opts && typeof opts === 'object' ? opts : {};
  const budgetMs = Math.min(180000, Math.max(3000, Number(optObj.timeoutMs) || 15000));
  const logLabel = optObj.logLabel ? String(optObj.logLabel) : '';
  const logPrefix = logLabel ? `[KRO public-snapshot ${logLabel}]` : '[KRO public-snapshot]';
  const parseHtml = (html, rawHtml) => {
    if (!html || html.length < 100) return null;
    const titleM = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) || html.match(/<title>([^<]+)<\/title>/i);
    const title = titleM ? kroStripHtmlToText(titleM[1]).slice(0, 120) : '';
    const textRegexes = [
      /<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
      /<div[^>]*class="[^"]*js-message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
      /<div[^>]*class="[^"]*message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    ];
    let blocks = [];
    for (const rx of textRegexes) {
      const arr = [...html.matchAll(rx)];
      if (arr.length) {
        blocks = arr.map((x) => x[1]);
        break;
      }
    }
    let snippets = kroFilterPublicSnapshotSnippets(
      blocks.map((x) => kroStripHtmlToText(x)),
      slug,
    );
    if (!snippets.length) {
      const desc = kroExtractPublicChannelDescriptionFromHtml(html);
      if (desc) snippets = kroFilterPublicSnapshotSnippets([desc], slug);
    }
    if (!snippets.length) return null;
    const dated_posts = kroExtractDatedPostsFromPublicHtml(html, slug);
    return {
      slug,
      title,
      snippets,
      dated_posts,
      fetched_at: new Date().toISOString(),
      html: rawHtml,
    };
  };

  const urls = [
    `https://t.me/s/${encodeURIComponent(slug)}`,
    `https://t.me/${encodeURIComponent(slug)}`,
    `https://r.jina.ai/http://t.me/s/${encodeURIComponent(slug)}`,
    `https://r.jina.ai/http://t.me/${encodeURIComponent(slug)}`,
  ];
  const deadline = Date.now() + budgetMs;
  for (const url of urls) {
    const remaining = deadline - Date.now();
    if (remaining < 600) break;
    const ctl = new AbortController();
    const perUrlMs = Math.min(remaining, Math.max(2000, Math.floor(budgetMs / urls.length)));
    const t = setTimeout(() => ctl.abort(), perUrlMs);
    console.log(`${logPrefix} try url=${url} budget_ms=${perUrlMs}`);
    try {
      const r = await fetch(url, {
        signal: ctl.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; KRO-Analyze/1.0)',
          accept: 'text/html,application/xhtml+xml,text/plain',
        },
      });
      if (!r.ok) {
        console.log(`${logPrefix} url=${url} http_status=${r.status} ok=false`);
        continue;
      }
      const body = await r.text();
      const htmlLen = body ? body.length : 0;
      let parsed = parseHtml(body, body);
      if (!parsed || !parsed.snippets || !parsed.snippets.length) {
        const descOnly = kroExtractPublicChannelDescriptionFromHtml(body);
        if (descOnly) {
          const sn = kroFilterPublicSnapshotSnippets([descOnly], slug);
          if (sn.length) {
            parsed = {
              slug,
              title: '',
              snippets: sn,
              dated_posts: kroExtractDatedPostsFromPublicHtml(body, slug),
              fetched_at: new Date().toISOString(),
              html: body,
            };
          }
        }
      }
      if (!parsed || !parsed.snippets || !parsed.snippets.length) {
        parsed = null;
      }
      const snippetCount = parsed && Array.isArray(parsed.snippets) ? parsed.snippets.length : 0;
      console.log(
        `${logPrefix} url=${url} ok=true html_len=${htmlLen} snippets=${snippetCount} sample=${JSON.stringify((parsed && parsed.snippets && parsed.snippets[0]) ? parsed.snippets[0].slice(0, 180) : '')}`,
      );
      if (parsed && parsed.snippets && parsed.snippets.length) return parsed;
    } catch (e) {
      console.warn(`${logPrefix} url=${url} error=${e && e.message ? String(e.message) : 'fetch_failed'}`);
      /* try next source */
    } finally {
      clearTimeout(t);
    }
  }
  console.log(`${logPrefix} no_snippets_found slug=${slug}`);
  return null;
}

function kroFirstSnippetForSuspiciousRule(texts, rule) {
  const src = Array.isArray(texts) ? texts : [];
  for (const raw of src) {
    const s = String(raw || '').trim();
    if (s.length < 6) continue;
    const low = s.toLowerCase();
    const kw = rule.kws.find((k) => low.includes(k));
    if (!kw) continue;
    const clipped = s.length > 480 ? `${s.slice(0, 477)}…` : s;
    return { snippet: clipped, keyword: kw };
  }
  return null;
}

function kroCollectSuspiciousFlagsFromTexts(texts) {
  const joined = texts.join(' \n ').toLowerCase();
  const rules = [
    {
      code: 'guarantee',
      title: 'Обещания прибыли «без риска»',
      kws: ['100%', 'без риска', 'гарант', 'точно заработа'],
      weight: 24,
      explanation:
        'На честном рынке никто не может гарантировать доход: формулировки вроде «без риска», «точно окупится», «100%» часто говорят не о математике, а о том, что вам хотят продать доступ, курс или «вход в сделку».\n\n'
        + 'Смысл такого сообщения для читателя: снять осторожность и ускорить перевод денег. Имеет смысл остановиться и спросить себя: где здесь конкретно описан риск (стоп, размер позиции), а не только обещание результата.',
    },
    {
      code: 'vip_paid',
      title: 'Платный доступ и закрытый формат',
      kws: ['vip', 'вип', 'платн', 'подписк', 'доступ в канал'],
      weight: 16,
      explanation:
        'Платный VIP, подписка или «закрытый клуб» сами по себе не преступление, но в паре с обещаниями лёгких денег это типичная воронка: сначала интерес, потом оплата за «секрет», «сигналы» или «личное сопровождение».\n\n'
        + 'О чём это для вас: автор переводит разговор из «посмотри идею» в «заплати, чтобы узнать». Проверьте, есть ли в бесплатной части нормальное объяснение риска — или только реклама закрытки.',
    },
    {
      code: 'signal_push',
      title: 'Призывы к сделке без контекста',
      kws: ['сигнал', 'buy', 'sell', 'лонг', 'шорт'],
      weight: 15,
      explanation:
        'Короткие команды «лонг», «шорт», «сигнал», buy/sell без сценария и риска учат копировать сделки вслепую: вы не знаете, где выход, что считается ошибкой и какой размер позиции адекватен.\n\n'
        + 'Смысл для читателя: быстро нажать кнопку у биржи. Полезный контент обычно объясняет логику и условия, при которых идея перестаёт работать — не только «куда нажать».',
    },
    {
      code: 'fomo',
      title: 'Срочность и страх упустить',
      kws: ['срочно', 'успей', 'последний шанс', 'limited'],
      weight: 14,
      explanation:
        'Фразы «успей», «последний шанс», «только сегодня», limited создают давление: решение принимают на эмоциях, а не после проверки.\n\n'
        + 'Это не всегда мошенничество, но почти всегда повод остановиться. Смысл послания: «не думай долго» — а с деньгами как раз лучше думать спокойно и заранее.',
    },
    {
      code: 'x_promises',
      title: 'Обещания «иксов» и пампа',
      kws: ['x2', 'x5', 'x10', 'икс', 'памп'],
      weight: 18,
      explanation:
        'Обещания «x2», «x10», «памп» без разбора актива и условий — это картинка «лёгких денег». На практике резкий рост редко бывает без огромной волатильности и риска вылететь в ноль.\n\n'
        + 'Для вас это сигнал: вас готовят к азарту, а не к осознанному риску. Спросите себя, есть ли в посте хоть одно честное «можем и не дойти до цели».',
    },
  ];
  const flags = [];
  for (const rule of rules) {
    if (!rule.kws.some((kw) => joined.includes(kw))) continue;
    const ev = kroFirstSnippetForSuspiciousRule(texts, rule);
    const snRaw = ev ? String(ev.snippet).trim() : '';
    const snClean = kroHomeFilterStructuredQuote(snRaw);
    flags.push({
      code: rule.code,
      title: rule.title,
      explanation: rule.explanation,
      weight: rule.weight,
      evidence_snippet: snClean,
      matched_keyword: ev ? ev.keyword : '',
    });
  }
  let risk = flags.reduce((sum, x) => sum + x.weight, 0);
  const examples = [];
  for (const text of texts) {
    const low = String(text || '').toLowerCase();
    if (rules.some((r) => r.kws.some((kw) => low.includes(kw)))) {
      const clip = kroHomeFilterStructuredQuote(String(text).slice(0, 240));
      if (clip) examples.push(clip);
    }
    if (examples.length >= 5) break;
  }
  if (!examples.length && texts.length) {
    const fb = kroHomeFilterStructuredQuote(String(texts[0]).slice(0, 240));
    if (fb) examples.push(fb);
  }
  if (examples.length === 0) risk = null;
  return { flags, examples, risk };
}

function kroMapRiskToUiStatus(risk) {
  if (!Number.isFinite(risk)) return { status: 'Оценка не готова', code: 'UNAVAILABLE' };
  if (risk >= 70) return { status: 'Много тревожного в формулировках', code: 'DANGER' };
  if (risk >= 40) return { status: 'Есть поводы насторожиться', code: 'SUSPICIOUS' };
  return { status: 'По тексту спокойнее', code: 'SAFE' };
}

function kroV0MergeHomeQuickPublicSnapshotIntoFastAnalysis(analysis, snap) {
  if (!analysis || !snap || !Array.isArray(snap.snippets) || !snap.snippets.length) return;
  const current = Array.isArray(analysis.content_behavior) ? analysis.content_behavior : [];
  analysis.content_behavior = [
    `Короткая выборка с открытой страницы t.me/${snap.slug}: ${snap.snippets.length} фрагментов.`,
    `Пример: «${String(snap.snippets[0] || '').slice(0, 180)}».`,
    ...current,
  ].slice(0, 8);
  const src = Array.isArray(analysis.sources) ? analysis.sources : [];
  analysis.sources = ['публичная лента Telegram', ...src];
  if (!analysis.conclusion || typeof analysis.conclusion !== 'object') {
    analysis.conclusion = { status: KRO_V0_STATUS.watch, reasons: [] };
  }
  const reasons = Array.isArray(analysis.conclusion.reasons) ? analysis.conclusion.reasons : [];
  analysis.conclusion.reasons = [
    'Вывод дополнен реальными фрагментами постов публичной ленты канала.',
    ...reasons,
  ].slice(0, KRO_V0_MAX_CONCLUSION_REASONS);
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
        basic_info: ['Сводка мониторинга временно недоступна — персональную сверку по каналу сейчас не собрать.'],
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
          basic_info: ['Не удалось подключиться к источнику данных (нет доступа к Google).'],
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
      const watchMon = watchSummary.visible_total;
      const caption12 = `Потери за 12 ч: ${roll12.lossesSum.toLocaleString('ru-RU')} ₽ · подтверждённая база: ${scamBaseCounter.channels_total} · широкий мониторинг: ${watchMon}.`;
      const totalLostAllTime = scamBaseCounter.losses_12h;
      const shockTextLive =
        buildKroDocumentedShockText(totalLostAllTime, scamBaseCounter.channels_total) || KRO_PENDING_REPORT_TEXT;
      const staleWarnHours = Number(process.env.KRO_STALE_CYCLE_WARN_HOURS || 20);
      const cycleStaleNotice = kroBuildStaleCycleSiteNotice(
        cycleMeta.last_cycle_at,
        displayUpdatedAt,
        scamBaseCounter.updatedAt,
        staleWarnHours
      );
      const volMin = kroReadMinChannelsPerCycleFromEnv();
      const volMetric = (process.env.KRO_CYCLE_VOLUME_METRIC || 'either').trim().toLowerCase();
      const cycleVol = kroEvalCycleVolume(newInCycle, channelsScanned, volMin, volMetric);
      const cycleVolumeNotice = kroBuildCycleVolumeNotice(cycleVol);
      const siteNotices = [cycleStaleNotice, cycleVolumeNotice].filter(Boolean);
      const payload = {
        sheets_available: true,
        live_counter_degraded: false,
        live_counter_note_ru: null,
        channelsToday: channelsTodayVal,
        new_in_cycle_meta: newInCycle,
        channels_scanned_in_cycle: channelsScanned,
        cycle_volume_ok: cycleVol.min > 0 ? cycleVol.ok : true,
        cycle_volume_actual: cycleVol.actual,
        cycle_volume_required_min: cycleVol.min,
        cycle_volume_metric: cycleVol.metric,
        cycle_volume_new_in_base: cycleVol.new_in_base,
        cycle_volume_scanned: cycleVol.scanned,
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
        siteNotice: siteNotices.length ? siteNotices.join('\n\n') : null,
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
    const degradedNote =
      'Живой счётчик не подключён к Google Sheets: на Render не задан или неверен KRO_GOOGLE_CREDENTIALS_JSON (или не удалось инициализировать googleapis). Укажите JSON ключа сервисного аккаунта и доступ к таблице KRO_SHEET_ID.';
    return res.json({
      sheets_available: false,
      live_counter_degraded: true,
      live_counter_note_ru: degradedNote,
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
      siteNotice: degradedNote,
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
    const errNote =
      'Ошибка при чтении Google Sheets для live-counter. Проверьте логи Render, права сервисного аккаунта на таблицу и корректность KRO_SHEET_ID.';
    res.json({
      sheets_available: false,
      live_counter_degraded: true,
      live_counter_note_ru: errNote,
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
      siteNotice: errNote,
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

/** Лёгкая проверка «Render жив» без чтения Sheets (отладка /monitor). */
app.get('/api/kro/monitor-ping', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({ ok: true, t: new Date().toISOString() });
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
    const volMinM = kroReadMinChannelsPerCycleFromEnv();
    const volMetricM = (process.env.KRO_CYCLE_VOLUME_METRIC || 'either').trim().toLowerCase();
    const cycleVolM = kroEvalCycleVolume(
      metaBase.new_in_cycle,
      metaBase.channels_scanned_in_cycle,
      volMinM,
      volMetricM
    );
    const meta = {
      ...metaBase,
      ...freshness,
      cycle_volume_ok: cycleVolM.min > 0 ? cycleVolM.ok : true,
      cycle_volume_actual: cycleVolM.actual,
      cycle_volume_required_min: cycleVolM.min,
      cycle_volume_metric: cycleVolM.metric,
      cycle_volume_new_in_base: cycleVolM.new_in_base,
      cycle_volume_scanned: cycleVolM.scanned,
    };

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
      /** Время ответа API (страница опрашивается); не путать с last_cycle_at из kro_meta. */
      api_refreshed_at: new Date().toISOString(),
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

/** Регистрация Telethon StringSession для глубокого анализа через аккаунт посетителя (без очереди сервера). */
app.post('/api/kro/byo-deep/register', express.json({ limit: '120000' }), (req, res) => {
  if (!KRO_BYO_DEEP_ENABLED) {
    return res.status(404).json({ error: 'not_found' });
  }
  if (!(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH)) {
    return res.status(503).json({ error: 'telegram_not_configured', message_ru: 'Сервер не настроен для Telegram.' });
  }
  const raw = (req.body && req.body.session_string ? String(req.body.session_string) : '').trim();
  if (!raw || raw.length < 72) {
    return res.status(400).json({
      error: 'bad_session',
      message_ru: 'Строка сессии пустая или слишком короткая.',
    });
  }
  if (raw.length > 12000) {
    return res.status(400).json({ error: 'bad_session', message_ru: 'Строка сессии слишком длинная.' });
  }
  const ip = kroDeepGetClientId(req);
  if (!kroByoAllowRegister(ip)) {
    return res.status(429).json({
      error: 'rate_limited',
      message_ru: 'Слишком много попыток подключения с этого адреса. Попробуйте через час.',
    });
  }
  const scriptPath = join(__dirname, 'kro-worker', 'validate_byo_session_string.py');
  if (!fs.existsSync(scriptPath)) {
    return res.status(503).json({ error: 'validator_missing' });
  }
  const child = spawnSync('python3', [scriptPath], {
    cwd: join(__dirname, 'kro-worker'),
    encoding: 'utf8',
    timeout: 25000,
    env: {
      ...process.env,
      KRO_BYO_SESSION_STRING: raw,
      TELEGRAM_SESSION_STRING: raw,
      TELEGRAM_SESSION_B64: '',
    },
  });
  const stdout = (child.stdout || '').trim();
  const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
  let parsed;
  try {
    parsed = line ? JSON.parse(line) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.ok !== true) {
    return res.status(400).json({
      error: 'session_invalid',
      message_ru:
        'Не удалось подтвердить сессию в Telegram (не авторизована, устарела или сеть). Сгенерируйте новую строку сессии и попробуйте снова.',
      detail: parsed && parsed.error != null ? String(parsed.error) : null,
    });
  }
  kroByoPruneStore();
  const token = `kro_byo_${crypto.randomBytes(24).toString('hex')}`;
  kroByoSessionStore.set(token, { sessionString: raw, createdAt: Date.now() });
  const ttlMin = Math.max(1, Math.round(KRO_BYO_SESSION_TTL_MS / 60000));
  return res.status(200).json({
    ok: true,
    byo_token: token,
    ttl_minutes: ttlMin,
    telegram_user: parsed.username || null,
    message_ru: `Сессия принята примерно на ${ttlMin} мин. Запустите глубокий анализ — запрос пойдёт через ваш аккаунт; общий кэш глубокого на сервере не обновим.`,
  });
});

app.post('/api/kro/byo-deep/revoke', express.json({ limit: '8000' }), (req, res) => {
  if (!KRO_BYO_DEEP_ENABLED) {
    return res.status(404).json({ error: 'not_found' });
  }
  const token = (req.body && req.body.byo_token ? String(req.body.byo_token) : '').trim();
  if (token) kroByoSessionStore.delete(token);
  return res.status(200).json({ ok: true });
});

const anthropicApiKey = (process.env.ANTHROPIC_API_KEY || '').trim();

function kroExtractJsonObjectFromText(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function kroFetchSiteMentionsByUsername(usernameKey, budgetMs) {
  const slug = String(usernameKey || '').replace(/^@+/, '').trim();
  if (!slug) return [];
  const baseBudget = Math.min(10000, Math.max(1000, Number(budgetMs) || 4000));
  const q = encodeURIComponent(slug);
  const urls = [`https://vklader.com/?s=${q}`, `https://forteck.net/?s=${q}`];
  const out = [];
  let left = baseBudget;
  for (const url of urls) {
    if (left < 400) break;
    const ctl = new AbortController();
    const slice = Math.min(3500, left);
    const t = setTimeout(() => ctl.abort(), slice);
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        signal: ctl.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; KRO-Site/1.0)', accept: 'text/html,text/plain,*/*' },
      });
      const txt = await r.text();
      out.push({ url, ok: r.ok, preview: (txt || '').slice(0, 1200) });
    } catch (e) {
      out.push({ url, ok: false, error: (e && e.message) ? String(e.message).slice(0, 120) : 'fetch_error' });
    } finally {
      clearTimeout(t);
      left -= Date.now() - t0;
    }
  }
  return out;
}

/** Поиск по сайту (?s=) — страницы результатов по названию канала (любые упоминания, не только «чёрный список»). */
async function kroFetchSiteSearchMentionsQuery(queryRaw, budgetMs) {
  const q = String(queryRaw || '').trim();
  if (q.length < 3) return [];
  const baseBudget = Math.min(9000, Math.max(1200, Number(budgetMs) || 3500));
  const enc = encodeURIComponent(q.slice(0, 120));
  const urls = [
    { host: 'vklader.com', url: `https://vklader.com/?s=${enc}` },
    { host: 'forteck.net', url: `https://forteck.net/?s=${enc}` },
  ];
  const out = [];
  let left = baseBudget;
  for (const { host, url } of urls) {
    if (left < 380) break;
    const ctl = new AbortController();
    const slice = Math.min(4500, left);
    const t = setTimeout(() => ctl.abort(), slice);
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        signal: ctl.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; KRO-SiteSearch/1.0)',
          accept: 'text/html,text/plain,*/*',
        },
      });
      const txt = await r.text();
      const body = (txt || '').slice(0, 4000);
      out.push({
        host,
        url,
        ok: r.ok,
        http_status: r.status,
        mentioned: body.length > 120,
        preview: body.slice(0, 1400),
        kind: 'search',
      });
    } catch (e) {
      out.push({
        host,
        url,
        ok: false,
        http_status: undefined,
        mentioned: false,
        preview: '',
        kind: 'search',
        error: (e && e.message) ? String(e.message).slice(0, 100) : 'fetch_error',
      });
    } finally {
      clearTimeout(t);
      left -= Date.now() - t0;
    }
  }
  return out;
}

function kroDecodeBasicHtmlEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/** Полный https URL страницы инвайта (регистр хеша сохраняем). */
function kroTelegramInviteHttpsUrl(normalized, key) {
  const k = String(key || '').trim();
  if (!k.toLowerCase().startsWith('t.me/+')) return '';
  const n = String(normalized || '').trim();
  if (/^https?:\/\//i.test(n)) {
    try {
      const u = new URL(n);
      const host = (u.hostname || '').toLowerCase();
      if (host === 't.me' || host === 'telegram.me') {
        const path = (u.pathname || '').replace(/^\//, '');
        if (path.startsWith('+')) return `https://t.me/${path}`;
      }
    } catch {
      /* fallthrough */
    }
  }
  return `https://${k}`;
}

/** og:title / og:description со страницы t.me/+… (без аккаунта Telegram). */
function kroParseTelegramInviteOgFromHtml(html) {
  const h = String(html || '');
  const ogOne = (prop) => {
    const reA = new RegExp(`<meta[^>]*property=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
    let m = h.match(reA);
    if (m) return kroDecodeBasicHtmlEntities(m[1]);
    const reB = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${prop}["']`, 'i');
    m = h.match(reB);
    return m ? kroDecodeBasicHtmlEntities(m[1]) : '';
  };
  let title = String(ogOne('og:title') || '').trim();
  if (!title || /^telegram$/i.test(title)) {
    const tm = h.match(/<title[^>]*>([^<]{2,400})<\/title>/i);
    title = tm ? kroDecodeBasicHtmlEntities(tm[1]).trim() : '';
  }
  title = title
    .replace(/^Telegram:\s*/i, '')
    .replace(/\s+on Telegram\s*$/i, '')
    .replace(/\s*\|\s*Telegram\s*$/i, '')
    .replace(/\s*\u2014\s*Telegram\s*$/i, '')
    .trim();
  const description = String(ogOne('og:description') || '').trim();
  if (!title || title.length < 2 || /^telegram\s*$/i.test(title)) return null;
  return {
    title: title.slice(0, 200),
    description: description.slice(0, 480),
  };
}

async function kroFetchChannelMetaFromInvitePage(inviteUrl, timeoutMs) {
  const url = String(inviteUrl || '').trim();
  if (!/^https:\/\/(t\.me|telegram\.me)\//i.test(url)) return null;
  const ms = Math.min(12000, Math.max(1500, Number(timeoutMs) || 8000));
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
      timeout: ms,
      maxRedirects: 5,
      validateStatus: (st) => st >= 200 && st < 400,
      responseType: 'text',
    });
    const html = typeof response.data === 'string' ? response.data : String(response.data || '');
    return kroParseTelegramInviteOgFromHtml(html);
  } catch (e) {
    console.warn(`kroFetchChannelMetaFromInvitePage: ${(e && e.message) ? String(e.message).slice(0, 120) : 'error'}`);
    return null;
  }
}

async function kroInviteFetchDuckDuckGoHtmlSnippet(queryRaw, timeoutMs) {
  const q = String(queryRaw || '').trim();
  if (q.length < 2) return { ok: false, preview: '', url: '' };
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${q} telegram`)}`;
  const budget = Math.min(11000, Math.max(1200, Number(timeoutMs) || 4500));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), budget);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; KRO-InviteSearch/1.0)',
        accept: 'text/html,text/plain,*/*',
      },
    });
    const txt = await r.text();
    const plain = kroStripHtmlToText(txt.slice(0, 14000)).replace(/\s+/g, ' ').trim();
    return { ok: r.ok, preview: plain.slice(0, 1400), url };
  } catch (e) {
    return { ok: false, preview: '', url, error: (e && e.message) ? String(e.message).slice(0, 80) : 'fetch_error' };
  } finally {
    clearTimeout(t);
  }
}

async function kroInviteFetchGoogleHtmlSnippet(queryRaw, timeoutMs) {
  const q = String(queryRaw || '').trim();
  if (q.length < 2) return { ok: false, preview: '', url: '' };
  const url = `https://www.google.com/search?q=${encodeURIComponent(`${q} telegram канал`)}&hl=ru&num=8`;
  const budget = Math.min(11000, Math.max(1200, Number(timeoutMs) || 4500));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budget);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'ru-RU,ru;q=0.9',
      },
    });
    const txt = await r.text();
    const plain = kroStripHtmlToText(txt.slice(0, 16000)).replace(/\s+/g, ' ').trim();
    return { ok: r.ok, preview: plain.slice(0, 1400), url };
  } catch (e) {
    return { ok: false, preview: '', url, error: (e && e.message) ? String(e.message).slice(0, 80) : 'fetch_error' };
  } finally {
    clearTimeout(timer);
  }
}

async function kroInviteCollectExternalWebHints(channelName, budgetMs) {
  const items = [];
  let duck_ok = false;
  let google_ok = false;
  const cap = Math.min(9000, Math.max(600, Number(budgetMs) || 3500));
  const t0 = Date.now();
  if (KRO_INVITE_DDG_HTML_SEARCH) {
    const left = cap - (Date.now() - t0);
    if (left > 500) {
      const d = await kroInviteFetchDuckDuckGoHtmlSnippet(channelName, left - 80);
      duck_ok = d.ok === true && String(d.preview || '').length > 40;
      if (String(d.preview || '').trim()) {
        items.push({ source: 'duckduckgo_html', preview: String(d.preview).slice(0, 900), url: d.url });
      }
    }
  }
  if (KRO_INVITE_GOOGLE_SITE_SEARCH) {
    const left = cap - (Date.now() - t0);
    if (left > 500) {
      const g = await kroInviteFetchGoogleHtmlSnippet(channelName, left - 80);
      google_ok = g.ok === true && String(g.preview || '').length > 40;
      if (String(g.preview || '').trim()) {
        items.push({ source: 'google_html', preview: String(g.preview).slice(0, 900), url: g.url });
      }
    }
  }
  return { items, duck_ok, google_ok };
}

function kroBuildComplaintEvidenceSnippetLinesRu({ reports, siteSearchPages, extWeb }) {
  const lines = [];
  const nRep = Array.isArray(reports) ? reports.length : 0;
  if (nRep > 0) lines.push(`В таблице жалоб сервиса найдено записей: ${nRep}.`);
  const ssRich = (siteSearchPages || []).some((p) => p && String(p.preview || '').length > 140);
  if (ssRich) lines.push('На vklader/forteck есть страницы выдачи поиска по названию — см. превью в «Подробнее».');
  for (const it of (extWeb && extWeb.items) || []) {
    const pv = String(it.preview || '').replace(/\s+/g, ' ').trim();
    if (pv.length > 50 && lines.length < 8) {
      lines.push(`${String(it.source || 'web')}: ${pv.slice(0, 220)}`);
    }
  }
  return lines.slice(0, 8);
}

/** Три фразы как на главной — чтобы фронт совпадал с серверной шкалой. */
function kroBuildMoneyVerdictFromAnalyzePayload(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    return {
      tier: 'warn',
      headline_ru: 'БУДЬ ОСТОРОЖЕН — есть подозрительные моменты',
      status_code: null,
      risk_index: null,
    };
  }
  const code = String(bundle.status_code || '').toUpperCase();
  const risk = bundle.risk_index != null ? Number(bundle.risk_index) : null;
  const c =
    bundle.analysis && bundle.analysis.conclusion && typeof bundle.analysis.conclusion.status === 'string'
      ? String(bundle.analysis.conclusion.status || '')
      : '';
  const trIns = bundle.trust_report && bundle.trust_report.insufficient_feed === true;
  let tier = 'warn';
  if (c.includes('подтвержд') && c.includes('скам')) tier = 'danger';
  else if (code === 'DANGER' || (risk != null && Number.isFinite(risk) && risk >= 9)) tier = 'danger';
  else if (code === 'INSUFFICIENT_FEED' || code === 'UNAVAILABLE' || trIns) tier = 'warn';
  else if (code === 'SAFE' || c.includes('нарушений не видно') || (risk != null && Number.isFinite(risk) && risk <= 3 && code !== 'SUSPICIOUS'))
    tier = 'clean';
  else if (code === 'SUSPICIOUS' || (risk != null && Number.isFinite(risk) && risk >= 5)) tier = 'warn';
  const headlines = {
    danger: 'НЕ ДОВЕРЯЙ ДЕНЬГИ — есть серьёзные признаки мошенничества',
    warn: 'БУДЬ ОСТОРОЖЕН — есть подозрительные моменты',
    clean: 'ПОКА ВЫГЛЯДИТ ЧИСТО — явных признаков мошенничества не найдено',
  };
  return {
    tier,
    headline_ru: headlines[tier] || headlines.warn,
    status_code: bundle.status_code ?? null,
    risk_index: risk != null && Number.isFinite(risk) ? risk : null,
  };
}

/** GET https://host/username — быстрая проверка упоминаний (без Telegram). */
async function kroFetchMentionPathPage(host, slug, timeoutMs) {
  const cleanHost = String(host || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').trim();
  const cleanSlug = String(slug || '').replace(/^@+/, '').replace(/[^\w]/g, '').trim();
  if (!cleanHost || !cleanSlug) return { url: '', ok: false, preview: '', error: 'bad_url' };
  const url = `https://${cleanHost}/${encodeURIComponent(cleanSlug)}`;
  const budget = Math.min(15000, Math.max(800, Number(timeoutMs) || 8000));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), budget);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; KRO-HomeQuick/1.0)',
        accept: 'text/html,text/plain,*/*',
      },
    });
    const txt = await r.text();
    const body = (txt || '').slice(0, 4000);
    const low = body.toLowerCase();
    const needle = cleanSlug.toLowerCase();
    const mentioned = Boolean(needle && low.includes(needle));
    return { url, ok: r.ok, http_status: r.status, mentioned, preview: body.slice(0, 1200) };
  } catch (e) {
    return {
      url,
      ok: false,
      mentioned: false,
      preview: '',
      error: (e && e.message) ? String(e.message).slice(0, 120) : 'fetch_error',
    };
  } finally {
    clearTimeout(t);
  }
}

/** GET страницы по slug с кириллицей/пробелами (упоминание канала по названию на vklader/forteck). */
async function kroFetchMentionPathPageUnicode(host, pathSegment, timeoutMs) {
  const cleanHost = String(host || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').trim();
  const raw = String(pathSegment || '').replace(/^@+/, '').trim();
  if (!cleanHost || raw.length < 2) return { url: '', ok: false, preview: '', mentioned: false, error: 'bad_url' };
  const segEnc = raw.split('/').map((p) => encodeURIComponent(p)).join('/');
  const url = `https://${cleanHost}/${segEnc}`;
  const budget = Math.min(15000, Math.max(800, Number(timeoutMs) || 8000));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), budget);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; KRO-HomeQuick/1.0)',
        accept: 'text/html,text/plain,*/*',
      },
    });
    const txt = await r.text();
    const body = (txt || '').slice(0, 4000);
    const low = body.toLowerCase();
    const needle = raw.slice(0, 90).toLowerCase();
    let mentioned = needle.length >= 3 && low.includes(needle);
    if (!mentioned && needle.length >= 3) {
      const parts = raw.split(/\s+/).filter((x) => x.length >= 4);
      mentioned = parts.some((w) => low.includes(w.toLowerCase()));
    }
    return { url, ok: r.ok, http_status: r.status, mentioned, preview: body.slice(0, 1200) };
  } catch (e) {
    return {
      url,
      ok: false,
      mentioned: false,
      preview: '',
      error: (e && e.message) ? String(e.message).slice(0, 120) : 'fetch_error',
    };
  } finally {
    clearTimeout(t);
  }
}

function kroSanitizeChannelNameHint(raw) {
  return String(raw || '').trim().slice(0, 160);
}

/** Сегмент пути для сайтов: латиница или компактное имя с пробелами→дефис. */
function kroChannelNameHintPathSegment(hint) {
  const t = kroSanitizeChannelNameHint(hint);
  if (!t || t.length < 2) return '';
  const ascii = t.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (ascii.length >= 3) return ascii.toLowerCase();
  try {
    const compact = t.replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 90);
    return compact.replace(/^-+|-+$/g, '') || '';
  } catch {
    const fb = t.replace(/\s+/g, '-').replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, '').slice(0, 90);
    return fb.replace(/^-+|-+$/g, '') || '';
  }
}

function kroInviteManualFirstEnabled() {
  return !/^try_telethon/i.test(kroInviteClosedChannelMode);
}

function kroMapRuRiskLabelToConclusion(ru) {
  const s = String(ru || '').toLowerCase();
  if (s.includes('опасн') || s.includes('скам')) return KRO_V0_STATUS.scam;
  if (s.includes('чист') || s.includes('безопас')) return KRO_V0_STATUS.clean;
  if (s.includes('подозр') || s.includes('риск')) return KRO_V0_STATUS.risk;
  return KRO_V0_STATUS.watch;
}

async function kroAnalyzeChannelWithClaudeFast(payload, timeoutMs) {
  const apiKey = (anthropicApiKey || String(process.env.ANTHROPIC_API_KEY || '').trim());
  if (!apiKey) {
    console.warn('[KRO claude] ANTHROPIC_API_KEY is empty; skipping Claude analysis');
    return null;
  }
  const budget = Math.min(25000, Math.max(2000, Number(timeoutMs) || 8000));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), budget);
  const prompt = [
    'Ты аналитик по crypto Telegram-каналам. По JSON ниже о канале дай краткий вывод по признакам мошенничества.',
    'Ответь ТОЛЬКО одним JSON-объектом без markdown и без пояснений вне JSON. Поля:',
    '{"risk_index":0-100,"status_ru":"ОПАСНО|ПОДОЗРИТЕЛЬНО|БЕЗОПАСНО|ПОД НАБЛЮДЕНИЕМ",',
    '"flags":[{"code":"","title":"","explanation":""}],',
    '"citations":["короткие выписки из данных"],',
    '"basic_info_lines":["2-4 строки фактов"],',
    '"conclusion_reasons":["1-3 причины вывода"]}',
    '',
    'Данные:',
    JSON.stringify(payload).slice(0, 28000),
  ].join('\n');
  console.log(
    `[KRO claude] request budget_ms=${budget} payload=${JSON.stringify(payload).slice(0, 4000)}`,
  );
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.KRO_CLAUDE_MODEL || 'claude-3-5-haiku-20241022',
        max_tokens: 1200,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const j = await r.json();
    console.log(
      `[KRO claude] response http_status=${r.status} body=${JSON.stringify(j).slice(0, 4000)}`,
    );
    const txt = (j && j.content && j.content[0] && j.content[0].text) ? String(j.content[0].text) : '';
    const parsed = kroExtractJsonObjectFromText(txt);
    console.log(`[KRO claude] parsed_json=${JSON.stringify(parsed).slice(0, 2000)}`);
    return parsed;
  } catch (e) {
    console.warn(`[KRO claude] error=${e && e.message ? String(e.message) : 'request_failed'}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Секрет для Render Cron: POST /api/kro/process-live-queue (без Telegram, только Sheets + Claude). */
const kroLiveQueueCronSecret = (process.env.KRO_LIVE_QUEUE_CRON_SECRET || '').trim();

function kroLiveQueueCronAuthorized(req) {
  if (!kroLiveQueueCronSecret) return false;
  const hdr = String(req.get('x-kro-live-queue-secret') || req.get('X-KRO-LIVE-QUEUE-SECRET') || '').trim();
  if (hdr && hdr === kroLiveQueueCronSecret) return true;
  const q = String((req.query && req.query.secret) || '').trim();
  return q === kroLiveQueueCronSecret;
}

function kroPickPendingLiveCheckRequest(rows) {
  const arr = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < arr.length; i++) {
    const row = arr[i];
    const requestId = String((row[0] || '')).trim();
    const username = String((row[1] || '')).trim();
    const status = String((row[2] || '')).trim().toLowerCase();
    if (!requestId || !username || status !== 'pending') continue;
    const createdAt = String((row[4] || '')).trim();
    return { sheetRow: i + 2, requestId, username, createdAt };
  }
  return null;
}

/**
 * Псевдо-лента для GET /api/kro/check-result/:id без Telethon/t.me: scam_base, channels_watch, reports + Claude.
 * Внешние HTTP (site_mentions) не вызываем — только Google Sheets и Anthropic.
 */
async function kroBuildQueueSheetClaudeParsed(opts) {
  const {
    sheetsClient,
    key,
    channelDisplay,
    requestId,
    claudeBudgetMs,
  } = opts || {};
  const rawRows = await kroFetchScamBaseValuesCached(sheetsClient);
  const scamRows = rawRows
    .slice(1)
    .map(parseScamBaseRow)
    .filter((r) => r.username && channelMatchKey(r.username) === key)
    .map(enrichScamBaseContentAnalysisForMonitor);
  let latestProfile = null;
  if (scamRows.length) {
    latestProfile = scamRows.reduce((a, b) => (parseScamDetectedAtMs(a) >= parseScamDetectedAtMs(b) ? a : b));
  }
  const watchRow = await fetchLatestChannelsWatchRowForKey(sheetsClient, key);
  const displayCh = (latestProfile && latestProfile.username) ? latestProfile.username : channelDisplay;
  const reports = await getAllReportsForChannel(sheetsClient, displayCh);
  const claudePayload = {
    mode: 'queue_sheets_only',
    channel: channelDisplay,
    request_id: requestId,
    scam_base: latestProfile
      ? {
          status: latestProfile.status,
          verdict: latestProfile.verdict,
          risk_score: latestProfile.risk_score,
          complaints: latestProfile.complaints,
          source_primary: latestProfile.source_primary,
        }
      : null,
    channels_watch: watchRow
      ? {
          status: watchRow.status,
          activity_summary: watchRow.activity_summary,
          reviews_summary: watchRow.reviews_summary,
          status_reason: watchRow.status_reason,
        }
      : null,
    reports: reports.slice(0, 18).map((r) => ({
      date: r.date,
      description: (r.description || '').slice(0, 400),
      status: r.status,
      source: r.source,
    })),
    site_mentions: [],
  };
  const claudeJson = await kroAnalyzeChannelWithClaudeFast(claudePayload, Math.max(4000, Number(claudeBudgetMs) || 12000));
  const sampleBits = [];
  if (latestProfile && latestProfile.source_primary) {
    sampleBits.push(String(latestProfile.source_primary).trim().slice(0, 220));
  }
  for (const r of reports.slice(0, 6)) {
    const d = (r.description || '').trim();
    if (d) sampleBits.push(d.slice(0, 220));
  }
  if (Array.isArray(claudeJson && claudeJson.citations)) {
    for (const c of claudeJson.citations) {
      const t = String(c || '').trim();
      if (t) sampleBits.push(t.slice(0, 220));
    }
  }
  if (Array.isArray(claudeJson && claudeJson.basic_info_lines)) {
    for (const line of claudeJson.basic_info_lines) {
      const t = String(line || '').trim();
      if (t) sampleBits.push(t.slice(0, 220));
    }
  }
  const seen = new Set();
  const sample_posts = [];
  for (const s of sampleBits) {
    const k = s.slice(0, 120);
    if (seen.has(k)) continue;
    seen.add(k);
    sample_posts.push(s);
    if (sample_posts.length >= 24) break;
  }
  if (sample_posts.length < 5) {
    while (sample_posts.length < 5) {
      sample_posts.push(
        `[без постов ленты Telegram] ${channelDisplay}: только строки из scam_base / channels_watch / reports сервиса и при необходимости Claude.`,
      );
    }
  }
  const postsRead = sample_posts.length;
  return {
    found: true,
    _check_once_ok: true,
    read_path: claudeJson ? 'sheets_claude_queue' : 'sheets_only_queue',
    queue_fill_mode: claudeJson ? 'sheets_plus_claude' : 'sheets_only',
    username: String(channelDisplay || '').trim() || null,
    posts_fetched: postsRead,
    analysis_window_days: 30,
    sample_posts,
    claude_queue: claudeJson || null,
    queue_note_ru:
      'Лента Telegram на этом сервере недоступна; ответ собран из Google Sheets (scam_base, channels_watch, reports) и при возможности Claude. Это не замена чтению постов в канале.',
  };
}

/** Мини-проверка Anthropic (нужен KRO_LIVE_QUEUE_CRON_SECRET в заголовке или ?secret=). */
app.get('/api/kro/internal/claude-ping', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  if (!kroLiveQueueCronAuthorized(req)) {
    return res.status(403).json({
      ok: false,
      error: 'forbidden',
      message_ru: 'Нужен заголовок X-KRO-LIVE-QUEUE-SECRET или query ?secret=… как в KRO_LIVE_QUEUE_CRON_SECRET.',
    });
  }
  const apiKey = anthropicApiKey || String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(200).json({ ok: false, configured: false, message_ru: 'ANTHROPIC_API_KEY не задан.' });
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.KRO_CLAUDE_MODEL || 'claude-3-5-haiku-20241022',
        max_tokens: 32,
        temperature: 0,
        messages: [{ role: 'user', content: 'Ответь одним словом: pong' }],
      }),
    });
    const j = await r.json();
    const txt = (j && j.content && j.content[0] && j.content[0].text) ? String(j.content[0].text).trim() : '';
    return res.status(200).json({
      ok: r.ok,
      http_status: r.status,
      model: process.env.KRO_CLAUDE_MODEL || 'claude-3-5-haiku-20241022',
      reply_preview: txt.slice(0, 120),
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: (e && e.message) ? String(e.message) : 'request_failed',
    });
  } finally {
    clearTimeout(t);
  }
});

/**
 * Одна pending-строка kro_check_requests → done/failed. Для Render Cron: каждые 2 мин POST
 * с заголовком X-KRO-LIVE-QUEUE-SECRET (значение = KRO_LIVE_QUEUE_CRON_SECRET).
 */
app.post('/api/kro/process-live-queue', express.json({ limit: '4000' }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  if (!kroLiveQueueCronAuthorized(req)) {
    return res.status(403).json({
      ok: false,
      error: 'forbidden',
      message_ru: 'Укажите KRO_LIVE_QUEUE_CRON_SECRET на сервере и передайте тот же секрет в X-KRO-LIVE-QUEUE-SECRET.',
    });
  }
  const logId = `liveq:${Date.now().toString(36)}`;
  try {
    const sheetsClient = await getKroSheetsClient();
    if (!sheetsClient || !kroSheetId) {
      return res.status(503).json({ ok: false, error: 'sheets_unavailable', message_ru: 'Google Sheets недоступен.' });
    }
    const resp = await sheetsClient.sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: kroCheckRequestsRange,
    });
    const rows = resp.data.values || [];
    const pick = kroPickPendingLiveCheckRequest(rows);
    if (!pick) {
      console.log(`[KRO process-live-queue ${logId}] no_pending`);
      return res.status(200).json({ ok: true, processed: false, reason: 'no_pending' });
    }
    const { sheetRow, requestId, username, createdAt } = pick;
    const key = channelMatchKey(username);
    const channelDisplay = username.startsWith('@') ? username : `@${key}`;
    console.log(`[KRO process-live-queue ${logId}] picked row=${sheetRow} id=${requestId} user=${channelDisplay}`);

    const sheetTab = kroCheckRequestsRange.includes('!') ? kroCheckRequestsRange.split('!')[0] : 'kro_check_requests';
    await sheetsClient.sheets.spreadsheets.values.update({
      spreadsheetId: kroSheetId,
      range: `${sheetTab}!A${sheetRow}:E${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[requestId, username, 'running', '', createdAt]],
      },
    });

    const claudeBudget = Math.min(25000, Math.max(5000, parseInt(process.env.KRO_QUEUE_CLAUDE_BUDGET_MS || '14000', 10) || 14000));
    let parsed = null;
    let errText = '';
    try {
      parsed = await kroBuildQueueSheetClaudeParsed({
        sheetsClient,
        key,
        channelDisplay,
        requestId,
        claudeBudgetMs: claudeBudget,
      });
    } catch (e) {
      errText = (e && e.message) ? String(e.message).slice(0, 400) : 'queue_build_failed';
      console.error(`[KRO process-live-queue ${logId}] build_error`, e);
    }
    if (!parsed || typeof parsed !== 'object') {
      parsed = {
        found: false,
        error: errText || 'queue_build_failed',
        read_path: 'sheets_queue_failed',
      };
    }
    const status = parsed.found === true && Number(parsed.posts_fetched || 0) >= 1 ? 'done' : 'failed';
    const resultJson = JSON.stringify(parsed);
    await sheetsClient.sheets.spreadsheets.values.update({
      spreadsheetId: kroSheetId,
      range: `${sheetTab}!A${sheetRow}:E${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[requestId, username, status, resultJson, createdAt]],
      },
    });
    console.log(`[KRO process-live-queue ${logId}] done status=${status} posts=${Number(parsed.posts_fetched || 0)}`);
    return res.status(200).json({
      ok: true,
      processed: true,
      request_id: requestId,
      username: channelDisplay,
      sheet_row: sheetRow,
      result_status: status,
      read_path: parsed.read_path || null,
    });
  } catch (e) {
    console.error(`[KRO process-live-queue ${logId}] fatal`, e);
    return res.status(500).json({ ok: false, error: 'internal_error', message_ru: 'Ошибка обработки очереди.' });
  }
});

function kroCheckQueueRequestId(channelKey) {
  return `krochk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}_${channelKey}`;
}

function kroCheckRequestRowById(rows, requestId) {
  if (!requestId) return null;
  for (const r of rows || []) {
    const rid = String((r[0] || '')).trim();
    if (!rid || rid !== requestId) continue;
    return {
      id: rid,
      username: String((r[1] || '')).trim(),
      status: String((r[2] || '')).trim().toLowerCase() || 'pending',
      result_raw: String((r[3] || '')).trim(),
      created_at: String((r[4] || '')).trim() || null,
    };
  }
  return null;
}

function kroBuildAnalyzeResponseFromParsed(parsed, key, requestId) {
  const payload = parsed && typeof parsed === 'object' ? parsed : {};
  const postsRead = Number(payload.posts_fetched || 0) || 0;
  const periodDays = Number(payload.analysis_window_days || 0) || null;
  const readPath = String(payload.read_path || 'telethon').trim() || 'telethon';
  if (payload.found !== true || postsRead < 1) {
    return {
      queue_status: 'done',
      request_id: requestId,
      posts_read: postsRead,
      period_days: periodDays,
      read_path: readPath,
      status: 'Оценка не готова',
      status_code: 'UNAVAILABLE',
      risk_index: null,
      analysis: {
        v: 0,
        channel_key: key,
        generated_at: new Date().toISOString(),
        sources: ['GitHub Actions Telethon'],
        basic_info: ['Не удалось прочитать текст постов в этом запуске.'],
        content_behavior: [],
        external_reports: [],
        ties_risk_factors: [],
        conclusion: { status: 'анализ ленты не выполнен', reasons: ['Нужно хотя бы одно нормальное текстовое сообщение.'] },
      },
      live_evidence: {
        live_pass: false,
        mode: readPath,
        reason: 'Посты в этом запуске не прочитаны.',
        sample_posts: [],
      },
      message: 'Анализ завершён без ленты: посты в этом запуске не прочитаны.',
    };
  }
  if (postsRead < 5) {
    const samplePosts = (Array.isArray(payload.sample_posts) ? payload.sample_posts : [])
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    return {
      queue_status: 'done',
      request_id: requestId,
      posts_read: postsRead,
      period_days: periodDays,
      read_path: readPath,
      status: 'Оценка не готова',
      status_code: 'UNAVAILABLE',
      risk_index: null,
      risk_index_max: 10,
      analysis: {
        v: 0,
        channel_key: key,
        generated_at: new Date().toISOString(),
        sources: ['GitHub Actions Telethon'],
        basic_info: [
          `Успели прочитать только ${postsRead} постов с текстом.`,
          'Для нормальной оценки нужно хотя бы пять осмысленных сообщений.',
        ],
        content_behavior: [],
        external_reports: [],
        ties_risk_factors: [],
        conclusion: {
          status: 'мало данных',
          reasons: ['Шкалу риска и тип канала не ставим: слишком мало текста в выборке.'],
        },
      },
      citations: samplePosts,
      live_evidence: {
        live_pass: true,
        mode: readPath,
        reason: `Прочитано ${postsRead} сообщений с текстом; этого мало для оценки риска.`,
        sample_posts: samplePosts,
      },
      message: `Мало текста для оценки: прочитано ${postsRead} постов, нужно минимум пять.`,
    };
  }
  const analysis = kroV0BuildAnalysisFromLiveParsed(payload, key);
  const textsForFast = Array.isArray(payload._sample_texts) && payload._sample_texts.length
    ? payload._sample_texts.map((x) => String(x || ''))
    : (Array.isArray(payload.sample_posts) ? payload.sample_posts.map((x) => String(x || '')) : []);
  const fastHuman = kroBuildFastCriteriaFromTexts(textsForFast, {
    hasSignalOffer: payload.has_signal_offer === true,
    onlyProfitsFlag: payload.only_profits_flag === true,
    fomoPct: payload.fomo_pct,
    adsRatio: payload.ads_ratio,
  });
  const risk = fastHuman.score10;
  const hasEvidence = kroHasStrongPostEvidence(payload, fastHuman);
  const userReport = kroBuildUserFacingLiveReport(payload, fastHuman, {
    postsRead,
    periodDays,
    hasPostEvidence: hasEvidence,
  });
  analysis.basic_info = [
    `Канал: @${key}`,
    `Кратко по выборке: ${fastHuman.channelType || 'смешанная картина по тексту'}.`,
    `Чем занимается канал: ${fastHuman.topicLine}`,
    `Прочитано ${postsRead} сообщений с текстом за период до ${periodDays || 30} дней.`,
  ].filter(Boolean);
  analysis.content_behavior = [
    ...kroFormatFastCriteriaLines(fastHuman.criteria),
    `Постов про прибыль: ${userReport.numbers && userReport.numbers.profits_posts_count != null ? userReport.numbers.profits_posts_count : 0}; про убытки: ${userReport.numbers && userReport.numbers.losses_posts_count != null ? userReport.numbers.losses_posts_count : 0}.`,
    `Упоминаний платного доступа: ${userReport.numbers && userReport.numbers.paid_access_mentions_count != null ? userReport.numbers.paid_access_mentions_count : 0}; гарантий и «без риска»: ${userReport.numbers && userReport.numbers.guarantee_mentions_count != null ? userReport.numbers.guarantee_mentions_count : 0}.`,
    `Тон «продажи» в начале и сейчас: ${userReport.time_analysis && userReport.time_analysis.sales_tone_early_score != null ? userReport.time_analysis.sales_tone_early_score : 0} и ${userReport.time_analysis && userReport.time_analysis.sales_tone_recent_score != null ? userReport.time_analysis.sales_tone_recent_score : 0} из 100.`,
    ...fastHuman.citations.map((x) => `Пример из ленты: «${String(x).slice(0, 220)}»`),
  ].slice(0, 8);
  analysis.external_reports = ['Вывод только по тексту постов канала, собранному при проверке.'];
  analysis.ties_risk_factors = ['Жалобы и внешние базы в основу статуса здесь не входили — только текст канала.'];
  if (userReport.scam_similarity && userReport.scam_similarity.label) {
    analysis.ties_risk_factors.push(String(userReport.scam_similarity.label));
  }
  const forceScam = String(payload.risk_verdict || '').toLowerCase() === 'scam' && hasEvidence;
  analysis.conclusion = {
    status: kroConclusionStatusFromEvidence(risk, hasEvidence, { forceScam }),
    reasons: [
      `Оценка по тексту ${Math.round(risk)}/10. Явных красных флагов в формулировках: ${hasEvidence ? 'есть' : 'нет'}. ${fastHuman.summaryLine}`,
      ...fastHuman.reasons,
    ].slice(0, KRO_V0_MAX_CONCLUSION_REASONS),
  };
  const ui = kroMapRiskDisplayToUiStatus(risk, hasEvidence);
  const textsForFlags = textsForFast.some((x) => String(x || '').trim())
    ? textsForFast
    : (Array.isArray(payload.sample_posts) ? payload.sample_posts.map((x) => String(x || '')) : []);
  const signalFast = kroCollectSuspiciousFlagsFromTexts(textsForFlags);
  return {
    queue_status: 'done',
    request_id: requestId,
    posts_read: postsRead,
    period_days: periodDays,
    read_path: readPath,
    status: ui.status,
    status_code: ui.code,
    risk_index: risk,
    risk_index_max: 10,
    risk_has_post_evidence: hasEvidence,
    flags: Array.isArray(signalFast.flags) ? signalFast.flags : [],
    citations: userReport.quotes,
    user_report: userReport,
    analysis,
    live_evidence: {
      live_pass: true,
      mode: readPath,
      reason: `Прочитано ${postsRead} сообщений с текстом.`,
      sample_posts: (Array.isArray(payload.first_impression_posts) && payload.first_impression_posts.length
        ? payload.first_impression_posts
        : fastHuman.citations).slice(0, 3).map((x) => String(x || '').trim()).filter(Boolean),
      posts_fetched: postsRead,
      analysis_window_days: periodDays,
    },
    live_metrics: {
      posts_fetched: postsRead,
      analysis_window_days: periodDays,
      home_quick_live: true,
    },
    analysis_basis: {
      label: 'Вывод по тексту постов, собранных при проверке (Telethon).',
      sources_used: ['telethon', 'github_actions'],
      read_path: readPath,
      posts_read: postsRead,
    },
    message: `Оценка ${Math.round(risk)}/10. ${fastHuman.channelType || 'Смешанная картина по тексту'}. Итог по свежим постам.`,
  };
}

function kroCheckQueueStatusByRows(rows, usernameKey, requestId) {
  let latest = null;
  for (const r of rows || []) {
    const rid = String((r[0] || '')).trim();
    const uname = String((r[1] || '')).trim();
    const ts = String((r[2] || '')).trim();
    const st = String((r[3] || '')).trim().toLowerCase();
    if (!rid || !uname) continue;
    if (requestId && rid !== requestId) continue;
    if (!requestId && channelMatchKey(uname) !== usernameKey) continue;
    if (!latest || Date.parse(ts) >= Date.parse(latest.requested_at || '1970-01-01T00:00:00Z')) {
      latest = {
        request_id: rid,
        username: uname,
        requested_at: ts || null,
        status: st || 'pending',
        started_at: String((r[4] || '')).trim() || null,
        finished_at: String((r[5] || '')).trim() || null,
        error: String((r[6] || '')).trim() || null,
      };
    }
  }
  return latest;
}

function kroCheckResultByRows(rows, usernameKey, requestId) {
  let latest = null;
  for (const r of rows || []) {
    const rid = String((r[0] || '')).trim();
    const uname = String((r[1] || '')).trim();
    const ts = String((r[2] || '')).trim();
    const st = String((r[3] || '')).trim().toLowerCase();
    if (!rid || !uname) continue;
    if (requestId && rid !== requestId) continue;
    if (!requestId && channelMatchKey(uname) !== usernameKey) continue;
    if (!latest || Date.parse(ts) >= Date.parse(latest.created_at || '1970-01-01T00:00:00Z')) {
      let payload = null;
      const raw = String((r[8] || '')).trim();
      if (raw) {
        try { payload = JSON.parse(raw); } catch { payload = null; }
      }
      latest = {
        request_id: rid,
        username: uname,
        created_at: ts || null,
        status: st || 'done',
        posts_read: Number(r[4] || 0) || 0,
        period_days: Number(r[5] || 0) || null,
        read_path: String((r[6] || '')).trim() || null,
        risk_index: Number.isFinite(Number(r[7])) ? Number(r[7]) : null,
        payload,
      };
    }
  }
  return latest;
}

function kroBuildAnalyzeDoneResponse(doneRow, key) {
  const parsed = doneRow && doneRow.payload && typeof doneRow.payload === 'object' ? doneRow.payload : null;
  const base = parsed && typeof parsed === 'object' ? { ...parsed } : {};
  if (!Number.isFinite(Number(base.posts_fetched))) {
    base.posts_fetched = Number(doneRow && doneRow.posts_read || 0) || 0;
  }
  if (!Number.isFinite(Number(base.analysis_window_days))) {
    base.analysis_window_days = Number(doneRow && doneRow.period_days || 0) || null;
  }
  if (!base.read_path && doneRow && doneRow.read_path) {
    base.read_path = doneRow.read_path;
  }
  const response = kroBuildAnalyzeResponseFromParsed(base, key, doneRow && doneRow.request_id ? doneRow.request_id : null);
  const readPath = String((response && response.read_path) || '').trim().toLowerCase();
  const postsRead = Number(response && response.posts_read);
  const livePass = response && response.live_evidence && response.live_evidence.live_pass === true;
  const livePathAllowed =
    readPath === 'telethon' ||
    readPath === 'telethon+public_snapshot' ||
    readPath === 'public_snapshot' ||
    readPath === 'public_content_fallback';
  const liveEnough = Number.isFinite(postsRead) && postsRead >= 3;
  // Принцип для главной: без живого чтения постов не выдаём «успешный быстрый анализ».
  if (!livePass || !livePathAllowed || !liveEnough) {
    return {
      queue_status: 'failed',
      request_id: response && response.request_id ? response.request_id : (doneRow && doneRow.request_id ? doneRow.request_id : null),
      status: 'Оценка не готова',
      status_code: 'UNAVAILABLE',
      posts_read: Number.isFinite(postsRead) ? postsRead : 0,
      period_days: response && response.period_days != null ? response.period_days : null,
      read_path: readPath || 'unknown',
      fast_live_required: true,
      message:
        'Ленту в этом запуске разобрать не удалось. Нужно хотя бы пять постов с нормальным текстом. ' +
        'Повторите запрос или запустите полный разбор на странице канала.',
      message_ru:
        'Не удалось прочитать ленту как нужно. Для короткого отчёта нужно минимум пять текстовых постов; иначе — полный разбор (до ~30 минут).',
      live_evidence: {
        live_pass: false,
        mode: readPath || 'unknown',
        reason:
          Number.isFinite(postsRead) && postsRead > 0
            ? `Прочитано ${postsRead} постов — для краткой оценки этого мало.`
            : 'Посты канала в этот раз не прочитаны.',
        sample_posts:
          response && response.live_evidence && Array.isArray(response.live_evidence.sample_posts)
            ? response.live_evidence.sample_posts.slice(0, 2)
            : [],
      },
    };
  }
  return response;
}

function kroBuildAnalyzeFastTimeoutResponse(requestId, username, elapsedMs) {
  const hardLimitSec = Math.round(KRO_ANALYZE_FAST_MAX_MS / 1000);
  const elapsedSec = Math.max(0, Math.round(Number(elapsedMs || 0) / 1000));
  const u = String(username || '').trim();
  return {
    queue_status: 'failed',
    request_id: requestId || null,
    username: u || null,
    status: 'Оценка не готова',
    status_code: 'UNAVAILABLE',
    read_path: 'fast_timeout',
    posts_read: 0,
    period_days: null,
    message:
      `Сработал лимит времени (${hardLimitSec} с), запрос остановлен.` +
      ` Прошло около ${elapsedSec} с — для короткой оценки данных не хватило.`,
    message_ru:
      'Не хватило времени на быстрый разбор (до 7 минут). Для глубокого варианта откройте страницу канала (до ~30 минут).',
    fast_timeout: true,
    fast_timeout_limit_seconds: hardLimitSec,
    elapsed_seconds: elapsedSec,
  };
}

function kroMergeSnippetsIntoParsedBase(parsedBase, extraSnippets, channelDisplay, extraDatedPosts) {
  const b = parsedBase && typeof parsedBase === 'object' ? { ...parsedBase } : {};
  const cur = Array.isArray(b.sample_posts) ? b.sample_posts.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const seen = new Set(cur.map((x) => x.slice(0, 400)));
  const out = cur.slice();
  for (const raw of extraSnippets || []) {
    const t = String(raw || '').trim();
    if (t.length < 8) continue;
    const k = t.slice(0, 400);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t.slice(0, 220));
  }
  b.sample_posts = out;
  b.posts_fetched = out.length;
  b.username = b.username || String(channelDisplay || '').trim() || null;
  if (Array.isArray(extraDatedPosts) && extraDatedPosts.length) {
    b.sample_posts_dated = kroNormalizeDatedPostsInput(
      { sample_posts_dated: [...(Array.isArray(b.sample_posts_dated) ? b.sample_posts_dated : []), ...extraDatedPosts] },
      out,
    );
  }
  if (out.length >= 1) {
    b.found = true;
    b._check_once_ok = true;
  }
  if (out.length >= 3) {
    delete b.not_crypto;
  }
  return b;
}

/**
 * Объект parsed только из публичной ленты (t.me/s или предварительно собранные snippets).
 * Нужен, когда Telethon не дал текста: без этой функции ответ «ленту не прочитали» даже при открытом канале.
 */
function kroBuildParsedFromPublicSnapshotOnly(rawSnap, channelDisplay, minPosts) {
  const need = Math.max(1, Number(minPosts) || 1);
  const snap = rawSnap && typeof rawSnap === 'object' ? rawSnap : null;
  if (!snap) return null;
  let snippets = [];
  if (Array.isArray(snap.snippets)) {
    snippets = snap.snippets.map((x) => String(x || '').trim()).filter(Boolean);
  }
  if (snippets.length < need) return null;
  const sample_posts = snippets.slice(0, Math.min(120, snippets.length));
  const datedRaw = Array.isArray(snap.dated_posts) ? snap.dated_posts : [];
  const sample_posts_dated = datedRaw.length
    ? datedRaw.slice(0, Math.min(120, datedRaw.length))
    : sample_posts.map((t) => ({ text: t, date_iso: null }));
  return {
    found: true,
    _check_once_ok: true,
    username: String(channelDisplay || '').trim() || null,
    posts_fetched: sample_posts.length,
    sample_posts,
    sample_posts_dated,
    analysis_window_days: 30,
    read_path: 'public_snapshot',
    has_signal_offer: false,
    only_profits_flag: false,
    fomo_pct: null,
    ads_ratio: null,
    risk_verdict: null,
  };
}

/** Дополняет sample_posts из полного _sample_texts (greedy режим отдаёт длинный текст, сниппеты могли обрезаться). */
function kroHomeGreedyMergeSamplesFromParsed(parsed, minUnique) {
  const need = Math.max(1, Number(minUnique) || 1);
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  let out = Array.isArray(p.sample_posts) ? p.sample_posts.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (out.length >= need) return out;
  const full = Array.isArray(p._sample_texts) ? p._sample_texts : [];
  const seen = new Set(out.map((x) => x.slice(0, 400)));
  for (const raw of full) {
    const s = String(raw || '').trim().replace(/\n/g, ' ');
    if (s.length < 12) continue;
    const sn = s.slice(0, 220);
    const key = sn.slice(0, 400);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sn);
    if (out.length >= Math.min(160, need + 80)) break;
  }
  return out;
}

/** Один запуск check_once в режиме home_greedy: жадное чтение ленты по monotonic-бюджету внутри Python. */
function kroRunHomeGreedyTelethonOnce(channelForOnce, deadline, telethonBudgetMs, logLabel) {
  const t0 = perfNow();
  const b = Math.max(
    5000,
    Math.min(Number(telethonBudgetMs) || 0, Math.max(0, deadline - Date.now() - 600)),
  );
  const mono = String(Math.min(7 * 60 * 1000, Math.floor(b)));
  const spawnSlack = Math.min(180000, Math.max(45000, Math.floor(b * 0.22 + 35000)));
  const spawnTimeout = Math.min(1800000, b + spawnSlack);
  const once = kroRunCheckOnce(channelForOnce, {
    readOnly: true,
    periodDays: 180,  // 6 месяцев — читаем всю доступную историю в рамках бюджета
    timeoutMs: spawnTimeout,
    checkOnceEnv: {
      KRO_CHECK_ONCE_MODE: 'home_greedy',
      KRO_CHECK_ONCE_MONO_MS: mono,
      KRO_HOME_GREEDY_KEEP_SAMPLE_TEXTS: '1',
    },
  });
  const parsed = kroNormalizeCheckOnceForAnalysis(once);
  const wallMs = Math.round(perfNow() - t0);
  const pr = Number(parsed.posts_fetched || 0);
  console.log(
    `[KRO analyze-channel ${logLabel}] home_greedy wall=${wallMs}ms budget=${b}ms spawn_timeout=${spawnTimeout} ok=${parsed._check_once_ok === true} found=${parsed.found === true} posts_read=${pr}`,
  );
  return { parsed, budgetMs: b, wallMs };
}

/** Оценка «сколько текста» вернул greedy (чтобы выбрать лучший проход и решить о повторе). */
function kroGreedyParsedTextScore(p) {
  if (!p || typeof p !== 'object') return 0;
  if (p._check_once_ok !== true || p.found !== true) return 0;
  const n = Number(p.posts_fetched || 0);
  const sp = Array.isArray(p.sample_posts) ? p.sample_posts.filter(Boolean).length : 0;
  const tx = Array.isArray(p._sample_texts) ? p._sample_texts.filter(Boolean).length : 0;
  return Math.max(n, sp, tx);
}

/**
 * До трёх проходов home_greedy: повторяем, если обрезало по таймауту или мало текста — пока есть окно sync.
 */
function kroRunHomeGreedyTelethonBestEffort(channelForOnce, deadline, telethonReserveMs, analyzeLogId, minPostsHint) {
  const need = Math.max(1, Number(minPostsHint) || 1);
  let parsed = null;
  let budgetMs = 0;
  let wallMs = 0;
  for (let pass = 1; pass <= 3; pass++) {
    const remain = deadline - Date.now();
    if (remain < (pass === 3 ? 8000 : 7000)) break;
    const slice = Math.min(Number(telethonReserveMs) || 0, Math.max(5000, remain - 900));
    const tel = kroRunHomeGreedyTelethonOnce(channelForOnce, deadline, slice, `${analyzeLogId}:greedy${pass}`);
    budgetMs += tel.budgetMs;
    wallMs += tel.wallMs;
    if (!parsed || kroGreedyParsedTextScore(tel.parsed) > kroGreedyParsedTextScore(parsed)) {
      parsed = tel.parsed;
    }
    const sc = kroGreedyParsedTextScore(parsed);
    const timedOut = parsed && parsed.check_once_timed_out === true;
    if (parsed && sc >= need && !timedOut) break;
    if (pass >= 3) break;
    if (deadline - Date.now() < (pass === 1 ? 12000 : 10000)) break;
  }
  const finalParsed = parsed || kroNormalizeCheckOnceForAnalysis({ ok: false, parsed: null, error: 'telethon_not_run' });
  console.log(
    `[KRO analyze-channel ${analyzeLogId}] greedy_best_effort score=${kroGreedyParsedTextScore(finalParsed)} budget_sum=${budgetMs}ms wall_sum=${wallMs}ms timed_out=${finalParsed.check_once_timed_out === true}`,
  );
  return { parsed: finalParsed, budgetMs, wallMs };
}

/** Фрагменты «как лента» из уже имеющихся данных (без выдумывания постов Telegram). */
function kroBuildEvidenceSnippetsFromDataset(opts) {
  const { latestProfile, reports, channelDisplay } = opts || {};
  const out = [];
  const push = (s) => {
    const t = String(s || '').trim();
    if (t.length < 12) return;
    out.push(t.slice(0, 420));
  };
  if (latestProfile) {
    push(latestProfile.source_primary);
    push(latestProfile.source_secondary);
    push(latestProfile.quote);
    const st = String(latestProfile.status || '').trim();
    if (st) push(`Статус в базе сервиса: ${st}.`);
  }
  const repArr = Array.isArray(reports) ? reports : [];
  for (const r of repArr.slice(0, 12)) {
    const d = (r.description || '').trim();
    if (d) push(d);
  }
  const seen = new Set();
  const uniq = [];
  for (const s of out) {
    const k = s.slice(0, 80);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
    if (uniq.length >= 28) break;
  }
  return uniq;
}

function kroPadEvidenceSnippetsToMin(snippets, minN, channelDisplay) {
  const n = Math.max(1, Number(minN) || 5);
  const arr = Array.isArray(snippets) ? [...snippets] : [];
  const ch = String(channelDisplay || '').trim() || 'канал';
  const honest = [
    `${ch}: в этом запуске не удалось получить текст постов с открытой страницы или через клиент Telegram на сервере.`,
    'Ниже — только реальные строки из нашей базы и жалоб; мы не подставляем выдуманные посты.',
    'Если канал открытый — можно свериться глазами на t.me рядом с этим ответом.',
    'Более полный разбор ленты — на странице канала (глубокий режим), когда доступна очередь.',
    'Повторите проверку через некоторое время, если был временный сбой сети.',
  ];
  let hi = 0;
  while (arr.length < n) {
    arr.push(honest[hi % honest.length]);
    hi += 1;
  }
  return arr.slice(0, Math.max(n, arr.length));
}

function kroBuildParsedFromDatasetSnippets(snippets, channelDisplay) {
  const posts = kroPadEvidenceSnippetsToMin(snippets, 5, channelDisplay);
  return {
    found: true,
    _check_once_ok: true,
    username: String(channelDisplay || '').trim() || null,
    posts_fetched: posts.length,
    sample_posts: posts,
    analysis_window_days: 30,
    read_path: 'dataset_evidence',
    has_signal_offer: false,
    only_profits_flag: false,
    fomo_pct: null,
    ads_ratio: null,
    risk_verdict: null,
    data_feed_note_ru:
      'Открытая страница канала или клиент Telegram на сервере в этом запуске не вернули текст постов. Ниже — реальные фрагменты из базы и жалоб; это опора для осторожности, не замена живой ленты.',
  };
}

function kroBuildAnalyzeChannelLiveSuccessBundle(opts) {
  const {
    withQueueMeta,
    channelDisplay,
    key,
    watchRow,
    reports,
    parsedForFast,
    sampleForFast,
    postsRead,
    readPathOut,
    telBudgetMs,
    t0,
    trustReportExtra,
    claudeOverlay,
    telegramUsernameResolve,
    personBehind,
    signalAccuracy,
  } = opts || {};
  const inviteVoiceRu =
    String(key || '').trim().toLowerCase().startsWith('t.me/+') &&
    readPathOut !== 'invite_manual_sheets_sites'
      ? 'Приватный канал по инвайт-ссылке: лента читается после join через аккаунт Telegram на сервере; публичная веб-страница без входа недоступна — опора на Telethon, не на t.me/s.'
      : '';
  const trustVoicePrefix = [inviteVoiceRu, trustReportExtra && trustReportExtra.editor_voice_prefix_ru
    ? String(trustReportExtra.editor_voice_prefix_ru).trim()
    : ''].filter(Boolean).join(' ');
  const analysis = kroV0BuildAnalysisFromLiveParsed(parsedForFast, key);
  if (watchRow) kroV0EnrichAnalysisWithWatch(analysis, watchRow);
  let signal = kroCollectSuspiciousFlagsFromTexts(sampleForFast);
  let fastHuman = kroBuildFastCriteriaFromTexts(sampleForFast, {
    hasSignalOffer: parsedForFast.has_signal_offer === true,
    onlyProfitsFlag: parsedForFast.only_profits_flag === true,
    fomoPct: parsedForFast.fomo_pct,
    adsRatio: parsedForFast.ads_ratio,
  });
  let risk = kroHomeCalmScoreIfNoStructuralTriggers(fastHuman.score10, fastHuman.criteria);
  let statusObj = kroMapFastRisk10ToUiStatus(risk);
  const co = claudeOverlay && typeof claudeOverlay === 'object' ? claudeOverlay : null;
  if ((readPathOut === 'sheets_sites_claude' || readPathOut === 'invite_manual_sheets_sites') && co) {
    const r100 = Number(co.risk_index);
    if (Number.isFinite(r100)) {
      const r10 = Math.max(0, Math.min(10, Math.round(r100 / 10)));
      risk = kroHomeCalmScoreIfNoStructuralTriggers(r10, fastHuman.criteria);
      statusObj = kroMapFastRisk10ToUiStatus(risk);
    }
    const stRu = String(co.status_ru || '').trim();
    if (stRu) {
      analysis.conclusion = analysis.conclusion && typeof analysis.conclusion === 'object' ? analysis.conclusion : { status: KRO_V0_STATUS.watch, reasons: [] };
      analysis.conclusion.status = kroMapRuRiskLabelToConclusion(stRu);
    }
    if (Array.isArray(co.basic_info_lines) && co.basic_info_lines.length) {
      const extra = co.basic_info_lines.map((x) => String(x || '').trim()).filter(Boolean);
      analysis.basic_info = [`Канал: ${channelDisplay}`, ...extra].slice(0, 8);
    }
    if (Array.isArray(co.conclusion_reasons) && co.conclusion_reasons.length) {
      analysis.conclusion = analysis.conclusion && typeof analysis.conclusion === 'object' ? analysis.conclusion : { status: KRO_V0_STATUS.watch, reasons: [] };
      analysis.conclusion.reasons = [
        ...co.conclusion_reasons.map((x) => String(x || '').trim()).filter(Boolean),
        ...(analysis.conclusion.reasons || []),
      ].slice(0, KRO_V0_MAX_CONCLUSION_REASONS);
    }
    if (Array.isArray(co.flags) && co.flags.length) {
      const ties = co.flags.map((f) => `${String(f.title || f.code || 'флаг').trim()}: ${String(f.explanation || '').trim()}`.trim()).filter(Boolean);
      if (ties.length) analysis.ties_risk_factors = ties.slice(0, 8);
    }
    const claudeCites = Array.isArray(co.citations)
      ? co.citations.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
      : [];
    if (claudeCites.length) {
      const behave = claudeCites.map((x) => `Claude (по данным): «${x.slice(0, 220)}»`);
      analysis.content_behavior = [...behave, ...(Array.isArray(analysis.content_behavior) ? analysis.content_behavior : [])].slice(0, 10);
    }
    const claudeFlagObjs = Array.isArray(co.flags)
      ? co.flags
        .filter((f) => f && (f.title || f.code))
        .map((f) => ({
          code: String(f.code || 'claude').trim() || 'claude',
          title: String(f.title || f.code || 'Фактор').trim(),
          explanation: String(f.explanation || '').trim() || 'По смыслу из ответа модели.',
          weight: 12,
          evidence_snippet: '',
          matched_keyword: '',
        }))
        .slice(0, 6)
      : [];
    if (claudeFlagObjs.length) {
      signal = { flags: claudeFlagObjs, examples: claudeCites, risk: null };
    }
    fastHuman = {
      ...fastHuman,
      summaryLine: stRu || fastHuman.summaryLine,
      citations: claudeCites.length ? claudeCites : fastHuman.citations,
    };
  }
  const feedSample = kroHomeReadPathIsChannelFeedSample(readPathOut);
  const postsReadN = Number(postsRead) || 0;
  const trustSampleMaxChars = Math.max(
    0,
    ...(Array.isArray(sampleForFast) ? sampleForFast.map((s) => String(s || '').trim().length) : []),
  );
  const strongPostEvidence = (signal.flags || []).some((f) => {
    const sn = f && f.evidence_snippet ? String(f.evidence_snippet).trim() : '';
    return kroHomeFilterStructuredQuote(sn).length >= 16;
  });
  const weakFeedNoScore =
    feedSample &&
    postsReadN === 1 &&
    !strongPostEvidence &&
    trustSampleMaxChars < 140 &&
    String(parsedForFast.risk_verdict || '').toLowerCase() !== 'scam';

  analysis.basic_info = [
    `Канал: ${channelDisplay}`,
    `Чем занимается канал: ${fastHuman.topicLine}`,
    readPathOut === 'invite_manual_sheets_sites'
      ? `Быстрый разбор: таблицы и жалобы (по @каналу, по тексту подсказки/инвайта в жалобе) + страницы vklader.com и forteck.net (прямой путь и поиск ?s= по названию) + Claude. Ленту Telegram не запрашивали.`
      :     readPathOut === 'sheets_sites_claude'
      ? `Быстрый разбор (~30 с): таблицы сервиса + страницы vklader.com и forteck.net (прямой путь и поиск ?s=, если запрос достаточно длинный) + Claude. Посты Telegram не запрашивали.`
      : readPathOut === 'dataset_evidence'
        ? `Разобрано ${postsRead} фрагментов из базы и жалоб; текст постов с открытой страницы или через клиент Telegram в этом запуске не собрали — используйте блок ниже как дополнение к просмотру канала вручную.`
        : `Прочитано ${postsRead} сообщений с текстом за период до ${Number(parsedForFast.analysis_window_days || 30)} дней.`,
    ...(Array.isArray(analysis.basic_info) ? analysis.basic_info.slice(1, 3) : []),
  ].filter(Boolean).slice(0, 6);
  const citeLab =
    readPathOut === 'dataset_evidence' || readPathOut === 'sheets_sites_claude' || readPathOut === 'invite_manual_sheets_sites'
      ? 'Фрагмент из данных'
      : 'Пример из ленты';
  analysis.content_behavior = [
    ...kroFormatFastCriteriaLines(fastHuman.criteria),
    ...fastHuman.citations.map((x) => `${citeLab}: «${String(x).slice(0, 220)}»`),
  ].filter(Boolean).slice(0, 8);
  analysis.external_reports = reports.length
    ? [
        `В сервисе ${reports.length} записей по каналу — как дополнение к тексту ленты.`,
        ...reports.slice(0, 2).map((r) => {
          const desc = String(r.description || '').trim();
          return desc ? `Из жалоб: ${desc.slice(0, 180)}${desc.length > 180 ? '…' : ''}` : '';
        }).filter(Boolean),
      ].slice(0, 3)
    : ['Жалоб по каналу в базе нет — оценка всё равно по тексту постов.'];
  analysis.ties_risk_factors = signal.flags.length
    ? signal.flags.map((f) => `${f.title}: ${f.explanation}`)
    : ['По сообщениям не видно явных «гарантий», жёсткой суеты и платного VIP.'];
  analysis.conclusion = {
    status: kroMapFastRisk10ToConclusion(risk, {
      forceScam: String(parsedForFast.risk_verdict || '').toLowerCase() === 'scam',
    }),
    reasons: [
      `Риск ${risk}/10: ${fastHuman.summaryLine}`,
      ...fastHuman.reasons,
    ].filter(Boolean).slice(0, KRO_V0_MAX_CONCLUSION_REASONS),
  };
  if (weakFeedNoScore) {
    risk = null;
    statusObj = { status: 'Мало текста в выборке', code: 'INSUFFICIENT_FEED' };
    analysis.conclusion = {
      status: KRO_V0_STATUS.watch,
      reasons: [
        'В выборку попал один пост с текстом; числовую оценку по ленте не ставим — так честнее, чем «угадывать» по одной строке.',
        ...fastHuman.reasons.slice(0, 2),
      ].filter(Boolean).slice(0, KRO_V0_MAX_CONCLUSION_REASONS),
    };
  } else if (risk != null && Number.isFinite(Number(risk))) {
    fastHuman = { ...fastHuman, score10: Number(risk) };
  }
  const complaintsFormCount = reports.filter((r) => (r.source || '').toLowerCase() === 'form').length;
  const complaintsRowsTotal = Array.isArray(reports) ? reports.length : 0;
  const telSec = Math.max(0, Math.round(Number(telBudgetMs || 0) / 1000));
  const liveReason =
    readPathOut === 'invite_manual_sheets_sites'
      ? `Приватный инвайт: scam_base, объединённые строки листа reports (канал / подсказка / ссылка инвайта в тексте), GET vklader и forteck по имени и поиск по сайту (?s=), затем Claude. Telegram не использовали.`
      : readPathOut === 'sheets_sites_claude'
      ? `За один ответ: scam_base, channels_watch, объединённые reports, GET vklader.com/${key} и forteck.net/${key}, при возможности поиск ?s= на тех же сайтах, затем Claude. Telegram не использовали.`
      : readPathOut === 'dataset_evidence'
        ? `Собрано ${postsRead} фрагментов из базы и жалоб; открытая лента или клиент Telegram на сервере в этом запросе не вернули текст — см. также страницу канала.`
        : readPathOut === 'public_snapshot'
        ? `Считано ${postsRead} фрагментов с текстом с открытой страницы канала (t.me/s); API Telegram на сервере в этом запуске не использовали.`
        : readPathOut === 'telethon+public_snapshot'
          ? `Считано ${postsRead} фрагментов с текстом: чтение в Telegram до ~${telSec} с плюс открытая страница.`
          : `Считано ${postsRead} фрагментов с текстом (чтение в Telegram, до ~${telSec} с).`;
  const basisLabel =
    readPathOut === 'invite_manual_sheets_sites'
      ? 'Оценка по данным из Google Sheets и внешних страниц (при указании названия — поиск по имени); лента Telegram по инвайту здесь не читается.'
      : readPathOut === 'sheets_sites_claude'
      ? 'Оценка по данным из Google Sheets, двух внешних страниц и Claude; лента Telegram не читалась.'
      : readPathOut === 'dataset_evidence'
        ? 'Оценка по строкам из базы и жалоб; живые посты канала в этот ответ не подключали — при открытом канале сверьтесь с t.me.'
        : readPathOut === 'public_snapshot'
        ? 'Вывод по тексту с открытой страницы канала (публичные фрагменты ленты).'
        : readPathOut === 'telethon+public_snapshot'
          ? 'Вывод по тексту из Telegram; при нехватке объёма добавлены фрагменты с открытой страницы.'
          : 'Вывод по тексту сообщений из Telegram.';
  const basisSources =
    readPathOut === 'sheets_sites_claude' || readPathOut === 'invite_manual_sheets_sites'
      ? ['scam_base', 'channels_watch', 'reports', 'vklader.com', 'forteck.net', 'site_search (?s=)', 'claude']
      : readPathOut === 'dataset_evidence'
        ? ['scam_base', 'channels_watch', 'reports']
        : readPathOut === 'public_snapshot'
        ? ['t.me/s']
        : readPathOut === 'telethon+public_snapshot'
          ? ['telethon', 't.me/s']
          : ['telethon'];
  const homeLivePass = kroHomeReadPathIsChannelFeedSample(readPathOut);
  const riskLine = risk == null || !Number.isFinite(Number(risk))
    ? 'оценка по шкале не выставлена (мало постов в выборке).'
    : `оценка ${risk}/10.`;
  const completedIso = new Date().toISOString();
  analysis.generated_at_iso = completedIso;
  if (Array.isArray(analysis.basic_info)) {
    analysis.basic_info.push(`Ответ сформирован на сервере: ${completedIso} (UTC).`);
  }
  return withQueueMeta({
    queue_status: 'done_sync',
    analysis_completed_at_iso: completedIso,
    analysis,
    status: statusObj.status,
    status_code: statusObj.code,
    risk_index: risk,
    risk_index_max: 10,
    posts_read: postsRead,
    period_days: Number(parsedForFast.analysis_window_days || 30),
    read_path: readPathOut,
    flags: signal.flags,
    citations: fastHuman.citations.slice(0, 3),
    trust_report: kroHomeBuildTrustReportBundle({
      risk10: risk,
      statusCode: statusObj.code,
      flags: signal.flags,
      livePass: homeLivePass,
      postsRead,
      complaintsCount: complaintsRowsTotal,
      criteriaRows: fastHuman.criteria,
      readPathOut,
      citationFallbacks: Array.isArray(fastHuman.citations) ? fastHuman.citations : [],
      trustSampleMaxChars,
      voice: {
        topicLine: fastHuman.topicLine,
        channelType: fastHuman.channelType,
        leadLine: fastHuman.summaryLine,
      },
      editor_voice_prefix_ru: trustVoicePrefix,
    }),
    live_evidence: {
      live_pass: homeLivePass,
      mode: readPathOut,
      reason: liveReason,
      sample_posts: sampleForFast.slice(0, 3),
      sample_posts_dated: kroNormalizeDatedPostsInput(parsedForFast, sampleForFast).slice(0, 14),
      channel_feed_url: kroExtractTelegramPublicSlug(channelDisplay || key)
        ? `https://t.me/s/${kroExtractTelegramPublicSlug(channelDisplay || key)}`
        : null,
      posts_fetched: postsRead,
      analysis_window_days: Number(parsedForFast.analysis_window_days || 30),
    },
    live_metrics: {
      posts_fetched: postsRead,
      analysis_window_days: Number(parsedForFast.analysis_window_days || 30),
      home_quick_live: homeLivePass,
      complaints_count: complaintsRowsTotal,
      complaints_via_form_count: complaintsFormCount,
      target_posts_min: KRO_HOME_ANALYZE_MIN_POSTS,
      sync_budget_ms: KRO_ANALYZE_CHANNEL_SYNC_MS,
    },
    analysis_basis: {
      label: basisLabel,
      sources_used: basisSources,
      read_path: readPathOut,
      posts_read: postsRead,
      elapsed_ms: Date.now() - t0,
    },
    message: `${channelDisplay}: ${riskLine} ${fastHuman.summaryLine}`,
    person_behind: personBehind || undefined,
    signal_accuracy: signalAccuracy || undefined,
    ...(telegramUsernameResolve && telegramUsernameResolve.resolved_slug
      ? {
          telegram_username_resolve: {
            resolved_slug: telegramUsernameResolve.resolved_slug,
            input_raw: telegramUsernameResolve.input_raw || null,
            tried_slugs: telegramUsernameResolve.tried_slugs || [],
            page_title_ru: telegramUsernameResolve.page_title_ru || null,
            method: telegramUsernameResolve.method || null,
          },
        }
      : {}),
  });
}

/**
 * Приватный канал t.me/+… в режиме manual_first: без Telethon, таблицы + vklader/forteck по названию + Claude + честный CTA со скриншотами.
 */
async function kroAnalyzeClosedInviteChannelHandler(req, res, opts) {
  const { t0, key, normalized, analyzeLogId, channelNameHint, telegramUsernameResolve } = opts;
  const inviteUrl = kroTelegramInviteHttpsUrl(normalized, key);
  let hintWorking = kroSanitizeChannelNameHint(channelNameHint || '');
  let inviteOgMeta = null;
  /** @type {'user_hint' | 'telegram_invite_html' | null} */
  let inviteTitleSource = hintWorking.length >= 3 ? 'user_hint' : null;

  const quickBudgetMs = KRO_HOME_QUICK_MS;
  const deadline = t0 + quickBudgetMs;

  if (hintWorking.length < 3 && inviteUrl && deadline - Date.now() > 2500) {
    const ogBudget = Math.min(8500, Math.max(2200, deadline - Date.now() - 1500));
    inviteOgMeta = await kroFetchChannelMetaFromInvitePage(inviteUrl, ogBudget);
    if (inviteOgMeta && inviteOgMeta.title) {
      hintWorking = kroSanitizeChannelNameHint(inviteOgMeta.title);
      inviteTitleSource = 'telegram_invite_html';
    }
  }

  const hintRaw = hintWorking;
  const channelDisplay = kroAnalyzeChannelUiLabel(normalized, key);

  const withQueueMeta = (payload) => ({
    ...payload,
    request_id: null,
    deep_pending: false,
    deep_status: 'off',
    deep_note:
      'Приватный канал по инвайт-ссылке: автоматическое чтение ленты на этом деплое недоступно. Используем базу и сайты (если указано название канала). Пришлите скриншоты постов для ручного разбора.',
  });

  console.log(
    `[KRO analyze-channel ${analyzeLogId}] invite_manual channel=${channelDisplay} hint_len=${hintRaw.length} og_title=${inviteTitleSource === 'telegram_invite_html' ? 'yes' : 'no'}`,
  );

  const sheetsClient = await getKroSheetsClient();
  if (!sheetsClient || !kroSheetId) {
    return res.status(503).json({ error: 'sheets_unavailable', message_ru: 'Google Sheets недоступен.' });
  }

  const rawRows = await kroFetchScamBaseValuesCached(sheetsClient);
  const parsedRows = rawRows.slice(1).map(parseScamBaseRow).filter((r) => r.username);
  const scamRowsInvite = parsedRows.filter((r) => channelMatchKey(r.username) === key);
  const hl = hintRaw.length >= 3 ? hintRaw.toLowerCase() : '';
  let scamRowsHint = [];
  if (hl) {
    scamRowsHint = parsedRows.filter((r) => {
      const u = String(r.username || '').toLowerCase();
      const q = String(r.quote || '').toLowerCase();
      const sp = String(r.source_primary || '').toLowerCase();
      return u.includes(hl) || q.includes(hl) || sp.includes(hl);
    });
  }
  let latestProfile = null;
  if (scamRowsInvite.length) {
    latestProfile = scamRowsInvite.reduce((a, b) => (parseScamDetectedAtMs(a) >= parseScamDetectedAtMs(b) ? a : b));
  } else if (scamRowsHint.length) {
    latestProfile = scamRowsHint.reduce((a, b) => (parseScamDetectedAtMs(a) >= parseScamDetectedAtMs(b) ? a : b));
  }
  if (latestProfile) latestProfile = enrichScamBaseContentAnalysisForMonitor(latestProfile);

  const watchRow = await fetchLatestChannelsWatchRowForKey(sheetsClient, key);

  const displayCh = (latestProfile && latestProfile.username) ? latestProfile.username : channelDisplay;
  const reports = await getAllReportsForChannelMerged(sheetsClient, displayCh, key, hintRaw);

  const nameSeg = kroChannelNameHintPathSegment(hintRaw);
  const emptyPage = { url: '', ok: false, mentioned: false, preview: '', http_status: undefined };
  const perSite = Math.floor(Math.max(2500, deadline - Date.now() - 9000) / 2);
  const searchBudget = Math.min(5000, Math.max(1200, deadline - Date.now() - perSite * 2 - 6500));
  const extBudget = Math.min(4500, Math.max(700, deadline - Date.now() - perSite * 2 - 7800));
  const searchQuery =
    (hintRaw && hintRaw.length >= 3)
      ? hintRaw
      : (nameSeg && String(nameSeg).length >= 3 ? String(nameSeg) : '');
  const searchQueriesList = kroSiteSearchQueriesVariants({
    hintSan: searchQuery,
    slugKey: nameSeg && String(nameSeg).length >= 3 ? String(nameSeg) : '',
  });

  async function kroBestMentionFetch(host, segment, budget) {
    const [a, u] = await Promise.all([
      kroFetchMentionPathPage(host, segment, budget),
      kroFetchMentionPathPageUnicode(host, segment, budget),
    ]);
    const pa = String(a.preview || '').length;
    const pu = String(u.preview || '').length;
    return pu > pa ? u : a;
  }

  const pathPairPromise = nameSeg
    ? Promise.all([
        kroBestMentionFetch('vklader.com', nameSeg, perSite),
        kroBestMentionFetch('forteck.net', nameSeg, perSite),
      ])
    : Promise.resolve([emptyPage, emptyPage]);

  const searchPromise =
    searchQueriesList.length
      ? kroFetchSiteSearchMentionsMulti(searchQueriesList, searchBudget)
      : Promise.resolve([]);

  const extHintQuery = searchQueriesList[0] || searchQuery;
  const externalPromise =
    extHintQuery.length >= 3 && (KRO_INVITE_DDG_HTML_SEARCH || KRO_INVITE_GOOGLE_SITE_SEARCH) && deadline - Date.now() > 4200
      ? kroInviteCollectExternalWebHints(extHintQuery, extBudget)
      : Promise.resolve({ items: [], duck_ok: false, google_ok: false });

  const [[vkPage, ftPage], siteSearchPages, extWeb] = await Promise.all([
    pathPairPromise,
    searchPromise,
    externalPromise,
  ]);

  const claudePayload = {
    mode: 'invite_closed_manual',
    channel: channelDisplay,
    slug: key,
    channel_name_hint: hintRaw || null,
    invite_only: true,
    invite_meta_from_telegram_html: inviteOgMeta
      ? {
          title: inviteOgMeta.title,
          description: String(inviteOgMeta.description || '').slice(0, 420),
        }
      : null,
    invite_title_extract_source: inviteTitleSource,
    invite_page_url: inviteUrl || null,
    external_web_hints: (extWeb.items || []).slice(0, 4),
    scam_base: latestProfile
      ? {
          status: latestProfile.status,
          verdict: latestProfile.verdict,
          risk_score: latestProfile.risk_score,
          complaints: latestProfile.complaints,
          source_primary: latestProfile.source_primary,
          quote: latestProfile.quote,
        }
      : null,
    channels_watch: watchRow
      ? {
          status: watchRow.status,
          activity_summary: watchRow.activity_summary,
          reviews_summary: watchRow.reviews_summary,
          status_reason: watchRow.status_reason,
        }
      : null,
    reports: reports.slice(0, 24).map((r) => ({
      date: r.date,
      description: (r.description || '').slice(0, 400),
      status: r.status,
      source: r.source,
    })),
    site_pages: [
      {
        host: 'vklader.com',
        url: vkPage.url,
        http_status: vkPage.http_status,
        ok: vkPage.ok,
        mentioned: vkPage.mentioned,
        preview: String(vkPage.preview || '').slice(0, 2000),
      },
      {
        host: 'forteck.net',
        url: ftPage.url,
        http_status: ftPage.http_status,
        ok: ftPage.ok,
        mentioned: ftPage.mentioned,
        preview: String(ftPage.preview || '').slice(0, 2000),
      },
    ],
    site_search_pages: (siteSearchPages || []).map((p) => ({
      host: p.host,
      url: p.url,
      ok: p.ok,
      http_status: p.http_status,
      mentioned: p.mentioned,
      preview: String(p.preview || '').slice(0, 2000),
      kind: p.kind || 'search',
      query: p.search_query != null ? p.search_query : searchQuery || null,
    })),
  };

  const claudeRemain = Math.max(2000, deadline - Date.now() - 300);
  const claudeJson = await kroAnalyzeChannelWithClaudeFast(claudePayload, claudeRemain);
  console.log(
    `[KRO analyze-channel ${analyzeLogId}] invite_manual claude_ok=${!!claudeJson} vk_ok=${vkPage.ok} ft_ok=${ftPage.ok} site_search_n=${(siteSearchPages || []).length} ext_web=${(extWeb.items || []).length} duck=${extWeb.duck_ok} google=${extWeb.google_ok}`,
  );

  const evidenceSnips = kroBuildEvidenceSnippetsFromDataset({
    latestProfile,
    reports,
    channelDisplay: displayCh,
  });
  const pathSnips = [];
  if (vkPage.preview) {
    pathSnips.push(
      `[HTML vklader по названию «${hintRaw || nameSeg || key}», http ${vkPage.http_status || '—'}] ${String(vkPage.preview).slice(0, 700)}`,
    );
  }
  if (ftPage.preview) {
    pathSnips.push(
      `[HTML forteck по названию «${hintRaw || nameSeg || key}», http ${ftPage.http_status || '—'}] ${String(ftPage.preview).slice(0, 700)}`,
    );
  }
  if (Array.isArray(siteSearchPages)) {
    for (const sp of siteSearchPages) {
      if (sp.preview) {
        pathSnips.push(
          `[HTML ${sp.host} поиск «${sp.search_query != null ? sp.search_query : searchQuery}», http ${sp.http_status || '—'}] ${String(sp.preview).slice(0, 700)}`,
        );
      }
    }
  }
  if (Array.isArray(extWeb.items)) {
    for (const ew of extWeb.items) {
      if (ew.preview) {
        pathSnips.push(
          `[${String(ew.source || 'web')}] ${String(ew.preview).slice(0, 700)}`,
        );
      }
    }
  }
  const mergedSnips = [...evidenceSnips, ...pathSnips];
  const parsedSimple = kroBuildParsedFromDatasetSnippets(mergedSnips, displayCh);
  parsedSimple.read_path = 'invite_manual_sheets_sites';
  const sampleArr = Array.isArray(parsedSimple.sample_posts)
    ? parsedSimple.sample_posts.filter(Boolean)
    : [];
  const postsN = sampleArr.length || Number(parsedSimple.posts_fetched || 0) || 0;

  const voicePrefix =
    `Приватный канал по инвайт-ссылке: ленту Telegram здесь не читаем. За ~${Math.round(quickBudgetMs / 1000)} с: ${inviteTitleSource === 'telegram_invite_html' ? 'название из HTML страницы инвайта (og:title), ' : ''}scam_base${hintRaw ? ' (поиск по названию)' : ''}, объединённые жалобы (reports), GET vklader/forteck${nameSeg ? ` по пути «${nameSeg}»` : ' (без названия — прямой путь не запрашивали)'}${searchQueriesList.length ? `, поиск на сайтах ?s= (${searchQueriesList.slice(0, 4).map((q) => `«${String(q).slice(0, 48)}»`).join(', ')})` : ''}${(extWeb.items || []).length ? ', доп. веб-поиск (DuckDuckGo/Google по env)' : ''}, затем Claude.`;
  const trustBundle = kroBuildAnalyzeChannelLiveSuccessBundle({
    withQueueMeta,
    channelDisplay,
    key,
    watchRow,
    reports,
    parsedForFast: parsedSimple,
    sampleForFast: sampleArr,
    postsRead: postsN,
    readPathOut: 'invite_manual_sheets_sites',
    telBudgetMs: 0,
    t0,
    trustReportExtra: { editor_voice_prefix_ru: voicePrefix },
    claudeOverlay: claudeJson,
    telegramUsernameResolve,
  });

  const screenshotHelp = {
    telegram_bot_url: kroScreenshotHelpBotUrl || null,
    form_url: kroScreenshotHelpFormUrl || null,
    upload_anchor: '#kro-check-screenshot-row',
  };

  const money_verdict = kroBuildMoneyVerdictFromAnalyzePayload(trustBundle);
  const complaint_evidence = {
    invite_channel_title_auto_ru: inviteOgMeta && inviteOgMeta.title ? inviteOgMeta.title : null,
    invite_title_extract_source: inviteTitleSource,
    invite_description_snippet_ru: inviteOgMeta && inviteOgMeta.description ? inviteOgMeta.description.slice(0, 280) : null,
    invite_page_url: inviteUrl || null,
    reports_sheet_rows: reports.length,
    site_search_used: searchQueriesList.length > 0,
    external_web_duck_ok: extWeb.duck_ok === true,
    external_web_google_ok: extWeb.google_ok === true,
    snippet_lines_ru: kroBuildComplaintEvidenceSnippetLinesRu({ reports, siteSearchPages, extWeb }),
  };

  return res.status(200).json({
    ...trustBundle,
    claude_home_quick: claudeJson,
    private_invite_channel: true,
    closed_channel_notice_ru: KRO_CLOSED_INVITE_NOTICE_RU,
    screenshot_help: screenshotHelp,
    invite_channel_name_hint_used: hintRaw || null,
    invite_site_lookup_segment: nameSeg || null,
    money_verdict,
    complaint_evidence,
  });
}

/**
 * Резерв: только таблицы + GET vklader/forteck + Claude (~KRO_HOME_QUICK_MS), без Telegram.
 * Включить: KRO_HOME_ANALYZE_MODE=quick_sheets_only
 */
async function kroAnalyzeChannelQuickSheetsSitesHandler(req, res, opts) {
  const { t0, key, normalized, analyzeLogId, channelNameHint, telegramUsernameResolve } = opts;
  const channelHintSan = kroSanitizeChannelNameHint(channelNameHint || '');
  const quickBudgetMs = KRO_HOME_QUICK_MS;
  const deadline = t0 + quickBudgetMs;
  const channelDisplay = kroAnalyzeChannelUiLabel(normalized, key);
  const withQueueMeta = (payload) => ({
    ...payload,
    request_id: null,
    deep_pending: false,
    deep_status: 'off',
    deep_note: `Режим quick_sheets_only (~${Math.round(quickBudgetMs / 1000)} с): таблицы + vklader.com/${key} + forteck.net/${key} + Claude. Ленту Telegram не читаем.`,
  });
  console.log(`[KRO analyze-channel ${analyzeLogId}] home_quick_sheets_sites_claude channel=${channelDisplay} budget_ms=${quickBudgetMs}`);

  const sheetsClient = await getKroSheetsClient();
  if (!sheetsClient || !kroSheetId) {
    return res.status(503).json({ error: 'sheets_unavailable', message_ru: 'Google Sheets недоступен.' });
  }

  const rawRows = await kroFetchScamBaseValuesCached(sheetsClient);
  const scamRows = rawRows
    .slice(1)
    .map(parseScamBaseRow)
    .filter((r) => r.username && channelMatchKey(r.username) === key)
    .map(enrichScamBaseContentAnalysisForMonitor);
  let latestProfile = null;
  if (scamRows.length) {
    latestProfile = scamRows.reduce((a, b) => (parseScamDetectedAtMs(a) >= parseScamDetectedAtMs(b) ? a : b));
  }
  const watchRow = await fetchLatestChannelsWatchRowForKey(sheetsClient, key);
  const displayCh = (latestProfile && latestProfile.username) ? latestProfile.username : channelDisplay;
  const reports = await getAllReportsForChannelMerged(sheetsClient, displayCh, key, channelHintSan);

  const perSite = Math.floor(Math.max(2500, deadline - Date.now() - 9000) / 2);
  const searchBudget = Math.min(5000, Math.max(1200, deadline - Date.now() - perSite * 2 - 6500));
  const searchQuery =
    (channelHintSan && channelHintSan.length >= 3)
      ? channelHintSan
      : (key && String(key).length >= 3 ? String(key) : '');
  const searchQueriesList = kroSiteSearchQueriesVariants({
    hintSan: channelHintSan,
    slugKey: key,
  });
  const [vkPage, ftPage, siteSearchPages] = await Promise.all([
    kroFetchMentionPathPage('vklader.com', key, perSite),
    kroFetchMentionPathPage('forteck.net', key, perSite),
    searchQueriesList.length
      ? kroFetchSiteSearchMentionsMulti(searchQueriesList, searchBudget)
      : Promise.resolve([]),
  ]);

  const claudePayload = {
    mode: 'home_quick_sheets_sites',
    channel: channelDisplay,
    slug: key,
    scam_base: latestProfile
      ? {
          status: latestProfile.status,
          verdict: latestProfile.verdict,
          risk_score: latestProfile.risk_score,
          complaints: latestProfile.complaints,
          source_primary: latestProfile.source_primary,
          quote: latestProfile.quote,
        }
      : null,
    channels_watch: watchRow
      ? {
          status: watchRow.status,
          activity_summary: watchRow.activity_summary,
          reviews_summary: watchRow.reviews_summary,
          status_reason: watchRow.status_reason,
        }
      : null,
    reports: reports.slice(0, 24).map((r) => ({
      date: r.date,
      description: (r.description || '').slice(0, 400),
      status: r.status,
      source: r.source,
    })),
    site_pages: [
      {
        host: 'vklader.com',
        url: vkPage.url,
        http_status: vkPage.http_status,
        ok: vkPage.ok,
        mentioned: vkPage.mentioned,
        preview: String(vkPage.preview || '').slice(0, 2000),
      },
      {
        host: 'forteck.net',
        url: ftPage.url,
        http_status: ftPage.http_status,
        ok: ftPage.ok,
        mentioned: ftPage.mentioned,
        preview: String(ftPage.preview || '').slice(0, 2000),
      },
    ],
    site_search_pages: (siteSearchPages || []).map((p) => ({
      host: p.host,
      url: p.url,
      ok: p.ok,
      http_status: p.http_status,
      mentioned: p.mentioned,
      preview: String(p.preview || '').slice(0, 2000),
      kind: p.kind || 'search',
      query: p.search_query != null ? p.search_query : searchQuery || null,
    })),
  };

  const claudeRemain = Math.max(2000, deadline - Date.now() - 300);
  const claudeJson = await kroAnalyzeChannelWithClaudeFast(claudePayload, claudeRemain);
  console.log(
    `[KRO analyze-channel ${analyzeLogId}] claude_ok=${!!claudeJson} vk_ok=${vkPage.ok} ft_ok=${ftPage.ok} site_search_n=${(siteSearchPages || []).length}`,
  );

  const evidenceSnips = kroBuildEvidenceSnippetsFromDataset({
    latestProfile,
    reports,
    channelDisplay,
  });
  const pathSnips = [];
  if (vkPage.preview) {
    pathSnips.push(`[HTML vklader.com/${key}, http ${vkPage.http_status || '—'}] ${String(vkPage.preview).slice(0, 700)}`);
  }
  if (ftPage.preview) {
    pathSnips.push(`[HTML forteck.net/${key}, http ${ftPage.http_status || '—'}] ${String(ftPage.preview).slice(0, 700)}`);
  }
  if (Array.isArray(siteSearchPages)) {
    for (const sp of siteSearchPages) {
      if (sp.preview) {
        pathSnips.push(
          `[HTML ${sp.host} поиск «${sp.search_query != null ? sp.search_query : searchQuery}», http ${sp.http_status || '—'}] ${String(sp.preview).slice(0, 700)}`,
        );
      }
    }
  }
  const mergedSnips = [...evidenceSnips, ...pathSnips];
  const parsedSimple = kroBuildParsedFromDatasetSnippets(mergedSnips, channelDisplay);
  parsedSimple.read_path = 'sheets_sites_claude';
  const sampleArr = Array.isArray(parsedSimple.sample_posts) ? parsedSimple.sample_posts.filter(Boolean) : [];
  const postsN = sampleArr.length || Number(parsedSimple.posts_fetched || 0) || 0;

  const voicePrefix =
    `За ~${Math.round(quickBudgetMs / 1000)} с собрали: scam_base, channels_watch, объединённые reports, GET https://vklader.com/${key} и https://forteck.net/${key}${searchQueriesList.length ? `, поиск на сайтах ?s= (${searchQueriesList.slice(0, 4).map((q) => `«${String(q).slice(0, 48)}»`).join(', ')})` : ''}, затем Claude. Посты Telegram и t.me не читали — только эти источники.`;

  const bundle = kroBuildAnalyzeChannelLiveSuccessBundle({
    withQueueMeta,
    channelDisplay,
    key,
    watchRow,
    reports,
    parsedForFast: parsedSimple,
    sampleForFast: sampleArr,
    postsRead: postsN,
    readPathOut: 'sheets_sites_claude',
    telBudgetMs: 0,
    t0,
    trustReportExtra: { editor_voice_prefix_ru: voicePrefix },
    claudeOverlay: claudeJson,
    telegramUsernameResolve,
  });
  return res.status(200).json({
    ...bundle,
    claude_home_quick: claudeJson,
  });
}

app.post('/api/kro/analyze-channel', express.json({ limit: '20000' }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  const rawInput = String((req.body && (req.body.username || req.body.channel || req.body.url)) || '').trim();
  let normalized = normalizeChannel(rawInput);
  let key = channelMatchKey(normalized);
  if (!key) {
    return res.status(400).json({
      error: 'bad_request',
      message_ru: 'Укажите @username, t.me/username или полную инвайт-ссылку приватного канала (https://t.me/+…).',
    });
  }

  let telegramUsernameResolve = null;
  const inviteKeyPre = String(key || '').toLowerCase().startsWith('t.me/+');
  if (!inviteKeyPre && kroShouldAttemptResolvePlainTitleToSlug(rawInput, key)) {
    telegramUsernameResolve = await kroResolveTelegramPublicSlugFromPlainTitle(rawInput, {
      analyzeLogId: `title:${key}`,
      budgetMs: KRO_PLAIN_TITLE_RESOLVE_MS,
    });
    if (telegramUsernameResolve && telegramUsernameResolve.resolved_slug) {
      normalized = `@${telegramUsernameResolve.resolved_slug}`;
      key = telegramUsernameResolve.resolved_slug;
    }
  }

  const t0 = Date.now();
  const analyzeLogId = `${key}:${Date.now().toString(36)}`;
  const channelDisplay = kroAnalyzeChannelUiLabel(normalized, key);
  const channelForOnce = (() => {
    const k = String(key || '');
    if (k.startsWith('t.me/')) return normalized.startsWith('t.me/') ? normalized : k;
    if (/^joinchat\//i.test(k)) return `t.me/${k}`;
    return normalized.startsWith('@') || normalized.startsWith('t.me/') ? normalized : `@${k}`;
  })();

  const channelNameHint = kroSanitizeChannelNameHint(
    (req.body && (req.body.channel_name_hint || req.body.channel_title_hint || req.body.display_name)) || '',
  );
  const inviteKeyEarly = String(key || '').toLowerCase().startsWith('t.me/+');

  if (inviteKeyEarly && kroInviteManualFirstEnabled()) {
    try {
      return await kroAnalyzeClosedInviteChannelHandler(req, res, {
        t0,
        key,
        normalized,
        analyzeLogId,
        channelNameHint,
        telegramUsernameResolve,
      });
    } catch (e) {
      console.error(`KRO analyze-channel invite_manual error [${analyzeLogId}]:`, e);
      return res.status(500).json({
        error: 'internal_error',
        message_ru: 'Не удалось собрать данные по приватному каналу.',
        message: 'Invite-channel analysis failed.',
        queue_status: 'failed',
      });
    }
  }

  if (kroHomeAnalyzeMode === 'quick_sheets_only') {
    try {
      return await kroAnalyzeChannelQuickSheetsSitesHandler(req, res, {
        t0,
        key,
        normalized,
        analyzeLogId,
        channelNameHint,
        telegramUsernameResolve,
      });
    } catch (e) {
      console.error(`KRO analyze-channel quick error [${analyzeLogId}]:`, e);
      return res.status(500).json({
        error: 'internal_error',
        message_ru: 'Не удалось выполнить быстрый анализ канала.',
        message: 'Быстрый анализ временно недоступен, попробуйте ещё раз.',
        queue_status: 'failed',
      });
    }
  }

  const withQueueMeta = (payload) => ({
    ...payload,
    request_id: null,
    deep_pending: false,
    deep_status: 'off',
    deep_note:
      `Живой разбор ленты до ~${Math.round(KRO_ANALYZE_CHANNEL_SYNC_MS / 60000)} мин: Telethon + при необходимости открытая страница t.me/s. Без очереди. Резерв без ленты: KRO_HOME_ANALYZE_MODE=quick_sheets_only.`,
  });
  console.log(
    `[KRO analyze-channel ${analyzeLogId}] live_first channel=${channelDisplay} sync_ms=${KRO_ANALYZE_CHANNEL_SYNC_MS}`,
  );

  try {
    const sheetsClient = await getKroSheetsClient();
    if (!sheetsClient || !kroSheetId) {
      return res.status(503).json({ error: 'sheets_unavailable', message_ru: 'Google Sheets недоступен.' });
    }

    const rawRows = await kroFetchScamBaseValuesCached(sheetsClient);
    const scamRows = rawRows
      .slice(1)
      .map(parseScamBaseRow)
      .filter((r) => r.username && channelMatchKey(r.username) === key)
      .map(enrichScamBaseContentAnalysisForMonitor);
    let latestProfile = null;
    if (scamRows.length) {
      latestProfile = scamRows.reduce((a, b) => (parseScamDetectedAtMs(a) >= parseScamDetectedAtMs(b) ? a : b));
    }
    const watchRow = await fetchLatestChannelsWatchRowForKey(sheetsClient, key);
    const displayCh = (latestProfile && latestProfile.username) ? latestProfile.username : channelDisplay;
    const reports = await getAllReportsForChannelMerged(sheetsClient, displayCh, key, channelNameHint);

    const deadline = t0 + KRO_ANALYZE_CHANNEL_SYNC_MS;
    const minReadablePosts = 1;
    const minTelethonPosts = minReadablePosts;

    /** Для публичного username — сначала быстро тянем t.me/s (до ~24 с), чтобы лента попала в ответ даже если Telethon задержится. */
    let harvestedBootstrap = null;
    const pubSlugBootstrap = kroExtractTelegramPublicSlug(channelForOnce);
    if (pubSlugBootstrap && deadline - Date.now() > 6000) {
      const bootUntil = Math.min(deadline - 1200, Date.now() + 24000);
      harvestedBootstrap = await kroHarvestPublicSnippetsUntilEnough(
        channelForOnce,
        bootUntil,
        1,
        `${analyzeLogId}:bootstrap_http`,
      );
      const bootHarvest = kroUnwrapPublicHarvest(harvestedBootstrap);
      if (bootHarvest.snippets.length) {
        console.log(
          `[KRO analyze-channel ${analyzeLogId}] bootstrap_http snippets=${bootHarvest.snippets.length}`,
        );
      }
      harvestedBootstrap = bootHarvest.snippets.length ? bootHarvest : null;
    }

    const telethonReserveMs = Math.min(330000, Math.max(120000, Math.floor(KRO_ANALYZE_CHANNEL_SYNC_MS * 0.78)));
    const telBest = kroRunHomeGreedyTelethonBestEffort(channelForOnce, deadline, telethonReserveMs, analyzeLogId, minTelethonPosts);
    let parsed = telBest.parsed;
    if (harvestedBootstrap && harvestedBootstrap.snippets && harvestedBootstrap.snippets.length) {
      parsed = kroMergeSnippetsIntoParsedBase(
        parsed,
        harvestedBootstrap.snippets,
        channelDisplay,
        harvestedBootstrap.dated_posts,
      );
    }
    const telethonOnlySnippetCount = Array.isArray(parsed.sample_posts) ? parsed.sample_posts.filter(Boolean).length : 0;
    const mergedSample = kroHomeGreedyMergeSamplesFromParsed(parsed, minTelethonPosts);
    let postsRead = mergedSample.length ? mergedSample.length : Number(parsed.posts_fetched || 0);
    let sample = mergedSample.length ? mergedSample : (Array.isArray(parsed.sample_posts) ? parsed.sample_posts.filter(Boolean) : []);
    if (mergedSample.length) {
      parsed.sample_posts = mergedSample;
      parsed.posts_fetched = postsRead;
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed._sample_texts)) {
      delete parsed._sample_texts;
    }
    console.log(
      `[KRO analyze-channel ${analyzeLogId}] telethon budget=${telBest.budgetMs}ms wall=${telBest.wallMs}ms ok=${parsed._check_once_ok === true} found=${parsed.found === true} posts_read=${postsRead}`,
    );

    let harvestedSnippets = null;
    let enough =
      parsed._check_once_ok === true &&
      parsed.found === true &&
      postsRead >= minTelethonPosts &&
      sample.length >= 1;
    const telethonWeak =
      parsed._check_once_ok !== true ||
      parsed.found !== true ||
      parsed.check_once_timed_out === true ||
      postsRead < minTelethonPosts;
    if ((telethonWeak || !enough) && deadline - Date.now() > 400) {
      const harvestRaw = await kroHarvestPublicSnippetsUntilEnough(channelForOnce, deadline, minReadablePosts, analyzeLogId);
      harvestedSnippets = kroUnwrapPublicHarvest(harvestRaw);
      if (harvestedSnippets.snippets.length) {
        parsed = kroMergeSnippetsIntoParsedBase(
          parsed,
          harvestedSnippets.snippets,
          channelDisplay,
          harvestedSnippets.dated_posts,
        );
        const mergedAfterHarvest = kroHomeGreedyMergeSamplesFromParsed(parsed, minTelethonPosts);
        postsRead = mergedAfterHarvest.length ? mergedAfterHarvest.length : Number(parsed.posts_fetched || 0);
        sample = mergedAfterHarvest.length ? mergedAfterHarvest : (Array.isArray(parsed.sample_posts) ? parsed.sample_posts.filter(Boolean) : []);
        if (mergedAfterHarvest.length) {
          parsed.sample_posts = mergedAfterHarvest;
          parsed.posts_fetched = postsRead;
        }
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed._sample_texts)) {
          delete parsed._sample_texts;
        }
        enough =
          postsRead >= minTelethonPosts &&
          sample.length >= 1 &&
          (parsed.found === true || (harvestedSnippets && harvestedSnippets.snippets.length >= minReadablePosts));
        console.log(
          `[KRO analyze-channel ${analyzeLogId}] after_public_harvest snippets=${harvestedSnippets.snippets.length} posts_read=${postsRead} enough=${enough}`,
        );
      }
    }

    if (deadline - Date.now() > 3000 && postsRead < KRO_HOME_ANALYZE_MIN_POSTS) {
      const fill = await kroHomeHarvestUntilTargetPosts({
        channelForOnce,
        deadline,
        analyzeLogId,
        targetPosts: KRO_HOME_ANALYZE_MIN_POSTS,
        parsed,
        minReadablePosts,
        channelDisplay,
      });
      parsed = fill.parsed;
      const mergedFill = kroHomeGreedyMergeSamplesFromParsed(parsed, minTelethonPosts);
      postsRead = mergedFill.length ? mergedFill.length : Number(parsed.posts_fetched || 0);
      sample = mergedFill.length ? mergedFill : (Array.isArray(parsed.sample_posts) ? parsed.sample_posts.filter(Boolean) : []);
      if (mergedFill.length) {
        parsed.sample_posts = mergedFill;
        parsed.posts_fetched = postsRead;
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed._sample_texts)) {
        delete parsed._sample_texts;
      }
      if (fill.harvestedExtra && fill.harvestedExtra.length) {
        if (!harvestedSnippets || !harvestedSnippets.snippets) {
          harvestedSnippets = { snippets: fill.harvestedExtra.slice(), dated_posts: [] };
        } else {
          harvestedSnippets = {
            snippets: [...harvestedSnippets.snippets, ...fill.harvestedExtra],
            dated_posts: harvestedSnippets.dated_posts || [],
          };
        }
      }
      enough =
        postsRead >= minTelethonPosts &&
        sample.length >= 1 &&
        (parsed.found === true || (harvestedSnippets && harvestedSnippets.snippets.length >= minReadablePosts));
      console.log(
        `[KRO analyze-channel ${analyzeLogId}] after_target_fill posts_read=${postsRead} target=${KRO_HOME_ANALYZE_MIN_POSTS} enough=${enough}`,
      );
    }

    let parsedForFast = parsed;
    let sampleForFast = sample;
    let readPathOut = 'telethon';
    if (enough) {
      const hadTelethonText = telethonOnlySnippetCount > 0;
      const usedPublicHarvest = !!(harvestedSnippets && harvestedSnippets.snippets && harvestedSnippets.snippets.length);
      if (!hadTelethonText && usedPublicHarvest) {
        readPathOut = 'public_snapshot';
      } else if (usedPublicHarvest) {
        readPathOut = 'telethon+public_snapshot';
      } else {
        readPathOut = 'telethon';
      }
      console.log(`[KRO analyze-channel ${analyzeLogId}] completed read_path=${readPathOut} posts_read=${postsRead}`);
      const { personBehind, signalAccuracy } = await kroFetchAnalyzeChannelGlanceExtras({
        pubSlugBootstrap,
        channelDisplay,
        channelForOnce,
        deadline,
        analyzeLogId,
        postTexts: sampleForFast,
        parsedForFast,
        sampleForFast,
      });
      return res.status(200).json(
        kroBuildAnalyzeChannelLiveSuccessBundle({
          withQueueMeta,
          channelDisplay,
          key,
          watchRow,
          reports,
          parsedForFast,
          sampleForFast,
          postsRead,
          readPathOut,
          telBudgetMs: telBest.budgetMs,
          t0,
          telegramUsernameResolve,
          personBehind,
          signalAccuracy,
        }),
      );
    }

    const pubOnly =
      harvestedSnippets && harvestedSnippets.snippets && harvestedSnippets.snippets.length >= minReadablePosts
        ? kroBuildParsedFromPublicSnapshotOnly(
          { snippets: harvestedSnippets.snippets, dated_posts: harvestedSnippets.dated_posts },
          channelDisplay,
          minReadablePosts,
        )
        : kroBuildParsedFromPublicSnapshotOnly(
            await kroFetchTelegramPublicSnapshot(channelForOnce, {
              timeoutMs: Math.min(60000, Math.max(4000, deadline - Date.now() - 400)),
              logLabel: `${analyzeLogId}:pub_fallback`,
            }),
            channelDisplay,
            minReadablePosts,
          );
    if (pubOnly) {
      const pPub = pubOnly;
      const sPub = Array.isArray(pPub.sample_posts) ? pPub.sample_posts.filter(Boolean) : [];
      const nPub = sPub.length;
      console.log(`[KRO analyze-channel ${analyzeLogId}] public_snapshot_only posts_read=${nPub}`);
      const { personBehind: personBehindPub, signalAccuracy: signalAccuracyPub } = await kroFetchAnalyzeChannelGlanceExtras({
        pubSlugBootstrap,
        channelDisplay,
        channelForOnce,
        deadline,
        analyzeLogId,
        postTexts: sPub,
        parsedForFast: pPub,
        sampleForFast: sPub,
      });
      return res.status(200).json(
        kroBuildAnalyzeChannelLiveSuccessBundle({
          withQueueMeta,
          channelDisplay,
          key,
          watchRow,
          reports,
          parsedForFast: pPub,
          sampleForFast: sPub,
          postsRead: nPub,
          readPathOut: 'public_snapshot',
          telBudgetMs: telBest.budgetMs,
          t0,
          telegramUsernameResolve,
          personBehind: personBehindPub,
          signalAccuracy: signalAccuracyPub,
        }),
      );
    }

    // Последняя попытка открыть публичную ленту по HTTP перед fallback на базу (медленная сеть / временный отказ t.me).
    if (deadline - Date.now() > 3500) {
      const pubRetryFetch = await kroFetchTelegramPublicSnapshot(channelForOnce, {
        timeoutMs: Math.min(90000, Math.max(8000, deadline - Date.now() - 900)),
        logLabel: `${analyzeLogId}:pub_fallback_retry`,
      });
      const pubRetry = kroBuildParsedFromPublicSnapshotOnly(pubRetryFetch, channelDisplay, minReadablePosts);
      if (pubRetry) {
        const pR = pubRetry;
        const sR = Array.isArray(pR.sample_posts) ? pR.sample_posts.filter(Boolean) : [];
        console.log(`[KRO analyze-channel ${analyzeLogId}] public_snapshot_retry posts_read=${sR.length}`);
        const { personBehind: personBehindRetry, signalAccuracy: signalAccuracyRetry } = await kroFetchAnalyzeChannelGlanceExtras({
          pubSlugBootstrap,
          channelDisplay,
          channelForOnce,
          deadline,
          analyzeLogId,
          postTexts: sR,
          parsedForFast: pR,
          sampleForFast: sR,
        });
        return res.status(200).json(
          kroBuildAnalyzeChannelLiveSuccessBundle({
            withQueueMeta,
            channelDisplay,
            key,
            watchRow,
            reports,
            parsedForFast: pR,
            sampleForFast: sR,
            postsRead: sR.length,
            readPathOut: 'public_snapshot',
            telBudgetMs: telBest.budgetMs,
            t0,
            telegramUsernameResolve,
            personBehind: personBehindRetry,
            signalAccuracy: signalAccuracyRetry,
          }),
        );
      }
    }
    if (deadline - Date.now() > 1800) {
      const lateHarvestRaw = await kroHarvestPublicSnippetsUntilEnough(
        channelForOnce,
        deadline,
        minReadablePosts,
        `${analyzeLogId}:pre_dataset_harvest`,
      );
      const lateHarvest = kroUnwrapPublicHarvest(lateHarvestRaw);
      const pubLate =
        lateHarvest.snippets.length >= minReadablePosts
          ? kroBuildParsedFromPublicSnapshotOnly(
            { snippets: lateHarvest.snippets, dated_posts: lateHarvest.dated_posts },
            channelDisplay,
            minReadablePosts,
          )
          : null;
      if (pubLate) {
        const pL = pubLate;
        const sL = Array.isArray(pL.sample_posts) ? pL.sample_posts.filter(Boolean) : [];
        console.log(`[KRO analyze-channel ${analyzeLogId}] public_snapshot_pre_dataset posts_read=${sL.length}`);
        const { personBehind: personBehindLate, signalAccuracy: signalAccuracyLate } = await kroFetchAnalyzeChannelGlanceExtras({
          pubSlugBootstrap,
          channelDisplay,
          channelForOnce,
          deadline,
          analyzeLogId,
          postTexts: sL,
          parsedForFast: pL,
          sampleForFast: sL,
        });
        return res.status(200).json(
          kroBuildAnalyzeChannelLiveSuccessBundle({
            withQueueMeta,
            channelDisplay,
            key,
            watchRow,
            reports,
            parsedForFast: pL,
            sampleForFast: sL,
            postsRead: sL.length,
            readPathOut: 'public_snapshot',
            telBudgetMs: telBest.budgetMs,
            t0,
            telegramUsernameResolve,
            personBehind: personBehindLate,
            signalAccuracy: signalAccuracyLate,
          }),
        );
      }
    }

    const evidenceSnips = kroBuildEvidenceSnippetsFromDataset({
      latestProfile,
      reports,
      channelDisplay,
    });
    const parsedDs = kroBuildParsedFromDatasetSnippets(evidenceSnips, channelDisplay);
    const sampleDs = Array.isArray(parsedDs.sample_posts) ? parsedDs.sample_posts.filter(Boolean) : [];
    const postsDs = sampleDs.length || Number(parsedDs.posts_fetched || 0) || 0;
    const dsNote =
      'В этом запросе не удалось собрать текст постов с открытой страницы или через клиент Telegram; ниже — только данные из базы и жалоб. Для живой ленты откройте канал в браузере или повторите проверку позже.';

    console.log(
      `[KRO analyze-channel ${analyzeLogId}] dataset_evidence_fallback posts=${postsDs}`,
    );
    const { personBehind: personBehindDs, signalAccuracy: signalAccuracyDs } = await kroFetchAnalyzeChannelGlanceExtras({
      pubSlugBootstrap,
      channelDisplay,
      channelForOnce,
      deadline,
      analyzeLogId,
      postTexts: sampleDs,
      parsedForFast: parsedDs,
      sampleForFast: sampleDs,
    });
    return res.status(200).json(
      kroBuildAnalyzeChannelLiveSuccessBundle({
        withQueueMeta,
        channelDisplay,
        key,
        watchRow,
        reports,
        parsedForFast: parsedDs,
        sampleForFast: sampleDs,
        postsRead: postsDs,
        readPathOut: 'dataset_evidence',
        telBudgetMs: telBest.budgetMs,
        t0,
        trustReportExtra: { editor_voice_prefix_ru: dsNote },
        telegramUsernameResolve,
        personBehind: personBehindDs,
        signalAccuracy: signalAccuracyDs,
      }),
    );
  } catch (e) {
    console.error(`KRO analyze-channel sync error [${analyzeLogId}]:`, e);
    return res.status(500).json(withQueueMeta({
      error: 'internal_error',
      message_ru: 'Не удалось выполнить анализ канала.',
      message: 'Анализ временно недоступен, попробуйте ещё раз.',
      queue_status: 'failed',
    }));
  }
});

app.get('/api/kro/analyze-channel/result', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  const qRaw = String((req.query.username || req.query.u || '')).trim();
  const requestId = String((req.query.request_id || '')).trim();
  const key = qRaw ? channelMatchKey(normalizeChannel(qRaw)) : '';
  if (!requestId && !key) {
    return res.status(400).json({ error: 'bad_request', message_ru: 'Нужен username или request_id.' });
  }

  try {
    const client = await getKroSheetsClient();
    if (!client || !kroSheetId) {
      return res.status(503).json({ error: 'sheets_unavailable', message_ru: 'Google Sheets недоступен.' });
    }

    const [queueResp, resultsResp] = await Promise.all([
      client.sheets.spreadsheets.values.get({ spreadsheetId: kroSheetId, range: kroCheckQueueRange }),
      client.sheets.spreadsheets.values.get({ spreadsheetId: kroSheetId, range: kroCheckResultsRange }),
    ]);

    const queueRows = queueResp.data.values || [];
    const resultsRows = resultsResp.data.values || [];

    const queueRow = kroCheckQueueStatusByRows(queueRows, key, requestId);
    const doneRow = kroCheckResultByRows(resultsRows, key, requestId);
    const startedAtRaw =
      (queueRow && queueRow.requested_at) ||
      (doneRow && doneRow.created_at) ||
      '';
    const startedAtMs = Date.parse(String(startedAtRaw || ''));
    const elapsedMs = Number.isFinite(startedAtMs) ? (Date.now() - startedAtMs) : null;
    const fastTimedOut = Number.isFinite(elapsedMs) && elapsedMs > KRO_ANALYZE_FAST_MAX_MS;
    if (fastTimedOut) {
      const user = (queueRow && queueRow.username) || (doneRow && doneRow.username) || (key ? `@${key}` : '');
      return res.status(200).json(
        kroBuildAnalyzeFastTimeoutResponse(
          requestId || (queueRow && queueRow.request_id) || (doneRow && doneRow.request_id) || null,
          user,
          elapsedMs,
        ),
      );
    }

    if (doneRow && doneRow.status === 'done') {
      return res.status(200).json(kroBuildAnalyzeDoneResponse(doneRow, key || channelMatchKey(doneRow.username)));
    }
    if (doneRow && doneRow.status === 'failed') {
      return res.status(200).json({
        queue_status: 'failed',
        request_id: doneRow.request_id,
        status: 'Оценка не готова',
        status_code: 'UNAVAILABLE',
        posts_read: Number(doneRow.posts_read || 0) || 0,
        period_days: doneRow.period_days,
        read_path: doneRow.read_path,
        message: (doneRow.payload && doneRow.payload.error) ? String(doneRow.payload.error) : 'Проверка завершилась ошибкой.',
      });
    }

    if (queueRow) {
      const requestedMs = Date.parse(String(queueRow.requested_at || ''));
      const pendingTooLong =
        queueRow.status === 'pending' &&
        Number.isFinite(requestedMs) &&
        (Date.now() - requestedMs > 15 * 60 * 1000);
      if (pendingTooLong) {
        return res.status(200).json({
          queue_status: 'failed',
          request_id: queueRow.request_id,
          username: queueRow.username,
          message:
            'Очередь не обработана вовремя (более 15 минут). Проверьте выполнение GitHub Actions и секреты воркера.',
        });
      }
      return res.status(200).json({
        queue_status: queueRow.status || 'pending',
        request_id: queueRow.request_id,
        username: queueRow.username,
        started_at: queueRow.started_at,
        finished_at: queueRow.finished_at,
        message: queueRow.status === 'running'
          ? 'Анализ в процессе: воркер читает посты канала.'
          : 'Задача в очереди на анализ.',
      });
    }

    return res.status(200).json({
      queue_status: 'not_found',
      message: 'Результат ещё не найден. Проверьте позже.',
    });
  } catch (e) {
    console.error('KRO analyze-channel result error:', e);
    return res.status(500).json({ error: 'internal_error', message_ru: 'Не удалось получить статус анализа.' });
  }
});

app.get('/api/kro/check-result/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  const requestId = String(req.params.id || '').trim();
  if (!requestId) {
    return res.status(400).json({ error: 'bad_request', message_ru: 'Нужен id запроса.' });
  }

  try {
    const client = await getKroSheetsClient();
    if (!client || !kroSheetId) {
      return res.status(503).json({ error: 'sheets_unavailable', message_ru: 'Google Sheets недоступен.' });
    }
    const resp = await client.sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: kroCheckRequestsRange,
    });
    const rows = resp.data.values || [];
    const row = kroCheckRequestRowById(rows, requestId);
    if (!row) {
      return res.status(404).json({ error: 'not_found', message: 'Запрос не найден.' });
    }
    const reqTsMs = Date.parse(String(row.created_at || ''));
    const fastTimedOut = Number.isFinite(reqTsMs) && (Date.now() - reqTsMs > KRO_ANALYZE_FAST_MAX_MS);
    if (fastTimedOut) {
      return res.status(200).json(
        kroBuildAnalyzeFastTimeoutResponse(row.id, row.username, Date.now() - reqTsMs),
      );
    }
    if (row.status === 'pending') {
      return res.status(200).json({
        id: row.id,
        status: 'pending',
        message: 'Ждём живое чтение ленты Telegram...',
      });
    }
    if (row.status === 'running') {
      return res.status(200).json({
        id: row.id,
        status: 'running',
        message: 'Воркер читает посты канала через Telegram (LIVE).',
      });
    }
    if (row.status === 'failed') {
      let failPayload = null;
      try { failPayload = row.result_raw ? JSON.parse(row.result_raw) : null; } catch { failPayload = null; }
      return res.status(200).json({
        id: row.id,
        status: 'failed',
        message: failPayload && failPayload.error ? String(failPayload.error) : 'Проверка завершилась ошибкой.',
      });
    }
    if (row.status === 'done') {
      let parsed = null;
      try { parsed = row.result_raw ? JSON.parse(row.result_raw) : null; } catch { parsed = null; }
      return res.status(200).json(kroBuildAnalyzeResponseFromParsed(parsed, channelMatchKey(row.username), row.id));
    }
    return res.status(200).json({
      id: row.id,
      status: row.status || 'pending',
      message: 'Результат ещё не готов.',
    });
  } catch (e) {
    console.error('KRO check-result error:', e);
    return res.status(500).json({ error: 'internal_error', message_ru: 'Не удалось получить результат проверки.' });
  }
});


// GET /api/kro/channel-profile?u=…&mode=fast|deep — карточка scam_base + анализ.
// По умолчанию mode=fast: без Telethon/check_once, только база, отчёты, channels_watch (быстро, без FLOOD_WAIT).
// mode=deep: полный check_once; при FLOOD_WAIT — быстрый слой + deep_available_at и live_metrics.deep_status.
// mode=deep&byo_token=kro_byo_… — тот же check_once, но через StringSession посетителя (без очереди и без записи в общий deep-кэш).
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
  const clientId = kroDeepGetClientId(req);
  const deep_cache_hint = kroDeepCacheHintForKey(key);
  try {
    const sheetsClient = await getKroSheetsClient();
    if (!sheetsClient || !kroSheetId) {
      const analysis = {
        v: 0,
        channel_key: key,
        generated_at: new Date().toISOString(),
        sources: ['настройки сервера'],
        basic_info: [`Канал: @${decoded}`, 'Сервис данных временно недоступен — сводку и жалобы сейчас не подтянуть.'],
        content_behavior: [],
        external_reports: [],
        ties_risk_factors: [],
        conclusion: {
          status: KRO_V0_STATUS.watch,
          reasons: ['Проверка отложена: нет доступа к сервису данных. Попробуйте позже.'],
        },
      };
      let dgSheets = null;
      const peekSheets = kroDeepAllowNewTelegramDeep(clientId);
      if (!peekSheets.allowed) {
        dgSheets = {
          server_deep_blocked: true,
          server_throttle_scope: peekSheets.scope,
          message_ru: peekSheets.message_ru,
          wait_minutes_approx: peekSheets.wait_minutes_approx,
          wait_seconds_approx: peekSheets.wait_seconds_approx,
        };
      }
      return res.status(200).json({
        mode: 'fast',
        deep_status: null,
        deep_available_at: null,
        deep_cache_hint,
        deep_gate: kroBuildChannelProfileDeepGate(dgSheets),
        profile: null,
        merged_rows: undefined,
        risk_index: null,
        risk_index_max: 100,
        false_positive_count: 0,
        analysis,
        live_metrics: null,
      });
    }
    const modeRaw = (req.query.mode ?? 'fast').toString().trim().toLowerCase();
    const deepMode = modeRaw === 'deep' || modeRaw === 'full' || modeRaw === 'live';
    const scamRawRows = await kroFetchScamBaseValuesCached(sheetsClient);
    const scamRows = scamRawRows
      .slice(1)
      .map(parseScamBaseRow)
      .filter((r) => r.username && r.username !== 'username')
      .map(enrichScamBaseContentAnalysisForMonitor);
    const matches = scamRows.filter((r) => channelMatchKey(r.username) === key);
    const channelForOnce = (() => {
      const k = String(key || '');
      if (k.startsWith('t.me/')) return k;
      if (/^joinchat\//i.test(k)) return `t.me/${k}`;
      return `@${k}`;
    })();

    const floodState = kroGetTelegramFloodState();
    let once = { ok: false, parsed: null, error: null, stderr: '' };
    let parsedOnce = { found: false, _check_once_ok: false };
    let deepStatus = 'not_requested';
    let deepAvailableAt = null;
    let deepFromCacheHit = false;
    let deepCacheStale = false;
    let deepCacheAgeMs = null;
    /** @type {{ server_deep_blocked: true, server_throttle_scope: string, message_ru: string, wait_minutes_approx?: number, wait_seconds_approx?: number } | null} */
    let serverThrottleMeta = null;
    /** @type {{ deep_queued: true, deep_queue_position: number, deep_queue_eta_minutes: number, message_ru: string } | null} */
    let deepQueueGate = null;
    let byoDeepActive = false;

    const deepRefreshRaw = (req.query.deep_refresh ?? req.query.refresh ?? '').toString().trim().toLowerCase();
    const deepRefresh =
      deepRefreshRaw === '1' || deepRefreshRaw === 'true' || deepRefreshRaw === 'yes';

    if (deepMode) {
      const byoTokenRaw =
        KRO_BYO_DEEP_ENABLED ? (req.query.byo_token ?? '').toString().trim() : '';
      const byoRow = byoTokenRaw ? kroByoGetSession(byoTokenRaw) : null;
      if (byoTokenRaw && KRO_BYO_DEEP_ENABLED && !byoRow) {
        return res.status(400).json({
          error: 'byo_token_invalid',
          message_ru:
            'Сессия «ваш Telegram» недействительна или истекла. Подключите строку сессии снова в блоке ниже на странице.',
        });
      }
      if (byoRow && byoRow.sessionString) {
        byoDeepActive = true;
        once = kroRunCheckOnce(channelForOnce, {
          readOnly: true,
          telegramSessionString: byoRow.sessionString,
          periodDays: 180,
          timeoutMs: kroDeepCheckOnceTimeoutMs,
        });
        if (once.stderr) console.error('KRO channel-profile BYO check_once stderr:', once.stderr);
        parsedOnce = kroNormalizeCheckOnceForAnalysis(once);
        deepFromCacheHit = false;
        deepCacheStale = false;
        deepCacheAgeMs = null;
        if (parsedOnce.telegram_rate_limited) {
          const sec = Number(parsedOnce.flood_wait_seconds);
          deepStatus = 'rate_limited';
          deepAvailableAt =
            Number.isFinite(sec) && sec > 0 ? new Date(Date.now() + sec * 1000).toISOString() : null;
        } else {
          if (once.ok !== true) {
            deepStatus = 'failed';
          } else if (parsedOnce.not_crypto) {
            deepStatus = 'not_applicable';
          } else if (parsedOnce.found === true) {
            deepStatus = 'ok';
          } else {
            deepStatus = 'incomplete';
          }
        }
      } else {
      const servableCached = deepRefresh ? null : kroDeepCacheServableResolved(key);
      if (floodState.active) {
        if (servableCached) {
          deepFromCacheHit = true;
          deepCacheStale = !servableCached.fresh;
          deepCacheAgeMs = servableCached.age_ms;
          once = servableCached.entry.once;
          parsedOnce = servableCached.entry.parsedOnce;
          deepStatus = servableCached.entry.deepStatus;
          deepAvailableAt = servableCached.entry.deepAvailableAt || null;
        } else {
          deepStatus = 'skipped_flood';
          deepAvailableAt = floodState.deep_available_at;
          parsedOnce = kroSyntheticFloodParsedForDeepSkip(key);
          once = { ok: true, parsed: parsedOnce, stderr: '' };
        }
      } else if (servableCached) {
        deepFromCacheHit = true;
        deepCacheStale = !servableCached.fresh;
        deepCacheAgeMs = servableCached.age_ms;
        once = servableCached.entry.once;
        parsedOnce = servableCached.entry.parsedOnce;
        deepStatus = servableCached.entry.deepStatus;
        deepAvailableAt = servableCached.entry.deepAvailableAt || null;
      } else {
        const allow = kroDeepAllowNewTelegramDeep(clientId);
        if (!allow.allowed) {
          if (allow.scope === 'global') {
            const q = kroDeepEnqueue(key, channelForOnce, clientId);
            if (q.rejected) {
              deepStatus = q.reject_reason === 'client_queue_full' ? 'client_queue_full' : 'queue_deferred';
              parsedOnce = kroSyntheticQueueRejectParsed(key, q);
              once = { ok: true, parsed: parsedOnce, stderr: '' };
              serverThrottleMeta = {
                server_deep_blocked: true,
                server_throttle_scope: String(q.reject_reason || 'queue'),
                message_ru: q.message_ru,
                wait_minutes_approx:
                  q.reject_reason === 'eta_too_long' ? KRO_DEEP_QUEUE_MAX_ETA_MINUTES : null,
                wait_seconds_approx:
                  q.reject_reason === 'eta_too_long' ? KRO_DEEP_QUEUE_MAX_ETA_MINUTES * 60 : null,
              };
            } else {
              deepStatus = 'queued';
              parsedOnce = kroSyntheticQueuedParsed(
                key,
                q.position,
                q.eta_minutes,
                q.suggested_refresh_seconds,
              );
              once = { ok: true, parsed: parsedOnce, stderr: '' };
              deepQueueGate = {
                deep_queued: true,
                deep_queue_position: q.position,
                deep_queue_eta_minutes: q.eta_minutes,
                suggested_refresh_seconds: q.suggested_refresh_seconds,
                message_ru: String(parsedOnce.error || ''),
              };
            }
          } else {
            deepStatus = 'server_rate_limited';
            serverThrottleMeta = {
              server_deep_blocked: true,
              server_throttle_scope: allow.scope,
              message_ru: allow.message_ru,
              wait_minutes_approx: allow.wait_minutes_approx,
              wait_seconds_approx: allow.wait_seconds_approx,
            };
            parsedOnce = kroSyntheticServerDeepThrottleParsed(key, allow.message_ru);
            once = { ok: true, parsed: parsedOnce, stderr: '' };
          }
        } else {
          once = kroRunCheckOnce(channelForOnce, {
            readOnly: true,
            periodDays: 180,
            timeoutMs: kroDeepCheckOnceTimeoutMs,
          });
          if (once.stderr) console.error('KRO channel-profile check_once stderr:', once.stderr);
          parsedOnce = kroNormalizeCheckOnceForAnalysis(once);
          if (parsedOnce.telegram_rate_limited) {
            kroRecordTelegramFloodWait(key, parsedOnce.flood_wait_seconds);
            deepStatus = 'rate_limited';
            deepAvailableAt = kroGetTelegramFloodState().deep_available_at;
          } else {
            kroDeepRecordSuccessfulTelegramDeep(clientId);
            if (once.ok !== true) {
              deepStatus = 'failed';
            } else if (parsedOnce.not_crypto) {
              deepStatus = 'not_applicable';
            } else if (parsedOnce.found === true) {
              deepStatus = 'ok';
            } else {
              deepStatus = 'incomplete';
            }
            if (['ok', 'incomplete', 'not_applicable'].includes(deepStatus)) {
              kroDeepCacheSet(key, { once, parsedOnce, deepStatus, deepAvailableAt });
            }
          }
        }
      }
      }
    }

    let homeQuickParsed = null;
    const homeQuickLiveWant =
      !deepMode &&
      ['1', 'true', 'yes'].includes(String(req.query.home_quick_live ?? '').trim().toLowerCase()) &&
      process.env.KRO_HOME_QUICK_LIVE !== '0';
    if (homeQuickLiveWant && !floodState.active) {
      const allowH = kroDeepAllowNewTelegramDeep(clientId);
      if (allowH.allowed) {
        const tHome = kroHomeQuickLiveTimeoutMs;
        const onceH = kroRunCheckOnce(channelForOnce, { readOnly: true, periodDays: 90, timeoutMs: tHome });
        if (onceH.ok === true && onceH.parsed) {
          const normH = kroNormalizeCheckOnceForAnalysis(onceH);
          if (normH && !normH.telegram_rate_limited && !normH.not_crypto) {
            homeQuickParsed = normH;
            try {
              kroDeepRecordSuccessfulTelegramDeep(clientId);
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
    const parsedForLiveMetrics =
      homeQuickParsed && homeQuickParsed._check_once_ok === true ? homeQuickParsed : parsedOnce;
    let liveMetrics = kroChannelProfileLiveMetrics(parsedForLiveMetrics, {
      mode: deepMode ? 'deep' : 'fast',
      deepRan: deepMode,
      deepStatus,
      deepAvailableAt,
    });
    if (byoDeepActive) {
      liveMetrics = { ...liveMetrics, byo_telegram: true };
    }
    if (homeQuickParsed && homeQuickParsed._check_once_ok === true) {
      liveMetrics = { ...liveMetrics, home_quick_live: true, home_quick_window_days: 90 };
    }

    const deepTelegramBlocked = deepMode && (deepStatus === 'rate_limited' || deepStatus === 'skipped_flood');
    const deepServerThrottled = deepMode && deepStatus === 'server_rate_limited';
    const deepClientQueueFull = deepMode && deepStatus === 'client_queue_full';
    const deepQueueDeferred = deepMode && deepStatus === 'queue_deferred';
    const deepQueued = deepMode && deepStatus === 'queued';
    const deepThrottleLike =
      deepServerThrottled || deepClientQueueFull || deepQueueDeferred;
    const deepBlocked =
      deepTelegramBlocked || deepThrottleLike || deepQueued;
    const deepRateLimited = deepTelegramBlocked;
    const deepAvailableIso =
      deepAvailableAt || (deepRateLimited ? kroGetTelegramFloodState().deep_available_at : null);
    let deepGatePayload = deepQueueGate || null;
    if (!byoDeepActive && !deepGatePayload) {
      const pendingCh = kroDeepPendingGateForChannelKey(key);
      if (pendingCh) deepGatePayload = pendingCh;
    }
    if (!deepGatePayload) deepGatePayload = serverThrottleMeta || null;
    if (!byoDeepActive && !deepGatePayload && !(deepMode && deepStatus === 'ok')) {
      const peek = kroDeepAllowNewTelegramDeep(clientId);
      if (!peek.allowed) {
        deepGatePayload = {
          server_deep_blocked: true,
          server_throttle_scope: peek.scope,
          message_ru: peek.message_ru,
          wait_minutes_approx: peek.wait_minutes_approx,
          wait_seconds_approx: peek.wait_seconds_approx,
        };
      }
    }
    const serverThrottleMsg = serverThrottleMeta && serverThrottleMeta.message_ru ? serverThrottleMeta.message_ru : '';
    const queuedMsg =
      deepQueued && parsedOnce && parsedOnce.error != null ? String(parsedOnce.error) : '';

    const responseMode = deepMode ? 'deep' : 'fast';

    if (!matches.length) {
      const watchRowCp0 = await fetchLatestChannelsWatchRowForKey(sheetsClient, key);
      let analysis;
      if (deepMode && !deepBlocked) {
        analysis = kroV0BuildAnalysisFromLiveParsed(parsedOnce, key);
        kroV0PrependNoScamBaseCardNote(analysis, { fast: false });
        if (once.ok !== true && parsedOnce && parsedOnce.check_once_timed_out === true) {
          analysis.basic_info = [
            'Глубокий разбор ленты не уложился в лимит времени (~30 мин.) — ниже то, что удалось собрать по жалобам и мониторингу; полный охват за полгода в этом запросе не гарантирован.',
          ].concat(analysis.basic_info || []);
        }
      } else if (deepTelegramBlocked) {
        analysis = await kroV0BuildFastAnalysisNoLive(sheetsClient, key, decoded, watchRowCp0);
        kroV0MergeDeepRateLimitIntoAnalysis(analysis, deepAvailableIso);
        kroV0PrependNoScamBaseCardNote(analysis, { fast: true });
      } else if (deepThrottleLike) {
        analysis = await kroV0BuildFastAnalysisNoLive(sheetsClient, key, decoded, watchRowCp0);
        kroV0MergeServerDeepThrottleIntoAnalysis(analysis, serverThrottleMsg);
        kroV0PrependNoScamBaseCardNote(analysis, { fast: true });
      } else if (deepQueued) {
        analysis = await kroV0BuildFastAnalysisNoLive(sheetsClient, key, decoded, watchRowCp0);
        kroV0MergeQueuedDeepIntoAnalysis(analysis, queuedMsg);
        kroV0PrependNoScamBaseCardNote(analysis, { fast: true });
      } else {
        analysis = await kroV0BuildFastAnalysisNoLive(sheetsClient, key, decoded, watchRowCp0);
        kroV0PrependNoScamBaseCardNote(analysis, { fast: true });
      }
      if (watchRowCp0 && !analysis._kro_watch_baked) {
        kroV0EnrichAnalysisWithWatch(analysis, watchRowCp0);
      }
      if (analysis._kro_watch_baked) delete analysis._kro_watch_baked;
      if (homeQuickParsed) kroV0MergeHomeQuickLiveIntoFastAnalysis(analysis, homeQuickParsed, key);
      await kroEnrichAnalysisWithChannelHistory(analysis, key, `@${decoded}`);
      return res.status(200).json({
        mode: responseMode,
        byo_deep: byoDeepActive,
        deep_status: deepStatus,
        deep_available_at: deepAvailableIso,
        deep_cache_hit: deepFromCacheHit,
        deep_cache_stale: deepCacheStale,
        deep_cache_age_ms: deepCacheAgeMs,
        deep_cache_hint,
        deep_gate: kroBuildChannelProfileDeepGate(deepGatePayload),
        profile: null,
        merged_rows: undefined,
        risk_index: null,
        risk_index_max: 100,
        false_positive_count: 0,
        analysis,
        live_metrics: liveMetrics,
      });
    }
    const bestAny = matches.reduce((best, cur) =>
      parseScamDetectedAtMs(cur) >= parseScamDetectedAtMs(best) ? cur : best
    );
    const liveMatches = matches.filter((r) => isScamBaseRowInLiveCounterDataset(r));
    if (!liveMatches.length) {
      const bestEnr = enrichScamBaseContentAnalysisForMonitor(bestAny);
      let analysis;
      if (deepMode && !deepBlocked) {
        const liveAnalysis = kroV0BuildAnalysisFromLiveParsed(parsedOnce, key);
        const deepHead =
          once.ok !== true && parsedOnce && parsedOnce.check_once_timed_out === true
            ? [
                `По этому каналу в мониторинге несколько совпадений (${matches.length}); глубокий разбор ленты уперся в лимит времени (~30 мин.) — ниже сокращённый отчёт и сводка.`,
                `Ориентир по статусу в мониторинге: «${(bestAny.status || bestAny.verdict || '—')}».`,
              ]
            : [
                `По этому каналу в мониторинге несколько совпадений (${matches.length}); в публичной сводке показываем одну логику по правилам видимости.`,
                `Ориентир по внутреннему статусу: «${(bestAny.status || bestAny.verdict || '—')}».`,
              ];
        analysis = {
          ...liveAnalysis,
          basic_info: deepHead.concat(liveAnalysis.basic_info || []),
        };
      } else if (deepTelegramBlocked) {
        analysis = kroV0BuildAnalysisFromScamBaseProfile(bestEnr, { channel_key: key });
        kroV0PrependFastModeNote(analysis, bestEnr);
        kroV0MergeDeepRateLimitIntoAnalysis(analysis, deepAvailableIso);
        analysis.basic_info = [
          `По этому каналу в мониторинге несколько совпадений (${matches.length}); в публичной сводке показываем одну логику по правилам видимости.`,
          `Ориентир по внутреннему статусу: «${(bestAny.status || bestAny.verdict || '—')}».`,
        ].concat(analysis.basic_info || []);
      } else if (deepThrottleLike) {
        analysis = kroV0BuildAnalysisFromScamBaseProfile(bestEnr, { channel_key: key });
        kroV0PrependFastModeNote(analysis, bestEnr);
        kroV0MergeServerDeepThrottleIntoAnalysis(analysis, serverThrottleMsg);
        analysis.basic_info = [
          `По этому каналу в мониторинге несколько совпадений (${matches.length}); в публичной сводке показываем одну логику по правилам видимости.`,
          `Ориентир по внутреннему статусу: «${(bestAny.status || bestAny.verdict || '—')}».`,
        ].concat(analysis.basic_info || []);
      } else if (deepQueued) {
        analysis = kroV0BuildAnalysisFromScamBaseProfile(bestEnr, { channel_key: key });
        kroV0PrependFastModeNote(analysis, bestEnr);
        kroV0MergeQueuedDeepIntoAnalysis(analysis, queuedMsg);
        analysis.basic_info = [
          `По этому каналу в мониторинге несколько совпадений (${matches.length}); в публичной сводке показываем одну логику по правилам видимости.`,
          `Ориентир по внутреннему статусу: «${(bestAny.status || bestAny.verdict || '—')}».`,
        ].concat(analysis.basic_info || []);
      } else {
        analysis = kroV0BuildAnalysisFromScamBaseProfile(bestEnr, { channel_key: key });
        kroV0PrependFastModeNote(analysis, bestEnr);
        analysis.basic_info = [
          `По этому каналу в мониторинге несколько совпадений (${matches.length}); в публичной сводке показываем одну логику по правилам видимости.`,
          `Ориентир по внутреннему статусу: «${(bestAny.status || bestAny.verdict || '—')}».`,
        ].concat(analysis.basic_info || []);
      }
      const watchRowCp1 = await fetchLatestChannelsWatchRowForKey(sheetsClient, key);
      if (watchRowCp1) kroV0EnrichAnalysisWithWatch(analysis, watchRowCp1);
      if (homeQuickParsed) kroV0MergeHomeQuickLiveIntoFastAnalysis(analysis, homeQuickParsed, key);
      await kroEnrichAnalysisWithChannelHistory(analysis, key, `@${decoded}`);
      return res.status(200).json({
        mode: responseMode,
        byo_deep: byoDeepActive,
        deep_status: deepStatus,
        deep_available_at: deepAvailableIso,
        deep_cache_hit: deepFromCacheHit,
        deep_cache_stale: deepCacheStale,
        deep_cache_age_ms: deepCacheAgeMs,
        deep_cache_hint,
        deep_gate: kroBuildChannelProfileDeepGate(deepGatePayload),
        profile: null,
        merged_rows: matches.length > 1 ? matches.length : undefined,
        risk_index: null,
        risk_index_max: 100,
        false_positive_count: 0,
        analysis,
        live_metrics: liveMetrics,
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
    let analysis;
    if (deepMode && !deepBlocked) {
      analysis = once.ok
        ? kroV0BuildAnalysisFromLiveParsed(parsedOnce, key)
        : kroV0BuildAnalysisFromScamBaseProfile(profileForAnalysis, { channel_key: key });
      if (!once.ok) {
        const timed = parsedOnce && parsedOnce.check_once_timed_out === true;
        analysis.basic_info = [
          timed
            ? 'Глубокий разбор ленты остановлен по лимиту времени (~30 мин.) — показана сводка мониторинга и жалоб; ниже то, что успели оценить без полной выборки постов.'
            : 'Разбор ленты в этом запросе не закончился (время или ограничения Telegram) — показана сводка мониторинга.',
        ].concat(analysis.basic_info || []);
      } else {
        analysis.basic_info = [
          `По каналу в мониторинге ${matches.length} совпадений; ниже — свежая проверка ленты в Telegram за широкое окно.`,
          `Последний статус в сводке: «${(profile.status || profile.verdict || '—')}» (${profile.detected_at || 'дата не указана'}).`,
        ].concat(analysis.basic_info || []);
        analysis.sources = Array.from(new Set([...(analysis.sources || []), 'мониторинг каналов']));
      }
    } else if (deepTelegramBlocked) {
      analysis = kroV0BuildAnalysisFromScamBaseProfile(profileForAnalysis, { channel_key: key });
      kroV0PrependFastModeNote(analysis, profileForAnalysis);
      kroV0MergeDeepRateLimitIntoAnalysis(analysis, deepAvailableIso);
      analysis.basic_info = [
        `По каналу в мониторинге ${matches.length} совпадений; глубокий прогон сейчас под лимитом Telegram.`,
        `Последний статус в сводке: «${(profile.status || profile.verdict || '—')}» (${profile.detected_at || 'дата не указана'}).`,
      ].concat(analysis.basic_info || []);
    } else if (deepThrottleLike) {
      analysis = kroV0BuildAnalysisFromScamBaseProfile(profileForAnalysis, { channel_key: key });
      kroV0PrependFastModeNote(analysis, profileForAnalysis);
      kroV0MergeServerDeepThrottleIntoAnalysis(analysis, serverThrottleMsg);
      analysis.basic_info = [
        `По каналу в мониторинге ${matches.length} совпадений; глубокий прогон сейчас ограничен на сервере.`,
        `Последний статус в сводке: «${(profile.status || profile.verdict || '—')}» (${profile.detected_at || 'дата не указана'}).`,
      ].concat(analysis.basic_info || []);
    } else if (deepQueued) {
      analysis = kroV0BuildAnalysisFromScamBaseProfile(profileForAnalysis, { channel_key: key });
      kroV0PrependFastModeNote(analysis, profileForAnalysis);
      kroV0MergeQueuedDeepIntoAnalysis(analysis, queuedMsg);
      analysis.basic_info = [
        `По каналу в мониторинге ${matches.length} совпадений; глубокий прогон поставлен в очередь из‑за нагрузки.`,
        `Последний статус в сводке: «${(profile.status || profile.verdict || '—')}» (${profile.detected_at || 'дата не указана'}).`,
      ].concat(analysis.basic_info || []);
    } else {
      analysis = kroV0BuildAnalysisFromScamBaseProfile(profileForAnalysis, { channel_key: key });
      kroV0PrependFastModeNote(analysis, profileForAnalysis);
      analysis.basic_info = [
        `По каналу в мониторинге ${matches.length} совпадений; в этом запросе ленту заново не читали (только сводка и жалобы).`,
        `Последний статус в сводке: «${(profile.status || profile.verdict || '—')}» (${profile.detected_at || 'дата не указана'}).`,
      ].concat(analysis.basic_info || []);
    }
    const watchRowCp2 = await fetchLatestChannelsWatchRowForKey(sheetsClient, key);
    if (watchRowCp2) kroV0EnrichAnalysisWithWatch(analysis, watchRowCp2);
    if (homeQuickParsed) kroV0MergeHomeQuickLiveIntoFastAnalysis(analysis, homeQuickParsed, key);
    await kroEnrichAnalysisWithChannelHistory(analysis, key, `@${decoded}`);
    return res.json({
      mode: responseMode,
      byo_deep: byoDeepActive,
      deep_status: deepStatus,
      deep_available_at: deepAvailableIso,
      deep_cache_hit: deepFromCacheHit,
      deep_cache_stale: deepCacheStale,
      deep_cache_age_ms: deepCacheAgeMs,
      deep_cache_hint,
      deep_gate: kroBuildChannelProfileDeepGate(deepGatePayload),
      profile,
      merged_rows: matches.length > 1 ? matches.length : undefined,
      risk_index,
      risk_index_max: 100,
      false_positive_count,
      analysis,
      live_metrics: liveMetrics,
    });
  } catch (e) {
    console.error('KRO channel-profile error:', e);
    let dgErr = null;
    let degradedAnalysis = null;
    let degradedPublicSnapshot = null;
    try {
      const peekE = kroDeepAllowNewTelegramDeep(clientId);
      if (!peekE.allowed) {
        dgErr = {
          server_deep_blocked: true,
          server_throttle_scope: peekE.scope,
          message_ru: peekE.message_ru,
          wait_minutes_approx: peekE.wait_minutes_approx,
          wait_seconds_approx: peekE.wait_seconds_approx,
        };
      }
    } catch {
      /* ignore */
    }
    try {
      const fallbackClient = await getKroSheetsClient();
      degradedAnalysis = await kroV0BuildFastAnalysisNoLive(fallbackClient, key, decoded, null);
      degradedPublicSnapshot = await kroFetchTelegramPublicSnapshot(channelForOnce);
      if (degradedPublicSnapshot) {
        kroV0MergeHomeQuickPublicSnapshotIntoFastAnalysis(degradedAnalysis, degradedPublicSnapshot);
      } else {
        degradedAnalysis.basic_info = [
          'Технический сбой в live-пайплайне: показан поверхностный отчёт по доступным данным (мониторинг/жалобы).',
        ].concat(Array.isArray(degradedAnalysis.basic_info) ? degradedAnalysis.basic_info : []);
      }
      degradedAnalysis.conclusion = degradedAnalysis.conclusion && typeof degradedAnalysis.conclusion === 'object'
        ? degradedAnalysis.conclusion
        : { status: KRO_V0_STATUS.watch, reasons: [] };
      if (!degradedPublicSnapshot) {
        degradedAnalysis.conclusion.reasons = [
          'Живое чтение ленты в этом запросе не завершилось, поэтому вывод ограничен поверхностными источниками.',
        ].concat(Array.isArray(degradedAnalysis.conclusion.reasons) ? degradedAnalysis.conclusion.reasons : []);
      }
    } catch {
      degradedAnalysis = null;
      degradedPublicSnapshot = null;
    }
    return res.status(200).json({
      profile: null,
      merged_rows: undefined,
      risk_index: null,
      risk_index_max: 100,
      false_positive_count: 0,
      analysis: degradedAnalysis || {
        v: 0,
        channel_key: key,
        generated_at: new Date().toISOString(),
        sources: [],
        basic_info: ['Не удалось загрузить данные для отчёта.'],
        content_behavior: [],
        external_reports: [],
        ties_risk_factors: [],
        conclusion: {
          status: KRO_V0_STATUS.watch,
          reasons: ['Сервис не смог собрать данные — попробуйте обновить страницу позже.'],
        },
      },
      live_metrics: {
        mode: 'fast',
        home_quick_live: !!(degradedPublicSnapshot && Array.isArray(degradedPublicSnapshot.snippets) && degradedPublicSnapshot.snippets.length),
        fast_degraded: true,
        internal_error_fallback: true,
      },
      live_evidence: kroBuildLiveEvidence(
        null,
        degradedPublicSnapshot ? 'ok_public_content' : 'failed',
        degradedPublicSnapshot,
      ),
      mode: 'fast',
      deep_status: null,
      deep_available_at: null,
      deep_cache_hint,
      deep_gate: kroBuildChannelProfileDeepGate(dgErr),
      error: 'internal_error',
    });
  }
});

// Сброс in-memory deep (кэш / очередь / счётчики лимитов). Только с KRO_DEEP_OPS_SECRET; не трогает FLOOD_WAIT Telegram.
app.post('/api/kro/ops/deep-breathe', express.json({ limit: '4000' }), (req, res) => {
  if (!KRO_DEEP_OPS_SECRET) {
    return res.status(404).json({ error: 'not_found' });
  }
  const auth = (req.headers.authorization || '').toString();
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const qSec = (req.query.secret || '').toString();
  if (bearer !== KRO_DEEP_OPS_SECRET && qSec !== KRO_DEEP_OPS_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const scope = ((body.scope ?? req.query.scope) || 'cache').toString().trim().toLowerCase();
  if (!['cache', 'queue', 'limits', 'all'].includes(scope)) {
    return res.status(400).json({ error: 'bad_scope', message: 'scope must be cache, queue, limits, or all' });
  }
  const nCache = kroDeepChannelCache.size;
  const nQueue = kroDeepWaitQueue.length;
  const out = {
    ok: true,
    scope,
    cache_entries_before: nCache,
    queue_jobs_before: nQueue,
    cache_cleared: false,
    queue_cleared: false,
    limits_reset: false,
  };
  if (scope === 'cache' || scope === 'all') {
    kroDeepChannelCache.clear();
    out.cache_cleared = true;
  }
  if (scope === 'queue' || scope === 'all') {
    kroDeepWaitQueue.length = 0;
    out.queue_cleared = true;
  }
  if (scope === 'limits' || scope === 'all') {
    kroDeepGlobalRuns.length = 0;
    kroDeepClientRuns.clear();
    out.limits_reset = true;
  }
  if (scope === 'all') {
    kroScamBaseValuesCache = { ts: 0, values: null };
    kroReportsRowsCache = { ts: 0, rows: null };
    kroChannelsWatchRawCache = { ts: 0, raw: null };
    out.sheets_snapshot_cache_cleared = true;
  }
  return res.json(out);
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

function kroMapReportsSheetRow(r) {
  if (!r || !Array.isArray(r)) return null;
  return {
    date: (r[0] || '').toString().trim(),
    channel: (r[1] || '').toString().trim(),
    sum: parseInt((r[2] || '0').toString().replace(/\s/g, ''), 10) || 0,
    source: (r[3] || '').toString().trim(),
    status: (r[4] || '').toString().trim(),
    reporter: (r[5] || '').toString().trim(),
    description: (r[6] || '').toString().trim(),
    proof_url: (r[7] || '').toString().trim(),
    object_type: (r[8] || '').toString().trim(),
  };
}

function kroDedupeKroReportRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    if (!r) continue;
    const k = `${r.date}|${r.channel}|${(r.description || '').slice(0, 140)}|${(r.proof_url || '').slice(0, 100)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * Строки листа reports: точное совпадение канала + текст инвайта / подсказки в полях жалобы.
 */
function kroMergeReportsSheetRows(mappedRows, exactMatchChannel, analyzeKey, channelNameHintSanitized) {
  const rows = Array.isArray(mappedRows) ? mappedRows : [];
  const hint = String(channelNameHintSanitized || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const dk = exactMatchChannel ? channelMatchKey(exactMatchChannel) : '';
  const ak = String(analyzeKey || '').trim().toLowerCase();
  const inviteFull = ak.startsWith('t.me/+') ? ak : '';
  const inviteTail = inviteFull ? inviteFull.replace(/^t\.me\//i, '').toLowerCase() : '';
  const inviteHashOnly = inviteFull ? inviteFull.replace(/^t\.me\/\+/i, '').toLowerCase() : '';

  const seen = new Set();
  const out = [];
  const push = (row) => {
    const k = `${row.date}|${row.channel}|${(row.description || '').slice(0, 96)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(row);
  };

  if (dk) {
    for (const r of rows) {
      if (!r.channel && !r.description) continue;
      if (channelMatchKey(r.channel) === dk) push(r);
    }
  }

  if (inviteFull) {
    for (const r of rows) {
      const blob = `${r.channel}\n${r.description}\n${r.proof_url}`.toLowerCase().replace(/\s+/g, ' ');
      if (
        blob.includes(inviteFull)
        || (inviteTail && blob.includes(inviteTail))
        || (inviteHashOnly.length > 8 && blob.includes(inviteHashOnly))
      ) {
        push(r);
      }
    }
  }

  if (hint.length >= 3) {
    for (const r of rows) {
      const blob = `${r.channel}\n${r.description}\n${r.proof_url}`.toLowerCase();
      if (blob.includes(hint)) push(r);
    }
    const tokens = hint.split(/\s+/).filter((w) => w.length >= 4);
    if (tokens.length >= 2) {
      for (const r of rows) {
        const blob = `${r.channel}\n${r.description}\n${r.proof_url}`.toLowerCase();
        if (tokens.every((t) => blob.includes(t))) push(r);
      }
    }
  }

  return out;
}

async function getAllReportsForChannelMerged(client, exactMatchChannel, analyzeKey, channelNameHintSanitized) {
  if (!client || !kroSheetId) return [];
  try {
    const raw = await kroFetchReportsRowsCached(client);
    const mapped = (raw || []).map(kroMapReportsSheetRow).filter((r) => r && (r.channel || r.description));
    return kroDedupeKroReportRows(
      kroMergeReportsSheetRows(mapped, exactMatchChannel, analyzeKey, channelNameHintSanitized),
    );
  } catch (e) {
    return [];
  }
}

/**
 * Reads all reports for a given channel from the reports sheet (A2:H).
 * Returns array of { date, channel, sum, source, reporter, description, proof_url }.
 */
async function getAllReportsForChannel(client, channel) {
  if (!client || !kroSheetId) return [];
  try {
    const rows = await kroFetchReportsRowsCached(client);
    const key = channelMatchKey(channel);
    if (!key) return [];
    return rows
      .filter((r) => channelMatchKey((r[1] || '').toString()) === key)
      .map(kroMapReportsSheetRow);
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

/** Node 18+ по умолчанию режет запрос через ~5 мин (requestTimeout) — ломает home quick до 7 мин и deep до 30 мин. */
const HTTP_REQUEST_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.HTTP_REQUEST_TIMEOUT_MS || '1900000', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1900000;
})();

function applyLongRequestTimeouts(server) {
  if (!server || typeof server !== 'object') return;
  try {
    if (typeof server.requestTimeout !== 'undefined') {
      server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS === 0 ? 0 : HTTP_REQUEST_TIMEOUT_MS;
    }
    if (HTTP_REQUEST_TIMEOUT_MS > 0 && typeof server.headersTimeout !== 'undefined') {
      server.headersTimeout = Math.min(2147483647, HTTP_REQUEST_TIMEOUT_MS + 120000);
    }
  } catch {
    /* ignore */
  }
}

// Start both HTTP and HTTPS servers
const httpSrv = app.listen(PORT, '0.0.0.0', () => {
  resetKroLiveCounterCache();
  console.log('[KRO] live-counter cache reset on HTTP server listen (start / post-deploy process)');
  console.log(`✅ HTTP Backend listening on port ${PORT}`);
  console.log(`🌐 Access via: http://localhost:${PORT} or http://192.168.1.142:${PORT}`);
  if (HTTP_REQUEST_TIMEOUT_MS > 0) {
    console.log(`⏱ HTTP requestTimeout=${HTTP_REQUEST_TIMEOUT_MS} ms (KRO Telethon до 30 мин)`);
  }
});
applyLongRequestTimeouts(httpSrv);

if (httpsOptions) {
  const httpsSrv = https.createServer(httpsOptions, app).listen(4443, '0.0.0.0', () => {
    resetKroLiveCounterCache();
    console.log('[KRO] live-counter cache reset on HTTPS server listen');
    console.log(`✅ HTTPS Backend listening on port 4443`);
    console.log(`🔒 Access via: https://localhost:4443 or https://192.168.1.142:4443`);
  });
  applyLongRequestTimeouts(httpsSrv);
}
