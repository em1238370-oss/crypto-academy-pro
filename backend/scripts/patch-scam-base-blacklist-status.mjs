/**
 * Патч scam_base: строки с источником только каталог (vklader / kurs.expert)
 * и evidence без конкретных фактов обмана (только чёрный список).
 *
 * Для них: status → «под наблюдением», в source_evidence добавляется пометка
 * «источник: чёрный список — конкретных фактов обмана не найдено» (идемпотентно).
 *
 * Запуск из корня репозитория:
 *   node backend/scripts/patch-scam-base-blacklist-status.mjs --dry-run
 *   node backend/scripts/patch-scam-base-blacklist-status.mjs --apply
 *
 * По умолчанию primary строго: vklader | kurs.expert (как в ТЗ).
 * Органический воркер пишет kurs.expert+search — добавь флаг:
 *   node backend/scripts/patch-scam-base-blacklist-status.mjs --dry-run --include-kurs-search
 *
 * Требует .env: KRO_SHEET_ID, KRO_GOOGLE_CREDENTIALS_JSON или GOOGLE_APPLICATION_CREDENTIALS,
 * опционально KRO_SCAM_BASE_RANGE (по умолчанию scam_base!A2:N).
 */
import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');
dotenv.config({ path: join(projectRoot, '.env') });
dotenv.config({ path: join(projectRoot, 'backend', 'kro-worker', '.env') });

const NOTE =
  'источник: чёрный список — конкретных фактов обмана не найдено';
const TARGET_STATUS = 'под наблюдением';

const COL = {
  username: 0,
  source_primary: 9,
  source_evidence: 10,
  status: 12,
};

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const includeKursSearch = argv.includes('--include-kurs-search');
  return { dryRun: !apply, includeKursSearch };
}

function primaryMatches(raw, includeKursSearch) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (s === 'vklader' || s === 'kurs.expert') return true;
  if (includeKursSearch && s === 'kurs.expert+search') return true;
  return false;
}

/** Есть явные «факты обмана» (статьи, схемы, жертвы) — не трогаем. */
function hasConcreteFraudFacts(text) {
  const t = String(text ?? '');
  if (/stop-scam1\.com\/[^|\s]+\//i.test(t) && t.length > 280) return true;
  if (/fin-obzor\.net/i.test(t) && t.length > 200) return true;
  if (
    /жертв|развод|обман|лохотрон|схема\s+обмана|заманивают|типичн(ая|ой)\s+схем|мошенник/i.test(
      t
    ) &&
    t.length > 140
  ) {
    return true;
  }
  return false;
}

/** Упоминание чёрного списка / страницы списка без обязательной схемы в тексте. */
function mentionsBlacklistOnlyContext(text) {
  const t = String(text ?? '');
  return (
    /черн(ый|ого|ом)\s+список/i.test(t) ||
    /cherniy-spisok/i.test(t) ||
    /\/blacklist-telegram\//i.test(t) ||
    /kurs\.expert\/[^|\s]*cherniy-spisok/i.test(t)
  );
}

function isBlacklistOnlyEvidence(evidence) {
  const t = String(evidence ?? '').trim();
  if (!t) return false;
  if (!mentionsBlacklistOnlyContext(t)) return false;
  return !hasConcreteFraudFacts(t);
}

function mergeNote(evidence) {
  const t = String(evidence ?? '').trim();
  if (t.includes(NOTE)) return t;
  return t ? `${NOTE} | ${t}` : NOTE;
}

async function getSheetsClient() {
  const kroSheetId = process.env.KRO_SHEET_ID;
  const kroCredentialsJson = process.env.KRO_GOOGLE_CREDENTIALS_JSON;
  let kroCredentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!kroSheetId) {
    throw new Error('KRO_SHEET_ID не задан');
  }
  let credentials;
  if (kroCredentialsJson && kroCredentialsJson.trim()) {
    try {
      credentials = JSON.parse(kroCredentialsJson);
    } catch (e) {
      console.warn(
        'KRO_GOOGLE_CREDENTIALS_JSON не парсится, пробуем файл:',
        e.message
      );
    }
  }
  if (!credentials) {
    const defaultFile = join(
      projectRoot,
      'backend',
      'kro-worker',
      'kro-google-credentials.json'
    );
    if (!kroCredentialsPath && fs.existsSync(defaultFile)) {
      kroCredentialsPath = defaultFile;
    }
  }
  if (!credentials && kroCredentialsPath) {
    const absPath = join(process.cwd(), kroCredentialsPath);
    const path = fs.existsSync(absPath) ? absPath : kroCredentialsPath;
    if (!fs.existsSync(path)) {
      throw new Error(`Файл credentials не найден: ${kroCredentialsPath}`);
    }
    credentials = JSON.parse(fs.readFileSync(path, 'utf8'));
  }
  if (!credentials) {
    throw new Error(
      'Задай валидный KRO_GOOGLE_CREDENTIALS_JSON, GOOGLE_APPLICATION_CREDENTIALS или положите backend/kro-worker/kro-google-credentials.json'
    );
  }
  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return { sheets: google.sheets({ version: 'v4', auth }), kroSheetId };
}

