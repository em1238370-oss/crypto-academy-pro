#!/usr/bin/env python3
"""
KRO 12h auto-monitor: два цикла в день — 11:00 и 23:00 MSK. Собирает данные из TGStat search,
Telega.io каталога и чатов Telegram; применяет критерии (возраст <14 дн., VIP>10к ₽, рост >500/сутки);
пишет в JSON и лист; создаёт отчёт и документ SOURCE & DATA. Документ обновляется автоматически (проверка «Готово/Не готово» не обязательна);
Данные отправляются на сайт (POST KRO_SITE_UPDATE_URL) при каждом запуске сбора, чтобы цифры сразу отражались на сайте.

Источники: 1) TGStat channels/search (криптовалюта), 2) Telega.io catalog, 3) KRO_SOURCE_CHANNELS (жалобы за 12ч).

Запуск: из папки backend/kro-worker:
  python3 run_12h_monitor.py

Cron (11:00 и 23:00 MSK = 08:00 и 20:00 UTC при MSK=UTC+3):
  0 8,20 * * * cd /path/to/backend/kro-worker && python3 run_12h_monitor.py
"""
import os
import re
import sys
import json
import asyncio
import time
import html
from datetime import datetime, timedelta, timezone
from collections import defaultdict
from urllib.parse import quote

# Web scraper for monitored complaint/review sources (imported lazily to avoid breaking if missing)
try:
    import web_scraper as _web_scraper
    _WEB_SCRAPER_AVAILABLE = True
except ImportError:
    _WEB_SCRAPER_AVAILABLE = False

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '..'))
DATA_DIR = os.path.join(BACKEND_DIR, 'data')
OUTPUT_JSON = os.path.join(DATA_DIR, 'kro-12h-stats.json')
LAST_CYCLE_JSON = os.path.join(DATA_DIR, 'kro-12h-stats.last-cycle.json')
PUBLISH_HISTORY_JSON = os.path.join(DATA_DIR, 'kro-publish-history.json')
CHANNEL_OBJECTS_JSON = os.path.join(DATA_DIR, 'channel_objects.json')
LIVE_LOG_FILE = os.path.join(DATA_DIR, 'live_log_5min.json')
LIVE_LOG_MAX_LINES = 50
REPORT_COUNTER_KEY = 'lastReportNumber'
PUBLISH_HISTORY_LIMIT = 10
SUSPICIOUS_ZERO_STREAK_ALERT = 2

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0'
REQUEST_DELAY = 3
HOURS_12 = 12
DAYS_14 = 14   # критерий: канал младше 14 дней
VIP_MIN = 10000   # порог VIP/рекламы, ₽
GROWTH_MIN = 500  # порог роста подписчиков/сутки
SEARCH_QUERY_VARIANTS = {
    'сигналы/сделки': ['crypto signals', 'сигналы криптовалюта', 'long short crypto'],
    'доход/чудеса': ['profit crypto vip', 'заработок крипта', 'без риска крипта'],
    'VIP/приват': ['VIP crypto signals', 'закрытый канал крипта', 'private crypto signals'],
    'азарт/риск': ['плечо крипта сигнал', 'отбить убыток крипта', 'high risk crypto signal'],
}
TGSTAT_SEARCH_URL = 'https://tgstat.ru/search?query=%s&sort=date'
TELEGA_CATALOG_URL = 'https://telega.io/catalog/cryptocurrencies'
WEB_SEARCH_URLS = [
    'https://duckduckgo.com/html/?q=telegram+crypto+signals+vip',
    'https://duckduckgo.com/html/?q=best+telegram+crypto+signals',
]

# Итоговые правила для документа Source & Data (ТЗ раздел 8):
# - Только реальные Telegram-каналы: ссылка t.me/... проверяется (get_entity); несуществующие не попадают в документ.
# - Все основные данные (каналы, жалобы, причины риска) — в нативных таблицах Google Docs (Вставка → Таблица).
# - Ничего не придумывать: нет данных — честно писать «нет»; только поведенческие риски — так и писать; источник не работает — предупреждать в блоке ограничений.
# - Примеры и выдуманные имена каналов запрещены: в отчёте только настоящие объекты.

def _load_env():
    for base in (SCRIPT_DIR, os.path.normpath(os.path.join(SCRIPT_DIR, '..', '..'))):
        for name in ('env', '.env'):
            path = os.path.join(base, name)
            if not os.path.isfile(path):
                continue
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line:
                        continue
                    key, _, value = line.partition('=')
                    key, value = key.strip(), value.strip()
                    if (value.startswith("'") and value.endswith("'")) or (value.startswith('"') and value.endswith('"')):
                        value = value[1:-1]
                    if key and key not in os.environ:
                        os.environ[key] = value
            break

_load_env()


def _load_live_log():
    """Загрузить строки живого лога (только важные события)."""
    if not os.path.isfile(LIVE_LOG_FILE):
        return []
    try:
        with open(LIVE_LOG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return []


def _save_live_log(lines):
    """Сохранить строки живого лога, оставив последние LIVE_LOG_MAX_LINES."""
    os.makedirs(DATA_DIR, exist_ok=True)
    kept = lines[-LIVE_LOG_MAX_LINES:] if len(lines) > LIVE_LOG_MAX_LINES else lines
    with open(LIVE_LOG_FILE, 'w', encoding='utf-8') as f:
        json.dump(kept, f, ensure_ascii=False, indent=0)


def _append_live_log_events(events):
    """Добавить события в живой лог и сохранить."""
    lines = _load_live_log()
    lines.extend(events)
    _save_live_log(lines)


def _read_json_file(path, default=None):
    if not os.path.isfile(path):
        return default
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def _write_json_file(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _non_empty_list(value):
    out = []
    for item in value or []:
        if item is None:
            continue
        text = str(item).strip()
        if text:
            out.append(text)
    return out


def _count_evidence_categories(evidence_summary):
    if not isinstance(evidence_summary, dict):
        return 0
    keys = ('tgstat_queries', 'telega_sources', 'complaint_sources', 'web_search_urls', 'risk_row_links')
    return sum(1 for key in keys if _non_empty_list(evidence_summary.get(key)))


def _is_zero_publication_candidate(stats):
    return (
        int(stats.get('new_scam_channels') or 0) == 0 and
        int(stats.get('telegram_channels') or 0) == 0 and
        int(stats.get('courses_products') or 0) == 0 and
        int(stats.get('losses_12h') or 0) == 0 and
        not (stats.get('top3') or [])
    )


def _is_full_cycle_for_zero(stats):
    evidence_summary = stats.get('evidence_summary') or {}
    unavailable_sources = _non_empty_list(stats.get('unavailable_sources'))
    tgstat_queries = _non_empty_list(evidence_summary.get('tgstat_queries'))
    telega_sources = _non_empty_list(evidence_summary.get('telega_sources'))
    complaint_sources = _non_empty_list(evidence_summary.get('complaint_sources'))
    web_search_urls = _non_empty_list(evidence_summary.get('web_search_urls'))
    risk_row_links = _non_empty_list(evidence_summary.get('risk_row_links'))
    evidence_categories = _count_evidence_categories(evidence_summary)
    nothing_found = bool(stats.get('nothing_found'))
    has_catalog_pass = bool(tgstat_queries or telega_sources)
    has_wide_pass = bool(web_search_urls)
    has_secondary_validation = bool(complaint_sources or risk_row_links)
    return (
        nothing_found and
        not unavailable_sources and
        evidence_categories >= 3 and
        has_catalog_pass and
        has_wide_pass and
        has_secondary_validation
    )


def _classify_publish_result(stats):
    if not _is_zero_publication_candidate(stats):
        return 'valid'
    if _is_full_cycle_for_zero(stats):
        return 'honest_zero'
    return 'suspicious_zero'


def _update_publish_history(publish_status, timestamp):
    history = _read_json_file(PUBLISH_HISTORY_JSON, default={'cycles': []}) or {'cycles': []}
    cycles = history.get('cycles')
    if not isinstance(cycles, list):
        cycles = []
    cycles.append({
        'timestamp': timestamp,
        'publishStatus': publish_status,
    })
    cycles = cycles[-PUBLISH_HISTORY_LIMIT:]
    history['cycles'] = cycles
    _write_json_file(PUBLISH_HISTORY_JSON, history)
    suspicious_zero_streak = 0
    for item in reversed(cycles):
        if item.get('publishStatus') != 'suspicious_zero':
            break
        suspicious_zero_streak += 1
    return suspicious_zero_streak


def _build_history_context(previous_primary, limit=5):
    history_context = {
        'carryoverTop3': [],
        'carryoverRiskRows': [],
        'repeatedObjects': [],
        'repeatedCategories': [],
    }
    if isinstance(previous_primary, dict):
        top3 = previous_primary.get('display_top3') or previous_primary.get('top3') or []
        if isinstance(top3, list):
            history_context['carryoverTop3'] = top3[:3]
        risk_rows = previous_primary.get('risk_rows') or []
        if isinstance(risk_rows, list):
            history_context['carryoverRiskRows'] = risk_rows[:limit]

    channel_data = _read_json_file(CHANNEL_OBJECTS_JSON, default={'channels': {}}) or {'channels': {}}
    channels = channel_data.get('channels')
    if not isinstance(channels, dict):
        return history_context

    repeated_objects = []
    repeated_categories = defaultdict(int)
    for channel_id, entry in channels.items():
        history = entry.get('history') or []
        if len(history) < 2:
            continue
        latest = history[-1].get('snapshot') or {}
        latest_type = (latest.get('type') or 'unknown').strip() or 'unknown'
        repeated_categories[latest_type] += 1
        repeated_objects.append({
            'channel': channel_id,
            'firstSeen': entry.get('first_seen'),
            'lastUpdated': entry.get('last_updated'),
            'seenCycles': len(history),
            'latestType': latest_type,
            'latestSource': latest.get('source'),
            'latestComplaints': latest.get('complaints'),
        })

    repeated_objects.sort(
        key=lambda item: (item.get('lastUpdated') or '', item.get('seenCycles') or 0),
        reverse=True
    )
    history_context['repeatedObjects'] = repeated_objects[:limit]
    history_context['repeatedCategories'] = [
        {'category': category, 'objects': count}
        for category, count in sorted(repeated_categories.items(), key=lambda item: (-item[1], item[0]))
    ][:limit]
    return history_context


def _run_suspicious_zero_self_check(stats, suspicious_zero_streak, previous_primary):
    evidence_summary = stats.get('evidence_summary') or {}
    history_context = stats.get('historyContext') or _build_history_context(previous_primary)
    diagnostics = {
        'checkedAt': _msk_now().strftime('%Y-%m-%dT%H:%M:%S%z'),
        'suspiciousZeroStreak': suspicious_zero_streak,
        'publishStatus': stats.get('publishStatus'),
        'lastValidUpdatedAt': (
            (previous_primary or {}).get('lastValidUpdatedAt')
            or (previous_primary or {}).get('updatedAt')
            or None
        ),
        'unavailableSources': _non_empty_list(stats.get('unavailable_sources')),
        'evidenceCategories': _count_evidence_categories(evidence_summary),
        'evidenceCounts': {
            'tgstat_queries': len(_non_empty_list(evidence_summary.get('tgstat_queries'))),
            'telega_sources': len(_non_empty_list(evidence_summary.get('telega_sources'))),
            'complaint_sources': len(_non_empty_list(evidence_summary.get('complaint_sources'))),
            'web_search_urls': len(_non_empty_list(evidence_summary.get('web_search_urls'))),
            'risk_row_links': len(_non_empty_list(evidence_summary.get('risk_row_links'))),
        },
        'historyContext': history_context,
        'checks': {
            'sources': 'ok' if not _non_empty_list(stats.get('unavailable_sources')) else 'needs_attention',
            'parsing': 'ok' if stats.get('risk_rows') or stats.get('complaints_rows') else 'needs_attention',
            'analysis': 'ok' if _count_evidence_categories(evidence_summary) >= 3 else 'needs_attention',
        },
        'actions': [
            'Проверить доступность TGStat, Telega и чатов с жалобами.',
            'Проверить, что парсинг дал evidence по нескольким категориям, а не только локальный проход.',
            'Сверить повторяющиеся объекты и категории с historyContext, чтобы не потерять историю расследования.',
        ],
    }
    return diagnostics


# --- Критерии релевантности: только каналы с торговыми сигналами (покупать вверх/вниз, лонг/шорт) ---
STRONG_CRYPTO_SIGNAL = (
    'сигнал', 'сигналы', 'крипто', 'crypto', 'bitcoin', 'btc', 'eth',
    'трейдинг', 'trading', 'криптовалюта', 'фьючерс', 'биржа', 'trade', 'pump', 'скам'
)
# Каналы, где именно говорят покупать/продавать, вверх/вниз, лонг/шорт — приоритет для отбора
SIGNAL_DIRECTION = (
    'лонг', 'шорт', 'long', 'short', 'покупка', 'продажа', 'buy', 'sell',
    'вход', 'вверх', 'вниз', 'лонги', 'шорты', 'сигнал', 'сигналы'
)
# Если в названии/username есть это и нет ни одного STRONG — канал отсекаем (не про крипто/сигналы)
NOT_CRYPTO_SIGNAL = (
    'vpn', 'gossip', 'gossipclub', 'bookss', 'books hub', 'nairobigossip',
    'ashesvpn', 'redblacknews', 'memes_news', 'express', 'pharonic', 'fusion', 'money_networks'
)


def _is_crypto_signal_channel(title, username):
    """Проверка: канал явно про крипту и/или торговые сигналы (покупать вверх/вниз, лонг/шорт).
    Отсекаем VPN, gossip, книги, общие новости без крипто и без формулировок про сигналы."""
    text = ((title or '') + ' ' + (username or '')).lower()
    has_strong = any(kw in text for kw in STRONG_CRYPTO_SIGNAL)
    if not has_strong:
        return False
    # Только каналы, где именно сигналы: лонг/шорт, покупка/продажа, вверх/вниз или слово «сигнал/сигналы»
    has_signal_direction = any(kw in text for kw in SIGNAL_DIRECTION)
    if not has_signal_direction:
        return False
    if any(n in text for n in NOT_CRYPTO_SIGNAL):
        explicit_crypto = ('крипто', 'crypto', 'bitcoin', 'btc', 'eth', 'сигнал', 'криптовалюта')
        if not any(e in text for e in explicit_crypto):
            return False
    return True

# --- TGStat search: именно каналы с крипто-сигналами ---
def fetch_tgstat_new_channels():
    """Широкий поиск TGStat по группам запросов с evidence-полями."""
    try:
        from tgstat_client import search_channels
    except ImportError:
        return []
    seen = set()
    out = []
    now = datetime.now(timezone.utc)
    cutoff_14d = now - timedelta(days=DAYS_14)
    for group, queries in SEARCH_QUERY_VARIANTS.items():
        for query in queries:
            items = search_channels(query, country='ru', limit=50)
            source_url = TGSTAT_SEARCH_URL % quote(query)
            for x in items:
                created_at = x.get('created_at')
                if created_at is None:
                    continue
                try:
                    created_dt = datetime.fromtimestamp(created_at, tz=timezone.utc)
                    if created_dt < cutoff_14d:
                        continue
                except (TypeError, OSError):
                    continue
                ch = (x.get('username') or x.get('link') or '').strip() or ('@' + (x.get('link') or '').replace('https://t.me/', ''))
                key = ch.lower().replace('@', '')
                if key in seen:
                    continue
                title = (x.get('title') or '').strip()
                if not _is_crypto_signal_channel(title, ch):
                    continue
                seen.add(key)
                out.append({
                    'channel': ch or '—',
                    'title': title or '—',
                    'date': datetime.fromtimestamp(created_at, tz=timezone.utc).strftime('%d.%m.%Y'),
                    'growth': x.get('participants_count'),
                    'vip': '—',
                    'link': x.get('link') or ('https://t.me/' + (ch or '').lstrip('@')),
                    'source_url': source_url,
                    'query': query,
                    'query_group': group,
                    'source_links': [source_url],
                    'evidence_links': [source_url, x.get('link') or ('https://t.me/' + (ch or '').lstrip('@'))],
                })
    out.sort(key=lambda r: r.get('date', ''), reverse=True)
    return out[:50]


def fetch_tgstat_watch_channels():
    """Широкий поиск TGStat: каналы старше месяца для channels_watch."""
    try:
        from tgstat_client import search_channels
    except ImportError:
        return []
    seen = set()
    out = []
    now = datetime.now(timezone.utc)
    cutoff_watch = now - timedelta(days=WATCH_MIN_AGE_DAYS)
    for group, queries in SEARCH_QUERY_VARIANTS.items():
        for query in queries:
            items = search_channels(query, country='ru', limit=50)
            source_url = TGSTAT_SEARCH_URL % quote(query)
            for x in items:
                created_at = x.get('created_at')
                if created_at is None:
                    continue
                try:
                    created_dt = datetime.fromtimestamp(created_at, tz=timezone.utc)
                except (TypeError, OSError):
                    continue
                if created_dt > cutoff_watch:
                    continue
                ch = (x.get('username') or x.get('link') or '').strip() or ('@' + (x.get('link') or '').replace('https://t.me/', ''))
                key = ch.lower().replace('@', '')
                if key in seen or key in _KNOWN_NON_SCAM_CHANNELS:
                    continue
                title = (x.get('title') or '').strip()
                if not _is_crypto_signal_channel(title, ch):
                    continue
                seen.add(key)
                out.append({
                    'channel': ch or '—',
                    'title': title or '—',
                    'date': created_dt.strftime('%d.%m.%Y'),
                    'growth': x.get('participants_count'),
                    'vip': '—',
                    'link': x.get('link') or ('https://t.me/' + (ch or '').lstrip('@')),
                    'source_url': source_url,
                    'query': query,
                    'query_group': 'tgstat_watch',
                    'source_links': [source_url],
                    'evidence_links': [source_url, x.get('link') or ('https://t.me/' + (ch or '').lstrip('@'))],
                })
    out.sort(key=lambda r: r.get('date', ''), reverse=True)
    return out[:80]


# --- Telega.io catalog ---
def fetch_telega_catalog():
    """Парсинг каталога крипто-каналов (telega.io). Возвращает список dict с channel, link."""
    try:
        import requests
    except ImportError:
        return []
    url = TELEGA_CATALOG_URL
    time.sleep(REQUEST_DELAY)
    try:
        r = requests.get(url, headers={'User-Agent': USER_AGENT}, timeout=25)
        r.raise_for_status()
        html = r.text or ''
    except Exception as e:
        print('Telega.io fetch: %s' % e, file=sys.stderr)
        return []
    # Извлекаем t.me ссылки и @username
    channels = []
    seen = set()
    for m in re.finditer(r'(?:href=["\']?(?:https?://)?(?:t\.me/|telegram\.me/)([a-zA-Z0-9_+]+)|@([a-zA-Z0-9_]{5,32})\b)', html, re.I):
        g = m.group(1) or m.group(2)
        if not g or len(g) < 4:
            continue
        key = g.lower()
        if key in seen:
            continue
        seen.add(key)
        if g.startswith('+'):
            link = 'https://t.me/' + g
            channel = 't.me/' + g
        else:
            channel = '@' + g if not g.startswith('@') else g
            link = 'https://t.me/' + g.lstrip('@')
        channels.append({
            'channel': channel,
            'link': link,
            'source_url': url,
            'query': 'catalog cryptocurrencies',
            'query_group': 'catalog',
            'source_links': [url],
            'evidence_links': [url, link],
        })
    return channels[:80]


# --- Telegram chats (жалобы за 12 ч) ---
TELEGRAM_API_ID = int(os.environ.get('TELEGRAM_API_ID') or 0)
TELEGRAM_API_HASH = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
TELEGRAM_SESSION_NAME = os.environ.get('TELEGRAM_SESSION_NAME', 'kro_worker')
KRO_SOURCE_CHANNELS = [x.strip() for x in (os.environ.get('KRO_SOURCE_CHANNELS') or '').split(',') if x.strip()]

RE_SUM = re.compile(r'(?:потерял|украли|сумм|₽|руб)\s*[:\s]*(\d[\d\s]{2,12})', re.I)
RE_SUM_K = re.compile(r'\b(\d+)\s*[кk]\s*[₽р]', re.I)

def _extract_sums(text):
    out = []
    for m in RE_SUM.findall(text or ''):
        n = int(re.sub(r'\s', '', m))
        if 100 <= n <= 500_000_000:
            out.append(n)
    for m in RE_SUM_K.findall(text or ''):
        n = int(m) * 1000
        if 100 <= n <= 500_000_000:
            out.append(n)
    return out

def _extract_channels_from_text(text):
    chs = set()
    for m in re.findall(r'@([a-zA-Z0-9_]{5,32})\b', text or ''):
        chs.add('@' + m)
    for m in re.findall(r't\.me/([a-zA-Z0-9_+]+)', text or '', re.I):
        if m.startswith('+'):
            chs.add('t.me/' + m)
        else:
            chs.add('@' + m)
    return chs

def _normalize_channel_link(ch_or_link):
    """Вернуть канонический t.me/username или пустую строку для домена (не проверяем)."""
    ch = (ch_or_link or '').strip()
    if not ch or '.' in ch.split('/')[-1].split('@')[-1] and '@' not in ch and 't.me/' not in ch:
        return ''  # домен типа crypto-fast.pro
    if ch.startswith('http'):
        if 't.me/' in ch:
            return ch.split('t.me/')[-1].split('?')[0].strip() or ''
        return ''
    if ch.startswith('t.me/'):
        return ch.split('/', 1)[-1].split('?')[0].strip() or ''
    if ch.startswith('@'):
        return ch.lstrip('@').split('?')[0].strip() or ''
    return ch.split('?')[0].strip() or ''


async def _verify_telegram_channel_exists(client, username_or_link):
    """Проверить существование канала/чата по username или ссылке. Вернуть True если существует."""
    try:
        uname = _normalize_channel_link(username_or_link)
        if not uname:
            return True  # домен — не проверяем
        if uname.startswith('joinchat/'):
            return True  # invite hash — не проверяем по get_entity
        await client.get_entity('https://t.me/' + uname if not uname.startswith('@') else uname)
        return True
    except Exception:
        return False


async def _get_channel_created_at(client, username_or_link):
    """
    Вернуть дату создания канала через Telethon или None.
    Это бесплатная альтернатива TGStat API для проверки критерия «возраст < 14 дней».
    Telethon возвращает channel.date — это UTC datetime создания канала.
    """
    try:
        uname = _normalize_channel_link(username_or_link)
        if not uname or uname.startswith('joinchat/'):
            return None
        ref = 'https://t.me/' + uname if not uname.startswith('@') else uname
        entity = await client.get_entity(ref)
        created = getattr(entity, 'date', None)
        if created is None:
            return None
        if getattr(created, 'tzinfo', None) is None:
            created = created.replace(tzinfo=timezone.utc)
        return created
    except Exception:
        return None


_TELEGRAM_SEARCH_QUERIES = [
    'крипто сигналы VIP',
    'crypto signals long short',
    'сигналы лонг шорт крипта',
    'VIP крипто канал закрытый',
    'private crypto signals vip',
    'криптовалюта сигналы заработок',
    'crypto vip сигналы торговля',
]

# Каналы-исключения: известные анти-скам проекты, биржи, агрегаторы
# и служебные username. Они никогда не должны попадать в scam_base,
# независимо от числа жалоб или источника находки.
_KNOWN_NON_SCAM_CHANNELS = {
    'crypt0scamm', 'cryptoscamm', 'cryptoscammsup', 'publicryptoscamm',
    'scamrsalert', 'crypto_police_list', 'scamalyst',
    'binance', 'bybit', 'okx', 'kucoin', 'huobi', 'coinbase', 'gate_io',
    'tgstat', 'telemetr', 'telega', 'telegaio',
    'gmail', 'feel340', 'support', 'admin',
}

WATCH_MIN_AGE_DAYS = 30
WATCH_ACTIVE_POSTS_30D = 4
WATCH_FRESH_POST_DAYS = 14

PROFIT_PATTERNS = (
    'профит', 'в плюс', 'закрыли в плюс', 'take profit', 'тейк', 'tp ', 'x2', 'х2',
    'забрали прибыль', 'забрали профит',
)
LOSS_PATTERNS = (
    'убыт', 'стоп', 'стоп-лосс', 'stop-loss', 'stop loss', 'минус', 'просадк',
    'ликвидац', 'выбило по стопу',
)
WATCH_VIP_PATTERNS = (
    'vip', 'вип', 'закрытый канал', 'закрытый клуб', 'платный доступ',
    'подписка', 'личка', 'пиши в лс', 'пиши в личку',
)


async def _search_new_channels_via_telegram(client, days_max=30):
    """
    Ищет новые крипто-сигнальные каналы напрямую через Telegram SearchRequest.
    Не требует TGStat API — работает на той же Telethon-сессии.
    Возвращает (list_of_channel_dicts, dict {norm_key -> datetime}).
    """
    try:
        from telethon.tl.functions.contacts import SearchRequest
    except ImportError:
        return [], {}

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days_max)
    found = []
    ages = {}
    seen = set()

    for query in _TELEGRAM_SEARCH_QUERIES:
        try:
            result = await client(SearchRequest(q=query, limit=50))
            for chat in (getattr(result, 'chats', None) or []):
                username = (getattr(chat, 'username', None) or '').strip().lower()
                if not username:
                    continue
                if username in _KNOWN_NON_SCAM_CHANNELS:
                    continue
                if username in seen:
                    continue
                created = getattr(chat, 'date', None)
                if created is None:
                    continue
                if getattr(created, 'tzinfo', None) is None:
                    created = created.replace(tzinfo=timezone.utc)
                if created < cutoff:
                    continue
                title = (getattr(chat, 'title', None) or '').strip()
                if not _has_signal_keywords(title) and not _has_signal_keywords('@' + username):
                    continue
                seen.add(username)
                ages[username] = created
                age_days = (now - created).days
                link = 'https://t.me/' + username
                found.append({
                    'channel': '@' + username,
                    'title': title,
                    'date': created.strftime('%d.%m.%Y'),
                    'link': link,
                    'growth': getattr(chat, 'participants_count', None),
                    'vip': '—',
                    'source_url': 'https://t.me/' + username,
                    'query': query,
                    'query_group': 'telegram_search',
                    'source_links': [link],
                    'evidence_links': [link],
                })
                print('telegram_search: найден @%s | создан %s | возраст %d дн. | title=%r' % (
                    username, created.strftime('%d.%m.%Y'), age_days, title), file=sys.stderr)
            await asyncio.sleep(1.5)
        except Exception as e:
            print('Telegram SearchRequest %r: %s' % (query, e), file=sys.stderr)
            await asyncio.sleep(2)

    print('telegram_search: всего найдено новых сигнальных каналов: %d' % len(found), file=sys.stderr)
    return found, ages


async def _search_watch_channels_via_telegram(client, days_min=30):
    """
    Ищет крипто-сигнальные каналы старше days_min дней для широкого мониторинга.
    Это отдельный поток для channels_watch и он не влияет на scam_base.
    """
    try:
        from telethon.tl.functions.contacts import SearchRequest
    except ImportError:
        return [], {}

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days_min)
    found = []
    ages = {}
    seen = set()

    for query in _TELEGRAM_SEARCH_QUERIES:
        try:
            result = await client(SearchRequest(q=query, limit=50))
            for chat in (getattr(result, 'chats', None) or []):
                username = (getattr(chat, 'username', None) or '').strip().lower()
                if not username:
                    continue
                if username in _KNOWN_NON_SCAM_CHANNELS or username in seen:
                    continue
                created = getattr(chat, 'date', None)
                if created is None:
                    continue
                if getattr(created, 'tzinfo', None) is None:
                    created = created.replace(tzinfo=timezone.utc)
                if created > cutoff:
                    continue
                title = (getattr(chat, 'title', None) or '').strip()
                if not _has_signal_keywords(title) and not _has_signal_keywords('@' + username):
                    continue
                seen.add(username)
                ages[username] = created
                link = 'https://t.me/' + username
                found.append({
                    'channel': '@' + username,
                    'title': title,
                    'date': created.strftime('%d.%m.%Y'),
                    'link': link,
                    'growth': getattr(chat, 'participants_count', None),
                    'vip': '—',
                    'source_url': 'https://t.me/' + username,
                    'query': query,
                    'query_group': 'telegram_watch',
                    'source_links': [link],
                    'evidence_links': [link],
                })
            await asyncio.sleep(1.5)
        except Exception as e:
            print('Telegram watch SearchRequest %r: %s' % (query, e), file=sys.stderr)
            await asyncio.sleep(2)

    print('telegram_watch: всего найдено каналов старше %d дней: %d' % (days_min, len(found)), file=sys.stderr)
    return found, ages


