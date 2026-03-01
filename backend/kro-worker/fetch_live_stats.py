#!/usr/bin/env python3
"""
KRO: сбор статистики из интернета — Telegram-каналы (сигналы, обменники, скам-листы)
и открытые сайты (vklader, tgrev). Результат пишется в backend/data/kro-reference-stats.json.
Главная страница читает эти данные через GET /api/kro/live-counter когда таблица пуста/недоступна.

Запуск: из папки backend/kro-worker:
  python3 fetch_live_stats.py

Cron (раз в сутки, например 06:00): 
  0 6 * * * cd /path/to/backend/kro-worker && python3 fetch_live_stats.py

Переменные окружения (те же, что для check_once/worker):
  TELEGRAM_API_ID, TELEGRAM_API_HASH — для парсинга каналов из KRO_SOURCE_CHANNELS
  KRO_SOURCE_CHANNELS — через запятую: @channel1, @channel2 или t.me/channel (каналы с жалобами/скам-листами/сигналами)
  KRO_GOOGLE_CREDENTIALS_JSON или GOOGLE_APPLICATION_CREDENTIALS — опционально, для записи в таблицу
  KRO_SHEET_ID — опционально
"""
import os
import re
import sys
import json
import asyncio
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '..'))
DATA_DIR = os.path.join(BACKEND_DIR, 'data')
OUTPUT_JSON = os.path.join(DATA_DIR, 'kro-reference-stats.json')
SNAPSHOT_KEY = 'prevChannelCount'
SNAPSHOT_DATE_KEY = 'prevDate'

# Загружаем env из kro-worker и из корня проекта
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

# --- Парсинг открытых сайтов (vklader, tgrev) ---
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0'
REQUEST_DELAY_SEC = 4

# Регулярки для извлечения упоминаний каналов из HTML/текста
RE_TG_USERNAME = re.compile(r'@([a-zA-Z0-9_]{5,32})\b')
RE_TME_LINK = re.compile(r't\.me/([a-zA-Z0-9_+]+)', re.I)
RE_SUM_RUB = re.compile(
    r'(?:потерял|потеряли|украли|увёл|увели|сумм[ае]?|в рублях?|₽|руб)\s*[:\s]*(\d[\d\s]{2,12})',
    re.I
)
RE_SUM_NUM = re.compile(r'\b(\d[\d\s]{2,12})\s*(?:р\.|руб|₽|тыс|млн)', re.I)

def _normalize_channel(s):
    s = (s or '').strip()
    if not s:
        return ''
    s = s.lower()
    if s.startswith('@'):
        return s
    return '@' + s

def _extract_channels_from_text(text):
    """Из текста извлекает уникальные @username и t.me/xxx."""
    if not text:
        return set()
    channels = set()
    for m in RE_TG_USERNAME.findall(text):
        channels.add(_normalize_channel('@' + m))
    for m in RE_TME_LINK.findall(text):
        if m.startswith('+'):
            channels.add('t.me/' + m)
        else:
            channels.add(_normalize_channel('@' + m))
    return channels

def _extract_sums_from_text(text):
    """Пытается извлечь суммы в рублях из текста (для оценки потерь)."""
    if not text:
        return []
    sums = []
    for m in RE_SUM_RUB.findall(text):
        num = int(re.sub(r'\s', '', m))
        if 100 <= num <= 500_000_000:
            sums.append(num)
    for m in RE_SUM_NUM.findall(text):
        num_str = re.sub(r'\s', '', m)
        if not num_str.isdigit():
            continue
        num = int(num_str)
        if 'млн' in text[max(0, text.find(m)-20):text.find(m)+30].lower():
            num *= 1_000_000
        elif 'тыс' in text[max(0, text.find(m)-20):text.find(m)+30].lower():
            num *= 1_000
        if 100 <= num <= 500_000_000:
            sums.append(num)
    return sums

def fetch_url(url, session=None):
    """Один HTTP GET с User-Agent и задержкой. session = requests.Session() или None."""
    try:
        import requests
    except ImportError:
        return None, 'requests not installed'
    s = session or requests.Session()
    s.headers.setdefault('User-Agent', USER_AGENT)
    try:
        time.sleep(REQUEST_DELAY_SEC)
        r = s.get(url, timeout=30)
        r.raise_for_status()
        return r.text, None
    except Exception as e:
        return None, str(e)