function rangeSheetName(rangeRaw) {
  const r = String(rangeRaw || 'scam_base!A2:N');
  return r.includes('!') ? r.split('!')[0] : 'scam_base';
}

function effectiveScamBaseRange(raw) {
  const r = String(raw || 'scam_base!A2:N');
  // В .env воркера часто A2:H — для v2 (J–M) патчу нужен полный диапазон
  if (/:H$/i.test(r) && /^scam_base!/i.test(r)) {
    console.warn(
      'KRO_SCAM_BASE_RANGE заканчивается на :H — для scam_base v2 подставляем :N (колонки J–M).'
    );
    return r.replace(/:H$/i, ':N');
  }
  return r;
}

async function main() {
  const { dryRun, includeKursSearch } = parseArgs(process.argv.slice(2));
  const rangeRaw = effectiveScamBaseRange(
    process.env.KRO_SCAM_BASE_RANGE || 'scam_base!A2:N'
  );
  const sheetName = rangeSheetName(rangeRaw);

  const { sheets, kroSheetId } = await getSheetsClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: kroSheetId,
    range: rangeRaw,
  });
  const rows = resp.data.values || [];

  const updates = [];
  rows.forEach((row, idx) => {
    const sheetRow = idx + 2;
    const username = (row[COL.username] ?? '').toString().trim();
    if (!username || username === 'username') return;

    const primary = row[COL.source_primary] ?? '';
    if (!primaryMatches(primary, includeKursSearch)) return;

    const evidence = row[COL.source_evidence] ?? '';
    if (!isBlacklistOnlyEvidence(evidence)) return;

    const currentStatus = (row[COL.status] ?? '').toString().trim();
    const newEvidence = mergeNote(evidence);
    const needStatus = currentStatus !== TARGET_STATUS;
    const needEvidence = newEvidence !== evidence;

    if (!needStatus && !needEvidence) return;

    updates.push({
      sheetRow,
      username,
      primary: primary.toString().trim(),
      needStatus,
      needEvidence,
      newEvidence,
    });
  });

  console.log(
    includeKursSearch
      ? 'Primary: vklader | kurs.expert | kurs.expert+search (--include-kurs-search)'
      : 'Primary: только vklader | kurs.expert'
  );
  console.log(`Строк к обновлению: ${updates.length}`);
  updates.forEach((u) => {
    console.log(
      `  строка ${u.sheetRow} | ${u.username} | primary=${u.primary} | status→${TARGET_STATUS} | evidence+пометка=${u.needEvidence}`
    );
  });

  if (dryRun) {
    console.log('\n(dry-run: повтори с --apply для записи в таблицу)');
    return;
  }

  if (!updates.length) {
    console.log('Нечего записывать.');
    return;
  }

  const data = [];
  for (const u of updates) {
    if (u.needEvidence) {
      data.push({
        range: `${sheetName}!K${u.sheetRow}`,
        values: [[u.newEvidence]],
      });
    }
    if (u.needStatus) {
      data.push({
        range: `${sheetName}!M${u.sheetRow}`,
        values: [[TARGET_STATUS]],
      });
    }
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: kroSheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data,
    },
  });

  console.log(`\nЗаписано: ${updates.length} строк (batchUpdate).`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