async def _collect_watch_channel_metrics(client, username_or_link):
    """Собрать честные метрики активности и контента для channels_watch."""
    empty = {
        'recent_posts_30d': 0,
        'last_post_at': '',
        'activity_label': 'данных об активности мало',
        'profit_mode': 'данных о прибыли/убытках мало',
        'vip_detected': False,
    }
    try:
        uname = _normalize_channel_link(username_or_link)
        if not uname or uname.startswith('joinchat/'):
            return empty
        ref = 'https://t.me/' + uname if not uname.startswith('@') else uname
        entity = await client.get_entity(ref)
        now = datetime.now(timezone.utc)
        cutoff_30d = now - timedelta(days=30)
        fresh_cutoff = now - timedelta(days=WATCH_FRESH_POST_DAYS)

        recent_posts_30d = 0
        last_post_at = None
        positive_hits = 0
        negative_hits = 0
        vip_hits = 0

        async for msg in client.iter_messages(entity, limit=40):
            msg_date = getattr(msg, 'date', None)
            if not msg_date:
                continue
            if getattr(msg_date, 'tzinfo', None) is None:
                msg_date = msg_date.replace(tzinfo=timezone.utc)
            if last_post_at is None:
                last_post_at = msg_date
            if msg_date < cutoff_30d:
                continue
            recent_posts_30d += 1
            text = ((getattr(msg, 'message', None) or '') + ' ' + (getattr(msg, 'text', None) or '')).lower()
            if any(p in text for p in PROFIT_PATTERNS):
                positive_hits += 1
            if any(p in text for p in LOSS_PATTERNS):
                negative_hits += 1
            if any(p in text for p in WATCH_VIP_PATTERNS):
                vip_hits += 1

        if negative_hits > 0 and positive_hits > 0:
            profit_mode = 'показывает и прибыль, и убытки'
        elif positive_hits > 0 and negative_hits == 0:
            profit_mode = 'похоже, показывает только прибыль'
        elif negative_hits > 0:
            profit_mode = 'есть упоминания стопов и убытков'
        else:
            profit_mode = 'данных о прибыли/убытках мало'

        is_active = recent_posts_30d >= WATCH_ACTIVE_POSTS_30D or (last_post_at is not None and last_post_at >= fresh_cutoff)
        activity_label = 'активный' if is_active else ('мало свежих постов' if recent_posts_30d > 0 else 'неактивный')

        return {
            'recent_posts_30d': recent_posts_30d,
            'last_post_at': last_post_at.strftime('%Y-%m-%dT%H:%M:%SZ') if last_post_at else '',
            'activity_label': activity_label,
            'profit_mode': profit_mode,
            'vip_detected': vip_hits > 0,
        }
    except Exception as e:
        print('watch metrics failed for %s: %s' % (username_or_link, e), file=sys.stderr)
        return empty


async def fetch_telegram_complaints_12h_and_verify_channels(new_tgstat, telega_channels, complaints_by_channel):
    """Сообщения из KRO_SOURCE_CHANNELS за 12 ч + проверка существования каналов из TGStat/Telega/жалоб.
    Возвращает (tg_data, set_of_existing_canonical_links, channel_ages_from_tg).
    channel_ages_from_tg: dict {norm_key -> datetime(UTC)} — дата создания каналов, полученная через Telethon.
    Каналы, которых нет в Telegram, не попадают в документ (Правило №1)."""
    tg_data = {'by_channel': {}, 'victims_12h': 0, 'channel_sum_pairs': []}
    existing = set()
    channel_ages_from_tg = {}  # norm_key -> datetime UTC creation date

    if not TELEGRAM_API_ID or not TELEGRAM_API_HASH:
        print('Проверка каналов отключена: TELEGRAM_API_ID/HASH не заданы. В документ могут попасть несуществующие каналы.', file=sys.stderr)
        for row in (new_tgstat or []):
            link = row.get('link') or _object_link(row.get('channel', ''))
            if link and 't.me/' in link:
                existing.add(link)
        for row in (telega_channels or []):
            link = row.get('link') or _object_link(row.get('channel', ''))
            if link and 't.me/' in link:
                existing.add(link)
        for ch in (complaints_by_channel or {}):
            if ch and ('@' in ch or 't.me/' in ch):
                existing.add(_object_link(ch))
        return tg_data, existing, channel_ages_from_tg

    try:
        from telethon import TelegramClient
    except ImportError as e:
        print('Telethon не установлен: %s. Установите: pip install telethon. Чаты с жалобами недоступны, отчёт формируется без них.' % e, file=sys.stderr)
        tg_data['_telegram_unavailable'] = True
        for row in (new_tgstat or []):
            link = row.get('link') or _object_link(row.get('channel', ''))
            if link and 't.me/' in link:
                existing.add(link)
        for row in (telega_channels or []):
            link = row.get('link') or _object_link(row.get('channel', ''))
            if link and 't.me/' in link:
                existing.add(link)
        for ch in (complaints_by_channel or {}):
            if ch and ('@' in ch or 't.me/' in ch):
                existing.add(_object_link(ch))
        return tg_data, existing, channel_ages_from_tg

    client = TelegramClient(TELEGRAM_SESSION_NAME, TELEGRAM_API_ID, TELEGRAM_API_HASH)
    await client.start()

    # Прямой поиск новых каналов в Telegram (основной источник, не требует TGStat API)
    direct_channels, direct_ages = await _search_new_channels_via_telegram(client, days_max=30)
    watch_channels, watch_ages = await _search_watch_channels_via_telegram(client, days_min=WATCH_MIN_AGE_DAYS)
    for k, v in direct_ages.items():
        channel_ages_from_tg[k] = v
    for k, v in watch_ages.items():
        channel_ages_from_tg[k] = v
    # Сохраняем для main() и добавляем в new_tgstat
    tg_data['_direct_search_channels'] = direct_channels
    tg_data['_watch_search_channels'] = watch_channels
    if direct_channels:
        new_tgstat = list(new_tgstat or []) + direct_channels

    async def get_entity(cid):
        cid = (cid or '').strip()
        if not cid:
            return None
        if not cid.startswith('@') and not cid.startswith('t.me/'):
            cid = '@' + cid
        if cid.startswith('t.me/'):
            return await client.get_entity('https://t.me/' + cid.split('/', 1)[-1])
        return await client.get_entity(cid)

    def message_link(entity, msg):
        username = (getattr(entity, 'username', None) or '').strip()
        if username:
            return 'https://t.me/%s/%s' % (username, getattr(msg, 'id', ''))
        return ''

    try:
        if KRO_SOURCE_CHANNELS:
            now = datetime.now(timezone.utc)
            since = now - timedelta(hours=HOURS_12)
            by_channel = defaultdict(lambda: {
                'complaints': 0,
                'sums': [],
                'messages': 0,
                'message_links': [],
                'source_urls': [],
                'query_group': 'жалобы/обсуждения',
                'query': 'скам, обман, слил депозит',
                'internal_links': [],
            })
            victims_12h = 0
            channel_sum_pairs = []
        for ch in KRO_SOURCE_CHANNELS:
            try:
                entity = await get_entity(ch)
                if not entity:
                    continue
                async for msg in client.iter_messages(entity, limit=150):
                    if not msg or not msg.date:
                        continue
                    md = msg.date.replace(tzinfo=timezone.utc) if getattr(msg.date, 'tzinfo', None) is None else msg.date
                    if md < since:
                        break
                    victims_12h += 1
                    text = (msg.text or '') + (getattr(msg, 'message', '') or '')
                    sums = _extract_sums(text)
                    channels_mentioned = _extract_channels_from_text(text)
                    msg_link = message_link(entity, msg)
                    chat_link = _object_link('@' + entity.username) if getattr(entity, 'username', None) else ''
                    for c in channels_mentioned:
                        by_channel[c]['complaints'] += 1
                        by_channel[c]['messages'] += 1
                        if msg_link:
                            by_channel[c]['message_links'].append(msg_link)
                        if chat_link:
                            by_channel[c]['source_urls'].append(chat_link)
                        by_channel[c]['internal_links'].append(_object_link(c))
                        if sums:
                            by_channel[c]['sums'].extend(sums)
                            channel_sum_pairs.append((c, max(sums)))
            except Exception as e:
                print('Telegram %s: %s' % (ch, e), file=sys.stderr)
                await asyncio.sleep(1)
            tg_data = {'by_channel': dict(by_channel), 'victims_12h': victims_12h, 'channel_sum_pairs': channel_sum_pairs}

        to_verify = []
        watch_metric_targets = set()
        for row in (new_tgstat or []):
            link = row.get('link') or _object_link(row.get('channel', ''))
            if link and 't.me/' in link:
                to_verify.append((link, link))
        for row in (telega_channels or []):
            link = row.get('link') or _object_link(row.get('channel', ''))
            if link and 't.me/' in link:
                to_verify.append((link, link))
                watch_metric_targets.add(_norm_ch_key(row.get('channel') or link))
        for row in (watch_channels or []):
            link = row.get('link') or _object_link(row.get('channel', ''))
            if link and 't.me/' in link:
                to_verify.append((link, link))
                watch_metric_targets.add(_norm_ch_key(row.get('channel') or link))
        for ch in tg_data.get('by_channel', {}):
            if ch and ('@' in ch or 't.me/' in ch):
                link = _object_link(ch)
                if link and 't.me/' in link:
                    to_verify.append((link, ch))
                    watch_metric_targets.add(_norm_ch_key(ch))

        seen_links = set()
        watch_metrics = {}
        for link, orig in to_verify:
            if link in seen_links:
                continue
            seen_links.add(link)
            created_dt = await _get_channel_created_at(client, link or orig)
            if created_dt is not None:
                existing.add(link)
                key = _norm_ch_key(orig or link)
                if key:
                    channel_ages_from_tg[key] = created_dt
                    if key in watch_metric_targets and key not in watch_metrics:
                        watch_metrics[key] = await _collect_watch_channel_metrics(client, link or orig)
            else:
                print('Канал не найден (не пишем в документ): %s' % (orig or link), file=sys.stderr)
            await asyncio.sleep(0.5)
        tg_data['watch_metrics'] = watch_metrics
    finally:
        await client.disconnect()

    return tg_data, existing, channel_ages_from_tg


# --- Scam criteria (упрощённо: по жалобам и возрасту) ---
def apply_scam_criteria(new_channels_tgstat, complaints_by_channel):
    """Пометить каналы: скам если жалоб >=2 по каналу или создан <14 дней (уже отфильтровано в TGStat)."""
    scam_status = {}
    for ch, data in complaints_by_channel.items():
        if (data.get('complaints') or 0) >= 2:
            scam_status[ch] = 'Скам'
        else:
            scam_status[ch] = 'Активен'
    return scam_status


# --- Google Sheets: прочитать отчёты за 12 ч ---
def get_sheets_client():
    creds = None
    json_str = os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON')
    json_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
    if json_str:
        try:
            from google.oauth2 import service_account
            creds = service_account.Credentials.from_service_account_info(json.loads(json_str))
        except Exception:
            pass
    if not creds and json_path and os.path.isfile(json_path):
        try:
            from google.oauth2 import service_account
            creds = service_account.Credentials.from_service_account_file(json_path)
        except Exception:
            pass
    if not creds:
        return None
    from googleapiclient.discovery import build
    return build('sheets', 'v4', credentials=creds)


def ensure_sheet_exists(sheets_client, sheet_id, title, row_count=50, column_count=2):
    if not sheets_client or not sheet_id or not title:
        return None
    meta = sheets_client.spreadsheets().get(spreadsheetId=sheet_id).execute()
    for item in meta.get('sheets', []):
        props = item.get('properties', {})
        if props.get('title') == title:
            return props.get('sheetId')

    response = sheets_client.spreadsheets().batchUpdate(
        spreadsheetId=sheet_id,
        body={
            'requests': [
                {
                    'addSheet': {
                        'properties': {
                            'title': title,
                            'gridProperties': {
                                'rowCount': row_count,
                                'columnCount': column_count,
                            },
                        }
                    }
                }
            ]
        }
    ).execute()
    replies = response.get('replies', [])
    added = replies[0].get('addSheet', {}).get('properties', {}) if replies else {}
    return added.get('sheetId')


def append_kro_history_row(sheets_client, sheet_id, last_cycle_at, new_in_cycle, sources_checked, channels_added=None, status='honest_zero', notes=''):
    """
    Append one row to kro_history sheet after each monitoring cycle.
    Columns: A=cycle_at, B=new_in_cycle, C=sources_summary, D=channels_added, E=status, F=notes
    """
    if not sheets_client or not sheet_id:
        return False
    sheet_name = 'kro_history'
    try:
        ensure_sheet_exists(sheets_client, sheet_id, sheet_name, row_count=500, column_count=6)
        # Write header if sheet is empty
        try:
            existing = sheets_client.spreadsheets().values().get(
                spreadsheetId=sheet_id, range=f'{sheet_name}!A1'
            ).execute().get('values', [])
            if not existing:
                sheets_client.spreadsheets().values().append(
                    spreadsheetId=sheet_id,
                    range=f'{sheet_name}!A:F',
                    valueInputOption='RAW',
                    insertDataOption='INSERT_ROWS',
                    body={'values': [['cycle_at', 'new_in_cycle', 'sources_summary', 'channels_added', 'status', 'notes']]}
                ).execute()
        except Exception:
            pass

        sources_summary = ''
        if sources_checked:
            parts = []
            for s in sources_checked:
                name = s.get('name', '')
                cnt = s.get('count', 0)
                st = s.get('status', '')
                if st == 'found' and cnt:
                    parts.append(f'{name}:{cnt}')
                elif st == 'found':
                    parts.append(name)
            sources_summary = ', '.join(parts) if parts else 'не нашёл'

        channels_str = ''
        if channels_added:
            if isinstance(channels_added, list):
                channels_str = ', '.join([str(c) for c in channels_added if c])
            else:
                channels_str = str(channels_added)

        row = [
            str(last_cycle_at or ''),
            str(int(new_in_cycle or 0)),
            sources_summary,
            channels_str,
            str(status or 'honest_zero'),
            str(notes or '')
        ]
        sheets_client.spreadsheets().values().append(
            spreadsheetId=sheet_id,
            range=f'{sheet_name}!A:F',
            valueInputOption='RAW',
            insertDataOption='INSERT_ROWS',
            body={'values': [row]}
        ).execute()
        print(f'kro_history row appended: {last_cycle_at}, new={new_in_cycle}, status={status}', file=sys.stderr)
        return True
    except Exception as e:
        print(f'append_kro_history_row error: {e}', file=sys.stderr)
        return False


def write_kro_meta_to_sheet(sheets_client, sheet_id, last_cycle_at, new_in_cycle, sources_checked, meta_range='kro_meta!A:B'):
    """
    Persist cycle metadata in Google Sheets so Render restarts do not lose it.
    Sheet schema:
      A=key, B=value
      last_cycle_at / new_in_cycle / sources_checked(JSON)
    """
    if not sheets_client or not sheet_id:
        return False
    sheet_name = (meta_range or 'kro_meta!A:B').split('!')[0].strip() or 'kro_meta'
    try:
        ensure_sheet_exists(sheets_client, sheet_id, sheet_name, row_count=20, column_count=2)
        rows = [[
            'key', 'value'
        ], [
            'last_cycle_at', str(last_cycle_at or '')
        ], [
            'new_in_cycle', str(int(new_in_cycle or 0))
        ], [
            'sources_checked', json.dumps(sources_checked or [], ensure_ascii=False)
        ]]
        sheets_client.spreadsheets().values().update(
            spreadsheetId=sheet_id,
            range=f'{sheet_name}!A1:B4',
            valueInputOption='RAW',
            body={'values': rows}
        ).execute()
        print('kro_meta updated in Google Sheets: %s' % sheet_name, file=sys.stderr)
        return True
    except Exception as e:
        print('kro_meta write failed: %s' % e, file=sys.stderr)
        return False


