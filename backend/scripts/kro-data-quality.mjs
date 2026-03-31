import dotenv from 'dotenv';
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');

dotenv.config({ path: join(projectRoot, '.env'), quiet: true });
dotenv.config({ path: join(projectRoot, 'backend', 'kro-worker', '.env'), quiet: true });

const REQUIRED = [
  'крипта', 'крипто', 'crypto', 'bitcoin', 'btc', 'usdt',
  'трейдинг', 'trading', 'обменник', 'exchange',
  'инвестиции', 'инвест', 'сигнал', 'signal',
];
const NON = [
  'недвижим', 'квартир', 'новострой', 'ипотек', 'риелт', 'аренд',
  'автомоб', 'машин', 'дилер', 'real estate', 'car ', 'mortgage',
];

function hasCryptoContext(...parts) {
  const blob = parts.map((v) => (v == null ? '' : String(v))).join(' ').toLowerCase();
  if (!blob.trim()) return false;
  if (NON.some((h) => blob.includes(h))) return false;
  return REQUIRED.some((h) => blob.includes(h));
}

function statusIsExactRisk(status) {
  const s = String(status || '').trim().toLowerCase();
  return s === 'в риске';
}

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
  };
}

function getCredentials() {
  const raw = process.env.KRO_GOOGLE_CREDENTIALS_JSON;
  if (raw && raw.trim()) {
    try { return JSON.parse(raw); } catch {}
  }
  const f = join(projectRoot, 'backend', 'kro-worker', 'kro-google-credentials.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  throw new Error('No valid Google credentials');
}

async function main() {
  const { apply, json } = parseArgs(process.argv.slice(2));
  const sheetId = process.env.KRO_SHEET_ID;
  if (!sheetId) throw new Error('KRO_SHEET_ID missing');

  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const range = process.env.KRO_SCAM_BASE_RANGE || 'scam_base!A2:N';
  const sheetName = range.includes('!') ? range.split('!')[0] : 'scam_base';

  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const rows = resp.data.values || [];

  const coursesRows = [];
  const nonCryptoRows = [];
  const lossStatusRows = [];
  const updates = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = i + 2;
    const username = (r[0] || '').toString().trim();
    const objectType = (r[5] || '').toString().trim();
    const sourcePrimary = (r[9] || '').toString().trim();
    const sourceEvidence = (r[10] || '').toString().trim();
    const status = (r[12] || '').toString().trim();
    const totalLoss = parseInt((r[8] || '0').toString().replace(/\s/g, ''), 10) || 0;

    const isCourseType = ['курс', 'сайт', 'обучен', 'обменник', 'инвест']
      .some((kw) => objectType.toLowerCase().includes(kw));
    if (isCourseType) {
      coursesRows.push({ rowNo, username, objectType, totalLoss, status });
    }

    const okCrypto = hasCryptoContext(username, objectType, sourcePrimary, sourceEvidence, r[13] || '');
    if (!okCrypto) {
      nonCryptoRows.push({ rowNo, username, objectType, status });
    }

    if (totalLoss > 0 && !statusIsExactRisk(status)) {
      lossStatusRows.push({ rowNo, username, totalLoss, status });
      if (apply) {
        updates.push({
          range: `${sheetName}!M${rowNo}`,
          values: [['в риске']],
        });
      }
    }
  }

  if (apply && updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates,
      },
    });
  }

  const out = {
    scam_total: rows.length,
    coursesCount: coursesRows.length,
    coursesRows,
    nonCryptoCount: nonCryptoRows.length,
    nonCryptoRows,
    lossStatusMismatchCount: lossStatusRows.length,
    lossStatusRows,
    appliedStatusUpdates: apply ? updates.length : 0,
  };
  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`scam_total: ${out.scam_total}`);
  console.log(`coursesCount: ${out.coursesCount}`);
  console.log(`nonCryptoCount: ${out.nonCryptoCount}`);
  console.log(`lossStatusMismatchCount: ${out.lossStatusMismatchCount}`);
  if (apply) console.log(`appliedStatusUpdates: ${out.appliedStatusUpdates}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

