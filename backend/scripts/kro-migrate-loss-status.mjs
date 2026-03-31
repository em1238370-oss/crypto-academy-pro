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

function normalizeRiskStatusByLoss(totalLossRub, status) {
  const base = String(status || '').trim();
  const loss = Number(totalLossRub) || 0;
  if (loss > 0) return 'в риске';
  return base || 'под наблюдением';
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
  const configuredRange = process.env.KRO_SCAM_BASE_RANGE || 'scam_base!A2:N';
  const sheetName = configuredRange.includes('!') ? configuredRange.split('!')[0] : 'scam_base';
  // Always read A..M explicitly for migration logic:
  // A=username, I=total_loss_rub, M=status.
  const range = `${sheetName}!A2:M`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const rows = resp.data.values || [];
  const updates = [];
  const changed = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = i + 2;
    const username = (r[0] || '').toString().trim();
    const totalLoss = parseInt((r[8] || '0').toString().replace(/[^\d-]/g, ''), 10) || 0;
    const status = (r[12] || '').toString().trim();
    const normalized = normalizeRiskStatusByLoss(totalLoss, status);
    if (normalized !== status) {
      changed.push({ rowNo, username, totalLoss, oldStatus: status || '—', newStatus: normalized });
      if (apply) {
        updates.push({
          range: `${sheetName}!M${rowNo}`,
          values: [[normalized]],
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
    scanned: rows.length,
    changedCount: changed.length,
    appliedUpdates: apply ? updates.length : 0,
    changedRows: changed,
  };

  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`scanned: ${out.scanned}`);
  console.log(`changedCount: ${out.changedCount}`);
  if (apply) console.log(`appliedUpdates: ${out.appliedUpdates}`);
  if (changed.length) {
    changed.slice(0, 20).forEach((row) => {
      console.log(`#${row.rowNo} ${row.username || '(empty username)'}: ${row.oldStatus} -> ${row.newStatus} (loss=${row.totalLoss})`);
    });
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
