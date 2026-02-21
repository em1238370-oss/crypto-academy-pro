/**
 * Проверка подключения к Google Таблице (KRO).
 * Запуск из корня проекта: node backend/scripts/verify-kro-google.js
 * Требует в .env: KRO_SHEET_ID, KRO_GOOGLE_CREDENTIALS_JSON (или GOOGLE_APPLICATION_CREDENTIALS + файл), KRO_SCAM_BASE_RANGE.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = join(__dirname, '..', '..');
dotenv.config({ path: join(projectRoot, '.env') });

const kroSheetId = process.env.KRO_SHEET_ID;
const kroCredentialsJson = process.env.KRO_GOOGLE_CREDENTIALS_JSON;
const kroCredentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const kroScamBaseRange = process.env.KRO_SCAM_BASE_RANGE || 'scam_base!A2:H';

async function main() {
  console.log('Проверка KRO + Google Sheets...\n');

  if (!kroSheetId) {
    console.error('❌ KRO_SHEET_ID не задан в .env');
    process.exit(1);
  }
  console.log('✓ KRO_SHEET_ID задан');

  let credentials;
  if (kroCredentialsJson) {
    try {
      credentials = JSON.parse(kroCredentialsJson);
    } catch (e) {
      console.error('❌ KRO_GOOGLE_CREDENTIALS_JSON — невалидный JSON');
      process.exit(1);
    }
  } else if (kroCredentialsPath) {
    const absPath = join(process.cwd(), kroCredentialsPath);
    if (!fs.existsSync(absPath) && !fs.existsSync(kroCredentialsPath)) {
      console.error('❌ Файл credentials не найден:', kroCredentialsPath);
      process.exit(1);
    }
    const path = fs.existsSync(absPath) ? absPath : kroCredentialsPath;
    credentials = JSON.parse(fs.readFileSync(path, 'utf8'));
  } else {
    console.error('❌ Задай KRO_GOOGLE_CREDENTIALS_JSON или GOOGLE_APPLICATION_CREDENTIALS в .env');
    process.exit(1);
  }
  console.log('✓ Учётные данные Google найдены');

  try {
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // Читаем первый лист (Отчёты) A1:F2
    const reportRes = await sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: 'A1:F2'
    });
    const reportRows = reportRes.data.values || [];
    console.log('✓ Первый лист (Отчёты) прочитан, строк:', reportRows.length);

    // Читаем scam_base
    const scamRes = await sheets.spreadsheets.values.get({
      spreadsheetId: kroSheetId,
      range: kroScamBaseRange
    });
    const scamRows = scamRes.data.values || [];
    console.log('✓ Лист scam_base прочитан, строк:', scamRows.length);

    console.log('\n✅ Подключение к таблице работает. Можно выставлять переменные на Render и деплоить.');
  } catch (e) {
    if (e.code === 403 || (e.message && e.message.includes('Permission'))) {
      console.error('❌ Нет доступа к таблице. В Google Таблице нажми «Поделиться» и добавь email сервисного аккаунта (client_email из JSON) с правом Редактор.');
    } else {
      console.error('❌ Ошибка:', e.message);
    }
    process.exit(1);
  }
}

main();
