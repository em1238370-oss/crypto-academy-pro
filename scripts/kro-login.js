#!/usr/bin/env node
/**
 * Один раз войти в Telegram для проверки каналов по ссылке.
 * Запуск из корня проекта: node scripts/kro-login.js
 * Дальше введи номер телефона (+79...) и код из приложения Telegram (5 цифр).
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key && !process.env[key]) process.env[key] = val;
    }
  });
}

const apiId = process.env.TELEGRAM_API_ID;
const apiHash = process.env.TELEGRAM_API_HASH;
if (!apiId || !apiHash) {
  console.error('Ошибка: в .env должны быть TELEGRAM_API_ID и TELEGRAM_API_HASH (получить на https://my.telegram.org).');
  process.exit(1);
}

const kroWorker = path.join(root, 'backend', 'kro-worker');
const loginScript = path.join(kroWorker, 'login_telegram.py');
if (!fs.existsSync(loginScript)) {
  console.error('Ошибка: не найден backend/kro-worker/login_telegram.py');
  process.exit(1);
}

console.log('Сейчас откроется вход в Telegram. Введи номер (+79...) и код из приложения Telegram (5 цифр).\n');
const child = spawn('python3', [loginScript], {
  cwd: kroWorker,
  env: { ...process.env, TELEGRAM_API_ID: apiId, TELEGRAM_API_HASH: apiHash },
  stdio: 'inherit'
});
child.on('close', (code) => {
  process.exit(code !== null && code !== undefined ? code : 0);
});
child.on('error', (err) => {
  console.error('Ошибка запуска Python:', err.message);
  console.error('Убедись, что установлены зависимости: cd backend/kro-worker && pip3 install -r requirements.txt');
  process.exit(1);
});
