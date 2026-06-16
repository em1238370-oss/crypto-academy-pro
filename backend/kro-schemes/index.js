import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMES_PATH = join(__dirname, 'schemes.json');

let _cache = null;

/** @returns {{ version: number, schemes: object[], categories: object }} */
export function kroLoadSchemes() {
  if (_cache) return _cache;
  const raw = fs.readFileSync(SCHEMES_PATH, 'utf8');
  _cache = JSON.parse(raw);
  return _cache;
}

/** Компактный список схем для промпта Mistral. */
export function kroSchemesPromptBlock() {
  const { schemes } = kroLoadSchemes();
  return schemes
    .map((s, i) => {
      const sig = (s.signals || []).slice(0, 2).join('; ');
      return `${i + 1}. ${s.name} — признаки: ${sig}`;
    })
    .join('\n');
}

/**
 * Быстрая проверка текста постов по ключевым словам (без AI).
 * @param {string[]} texts
 * @returns {Array<{ id, name, category, severity, how_earn, victim_risk, channel_link, quote, match_keyword }>}
 */
export function kroDetectSchemesInTexts(texts) {
  const { schemes } = kroLoadSchemes();
  const joined = (Array.isArray(texts) ? texts : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  if (!joined.length) return [];

  const fullLower = joined.join('\n').toLowerCase();
  const hits = [];

  for (const scheme of schemes) {
    const kws = Array.isArray(scheme.keywords) ? scheme.keywords : [];
    let matchedKw = '';
    for (const kw of kws) {
      const k = String(kw || '').toLowerCase().trim();
      if (k.length >= 3 && fullLower.includes(k)) {
        matchedKw = kw;
        break;
      }
    }
    if (!matchedKw) continue;

    let quote = '';
    for (const line of joined) {
      const low = line.toLowerCase();
      if (low.includes(String(matchedKw).toLowerCase())) {
        quote = line.slice(0, 220);
        break;
      }
    }
    if (!quote) {
      for (const line of joined) {
        for (const kw of kws) {
          if (line.toLowerCase().includes(String(kw).toLowerCase())) {
            quote = line.slice(0, 220);
            break;
          }
        }
        if (quote) break;
      }
    }

    hits.push({
      id: scheme.id,
      name: scheme.name,
      category: scheme.category,
      severity: scheme.severity || 'medium',
      how_earn: scheme.how_earn || '',
      victim_risk: scheme.victim_risk || '',
      channel_link: scheme.channel_link || '',
      quote: quote || '',
      match_keyword: matchedKw,
      source: 'keyword',
    });
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  hits.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  return hits.slice(0, 12);
}

/** Объединить keyword-хиты и AI-хиты без дублей по id. */
export function kroMergeSchemeHits(keywordHits, aiHits) {
  const out = [];
  const seen = new Set();
  const add = (h) => {
    if (!h || !h.id || seen.has(h.id)) return;
    seen.add(h.id);
    out.push(h);
  };
  (Array.isArray(aiHits) ? aiHits : []).forEach(add);
  (Array.isArray(keywordHits) ? keywordHits : []).forEach(add);
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  out.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  return out.slice(0, 10);
}

/** Текст red_flags из найденных схем. */
export function kroFormatSchemeRedFlags(hits) {
  const arr = Array.isArray(hits) ? hits : [];
  if (!arr.length) return 'Явных манипулятивных схем не найдено';
  return arr
    .slice(0, 6)
    .map((h) => {
      const q = h.quote ? `: «${String(h.quote).slice(0, 120)}»` : '';
      return `[${h.name}]${q}`;
    })
    .join('; ');
}

/**
 * Нечёткий поиск схемы по названию (word-overlap ≥ 0.5).
 * Используется для сопоставления AI-ответа со схемами из schemes.json.
 * @param {string} rawName
 * @returns {{ id, name, victim_risk, how_earn, severity } | null}
 */
export function kroFindSchemeByName(rawName) {
  const { schemes } = kroLoadSchemes();
  const normalize = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[«»\[\]"'„"]/g, '')
      .trim();
  const words = (s) => normalize(s).split(/\s+/).filter((w) => w.length >= 3);

  const query = words(rawName);
  if (!query.length) return null;

  let best = null;
  let bestScore = 0;

  for (const scheme of schemes) {
    const sWords = words(scheme.name);
    if (!sWords.length) continue;
    const intersection = query.filter((w) => sWords.includes(w)).length;
    const union = new Set([...query, ...sWords]).size;
    const score = union > 0 ? intersection / union : 0;
    if (score > bestScore) {
      bestScore = score;
      best = scheme;
    }
  }

  if (bestScore >= 0.5) {
    return {
      id: best.id,
      name: best.name,
      victim_risk: best.victim_risk || '',
      how_earn: best.how_earn || '',
      severity: best.severity || 'medium',
    };
  }
  return null;
}

/**
 * Преобразует keyword-хиты в структурированный red_flags_list [{name, quote, why}].
 * why берётся из victim_risk схемы.
 * @param {Array} hits — результат kroDetectSchemesInTexts
 * @returns {Array<{name: string, quote: string, why: string}>}
 */
export function kroSchemeHitsToRedFlagsList(hits) {
  return (Array.isArray(hits) ? hits : []).slice(0, 6).map((h) => ({
    name: String(h.name || '').trim(),
    quote: String(h.quote || '').trim().slice(0, 220),
    why: String(h.victim_risk || '').trim(),
  }));
}