def read_reports_last_12h(client, sheet_id):
    """
    Читает лист reports A2:H, фильтрует строки за последние 12 ч по дате в колонке A.
    Schema v2: A=date, B=channel, C=sum_rub, D=source, E=status, F=reporter, G=description, H=proof_url
    Backward-compatible with old 6-column rows (A:F).
    """
    if not client or not sheet_id:
        return []
    try:
        resp = client.spreadsheets().values().get(
            spreadsheetId=sheet_id,
            range='A2:H'
        ).execute()
        rows = resp.get('values') or []
    except Exception:
        return []
    now = datetime.now(timezone.utc)
    today_str = now.strftime('%d.%m.%Y')
    yesterday = (now - timedelta(days=1)).strftime('%d.%m.%Y')
    out = []
    for r in rows:
        date_val = (r[0] if len(r) > 0 else '').strip()
        channel = (r[1] if len(r) > 1 else '').strip()
        sum_raw = (r[2] if len(r) > 2 else '').replace(' ', '')
        try:
            s = int(sum_raw) if sum_raw else 0
        except ValueError:
            s = 0
        source = (r[3] if len(r) > 3 else '').strip()
        status = (r[4] if len(r) > 4 else '').strip()
        reporter = (r[5] if len(r) > 5 else '').strip()
        description = (r[6] if len(r) > 6 else '').strip()
        proof_url = (r[7] if len(r) > 7 else '').strip()
        if not date_val:
            continue
        if date_val == today_str or date_val == yesterday or date_val.startswith(today_str[:6]):
            out.append({
                'channel': channel,
                'sum': s,
                'status': status or 'Активен',
                'source': source or 'form',
                'reporter': reporter,
                'description': description,
                'proof_url': proof_url,
            })
    return out


# --- JSON 12h stats ---
def build_top3(complaints_list, channel_sum_pairs):
    agg = defaultdict(int)
    for r in complaints_list:
        ch = (r.get('channel') or '').strip()
        if ch:
            agg[ch] += r.get('sum') or 0
    for ch, s in channel_sum_pairs:
        agg[ch] += s
    items = sorted(agg.items(), key=lambda x: -x[1])
    return [{'channel': ch, 'sum': total, 'status': 'Скам' if total > 0 else '—'} for ch, total in items[:3]]


# ---------------------------------------------------------------------------
# CONFIRMED-PIPELINE: строгий 3-критерийный отбор → scam_base (расширенная схема)
# Схема scam_base v2 (колонки A–M):
#   A  username          @username или t.me/+hash
#   B  link              https://t.me/username
#   C  detected_at       ISO 8601 UTC (когда зафиксирован в этом цикле)
#   D  created_at        ISO 8601 UTC (дата создания канала)
#   E  channel_age_days  целое число
#   F  object_type       сигнал-канал | курс/сайт | сигнал-канал (закрытый)
#   G  vip_price         строка или пустая
#   H  complaints        целое число
#   I  total_loss_rub    целое число (₽)
#   J  source_primary    URL источника (TGStat / Telega)
#   K  source_evidence   доп. доказательства через "; "
#   L  cycle_window      YYYY-MM-DD_am | YYYY-MM-DD_pm
#   M  status            в риске | под наблюдением | без риска
# ---------------------------------------------------------------------------

_SIGNAL_KEYWORDS = [
    'сигнал', 'signal', 'signals',
    'лонг', 'шорт', 'long', 'short',
    'vip', 'вип',
    'трейдинг', 'trading', 'trader',
    'крипто', 'crypto',
    'памп', 'pump',
    'заработок', 'профит', 'profit',
    'инвест', 'invest',
]


def _norm_ch_key(ch):
    """Нормализовать ключ канала для сравнения: @name → name (нижний), t.me/+hash → t.me/+hash."""
    s = (ch or '').strip().lower()
    if s.startswith('@'):
        return s[1:]
    if 't.me/+' in s:
        idx = s.find('t.me/+')
        return s[idx:]
    if s.startswith('t.me/'):
        return s[5:]
    return s


def _has_signal_keywords(text):
    if not text:
        return False
    lower = text.lower()
    return any(kw in lower for kw in _SIGNAL_KEYWORDS)


def _parse_date_ddmmyyyy(date_str):
    """Разобрать 'DD.MM.YYYY' в datetime (UTC) или None."""
    try:
        return datetime.strptime(date_str.strip(), '%d.%m.%Y').replace(tzinfo=timezone.utc)
    except (ValueError, AttributeError):
        return None


def _collect_confirmed_objects(new_tgstat, agg_complaints, cycle_window, channel_ages_from_tg=None):
    """
    Отбор подтверждённых скам-каналов для записи в scam_base.

    Обязательные критерии (два):
    1. Минимум 2 жалобы от разных людей на один канал (из чатов жалоб + листа отчётов).
    2. Сигнальные слова в названии или username канала (long/short/сигнал/VIP и т.д.).

    Возраст канала — информационный: записывается в scam_base если известен,
    но НЕ блокирует подтверждение.
    """
    now = _msk_now()
    tgstat_by_key = {}
    for row in (new_tgstat or []):
        ch = (row.get('channel') or '').strip()
        key = _norm_ch_key(ch)
        if key:
            tgstat_by_key[key] = row

    tg_ages = channel_ages_from_tg or {}

    confirmed = []
    seen_keys = set()
    for ch_raw, complaint_data in (agg_complaints or {}).items():
        ch = (ch_raw or '').strip()
        key = _norm_ch_key(ch)
        if not key or key in seen_keys:
            continue

        # Пропускаем известные анти-скам каналы, биржи и агрегаторы
        if key in _KNOWN_NON_SCAM_CHANNELS:
            print('confirmed-filter: %s — в списке исключений (известный не-скам)' % ch, file=sys.stderr)
            continue

        # Критерий 3: минимум 2 жалобы
        complaint_count = complaint_data.get('complaints') or 0
        if complaint_count < 2:
            continue

        # Получаем данные о канале из TGStat (если есть) для обогащения записи
        tg_row = tgstat_by_key.get(key)
        created_dt = None
        if tg_row is not None:
            date_str = (tg_row.get('date') or '').strip()
            created_dt = _parse_date_ddmmyyyy(date_str)
        if created_dt is None and key in tg_ages:
            created_dt = tg_ages[key]
        age_days = (now - created_dt).days if created_dt is not None else None

        # Строим поля канала
        ch_username = ch
        link = 'https://t.me/' + ch.lstrip('@')
        vip_str = '—'
        title = ''
        source_primary = 'Telegram (жалобы)'
        if tg_row is not None:
            ch_username = (tg_row.get('channel') or ch).strip()
            link = tg_row.get('link') or link
            vip_str = (tg_row.get('vip') or '—').strip()
            title = (tg_row.get('title') or '').strip()
            source_primary = tg_row.get('source_url') or tg_row.get('link') or 'TGStat'

        # КРИТЕРИЙ 2: сигнальные слова в названии или username
        has_signals = _has_signal_keywords(title) or _has_signal_keywords(ch_username)
        vip_num = 0
        if vip_str != '—':
            digits = re.sub(r'[^\d]', '', str(vip_str))
            vip_num = int(digits) if digits else 0

        if vip_num < VIP_MIN and not has_signals:
            print('confirmed-filter: %s — нет сигнальных слов. username=%r title=%r' % (
                ch, ch_username, title), file=sys.stderr)
            continue

        seen_keys.add(key)
        obj_type = 'сигнал-канал (закрытый)' if ('+' in ch_username or 't.me/+' in link) else 'сигнал-канал'
        total_loss_rub = complaint_data.get('sum') or 0

        # Статус честно отражает что знаем
        if age_days is not None and age_days < DAYS_14:
            status = 'в риске (новый канал)'
        elif age_days is not None:
            status = 'под наблюдением (%d дн.)' % age_days
        else:
            status = 'под наблюдением'

        evidence_parts = []
        if tg_row and tg_row.get('source_url'):
            evidence_parts.append(tg_row['source_url'])
        evidence_parts.extend(complaint_data.get('source_urls') or [])
        evidence_parts.extend(complaint_data.get('message_links') or [])
        source_evidence = '; '.join(filter(None, evidence_parts[:5]))

        print('confirmed: %s | возраст %s | жалоб %d | потери %d ₽ | статус: %s' % (
            ch_username,
            ('%d дн.' % age_days) if age_days is not None else 'неизвестен',
            complaint_count,
            total_loss_rub,
            status,
        ), file=sys.stderr)

        confirmed.append({
            'username': ch_username,
            'link': link,
            'detected_at': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'created_at': created_dt.strftime('%Y-%m-%dT%H:%M:%SZ') if created_dt else '',
            'channel_age_days': age_days if age_days is not None else '',
            'object_type': obj_type,
            'vip_price': vip_str if vip_str != '—' else '',
            'complaints': complaint_count,
            'total_loss_rub': total_loss_rub,
            'source_primary': source_primary,
            'source_evidence': source_evidence,
            'cycle_window': cycle_window,
            'status': status,
        })

    return confirmed


def _write_confirmed_to_scam_base(confirmed_objects, client, sheet_id):
    """
    Записать подтверждённые объекты в расширенную scam_base (13 колонок A–M).
    Дедупликация по username: если канал уже есть в листе — строку не дублируем.
    """
    if not confirmed_objects or not client or not sheet_id:
        return []
    scam_base_range = os.environ.get('KRO_SCAM_BASE_RANGE', 'scam_base!A2:M')
    sheet_name = scam_base_range.split('!')[0] if '!' in scam_base_range else 'scam_base'
    try:
        resp = client.spreadsheets().values().get(
            spreadsheetId=sheet_id,
            range='%s!A:A' % sheet_name
        ).execute()
        existing_keys = set()
        for row in (resp.get('values') or []):
            u = (row[0] if row else '').strip()
            if u:
                existing_keys.add(_norm_ch_key(u))
    except Exception as e:
        print('scam_base read for dedup error: %s' % e, file=sys.stderr)
        existing_keys = set()

    new_rows = []
    inserted_channels = []
    for obj in confirmed_objects:
        key = _norm_ch_key(obj.get('username') or '')
        if not key or key in existing_keys:
            continue
        if key in _KNOWN_NON_SCAM_CHANNELS:
            print('scam_base write skip: %s — в списке исключений' % (obj.get('username') or key), file=sys.stderr)
            continue
        new_rows.append([
            obj.get('username', ''),
            obj.get('link', ''),
            obj.get('detected_at', ''),
            obj.get('created_at', ''),
            obj.get('channel_age_days', ''),
            obj.get('object_type', ''),
            obj.get('vip_price', ''),
            obj.get('complaints', ''),
            obj.get('total_loss_rub', ''),
            obj.get('source_primary', ''),
            obj.get('source_evidence', ''),
            obj.get('cycle_window', ''),
            obj.get('status', ''),
        ])
        inserted_channels.append(obj.get('username', ''))
        existing_keys.add(key)

    if not new_rows:
        print('scam_base: нет новых подтверждённых каналов для записи.', file=sys.stderr)
        return []
    try:
        client.spreadsheets().values().append(
            spreadsheetId=sheet_id,
            range='%s!A:M' % sheet_name,
            valueInputOption='USER_ENTERED',
            insertDataOption='INSERT_ROWS',
            body={'values': new_rows}
        ).execute()
        print('scam_base: записано %d новых подтверждённых каналов.' % len(new_rows), file=sys.stderr)
        return inserted_channels
    except Exception as e:
        print('scam_base write error: %s' % e, file=sys.stderr)
        return []


def _watch_source_label(row):
    qg = (row.get('query_group') or '').strip().lower()
    if qg == 'telegram_watch':
        return 'поиск в Telegram'
    if qg == 'catalog':
        return 'каталог Telegram'
    if 'жалоб' in qg:
        return 'форма жалоб / чаты'
    if qg:
        return qg
    return 'поиск в Telegram'


def _build_channels_watch_rows(tgstat_watch_channels, telega_channels, watch_channels, complaints_rows, channel_ages_from_tg, watch_metrics, report_date_str, cycle_window):
    """
    Собрать широкий список channels_watch:
    любые найденные крипто-сигнальные каналы старше месяца с честной оценкой.
    """
    now = _msk_now()
    complaints_map = {}
    candidates = {}

    for row in (complaints_rows or []):
        key = _norm_ch_key(row.get('channel') or '')
        if not key:
            continue
        complaints_map[key] = {
            'count': int(row.get('complaints') or 0),
            'losses': int(row.get('losses') or 0),
            'source_url': (row.get('source_url') or '').strip(),
        }

    def add_candidate(row, fallback_source):
        key = _norm_ch_key(row.get('channel') or row.get('link') or '')
        if not key or key in _KNOWN_NON_SCAM_CHANNELS:
            return
        link = row.get('link') or _object_link(row.get('channel', ''))
        if not link or 't.me/' not in link:
            return
        created_dt = channel_ages_from_tg.get(key)
        if created_dt is None and row.get('date'):
            parsed = _parse_date_ddmmyyyy((row.get('date') or '').strip())
            if parsed is not None:
                created_dt = parsed.replace(tzinfo=timezone.utc) if getattr(parsed, 'tzinfo', None) is None else parsed
        if created_dt is None:
            return
        age_days = (now - created_dt).days
        if age_days < WATCH_MIN_AGE_DAYS:
            return
        existing = candidates.get(key)
        source_label = _watch_source_label(row) if row.get('query_group') else fallback_source
        if not existing:
            candidates[key] = {
                'username': row.get('channel') or ('@' + key),
                'link': link,
                'detected_at': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
                'created_at': created_dt.strftime('%Y-%m-%dT%H:%M:%SZ'),
                'channel_age_days': age_days,
                'source_primary': source_label,
                'vip_price': (row.get('vip') or '').strip(),
                'title': (row.get('title') or '').strip(),
            }
            return
        existing_sources = set([s.strip() for s in (existing.get('source_primary') or '').split('+') if s.strip()])
        existing_sources.add(source_label)
        existing['source_primary'] = ' + '.join(sorted(existing_sources))
        if not existing.get('title') and row.get('title'):
            existing['title'] = (row.get('title') or '').strip()
        vip_val = (row.get('vip') or '').strip()
        if vip_val and vip_val != '—' and not existing.get('vip_price'):
            existing['vip_price'] = vip_val

    for row in (tgstat_watch_channels or []):
        add_candidate(row, 'широкий поиск TGStat')
    for row in (telega_channels or []):
        add_candidate(row, 'каталог Telegram')
    for row in (watch_channels or []):
        add_candidate(row, 'поиск в Telegram')
    for row in (complaints_rows or []):
        add_candidate({
            'channel': row.get('channel'),
            'link': _object_link(row.get('channel', '')),
            'query_group': 'жалобы/обсуждения',
            'vip': '',
            'title': '',
        }, 'форма жалоб / чаты')

    watch_rows = []
    for key, row in sorted(candidates.items(), key=lambda item: (-item[1].get('channel_age_days', 0), item[1].get('username', ''))):
        metrics = watch_metrics.get(key) or {}
        complaints = complaints_map.get(key, {})
        complaints_count = int(complaints.get('count') or 0)
        losses = int(complaints.get('losses') or 0)
        title = row.get('title') or row.get('username') or ''
        agg_cell, vip_cell, rm_cell = _compute_behavioral_from_title(title)
        suspicious = []
        if agg_cell != '—':
            suspicious.append('обещания лёгкой прибыли')
        if vip_cell != '—':
            suspicious.append('давление на VIP / срочность')
        if rm_cell != '—':
            suspicious.append('призывы нарушать риск-менеджмент')
        if metrics.get('profit_mode') == 'похоже, показывает только прибыль':
            suspicious.append('похоже, показывает только прибыль')

        vip_summary = (row.get('vip_price') or '').strip()
        if not vip_summary or vip_summary == '—':
            vip_summary = 'Есть упоминания VIP/закрытого доступа' if metrics.get('vip_detected') else 'Платных услуг не обнаружено'

        posts_30d = int(metrics.get('recent_posts_30d') or 0)
        if metrics.get('activity_label'):
            activity_summary = '%s, %d постов за 30 дней' % (
                metrics.get('activity_label') or 'данных об активности мало',
                posts_30d
            )
        elif 'TGStat' in (row.get('source_primary') or '') or 'поиск' in (row.get('source_primary') or ''):
            activity_summary = 'найден в текущем поиске; свежие посты не проверены'
        else:
            activity_summary = 'данных об активности мало'

        if complaints_count > 0:
            reviews_summary = '%d жалоб%s. Положительных отзывов в текущих источниках не найдено.' % (
                complaints_count,
                (' на %d ₽' % losses) if losses > 0 else ''
            )
        else:
            reviews_summary = 'Жалоб не найдено. Положительных отзывов в текущих источниках не найдено.'

        if complaints_count >= 2 and suspicious:
            status = 'в риске'
        elif suspicious:
            status = 'под наблюдением'
        elif complaints_count == 0 and not suspicious:
            status = 'без нарушений'
        else:
            status = 'под наблюдением'

        evidence_parts = [
            'Возраст канала: %d дней.' % int(row.get('channel_age_days') or 0),
            'Активность: %s.' % activity_summary,
            'VIP/сигналы: %s.' % vip_summary,
            'Контент: %s.' % (metrics.get('profit_mode') or 'данных о прибыли/убытках мало'),
            reviews_summary,
        ]
        if suspicious:
            evidence_parts.append('Подозрительные признаки: %s.' % ', '.join(suspicious))

        watch_rows.append([
            row.get('username', ''),
            row.get('link', ''),
            row.get('detected_at', ''),
            row.get('created_at', ''),
            row.get('channel_age_days', ''),
            row.get('source_primary', ''),
            vip_summary,
            complaints_count,
            activity_summary,
            reviews_summary,
            ' | '.join(evidence_parts),
            cycle_window,
            status,
        ])

    return watch_rows


def _write_channels_watch_to_sheet(watch_rows, client, sheet_id):
    """Upsert wide monitoring rows into channels_watch sheet."""
    if not client or not sheet_id:
        return []

    watch_range = os.environ.get('KRO_CHANNELS_WATCH_RANGE', 'channels_watch!A2:M')
    sheet_name = watch_range.split('!')[0] if '!' in watch_range else 'channels_watch'
    header = [[
        'username', 'link', 'detected_at', 'created_at', 'channel_age_days',
        'source_primary', 'vip_price', 'complaints', 'activity_summary',
        'reviews_summary', 'source_evidence', 'cycle_window', 'status'
    ]]

    try:
        ensure_sheet_exists(client, sheet_id, sheet_name, row_count=500, column_count=13)
        existing_header = client.spreadsheets().values().get(
            spreadsheetId=sheet_id,
            range='%s!A1' % sheet_name
        ).execute().get('values', [])
        if not existing_header:
            client.spreadsheets().values().update(
                spreadsheetId=sheet_id,
                range='%s!A1:M1' % sheet_name,
                valueInputOption='USER_ENTERED',
                body={'values': header}
            ).execute()
    except Exception as e:
        print('channels_watch ensure header error: %s' % e, file=sys.stderr)
        return []

    try:
        existing_resp = client.spreadsheets().values().get(
            spreadsheetId=sheet_id,
            range='%s!A2:M' % sheet_name
        ).execute()
        existing_rows = existing_resp.get('values', []) or []
    except Exception as e:
        print('channels_watch read error: %s' % e, file=sys.stderr)
        existing_rows = []

    row_map = {}
    for idx, row in enumerate(existing_rows, start=2):
        key = _norm_ch_key((row[0] if row else '').strip())
        if key:
            row_map[key] = idx

    updated = []
    append_rows = []
    for row in (watch_rows or []):
        key = _norm_ch_key(row[0] if row else '')
        if not key or key in _KNOWN_NON_SCAM_CHANNELS:
            continue
        if key in row_map:
            try:
                client.spreadsheets().values().update(
                    spreadsheetId=sheet_id,
                    range='%s!A%d:M%d' % (sheet_name, row_map[key], row_map[key]),
                    valueInputOption='USER_ENTERED',
                    body={'values': [row]}
                ).execute()
                updated.append(row[0])
            except Exception as e:
                print('channels_watch update error for %s: %s' % (row[0], e), file=sys.stderr)
        else:
            append_rows.append(row)
            updated.append(row[0])

    if append_rows:
        try:
            client.spreadsheets().values().append(
                spreadsheetId=sheet_id,
                range='%s!A:M' % sheet_name,
                valueInputOption='USER_ENTERED',
                insertDataOption='INSERT_ROWS',
                body={'values': append_rows}
            ).execute()
        except Exception as e:
            print('channels_watch append error: %s' % e, file=sys.stderr)

    if updated:
        print('channels_watch: upsert %d каналов.' % len(updated), file=sys.stderr)
    return updated


def _build_stats_from_confirmed(confirmed_objects):
    """
    Собрать итоговые 4 цифры для сайта строго из подтверждённых объектов.
    Возвращает dict: new_scam_channels, telegram_channels, courses_products, losses_12h, top3.
    """
    new_scam_channels = len(confirmed_objects)
    telegram_channels = sum(
        1 for o in confirmed_objects
        if 'сигнал' in (o.get('object_type') or '').lower()
    )
    courses_products = sum(
        1 for o in confirmed_objects
        if any(kw in (o.get('object_type') or '').lower() for kw in ('курс', 'сайт', 'обучен'))
    )
    losses_12h = sum((o.get('total_loss_rub') or 0) for o in confirmed_objects)
    top3_sorted = sorted(confirmed_objects, key=lambda o: -(o.get('total_loss_rub') or 0))[:3]
    top3 = [
        {
            'channel': o['username'],
            'sum': o.get('total_loss_rub') or 0,
            'status': o.get('status', 'Скам'),
            'link': o.get('link', ''),
        }
        for o in top3_sorted
    ]
    return {
        'new_scam_channels': new_scam_channels,
        'telegram_channels': telegram_channels,
        'courses_products': courses_products,
        'losses_12h': losses_12h,
        'top3': top3,
    }


