#!/usr/bin/env python3
"""
Обновление блока «живой лог каждые 5 мин» в документе SOURCE & DATA.
Запускать по крону каждые 5 минут: */5 * * * *
Время MSK: 00:05, 00:10, 00:15, … 23:55. Каждый запуск подтягивает счётчики и дописывает строку.
Последняя добавленная строка выделяется жирным шрифтом; при следующем обновлении жирной станет только новая строка — так видно, что изменилось.
"""
import os
import sys
import json
import re
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '..'))
DATA_DIR = os.path.join(BACKEND_DIR, 'data')
LIVE_LOG_FILE = os.path.join(DATA_DIR, 'live_log_5min.json')
# Строка в документе, которую скрипт заменяет на актуальные строки лога (и снова вставляет в конец для следующего запуска)
PLACEHOLDER = 'Обновления каждые 5 мин — см. ниже'
MAX_LINES = 50

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0'

def _load_env():
    for base in (SCRIPT_DIR, os.path.normpath(os.path.join(SCRIPT_DIR, '..', '..'))):
        for name in ('.env', 'env'):
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

def _msk_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo('Europe/Moscow'))
    except ImportError:
        return datetime.now(timezone.utc) + timedelta(hours=3)

def fetch_tgstat_count():
    """Количество каналов по запросу «крипто сигналы» (лёгкий запрос)."""
    try:
        from tgstat_client import search_channels
    except ImportError:
        return 0
    try:
        items = search_channels('крипто сигналы', country='ru', limit=50)
        return len(items) if items else 0
    except Exception:
        return 0

def fetch_telega_count():
    """Примерное количество каналов на странице каталога криптовалют."""
    try:
        import requests
    except ImportError:
        return 0
    url = 'https://telega.io/catalog/cryptocurrencies'
    try:
        r = requests.get(url, headers={'User-Agent': USER_AGENT}, timeout=15)
        r.raise_for_status()
        html = r.text or ''
    except Exception:
        return 0
    channels = set()
    for m in re.finditer(r'(?:href=["\']?(?:https?://)?(?:t\.me/|telegram\.me/)([a-zA-Z0-9_+]+)|@([a-zA-Z0-9_]{5,32})\b)', html, re.I):
        g = m.group(1) or m.group(2)
        if g and len(g) >= 4:
            channels.add(g.lower())
    return len(channels)

def get_complaints_cached():
    """Жалобы из последнего kro-12h-stats.json или 0."""
    path = os.path.join(DATA_DIR, 'kro-12h-stats.json')
    if not os.path.isfile(path):
        return 0
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return int(data.get('victims_12h') or data.get('complaints_count') or 0)
    except Exception:
        return 0

def load_log_lines():
    if not os.path.isfile(LIVE_LOG_FILE):
        return []
    try:
        with open(LIVE_LOG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return []

def save_log_lines(lines):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(LIVE_LOG_FILE, 'w', encoding='utf-8') as f:
        json.dump(lines, f, ensure_ascii=False, indent=0)

def _get_creds():
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
    return creds

def _find_text_start_index(service, doc_id, search_text):
    """Найти startIndex подстроки search_text в документе (индексы в API 1-based). Возвращает None если не найдено."""
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
                        run_content = tr.get('content', '')
                        start = pe.get('startIndex', elem.get('startIndex', 1))
                        segments.append((start, run_content))
        full_text = ''.join(s[1] for s in segments)
        idx = full_text.find(search_text)
        if idx == -1:
            return None
        offset = 0
        for seg_start, seg_text in segments:
            if offset + len(seg_text) > idx:
                return seg_start + (idx - offset)
            offset += len(seg_text)
        return None
    except Exception:
        return None

def update_doc_placeholder(doc_id, new_content, last_line):
    """Заменить плейсхолдер в документе на new_content и выделить last_line жирным (последняя строка = новое обновление)."""
    creds = _get_creds()
    if not creds:
        print('update_live_log_5min: нет учётных данных Google', file=sys.stderr)
        return False
    try:
        from googleapiclient.discovery import build
        service = build('docs', 'v1', credentials=creds)
        requests = [
            {
                'replaceAllText': {
                    'containsText': {'text': PLACEHOLDER, 'matchCase': True},
                    'replaceText': new_content
                }
            }
        ]
        service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
        if not last_line:
            return True
        P = _find_text_start_index(service, doc_id, PLACEHOLDER)
        if P is None:
            return True
        len_content = len(new_content)
        len_placeholder = len(PLACEHOLDER)
        block_start = P - len_content + len_placeholder
        # последняя строка в блоке — сразу перед "\n" + PLACEHOLDER
        last_line_start = block_start + len_content - len_placeholder - 1 - len(last_line)
        last_line_end = last_line_start + len(last_line)
        if last_line_start < 1 or last_line_end <= last_line_start or last_line_start >= P:
            return True
        requests2 = [
            {
                'updateTextStyle': {
                    'range': {'startIndex': last_line_start, 'endIndex': last_line_end},
                    'textStyle': {'bold': True},
                    'fields': 'bold'
                }
            }
        ]
        service.documents().batchUpdate(documentId=doc_id, body={'requests': requests2}).execute()
        return True
    except Exception as e:
        print('update_live_log_5min: %s' % e, file=sys.stderr)
        return False

def main():
    now = _msk_now()
    # Округляем до 5 минут: 13:07 -> 13:05
    minute = (now.minute // 5) * 5
    ts = now.replace(minute=minute, second=0, microsecond=0)
    time_str = ts.strftime('%H:%M')

    tg = fetch_tgstat_count()
    telega = fetch_telega_count()
    complaints = get_complaints_cached()
    line = '%s — TGStat: %s каналов (крипто сигналы), Telega: %s, жалоб: %s' % (time_str, tg, telega, complaints)

    lines = load_log_lines()
    lines.append(line)
    lines = lines[-MAX_LINES:]
    save_log_lines(lines)

    doc_id = os.environ.get('KRO_SOURCES_DOC_ID', '').strip()
    if not doc_id:
        print('KRO_SOURCES_DOC_ID не задан, только запись в %s' % LIVE_LOG_FILE, file=sys.stderr)
        return
    # В конце снова вставляем ту же строку, чтобы следующий запуск (через 5 мин) снова нашёл и заменил её
    content = '\n'.join(lines) + '\n' + PLACEHOLDER
    # Последняя строка (только что добавленная) выделяется жирным, чтобы было видно новое обновление
    if update_doc_placeholder(doc_id, content, last_line=line):
        print('%s ok (жирным: новая строка): %s' % (time_str, line), file=sys.stderr)
    else:
        print('%s doc update failed' % time_str, file=sys.stderr)

if __name__ == '__main__':
    main()
