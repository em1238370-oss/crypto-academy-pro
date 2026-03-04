#!/usr/bin/env python3
"""
KRO 12h auto-monitor: два цикла в день — 11:00 и 23:00 MSK. Собирает данные из TGStat search,
Telega.io каталога и чатов Telegram; применяет критерии (возраст <14 дн., VIP>10к ₽, рост >500/сутки);
пишет в JSON и лист; создаёт отчёт и документ SOURCE & DATA. К 11:55/23:55 документ готов на проверку;
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
REPORT_COUNTER_KEY = 'lastReportNumber'

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0'
REQUEST_DELAY = 3
HOURS_12 = 12
DAYS_14 = 14   # критерий: канал младше 14 дней
VIP_MIN = 10000   # порог VIP/рекламы, ₽
GROWTH_MIN = 500  # порог роста подписчиков/сутки

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

async def fetch_telegram_complaints_12h():
    """Сообщения из KRO_SOURCE_CHANNELS за последние 12 ч; агрегация по каналу (жалобы, суммы)."""
    if not KRO_SOURCE_CHANNELS or not TELEGRAM_API_ID or not TELEGRAM_API_HASH:
        return {'by_channel': {}, 'victims_12h': 0, 'channel_sum_pairs': []}
    from telethon import TelegramClient
    from telethon.tl.functions.messages import ImportChatInviteRequest

    client = TelegramClient(TELEGRAM_SESSION_NAME, TELEGRAM_API_ID, TELEGRAM_API_HASH)
    await client.start()
    now = datetime.now(timezone.utc)
    since = now - timedelta(hours=HOURS_12)
    by_channel = defaultdict(lambda: {'complaints': 0, 'sums': [], 'messages': 0})
    victims_12h = 0
    channel_sum_pairs = []

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
            time.sleep(1)
    finally:
        await client.disconnect()

    return {'by_channel': dict(by_channel), 'victims_12h': victims_12h, 'channel_sum_pairs': channel_sum_pairs}


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


def build_sources_doc_text(collect_time_msk, new_tgstat, telega_channels, complaints_rows,
                           new_scams_count, total_losses_12h, telegram_channels_count,
                           courses, top3, report_url=None, period_start=None, period_end=None,
                           victims_12h=0, complaints_count=None):
    """Формирует текст документа SOURCE & DATA по спецификации: заголовок, живой лог, SOURCE & DATA 1–3, расчёт, чеклист."""
    if complaints_count is None:
        complaints_count = sum((r.get('complaints') or 0) for r in (complaints_rows or []))
    report_date_str = (period_end or collect_time_msk).split()[0] if period_end else ''

    lines = [
        'Пункт 1. Заголовок и период',
        'СКАМ-МОНИТОРИНГ | Source & Data',
        '',
        'Период: %s – %s' % (period_start or collect_time_msk, period_end or collect_time_msk),
        'Время формирования: %s MSK' % collect_time_msk,
        '',
        'Пункт 2. Живой лог',
        '——— ЖИВОЙ ЛОГ (каждые 5 минут) ———',
        '',
        'START цикла: %s' % (period_start or collect_time_msk),
        'TGStat: %s — проверено каналов: %s' % (collect_time_msk, len(new_tgstat) if new_tgstat else '0'),
        'Telega: %s — проверено каналов: %s' % (collect_time_msk, len(telega_channels) if telega_channels else '0'),
        'Чаты скам: %s — жалоб: %s' % (collect_time_msk, complaints_count if complaints_count is not None else victims_12h),
        'Фильтр: %s по фильтру' % (new_scams_count if new_scams_count else 0),
        'Расчёт: потери %s ₽' % (total_losses_12h if total_losses_12h else 0),
        'ПОИСК ЗАВЕРШЁН: %s' % collect_time_msk,
        '',
        '——— Обновления каждые 5 мин (00:05, 00:10, … 23:55) ———',
        'Обновления каждые 5 мин — см. ниже',
        '',
        'Пункт 3. SOURCE & DATA (полный поиск)',
        '——— SOURCE & DATA ———',
        '',
        '3.1. TGStat.ru поиск (каналы с крипто-сигналами)',
        '   Запрос: «крипто сигналы», «сигналы криптовалюта». В список попадают только каналы, у которых в названии есть тема крипто/сигналов.',
        '   Ссылка: https://tgstat.ru/search?query=крипто+сигналы&sort=date',
        '   Время: %s' % collect_time_msk,
        '   Проверено по теме: %s каналов (остальные отсечены — не про крипто/сигналы)' % (len(new_tgstat) if new_tgstat else 0),
        '   Критерии отбора: возраст <14 дн., в названии — ключевые слова (крипто, сигнал, bitcoin, трейдинг и т.д.); для отметки ✅ дополнительно VIP>10к ₽, рост >500/сутки.',
        ''
    ]
    for row in (new_tgstat or [])[:50]:
        ch = row.get('channel', '—')
        title = row.get('title', '—')
        link = row.get('link', 'https://t.me/' + str(ch).lstrip('@'))
        date = row.get('date', '—')
        growth = row.get('growth')
        growth_str = str(growth) if growth is not None else '—'
        vip_val = row.get('vip')
        if isinstance(vip_val, (int, float)):
            vip_str = '%s' % vip_val
        else:
            vip_str = (vip_val or '—')
        age = _channel_age_days(date, report_date_str)
        if age is not None and age >= DAYS_14:
            mark, reason = '❌', '>14 дней'
        elif age is not None and age < DAYS_14:
            mark = '✅'
            reason = ''
            if isinstance(vip_val, (int, float)) and vip_val < VIP_MIN:
                reason = 'VIP<10к'
            if isinstance(growth, (int, float)) and growth < GROWTH_MIN:
                reason = (reason + ' ' if reason else '') + 'рост<500'
        else:
            mark, reason = '❌', 'нет даты'
        lines.append('%s %s' % (mark, ch))
        lines.append('  Название канала: %s' % (title if title != '—' else '(нет)'))
        lines.append('  Ссылка: %s' % link)
        lines.append('  Дата создания: %s | VIP: %s | Рост: %s' % (date, vip_str, growth_str))
        why = 'Почему выбран: запрос «крипто сигналы»; в названии/username есть тема крипто или сигналов; возраст <14 дн.'
        if reason:
            lines.append('  Причина отклонения по критериям: %s' % reason)
        lines.append('  %s' % why)
        lines.append('')
    lines.extend([
        '3.2. Telega.in поиск',
        '   Каталог «криптовалюты» — все каналы из раздела релевантны теме крипто.',
        '   Ссылка: https://telega.io/catalog/cryptocurrencies',
        '   Время: %s' % collect_time_msk,
        '   Проверено: %s каналов' % (len(telega_channels) if telega_channels else 0),
        '   Почему выбран источник: каталог Telega — раздел криптовалюты, тема совпадает с задачей (крипто/сигналы).',
        ''
    ])
    for row in (telega_channels or [])[:50]:
        ch = row.get('channel', '—')
        link = row.get('link', '—')
        lines.append('✅ %s' % ch)
        lines.append('  Ссылка: %s' % link)
        lines.append('  Почему выбран: каталог «криптовалюты» Telega — релевантен теме.')
        lines.append('')
    lines.extend([
        '3.3. Чаты с жалобами',
        '   Чаты: KRO_SOURCE_CHANNELS',
        '   Количество жалоб: %s' % (complaints_count if complaints_count is not None else victims_12h),
        ''
    ])
    for row in (complaints_rows or [])[:50]:
        ch = row.get('channel', '—')
        complaints = row.get('complaints', 0)
        losses = row.get('losses', 0)
        lines.append('  Канал: %s — жалоб: %s, сумма: %s ₽' % (ch, complaints, losses))
    lines.extend([
        '',
        'Пункт 4. Расчёт для сайта (эти данные уходят на сайт в 12:00 и 00:00)',
        '——— РАСЧЁТ ДЛЯ САЙТА ———',
        '',
        'Новые скам-каналы: %s' % new_scams_count,
        'Потери за 12 ч: %s ₽' % total_losses_12h,
        'Telegram каналов: %s' % telegram_channels_count,
        'Курсов/продуктов: %s' % (courses or 0),
        'ТОП-3 за сегодня:',
        ''
    ])
    for i, t in enumerate((top3 or [])[:3], 1):
        ch = t.get('channel') or t.get('name') or '—'
        losses = t.get('losses') or t.get('sum') or 0
        st = t.get('status', 'Активен')
        lines.append('  %s) %s — %s ₽ — %s' % (i, ch, losses, st))
    if not (top3 or []):
        lines.append('  (нет данных)')
    lines.extend([
        '',
        'Пункт 5. Твоя проверка',
        '——— ТВОЯ ПРОВЕРКА (до 12:00 / до 00:00, затем данные на сайт) ———',
        '',
        '□ Ссылки работают',
        '□ Каналы <14 дней + VIP>10к ₽, рост >500/сутки',
        '□ Жалобы реальные',
        '□ Суммы адекватны',
        '□ Комментарий:',
        ''
    ])
    lines.append(report_url or '(отчёт после 11:00 или 23:00 MSK)')
    return '\n'.join(lines)

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
    """Найти в документе все вхождения regex pattern; вернуть список (startIndex, endIndex) в 1-based индексах."""
    import re
    try:
        doc = service.documents().get(documentId=doc_id).execute()
        body = doc.get('body', {})
        content = body.get('content', [])
        segments = []
        for elem in content:
            if 'paragraph' in elem:
                for pe in elem.get('paragraph', {}).get('elements', []):
                    tr = pe.get('textRun', {})
                    if tr:
                        segments.append((pe.get('startIndex', elem.get('startIndex', 1)), tr.get('content', '')))
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
    except Exception:
        return []

def _apply_italic_to_times_in_doc(service, doc_id):
    """Выделить курсивом все вхождения времени (HH:MM, DD.MM.YYYY HH:MM) в документе."""
    ranges = _find_text_ranges_in_doc(service, doc_id, r'\d{1,2}:\d{2}')
    if not ranges:
        return
    try:
        requests = [
            {'updateTextStyle': {'range': {'startIndex': s, 'endIndex': e}, 'textStyle': {'italic': True}, 'fields': 'italic'}}
            for s, e in ranges
        ]
        service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
    except Exception as e:
        print('Sources doc: курсив для времени: %s' % e, file=sys.stderr)

def update_sources_google_doc(doc_id, doc_text):
    """Пишет в документ «Источники и данные» готовый текст doc_text; время выделяет курсивом."""
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
            # API не позволяет удалять диапазон, включающий \n в конце сегмента — удаляем до последнего символа
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


def main():
    now_msk = datetime.now(timezone.utc)  # можно перевести в MSK для заголовка
    now_msk_str = now_msk.strftime('%d %B %H:%M').replace('February', 'февраля').replace('March', 'марта').replace('January', 'января')
    print('Run 12h monitor at %s UTC' % now_msk.isoformat(), file=sys.stderr)

    # 1) TGStat new channels
    new_tgstat = fetch_tgstat_new_channels()
    time.sleep(REQUEST_DELAY)

    # 2) Telega catalog
    telega_channels = fetch_telega_catalog()

    # 3) Telegram complaints last 12h
    tg_data = asyncio.run(fetch_telegram_complaints_12h())
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

    # Top3 and totals
    top3 = build_top3(sheet_reports, channel_sum_pairs)
    total_losses_12h = sum(r.get('sum', 0) for r in sheet_reports) + sum(s for _, s in channel_sum_pairs)
    new_scams_count = len(new_tgstat) + len([c for c, d in agg_complaints.items() if d.get('status') == 'Скам'])

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
    sources_doc_id = os.environ.get('KRO_SOURCES_DOC_ID', '').strip()
    if sources_doc_id:
        print('Обновляю Google Doc «Источники и данные»...', flush=True)
        now_msk_dt = _msk_now()
        collect_time_msk = now_msk_dt.strftime('%d %B %H:%M MSK').replace('February', 'февраля').replace('March', 'марта').replace('January', 'января')
        period_end = now_msk_dt.strftime('%d.%m.%Y %H:%M')
        period_start_dt = now_msk_dt - timedelta(hours=HOURS_12)
        period_start = period_start_dt.strftime('%d.%m.%Y %H:%M')
        complaints_count_val = sum((r.get('complaints') or 0) for r in complaints_rows)
        doc_text = build_sources_doc_text(
            collect_time_msk, new_tgstat, telega_channels, complaints_rows,
            new_scams_count, total_losses_12h, len(complaints_rows), 0, top3,
            report_doc_url,
            period_start=period_start, period_end=period_end,
            victims_12h=victims_12h, complaints_count=complaints_count_val
        )
        url = update_sources_google_doc(sources_doc_id, doc_text)
        if url:
            print('Готово. Документ «Источники и данные» обновлён: %s' % url, flush=True)
            print('Открой эту ссылку и обнови страницу (F5), чтобы увидеть новую структуру: ЖИВОЙ ЛОГ, SOURCE & DATA, РАСЧЁТ ДЛЯ САЙТА, ТВОЯ ПРОВЕРКА.', flush=True)
        else:
            print('Не удалось обновить документ. Проверьте: 1) KRO_GOOGLE_CREDENTIALS_JSON, 2) доступ сервисного аккаунта к документу (Поделиться → email из ключа), 3) Google Docs API включён в Cloud.', flush=True)
    else:
        print('KRO_SOURCES_DOC_ID не задан — обновление документа пропущено.', flush=True)

    # 6) Write JSON for site (поля спецификации + обратная совместимость)
    courses_val = 0  # курсов/продуктов из листа или 0
    top3_today = [(t.get('channel') or t.get('name') or '—') for t in (top3 or [])[:3]]
    out = {
        'new_scams': new_scams_count,
        'new_scam_channels': new_scams_count,
        'losses_12h': total_losses_12h,
        'victims_12h': victims_12h,
        'telegram_channels': len(complaints_rows),
        'courses': courses_val,
        'courses_products': courses_val,
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

    # 6b) Опционально: POST на сайт (KRO_SITE_UPDATE_URL и при необходимости KRO_SITE_UPDATE_SECRET)
    site_url = os.environ.get('KRO_SITE_UPDATE_URL', '').strip()
    if site_url:
        try:
            import urllib.request
            payload = {
                'timestamp': out['timestamp'],
                'new_scam_channels': new_scams_count,
                'losses_12h': total_losses_12h,
                'telegram_channels': out['telegram_channels'],
                'courses_products': courses_val,
                'top3_today': top3_today,
            }
            data = json.dumps(payload).encode('utf-8')
            req = urllib.request.Request(site_url, data=data, method='POST', headers={'Content-Type': 'application/json'})
            secret = os.environ.get('KRO_SITE_UPDATE_SECRET', '').strip()
            if secret:
                req.add_header('Authorization', 'Bearer %s' % secret)
            with urllib.request.urlopen(req, timeout=15) as resp:
                if 200 <= resp.getcode() < 300:
                    print('POST %s: ok' % site_url, file=sys.stderr)
                else:
                    print('POST %s: %s' % (site_url, resp.getcode()), file=sys.stderr)
        except Exception as e:
            print('POST %s failed: %s' % (site_url, e), file=sys.stderr)


if __name__ == '__main__':
    main()
