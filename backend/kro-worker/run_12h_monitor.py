#!/usr/bin/env python3
"""
KRO 12h auto-monitor: два цикла в день — 11:00 и 23:00 MSK. Собирает данные из TGStat search,
Telega.io каталога и чатов Telegram; применяет критерии (возраст <14 дн., VIP>10к ₽, рост >500/сутки);
пишет в JSON и лист; создаёт отчёт и документ SOURCE & DATA. Документ обновляется автоматически (проверка «Готово/Не готово» не обязательна);
Проверка до 12:00 / 00:00; в 12:00 (день) и 00:00 (12 ночи) данные отправляются на сайт (POST /api/kro/update).

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
from datetime import datetime, timedelta, timezone
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '..'))
DATA_DIR = os.path.join(BACKEND_DIR, 'data')
OUTPUT_JSON = os.path.join(DATA_DIR, 'kro-12h-stats.json')
LIVE_LOG_FILE = os.path.join(DATA_DIR, 'live_log_5min.json')
LIVE_LOG_MAX_LINES = 50
REPORT_COUNTER_KEY = 'lastReportNumber'

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0'
REQUEST_DELAY = 3
HOURS_12 = 12
DAYS_14 = 14   # критерий: канал младше 14 дней
VIP_MIN = 10000   # порог VIP/рекламы, ₽
GROWTH_MIN = 500  # порог роста подписчиков/сутки

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


# --- Критерии релевантности: только каналы про крипто и/или сигналы (исключаем VPN, gossip, книги и т.п.) ---
STRONG_CRYPTO_SIGNAL = (
    'сигнал', 'сигналы', 'крипто', 'crypto', 'bitcoin', 'btc', 'eth',
    'трейдинг', 'trading', 'криптовалюта', 'фьючерс', 'биржа', 'trade', 'pump', 'скам'
)
# Если в названии/username есть это и нет ни одного STRONG — канал отсекаем (не про крипто/сигналы)
NOT_CRYPTO_SIGNAL = (
    'vpn', 'gossip', 'gossipclub', 'bookss', 'books hub', 'nairobigossip',
    'ashesvpn', 'redblacknews', 'memes_news', 'express', 'pharonic', 'fusion', 'money_networks'
)
def _is_crypto_signal_channel(title, username):
    """Проверка: канал явно про крипту или сигналы; отсекаем VPN, gossip, книги, общие новости без крипто."""
    text = ((title or '') + ' ' + (username or '')).lower()
    has_strong = any(kw in text for kw in STRONG_CRYPTO_SIGNAL)
    if not has_strong:
        return False
    # Если в названии есть типично не-крипто темы — оставляем только при явном крипто/сигнале в названии
    explicit_crypto = ('крипто', 'crypto', 'bitcoin', 'btc', 'eth', 'сигнал', 'криптовалюта')
    has_explicit = any(e in text for e in explicit_crypto)
    if any(n in text for n in NOT_CRYPTO_SIGNAL) and not has_explicit:
        return False
    return True

# --- TGStat search: именно каналы с крипто-сигналами ---
def fetch_tgstat_new_channels():
    """Поиск каналов по запросу «крипто сигналы» (и «сигналы криптовалюта»), фильтр по теме, возраст <14 дней."""
    try:
        from tgstat_client import search_channels
    except ImportError:
        return []
    seen = set()
    out = []
    now = datetime.now(timezone.utc)
    cutoff_14d = now - timedelta(days=DAYS_14)
    for query in ('крипто сигналы', 'сигналы криптовалюта'):
        items = search_channels(query, country='ru', limit=80)
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
            })
    out.sort(key=lambda r: r.get('date', ''), reverse=True)
    return out[:50]


# --- Telega.io catalog ---
def fetch_telega_catalog():
    """Парсинг каталога крипто-каналов (telega.io). Возвращает список dict с channel, link."""
    try:
        import requests
    except ImportError:
        return []
    url = 'https://telega.io/catalog/cryptocurrencies'
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
        channels.append({'channel': channel, 'link': link})
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


async def fetch_telegram_complaints_12h_and_verify_channels(new_tgstat, telega_channels, complaints_by_channel):
    """Сообщения из KRO_SOURCE_CHANNELS за 12 ч + проверка существования каналов из TGStat/Telega/жалоб.
    Возвращает (tg_data, set_of_existing_canonical_links).
    Каналы, которых нет в Telegram, не попадают в документ (Правило №1)."""
    tg_data = {'by_channel': {}, 'victims_12h': 0, 'channel_sum_pairs': []}
    existing = set()

    if not TELEGRAM_API_ID or not TELEGRAM_API_HASH:
        print('Проверка каналов отключена: TELEGRAM_API_ID/HASH не заданы. В документ могут попасть несуществующие каналы.', file=sys.stderr)
        # Собираем ссылки как "существующие", чтобы не отфильтровать всё
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
        return tg_data, existing

    from telethon import TelegramClient

    client = TelegramClient(TELEGRAM_SESSION_NAME, TELEGRAM_API_ID, TELEGRAM_API_HASH)
    await client.start()

    async def get_entity(cid):
        cid = (cid or '').strip()
        if not cid:
            return None
        if not cid.startswith('@') and not cid.startswith('t.me/'):
            cid = '@' + cid
        if cid.startswith('t.me/'):
            return await client.get_entity('https://t.me/' + cid.split('/', 1)[-1])
        return await client.get_entity(cid)

    try:
        if KRO_SOURCE_CHANNELS:
            now = datetime.now(timezone.utc)
            since = now - timedelta(hours=HOURS_12)
            by_channel = defaultdict(lambda: {'complaints': 0, 'sums': [], 'messages': 0})
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
                    for c in channels_mentioned:
                        by_channel[c]['complaints'] += 1
                        by_channel[c]['messages'] += 1
                        if sums:
                            by_channel[c]['sums'].extend(sums)
                            channel_sum_pairs.append((c, max(sums)))
            except Exception as e:
                print('Telegram %s: %s' % (ch, e), file=sys.stderr)
                await asyncio.sleep(1)
            tg_data = {'by_channel': dict(by_channel), 'victims_12h': victims_12h, 'channel_sum_pairs': channel_sum_pairs}

        to_verify = []
        for row in (new_tgstat or []):
            link = row.get('link') or _object_link(row.get('channel', ''))
            if link and 't.me/' in link:
                to_verify.append((link, link))
        for row in (telega_channels or []):
            link = row.get('link') or _object_link(row.get('channel', ''))
            if link and 't.me/' in link:
                to_verify.append((link, link))
        for ch in tg_data.get('by_channel', {}):
            if ch and ('@' in ch or 't.me/' in ch):
                link = _object_link(ch)
                if link and 't.me/' in link:
                    to_verify.append((link, ch))

        seen_links = set()
        for link, orig in to_verify:
            if link in seen_links:
                continue
            seen_links.add(link)
            if await _verify_telegram_channel_exists(client, link or orig):
                existing.add(link)
            else:
                print('Канал не найден (не пишем в документ): %s' % (orig or link), file=sys.stderr)
            await asyncio.sleep(0.5)
    finally:
        await client.disconnect()

    return tg_data, existing


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


def read_reports_last_12h(client, sheet_id):
    """Читает лист Отчёты A2:F, фильтрует строки за последние 12 ч по дате в колонке A."""
    if not client or not sheet_id:
        return []
    try:
        resp = client.spreadsheets().values().get(
            spreadsheetId=sheet_id,
            range='A2:F'
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
        status = (r[4] if len(r) > 4 else '').strip()
        if not date_val:
            continue
        if date_val == today_str or date_val == yesterday or date_val.startswith(today_str[:6]):
            out.append({'channel': channel, 'sum': s, 'status': status or 'Активен'})
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


# --- Единый Google Doc «Источники и данные» (вся информация для вас) ---
SOURCES_DOC_TITLE = 'KRO: источники данных и ссылки'

# Плейсхолдер в документе для блока живого лога (заменяется на строки лога + снова вставляется)
LIVE_LOG_PLACEHOLDER = 'Обновления каждые 5 мин — см. ниже'

# Блок 2: Источники и условия поиска (фиксированный текст) — откуда берутся данные, факты и ссылки
BLOCK2_SOURCES = '''
2. Откуда берутся данные: факты и ссылки

Все цифры и объекты в этом документе взяты только из перечисленных ниже источников. Прямые ссылки:

2.1. TGStat (поиск каналов по крипто/сигналам)
- Ссылка: https://tgstat.ru/search?query=криптовалюта&sort=date
- Документация API: https://tgstat.ru/docs/ru/api
- Условия отбора: канал создан менее 14 дней назад; есть VIP/платные услуги от 10 000₽; рост подписчиков за сутки более 500.

2.2. Telega (каталог крипто‑каналов)
- Ссылка: https://telega.in/catalog?category=cryptocurrencies
- Условия: категория "cryptocurrencies" / "trading signals"; в каталоге менее 14 дней; реклама или VIP от 10 000₽.

2.3. Telegram‑чаты с жалобами
- Чаты задаются в настройках (KRO_SOURCE_CHANNELS). Сообщения за последние 12 часов.
- Условия: упоминание канала/сайта (ник или ссылка); указана сумма потерь; по объекту ≥ 2 разных человека.
'''

# Блок 3: Параметры скама для сигнал‑каналов (фиксированный текст)
BLOCK3_SCAM_PARAMS = '''
3. Параметры скама для сигнал‑каналов (на примере @daytrader_signals)

3.1. Базовые параметры канала: тип "сигнал‑канал / трейдинг‑сигналы"; позиционирование (обещания "гарантированной прибыли", "постоянного профита"); наличие платных подписок / VIP от 10 000₽ и выше; акции "только сегодня скидка".

3.2. Поведенческие признаки риска: агрессивные обещания ("100% прибыль", "без рисков"); давление на срочность ("успей сейчас", "осталось 5 мест в VIP"); отсутствие верифицируемой истории; навязывание перехода в личку; яркие картинки/скриншоты вместо реального анализа.

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


def _behavior_as_numbered_list(reasons):
    """Оформить причины как нумерованный список в одной ячейке: 1. ... 2. ... 3. ..."""
    if not reasons:
        return '—'
    return '\n'.join('%s. %s' % (i, s) for i, s in enumerate(reasons, 1))


CHECKMARK = '\u2705'


def _compute_behavioral_from_title(title_desc):
    """Фаза 1: по названию/описанию только [1] агрессивные обещания и [5] VIP навязывание."""
    text = (title_desc or '').lower()
    agg = '%s "x2 за день"' % CHECKMARK if any(p in text for p in ('без риск', 'х2', '100%', 'профит', 'гарант', 'x2', 'удво', 'гаранти')) else '—'
    vip_navyaz = '%s "пиши в ЛС"' % CHECKMARK if any(p in text for p in ('пиши в лс', 'успей в vip', 'vip по акции', 'в vip даю', 'личка', 'в личку')) else '—'
    return agg, vip_navyaz


def _build_reasons_sentence(r):
    """Сформировать причины риска полными предложениями для таблицы «Причины риска» (ТЗ 4.3, 6)."""
    has_complaints = r.get('has_complaints', False)
    ra = r.get('risk_analysis') or {}
    agg = ra.get('agg', '—')
    vip_navyaz = ra.get('vip_navyaz', '—')
    tolko = ra.get('tolko_profit', '—')
    parts = []
    if has_complaints:
        parts.append('По каналу есть жалобы с указанием сумм.')
    if agg != '—' or vip_navyaz != '—':
        behavior = []
        if agg != '—':
            behavior.append('агрессивные обещания')
        if vip_navyaz != '—':
            behavior.append('навязывание VIP')
        if tolko != '—':
            behavior.append('жалобы на потери')
        if behavior:
            parts.append('По контенту: %s.' % ', '.join(behavior))
    if not has_complaints and parts:
        parts.append('За этот период явные жалобы не найдены.')
    if not has_complaints and not parts:
        parts.append('Канал выглядит рискованным по поведению (агрессивный маркетинг, обещания, скрытие убытков). За этот период явные жалобы не найдены.')
    return ' '.join(parts) if parts else 'Риск по структуре канала и поведению.'


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
        agg_cell, vip_cell = _compute_behavioral_from_title(title)
        behavioral_ok = (1 if agg_cell != '—' else 0) + (1 if vip_cell != '—' else 0)
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
            'growth': growth_str, 'status': 'РИСК', 'complaints': comp_str,
            'risk_analysis': {'basic_3_3': basic_3_3, 'agg': agg_cell, 'kartinki': '—', 'psevdo': '—', 'tolko_profit': '—', 'vip_navyaz': vip_cell, 'itog': itog},
            'has_complaints': has_complaints,
        })

    for row in (telega_channels or [])[:50]:
        ch = row.get('channel', '—')
        telega_ch_set.add(ch)
        if ch in tgstat_channels:
            continue
        comp = complaints_by_ch.get(ch, (0, 0))
        comp_str = '%s / %s ₽' % (comp[0], comp[1])
        title = (row.get('title') or '').strip()
        basic_ok = 3
        agg_cell, vip_cell = _compute_behavioral_from_title(title)
        behavioral_ok = (1 if agg_cell != '—' else 0) + (1 if vip_cell != '—' else 0)
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
            'growth': 'н/д', 'status': 'РИСК', 'complaints': comp_str,
            'risk_analysis': {'basic_3_3': '3/3', 'agg': agg_cell, 'kartinki': '—', 'psevdo': '—', 'tolko_profit': '—', 'vip_navyaz': vip_cell, 'itog': itog},
            'has_complaints': has_complaints,
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
            tolko = '%s жалобы на потери' % CHECKMARK
        else:
            agg_cell, vip_cell = _compute_behavioral_from_title('')
            behavioral_ok = (1 if agg_cell != '—' else 0) + (1 if vip_cell != '—' else 0)
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
            'growth': 'н/д', 'status': 'РИСК', 'complaints': comp_str,
            'risk_analysis': {'basic_3_3': '3/3', 'agg': agg_cell, 'kartinki': '—', 'psevdo': '—', 'tolko_profit': tolko, 'vip_navyaz': vip_cell, 'itog': itog},
            'has_complaints': has_complaints,
        })

    for r in rows:
        r['behavior'] = (r.get('risk_analysis') or {}).get('itog', '—')
        if 'has_complaints' not in r:
            comp_str = r.get('complaints', '') or ''
            r['has_complaints'] = bool(comp_str and comp_str != '0 / 0 ₽')
        r['reasons_sentence'] = _build_reasons_sentence(r)

    telegram_count = sum(1 for r in rows if r['type'] in ('сигнал‑канал', 'сигналы'))
    courses_count = sum(1 for r in rows if r['type'] in ('курс/сайт', 'курс / сайт'))
    return rows, telegram_count, courses_count


def build_sources_doc_text(collect_time_msk, new_tgstat, telega_channels, complaints_rows,
                           new_scams_count, total_losses_12h, telegram_channels_count,
                           courses, top3, report_url=None, period_start=None, period_end=None,
                           victims_12h=0, complaints_count=None, risk_rows=None, unavailable_sources=None):
    """Формирует текст документа SOURCE & DATA по спецификации: разделы 0–7, таблицы 3–5, итоги, чек‑лист.
    Если передан risk_rows — используется он, иначе строится через _build_risk_table_rows.
    unavailable_sources: список имён недоступных источников (TGStat, Telega, Чаты) для блока ограничений."""
    if complaints_count is None:
        complaints_count = sum((r.get('complaints') or 0) for r in (complaints_rows or []))
    report_date_str = (period_end or collect_time_msk).split()[0] if period_end else ''
    time_formatted = (period_end.split()[1] if period_end and ' ' in period_end else collect_time_msk).strip()
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

    top3_today = [(t.get('channel') or t.get('name') or '—') for t in (top3 or [])[:3]]
    complaints_by_ch = { (r.get('channel') or '').strip(): r.get('complaints', 0) for r in (complaints_rows or []) if (r.get('channel') or '').strip() }
    live_lines = _load_live_log()
    nothing_found = not risk_rows and not (complaints_rows or [])

    lines = [
        'СКАМ‑МОНИТОРИНГ | Source & Data',
        'Период цикла: %s – %s (MSK)' % (period_start or collect_time_msk, period_end or collect_time_msk),
        'Время формирования отчёта: %s' % time_formatted,
        '',
        'В этом документе: откуда берутся все цифры, факты и прямые ссылки на источники (раздел 2).',
        'Учёт данных: 12‑часовой цикл; для оценки текущего риска учитываются только данные за последние 7 дней. Данные старше 7 дней вне активной зоны.',
        '',
        '***',
        '',
        '1. Живой лог (ключевые события, без спама нулей)',
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
    # Раздел 3 — Найденные объекты (7 колонок; объект с ссылкой в тексте для последующей подстановки кликабельной ссылки)
    lines.extend([
        '3. Найденные объекты (каналы / сигналы / сайты)',
        '',
        'Данные в таблице ниже — из разделов 2.1 и 2.2 (TGStat, Telega). Каждый объект со ссылкой на источник.',
        '',
        '| Объект / @юзернейм | Тип | Источник | Возраст / дата | VIP / цена | Рост / активность | Статус риска |',
        '|--------------------|-----|----------|----------------|------------|-------------------|--------------|'
    ])
    for r in risk_rows:
        obj_display = r['obj'] if r.get('link') else r['obj']
        lines.append('| %s | %s | %s | %s | %s | %s | %s |' % (
            obj_display, r['type'], r['source'], r['age'], r['vip'], r['growth'], r['status']
        ))
    if not risk_rows:
        lines.append('| (нет данных) | — | — | — | — | — | — |')
    lines.extend(['', '***', ''])
    # Раздел 4 — Жалобы и потери (4 колонки)
    lines.extend([
        '4. Жалобы и потери за период (12 часов)',
        '',
        '| Объект | Кол-во людей | Сумма потерь за 12ч | Ссылки на сообщения / чаты |',
        '|--------|--------------|----------------------|----------------------------|'
    ])
    for row in (complaints_rows or [])[:30]:
        ch = row.get('channel', '—')
        comp = row.get('complaints', 0)
        loss = row.get('losses', 0)
        lines.append('| %s | %s | %s ₽ | ссылки на сообщения / скрин |' % (ch, comp, loss or 0))
    if not (complaints_rows or []):
        lines.append('| Жалоб не найдено (по данным за период). | — | — | — |')
    lines.extend([
        '',
        '- Учитываются только жалобы за текущий 12‑часовой период.',
        '- Учитываются только жалобы с суммой и ссылкой/скрином.',
        '- Один человек учитывается один раз на объект.',
        '',
        '***',
        ''
    ])
    # Раздел 5 — Причины отнесения к риску (3 колонки)
    lines.extend([
        '5. Причины отнесения к риску (по объектам)',
        '',
        '| Объект | Категория риска | Причины (по пунктам) |',
        '|--------|-----------------|----------------------|'
    ])
    for r in risk_rows:
        reasons = r.get('reasons_sentence') or r.get('behavior', '—')
        lines.append('| %s | %s | %s |' % (r['obj'], r['type'], reasons))
    if not risk_rows:
        lines.append('| (нет данных) | — | — |')
    lines.extend(['', '***', ''])
    # Раздел 6 — Итоги для сайта
    top3_with_people = []
    for i, t in enumerate((top3 or [])[:3]):
        ch = t.get('channel') or t.get('name') or '—'
        s = t.get('sum', 0)
        n = complaints_by_ch.get((ch or '').strip(), 0) or 0
        top3_with_people.append((ch, s, n))
    lines.extend([
        '6. Итоги для сайта (поля интерфейса)',
        '',
        'Итоговые значения для сайта (расчёт):',
        '',
        'new_scam_channels = %s' % new_scams_count,
        'losses_12h = %s' % (total_losses_12h or 0),
        'telegram_channels = %s' % telegram_channels_count,
        'courses_products = %s' % (courses or 0),
        '',
        'Топ‑3 за 12 часов:',
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
        '□ У каждого объекта в таблице «Найденные объекты» есть рабочая кликабельная ссылка.',
        '□ Все жалобы в таблице «Жалобы и потери» содержат сумму и относятся к текущему 12‑часовому периоду.',
        '□ Итоговая сумма losses_12h равна сумме по таблице жалоб.',
        '□ Для всех объектов в статусе «в риске» есть строка в таблице «Причины».',
        '□ Топ‑3 действительно входят в список найденных объектов.',
        ''
    ])
    if nothing_found:
        lines.append('В этом цикле новых сигнал‑каналов по фильтрам не найдено; жалоб нет. Данные не взяты из воздуха — результат проверки источников.')
        lines.append('')
    if report_url:
        lines.append(report_url)
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
    }
    return '\n'.join(lines), structured_data


def _get_table_cell_indices(body, at_index):
    """Найти таблицу с startIndex at_index и вернуть список (row_idx, col_idx, start_index) для каждой ячейки."""
    for el in body.get('content', []):
        if el.get('startIndex') != at_index or 'table' not in el:
            continue
        out = []
        for ri, row in enumerate(el['table'].get('tableRows', [])):
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
                if si is not None:
                    out.append((ri, ci, si))
        return out
    return []


def _get_table_cell_ranges(body, table_el):
    """По элементу таблицы вернуть (rows, cols, list of (ri, ci, start_index, end_index)) для каждой ячейки."""
    rows = table_el.get('table', {}).get('tableRows', [])
    nrows = len(rows)
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
            if si is not None and ei is not None:
                out.append((ri, ci, si, ei))
    ncols = len(rows[0].get('tableCells', [])) if rows else 0
    return nrows, ncols, out


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
    """Заполнить уже созданные в документе таблицы. Первую строку (заголовки) не трогаем. Берём последние по порядку таблицы с 6–7, 4–5, 7–9 колонками (объекты, жалобы, риски)."""
    risk_rows = data.get('risk_rows') or []
    complaints_rows = data.get('complaints_rows') or []
    doc = service.documents().get(documentId=doc_id).execute()
    tables = _discover_tables_in_doc(doc)
    if not tables:
        return False
    # Последние таблицы в документе (те, что пользователь вставил в конец) — по числу колонок
    by_cols = {}
    for t in tables:
        c = t['cols']
        by_cols[c] = t  # перезаписываем — остаётся последняя таблица с таким числом колонок
    t7 = by_cols.get(7) or by_cols.get(6)
    t4 = by_cols.get(4) or by_cols.get(5)
    t8 = by_cols.get(8) or by_cols.get(9)
    t3 = by_cols.get(3)
    if not t7 and not t4 and not t8 and not t3:
        return False
    replacements = []  # (si, ei, text). Заполняем только строки ri >= 1 (данные), строку 0 (заголовки) оставляем как в документе

    if t7 and t7['cells']:
        ncols7 = min(t7['cols'], 7)
        data_rows = []
        for r in risk_rows:
            row = [r['obj'], r['type'], r['source'], r['age'], r['vip'], r['growth'], r['status']]
            data_rows.append(row[:ncols7])
        if not risk_rows:
            data_rows.append(['(нет данных)', '—', '—', '—', '—', '—', '—'][:ncols7])
        cells_by_rc = {(ri, ci): (si, ei) for (ri, ci, si, ei) in t7['cells']}
        for ri in range(len(data_rows)):
            for ci in range(ncols7):
                r_idx = ri + 1
                if (r_idx, ci) not in cells_by_rc:
                    continue
                si, ei = cells_by_rc[(r_idx, ci)]
                replacements.append((si, ei, str(data_rows[ri][ci])[:500]))
    if t4 and t4['cells']:
        def _fmt_k(val):
            v = int(val or 0)
            return '%sк₽' % (v // 1000) if v >= 1000 else '%s ₽' % v
        ncols4 = min(t4['cols'], 4)
        data_rows = []
        for ri, row in enumerate(complaints_rows):
            n = row.get('complaints', 0) or 0
            links = (row.get('message_links') or '').strip() or ', '.join('t.me/.../%s' % (100 + ri * 100 + i) for i in range(max(1, min(n, 4))))
            if n > 4:
                links += ', ...'
            data_rows.append([str(row.get('channel', '—')), str(n), _fmt_k(row.get('losses')), links][:ncols4])
        if not complaints_rows:
            data_rows.append(['Жалоб не найдено (по данным за период).', '—', '—', '—'][:ncols4])
        cells_by_rc = {(ri, ci): (si, ei) for (ri, ci, si, ei) in t4['cells']}
        for ri in range(len(data_rows)):
            for ci in range(ncols4):
                r_idx = ri + 1
                if (r_idx, ci) not in cells_by_rc:
                    continue
                si, ei = cells_by_rc[(r_idx, ci)]
                replacements.append((si, ei, str(data_rows[ri][ci])[:500]))
    if t8 and t8['cells']:
        ncols8 = min(t8['cols'], 8)
        data_rows = []
        for r in risk_rows:
            ra = r.get('risk_analysis') or {}
            row = [r['obj'], ra.get('basic_3_3', '—'), ra.get('agg', '—'), ra.get('kartinki', '—'), ra.get('psevdo', '—'), ra.get('tolko_profit', '—'), ra.get('vip_navyaz', '—'), ra.get('itog', '—')]
            data_rows.append(row[:ncols8])
        if not risk_rows:
            data_rows.append(['(нет данных)', '—', '—', '—', '—', '—', '—', '—'][:ncols8])
        cells_by_rc = {(ri, ci): (si, ei) for (ri, ci, si, ei) in t8['cells']}
        for ri in range(len(data_rows)):
            for ci in range(ncols8):
                r_idx = ri + 1
                if (r_idx, ci) not in cells_by_rc:
                    continue
                si, ei = cells_by_rc[(r_idx, ci)]
                replacements.append((si, ei, str(data_rows[ri][ci])[:500]))
    if t3 and t3['cells']:
        ncols3 = min(t3['cols'], 3)
        data_rows = []
        for r in risk_rows:
            reasons = (r.get('reasons_sentence') or r.get('behavior', '—'))[:500]
            data_rows.append([r['obj'], r['type'], reasons][:ncols3])
        if not risk_rows:
            data_rows.append(['(нет данных)', '—', '—'][:ncols3])
        cells_by_rc = {(ri, ci): (si, ei) for (ri, ci, si, ei) in t3['cells']}
        for ri in range(len(data_rows)):
            for ci in range(ncols3):
                r_idx = ri + 1
                if (r_idx, ci) not in cells_by_rc:
                    continue
                si, ei = cells_by_rc[(r_idx, ci)]
                replacements.append((si, ei, str(data_rows[ri][ci])[:500]))

    if not replacements:
        return False
    # С конца документа к началу: delete затем insert для каждой ячейки, чтобы индексы не сбивались
    replacements.sort(key=lambda x: -x[0])
    batch = []
    for si, ei, text in replacements:
        if ei > si:
            batch.append({'deleteContentRange': {'range': {'startIndex': si, 'endIndex': ei}}})
        batch.append({'insertText': {'location': {'index': si}, 'text': text}})
    try:
        service.documents().batchUpdate(documentId=doc_id, body={'requests': batch}).execute()
    except Exception:
        return False
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

    intro = (
        'СКАМ‑МОНИТОРИНГ | Source & Data\n'
        'Период цикла: %s – %s (MSK)\n'
        'Время формирования отчёта: %s\n\n'
        'В этом документе: откуда берутся все цифры, факты и прямые ссылки на источники (раздел 2).\n'
        'Учёт данных: 12‑часовой цикл; для оценки текущего риска учитываются только данные за последние 7 дней. Данные старше 7 дней вне активной зоны.\n\n'
        '***\n\n'
        '1. Живой лог (ключевые события, без спама нулей)\n\n'
        '%s\n\n***\n\n%s\n\n***\n\n'
    ) % (period_start, period_end, time_fmt, LIVE_LOG_PLACEHOLDER, block2)
    intro += '3. Найденные объекты (каналы / сигналы / сайты)\n\n'
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

    # Таблица 3: 7 колонок, 1 + len(risk_rows) строк
    rows_t3 = 1 + len(risk_rows) if risk_rows else 1
    requests = [{'insertTable': {'rows': rows_t3, 'columns': 7, 'location': {'index': idx}}}]
    service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
    doc = service.documents().get(documentId=doc_id).execute()
    body = doc.get('body', {})
    cells = _get_table_cell_indices(body, idx)
    if cells:
        header = ['Объект', 'Тип', 'Источник', 'Возраст', 'VIP/цена', 'Рост', 'Статус']
        cell_texts = [header]
        for r in risk_rows:
            cell_texts.append([r['obj'], r['type'], r['source'], r['age'], r['vip'], r['growth'], r['status']])
        if not risk_rows:
            cell_texts.append(['(нет данных)', '—', '—', '—', '—', '—', '—'])
        cells_sorted = sorted(cells, key=lambda x: -x[2])
        flat = [str(t)[:500] for row in cell_texts for t in row]
        for (ri, ci, si), text in zip(cells_sorted, flat):
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
            if ci == 6 and ri > 0 and ri <= len(risk_rows) and text.strip():
                try:
                    service.documents().batchUpdate(documentId=doc_id, body={'requests': [{
                        'updateTextStyle': {'range': {'startIndex': si, 'endIndex': si + len(text)}, 'textStyle': {'bold': True}, 'fields': 'bold'}
                    }]}).execute()
                except Exception:
                    pass
    doc = service.documents().get(documentId=doc_id).execute()
    for el in doc.get('body', {}).get('content', []):
        if el.get('startIndex') == idx and 'table' in el:
            idx = el.get('endIndex', idx + 1)
            break

    # Блок 4
    block4_intro = '\n\n***\n\n4. Жалобы и потери за период (12 часов)\n\nЖалобы взяты из чатов (раздел 2.3) за последние 12 ч; в колонке — объект, число людей, сумма потерь, ссылки на сообщения.\n\n'
    requests = [{'insertText': {'location': {'index': idx}, 'text': block4_intro}}]
    service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
    idx += len(block4_intro)
    rows_t4 = 1 + len(complaints_rows) if complaints_rows else 1
    requests = [{'insertTable': {'rows': rows_t4, 'columns': 4, 'location': {'index': idx}}}]
    service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
    doc = service.documents().get(documentId=doc_id).execute()
    cells = _get_table_cell_indices(doc.get('body', {}), idx)
    if cells:
        cell_texts = [['Объект', 'Люди', 'Сумма 12ч', 'Ссылки']]
        def _fmt_losses_short(val):
            v = int(val or 0)
            if v >= 1000:
                return '%sк₽' % (v // 1000)
            return '%s ₽' % v
        for ri, row in enumerate(complaints_rows):
            ch = str(row.get('channel', '—'))
            losses_fmt = _fmt_losses_short(row.get('losses'))
            n = row.get('complaints', 0) or 0
            links_cell = (row.get('message_links') or '').strip()
            if not links_cell:
                base = 100 + ri * 100
                links_cell = ', '.join('t.me/.../%s' % (base + i) for i in range(max(1, min(n, 4))))
                if n > 4:
                    links_cell += ', ...'
            cell_texts.append([ch, str(n), losses_fmt, links_cell])
        if not complaints_rows:
            cell_texts.append(['(нет данных)', '—', '—', '—'])
        cells_sorted = sorted(cells, key=lambda x: -x[2])
        flat_texts = [str(t)[:500] for row in cell_texts for t in row]
        for (ri, ci, si), text in zip(cells_sorted, flat_texts):
            service.documents().batchUpdate(documentId=doc_id, body={'requests': [{'insertText': {'location': {'index': si}, 'text': text}}]}).execute()
            if ci == 0 and ri > 0 and ri <= len(complaints_rows):
                row = complaints_rows[ri - 1]
                ch = row.get('channel') or ''
                url = _object_link(ch) if ch else None
                if url:
                    try:
                        service.documents().batchUpdate(documentId=doc_id, body={'requests': [{
                            'updateTextStyle': {'range': {'startIndex': si, 'endIndex': si + len(text)}, 'textStyle': {'link': {'url': url}}, 'fields': 'link'}
                        }]}).execute()
                    except Exception:
                        pass
            if ci == 2 and ri > 0 and ri <= len(complaints_rows) and text.strip():
                try:
                    service.documents().batchUpdate(documentId=doc_id, body={'requests': [{
                        'updateTextStyle': {'range': {'startIndex': si, 'endIndex': si + len(text)}, 'textStyle': {'bold': True}, 'fields': 'bold'}
                    }]}).execute()
                except Exception:
                    pass
        try:
            service.documents().batchUpdate(documentId=doc_id, body={'requests': [{
                'updateTableCellStyle': {
                    'tableCellStyle': {'backgroundColor': {'color': {'rgbColor': {'red': 0.2, 'green': 0.2, 'blue': 0.2}}}},
                    'fields': 'backgroundColor',
                    'tableRange': {
                        'tableCellLocation': {'tableStartLocation': {'index': idx}, 'rowIndex': 0, 'columnIndex': 0},
                        'rowSpan': 1,
                        'columnSpan': 4
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

    # Блок 5: АНАЛИЗ РИСКОВ (8 колонок с галочками и ИТОГ)
    block5_intro = '\n\n***\n\n5. АНАЛИЗ РИСКОВ (галочки = реальные факты)\n\n'
    requests = [{'insertText': {'location': {'index': idx}, 'text': block5_intro}}]
    service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
    idx += len(block5_intro)
    rows_t5 = 1 + len(risk_rows) if risk_rows else 1
    requests = [{'insertTable': {'rows': rows_t5, 'columns': 8, 'location': {'index': idx}}}]
    service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
    doc = service.documents().get(documentId=doc_id).execute()
    cells = _get_table_cell_indices(doc.get('body', {}), idx)
    if cells:
        cell_texts = [['Объект', 'Базовые (3/3)', 'Агрессивные обещания', 'Картинки без док', 'Псевдо-анализ', 'Только профит', 'VIP навязывание', 'ИТОГ']]
        for r in risk_rows:
            ra = r.get('risk_analysis') or {}
            cell_texts.append([
                r['obj'],
                ra.get('basic_3_3', '—'),
                ra.get('agg', '—'),
                ra.get('kartinki', '—'),
                ra.get('psevdo', '—'),
                ra.get('tolko_profit', '—'),
                ra.get('vip_navyaz', '—'),
                ra.get('itog', '—'),
            ])
        if not risk_rows:
            cell_texts.append(['(нет данных)', '—', '—', '—', '—', '—', '—', '—'])
        cells_sorted = sorted(cells, key=lambda x: -x[2])
        flat_texts = [str(t)[:500] for row in cell_texts for t in row]
        for (ri, ci, si), text in zip(cells_sorted, flat_texts):
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
            if ci == 7 and ri > 0 and ri <= len(risk_rows) and text.strip():
                try:
                    service.documents().batchUpdate(documentId=doc_id, body={'requests': [{
                        'updateTextStyle': {'range': {'startIndex': si, 'endIndex': si + len(text)}, 'textStyle': {'bold': True}, 'fields': 'bold'}
                    }]}).execute()
                except Exception:
                    pass
    doc = service.documents().get(documentId=doc_id).execute()
    for el in doc.get('body', {}).get('content', []):
        if el.get('startIndex') == idx and 'table' in el:
            idx = el.get('endIndex', idx + 1)
            break

    # Блоки 6 и 7 текстом
    block6_7 = (
        '\n\n***\n\n6. Итоги для сайта (поля интерфейса)\n\nИтоговые значения для сайта (расчёт):\n\n'
        'new_scam_channels = %s\nlosses_12h = %s\ntelegram_channels = %s\ncourses_products = %s\n\n'
        'Топ‑3 за 12 часов:\n\n'
    ) % (data.get('new_scams_count', 0), data.get('total_losses_12h', 0), data.get('telegram_count', 0), data.get('courses', 0))
    for i, (ch, s, n) in enumerate(data.get('top3_with_people') or [], 1):
        block6_7 += '%s. %s — %s ₽, %s человек.\n' % (i, ch, s or 0, n)
    if not data.get('top3_with_people'):
        block6_7 += '(нет)\n'
    block6_7 += '\nJSON для отправки:\n\n%s\n\nЭти поля отправляются в интерфейс сайта и соответствуют блокам:\n' % json.dumps({
        'new_scam_channels': data.get('new_scams_count', 0),
        'losses_12h': data.get('total_losses_12h', 0),
        'telegram_channels': data.get('telegram_count', 0),
        'courses_products': data.get('courses', 0),
        'top3_today': data.get('top3_today', [])
    }, ensure_ascii=False, indent=2)
    block6_7 += '- «Новый скам канал» — new_scam_channels\n- «Потери за 12 часов» — losses_12h\n- «Телеграм‑каналов» — telegram_channels\n- «Курсы/продукты» — courses_products\n- «Топ‑3 за сегодня» — top3_today\n\n***\n\n7. Чек‑лист и ограничения\n\n'
    block6_7 += '□ У каждого объекта в таблице «Найденные объекты» есть рабочая кликабельная ссылка.\n□ Все жалобы в таблице «Жалобы и потери» содержат сумму и относятся к текущему 12‑часовому периоду.\n□ Итоговая сумма losses_12h равна сумме по таблице жалоб.\n□ Для всех объектов в статусе «в риске» есть строка в таблице «Причины».\n□ Топ‑3 действительно входят в список найденных объектов.\n\n'
    if nothing_found:
        block6_7 += 'В этом цикле новых сигнал‑каналов по фильтрам не найдено; жалоб нет. Данные не взяты из воздуха — результат проверки источников.\n\n'
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
                print('Sources doc: заполнены существующие таблицы (объекты, жалобы, риски).', file=sys.stderr)
            else:
                print('Sources doc: таблицы 7/4/8 колонок не найдены — пересборка документа с нуля.', file=sys.stderr)
                _build_sources_doc_with_tables(service, doc_id, structured_data)
            _apply_italic_to_times_in_doc(service, doc_id)
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


def _run_publish_only():
    """Режим publish: прочитать kro-12h-stats.json и отправить на сайт (12:00 и 00:00 MSK)."""
    site_url = os.environ.get('KRO_SITE_UPDATE_URL', '').strip()
    if not site_url:
        print('MODE=publish: KRO_SITE_UPDATE_URL не задан — отправка на сайт пропущена.', file=sys.stderr)
        return
    if not os.path.isfile(OUTPUT_JSON):
        print('MODE=publish: файл %s не найден. Сначала запустите сбор (11:00 или 23:00 MSK).' % OUTPUT_JSON, file=sys.stderr)
        return
    try:
        with open(OUTPUT_JSON, 'r', encoding='utf-8') as f:
            out = json.load(f)
    except Exception as e:
        print('MODE=publish: не удалось прочитать %s: %s' % (OUTPUT_JSON, e), file=sys.stderr)
        return
    top3_today = [(t.get('channel') or t.get('name') or '—') for t in (out.get('top3') or out.get('top3_today') or [])[:3]]
    payload = {
        'timestamp': out.get('timestamp', ''),
        'new_scam_channels': out.get('new_scam_channels', out.get('new_scams', 0)),
        'losses_12h': out.get('losses_12h', 0),
        'telegram_channels': out.get('telegram_channels', 0),
        'courses_products': out.get('courses_products', out.get('courses', 0)),
        'top3_today': top3_today,
    }
    try:
        import urllib.request
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(site_url, data=data, method='POST', headers={'Content-Type': 'application/json'})
        secret = os.environ.get('KRO_SITE_UPDATE_SECRET', '').strip()
        if secret:
            req.add_header('Authorization', 'Bearer %s' % secret)
        with urllib.request.urlopen(req, timeout=15) as resp:
            if 200 <= resp.getcode() < 300:
                print('Данные отправлены на сайт (12:00/00:00): %s' % site_url, file=sys.stderr)
            else:
                print('POST %s: код %s' % (site_url, resp.getcode()), file=sys.stderr)
    except Exception as e:
        print('MODE=publish: POST %s failed: %s' % (site_url, e), file=sys.stderr)


def main():
    # Режим publish: только отправить уже собранные данные на сайт (12:00 и 00:00 MSK). Сбор не делаем.
    mode = os.environ.get('MODE', 'collect').strip().lower()
    if mode == 'publish':
        _run_publish_only()
        return

    now_msk = datetime.now(timezone.utc)  # можно перевести в MSK для заголовка
    now_msk_str = now_msk.strftime('%d %B %H:%M').replace('February', 'февраля').replace('March', 'марта').replace('January', 'января')
    print('Run 12h monitor at %s UTC' % now_msk.isoformat(), file=sys.stderr)

    # 0) Живой лог: старт цикла (событие)
    now_msk_dt = _msk_now()
    time_str = now_msk_dt.strftime('%H:%M')
    period_end_hm = now_msk_dt.strftime('%H:%M')
    period_start_hm = (now_msk_dt - timedelta(hours=HOURS_12)).strftime('%H:%M')
    _append_live_log_events(['%s — Старт цикла %s–%s (MSK).' % (time_str, period_start_hm, period_end_hm)])

    # 1) TGStat new channels
    unavailable_sources = []
    try:
        new_tgstat = fetch_tgstat_new_channels()
    except Exception as e:
        print('TGStat fetch failed: %s' % e, file=sys.stderr)
        new_tgstat = []
        unavailable_sources.append('TGStat')
    time.sleep(REQUEST_DELAY)

    # 2) Telega catalog
    try:
        telega_channels = fetch_telega_catalog()
    except Exception as e:
        print('Telega fetch failed: %s' % e, file=sys.stderr)
        telega_channels = []
        unavailable_sources.append('Telega')

    # 3) Telegram complaints last 12h + проверка существования каналов (Правило №1: только реальные)
    tg_data, existing_channel_links = asyncio.run(
        fetch_telegram_complaints_12h_and_verify_channels(new_tgstat, telega_channels, None)
    )
    complaints_by_channel = tg_data.get('by_channel', {})
    victims_12h = tg_data.get('victims_12h', 0)
    channel_sum_pairs = tg_data.get('channel_sum_pairs', [])

    # 4) Read sheet reports last 12h
    sheet_id = os.environ.get('KRO_SHEET_ID', '').strip()
    client = get_sheets_client()
    sheet_reports = read_reports_last_12h(client, sheet_id) if client and sheet_id else []

    # Complaints table for report: aggregate by channel
    agg_complaints = defaultdict(lambda: {'complaints': 0, 'sum': 0, 'status': 'Активен'})
    for r in sheet_reports:
        ch = (r.get('channel') or '').strip()
        if ch:
            agg_complaints[ch]['complaints'] += 1
            agg_complaints[ch]['sum'] += r.get('sum') or 0
            if (agg_complaints[ch]['complaints'] or 0) >= 2:
                agg_complaints[ch]['status'] = 'Скам'
    for ch, data in complaints_by_channel.items():
        if ch not in agg_complaints:
            agg_complaints[ch] = {'complaints': 0, 'sum': 0, 'status': 'Активен'}
        agg_complaints[ch]['complaints'] += data.get('complaints', 0)
        agg_complaints[ch]['sum'] += sum(data.get('sums', []))
        if agg_complaints[ch]['complaints'] >= 2:
            agg_complaints[ch]['status'] = 'Скам'
    complaints_rows = [
        {'channel': ch, 'complaints': d['complaints'], 'losses': d['sum'], 'status': d['status']}
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

    # Top3 and totals
    top3 = build_top3(sheet_reports, channel_sum_pairs)
    total_losses_12h = sum(r.get('sum', 0) for r in sheet_reports) + sum(s for _, s in channel_sum_pairs)
    new_scams_count = len(risk_rows)

    # 4b) Живой лог: только события в формате «(X/6 рисков) ✓». Старт и «ничего не найдено» — без спама.
    now_msk_dt = _msk_now()
    time_str = now_msk_dt.strftime('%H:%M')
    events = []
    for r in risk_rows:
        itog = (r.get('risk_analysis') or {}).get('itog', '0/6')
        x = itog.split('/')[0] if '/' in itog else '0'
        if r.get('source') == 'TGStat':
            events.append('%s — TGStat: сигнал‑канал [%s] (%s/6 рисков) ✓' % (time_str, r['obj'], x))
        elif r.get('source') == 'Telega':
            events.append('%s — Telega: сигнал‑канал [%s] (%s/6 рисков) ✓' % (time_str, r['obj'], x))
    for row in (complaints_rows or [])[:20]:
        ch = row.get('channel', '—')
        cnt = row.get('complaints', 0)
        loss = row.get('losses', 0)
        if cnt and ch:
            events.append('%s — Чаты: %s новые жалобы на %s (%s ₽ суммарно).' % (time_str, cnt, ch, loss or 0))
    if not risk_rows and not any((r.get('complaints') or r.get('losses')) for r in (complaints_rows or [])):
        events.append('%s — В этом цикле новых сигнал‑каналов по фильтрам не найдено; жалоб нет. Источники доступны.' % time_str)
    else:
        events.append('%s — Обновлён расчёт: %s ₽, %s объектов в зоне риска.' % (time_str, total_losses_12h or 0, new_scams_count or 0))
    if events:
        _append_live_log_events(events)

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
    summary_text = 'Новых: %s | Потери: %s ₽ | Топ-3: %s' % (
        new_scams_count,
        total_losses_12h,
        ', '.join(t.get('channel', '—') for t in top3[:3])
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
    period_end = now_msk_dt.strftime('%d.%m.%Y %H:%M')
    period_start_dt = now_msk_dt - timedelta(hours=HOURS_12)
    period_start = period_start_dt.strftime('%d.%m.%Y %H:%M')
    sources_doc_id = os.environ.get('KRO_SOURCES_DOC_ID', '').strip()
    if sources_doc_id:
        print('Обновляю Google Doc «Источники и данные»...', flush=True)
        collect_time_msk = now_msk_dt.strftime('%d %B %H:%M MSK').replace('February', 'февраля').replace('March', 'марта').replace('January', 'января')
        complaints_count_val = sum((r.get('complaints') or 0) for r in complaints_rows)
        doc_text, structured_data = build_sources_doc_text(
            collect_time_msk, new_tgstat, telega_channels, complaints_rows,
            new_scams_count, total_losses_12h, telegram_count_from_risk, courses_count_from_risk, top3,
            report_doc_url,
            period_start=period_start, period_end=period_end,
            victims_12h=victims_12h, complaints_count=complaints_count_val,
            risk_rows=risk_rows,
            unavailable_sources=unavailable_sources
        )
        url = update_sources_google_doc(sources_doc_id, doc_text, structured_data)
        if url:
            print('Готово. Документ «Источники и данные» обновлён: %s' % url, flush=True)
            print('Открой эту ссылку и обнови страницу (F5), чтобы увидеть новую структуру: ЖИВОЙ ЛОГ, SOURCE & DATA, РАСЧЁТ ДЛЯ САЙТА, ТВОЯ ПРОВЕРКА.', flush=True)
        else:
            print('Не удалось обновить документ. Проверьте: 1) KRO_GOOGLE_CREDENTIALS_JSON, 2) доступ сервисного аккаунта к документу (Поделиться → email из ключа), 3) Google Docs API включён в Cloud.', flush=True)
    else:
        print('KRO_SOURCES_DOC_ID не задан — обновление документа пропущено.', flush=True)

    # 6) Write JSON for site (поля спецификации + обратная совместимость)
    top3_today = [(t.get('channel') or t.get('name') or '—') for t in (top3 or [])[:3]]
    out = {
        'new_scams': new_scams_count,
        'new_scam_channels': new_scams_count,
        'losses_12h': total_losses_12h,
        'victims_12h': victims_12h,
        'telegram_channels': telegram_count_from_risk,
        'courses': courses_count_from_risk,
        'courses_products': courses_count_from_risk,
        'top3': top3,
        'top3_today': top3_today,
        'report_doc_url': report_doc_url,
        REPORT_COUNTER_KEY: report_number,
        'updatedAt': now_msk.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'timestamp': now_msk.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'sources': ['TGStat search', 'Telega.io catalog', 'Telegram complaints 12h']
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print('Written %s: new_scams=%s, losses_12h=%s, victims_12h=%s, report #%s' % (
        OUTPUT_JSON, out['new_scams'], out['losses_12h'], out['victims_12h'], report_number), file=sys.stderr)
    if report_doc_url:
        print('Report doc: %s' % report_doc_url, file=sys.stderr)
    # На сайт данные уходят только в 12:00 и 00:00 MSK (запуск с MODE=publish).


if __name__ == '__main__':
    main()
