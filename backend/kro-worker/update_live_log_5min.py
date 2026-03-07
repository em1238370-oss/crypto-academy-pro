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
STATE_FILE = os.path.join(DATA_DIR, 'live_log_state.json')
# Строка в документе, которую скрипт заменяет на актуальные строки лога (и снова вставляет в конец для следующего запуска)
PLACEHOLDER = 'События за период — ниже'
MAX_LINES = 50
EMPTY_INTERVAL_MINUTES = 30  # не чаще чем раз в 30 мин писать «новых каналов не найдено»


def _parse_time_and_msg(line):
    """Вернуть (time_str, msg) для строки «HH:MM — текст» или «HH:MM–HH:MM — текст». time_str может быть None."""
    s = (line or '').strip()
    if not s or ' — ' not in s:
        return None, (s or '')
    left, msg = s.split(' — ', 1)
    left = left.strip()
    msg = msg.strip()
    if not left:
        return None, msg
    if '–' in left or '-' in left:
        part = left.replace('-', '–').split('–')[0].strip()
        return part if ':' in part else None, msg
    if len(left) <= 5 and ':' in left:
        return left, msg
    return None, msg


def format_live_log_grouped(lines):
    """Объединить подряд идущие строки с одинаковым текстом в одну: «HH:MM–HH:MM — сообщение». Цифры и сообщения не дублируются."""
    if not lines:
        return []
    parsed = []
    for raw in lines:
        s = (raw or '').strip()
        if not s:
            parsed.append((None, ''))
            continue
        t, msg = _parse_time_and_msg(s)
        if t is None and parsed and parsed[-1][1]:
            t = parsed[-1][0]
        parsed.append((t, msg))
    out = []
    prev_last_time = None
    i = 0
    while i < len(parsed):
        t, msg = parsed[i]
        if msg == '':
            out.append('')
            i += 1
            continue
        first_time = t
        last_time = t
        j = i + 1
        while j < len(parsed) and parsed[j][1] == msg:
            if parsed[j][0]:
                last_time = parsed[j][0]
            j += 1
        if prev_last_time and first_time:
            try:
                ph, pm = int(prev_last_time[:2]), int(prev_last_time[3:5]) if len(prev_last_time) >= 5 else 0
                fh, fm = int(first_time[:2]), int(first_time[3:5]) if len(first_time) >= 5 else 0
                if ph >= 23 and fh <= 1:
                    out.append('——— Новый день ———')
            except (ValueError, TypeError):
                pass
        line = ''
        if first_time and last_time:
            if first_time == last_time:
                line = '%s — %s' % (first_time, msg)
            else:
                line = '%s–%s — %s' % (first_time, last_time, msg)
        elif first_time:
            line = '%s — %s' % (first_time, msg)
        else:
            line = msg
        if line:
            out.append(line)
            prev_last_time = last_time or first_time
        i = j
    return out

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

def get_stats_cached():
    """Вернуть (victims_12h, losses_12h) из kro-12h-stats.json или (0, 0)."""
    path = os.path.join(DATA_DIR, 'kro-12h-stats.json')
    if not os.path.isfile(path):
        return 0, 0
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        v = int(data.get('victims_12h') or data.get('complaints_count') or 0)
        l = int(data.get('losses_12h') or 0)
        return v, l
    except Exception:
        return 0, 0


