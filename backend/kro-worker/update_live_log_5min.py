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
import warnings
from datetime import datetime, timezone, timedelta

# Убрать из вывода предупреждения библиотек (Python 3.9 EOL, OpenSSL, google-auth и т.д.)
warnings.filterwarnings('ignore', category=FutureWarning)
warnings.filterwarnings('ignore', message='.*OpenSSL.*')
warnings.filterwarnings('ignore', message='.*urllib3.*')

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '..'))
DATA_DIR = os.path.join(BACKEND_DIR, 'data')
LIVE_LOG_FILE = os.path.join(DATA_DIR, 'live_log_5min.json')
STATE_FILE = os.path.join(DATA_DIR, 'live_log_state.json')
# Строка в документе, которую скрипт заменяет на актуальные строки лога (и снова вставляет в конец для следующего запуска)
PLACEHOLDER = 'События за период — ниже'
# Документ по умолчанию (ваш Sources and Data), если KRO_SOURCES_DOC_ID не задан в .env
DEFAULT_SOURCES_DOC_ID = '1VA3Vrt6sak_TXypqBqQalOWeOJHdQm20gz80s6rfi58'
MAX_LINES = 50
EMPTY_INTERVAL_MINUTES = 30  # не чаще чем раз в 30 мин писать «новых каналов не найдено»
# Сутки с 00:00 (12 ночи); данные показываем с этой даты (11 марта 2026 — старт с этого дня)
START_DATE_DDMMYYYY = '11.03.2026'
# В документе показывать только последние N дней лога (1 = только сегодня), чтобы блок не разрастался на 100+ страниц
MAX_DAYS_SHOWN_IN_DOC = 1
GRID_MINUTES = 5  # время округляем до сетки 5 мин (00:00, 00:05, … 23:55)


def _parse_line(line, today_ddmm, has_date_only_format=False):
    """Вернуть (date_ddmm, time_str, msg). date_ddmm = DD.MM.YYYY или None если только HH:MM (старый формат)."""
    s = (line or '').strip()
    if not s or ' — ' not in s:
        return (today_ddmm if has_date_only_format else None, None, (s or ''))
    left, msg = s.split(' — ', 1)
    left = left.strip()
    msg = msg.strip()
    if not left:
        return (None, None, msg)
    time_str = None
    date_str = None
    if re.search(r'\d{1,2}\.\d{1,2}\.\d{4}', left) and re.search(r'\d{1,2}:\d{2}', left):
        parts = left.split(None, 1)
        date_str = parts[0] if parts else None
        time_str = parts[1][:5] if len(parts) > 1 and ':' in parts[1] else None
    elif '–' in left or '-' in left:
        part = left.replace('-', '–').split('–')[0].strip()
        if ':' in part:
            time_str = part[:5]
    elif len(left) >= 5 and ':' in left:
        time_str = left[:5]
    if date_str is None and has_date_only_format:
        date_str = today_ddmm
    return (date_str, time_str, msg)


def format_live_log_grouped(lines):
    """Сортировка по дате и времени (строго по возрастанию), данные с START_DATE_DDMMYYYY; в сутках каждое HH:MM не повторяется; объединение подряд одинаковых сообщений."""
    if not lines:
        return []
    now = _msk_now()
    today_ddmm = now.strftime('%d.%m.%Y')
    parsed = []
    for idx, raw in enumerate(lines):
        s = (raw or '').strip()
        if not s:
            continue
        date_str, time_str, msg = _parse_line(s, today_ddmm, has_date_only_format=False)
        if time_str is None and parsed and parsed[-1][2] == msg:
            time_str = parsed[-1][1]
        parsed.append((date_str, time_str, msg, idx))
    # Только данные с START_DATE_DDMMYYYY (11.03.2026)
    parsed = [(d, t, msg, idx) for (d, t, msg, idx) in parsed if _date_str_ge(START_DATE_DDMMYYYY, d)]
    # В документе показывать только последние MAX_DAYS_SHOWN_IN_DOC дней (1 = только сегодня), чтобы не раздувать блок
    parsed = [(d, t, msg, idx) for (d, t, msg, idx) in parsed if _date_str_within_last_n_days(d, MAX_DAYS_SHOWN_IN_DOC - 1, today_ddmm)]
    if not parsed:
        return []
    def sort_key(x):
        d, t, _, idx = x
        try:
            h, m = (int(t[:2]), int(t[3:5]) if t and len(t) >= 5 else 0) if t and ':' in t else (99, 99)
        except (ValueError, TypeError):
            h, m = 99, 99
        if d is None:
            return (0, 0, 0, h, m, idx)
        try:
            parts = d.split('.')
            if len(parts) == 3:
                day, month, year = int(parts[0]), int(parts[1]), int(parts[2])
                date_ord = (year, month, day)
            else:
                date_ord = (9999, 99, 99)
        except (ValueError, TypeError):
            date_ord = (9999, 99, 99)
        return (date_ord[0], date_ord[1], date_ord[2], h, m, idx)
    parsed.sort(key=sort_key)
    # В одних сутках каждое время (слот 5 мин) не более одного раза — оставляем последнюю запись в слоте
    seen = {}
    for x in reversed(parsed):
        slot = _round_time_str_to_grid(x[1]) if x[1] else x[1]
        key = (x[0], slot)
        if key not in seen:
            seen[key] = x
    parsed = list(seen.values())
    parsed.sort(key=sort_key)
    out = []
    prev_date = None
    prev_last_time = None
    i = 0
    while i < len(parsed):
        date_str, t, msg, _ = parsed[i]
        if msg == '':
            i += 1
            continue
        first_date = date_str
        first_time = t
        last_time = t
        j = i + 1
        while j < len(parsed) and parsed[j][2] == msg and parsed[j][0] == first_date:
            if parsed[j][1]:
                last_time = parsed[j][1]
            j += 1
        if prev_date is not None and first_date is not None and first_date != prev_date:
            out.append('——— Новый день ———')
        elif prev_last_time and first_time:
            try:
                ph = int(prev_last_time[:2])
                fh = int(first_time[:2])
                if ph >= 23 and fh <= 1:
                    out.append('——— Новый день ———')
            except (ValueError, TypeError):
                pass
        prev_date = first_date
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