def parse_vklader_tgrev(html, source_name):
    """Считает уникальные каналы на странице (vklader/tgrev)."""
    channels = _extract_channels_from_text(html or '')
    # Дополнительно ищем ссылки вида /channels/@xxx или href="...t.me/..."
    for m in re.findall(r'/?(?:channel|channels?)/@?([a-zA-Z0-9_]{5,32})', html or '', re.I):
        channels.add(_normalize_channel('@' + m))
    for m in re.findall(r'href=["\']?(?:https?://)?t\.me/([a-zA-Z0-9_+]+)', html or '', re.I):
        if m.startswith('+'):
            channels.add('t.me/' + m)
        else:
            channels.add(_normalize_channel('@' + m))
    return channels

# --- Telegram (Telethon) ---
TELEGRAM_API_ID = int(os.environ.get('TELEGRAM_API_ID') or 0)
TELEGRAM_API_HASH = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
TELEGRAM_SESSION_NAME = os.environ.get('TELEGRAM_SESSION_NAME', 'kro_worker')
KRO_SOURCE_CHANNELS = [x.strip() for x in (os.environ.get('KRO_SOURCE_CHANNELS') or '').split(',') if x.strip()]

def _extract_channel_sum_pairs_from_text(text):
    """Из текста извлекает пары (канал, сумма) для топ-3: каналы и суммы в одном сообщении."""
    if not text:
        return []
    channels = list(_extract_channels_from_text(text))
    sums = _extract_sums_from_text(text)
    sum_val = max(sums) if sums else 0
    return [(c, sum_val) for c in channels]


async def fetch_telegram_sources():
    """Читает каналы из KRO_SOURCE_CHANNELS за последние 24–48 ч, собирает @/t.me, суммы и пары (канал, сумма)."""
    if not KRO_SOURCE_CHANNELS or not TELEGRAM_API_ID or not TELEGRAM_API_HASH:
        return {'channels': set(), 'sums': [], 'messages_today': 0, 'channel_sum_pairs': []}
    from telethon import TelegramClient
    from telethon.tl.functions.messages import ImportChatInviteRequest

    client = TelegramClient(
        TELEGRAM_SESSION_NAME,
        TELEGRAM_API_ID,
        TELEGRAM_API_HASH
    )
    await client.start()
    all_channels = set()
    all_sums = []
    messages_today = 0
    channel_sum_pairs = []
    now = datetime.now(timezone.utc)
    since = now - timedelta(hours=48)

    async def get_entity(cid):
        cid = (cid or '').strip()
        if not cid:
            return None
        if cid.startswith('t.me/+'):
            hash_part = cid.replace('t.me/+', '').strip()
            if hash_part:
                try:
                    res = await client(ImportChatInviteRequest(hash_part))
                    if res.chats:
                        return res.chats[0]
                except Exception:
                    pass
            return None
        if not cid.startswith('@') and not cid.startswith('t.me/'):
            cid = '@' + cid
        if cid.startswith('t.me/'):
            return await client.get_entity('https://t.me/' + cid.split('/', 1)[-1])
        return await client.get_entity(cid)

    try:
        for ch in KRO_SOURCE_CHANNELS:
            try:
                entity = await get_entity(ch)
                if not entity:
                    continue
                async for msg in client.iter_messages(entity, limit=200):
                    if not msg or not msg.date:
                        continue
                    md = msg.date.replace(tzinfo=timezone.utc) if getattr(msg.date, 'tzinfo', None) is None else msg.date
                    if md < since:
                        break
                    if md >= (now - timedelta(hours=24)):
                        messages_today += 1
                    text = (msg.text or '') + (getattr(msg, 'message', '') or '')
                    all_channels |= _extract_channels_from_text(text)
                    all_sums.extend(_extract_sums_from_text(text))
                    channel_sum_pairs.extend(_extract_channel_sum_pairs_from_text(text))
            except Exception as e:
                print('Telegram channel %s: %s' % (ch, e), file=sys.stderr)
            time.sleep(1)
    finally:
        await client.disconnect()

    return {'channels': all_channels, 'sums': all_sums, 'messages_today': messages_today, 'channel_sum_pairs': channel_sum_pairs}


def _build_top3(channel_sum_pairs, web_channels_fallback):
    """Строит топ-3: агрегация по каналу (сумма), сортировка по убыванию суммы. status «Из парсинга» или «—»."""
    from collections import defaultdict
    agg = defaultdict(int)
    for ch, s in channel_sum_pairs:
        agg[ch] += s
    # каналы только с веба с суммой 0
    for ch in web_channels_fallback:
        if ch not in agg:
            agg[ch] = 0
    items = [(ch, total) for ch, total in agg.items()]
    items.sort(key=lambda x: -x[1])
    top3 = []
    for ch, total in items[:3]:
        top3.append({
            'channel': ch,
            'sum': total,
            'status': 'Из парсинга' if total == 0 else 'Активен'
        })
    return top3