def get_complaints_cached():
    """Жалобы из последнего kro-12h-stats.json или 0."""
    v, _ = get_stats_cached()
    return v

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
    """Заменить только первое вхождение плейсхолдера на new_content; в последней строке выделить жирным только время (HH:MM)."""
    creds = _get_creds()
    if not creds:
        print('update_live_log_5min: нет учётных данных Google', file=sys.stderr)
        return False
    try:
        from googleapiclient.discovery import build
        service = build('docs', 'v1', credentials=creds)
        P = _find_text_start_index(service, doc_id, PLACEHOLDER)
        if P is None:
            return False
        # Заменяем только первое вхождение, чтобы не дублировать блок при нескольких плейсхолдерах
        requests = [
            {'deleteContentRange': {'range': {'startIndex': P, 'endIndex': P + len(PLACEHOLDER)}}},
            {'insertText': {'location': {'index': P}, 'text': new_content}}
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
        last_line_start = block_start + len_content - len_placeholder - 1 - len(last_line)
        # Жирным только время в начале строки (HH:MM или до " — ")
        time_part = last_line.split(' — ', 1)[0] if ' — ' in last_line else last_line[:5]
        time_len = len(time_part)
        bold_end = last_line_start + time_len
        if last_line_start < 1 or bold_end <= last_line_start or last_line_start >= P:
            return True
        requests2 = [
            {
                'updateTextStyle': {
                    'range': {'startIndex': last_line_start, 'endIndex': bold_end},
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

def load_state():
    """Загрузить последние счётчики и время последнего «ничего не найдено»."""
    if not os.path.isfile(STATE_FILE):
        return None
    try:
        with open(STATE_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def save_state(state):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(STATE_FILE, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=0)


def main():
    now = _msk_now()
    time_str = now.strftime('%H:%M')

    tg = fetch_tgstat_count()
    telega = fetch_telega_count()
    victims, losses = get_stats_cached()

    state = load_state()
    new_line = None

    if state is None:
        save_state({
            'last_tgstat': tg, 'last_telega': telega, 'last_victims': victims, 'last_losses': losses,
            'last_empty_at': None
        })
    else:
        changed = (
            state.get('last_tgstat') != tg or state.get('last_telega') != telega
            or state.get('last_victims') != victims or state.get('last_losses') != losses
        )
        if changed:
            if (state.get('last_losses') != losses or state.get('last_victims') != victims) and (losses or victims):
                new_line = '%s — Обновлён расчёт: потери %s ₽, жалоб %s.' % (time_str, losses, victims)
            elif state.get('last_tgstat') != tg or state.get('last_telega') != telega:
                new_line = '%s — TGStat/Telega: найдено каналов по фильтрам — TGStat %s, Telega %s.' % (time_str, tg, telega)
            else:
                new_line = '%s — Обновление счётчиков: TGStat %s, Telega %s, потери %s ₽.' % (time_str, tg, telega, losses)
            if new_line:
                lines = load_log_lines()
                lines.append(new_line)
                save_log_lines(lines[-MAX_LINES:] if len(lines) > MAX_LINES else lines)
            save_state({
                'last_tgstat': tg, 'last_telega': telega, 'last_victims': victims, 'last_losses': losses,
                'last_empty_at': state.get('last_empty_at')
            })
        else:
            last_empty = state.get('last_empty_at')
            try:
                last_empty_dt = datetime.fromisoformat(last_empty.replace('Z', '+00:00')) if last_empty else None
            except Exception:
                last_empty_dt = None
            if last_empty_dt:
                try:
                    from zoneinfo import ZoneInfo
                    last_empty_dt = last_empty_dt.astimezone(ZoneInfo('Europe/Moscow'))
                except ImportError:
                    last_empty_dt = last_empty_dt + timedelta(hours=3)
            delta_min = (now - last_empty_dt).total_seconds() / 60.0 if last_empty_dt else EMPTY_INTERVAL_MINUTES + 1
            if delta_min >= EMPTY_INTERVAL_MINUTES:
                new_line = '%s — За последние 30 минут новых объектов по фильтрам не найдено, источники доступны.' % time_str
                lines = load_log_lines()
                lines.append(new_line)
                save_log_lines(lines[-MAX_LINES:] if len(lines) > MAX_LINES else lines)
                save_state({
                    'last_tgstat': tg, 'last_telega': telega, 'last_victims': victims, 'last_losses': losses,
                    'last_empty_at': now.isoformat()
                })

    lines = load_log_lines()
    doc_id = os.environ.get('KRO_SOURCES_DOC_ID', '').strip()
    if not doc_id:
        print('KRO_SOURCES_DOC_ID не задан, только запись в %s' % LIVE_LOG_FILE, file=sys.stderr)
        return
    formatted = format_live_log_grouped(lines)
    content = '\n'.join(formatted) + '\n' + PLACEHOLDER
    last_line = formatted[-1] if formatted else (new_line if new_line else None)
    if update_doc_placeholder(doc_id, content, last_line=last_line):
        if last_line:
            print('%s ok (жирным: новая строка): %s' % (time_str, last_line), file=sys.stderr)
        else:
            print('%s ok (документ обновлён)' % time_str, file=sys.stderr)
    else:
        print('%s doc update failed' % time_str, file=sys.stderr)

if __name__ == '__main__':
    main()
