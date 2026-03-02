#!/usr/bin/env python3
"""
KRO 12h auto-monitor: каждые 12 ч (01:00 и 13:00 MSK) собирает данные из TGStat search,
Telega.io каталога и чатов Telegram; применяет критерии скама; пишет в JSON и лист;
создаёт отчёт в Google Docs.

Источники: 1) TGStat channels/search (криптовалюта), 2) Telega.io catalog, 3) KRO_SOURCE_CHANNELS (жалобы за 12ч).

Запуск: из папки backend/kro-worker:
  python3 run_12h_monitor.py

Cron (01:00 и 13:00 MSK): 
  0 1,13 * * * TZ=Europe/Moscow cd /path/to/backend/kro-worker && python3 run_12h_monitor.py
  или 0 22 * * * и 0 10 * * * (UTC).
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
DAYS_7 = 7

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

# --- TGStat search ---
def fetch_tgstat_new_channels():
    """Поиск каналов по «криптовалюта», сортировка по новизне, отбор за последние 7 дней."""
    try:
        from tgstat_client import search_channels
    except ImportError:
        return []
    items = search_channels('криптовалюта', country='ru', limit=100)
    now = datetime.now(timezone.utc)
    cutoff_7d = now - timedelta(days=DAYS_7)
    out = []
    for x in items:
        created_at = x.get('created_at')
        if created_at is None:
            continue
        try:
            created_dt = datetime.fromtimestamp(created_at, tz=timezone.utc)
            if created_dt < cutoff_7d:
                continue
        except (TypeError, OSError):
            continue
        out.append({
            'channel': x.get('username') or x.get('link') or '—',
            'date': datetime.fromtimestamp(created_at, tz=timezone.utc).strftime('%d.%m.%Y'),
            'growth': x.get('participants_count'),
            'vip': '—',
            'link': x.get('link') or ('https://t.me/' + (x.get('username') or '').lstrip('@')),
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
    """Пометить каналы: скам если жалоб >=2 по каналу или создан <7 дней (уже отфильтровано в TGStat)."""
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

def build_sources_doc_text(collect_time_msk, new_tgstat, telega_channels, complaints_rows,
                           new_scams_count, total_losses_12h, telegram_channels_count,
                           courses, top3, report_url=None):
    lines = [
        '# СКАМ-МОНИТОРИНГ КРИПТО | АВТООТЧЁТ', '',
        '%s → ТВОЯ ПРОВЕРКА (15 мин)' % collect_time_msk, '',
        '——— ГОТОВЫЕ ЦИФРЫ ДЛЯ САЙТА ———', '',
        'Новых скам-каналов | %s' % new_scams_count,
        'Потери за 12 ч | %s ₽' % total_losses_12h,
        'Telegram каналов | %s' % telegram_channels_count,
        'Курсов/продуктов | %s' % courses, '', 'ТОП-3 СЕГОДНЯ:', ''
    ]
    for i, t in enumerate((top3 or [])[:3], 1):
        ch = t.get('channel') or t.get('name') or '—'
        losses = t.get('losses') or t.get('sum') or 0
        complaints = t.get('complaints', 0)
        lines.append('  %s. %s — %s ₽, жалоб: %s' % (i, ch, losses, complaints))
    if not (top3 or []):
        lines.append('  (нет данных)')
    lines.extend(['', '——— SOURCE & DATA ———', ''])
    lines.append('TGStat → %s' % collect_time_msk)
    for row in (new_tgstat or [])[:25]:
        ch, date = row.get('channel', '—'), row.get('date', '—')
        link = row.get('link', 'https://t.me/' + str(ch).lstrip('@'))
        lines.append('  ✓ %s | %s | %s' % (date, ch, link))
    lines.extend(['', 'Telega → %s' % collect_time_msk])
    for row in (telega_channels or [])[:25]:
        lines.append('  ✓ %s | %s' % (row.get('channel', '—'), row.get('link', '—')))
    lines.extend(['', 'ЖАЛОБЫ:'])
    for row in (complaints_rows or [])[:30]:
        lines.append('  %s — жалоб: %s, потери: %s ₽' % (row.get('channel', '—'), row.get('complaints', 0), row.get('losses', 0)))
    lines.extend(['', '——— ЧЕКЛИСТ ———', 'Время сбора: %s' % collect_time_msk, 'Статус: ЖДУ ТВОЕГО ✅ / ❌', ''])
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
        '• TGStat — поиск каналов «криптовалюта», новые за 7 дней.',
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


def update_sources_google_doc(doc_id, doc_text):
    """Пишет в документ «Источники и данные» готовый текст doc_text."""
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

    # 5b) Обновить документ «Источники и данные» — текст собираем здесь
    sources_doc_id = os.environ.get('KRO_SOURCES_DOC_ID', '').strip()
    if sources_doc_id:
        print('Обновляю Google Doc «Источники и данные»...', flush=True)
        now_msk_dt = _msk_now()
        collect_time_msk = now_msk_dt.strftime('%d %B %H:%M MSK').replace('February', 'февраля').replace('March', 'марта').replace('January', 'января')
        doc_text = build_sources_doc_text(
            collect_time_msk, new_tgstat, telega_channels, complaints_rows,
            new_scams_count, total_losses_12h, len(complaints_rows), 0, top3,
            report_doc_url
        )
        url = update_sources_google_doc(sources_doc_id, doc_text)
        if url:
            print('Готово. Документ: %s' % url, flush=True)
        else:
            print('Не удалось обновить документ. Проверьте: 1) KRO_GOOGLE_CREDENTIALS_JSON, 2) доступ сервисного аккаунта к документу (Поделиться → email из ключа), 3) Google Docs API включён в Cloud.', flush=True)
    else:
        print('KRO_SOURCES_DOC_ID не задан — обновление документа пропущено.', flush=True)

    # 6) Write JSON for site
    out = {
        'new_scams': new_scams_count,
        'losses_12h': total_losses_12h,
        'victims_12h': victims_12h,
        'top3': top3,
        'report_doc_url': report_doc_url,
        REPORT_COUNTER_KEY: report_number,
        'updatedAt': now_msk.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'sources': ['TGStat search', 'Telega.io catalog', 'Telegram complaints 12h']
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print('Written %s: new_scams=%s, losses_12h=%s, victims_12h=%s, report #%s' % (
        OUTPUT_JSON, out['new_scams'], out['losses_12h'], out['victims_12h'], report_number), file=sys.stderr)
    if report_doc_url:
        print('Report doc: %s' % report_doc_url, file=sys.stderr)


if __name__ == '__main__':
    main()
