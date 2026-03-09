/**
 * Обновление Google Doc «Sources and Data» содержимым из файла.
 * Запуск из корня проекта: node backend/scripts/update-google-doc-sources-and-data.js
 *
 * Требования:
 * 1. В Google Doc нажмите «Поделиться» и добавьте редактором email сервисного аккаунта
 *    (client_email из kro-google-credentials.json), например:
 *    service-account-name-check@neon-operator-488010-n8.iam.gserviceaccount.com
 * 2. Credentials: задать GOOGLE_APPLICATION_CREDENTIALS=backend/kro-worker/kro-google-credentials.json
 *    или передать путь к JSON с сервисным аккаунтом (scope: documents).
 */
import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Скрипт запускают из backend/: node scripts/update-google-doc-sources-and-data.js
const PROJECT_ROOT = join(__dirname, '..', '..');
const DOC_ID = '1VA3Vrt6sak_TXypqBqQalOWeOJHdQm20gz80s6rfi58';
const CONTENT_FILE = join(PROJECT_ROOT, 'Sources-and-Data-ВСТАВИТЬ-В-GOOGLE-DOC.txt');

dotenv.config({ path: join(PROJECT_ROOT, '.env') });

const PLACEHOLDER_5MIN = 'События за период — ниже';

function getContentFromFile() {
  const raw = fs.readFileSync(CONTENT_FILE, 'utf8');
  const marker = 'Sources and Data — источники и данные';
  const idx = raw.indexOf(marker);
  if (idx === -1) throw new Error('В файле не найден блок «Sources and Data — источники и данные»');
  const content = raw.slice(idx).trimEnd();
  if (!content.includes(PLACEHOLDER_5MIN)) {
    throw new Error('В файле должен оставаться плейсхолдер «' + PLACEHOLDER_5MIN + '» для скрипта update_live_log_5min.py (каждые 5 мин ищет данные и пишет в документ). Не удаляйте блок «Обновления каждые 5 мин».');
  }
  return content;
}

async function main() {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || join(PROJECT_ROOT, 'backend/kro-worker/kro-google-credentials.json');
  if (!fs.existsSync(credPath)) {
    console.error('❌ Файл учётных данных не найден:', credPath);
    console.error('   Задайте GOOGLE_APPLICATION_CREDENTIALS или положите kro-google-credentials.json в backend/kro-worker/');
    process.exit(1);
  }
  const credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const text = getContentFromFile();
  console.log('✓ Текст из файла прочитан, символов:', text.length);

  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/documents'],
  });
  const docs = google.docs({ version: 'v1', auth });

  let doc;
  try {
    doc = await docs.documents.get({ documentId: DOC_ID });
  } catch (e) {
    if (e.code === 403 || (e.message && e.message.includes('Permission'))) {
      console.error('❌ Нет доступа к документу. Откройте документ в Google Docs → «Поделиться» → добавьте редактором:');
      console.error('   ', credentials.client_email);
      process.exit(1);
    }
    throw e;
  }

  const body = doc.data.body?.content;
  if (!body || body.length === 0) {
    console.error('❌ Не удалось прочитать структуру документа');
    process.exit(1);
  }
  const startIndex = 1;
  const endIndex = body[body.length - 1].endIndex;
  if (endIndex <= startIndex) {
    console.error('❌ Документ пуст или некорректная структура');
    process.exit(1);
  }
  // API не позволяет удалять последний символ (перевод строки) сегмента
  const deleteEndIndex = Math.max(startIndex, endIndex - 1);

  const requests = [
    { deleteContentRange: { range: { startIndex, endIndex: deleteEndIndex } } },
    { insertText: { location: { index: startIndex }, text } },
  ];

  await docs.documents.batchUpdate({
    documentId: DOC_ID,
    requestBody: { requests },
  });

  console.log('✅ Документ обновлён: https://docs.google.com/document/d/' + DOC_ID + '/edit');
}

main().catch((e) => {
  console.error('❌ Ошибка:', e.message);
  process.exit(1);
});