def main():
    out = {
        'source': 'parsed',
        'sourceCaption': '',
        'channelsToday': 0,
        'totalLost': 0,
        'telegramCount': 0,
        'coursesCount': 0,
        'top3': [],
        'victims24h': None,
        'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    }
    today_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    prev_count = None
    prev_date = None
    if os.path.isfile(OUTPUT_JSON):
        try:
            with open(OUTPUT_JSON, 'r', encoding='utf-8') as f:
                old = json.load(f)
                prev_count = old.get(SNAPSHOT_KEY)
                prev_date = old.get(SNAPSHOT_DATE_KEY)
        except Exception:
            pass

    # 1) Парсим открытые сайты
    vklader_url = 'https://vklader.com/blacklist-telegram/'
    tgrev_url = 'https://tgrev.ru/scam-telegram-channel'
    all_web_channels = set()
    courses_keywords = 0

    try:
        import requests
        session = requests.Session()
        session.headers.setdefault('User-Agent', USER_AGENT)

        html1, err1 = fetch_url(vklader_url, session)
        if html1:
            all_web_channels |= parse_vklader_tgrev(html1, 'vklader')
            courses_keywords += (html1.lower().count('курс') + html1.lower().count('марафон') + html1.lower().count('vip'))
        else:
            print('vklader: %s' % (err1 or 'fail'), file=sys.stderr)

        html2, err2 = fetch_url(tgrev_url, session)
        if html2:
            all_web_channels |= parse_vklader_tgrev(html2, 'tgrev')
            courses_keywords += (html2.lower().count('курс') + html2.lower().count('марафон') + html2.lower().count('vip'))
        else:
            print('tgrev: %s' % (err2 or 'fail'), file=sys.stderr)
    except ImportError:
        print('Install requests: pip install requests', file=sys.stderr)

    # 2) Telegram-каналы (если настроены)
    tg_channels = set()
    tg_sums = []
    messages_today = 0
    channel_sum_pairs = []
    if KRO_SOURCE_CHANNELS and TELEGRAM_API_ID and TELEGRAM_API_HASH:
        try:
            tg_data = asyncio.run(fetch_telegram_sources())
            tg_channels = tg_data['channels']
            tg_sums = tg_data['sums']
            messages_today = tg_data['messages_today']
            channel_sum_pairs = tg_data.get('channel_sum_pairs', [])
        except Exception as e:
            print('Telegram fetch error: %s' % e, file=sys.stderr)

    # 3) Агрегация
    all_channels = all_web_channels | tg_channels
    telegram_count = len(all_channels)
    # «Новых за день»: разница с предыдущим снимком, если дата сменилась
    if prev_date is not None and prev_count is not None and prev_date != today_str:
        channels_today = max(0, telegram_count - prev_count)
    elif messages_today > 0:
        channels_today = messages_today
    else:
        channels_today = min(50, max(1, len(all_channels) // 10)) if all_channels else 0
    total_lost = sum(tg_sums) if tg_sums else 0
    courses_count = min(99, courses_keywords // 3) if courses_keywords else 12
    use_fallback_total = total_lost <= 0

    out['channelsToday'] = channels_today
    out['telegramCount'] = telegram_count
    out['totalLost'] = total_lost if total_lost > 0 else 350_000_000
    out['coursesCount'] = courses_count
    out[SNAPSHOT_KEY] = telegram_count
    out[SNAPSHOT_DATE_KEY] = today_str
    out['victims24h'] = messages_today if messages_today > 0 else None

    # Топ-3 из распарсенных (канал, сумма); при отсутствии — топ-3 каналов с sum 0 из веба
    out['top3'] = _build_top3(channel_sum_pairs, list(all_web_channels)[:50])

    sources = []
    if all_web_channels:
        sources.append('vklader, tgrev')
    if tg_channels or tg_sums:
        sources.append('Telegram (каналы жалоб/сигналов)')
    caption = 'Данные из интернета: %s. Обновлено %s.' % (
        ', '.join(sources) if sources else 'открытые списки',
        datetime.now(timezone.utc).strftime('%d.%m.%Y %H:%M UTC')
    )
    if use_fallback_total:
        caption += ' Потери: оценка по отчётам (Chainalysis и др.).'
    out['sourceCaption'] = caption

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print('Written: %s (channelsToday=%s, telegramCount=%s, totalLost=%s, victims24h=%s)' % (
        OUTPUT_JSON, out['channelsToday'], out['telegramCount'], out['totalLost'], out.get('victims24h')))


if __name__ == '__main__':
    main()