def _round_time_to_grid(dt, grid_minutes=GRID_MINUTES):
    """Округлить время до сетки 5 мин (00:00, 00:05, … 23:55). Сутки с 00:00."""
    m = (dt.minute // grid_minutes) * grid_minutes
    return dt.replace(minute=m, second=0, microsecond=0)


def _date_str_ge(start_ddmm, date_str):
    """True если date_str >= start_ddmm (формат DD.MM.YYYY)."""
    if not date_str or not re.search(r'\d{1,2}\.\d{1,2}\.\d{4}', date_str):
        return False
    try:
        parts = date_str.split('.')
        start_parts = start_ddmm.split('.')
        if len(parts) != 3 or len(start_parts) != 3:
            return True
        d = (int(parts[2]), int(parts[1]), int(parts[0]))
        s = (int(start_parts[2]), int(start_parts[1]), int(start_parts[0]))
        return d >= s
    except (ValueError, TypeError):
        return True


def _date_str_within_last_n_days(date_str, n_days, today_ddmm):
    """True если date_str в пределах последних n_days включительно (формат DD.MM.YYYY). today_ddmm = сегодня."""
    if not date_str or not re.search(r'\d{1,2}\.\d{1,2}\.\d{4}', date_str):
        return False
    try:
        parts = date_str.split('.')
        today_parts = today_ddmm.split('.')
        if len(parts) != 3 or len(today_parts) != 3:
            return True
        d = datetime(int(parts[2]), int(parts[1]), int(parts[0]))
        t = datetime(int(today_parts[2]), int(today_parts[1]), int(today_parts[0]))
        return 0 <= (t - d).days <= n_days
    except (ValueError, TypeError):
        return True


def _round_time_str_to_grid(time_str, grid_minutes=GRID_MINUTES):
    """Округлить HH:MM до сетки 5 мин (17:33 -> 17:30, 17:38 -> 17:35)."""
    if not time_str or ':' not in time_str:
        return time_str
    try:
        parts = time_str.strip()[:5].split(':')
        h, m = int(parts[0]), int(parts[1])
        m = (m // grid_minutes) * grid_minutes
        return '%02d:%02d' % (h, m)
    except (ValueError, TypeError, IndexError):
        return time_str

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


def _keep_line_on_or_after_date(line, from_ddmm):
    """True если в строке дата >= from_ddmm (DD.MM.YYYY). Строки без даты отбрасываем (старый формат)."""
    s = (line or '').strip()
    if not s or ' — ' not in s:
        return False
    left = s.split(' — ', 1)[0].strip()
    if not re.search(r'\d{1,2}\.\d{1,2}\.\d{4}', left):
        return False
    parts = left.split(None, 1)
    date_str = parts[0] if parts else None
    if not date_str:
        return False
    return _date_str_ge(from_ddmm, date_str)


def trim_log_to_start_date(lines, start_ddmm):
    """Оставить в списке только строки с датой >= start_ddmm. Возвращает новый список."""
    return [ln for ln in lines if _keep_line_on_or_after_date(ln, start_ddmm)]


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


def _find_all_placeholder_ranges(service, doc_id, search_text):
    """Найти все вхождения search_text; вернуть список (startIndex, endIndex)."""
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
        L = len(search_text)
        out = []
        idx = 0
        while True:
            pos = full_text.find(search_text, idx)
            if pos == -1:
                break
            offset = 0
            for seg_start, seg_text in segments:
                if offset + len(seg_text) > pos:
                    start_i = seg_start + (pos - offset)
                    out.append((start_i, start_i + L))
                    break
                offset += len(seg_text)
            idx = pos + 1
        return out
    except Exception:
        return []


def update_doc_placeholder(doc_id, new_content, last_line):
    """Заменить блок лога на new_content: удалить ВЕСЬ старый блок (от первого плейсхолдера до второго включительно),
    чтобы документ не разрастался на сотни страниц. В последней строке выделить жирным только время (HH:MM)."""
    creds = _get_creds()
    if not creds:
        print('update_live_log_5min: нет учётных данных Google', file=sys.stderr)
        return False
    try:
        from googleapiclient.discovery import build
        service = build('docs', 'v1', credentials=creds)
        ranges = _find_all_placeholder_ranges(service, doc_id, PLACEHOLDER)
        if not ranges:
            print('update_live_log_5min: в документе не найден плейсхолдер «%s».' % PLACEHOLDER, file=sys.stderr)
            print('  Откройте документ Sources and Data, вставьте в блок «Обновления каждые 5 мин» строку «%s» (или весь текст из файла Sources-and-Data-ВСТАВИТЬ-В-GOOGLE-DOC.txt), сохраните и запустите скрипт снова.' % PLACEHOLDER, file=sys.stderr)
            return False
        P = ranges[0][0]
        # Удаляем весь накопленный блок: от первого плейсхолдера до конца последнего (или до конца документа), чтобы убрать все старые страницы
        if len(ranges) >= 2:
            delete_end = ranges[-1][1]
        else:
            # Один плейсхолдер: удаляем от него до конца документа (не включая последний символ абзаца — иначе API 400)
            doc = service.documents().get(documentId=doc_id).execute()
            content = doc.get('body', {}).get('content', [])
            delete_end = content[-1].get('endIndex', P + len(PLACEHOLDER)) if content else (P + len(PLACEHOLDER))
            if delete_end > P + 1:
                delete_end -= 1  # не включать newline в конце сегмента — Google Docs API не разрешает
        if delete_end <= P:
            delete_end = P + len(PLACEHOLDER)
        requests = [
            {'deleteContentRange': {'range': {'startIndex': P, 'endIndex': delete_end}}},
            {'insertText': {'location': {'index': P}, 'text': new_content}}
        ]
        for attempt in range(25):
            try:
                service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
                break
            except Exception as err:
                err_str = str(err)
                if '400' in err_str and ('newline' in err_str.lower() or 'segment' in err_str.lower()) and delete_end > P + 1:
                    delete_end -= 1
                    requests[0]['deleteContentRange']['range']['endIndex'] = delete_end
                    continue
                raise
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
    # Обрезать лог до записей с START_DATE_DDMMYYYY (11.03.2026), чтобы убрать старые страницы
    lines = load_log_lines()
    trimmed = trim_log_to_start_date(lines, START_DATE_DDMMYYYY)
    if len(trimmed) < len(lines):
        save_log_lines(trimmed)
        print('update_live_log_5min: лог обрезан до записей с %s (%s строк удалено)' % (START_DATE_DDMMYYYY, len(lines) - len(trimmed)), file=sys.stderr)

    now = _msk_now()
    now_rounded = _round_time_to_grid(now)  # сутки по сетке 00:00, 00:05, … 23:55
    date_str = now_rounded.strftime('%d.%m.%Y')
    time_str = now.strftime('%H:%M')  # для вывода в лог (фактическое время)
    time_str_grid = now_rounded.strftime('%H:%M')
    datetime_prefix = '%s %s' % (date_str, time_str_grid)  # при записи — время по сетке, без повторов в слоте

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
                new_line = '%s — Обновлён расчёт: потери %s ₽, жалоб %s.' % (datetime_prefix, losses, victims)
            elif state.get('last_tgstat') != tg or state.get('last_telega') != telega:
                new_line = '%s — TGStat/Telega: найдено каналов по фильтрам — TGStat %s, Telega %s.' % (datetime_prefix, tg, telega)
            else:
                new_line = '%s — Обновление счётчиков: TGStat %s, Telega %s, потери %s ₽.' % (datetime_prefix, tg, telega, losses)
            if new_line:
                lines = load_log_lines()
                if lines and lines[-1].strip().startswith(datetime_prefix):
                    lines[-1] = new_line  # тот же слот (день + 5 мин) — заменяем, цифры не дублируем
                else:
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
                new_line = '%s — За последние 30 минут новых объектов по фильтрам не найдено, источники доступны.' % datetime_prefix
                lines = load_log_lines()
                if lines and lines[-1].strip().startswith(datetime_prefix):
                    lines[-1] = new_line
                else:
                    lines.append(new_line)
                save_log_lines(lines[-MAX_LINES:] if len(lines) > MAX_LINES else lines)
                save_state({
                    'last_tgstat': tg, 'last_telega': telega, 'last_victims': victims, 'last_losses': losses,
                    'last_empty_at': now.isoformat()
                })

    lines = load_log_lines()
    doc_id = (os.environ.get('KRO_SOURCES_DOC_ID') or '').strip() or DEFAULT_SOURCES_DOC_ID
    if not doc_id:
        print('KRO_SOURCES_DOC_ID не задан, только запись в %s' % LIVE_LOG_FILE, file=sys.stderr)
        return
    formatted = format_live_log_grouped(lines)
    content = '\n'.join(formatted) + '\n' + PLACEHOLDER + '\n\nКанонический источник методологии\nОтчёт «СКАМ‑МОНИТОРИНГ | Source & Data» (PDF / Google Doc).'
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