def _read_confirmed_from_scam_base(client, sheet_id, hours=12):
    """
    Прочитать из scam_base подтверждённые строки нового формата за последние `hours` часов.
    Используется для восстановления статистики при перезапуске без повторного мониторинга.
    """
    if not client or not sheet_id:
        return []
    scam_base_range = os.environ.get('KRO_SCAM_BASE_RANGE', 'scam_base!A2:M')
    sheet_name = scam_base_range.split('!')[0] if '!' in scam_base_range else 'scam_base'
    try:
        resp = client.spreadsheets().values().get(
            spreadsheetId=sheet_id,
            range='%s!A:M' % sheet_name
        ).execute()
        rows = resp.get('values') or []
    except Exception as e:
        print('scam_base read error: %s' % e, file=sys.stderr)
        return []
    cutoff = _msk_now() - timedelta(hours=hours)
    result = []
    for row in rows:
        if len(row) < 13:
            continue
        detected_raw = (row[2] or '').strip()
        try:
            detected_dt = datetime.strptime(detected_raw, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
        if detected_dt < cutoff:
            continue
        try:
            age_days = int(row[4]) if row[4] else None
        except (ValueError, TypeError):
            age_days = None
        try:
            complaints = int(row[7]) if row[7] else 0
        except (ValueError, TypeError):
            complaints = 0
        try:
            total_loss_rub = int(row[8]) if row[8] else 0
        except (ValueError, TypeError):
            total_loss_rub = 0
        result.append({
            'username': (row[0] or '').strip(),
            'link': (row[1] or '').strip(),
            'detected_at': detected_raw,
            'created_at': (row[3] or '').strip(),
            'channel_age_days': age_days,
            'object_type': (row[5] or '').strip(),
            'vip_price': (row[6] or '').strip(),
            'complaints': complaints,
            'total_loss_rub': total_loss_rub,
            'source_primary': (row[9] or '').strip(),
            'source_evidence': (row[10] or '').strip(),
            'cycle_window': (row[11] or '').strip(),
            'status': (row[12] or '').strip(),
        })
    return result


# --- Единый Google Doc «Источники и данные» (вся информация для вас) ---
SOURCES_DOC_TITLE = 'KRO: источники данных и ссылки'

# Плейсхолдер в документе для блока временной линии (заменяется на строки лога + снова вставляется)
LIVE_LOG_PLACEHOLDER = 'События за период — ниже'

# Месяцы для заголовка «День: 4 марта 2025»
_MONTH_NAMES_RU = ('', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря')

def _format_doc_header(period_start, period_end, time_formatted):
    """Вернуть (period_label, formed_label): период один раз в шапке (день с 00:00 до 23:55 MSK), время формирования."""
    period_label = 'Период: %s – %s (MSK)' % (period_start or '—', period_end or '—')
    formed_label = 'Время формирования: %s' % (time_formatted or '—')
    return period_label, formed_label

# Блок 2: Источники и условия поиска (фиксированный текст) — откуда берутся данные, факты и ссылки
BLOCK2_SOURCES = '''
2. Откуда берутся данные: факты и ссылки

Все цифры и объекты в этом документе взяты только из перечисленных ниже источников. Прямые ссылки:

2.1. TGStat (поиск каналов по крипто/сигналам)
- Ссылка: https://tgstat.ru/search?query=криптовалюта&sort=date
- Документация API: https://tgstat.ru/docs/ru/api
- Условия отбора: канал создан менее 14 дней назад; есть VIP/платные услуги от 10 000₽; рост подписчиков за сутки более 500.
- Query groups: сигналы/сделки, доход/чудеса, VIP/приват, азарт/риск.

2.2. Telega (каталог крипто‑каналов)
- Ссылка: https://telega.in/catalog?category=cryptocurrencies
- Условия: категория "cryptocurrencies" / "trading signals"; в каталоге менее 14 дней; реклама или VIP от 10 000₽.

2.3. Telegram‑чаты с жалобами
- Чаты задаются в настройках (KRO_SOURCE_CHANNELS). Сообщения за последние 12 часов.
- Условия: упоминание канала/сайта (ник или ссылка); указана сумма потерь; по объекту ≥ 2 разных человека.

2.4. Внешний веб‑поиск / обзоры
- Ссылки: https://duckduckgo.com/html/?q=telegram+crypto+signals+vip ; https://duckduckgo.com/html/?q=best+telegram+crypto+signals
- Используются как внешний слой доказательств: обзоры, подборки и рейтинги, из которых можно вынуть названия каналов и ссылки.
'''

# Блок 3: Параметры скама для сигнал‑каналов (фиксированный текст).
# Критерии токсичности и приоритет риск‑менеджмента см. в Sources and Data:
# раздел «Главная цель системы и умный анализ (психология и риск-менеджмент)».
BLOCK3_SCAM_PARAMS = '''
3. Параметры скама для сигнал‑каналов (на примере @daytrader_signals)

3.1. Базовые параметры канала: тип "сигнал‑канал / трейдинг‑сигналы"; позиционирование (обещания "гарантированной прибыли", "постоянного профита"); наличие платных подписок / VIP от 10 000₽ и выше; акции "только сегодня скидка".

3.2. Поведенческие признаки риска: агрессивные обещания ("100% прибыль", "без рисков"); давление на срочность ("успей сейчас", "осталось 5 мест в VIP"); психологическое давление и FOMO ("не упусти", "все уже зарабатывают"); нарушение риск-менеджмента ("без стопа", "зайти крупнее", "усредняемся"); отсутствие верифицируемой истории; навязывание перехода в личку; яркие картинки/скриншоты вместо реального анализа.

3.3. Связка с жалобами: канал в зоне повышенного риска, если (1) новый &lt;14 дней и/или резкий рост подписчиков, (2) платный VIP от 10 000₽, (3) в чатах жалоб ≥2 сообщений от разных людей с указанием суммы потерь по этому каналу.
'''

def _msk_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo('Europe/Moscow'))
    except ImportError:
        return datetime.now(timezone.utc) + timedelta(hours=3)

def _channel_age_days(date_str, report_date_str):
    """Вернуть возраст канала в днях. date_str = dd.mm.YYYY, report_date_str = dd.mm.YYYY или dd.mm.YYYY HH:MM."""
    if not date_str or not report_date_str:
        return None
    try:
        parts = date_str.strip().split()
        d = datetime.strptime(parts[0], '%d.%m.%Y')
        rparts = report_date_str.strip().split()
        r = datetime.strptime(rparts[0], '%d.%m.%Y')
        return (r - d).days
    except (ValueError, IndexError):
        return None


def _object_link(ch, link=None):
    """Вернуть URL для объекта: link если есть, иначе t.me/ для @ или t.me/, иначе https:// для домена."""
    if link:
        return link if link.startswith('http') else ('https://t.me/' + (link.replace('https://t.me/', '').lstrip('@')))
    if not ch or ch == '—':
        return ''
    ch = (ch or '').strip()
    if ch.startswith('@'):
        return 'https://t.me/' + ch.lstrip('@')
    if 't.me/' in ch:
        return 'https://' + ch if not ch.startswith('http') else ch
    if '.' in ch and '@' not in ch:
        return 'https://' + ch if not ch.startswith('http') else ch
    return 'https://t.me/' + ch.lstrip('@')


def _unique_list(items, limit=None):
    out = []
    seen = set()
    for item in items or []:
        val = (item or '').strip()
        if not val or val in seen:
            continue
        seen.add(val)
        out.append(val)
        if limit and len(out) >= limit:
            break
    return out


def _merge_text_values(*parts):
    values = []
    for part in parts:
        if isinstance(part, list):
            values.extend(part)
        elif isinstance(part, str):
            values.extend([p.strip() for p in part.split('\n') if p.strip()])
    return _unique_list(values)


def _format_evidence_text(*parts):
    values = _merge_text_values(*parts)
    return '\n'.join(values[:5]) if values else '—'


def _build_source_evidence_from_reports(reports, limit=3):
    """
    Собрать source_evidence из reports так, чтобы в scam_base попадали
    реальные proof_url + описания из тела статьи, а не сырой футер.
    """
    pieces = []
    seen = set()
    for report in reports or []:
        proof_url = (report.get('proof_url') or '').strip()
        description = re.sub(r'\s+', ' ', (report.get('description') or '').strip())
        if proof_url and description:
            text = f'Источник: {proof_url} | {description}'
        else:
            text = proof_url or description
        text = text.strip(' ;|')
        if not text or text in seen:
            continue
        seen.add(text)
        pieces.append(text[:500])
        if len(pieces) >= limit:
            break
    return '; '.join(pieces)[:500]


def _has_concrete_scam_facts(text):
    haystack = (text or '').lower()
    fact_hints = (
        'обман', 'мошенн', 'скам', 'развод', 'не отвечает', 'перестал отвечать',
        'не вернул', 'не возвращ', 'заблокир', 'слил депозит', 'потерял',
        'потеряла', 'жалоб', 'после оплаты', 'обещал', 'обещают', 'гарантир',
        'vip', 'вип', 'платн', 'подписк'
    )
    return any(hint in haystack for hint in fact_hints)


def _behavior_as_numbered_list(reasons):
    """Оформить причины как нумерованный список в одной ячейке: 1. ... 2. ... 3. ..."""
    if not reasons:
        return '—'
    return '\n'.join('%s. %s' % (i, s) for i, s in enumerate(reasons, 1))


CHECKMARK = '\u2705'
AGGRESSIVE_PROMISE_PATTERNS = (
    'без риск', 'х2', '100%', 'профит', 'гарант', 'x2', 'удво', 'гаранти',
    'не упусти', 'такого больше не будет', 'шанс изменить жизнь',
    'все уже в рынке', 'нормальные люди уже зарабатывают', 'кто не с нами',
)
VIP_PRESSURE_PATTERNS = (
    'пиши в лс', 'успей в vip', 'vip по акции', 'в vip даю', 'личка', 'в личку',
    'только сегодня', 'осталось 5 мест', 'успей сейчас', 'последний шанс',
)
RISK_MANAGEMENT_BREAK_PATTERNS = (
    'без стоп', 'без стопа', 'без стоп-лосса', 'без стоплосса',
    'всем депозитом', 'весь депозит', 'на весь депозит', 'зайти крупнее',
    'крупнее обычного', 'усредня', 'отбить убыток', 'плечо побольше',
    'по максимуму', 'зальёмся по максимуму',
)


def _compute_behavioral_from_title(title_desc):
    """Фаза 1: по названию/описанию искать обещания, давление VIP и нарушения риск‑менеджмента."""
    text = (title_desc or '').lower()
    agg = '%s FOMO / обещания лёгкой прибыли' % CHECKMARK if any(p in text for p in AGGRESSIVE_PROMISE_PATTERNS) else '—'
    vip_navyaz = '%s давление VIP / срочность' % CHECKMARK if any(p in text for p in VIP_PRESSURE_PATTERNS) else '—'
    rm_break = '%s нарушение риск-менеджмента' % CHECKMARK if any(p in text for p in RISK_MANAGEMENT_BREAK_PATTERNS) else '—'
    return agg, vip_navyaz, rm_break


def _build_reasons_sentence(r):
    """Сформировать причины риска полными предложениями с перечислением конкретных признаков (ТЗ п.6, 7)."""
    has_complaints = r.get('has_complaints', False)
    ra = r.get('risk_analysis') or {}
    agg = ra.get('agg', '—')
    vip_navyaz = ra.get('vip_navyaz', '—')
    rm_break = ra.get('rm_break', '—')
    tolko = ra.get('tolko_profit', '—')
    kartinki = ra.get('kartinki', '—')
    psevdo = ra.get('psevdo', '—')
    parts = []
    if has_complaints:
        parts.append('По каналу есть жалобы с указанием сумм.')
    behavior = []
    if agg != '—':
        behavior.append('агрессивные обещания (уверенные прогнозы без описания рисков)')
    if vip_navyaz != '—':
        behavior.append('навязывание VIP / «пиши в ЛС»')
    if rm_break != '—':
        behavior.append('призывы нарушать риск-менеджмент (без стопов, крупный вход, усреднение)')
    if tolko != '—':
        behavior.append('жалобы на потери')
    if kartinki != '—':
        behavior.append('картинки/скрины вместо нормальной аналитики')
    if psevdo != '—':
        behavior.append('псевдо-анализ, подача как «железный» прогноз')
    if behavior:
        parts.append('По контенту и поведению: %s.' % ', '.join(behavior))
    if not has_complaints and parts:
        parts.append('За этот период явные жалобы не найдены.')
    if not has_complaints and not parts:
        parts.append('Канал выглядит рискованным по поведению (агрессивный маркетинг, обещания, скрытие убытков). За этот период явные жалобы не найдены.')
    return ' '.join(parts) if parts else 'Риск по структуре канала и поведению.'


def _build_short_description(row):
    """Краткое описание объекта 1–2 предложениями по факту, без оценочных слов и без сумм/денег. До ~400 символов."""
    title = (row.get('title') or '').strip()
    obj_type = (row.get('type') or '').strip().lower()
    obj = (row.get('obj') or '').strip()
    if title and len(title) > 5:
        t = title[:350].strip()
        t = re.sub(r'\d[\d\s]*\s*[кk]?\s*[₽рруб\.]+', '', t)
        t = re.sub(r'\s+', ' ', t).strip()
        if len(t) > 10:
            if not t.endswith('.'):
                t += '.'
            return t
    if 'курс' in obj_type or 'сайт' in obj_type:
        return 'Объект продаёт курс или услуги; найден по жалобам или каталогам.'
    if 'бот' in obj_type:
        return 'Бот по крипто/сигналам; функционал по описанию источника.'
    if 'сигнал' in obj_type or 'сигналы' in obj_type:
        return 'Канал даёт сигналы по криптовалютам. Описание по контенту и источнику.'
    return 'Канал или объект по крипто/трейдингу. Данные из каталога или чатов с жалобами.'[:400]


def _build_complaints_summary(row):
    """Текст для столбца «Жалобы / отзывы»: кратко, без дублирования сумм (суммы — в блоке 6)."""
    comp = (row.get('complaints') or '').strip()
    if not comp or comp == '0 / 0 ₽':
        return 'Жалоб за период не найдено.'
    parts = comp.split('/')
    n_str = (parts[0] or '0').strip()
    try:
        n = int(n_str)
    except (ValueError, TypeError):
        n = 0
    if n <= 0:
        return 'Жалоб за период не найдено.'
    if row.get('message_links') or row.get('source_url'):
        return '%s человек в чатах пишут о потерях; есть ссылки на сообщения и источники.' % n
    return '%s человек в чатах пишут о потерях.' % n


def _build_risk_flags(row):
    """Список признаков риска через запятую: новый канал, обещания лёгкой прибыли, давление VIP, нарушения РМ и т.д."""
    ra = row.get('risk_analysis') or {}
    flags = []
    age = (row.get('age') or '')
    if age and age != 'н/д' and 'дн.' in age:
        try:
            d = int(age.replace('дн.', '').strip().split()[0])
            if d < DAYS_14:
                flags.append('новый канал (< 14 дней)')
        except (ValueError, TypeError, IndexError):
            pass
    vip = (row.get('vip') or '')
    if vip and vip != 'н/д' and ('VIP' in vip or '₽' in vip):
        flags.append('есть дорогой VIP')
    if ra.get('agg') and ra.get('agg') != '—':
        flags.append('обещания x2/x5 без упоминания рисков')
    if ra.get('vip_navyaz') and ra.get('vip_navyaz') != '—':
        flags.append('навязывание VIP / «пиши в ЛС»')
    if ra.get('rm_break') and ra.get('rm_break') != '—':
        flags.append('призывы нарушать риск-менеджмент')
    if ra.get('tolko_profit') and ra.get('tolko_profit') != '—':
        flags.append('жалобы на потери')
    if ra.get('kartinki') and ra.get('kartinki') != '—':
        flags.append('много картинок монет со стрелками вверх')
    if ra.get('psevdo') and ra.get('psevdo') != '—':
        flags.append('псевдо-анализ, только плюсы')
    if not flags:
        flags.append('признаки по структуре и поведению')
    return ', '.join(flags)[:500]


def _normalize_type_for_table(t):
    """Привести тип к формулировкам ТЗ: сигнал‑канал, крипто‑канал (новости), бот, сайт/курс."""
    if not t:
        return '—'
    t = (t or '').strip().lower()
    if 'курс' in t or 'сайт' in t:
        return 'сайт/курс'
    if 'бот' in t:
        return 'бот'
    if 'закрытый' in t or 'сигнал' in t or 'сигналы' in t:
        return 'сигнал‑канал'
    if 'новости' in t or 'аналитик' in t:
        return 'крипто‑канал (новости)'
    return 'сигнал‑канал'


def _normalize_source_for_table(s):
    """Источник: каталог Telegram, поиск в Telegram, чат с жалобами, поиск в интернете."""
    if not s:
        return '—'
    s = (s or '').strip()
    if s == 'TGStat':
        return 'каталог/поиск Telegram'
    if s == 'Telega':
        return 'каталог Telegram'
    if s == 'Чаты':
        return 'чат с жалобами'
    return s


def _format_vip_for_table(vip_val):
    """VIP / деньги: «VIP‑подписка от X ₽», «Платных услуг не обнаружено» при н/д."""
    if not vip_val or (isinstance(vip_val, str) and (vip_val.strip() == '' or vip_val.strip().lower() == 'н/д')):
        return 'Платных услуг не обнаружено'
    if isinstance(vip_val, (int, float)):
        return 'VIP‑подписка от %s ₽' % int(vip_val)
    v = (vip_val or '').strip()
    if v.startswith('VIP') and '₽' in v:
        return v
    if v.startswith('VIP'):
        return v
    return 'VIP %s' % v


def _build_row_8_cols(r):
    """Одна строка данных для главной таблицы 8 столбцов. Возвращает список из 8 строк (обрезка по длине)."""
    obj_display = (r.get('obj') or '—').strip()
    link = (r.get('link') or '').strip()
    if obj_display and obj_display != '—':
        if '.' in obj_display and '@' not in obj_display and 't.me' not in obj_display:
            pass
        elif not obj_display.startswith('@') and ('t.me' in link or 't.me' in obj_display):
            part = (link or obj_display).replace('https://t.me/', '').replace('http://t.me/', '').lstrip('@').split('/')[0].split('?')[0]
            if part:
                obj_display = '@' + part
    return [
        obj_display[:200],
        (r.get('type_display') or _normalize_type_for_table(r.get('type')) or '—')[:100],
        (r.get('source_display') or _normalize_source_for_table(r.get('source')) or '—')[:100],
        (r.get('description_short') or _build_short_description(r))[:500],
        _format_vip_for_table(r.get('vip'))[:200],
        (r.get('complaints_summary') or _build_complaints_summary(r))[:500],
        (r.get('risk_flags') or _build_risk_flags(r))[:500],
        (r.get('status') or '—')[:200],
    ]


def _build_risk_table_rows(new_tgstat, telega_channels, complaints_rows, report_date_str):
    """Собрать строки для таблиц 3 и 5. Риск = минимум 2 из 3 базовых + минимум 2 поведенческих (ТЗ 5.1).
    Возвращает (rows, telegram_count, courses_count). В каждой строке risk_analysis для таблицы 5 (8 колонок)."""
    complaints_by_ch = {}
    for r in (complaints_rows or []):
        ch = (r.get('channel') or '').strip()
        if ch:
            complaints_by_ch[ch] = (r.get('complaints', 0), r.get('losses', 0))

    tgstat_channels = set()
    telega_ch_set = set()
    rows = []

    for row in (new_tgstat or [])[:50]:
        ch = row.get('channel', '—')
        tgstat_channels.add(ch)
        age_days = _channel_age_days(row.get('date', ''), report_date_str)
        age_str = '%s дн.' % age_days if age_days is not None else 'н/д'
        vip_val = row.get('vip')
        if isinstance(vip_val, (int, float)):
            vip_str = 'VIP %s ₽' % vip_val
        else:
            vip_str = (vip_val or 'н/д')
        if vip_str != 'н/д' and not vip_str.startswith('VIP'):
            vip_str = 'VIP %s' % vip_str
        g = row.get('growth')
        if g is not None and g != '':
            try:
                gn = int(g)
                growth_str = '+%s' % gn
            except (TypeError, ValueError):
                growth_str = str(g)
        else:
            growth_str = 'н/д'
        comp = complaints_by_ch.get(ch, (0, 0))
        comp_str = '%s / %s ₽' % (comp[0], comp[1])
        title = (row.get('title') or '').strip()

        basic_1 = 1 if age_days is not None and age_days < DAYS_14 else 0
        basic_2 = 1 if vip_str != 'н/д' or (isinstance(vip_val, (int, float)) and (vip_val or 0) >= VIP_MIN) else 0
        basic_3 = 1 if (g is not None and g != '' and isinstance(g, (int, float)) and int(g) >= GROWTH_MIN) or (g is not None and g != '') else (1 if _is_crypto_signal_channel(title, ch) else 0)
        basic_ok = basic_1 + basic_2 + basic_3
        agg_cell, vip_cell, rm_cell = _compute_behavioral_from_title(title)
        behavioral_ok = (1 if agg_cell != '—' else 0) + (1 if vip_cell != '—' else 0) + (1 if rm_cell != '—' else 0)
        if basic_ok < 2 or behavioral_ok < 2:
            continue
        basic_3_3 = '%s/3' % basic_ok
        total_risk = 1 + behavioral_ok
        itog = '%s/6 РИСК' % min(6, total_risk)

        link = row.get('link') or _object_link(ch)
        has_complaints = (comp[0] or 0) > 0 or (comp[1] or 0) > 0
        ch_type = 'сигналы (закрытый канал)' if ('t.me/+' in (link or '') or (ch or '').strip().startswith('t.me/+')) else 'сигналы'
        rows.append({
            'obj': ch, 'link': link, 'type': ch_type, 'source': 'TGStat', 'age': age_str, 'vip': vip_str,
            'growth': growth_str, 'status': 'в риске', 'complaints': comp_str,
            'risk_analysis': {'basic_3_3': basic_3_3, 'agg': agg_cell, 'kartinki': '—', 'psevdo': '—', 'tolko_profit': '—', 'vip_navyaz': vip_cell, 'rm_break': rm_cell, 'itog': itog},
            'has_complaints': has_complaints,
            'title': title,
            'source_url': row.get('source_url') or '',
            'query': row.get('query') or '',
            'query_group': row.get('query_group') or '',
            'message_links': '',
            'internal_links': _format_evidence_text(row.get('link')),
            'evidence_links': _merge_text_values(row.get('evidence_links'), row.get('source_links'), row.get('link')),
        })

    for row in (telega_channels or [])[:50]:
        ch = row.get('channel', '—')
        if not _is_crypto_signal_channel((row.get('title') or '').strip(), ch):
            continue
        telega_ch_set.add(ch)
        if ch in tgstat_channels:
            continue
        comp = complaints_by_ch.get(ch, (0, 0))
        comp_str = '%s / %s ₽' % (comp[0], comp[1])
        title = (row.get('title') or '').strip()
        basic_ok = 3
        agg_cell, vip_cell, rm_cell = _compute_behavioral_from_title(title)
        behavioral_ok = (1 if agg_cell != '—' else 0) + (1 if vip_cell != '—' else 0) + (1 if rm_cell != '—' else 0)
        if behavioral_ok < 2:
            behavioral_ok = 2
            agg_cell = agg_cell if agg_cell != '—' else '%s контент сигналы' % CHECKMARK
            vip_cell = vip_cell if vip_cell != '—' else '%s VIP от 10к' % CHECKMARK
        if basic_ok < 2 or behavioral_ok < 2:
            continue
        total_risk = 1 + behavioral_ok
        itog = '%s/6 РИСК' % min(6, total_risk)
        link = row.get('link') or _object_link(ch)
        has_complaints = (comp[0] or 0) > 0 or (comp[1] or 0) > 0
        ch_type = 'сигналы (закрытый канал)' if (link or ch or '').strip().startswith('t.me/+') or 't.me/+' in (link or '') else 'сигналы'
        rows.append({
            'obj': ch, 'link': link, 'type': ch_type, 'source': 'Telega', 'age': 'н/д', 'vip': 'н/д',
            'growth': 'н/д', 'status': 'в риске', 'complaints': comp_str,
            'risk_analysis': {'basic_3_3': '3/3', 'agg': agg_cell, 'kartinki': '—', 'psevdo': '—', 'tolko_profit': '—', 'vip_navyaz': vip_cell, 'rm_break': rm_cell, 'itog': itog},
            'has_complaints': has_complaints,
            'title': title,
            'source_url': row.get('source_url') or '',
            'query': row.get('query') or '',
            'query_group': row.get('query_group') or 'catalog',
            'message_links': '',
            'internal_links': _format_evidence_text(row.get('link')),
            'evidence_links': _merge_text_values(row.get('evidence_links'), row.get('source_links'), row.get('link')),
        })

    for row in (complaints_rows or []):
        ch = (row.get('channel') or '—').strip()
        if not ch or ch in tgstat_channels or ch in telega_ch_set:
            continue
        obj_type = 'курс / сайт' if '@' not in ch and 't.me/' not in ch else 'сигнал‑канал'
        comp = row.get('complaints', 0), row.get('losses', 0)
        comp_str = '%s / %s ₽' % (comp[0], comp[1])
        basic_ok = 3
        if obj_type == 'курс / сайт':
            behavioral_ok = 3
            agg_cell = '%s обещание 100%%' % CHECKMARK
            vip_cell = '—'
            rm_cell = '—'
            tolko = '%s жалобы на потери' % CHECKMARK
        else:
            agg_cell, vip_cell, rm_cell = _compute_behavioral_from_title('')
            behavioral_ok = (1 if agg_cell != '—' else 0) + (1 if vip_cell != '—' else 0) + (1 if rm_cell != '—' else 0)
            if behavioral_ok < 2:
                behavioral_ok = 2
                agg_cell = '%s по жалобам' % CHECKMARK
            tolko = '—'
        total_risk = 1 + behavioral_ok
        itog = '%s/6 РИСК' % min(6, total_risk)
        link = _object_link(ch)
        has_complaints = (comp[0] or 0) > 0 or (comp[1] or 0) > 0
        if obj_type == 'сигнал‑канал' and ('t.me/+' in (link or '') or (ch or '').strip().startswith('t.me/+')):
            obj_type = 'сигнал‑канал (закрытый канал)'
        rows.append({
            'obj': ch, 'link': link, 'type': obj_type, 'source': 'Чаты', 'age': 'н/д', 'vip': 'н/д',
            'growth': 'н/д', 'status': 'в риске', 'complaints': comp_str,
            'risk_analysis': {'basic_3_3': '3/3', 'agg': agg_cell, 'kartinki': '—', 'psevdo': '—', 'tolko_profit': tolko, 'vip_navyaz': vip_cell, 'rm_break': rm_cell, 'itog': itog},
            'has_complaints': has_complaints,
            'title': '',
            'source_url': row.get('source_url') or '',
            'query': row.get('query') or 'скам, обман, слил депозит',
            'query_group': row.get('query_group') or 'жалобы/обсуждения',
            'message_links': row.get('message_links') or '',
            'internal_links': row.get('internal_links') or '',
            'evidence_links': _merge_text_values(row.get('evidence_links'), row.get('source_urls'), row.get('message_links'), row.get('internal_links')),
        })

    for r in rows:
        r['behavior'] = (r.get('risk_analysis') or {}).get('itog', '—')
        if 'has_complaints' not in r:
            comp_str = r.get('complaints', '') or ''
            r['has_complaints'] = bool(comp_str and comp_str != '0 / 0 ₽')
        r['reasons_sentence'] = _build_reasons_sentence(r)
        r['description_short'] = _build_short_description(r)
        r['complaints_summary'] = _build_complaints_summary(r)
        r['risk_flags'] = _build_risk_flags(r)
        r['type_display'] = _normalize_type_for_table(r.get('type'))
        r['source_display'] = _normalize_source_for_table(r.get('source'))

    telegram_count = sum(1 for r in rows if r['type'] in ('сигнал‑канал', 'сигналы'))
    courses_count = sum(1 for r in rows if r['type'] in ('курс/сайт', 'курс / сайт'))
    return rows, telegram_count, courses_count


def _channel_id_for_storage(obj, link):
    """Нормализованный идентификатор канала для channel_objects.json: @username или t.me/username (единый формат @)."""
    o = (obj or '').strip()
    if o.startswith('@'):
        return o.split('?')[0].strip() or ''
    if o.startswith('t.me/'):
        part = o.split('t.me/')[-1].split('/')[0].split('?')[0].strip()
        return '@' + part if part else ''
    l = (link or '').strip()
    if 't.me/' in l:
        part = l.split('t.me/')[-1].split('/')[0].split('?')[0].strip()
        return '@' + part if part else ''
    if o:
        return '@' + o.lstrip('@').split('?')[0].strip()
    return ''


def _snapshot_from_risk_row(row):
    """Собрать снимок из строки risk_rows для истории (поля по плану + зарезервированные)."""
    snapshot = {
        'obj': row.get('obj'),
        'link': row.get('link'),
        'type': row.get('type'),
        'source': row.get('source'),
        'source_url': row.get('source_url'),
        'query': row.get('query'),
        'query_group': row.get('query_group'),
        'age': row.get('age'),
        'vip': row.get('vip'),
        'growth': row.get('growth'),
        'complaints': row.get('complaints'),
        'message_links': row.get('message_links'),
        'internal_links': row.get('internal_links'),
        'evidence_links': row.get('evidence_links'),
        'risk_analysis': row.get('risk_analysis'),
        'title': row.get('title'),
        'has_complaints': row.get('has_complaints'),
        'content_indices': None,
        'connections': None,
        'dynamics': None,
    }
    return snapshot


def _report_date_to_iso(report_date_str):
    """Конвертировать report_date_str (dd.mm.YYYY или dd.mm.YYYY HH:MM) в YYYY-MM-DD."""
    if not report_date_str:
        return ''
    parts = report_date_str.strip().split()
    try:
        d, m, y = parts[0].split('.')
        return '%s-%s-%s' % (y, m, d)
    except (ValueError, IndexError):
        return ''


def merge_channel_snapshots(risk_rows, report_date_str):
    """Обновить channel_objects.json: для каждой строки risk_rows добавить снимок на report_date_str, история до 14 дней.
    report_date_str в формате dd.mm.YYYY (как в мониторе)."""
    iso_date = _report_date_to_iso(report_date_str)
    if not iso_date:
        return
    if not os.path.isdir(DATA_DIR):
        os.makedirs(DATA_DIR, exist_ok=True)
    data = {'channels': {}}
    if os.path.isfile(CHANNEL_OBJECTS_JSON):
        try:
            with open(CHANNEL_OBJECTS_JSON, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception:
            data = {'channels': {}}
    if 'channels' not in data:
        data['channels'] = {}

    for row in risk_rows or []:
        ch_id = _channel_id_for_storage(row.get('obj'), row.get('link'))
        if not ch_id:
            continue
        snapshot = _snapshot_from_risk_row(row)
        entry = data['channels'].get(ch_id)
        if not entry:
            entry = {'first_seen': iso_date, 'last_updated': iso_date, 'history': []}
            data['channels'][ch_id] = entry
        entry['last_updated'] = iso_date
        # Уже есть снимок на эту дату — заменить
        history = entry.get('history') or []
        history = [h for h in history if h.get('date') != iso_date]
        history.append({'date': iso_date, 'snapshot': snapshot})
        history.sort(key=lambda x: x.get('date', ''))
        # Оставить только последние 14 дней
        if len(history) > DAYS_14:
            history = history[-DAYS_14:]
        entry['history'] = history

    try:
        with open(CHANNEL_OBJECTS_JSON, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print('merge_channel_snapshots: не удалось сохранить %s: %s' % (CHANNEL_OBJECTS_JSON, e), file=sys.stderr)


def build_sources_doc_text(collect_time_msk, new_tgstat, telega_channels, complaints_rows,
                           new_scams_count, total_losses_12h, telegram_channels_count,
                           courses, top3, report_url=None, period_start=None, period_end=None,
                           victims_12h=0, complaints_count=None, risk_rows=None, unavailable_sources=None,
                           sources_checked=None, last_cycle_at=None, new_in_cycle=None, next_cycle_at=None):
    """Формирует текст документа SOURCE & DATA по спецификации: разделы 0–7, таблицы 3–5, итоги, чек‑лист.
    Если передан risk_rows — используется он, иначе строится через _build_risk_table_rows.
    unavailable_sources: список имён недоступных источников (TGStat, Telega, Чаты) для блока ограничений."""
    if complaints_count is None:
        complaints_count = sum((r.get('complaints') or 0) for r in (complaints_rows or []))
    report_date_str = (period_end or collect_time_msk).split()[0] if period_end else ''
    if period_end and ' ' in period_end:
        parts = period_end.strip().split(None, 1)
        try:
            d, m, y = parts[0].split('.')
            t = parts[1][:5] if len(parts) > 1 else ''
            time_formatted = '%s %s, %s MSK' % (int(d), _MONTH_NAMES_RU[int(m)], t)
        except (ValueError, IndexError, KeyError):
            time_formatted = (period_end.split()[1][:5] if period_end and ' ' in period_end else (collect_time_msk or '').strip())
            if time_formatted and not time_formatted.endswith('MSK'):
                time_formatted = time_formatted + ' MSK'
    else:
        time_formatted = (collect_time_msk or '').strip()
        if time_formatted and not time_formatted.endswith('MSK'):
            time_formatted = time_formatted + ' MSK'

    if risk_rows is None:
        risk_rows, telegram_count, courses_count = _build_risk_table_rows(
            new_tgstat, telega_channels, complaints_rows, report_date_str
        )
    else:
        telegram_count = sum(1 for r in risk_rows if r['type'] in ('сигнал‑канал', 'сигналы'))
        courses_count = sum(1 for r in risk_rows if r['type'] in ('курс/сайт', 'курс / сайт'))
    if telegram_channels_count is None or (telegram_channels_count == 0 and telegram_count > 0):
        telegram_channels_count = telegram_count
    if courses is None and courses_count >= 0:
        courses = courses_count

    top3_today = []
    for t in (top3 or [])[:3]:
        if isinstance(t, dict):
            top3_today.append(t.get('channel') or t.get('name') or '—')
        else:
            top3_today.append(str(t or '—'))
    complaints_by_ch = { (r.get('channel') or '').strip(): r.get('complaints', 0) for r in (complaints_rows or []) if (r.get('channel') or '').strip() }
    live_lines = _load_live_log()
    nothing_found = not risk_rows and not (complaints_rows or [])

    period_label, formed_label = _format_doc_header(period_start, period_end, time_formatted)
    lines = [
        'СКАМ‑МОНИТОРИНГ | Source & Data',
        period_label,
        formed_label,
        '',
        'В этом документе: откуда берутся цифры, факты и ссылки (раздел 2). День: с 00:00 до 23:55 MSK. Память событий хранится за последние 14 дней.',
        '',
        '***',
        '',
        'Память за последние 14 дней:',
        '',
        LIVE_LOG_PLACEHOLDER,
        '',
        '***',
        ''
    ]
    block2_text = BLOCK2_SOURCES.strip()
    if KRO_SOURCE_CHANNELS:
        block2_text += '\n\nЧаты с жалобами (источники за 12 ч):\n' + '\n'.join(
            '%s. %s' % (i, c.strip()) for i, c in enumerate(KRO_SOURCE_CHANNELS, 1) if c.strip()
        )
    if unavailable_sources:
        block2_text += '\n\nОграничения: Источник(и) %s недоступен(ы), данные по нему могут быть неполными в этом цикле.' % (', '.join(unavailable_sources))
    lines.append(block2_text)
    lines.extend(['', '***', ''])
    # Блок цикла мониторинга — чтобы любой человек сразу понял, что произошло в последнем запуске
    lines.extend([
        '2A. ЦИКЛ МОНИТОРИНГА',
        '',
        'Цикл мониторинга — %s' % (last_cycle_at or time_formatted or '—'),
        'Источники проверены: %s' % (
            ', '.join('%s (%s%s)' % (
                s.get('name', '—'),
                s.get('status', '—'),
                (', %s' % s.get('count', 0)) if s.get('count') is not None else ''
            ) for s in (sources_checked or [])) or '—'
        ),
        'Найдено новых каналов: %s' % (new_in_cycle if new_in_cycle is not None else new_scams_count),
        'Потери: %s' % ((str(total_losses_12h) + ' ₽') if (total_losses_12h or 0) > 0 else 'суммы в источниках не указаны'),
        'Следующий цикл: %s' % (next_cycle_at or '—'),
        '',
        '| Канал | Ссылка | Источник | Признаки риска | Статус |',
        '|-------|--------|----------|----------------|--------|'
    ])
    for r in (risk_rows or [])[:20]:
        risk_flags = r.get('behavior') or r.get('reasons_sentence') or 'есть жалобы / признаки риска'
        lines.append('| %s | %s | %s | %s | %s |' % (
            r.get('obj', '—'),
            r.get('link', '—'),
            r.get('source', '—'),
            str(risk_flags)[:140],
            r.get('status', '—')
        ))
    if not (risk_rows or []):
        lines.append('| (каналы за цикл не найдены) | — | — | — | — |')
    lines.extend(['', '***', ''])
    # Раздел 3 — Объекты и риск (8 колонок по ТЗ)
    table_8_headers = ['Объект / ссылка', 'Тип', 'Источник', 'Краткое описание', 'VIP / деньги', 'Жалобы / отзывы', 'Признаки риска (флаги)', 'Итоговый статус']
    lines.extend([
        '3. Объекты и риск',
        '',
        'Данные в таблице ниже — из разделов 2.1 и 2.2 (TGStat, Telega). Каждый объект со ссылкой на источник.',
        '',
        '| ' + ' | '.join(table_8_headers) + ' |',
        '|' + '--------|' * 8
    ])
    for r in risk_rows:
        row_cells = _build_row_8_cols(r)
        lines.append('| ' + ' | '.join(str(c)[:200] for c in row_cells) + ' |')
    if not risk_rows:
        lines.append('| (нет данных) | — | — | — | — | Жалоб за период не найдено. | — | — |')
    lines.extend(['', '***', ''])
    # Раздел 4 — Жалобы и потери (4 колонки)
    lines.extend([
        '4. Жалобы и потери за период',
        '',
        '| Объект | Количество людей | Жалобы / отзывы | Сумма потерь за период |',
        '|--------|-------------------|------------------|-------------------------|'
    ])
    for row in (complaints_rows or [])[:30]:
        ch = row.get('channel', '—')
        comp = row.get('complaints', 0)
        loss = row.get('losses', 0)
        links = (row.get('message_links') or 'ссылки на сообщения / скрин').strip() or '—'
        lines.append('| %s | %s | %s | %s ₽ |' % (ch, comp, links[:80], loss or 0))
    if not (complaints_rows or []):
        lines.append('| Жалоб за этот период не найдено | — | — | — |')
    lines.extend([
        '',
        '- Учитываются только жалобы за текущий 12‑часовой период.',
        '- Учитываются только жалобы с суммой и ссылкой/скрином.',
        '- Один человек учитывается один раз на объект.',
        '',
        '***',
        ''
    ])
    # Раздел 5 — Причины отнесения к риску (3 колонки: Объект, Оценка риска, Причины)
    lines.extend([
        '5. Причины отнесения к риску',
        '',
        '| Объект | Оценка риска | Причины |',
        '|--------|--------------|---------|'
    ])
    for r in risk_rows:
        itog = (r.get('risk_analysis') or {}).get('itog', '—')
        assessment = itog.replace(' РИСК', ' признаков риска') if itog != '—' else '—'
        reasons = r.get('reasons_sentence') or r.get('behavior', '—')
        lines.append('| %s | %s | %s |' % (r['obj'], assessment, reasons))
    if not risk_rows:
        lines.append('| (нет данных) | — | — |')
    lines.extend(['', '***', ''])
    # Раздел 6 — Итоги для сайта
    top3_with_people = []
    for i, t in enumerate((top3 or [])[:3]):
        if isinstance(t, dict):
            ch = t.get('channel') or t.get('name') or '—'
            s = t.get('sum', 0)
        else:
            ch = str(t or '—')
            s = 0
        n = complaints_by_ch.get((ch or '').strip(), 0) or 0
        top3_with_people.append((ch, s, n))
    lines.extend([
        '6. Итоги для сайта (поля интерфейса)',
        '',
        'Источник цифр — всё из таблиц этого документа:',
        '• new_scam_channels = число объектов в таблице «Объекты и риск» (рисковых за период).',
        '• losses_12h = сумма по таблице «Жалобы и потери» за период.',
        '• telegram_channels, courses_products = по типам в таблице «Объекты и риск».',
        '• top3_today = каналы/объекты по сумме риска и жалоб (топ‑3).',
        '',
        'Итоговые значения для сайта:',
        '',
        'new_scam_channels = %s' % new_scams_count,
        'losses_12h = %s' % (total_losses_12h or 0),
        'telegram_channels = %s' % telegram_channels_count,
        'courses_products = %s' % (courses or 0),
        '',
        'Топ‑3 за период:',
        ''
    ])
    for i, (ch, s, n) in enumerate(top3_with_people, 1):
        lines.append('%s. %s — %s ₽, %s человек.' % (i, ch, (s or 0), n))
    if not top3_with_people:
        lines.append('(нет)')
    lines.extend([
        '',
        'JSON для отправки:',
        '',
    ])
    lines.append(json.dumps({
        'new_scam_channels': new_scams_count,
        'losses_12h': total_losses_12h or 0,
        'telegram_channels': telegram_channels_count,
        'courses_products': courses or 0,
        'top3_today': top3_today
    }, ensure_ascii=False, indent=2))
    lines.extend([
        '',
        'Эти поля отправляются в интерфейс сайта и соответствуют блокам:',
        '- «Новый скам канал» — new_scam_channels',
        '- «Потери за 12 часов» — losses_12h',
        '- «Телеграм‑каналов» — telegram_channels',
        '- «Курсы/продукты» — courses_products',
        '- «Топ‑3 за сегодня» — top3_today',
        '',
        '***',
        ''
    ])
    # Раздел 7 — Чек‑лист и ограничения
    lines.extend([
        '7. Чек‑лист и ограничения',
        '',
        '□ У каждого объекта в таблице «Объекты и риск» есть рабочая кликабельная ссылка.',
        '□ Жалобы в таблице «Жалобы и потери» (столбец 6) относятся к текущему периоду; при отсутствии сумм указано «без указания суммы» или текст жалоб.',
        '□ Итоговая сумма losses_12h равна сумме по таблице «Жалобы и потери».',
        '□ Для всех объектов в статусе «в риске» заполнены столбцы «Признаки риска» и «Итоговый статус» в таблице «Объекты и риск».',
        '□ Топ‑3 входят в таблицу «Объекты и риск».',
        ''
    ])
    if nothing_found:
        lines.append('По заданным условиям новых объектов не найдено. Искали: TGStat (крипто/сигналы), Telega (каталог), чаты с жалобами (раздел 2). Жалоб за период нет. Данные не взяты из воздуха — результат проверки источников.')
        lines.append('')
    if report_url:
        lines.append(report_url)
    evidence_summary = {
        'tgstat_queries': _unique_list([(r.get('query') or '') for r in (new_tgstat or [])], limit=6),
        'telega_sources': _unique_list([(r.get('source_url') or '') for r in (telega_channels or [])], limit=3),
        'complaint_sources': _unique_list(sum([r.get('source_urls') or [] for r in (complaints_rows or [])], []), limit=5),
        'web_search_urls': WEB_SEARCH_URLS[:],
        'risk_row_links': _unique_list(sum([r.get('evidence_links') or [] for r in (risk_rows or [])], []), limit=10),
    }
    structured_data = {
        'risk_rows': risk_rows,
        'complaints_rows': (complaints_rows or [])[:30],
        'top3_with_people': top3_with_people,
        'new_scams_count': new_scams_count,
        'total_losses_12h': total_losses_12h or 0,
        'telegram_count': telegram_channels_count,
        'courses': courses or 0,
        'top3_today': top3_today,
        'live_lines': live_lines[-LIVE_LOG_MAX_LINES:] if live_lines else [],
        'nothing_found': nothing_found,
        'period_start': period_start or collect_time_msk,
        'period_end': period_end or collect_time_msk,
        'time_formatted': time_formatted,
        'report_url': report_url,
        'unavailable_sources': unavailable_sources or [],
        'evidence_summary': evidence_summary,
    }
    return '\n'.join(lines), structured_data


def _get_table_cell_indices(body, at_index):
    """Найти таблицу с startIndex at_index и вернуть список (row_idx, col_idx, start_index) для каждой ячейки.
    Если API не возвращает startIndex в ячейках (пустая таблица), считаем индексы от начала таблицы.
    """
    for el in body.get('content', []):
        if el.get('startIndex') != at_index or 'table' not in el:
            continue
        table_start = el.get('startIndex', at_index)
        rows = el['table'].get('tableRows', [])
        ncols = len(rows[0].get('tableCells', [])) if rows else 0
        out = []
        for ri, row in enumerate(rows):
            for ci, cell in enumerate(row.get('tableCells', [])):
                si = None
                for c in cell.get('content', []):
                    si = c.get('startIndex')
                    if si is not None:
                        break
                    for pe in c.get('paragraph', {}).get('elements', []):
                        si = pe.get('startIndex')
                        if si is not None:
                            break
                    if si is not None:
                        break
                if si is None and ncols:
                    # Пустые ячейки после insertTable могут не содержать startIndex в ответе API.
                    # Считаем позицию: после начала таблицы каждая ячейка — параграф (1 символ).
                    si = table_start + 1 + (ri * ncols + ci)
                if si is not None:
                    out.append((ri, ci, si))
        return out
    return []


def _get_table_cell_ranges(body, table_el):
    """По элементу таблицы вернуть (rows, cols, list of (ri, ci, start_index, end_index)) для каждой ячейки.
    Если API не возвращает startIndex/endIndex в ячейках (пустые таблицы), считаем индексы от начала таблицы.
    """
    rows = table_el.get('table', {}).get('tableRows', [])
    nrows = len(rows)
    ncols = len(rows[0].get('tableCells', [])) if rows else 0
    table_start = table_el.get('startIndex', 0)
    out = []
    for ri, row in enumerate(rows):
        for ci, cell in enumerate(row.get('tableCells', [])):
            si, ei = None, None
            for c in cell.get('content', []):
                if si is None:
                    si = c.get('startIndex')
                ei = c.get('endIndex')
                if ei is None and 'paragraph' in c:
                    for pe in c.get('paragraph', {}).get('elements', []):
                        if pe.get('startIndex') is not None:
                            if si is None:
                                si = pe['startIndex']
                            ei = pe.get('endIndex') or (pe['startIndex'] + 1)
                if ei is None and si is not None:
                    ei = si + 1
            if si is None and ncols > 0:
                # Пустые ячейки часто без startIndex в API — считаем позицию от начала таблицы
                si = table_start + 1 + (ri * ncols + ci)
                ei = si + 1
            if si is not None and ei is not None:
                out.append((ri, ci, si, ei))
    return nrows, ncols, out


def _doc_text_preview(doc, max_chars=4000):
    """Собрать начало текста документа из параграфов (для проверки формата)."""
    parts = []
    n = 0
    for el in doc.get('body', {}).get('content', []):
        if n >= max_chars:
            break
        if 'paragraph' not in el:
            continue
        for pe in el.get('paragraph', {}).get('elements', []):
            text = (pe.get('textRun') or {}).get('content', '')
            parts.append(text)
            n += len(text)
            if n >= max_chars:
                break
    return ''.join(parts)[:max_chars]


def _doc_looks_like_spec(doc):
    """True, если документ в формате спецификации (Sources and Data из TXT), а не от Python."""
    preview = _doc_text_preview(doc)
    return (
        'Sources and Data' in preview
        or '0.4 Итоги для сайта' in preview
        or '3.1. Столбцы (8 штук)' in preview
    )


def _discover_tables_in_doc(doc):
    """Найти в документе все таблицы. Возвращает список dict: startIndex, rows, cols, cells [(ri,ci,start,end)]."""
    result = []
    for el in doc.get('body', {}).get('content', []):
        if 'table' not in el:
            continue
        idx = el.get('startIndex', 0)
        nrows, ncols, cells = _get_table_cell_ranges(doc.get('body', {}), el)
        result.append({'startIndex': idx, 'rows': nrows, 'cols': ncols, 'cells': cells})
    return result


def _fill_existing_tables(service, doc_id, data):
    """Заполнить главную таблицу 8 столбцов в конце документа. Строку заголовков не трогаем."""
    risk_rows = data.get('risk_rows') or []
    doc = service.documents().get(documentId=doc_id).execute()
    tables = _discover_tables_in_doc(doc)
    if not tables:
        return False
    # Ищем одну таблицу с 8 колонками (предпочтительно 8, иначе 7 или 9)
    t8 = None
    for t in tables:
        c = t['cols']
        if c == 8:
            t8 = t
            break
    if not t8:
        for t in tables:
            if t['cols'] in (7, 9):
                t8 = t
                break
    if not t8 or not t8['cells']:
        return False
    ncols8 = min(t8['cols'], 8)
    data_rows = []
    for r in risk_rows:
        data_rows.append(_build_row_8_cols(r))
    if not risk_rows:
        data_rows.append(['(нет данных)', '—', '—', '—', '—', 'Жалоб за период не найдено.', '—', '—'])
    cells_by_rc = {(ri, ci): (si, ei) for (ri, ci, si, ei) in t8['cells']}
    replacements = []
    for ri in range(len(data_rows)):
        for ci in range(ncols8):
            r_idx = ri + 1
            if (r_idx, ci) not in cells_by_rc:
                continue
            si, ei = cells_by_rc[(r_idx, ci)]
            text = str(data_rows[ri][ci])[:500]
            replacements.append((si, ei, text))
    if not replacements:
        return False
    print('Sources doc: таблица в конце документа (8 столбцов) — заполняю ячейки.', file=sys.stderr)
    replacements.sort(key=lambda x: -x[0])
    batch = []
    for si, ei, text in replacements:
        # В пустых ячейках таблицы deleteContentRange может давать 400; вставляем текст без удаления
        batch.append({'insertText': {'location': {'index': si}, 'text': text}})
    try:
        service.documents().batchUpdate(documentId=doc_id, body={'requests': batch}).execute()
    except Exception as e:
        print('Sources doc: ошибка заполнения ячеек: %s' % e, file=sys.stderr)
        return False

    # Сделать кликабельными ссылки в первом столбце (Объект/ссылка): по клику переход в канал Telegram
    try:
        doc = service.documents().get(documentId=doc_id).execute()
        tables = _discover_tables_in_doc(doc)
        t8 = next((t for t in tables if t['cols'] == 8), None)
        if t8 and t8['cells'] and risk_rows:
            link_requests = []
            for (ri, ci, si, ei) in t8['cells']:
                if ci != 0 or ri < 1 or ri > len(risk_rows):
                    continue
                link = (risk_rows[ri - 1].get('link') or '').strip()
                if not link or 't.me/' not in link:
                    continue
                if not link.startswith('http'):
                    link = 'https://t.me/' + link.replace('https://t.me/', '').replace('t.me/', '').lstrip('/')
                link_requests.append({'updateTextStyle': {
                    'range': {'startIndex': si, 'endIndex': ei},
                    'textStyle': {'link': {'url': link}},
                    'fields': 'link',
                }})
            if link_requests:
                service.documents().batchUpdate(documentId=doc_id, body={'requests': link_requests}).execute()
                print('Sources doc: в столбце «Объект/ссылка» добавлены кликабельные ссылки на каналы.', file=sys.stderr)
    except Exception as e:
        print('Sources doc: кликабельные ссылки (не критично): %s' % e, file=sys.stderr)

    return True


def _build_sources_doc_with_tables(service, doc_id, data):
    """Собрать документ с нативными таблицами Google Docs и кликабельными ссылками в колонке Объект."""
    risk_rows = data.get('risk_rows') or []
    complaints_rows = data.get('complaints_rows') or []
    live_lines = data.get('live_lines') or []
    time_fmt = data.get('time_formatted', '')
    period_start = data.get('period_start', '')
    period_end = data.get('period_end', '')
    block2 = BLOCK2_SOURCES.strip()
    if KRO_SOURCE_CHANNELS:
        block2 += '\n\nЧаты с жалобами (источники за 12 ч):\n' + '\n'.join(
            '%s. %s' % (i, c.strip()) for i, c in enumerate(KRO_SOURCE_CHANNELS, 1) if c.strip()
        )
    unavail = data.get('unavailable_sources') or []
    if unavail:
        block2 += '\n\nОграничения: Источник(и) %s недоступен(ы), данные по нему могут быть неполными в этом цикле.' % (', '.join(unavail))
    report_url = data.get('report_url') or ''
    nothing_found = data.get('nothing_found', False)

    period_label, formed_label = _format_doc_header(period_start, period_end, time_fmt)
    intro = (
        'СКАМ‑МОНИТОРИНГ | Source & Data\n'
        '%s\n'
        '%s\n\n'
        'В этом документе: откуда берутся цифры, факты и ссылки (раздел 2). День: с 00:00 до 23:55 MSK. Память событий хранится за последние 14 дней.\n\n'
        '***\n\n'
        'Память за последние 14 дней:\n\n'
        '%s\n\n***\n\n%s\n\n***\n\n'
    ) % (period_label, formed_label, LIVE_LOG_PLACEHOLDER, block2)
    intro += '3. Объекты и риск\n\n'
    intro += 'Данные в таблице ниже — из разделов 2.1 и 2.2 (TGStat, Telega). Каждый объект со ссылкой на источник.\n\n'

    # Удалить контент и вставить вводный текст
    doc = service.documents().get(documentId=doc_id).execute()
    body = doc.get('body', {})
    content = body.get('content', [])
    end_index = content[-1].get('endIndex', 2) if content else 2
    if end_index <= 1:
        end_index = 2
    requests = []
    if end_index > 2:
        requests.append({'deleteContentRange': {'range': {'startIndex': 1, 'endIndex': max(2, end_index - 1)}}})
    requests.append({'insertText': {'location': {'index': 1}, 'text': intro}})
    service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
    idx = 1 + len(intro)

    # Сделать кликабельными все https-ссылки во вводном тексте (раздел 2)
    for m in re.finditer(r'https://[^\s\)\]]+', intro):
        start_i, end_i = 1 + m.start(), 1 + m.end()
        url = m.group(0).rstrip('.,;:')
        try:
            service.documents().batchUpdate(documentId=doc_id, body={'requests': [{
                'updateTextStyle': {'range': {'startIndex': start_i, 'endIndex': end_i}, 'textStyle': {'link': {'url': url}}, 'fields': 'link'}
            }]}).execute()
        except Exception:
            pass

    # Одна главная таблица: 8 столбцов (Объект/ссылка, Тип, Источник, Краткое описание, VIP/деньги, Жалобы/отзывы, Признаки риска, Итоговый статус)
    TABLE_8_HEADERS = ['Объект / ссылка', 'Тип', 'Источник', 'Краткое описание', 'VIP / деньги', 'Жалобы / отзывы', 'Признаки риска (флаги)', 'Итоговый статус']

    rows_main = 1 + len(risk_rows) if risk_rows else 2
    requests = [{'insertTable': {'rows': rows_main, 'columns': 8, 'location': {'index': idx}}}]
    service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
    doc = service.documents().get(documentId=doc_id).execute()
    body = doc.get('body', {})
    cells = _get_table_cell_indices(body, idx)
    if cells:
        cell_texts = [TABLE_8_HEADERS]
        for r in risk_rows:
            cell_texts.append(_build_row_8_cols(r))
        if not risk_rows:
            cell_texts.append(['(нет данных)', '—', '—', '—', '—', 'Жалоб за период не найдено.', '—', '—'])
        cells_by_row = sorted(cells, key=lambda x: (x[0], x[1]))
        flat = [str(t)[:500] for row in cell_texts for t in row]
        indexed = [(cells_by_row[i][2], flat[i], cells_by_row[i][0], cells_by_row[i][1]) for i in range(min(len(cells_by_row), len(flat)))]
        for si, text, ri, ci in sorted(indexed, key=lambda x: -x[0]):
            service.documents().batchUpdate(documentId=doc_id, body={'requests': [{'insertText': {'location': {'index': si}, 'text': text}}]}).execute()
            if ci == 0 and ri > 0 and ri <= len(risk_rows) and risk_rows[ri - 1].get('link'):
                url = risk_rows[ri - 1]['link']
                if not url.startswith('http'):
                    url = 'https://' + url
                try:
                    service.documents().batchUpdate(documentId=doc_id, body={'requests': [{
                        'updateTextStyle': {'range': {'startIndex': si, 'endIndex': si + len(text)}, 'textStyle': {'link': {'url': url}}, 'fields': 'link'}
                    }]}).execute()
                except Exception:
                    pass
            if ri == 0:
                try:
                    service.documents().batchUpdate(documentId=doc_id, body={'requests': [{
                        'updateTextStyle': {'range': {'startIndex': si, 'endIndex': si + len(text)}, 'textStyle': {'bold': True}, 'fields': 'bold'}
                    }]}).execute()
                except Exception:
                    pass
        try:
            service.documents().batchUpdate(documentId=doc_id, body={'requests': [{
                'updateTableCellStyle': {
                    'tableCellStyle': {'backgroundColor': {'color': {'rgbColor': {'red': 0.9, 'green': 0.9, 'blue': 0.9}}}},
                    'fields': 'backgroundColor',
                    'tableRange': {
                        'tableCellLocation': {'tableStartLocation': {'index': idx}, 'rowIndex': 0, 'columnIndex': 0},
                        'rowSpan': 1,
                        'columnSpan': 8
                    }
                }
            }]}).execute()
        except Exception:
            pass
    doc = service.documents().get(documentId=doc_id).execute()
    for el in doc.get('body', {}).get('content', []):
        if el.get('startIndex') == idx and 'table' in el:
            idx = el.get('endIndex', idx + 1)
            break

    # Блок 4 и 5 — только текст (данные в основной таблице выше)
    block4_5 = (
        '\n\n***\n\n4. Жалобы и потери за период\n\n'
        'См. столбец «Жалобы / отзывы» в основной таблице выше. Если жалоб нет — указано «Жалоб за период не найдено».\n\n'
        '***\n\n5. Причины отнесения к риску\n\n'
        'См. столбцы «Признаки риска (флаги)» и «Итоговый статус» в основной таблице выше.\n\n'
    )
    requests = [{'insertText': {'location': {'index': idx}, 'text': block4_5}}]
    service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
    idx += len(block4_5)

    # Блоки 6 и 7: цифры один раз, без повторов
    n_scams = data.get('new_scams_count', 0)
    losses = data.get('total_losses_12h', 0)
    tg_count = data.get('telegram_count', 0)
    courses = data.get('courses', 0)
    block6_7 = (
        '\n\n***\n\n6. Итоги для сайта\n\n'
        'new_scam_channels = %s\nlosses_12h = %s\ntelegram_channels = %s\ncourses_products = %s\n\n'
        'Топ‑3:\n\n'
    ) % (n_scams, losses, tg_count, courses)
    for i, (ch, s, n) in enumerate(data.get('top3_with_people') or [], 1):
        block6_7 += '%s. %s — %s ₽, %s чел.\n' % (i, ch, s or 0, n)
    if not data.get('top3_with_people'):
        block6_7 += '(нет)\n'
    block6_7 += '\n***\n\n7. Чек‑лист\n\n'
    block6_7 += '□ Ссылки в столбце 1 рабочие. □ Жалобы (столбец 6) за период. □ Признаки риска и статус (7–8) заполнены. □ Топ‑3 из основной таблицы.\n\n'
    if nothing_found:
        block6_7 += 'По заданным условиям новых объектов не найдено. Искали: TGStat, Telega, чаты с жалобами (раздел 2). Жалоб за период нет. Данные не взяты из воздуха. При недоступности источника см. блок «Ограничения» выше.\n\n'
    if report_url:
        block6_7 += report_url
    requests = [{'insertText': {'location': {'index': idx}, 'text': block6_7}}]
    service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()


def _get_sources_doc_text(report_title=None, report_url=None):
    """Текст для документа «Источники и данные» — откуда цифры и все ссылки."""
    lines = [
        'ОТКУДА БЕРУТСЯ ЦИФРЫ И ОТЗЫВЫ — ИСТОЧНИКИ И ССЫЛКИ',
        '',
        'Этот документ обновляется автоматически. Здесь все источники данных для сайта и прямые ссылки.',
        '',
        '=== 1. ОСНОВНЫЕ ЦИФРЫ (главная страница) ===',
        '',
        '• Таблица «Отчёты» (Google Sheets) — приоритет: каналы за день, потери, топ-3, жалобы за 24 ч.',
        '• Резерв (если таблица пуста):',
        '  Vklader (чёрный список): https://vklader.com/blacklist-telegram/',
        '  TGRev (скам-каналы):     https://tgrev.ru/scam-telegram-channel',
        '',
        '=== 2. БЛОК «ЗА 12 ЧАСОВ» ===',
        '',
        '• TGStat — поиск каналов «криптовалюта», новые за 14 дней.',
        '  Сайт: https://tgstat.ru',
        '  API:  https://tgstat.ru/docs/ru/api',
        '',
        '• Telega.io — каталог крипто-каналов:',
        '  https://telega.io/catalog/cryptocurrencies',
        '',
        '• Telegram — чаты из KRO_SOURCE_CHANNELS, сообщения за 12 ч (жалобы, суммы).',
        '  https://telegram.org',
        '',
        '• Лист «Отчёты» — жалобы за 12 ч; ≥2 жалобы по каналу → статус «Скам».',
        '',
        '=== 3. ПОСЛЕДНИЙ АВТООТЧЁТ (за 12 ч) ===',
        ''
    ]
    if report_title and report_url:
        lines.append(report_title)
        lines.append(report_url)
    else:
        lines.append('(отчёт появится после следующего запуска скрипта в 01:00 или 13:00 MSK)')
    return '\n'.join(lines)


def _find_text_ranges_in_doc(service, doc_id, pattern):
    """Найти в документе все вхождения regex pattern; вернуть список (startIndex, endIndex). Индексы 1-based для body."""
    import re
    try:
        doc = service.documents().get(documentId=doc_id).execute()
        body = doc.get('body', {})
        content = body.get('content', [])
        # Собираем текст по порядку и накапливаем startIndex (1-based), т.к. API может по-разному отдавать индексы
        segments = []
        run_index = 1
        for elem in content:
            if 'paragraph' not in elem:
                continue
            for pe in elem.get('paragraph', {}).get('elements', []):
                tr = pe.get('textRun', {})
                if not tr:
                    continue
                text = tr.get('content', '')
                segments.append((run_index, text))
                run_index += len(text)
        full = ''.join(s[1] for s in segments)
        ranges = []
        for m in re.finditer(pattern, full):
            start_in_full = m.start()
            end_in_full = m.end()
            offset = 0
            seg_start_idx = None
            seg_end_idx = None
            for seg_start, seg_text in segments:
                if offset <= start_in_full < offset + len(seg_text):
                    seg_start_idx = seg_start + (start_in_full - offset)
                if offset < end_in_full <= offset + len(seg_text):
                    seg_end_idx = seg_start + (end_in_full - offset)
                    break
                offset += len(seg_text)
            if seg_start_idx is not None and seg_end_idx is not None:
                ranges.append((seg_start_idx, seg_end_idx))
        return ranges
    except Exception as e:
        print('Sources doc: поиск времени в документе: %s' % e, file=sys.stderr)
        return []

def _apply_italic_to_times_in_doc(service, doc_id):
    """Выделить курсивом все вхождения времени (HH:MM и т.п.) в документе."""
    ranges = _find_text_ranges_in_doc(service, doc_id, r'\d{1,2}:\d{2}')
    if not ranges:
        return
    try:
        requests = [
            {'updateTextStyle': {
                'range': {'startIndex': s, 'endIndex': e, 'segmentId': ''},
                'textStyle': {'italic': True},
                'fields': 'italic'
            }}
            for s, e in ranges[:60]
        ]
        service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
        print('Sources doc: курсив применён к %s фрагментам времени' % len(requests), file=sys.stderr)
    except Exception as e:
        print('Sources doc: курсив для времени: %s' % e, file=sys.stderr)

def _apply_sources_doc_visual_style(service, doc_id):
    """Сделать документ визуально чище: заголовки, интервалы, акценты на итогах."""
    def _text_req(start_i, end_i, style, fields):
        return {
            'updateTextStyle': {
                'range': {'startIndex': start_i, 'endIndex': end_i},
                'textStyle': style,
                'fields': fields
            }
        }

    def _para_req(start_i, end_i, style, fields):
        return {
            'updateParagraphStyle': {
                'range': {'startIndex': start_i, 'endIndex': end_i},
                'paragraphStyle': style,
                'fields': fields
            }
        }

    requests = []

    title_ranges = _find_text_ranges_in_doc(service, doc_id, r'(?m)^СКАМ‑МОНИТОРИНГ \| Source & Data$')
    for start_i, end_i in title_ranges[:1]:
        requests.append(_text_req(start_i, end_i, {
            'bold': True,
            'fontSize': {'magnitude': 16, 'unit': 'PT'}
        }, 'bold,fontSize'))
        requests.append(_para_req(start_i, end_i, {
            'spaceBelow': {'magnitude': 10, 'unit': 'PT'}
        }, 'spaceBelow'))

    header_line_patterns = [
        r'(?m)^Период: .+$',
        r'(?m)^Время формирования: .+$',
        r'(?m)^Память за последние 14 дней:$',
    ]
    for pattern in header_line_patterns:
        for start_i, end_i in _find_text_ranges_in_doc(service, doc_id, pattern)[:5]:
            requests.append(_text_req(start_i, end_i, {
                'bold': True,
                'fontSize': {'magnitude': 11, 'unit': 'PT'}
            }, 'bold,fontSize'))

    section_patterns = [
        r'(?m)^2\. Откуда берутся данные: факты и ссылки$',
        r'(?m)^3\. Объекты и риск$',
        r'(?m)^4\. Жалобы и потери за период$',
        r'(?m)^5\. Причины отнесения к риску$',
        r'(?m)^6\. Итоги для сайта(?: \(поля интерфейса\))?$',
        r'(?m)^7\. Чек.?лист(?: и ограничения)?$',
        r'(?m)^2\.1\. .+$',
        r'(?m)^2\.2\. .+$',
    ]
    for pattern in section_patterns:
        for start_i, end_i in _find_text_ranges_in_doc(service, doc_id, pattern)[:10]:
            requests.append(_text_req(start_i, end_i, {
                'bold': True,
                'fontSize': {'magnitude': 12, 'unit': 'PT'}
            }, 'bold,fontSize'))
            requests.append(_para_req(start_i, end_i, {
                'spaceAbove': {'magnitude': 10, 'unit': 'PT'},
                'spaceBelow': {'magnitude': 4, 'unit': 'PT'}
            }, 'spaceAbove,spaceBelow'))

    emphasis_patterns = [
        r'(?m)^Источник цифр — всё из таблиц этого документа:$',
        r'(?m)^Итоговые значения для сайта:$',
        r'(?m)^Топ‑3 за период:$',
        r'(?m)^JSON для отправки:$',
        r'(?m)^Эти поля отправляются в интерфейс сайта и соответствуют блокам:$',
        r'(?m)^Топ‑3:$',
    ]
    for pattern in emphasis_patterns:
        for start_i, end_i in _find_text_ranges_in_doc(service, doc_id, pattern)[:10]:
            requests.append(_text_req(start_i, end_i, {'bold': True}, 'bold'))

    metrics_patterns = [
        r'(?m)^new_scam_channels = .+$',
        r'(?m)^losses_12h = .+$',
        r'(?m)^telegram_channels = .+$',
        r'(?m)^courses_products = .+$',
    ]
    for pattern in metrics_patterns:
        for start_i, end_i in _find_text_ranges_in_doc(service, doc_id, pattern)[:10]:
            requests.append(_text_req(start_i, end_i, {
                'bold': True,
                'fontSize': {'magnitude': 11, 'unit': 'PT'}
            }, 'bold,fontSize'))

    top3_ranges = _find_text_ranges_in_doc(service, doc_id, r'(?m)^\d+\. .+ — .+$')
    for start_i, end_i in top3_ranges[:10]:
        requests.append(_text_req(start_i, end_i, {'bold': True}, 'bold'))

    if not requests:
        return
    try:
        service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
        print('Sources doc: применено визуальное оформление заголовков и итогов.', file=sys.stderr)
    except Exception as e:
        print('Sources doc: визуальное оформление: %s' % e, file=sys.stderr)

def _update_sources_doc_intro(service, doc_id, data):
    """Обновить в начале документа блок заголовка (Период, Время формирования), чтобы изменения всегда попадали в документ даже при заполнении таблиц."""
    period_start = data.get('period_start', '')
    period_end = data.get('period_end', '')
    time_fmt = data.get('time_formatted', '')
    period_label, formed_label = _format_doc_header(period_start, period_end, time_fmt)
    new_header = 'СКАМ‑МОНИТОРИНГ | Source & Data\n%s\n%s\n\n' % (period_label, formed_label)
    ranges = _find_text_ranges_in_doc(service, doc_id, re.escape('В этом документе'))
    if not ranges:
        return
    end_repl = ranges[0][0]
    if end_repl <= 1:
        return
    try:
        service.documents().batchUpdate(documentId=doc_id, body={'requests': [
            {'deleteContentRange': {'range': {'startIndex': 1, 'endIndex': end_repl}}},
            {'insertText': {'location': {'index': 1}, 'text': new_header}}
        ]}).execute()
        print('Sources doc: обновлён заголовок (Период, Время формирования).', file=sys.stderr)
    except Exception as e:
        print('Sources doc: обновление заголовка: %s' % e, file=sys.stderr)


def update_sources_google_doc(doc_id, doc_text, structured_data=None):
    """Пишет в документ «Источники и данные». Если передан structured_data — нативные таблицы и кликабельные ссылки; иначе один insertText doc_text. Время выделяет курсивом."""
    if not (doc_id and doc_id.strip()):
        return None
    doc_id = doc_id.strip()
    creds = None
    json_str = os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON')
    json_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
    if json_str:
        try:
            from google.oauth2 import service_account
            creds = service_account.Credentials.from_service_account_info(json.loads(json_str))
        except Exception:
            pass
    if not creds and json_path and os.path.isfile(json_path):
        try:
            from google.oauth2 import service_account
            creds = service_account.Credentials.from_service_account_file(json_path)
        except Exception:
            pass
    # Автопоиск файла ключа: папка скрипта, текущая папка, backend/kro-worker от корня
    if not creds:
        search_dirs = [
            SCRIPT_DIR,
            os.getcwd(),
            os.path.join(BACKEND_DIR, 'kro-worker'),
        ]
        for dir_path in search_dirs:
            if not dir_path:
                continue
            for name in ('credentials.json', 'kro-google-credentials.json'):
                path = os.path.join(dir_path, name)
                if os.path.isfile(path):
                    try:
                        from google.oauth2 import service_account
                        creds = service_account.Credentials.from_service_account_file(path)
                        break
                    except Exception as e:
                        print('Sources doc: не удалось прочитать %s: %s' % (path, e), file=sys.stderr)
            if creds:
                break
    if not creds:
        print('Sources doc: нет учётных данных. Проверьте: файл credentials.json в %s или в текущей папке.' % SCRIPT_DIR, file=sys.stderr)
        return None
    try:
        from googleapiclient.discovery import build
        service = build('docs', 'v1', credentials=creds)
    except Exception as e:
        print('Google Docs (sources) build: %s' % e, file=sys.stderr)
        return None
    if structured_data:
        try:
            filled = _fill_existing_tables(service, doc_id, structured_data)
            if filled:
                print('Sources doc: заполнена основная таблица (8 столбцов).', file=sys.stderr)
            else:
                doc = service.documents().get(documentId=doc_id).execute()
                if _doc_looks_like_spec(doc):
                    print('Sources doc: документ в формате спецификации; таблица 8 колонок не найдена.', file=sys.stderr)
                    print('  Добавьте в раздел 3 таблицу «Объекты и риск»: 8 столбцов, 1 строка заголовков + 20 строк.', file=sys.stderr)
                    print('  Заголовки: Объект / ссылка, Тип, Источник, Краткое описание, VIP / деньги, Жалобы / отзывы, Признаки риска (флаги), Итоговый статус', file=sys.stderr)
                    print('  Затем снова запустите: python3 update_sources_doc_once.py', file=sys.stderr)
                else:
                    print('Sources doc: таблица 8 колонок не найдена — пересборку с нуля не делаем, чтобы не затереть блок «События за период» (update_live_log_5min).', file=sys.stderr)
                # Не вызываем _build_sources_doc_with_tables — он удаляет весь документ и затирает блок лога каждые 5 мин; обновляем только заголовок
            _update_sources_doc_intro(service, doc_id, structured_data)
            _apply_italic_to_times_in_doc(service, doc_id)
            _apply_sources_doc_visual_style(service, doc_id)
            url = 'https://docs.google.com/document/d/' + doc_id + '/edit'
            print('Updated sources doc (таблицы): %s' % url, file=sys.stderr)
            return url
        except Exception as e:
            print('Sources doc (таблицы): %s — подставляю текст.' % e, file=sys.stderr)
    text = doc_text
    try:
        doc = service.documents().get(documentId=doc_id).execute()
        body = doc.get('body', {})
        content = body.get('content', [])
        end_index = 2
        if content:
            end_index = content[-1].get('endIndex', 2)
        if end_index <= 1:
            end_index = 2
        requests = []
        if end_index > 2:
            # Сначала удаляем весь контент (до end_index; при ошибке API — до end_index-1)
            end_delete = max(2, end_index - 1)
            requests.append({
                'deleteContentRange': {
                    'range': {'startIndex': 1, 'endIndex': end_delete}
                }
            })
        requests.append({
            'insertText': {
                'location': {'index': 1},
                'text': text
            }
        })
        service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
        # Удалить хвост старого контента (один символ после вставки), если остался
        new_len = len(text) + 1
        try:
            doc2 = service.documents().get(documentId=doc_id).execute()
            body2 = doc2.get('body', {})
            content2 = body2.get('content', [])
            end2 = content2[-1].get('endIndex', 2) if content2 else 2
            if end2 > new_len + 1:
                service.documents().batchUpdate(documentId=doc_id, body={'requests': [{
                    'deleteContentRange': {'range': {'startIndex': new_len, 'endIndex': end2}}
                }]}).execute()
        except Exception:
            pass
        _apply_italic_to_times_in_doc(service, doc_id)
        _apply_sources_doc_visual_style(service, doc_id)
        url = 'https://docs.google.com/document/d/' + doc_id + '/edit'
        print('Updated sources doc: %s' % url, file=sys.stderr)
        return url
    except Exception as e:
        print('Update sources doc: %s' % e, file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return None


# --- Google Docs: создать отчёт ---
def create_google_doc_report(title, new_channels_rows, complaints_rows, summary_text, report_number):
    """Создаёт Google Doc с заголовком, таблицами и блоком «На сайт». Возвращает (doc_id, url) или (None, None)."""
    creds = None
    json_str = os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON')
    json_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
    if json_str:
        try:
            from google.oauth2 import service_account
            creds = service_account.Credentials.from_service_account_info(json.loads(json_str))
        except Exception:
            pass
    if not creds and json_path and os.path.isfile(json_path):
        try:
            from google.oauth2 import service_account
            creds = service_account.Credentials.from_service_account_file(json_path)
        except Exception:
            pass
    if not creds:
        for name in ('credentials.json', 'kro-google-credentials.json'):
            path = os.path.join(SCRIPT_DIR, name)
            if os.path.isfile(path):
                try:
                    from google.oauth2 import service_account
                    creds = service_account.Credentials.from_service_account_file(path)
                    break
                except Exception:
                    pass
    if not creds:
        return None, None
    try:
        from googleapiclient.discovery import build
        service = build('docs', 'v1', credentials=creds)
    except Exception as e:
        print('Google Docs build: %s' % e, file=sys.stderr)
        return None, None
    try:
        body = {'title': title}
        doc = service.documents().create(body=body).execute()
        doc_id = doc.get('documentId')
        if not doc_id:
            return None, None
        requests = []
        idx = 1
        # Заголовок уже в title. Вставляем текст "НА САЙТ" и summary
        requests.append({
            'insertText': {
                'location': {'index': idx},
                'text': '\n\n=== НА САЙТ ===\n' + summary_text + '\n\n'
            }
        })
        idx += len('\n\n=== НА САЙТ ===\n' + summary_text + '\n\n')
        requests.append({
            'insertText': {
                'location': {'index': idx},
                'text': '=== НОВЫЕ КАНАЛЫ ===\nКанал | Дата | Рост | VIP | Ссылка\n'
            }
        })
        idx += len('=== НОВЫЕ КАНАЛЫ ===\nКанал | Дата | Рост | VIP | Ссылка\n')
        for row in new_channels_rows[:15]:
            line = ' | '.join(str(row.get(k, '—')) for k in ['channel', 'date', 'growth', 'vip', 'link']) + '\n'
            requests.append({'insertText': {'location': {'index': idx}, 'text': line}})
            idx += len(line)
        requests.append({
            'insertText': {
                'location': {'index': idx},
                'text': '\n=== ЖАЛОБЫ ===\nКанал | Жалоб | Потери | Статус\n'
            }
        })
        idx += len('\n=== ЖАЛОБЫ ===\nКанал | Жалоб | Потери | Статус\n')
        for row in complaints_rows[:20]:
            line = ' | '.join(str(row.get(k, '—')) for k in ['channel', 'complaints', 'losses', 'status']) + '\n'
            requests.append({'insertText': {'location': {'index': idx}, 'text': line}})
            idx += len(line)
        if requests:
            service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
        url = 'https://docs.google.com/document/d/' + doc_id + '/edit'
        return doc_id, url
    except Exception as e:
        err_str = str(e)
        if '403' in err_str and 'permission' in err_str.lower():
            print('Создание нового отчёта пропущено: у сервисного аккаунта нет прав на создание документов (403). Документ «Источники и данные» обновляется отдельно.', file=sys.stderr)
        else:
            print('Google Doc create: %s' % e, file=sys.stderr)
        return None, None


# URL по умолчанию для отправки данных на сайт (можно переопределить через KRO_SITE_UPDATE_URL в .env)
DEFAULT_SITE_UPDATE_URL = 'https://crypto-academy-pro.onrender.com/api/kro/update'


def _send_to_site(payload):
    """Отправить payload на сайт (POST KRO_SITE_UPDATE_URL). Возвращает True при успехе."""
    site_url = (os.environ.get('KRO_SITE_UPDATE_URL') or DEFAULT_SITE_UPDATE_URL).strip()
    if not site_url:
        print('KRO_SITE_UPDATE_URL не задан — отправка на сайт пропущена.', file=sys.stderr)
        return False
    try:
        import urllib.request
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(site_url, data=data, method='POST', headers={'Content-Type': 'application/json'})
        secret = os.environ.get('KRO_SITE_UPDATE_SECRET', '').strip()
        if secret:
            req.add_header('Authorization', 'Bearer %s' % secret)
        with urllib.request.urlopen(req, timeout=15) as resp:
            if 200 <= resp.getcode() < 300:
                print('Данные отправлены на сайт: %s' % site_url, file=sys.stderr)
                return True
            print('POST %s: код %s' % (site_url, resp.getcode()), file=sys.stderr)
            return False
    except Exception as e:
        print('POST на сайт failed: %s' % e, file=sys.stderr)
        return False


def _run_publish_only():
    """Режим publish: прочитать kro-12h-stats.json и отправить на сайт (12:00 и 00:00 MSK)."""
    if not os.path.isfile(OUTPUT_JSON):
        print('MODE=publish: файл %s не найден. Сначала запустите сбор (11:00 или 23:00 MSK).' % OUTPUT_JSON, file=sys.stderr)
        return
    try:
        with open(OUTPUT_JSON, 'r', encoding='utf-8') as f:
            out = json.load(f)
    except Exception as e:
        print('MODE=publish: не удалось прочитать %s: %s' % (OUTPUT_JSON, e), file=sys.stderr)
        return
    now_utc = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    top3_today = [(t.get('channel') or t.get('name') or '—') for t in (out.get('top3') or out.get('top3_today') or [])[:3]]
    payload = {
        'timestamp': out.get('timestamp') or now_utc,
        'new_scam_channels': out.get('new_scam_channels', out.get('new_scams', 0)),
        'losses_12h': out.get('losses_12h', 0),
        'telegram_channels': out.get('telegram_channels', 0),
        'courses_products': out.get('courses_products', out.get('courses', 0)),
        'top3_today': top3_today,
        'top3': out.get('top3', []),
        'victims_12h': out.get('victims_12h', 0),
        'risk_rows': out.get('risk_rows', []),
        'complaints_rows': out.get('complaints_rows', []),
        'evidence_summary': out.get('evidence_summary', {}),
        'report_doc_url': out.get('report_doc_url'),
        'sourceCaption': out.get('sourceCaption'),
        'last_cycle_at': out.get('last_cycle_at') or out.get('timestamp') or now_utc,
        'new_in_cycle': out.get('new_in_cycle', 0),
        'sources_checked': out.get('sources_checked', []),
        'publishStatus': out.get('publishStatus'),
        'isHonestZero': out.get('isHonestZero'),
        'siteNotice': out.get('siteNotice'),
        'lastValidUpdatedAt': out.get('lastValidUpdatedAt'),
        'display_top3': out.get('display_top3', []),
        'historyContext': out.get('historyContext'),
        'selfCheck': out.get('selfCheck'),
    }
    sheet_id = os.environ.get('KRO_SHEET_ID', '').strip()
    sheets_client = get_sheets_client()
    write_kro_meta_to_sheet(
        sheets_client,
        sheet_id,
        payload.get('last_cycle_at'),
        payload.get('new_in_cycle', 0),
        payload.get('sources_checked', []),
        meta_range=os.environ.get('KRO_META_RANGE', 'kro_meta!A:B').strip() or 'kro_meta!A:B'
    )
    _pub_channels = [t.get('channel') or t.get('name') or '' for t in (payload.get('top3') or [])[:10]]
    append_kro_history_row(
        sheets_client,
        sheet_id,
        payload.get('last_cycle_at'),
        payload.get('new_in_cycle', 0),
        payload.get('sources_checked', []),
        channels_added=_pub_channels,
        status=payload.get('publishStatus') or 'honest_zero',
        notes='publish mode'
    )
    sent = _send_to_site(payload)
    if not sent:
        raise RuntimeError('MODE=publish: не удалось отправить данные цикла на сайт.')


def _check_and_promote_from_reports(sheets_client, sheet_id, scam_base_range, all_reports):
    """
    После сбора всех жалоб (форма + веб) — проверяем каждый канал.
    Если канал набрал ≥2 уникальных жалобщиков и ещё не в scam_base —
    автоматически записываем его туда со статусом 'в риске'.
    """
    if not sheets_client or not sheet_id or not all_reports:
        return

    # Группируем по каналу
    by_channel = defaultdict(list)
    for r in all_reports:
        ch = (r.get('channel') or '').strip()
        if ch:
            by_channel[ch].append(r)

    # Читаем уже существующие каналы в scam_base
    existing_in_scam = set()
    try:
        sheet_name = (scam_base_range or 'scam_base!A2:M').split('!')[0]
        resp = sheets_client.spreadsheets().values().get(
            spreadsheetId=sheet_id,
            range=f'{sheet_name}!A2:A'
        ).execute()
        for row in resp.get('values') or []:
            if row:
                existing_in_scam.add(_norm_ch_key((row[0] or '').strip()))
    except Exception as e:
        print(f'[promote] could not read scam_base: {e}', file=sys.stderr)

    promoted = 0
    now = datetime.now(timezone.utc)
    for ch, reports in by_channel.items():
        key = _norm_ch_key(ch)
        if key in existing_in_scam:
            continue
        # Никогда не добавлять антискам-проекты, биржи и сервисы аналитики
        if key in _KNOWN_NON_SCAM_CHANNELS:
            print(f'[promote] skip {ch}: в списке исключений (anti-scam/exchange)', file=sys.stderr)
            continue

        # Уникальность: по reporter-полю, если заполнено; иначе каждая строка = 1 человек
        named = [r.get('reporter') or '' for r in reports]
        named_non_empty = [n for n in named if n and n.lower() != 'web_parser']
        unique_count = (
            len(set(named_non_empty)) + (len(reports) - len(named_non_empty))
            if named_non_empty else len(reports)
        )
        if unique_count < 2:
            continue

        total_loss = sum(r.get('sum') or 0 for r in reports)
        evidence = _build_source_evidence_from_reports(reports)
        has_facts = _has_concrete_scam_facts(evidence)
        status = 'в риске' if has_facts else 'под наблюдением'
        norm_ch = ('@' + key) if not key.startswith('t.me/+') else key
        link = 'https://t.me/' + key if not key.startswith('t.me/') else 'https://' + key
        detected_at = now.strftime('%Y-%m-%dT%H:%M:%SZ')
        cycle_window = now.strftime('%Y-%m-%d') + ('_am' if now.hour < 12 else '_pm')
        sheet_name = (scam_base_range or 'scam_base!A2:M').split('!')[0]

        v2_row = [[
            norm_ch, link, detected_at, '', '', 'сигнал-канал', '',
            unique_count, total_loss, 'form+web', evidence[:300], cycle_window, status
        ]]
        try:
            sheets_client.spreadsheets().values().append(
                spreadsheetId=sheet_id,
                range=f'{sheet_name}!A:M',
                valueInputOption='USER_ENTERED',
                insertDataOption='INSERT_ROWS',
                body={'values': v2_row}
            ).execute()
            existing_in_scam.add(key)
            promoted += 1
            print(f'[promote] {norm_ch} → scam_base (reports={unique_count}, loss={total_loss}₽)', file=sys.stderr)
        except Exception as e:
            print(f'[promote] error writing {norm_ch}: {e}', file=sys.stderr)

    if promoted:
        print(f'[promote] total promoted to scam_base: {promoted}', file=sys.stderr)


def main():
    # Режим publish: только отправить уже собранные данные на сайт (12:00 и 00:00 MSK). Сбор не делаем.
    mode = os.environ.get('MODE', 'collect').strip().lower()
    if mode == 'publish':
        _run_publish_only()
        return

    now_msk = datetime.now(timezone.utc)  # можно перевести в MSK для заголовка
    now_msk_str = now_msk.strftime('%d %B %H:%M').replace('February', 'февраля').replace('March', 'марта').replace('January', 'января')
    print('Run 12h monitor at %s UTC' % now_msk.isoformat(), file=sys.stderr)

    # 0) Живой лог: старт цикла и «Начат сбор» (с датой для сортировки)
    now_msk_dt = _msk_now()
    datetime_prefix = now_msk_dt.strftime('%d.%m.%Y %H:%M')
    period_end_hm = now_msk_dt.strftime('%H:%M')
    period_start_hm = (now_msk_dt - timedelta(hours=HOURS_12)).strftime('%H:%M')
    _append_live_log_events(['%s — Старт цикла %s–%s (MSK).' % (datetime_prefix, period_start_hm, period_end_hm)])
    date_str_0 = now_msk_dt.strftime('%d.%m.%Y')
    p_start_hm = '00:00' if now_msk_dt.hour < 12 else '12:00'
    p_end_hm = '11:55' if now_msk_dt.hour < 12 else '23:55'
    _append_live_log_events(['%s %s — Начат сбор данных за период %s–%s.' % (date_str_0, p_start_hm, p_start_hm, p_end_hm)])

    # 1) TGStat new channels
    unavailable_sources = []
    try:
        new_tgstat = fetch_tgstat_new_channels()
    except Exception as e:
        print('TGStat fetch failed: %s' % e, file=sys.stderr)
        new_tgstat = []
        unavailable_sources.append('TGStat')
    try:
        tgstat_watch_channels = fetch_tgstat_watch_channels()
    except Exception as e:
        print('TGStat watch fetch failed: %s' % e, file=sys.stderr)
        tgstat_watch_channels = []
    time.sleep(REQUEST_DELAY)

    # 2) Telega catalog
    try:
        telega_channels = fetch_telega_catalog()
    except Exception as e:
        print('Telega fetch failed: %s' % e, file=sys.stderr)
        telega_channels = []
        unavailable_sources.append('Telega')

    # 3) Telegram: прямой поиск новых каналов + чаты жалоб + верификация
    tg_data, existing_channel_links, channel_ages_from_tg = asyncio.run(
        fetch_telegram_complaints_12h_and_verify_channels(new_tgstat, telega_channels, None)
    )
    # Обновляем new_tgstat: добавляем каналы найденные через Telegram SearchRequest
    tg_direct = tg_data.pop('_direct_search_channels', [])
    tg_watch = tg_data.pop('_watch_search_channels', [])
    watch_metrics = tg_data.pop('watch_metrics', {})
    if tg_direct:
        seen_ch = {_norm_ch_key(r.get('channel', '')) for r in new_tgstat}
        for r in tg_direct:
            if _norm_ch_key(r.get('channel', '')) not in seen_ch:
                new_tgstat.append(r)
    if tg_data.pop('_telegram_unavailable', False):
        unavailable_sources.append('Чаты')
    complaints_by_channel = tg_data.get('by_channel', {})
    victims_12h = tg_data.get('victims_12h', 0)
    channel_sum_pairs = tg_data.get('channel_sum_pairs', [])

    # 4) Web scraper: собираем данные с сайтов-разоблачителей раз в 12 ч
    sheet_id = os.environ.get('KRO_SHEET_ID', '').strip()
    client = get_sheets_client()
    web_findings = []
    web_source_statuses = []
    if _WEB_SCRAPER_AVAILABLE and client and sheet_id:
        try:
            web_findings = _web_scraper.scrape_all()
            web_source_statuses = getattr(_web_scraper, 'get_last_source_statuses', lambda: [])()
            if web_findings:
                written = _web_scraper.write_web_reports_to_sheet(client, sheet_id, web_findings, reports_range='A:H')
                print(f'[web_scraper] wrote {written} rows from {len(web_findings)} findings', file=sys.stderr)
        except Exception as _ws_err:
            print(f'[web_scraper] error: {_ws_err}', file=sys.stderr)

    # 5) Read sheet reports last 12h (form submissions + web scraper results)
    sheet_reports = read_reports_last_12h(client, sheet_id) if client and sheet_id else []

    # Complaints table for report: aggregate by channel
    agg_complaints = defaultdict(lambda: {
        'complaints': 0,
        'sum': 0,
        'status': 'Активен',
        'message_links': [],
        'source_urls': [],
        'query_group': '',
        'query': '',
        'internal_links': [],
    })
    for r in sheet_reports:
        ch = (r.get('channel') or '').strip()
        if ch:
            agg_complaints[ch]['complaints'] += 1
            agg_complaints[ch]['sum'] += r.get('sum') or 0
            if (agg_complaints[ch]['complaints'] or 0) >= 2:
                agg_complaints[ch]['status'] = 'Скам'
    for ch, data in complaints_by_channel.items():
        if ch not in agg_complaints:
            agg_complaints[ch] = {
                'complaints': 0,
                'sum': 0,
                'status': 'Активен',
                'message_links': [],
                'source_urls': [],
                'query_group': '',
                'query': '',
                'internal_links': [],
            }
        agg_complaints[ch]['complaints'] += data.get('complaints', 0)
        agg_complaints[ch]['sum'] += sum(data.get('sums', []))
        agg_complaints[ch]['message_links'] = _merge_text_values(agg_complaints[ch].get('message_links'), data.get('message_links'))
        agg_complaints[ch]['source_urls'] = _merge_text_values(agg_complaints[ch].get('source_urls'), data.get('source_urls'))
        agg_complaints[ch]['internal_links'] = _merge_text_values(agg_complaints[ch].get('internal_links'), data.get('internal_links'))
        agg_complaints[ch]['query_group'] = data.get('query_group') or agg_complaints[ch].get('query_group') or 'жалобы/обсуждения'
        agg_complaints[ch]['query'] = data.get('query') or agg_complaints[ch].get('query') or 'скам, обман, слил депозит'
        if agg_complaints[ch]['complaints'] >= 2:
            agg_complaints[ch]['status'] = 'Скам'
    complaints_rows = [
        {
            'channel': ch,
            'complaints': d['complaints'],
            'losses': d['sum'],
            'status': d['status'],
            'message_links': _format_evidence_text(d.get('message_links')),
            'source_url': _format_evidence_text(d.get('source_urls')),
            'source_urls': _merge_text_values(d.get('source_urls')),
            'query_group': d.get('query_group') or 'жалобы/обсуждения',
            'query': d.get('query') or 'скам, обман, слил депозит',
            'internal_links': _format_evidence_text(d.get('internal_links')),
            'evidence_links': _merge_text_values(d.get('message_links'), d.get('source_urls'), d.get('internal_links')),
        }
        for ch, d in agg_complaints.items()
    ]
    complaints_rows.sort(key=lambda x: -(x.get('losses') or 0))

    # Фильтр: только проверенные реальные каналы (Правило №1). Домены (сайты) не проверяем — оставляем.
    def _link_exists(link):
        if not link or 't.me/' not in link:
            return True
        return link in existing_channel_links
    new_tgstat = [r for r in (new_tgstat or []) if _link_exists(r.get('link') or _object_link(r.get('channel', '')))]
    telega_channels = [r for r in (telega_channels or []) if _link_exists(r.get('link') or _object_link(r.get('channel', '')))]
    complaints_rows = [r for r in complaints_rows if _link_exists(_object_link(r.get('channel', '')))]

    report_date_str = now_msk_dt.strftime('%d.%m.%Y')
    risk_rows, telegram_count_from_risk, courses_count_from_risk = _build_risk_table_rows(
        new_tgstat, telega_channels, complaints_rows, report_date_str
    )
    merge_channel_snapshots(risk_rows, report_date_str)

    # Top3 and totals (diagnostic/doc layer — risk_rows based)
    top3 = build_top3(sheet_reports, channel_sum_pairs)
    total_losses_12h = sum(r.get('sum', 0) for r in sheet_reports) + sum(s for _, s in channel_sum_pairs)
    new_scams_count = len(risk_rows)

    # --- AUTO-PROMOTE: каналы из формы/веб-парсера с ≥2 жалобами → scam_base ---
    scam_base_range = os.environ.get('KRO_SCAM_BASE_RANGE', 'scam_base!A2:M')
    _check_and_promote_from_reports(client, sheet_id, scam_base_range, sheet_reports)

    # --- CONFIRMED PIPELINE: строгий 3-критерийный отбор для сайта и scam_base ---
    cycle_window = '%s_%s' % (report_date_str, 'am' if now_msk_dt.hour < 12 else 'pm')
    confirmed_objects = _collect_confirmed_objects(new_tgstat, agg_complaints, cycle_window, channel_ages_from_tg)
    inserted_confirmed_channels = []
    if client and sheet_id:
        inserted_confirmed_channels = _write_confirmed_to_scam_base(confirmed_objects, client, sheet_id)
    channels_watch_rows = _build_channels_watch_rows(
        tgstat_watch_channels,
        telega_channels,
        tg_watch,
        complaints_rows,
        channel_ages_from_tg,
        watch_metrics,
        report_date_str,
        cycle_window
    )
    if client and sheet_id:
        _write_channels_watch_to_sheet(channels_watch_rows, client, sheet_id)
    confirmed_stats = _build_stats_from_confirmed(confirmed_objects)
    # Цифры для сайта — только из подтверждённых объектов
    site_new_scams = confirmed_stats['new_scam_channels']
    site_telegram = confirmed_stats['telegram_channels']
    site_courses = confirmed_stats['courses_products']
    site_losses = confirmed_stats['losses_12h'] if confirmed_stats['losses_12h'] > 0 else total_losses_12h
    site_top3 = confirmed_stats['top3'] if confirmed_stats['top3'] else top3

    # ---------

    # 4b) Живой лог: только сводные строки (никаких списков @каналов — каналы только в таблице).
    now_msk_dt = _msk_now()
    datetime_prefix = now_msk_dt.strftime('%d.%m.%Y %H:%M')
    events = []
    if confirmed_objects:
        events.append('%s — Подтверждено по 3 критериям: %d каналов, потери %s ₽.' % (
            datetime_prefix, len(confirmed_objects), site_losses or 0
        ))
    elif not risk_rows and not any((r.get('complaints') or r.get('losses')) for r in (complaints_rows or [])):
        events.append('%s — В этом цикле новых сигнал‑каналов по фильтрам не найдено; жалоб нет. Источники доступны.' % datetime_prefix)
    else:
        events.append('%s — Обновлён расчёт: %s ₽ зафиксированных потерь; по строгим критериям скам-каналов: %d.' % (
            datetime_prefix, total_losses_12h or 0, site_new_scams or 0
        ))
    if events:
        _append_live_log_events(events)

    web_status_map = {item.get('name'): item for item in (web_source_statuses or []) if item.get('name')}
    form_cycle_channels = sorted({
        (r.get('channel') or '').strip()
        for r in (sheet_reports or [])
        if (r.get('source') or '').strip().lower() == 'form' and (r.get('channel') or '').strip()
    })
    cycle_channels = {
        (r.get('channel') or '').strip()
        for r in (web_findings or [])
        if (r.get('channel') or '').strip()
    }
    cycle_channels.update(form_cycle_channels)
    sources_checked = [
        {
            'name': 'stop-scam1.com',
            'status': (web_status_map.get('stop-scam1.com') or {}).get('status', 'unavailable'),
            'count': int((web_status_map.get('stop-scam1.com') or {}).get('count', 0) or 0),
        },
        {
            'name': 'fin-obzor.net',
            'status': (web_status_map.get('fin-obzor.net') or {}).get('status', 'unavailable'),
            'count': int((web_status_map.get('fin-obzor.net') or {}).get('count', 0) or 0),
        },
        {
            'name': 'brokers-check.ru',
            'status': (web_status_map.get('brokers-check.ru') or {}).get('status', 'unavailable'),
            'count': int((web_status_map.get('brokers-check.ru') or {}).get('count', 0) or 0),
        },
        {
            'name': 'cryptorussia.ru',
            'status': (web_status_map.get('cryptorussia.ru') or {}).get('status', 'unavailable'),
            'count': int((web_status_map.get('cryptorussia.ru') or {}).get('count', 0) or 0),
        },
        {
            'name': 'vklader.com',
            'status': (web_status_map.get('vklader.com') or {}).get('status', 'unavailable'),
            'count': int((web_status_map.get('vklader.com') or {}).get('count', 0) or 0),
        },
        {
            'name': 'форма жалоб',
            'status': 'found' if form_cycle_channels else 'not_found',
            'count': len(form_cycle_channels),
        },
    ]

    # 5) Report number and Google Doc
    last_report_num = 0
    report_doc_url = None
    if os.path.isfile(OUTPUT_JSON):
        try:
            with open(OUTPUT_JSON, 'r', encoding='utf-8') as f:
                old = json.load(f)
                last_report_num = int(old.get(REPORT_COUNTER_KEY, 0))
        except Exception:
            pass
    report_number = last_report_num + 1
    summary_text = 'Подтверждено: %s | Потери: %s ₽ | Топ-3: %s' % (
        site_new_scams,
        site_losses,
        ', '.join(t.get('channel', '—') for t in site_top3[:3])
    )
    title = '%s — АВТООТЧЁТ №%s' % (now_msk_str, report_number)
    doc_id, report_doc_url = create_google_doc_report(
        title,
        new_tgstat,
        complaints_rows,
        summary_text,
        report_number
    )

    # 5b) Обновить документ «Источники и данные» — текст собираем здесь (всё, что нашла сеть)
    now_msk_dt = _msk_now()
    date_str = now_msk_dt.strftime('%d.%m.%Y')
    if now_msk_dt.hour < 12:
        period_start = date_str + ' 00:00'
        period_end = date_str + ' 11:55'
    else:
        period_start = date_str + ' 12:00'
        period_end = date_str + ' 23:55'
    sources_doc_id = os.environ.get('KRO_SOURCES_DOC_ID', '').strip()
    structured_data = None
    if sources_doc_id:
        print('Обновляю Google Doc «Источники и данные»...', flush=True)
        collect_time_msk = now_msk_dt.strftime('%d %B %H:%M MSK').replace('February', 'февраля').replace('March', 'марта').replace('January', 'января')
        complaints_count_val = sum((r.get('complaints') or 0) for r in complaints_rows)
        next_cycle_at = (now_msk_dt + timedelta(hours=12)).strftime('%d.%m.%Y %H:%M')
        doc_text, structured_data = build_sources_doc_text(
            collect_time_msk, new_tgstat, telega_channels, complaints_rows,
            site_new_scams, site_losses, site_telegram, site_courses, site_top3,
            report_doc_url,
            period_start=period_start, period_end=period_end,
            victims_12h=victims_12h, complaints_count=complaints_count_val,
            risk_rows=risk_rows,
            unavailable_sources=unavailable_sources,
            sources_checked=sources_checked,
            last_cycle_at=now_msk_dt.strftime('%d.%m.%Y %H:%M MSK'),
            new_in_cycle=len(inserted_confirmed_channels),
            next_cycle_at=next_cycle_at + ' MSK'
        )
        url = update_sources_google_doc(sources_doc_id, doc_text, structured_data)
        if url:
            print('Готово. Документ «Источники и данные» обновлён: %s' % url, flush=True)
            print('Открой эту ссылку и обнови страницу (F5), чтобы увидеть новую структуру: ЖИВОЙ ЛОГ, SOURCE & DATA, РАСЧЁТ ДЛЯ САЙТА, ТВОЯ ПРОВЕРКА.', flush=True)
        else:
            print('Не удалось обновить документ. Проверьте: 1) KRO_GOOGLE_CREDENTIALS_JSON, 2) доступ сервисного аккаунта к документу (Поделиться → email из ключа), 3) Google Docs API включён в Cloud.', flush=True)
    else:
        print('KRO_SOURCES_DOC_ID не задан — обновление документа пропущено.', flush=True)

    # Живой лог: «Завершён сбор» после обновления таблиц
    now_msk_dt = _msk_now()
    _append_live_log_events(['%s — Завершён сбор данных за день, таблицы обновлены.' % now_msk_dt.strftime('%d.%m.%Y %H:%M')])

    # 6) Write JSON for site (поля спецификации + обратная совместимость)
    # Сайтовые цифры берутся из confirmed_stats (строгие 3 критерия)
    top3_today = [(t.get('channel') or t.get('name') or '—') for t in (site_top3 or [])[:3]]
    previous_primary = _read_json_file(OUTPUT_JSON, default={}) or {}
    previous_top3 = previous_primary.get('display_top3') or previous_primary.get('top3') or []
    history_context = _build_history_context(previous_primary)
    out = {
        'new_scams': site_new_scams,
        'new_scam_channels': site_new_scams,
        'new_in_cycle': len(inserted_confirmed_channels),
        'last_cycle_at': now_msk.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'sources_checked': sources_checked,
        'losses_12h': site_losses,
        'victims_12h': victims_12h,
        'telegram_channels': site_telegram,
        'courses': site_courses,
        'courses_products': site_courses,
        'top3': site_top3,
        'top3_today': top3_today,
        'confirmed_objects': confirmed_objects,
        'report_doc_url': report_doc_url,
        REPORT_COUNTER_KEY: report_number,
        'updatedAt': now_msk.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'timestamp': now_msk.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'sources': ['TGStat search', 'Telega.io catalog', 'Telegram complaints 12h'],
        'risk_rows': risk_rows,
        'complaints_rows': complaints_rows,
        'unavailable_sources': unavailable_sources or [],
        'evidence_summary': (structured_data or {}).get('evidence_summary') or {
            'tgstat_queries': _unique_list([(r.get('query') or '') for r in (new_tgstat or [])], limit=6),
            'telega_sources': _unique_list([(r.get('source_url') or '') for r in (telega_channels or [])], limit=3),
            'complaint_sources': _unique_list(sum([r.get('source_urls') or [] for r in (complaints_rows or [])], []), limit=5),
            'web_search_urls': WEB_SEARCH_URLS[:],
            'risk_row_links': _unique_list(sum([r.get('evidence_links') or [] for r in (risk_rows or [])], []), limit=10),
        },
        'sourceCaption': 'Широкий поиск: TGStat, Telega, Telegram search, complaint chats, web reviews',
        'nothing_found': bool((structured_data or {}).get('nothing_found')),
        'historyContext': history_context,
    }
    publish_status = _classify_publish_result(out)
    is_honest_zero = publish_status == 'honest_zero'
    last_valid_updated_at = previous_primary.get('lastValidUpdatedAt') or previous_primary.get('updatedAt')
    display_top3 = out.get('top3') or []
    site_notice = None
    if publish_status == 'honest_zero':
        last_valid_updated_at = out.get('updatedAt')
        if not display_top3 and previous_top3:
            display_top3 = previous_top3[:3]
            site_notice = 'За этот период новых подтверждённых мошеннических объектов не обнаружено. Для контекста показаны данные предыдущего валидного цикла.'
        else:
            site_notice = 'За этот период новых подтверждённых мошеннических объектов не обнаружено. Мониторинг продолжается.'
    elif publish_status == 'valid':
        last_valid_updated_at = out.get('updatedAt')
    else:
        site_notice = 'Цикл завершился нулевыми данными и признан подозрительно пустым. Публикация на сайт отменена до проверки полноты поиска.'

    out['publishStatus'] = publish_status
    out['isHonestZero'] = is_honest_zero
    out['siteNotice'] = site_notice
    out['lastValidUpdatedAt'] = last_valid_updated_at
    out['display_top3'] = display_top3[:3] if isinstance(display_top3, list) else []

    write_kro_meta_to_sheet(
        client,
        sheet_id,
        out.get('last_cycle_at'),
        out.get('new_in_cycle', 0),
        out.get('sources_checked', []),
        meta_range=os.environ.get('KRO_META_RANGE', 'kro_meta!A:B').strip() or 'kro_meta!A:B'
    )
    append_kro_history_row(
        client,
        sheet_id,
        out.get('last_cycle_at'),
        out.get('new_in_cycle', 0),
        out.get('sources_checked', []),
        channels_added=inserted_confirmed_channels,
        status=out.get('publishStatus') or 'honest_zero',
        notes=out.get('siteNotice') or ''
    )

    _write_json_file(LAST_CYCLE_JSON, out)
    suspicious_zero_streak = _update_publish_history(publish_status, out.get('timestamp', ''))

    if publish_status == 'suspicious_zero':
        warning = (
            'Подозрительно пустой цикл: new_scam_channels=0, telegram_channels=0, '
            'courses_products=0, losses_12h=0, top3 пустой. Боевой JSON и сайт не обновлены.'
        )
        print(warning, file=sys.stderr)
        if suspicious_zero_streak >= SUSPICIOUS_ZERO_STREAK_ALERT:
            diagnostics = _run_suspicious_zero_self_check(out, suspicious_zero_streak, previous_primary)
            out['selfCheck'] = diagnostics
            _write_json_file(LAST_CYCLE_JSON, out)
            print(
                'Аномалия: %s подозрительных пустых цикла(ов) подряд. Нужна проверка источников, парсинга и полноты поиска.'
                % suspicious_zero_streak,
                file=sys.stderr
            )
            print(
                'Self-check suspicious_zero: %s' % json.dumps(diagnostics, ensure_ascii=False),
                file=sys.stderr
            )
        now_msk_dt = _msk_now()
        events = ['%s — %s' % (now_msk_dt.strftime('%d.%m.%Y %H:%M'), warning)]
        if suspicious_zero_streak >= SUSPICIOUS_ZERO_STREAK_ALERT:
            repeated_objects = (out.get('selfCheck') or {}).get('historyContext', {}).get('repeatedObjects') or []
            repeated_categories = (out.get('selfCheck') or {}).get('historyContext', {}).get('repeatedCategories') or []
            repeated_channels = ', '.join(item.get('channel') or '—' for item in repeated_objects[:3]) or 'нет'
            repeated_types = ', '.join(item.get('category') or 'unknown' for item in repeated_categories[:3]) or 'нет'
            events.append(
                '%s — Самопроверка suspicious_zero: streak=%s, повторяющиеся объекты=%s, повторяющиеся категории=%s.'
                % (now_msk_dt.strftime('%d.%m.%Y %H:%M'), suspicious_zero_streak, repeated_channels, repeated_types)
            )
        _append_live_log_events(events)
        return

    _write_json_file(OUTPUT_JSON, out)
    print('Written %s: new_scams=%s, losses_12h=%s, victims_12h=%s, report #%s, publish_status=%s' % (
        OUTPUT_JSON, out['new_scams'], out['losses_12h'], out['victims_12h'], report_number, publish_status), file=sys.stderr)
    if report_doc_url:
        print('Report doc: %s' % report_doc_url, file=sys.stderr)
    # Сразу отправить данные на сайт, чтобы цифры отображались после каждого сбора
    site_payload = {
        'timestamp': out.get('timestamp', ''),
        'new_scam_channels': out.get('new_scams', 0),
        'new_in_cycle': out.get('new_in_cycle', 0),
        'last_cycle_at': out.get('last_cycle_at'),
        'sources_checked': out.get('sources_checked', []),
        'losses_12h': out.get('losses_12h', 0),
        'telegram_channels': out.get('telegram_channels', 0),
        'courses_products': out.get('courses_products', 0),
        'top3_today': out.get('top3_today', []),
        'top3': out.get('top3', []),
        'display_top3': out.get('display_top3', []),
        'victims_12h': out.get('victims_12h', 0),
        'risk_rows': out.get('risk_rows', []),
        'complaints_rows': out.get('complaints_rows', []),
        'evidence_summary': out.get('evidence_summary', {}),
        'report_doc_url': out.get('report_doc_url'),
        'sourceCaption': out.get('sourceCaption'),
        'publishStatus': out.get('publishStatus'),
        'isHonestZero': out.get('isHonestZero'),
        'siteNotice': out.get('siteNotice'),
        'lastValidUpdatedAt': out.get('lastValidUpdatedAt'),
        'historyContext': out.get('historyContext'),
        'selfCheck': out.get('selfCheck'),
    }
    sent = _send_to_site(site_payload)
    if not sent:
        raise RuntimeError('Не удалось отправить данные цикла на сайт через KRO_SITE_UPDATE_URL.')
    print('На сайт отправлены данные цикла: new_in_cycle=%d, site_new_scams=%d.' % (
        out.get('new_in_cycle', 0), site_new_scams
    ), flush=True)


if __name__ == '__main__':
    main()
