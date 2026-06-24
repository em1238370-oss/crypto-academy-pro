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
 * Найти схему по неточному совпадению названия (для AI-флагов без точного id).
 * Сравнивает по словам (>=3 символа), порог совпадения 0.5 от меньшего набора слов.
 * @param {string} rawName
 * @returns {object|null}
 */
export function kroFindSchemeByName(rawName) {
  const { schemes } = kroLoadSchemes();
  const norm = String(rawName || '')
    .toLowerCase()
    .replace(/[«»"'.,!?()/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return null;
  const words = new Set(norm.split(' ').filter((w) => w.length >= 3));
  if (!words.size) return null;
  let best = null;
  let bestScore = 0;
  for (const s of schemes) {
    const sn = String(s.name || '')
      .toLowerCase()
      .replace(/[«»"'.,!?()/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const sWords = sn.split(' ').filter((w) => w.length >= 3);
    if (!sWords.length) continue;
    let overlap = 0;
    for (const w of sWords) if (words.has(w)) overlap += 1;
    const score = overlap / Math.min(words.size, sWords.length);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

/** Преобразует хиты схем в структурированный список {name, quote, why} для фронта. */
export function kroSchemeHitsToRedFlagsList(hits) {
  const arr = Array.isArray(hits) ? hits : [];
  return arr
    .slice(0, 8)
    .map((h) => ({
      name: h.name || '',
      quote: h.quote ? String(h.quote).slice(0, 220) : '',
      why: h.victim_risk || '',
    }))
    .filter((x) => x.name);
}

/**
 * Эвристические "мягкие" сигналы — в отличие от kroDetectSchemesInTexts (ищет присутствие
 * конкретного ключевого слова одной схемы), эти сигналы считаются по статистике ПО ВСЕМ
 * полученным постам: что упоминается часто, а что не упоминается вообще. Это страховка на
 * случай, когда ни одна схема из списка не сматчилась явным ключевым словом, но за месяц
 * данных видна типичная для скам-каналов картина (только прибыль без единого убытка, нет
 * предупреждений о риске, канал в основном продаёт доступ, а не даёт ценность).
 * Срабатывает только при >=5 реальных постах — на малом объёме данных выводов не делает.
 * Не выдумывает фактов: считает реальные слова в реальных текстах, а где сигнал — это
 * отсутствие чего-то (нет дисклеймера о риске), quote оставляет пустым, потому что
 * "отсутствие" невозможно процитировать.
 * @param {string[]} texts
 * @returns {Array<{name: string, quote: string, why: string}>}
 */
export function kroDetectSoftPatternSignals(texts) {
  const posts = (Array.isArray(texts) ? texts : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  if (posts.length < 5) return [];

  const lowerPosts = posts.map((p) => p.toLowerCase());
  const joinedLower = lowerPosts.join('\n');
  const out = [];

  const profitWords = ['прибыль', 'профит', 'заработали', 'успешн', 'take profit', 'тейк профит', 'win', 'profit', 'иксы', 'x2', 'x5', 'x10'];
  const lossWords = ['убыток', 'минус', 'слил', 'stop loss', 'стоп сработал', 'просадк', 'потерял', 'loss', 'минусов'];
  const hasProfitTalk = profitWords.some((w) => joinedLower.includes(w));
  const hasLossTalk = lossWords.some((w) => joinedLower.includes(w));
  if (hasProfitTalk && !hasLossTalk) {
    const exIdx = lowerPosts.findIndex((p) => profitWords.some((w) => p.includes(w)));
    out.push({
      name: 'Видны только прибыльные сделки',
      quote: exIdx >= 0 ? posts[exIdx].slice(0, 220) : '',
      why: `Из ${posts.length} проверенных постов про прибыль пишут регулярно, а про убыточные сделки — ни разу. У реальной торговли почти всегда есть потери; их полное отсутствие в ленте — признак того, что показывают не всю картину.`,
    });
  }

  const riskWords = ['не финсовет', 'не финансовый совет', 'dyor', 'риск потери', 'торгуйте на свой риск', 'без гарантий', 'не гарантия', 'на свой риск'];
  const hasRiskDisclaimer = riskWords.some((w) => joinedLower.includes(w));
  if (!hasRiskDisclaimer) {
    out.push({
      name: 'Нет предупреждений о риске',
      quote: '',
      why: `За ${posts.length} проверенных постов канал ни разу не написал, что результаты не гарантированы и можно потерять деньги. Это не доказывает обман сам по себе, но снимает с автора любую ответственность за твои потери.`,
    });
  }

  const ctaWords = ['vip', 'оплат', 'тариф', 'купить доступ', 'по ссылке в био', 'подключ', 'цена за месяц', 'стоимость доступа'];
  const ctaPostsCount = lowerPosts.filter((p) => ctaWords.some((w) => p.includes(w))).length;
  const ctaRatio = ctaPostsCount / posts.length;
  if (ctaRatio >= 0.25) {
    const exIdx = lowerPosts.findIndex((p) => ctaWords.some((w) => p.includes(w)));
    out.push({
      name: 'Высокая доля продающих постов',
      quote: exIdx >= 0 ? posts[exIdx].slice(0, 220) : '',
      why: `${ctaPostsCount} из ${posts.length} проверенных постов (~${Math.round(ctaRatio * 100)}%) — это призывы оплатить доступ, а не разбор рынка или сделок. Канал тратит больше внимания на продажу подписки, чем на пользу для подписчика.`,
    });
  }

  return out.slice(0, 3);
}
