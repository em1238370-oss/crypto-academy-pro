/**
 * Заменяет содержимое Google Doc «Sources and Data» одной строкой:
 * «Актуальные данные системы мониторинга: https://crypto-academy-pro.onrender.com/monitor»
 *
 * Запуск:
 *   cd /Users/elizavetamedvedeva/Documents/GitHub/crypto-academy-pro
 *   node backend/scripts/replace-sources-doc-with-monitor-link.js
 *
 * Требует: сервисный аккаунт добавлен редактором в Google Doc (см. client_email в credentials).
 */
import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');

dotenv.config({ path: join(PROJECT_ROOT, '.env') });

const DOC_ID = '1VA3Vrt6sak_TXypqBqQalOWeOJHdQm20gz80s6rfi58';
const NEW_TEXT = 'Актуальные данные системы мониторинга: https://crypto-academy-pro.onrender.com/monitor';

async function main() {
  const credPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    join(PROJECT_ROOT, 'backend/kro-worker/kro-google-credentials.json');

  if (!fs.existsSync(credPath)) {
    console.error('❌ Credentials file not found:', credPath);
    console.error('   Set GOOGLE_APPLICATION_CREDENTIALS or place kro-google-credentials.json in backend/kro-worker/');
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  console.log('✓ Credentials loaded for:', credentials.client_email);

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
      console.error('❌ No access to document. Share the doc with this service account as Editor:');
      console.error('   ', credentials.client_email);
      process.exit(1);
    }
    throw e;
  }

  const body = doc.data.body?.content;
  if (!body || body.length === 0) {
    console.error('❌ Could not read document structure');
    process.exit(1);
  }

  const startIndex = 1;
  const endIndex = body[body.length - 1].endIndex;
  const deleteEndIndex = Math.max(startIndex, endIndex - 1);

  console.log(`✓ Document has ${endIndex} chars. Replacing with monitor link…`);

  await docs.documents.batchUpdate({
    documentId: DOC_ID,
    requestBody: {
      requests: [
        { deleteContentRange: { range: { startIndex, endIndex: deleteEndIndex } } },
        { insertText: { location: { index: startIndex }, text: NEW_TEXT } },
      ],
    },
  });

  console.log('✅ Document updated successfully!');
  console.log('   New content:', NEW_TEXT);
  console.log('   View: https://docs.google.com/document/d/' + DOC_ID + '/edit');
}

main().catch((e) => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
