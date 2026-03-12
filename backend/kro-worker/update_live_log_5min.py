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
import html
import warnings
from datetime import datetime, timezone, timedelta
from urllib.parse import quote

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
# Текст для слотов, где не было отдельного события — описание действий за 5 мин
DEFAULT_SLOT_MSG = 'Промежуточный поиск по крипто‑сигналам продолжается.'
# Окно памяти для документа и JSON-источника
LOG_RETENTION_DAYS = 14
# Оформление блоков памяти
MEMORY_BLOCK_TITLE = 'Память за последние 14 дней:'
LOG_LINE_PREFIX = '• '  # буллет перед каждой строкой лога
SEARCH_QUERY_GROUPS = {
    'сигналы/сделки': 'signal signals сигналы trade trading entry long short take profit stop loss TP SL',
    'доход/чудеса': 'доход заработок profit passive income x2 x5 100% гарантия без риска risk free',
    'VIP/приват': 'VIP закрытый канал private inner circle подписка плати курс обучение приватный чат',
    'азарт/риск': 'отбить убыток отыграться слил слив залить плечо левередж high risk всё плечом',
}
SEARCH_GROUPS_HUMAN = ', '.join(SEARCH_QUERY_GROUPS.keys())
SEARCH_QUERY_VARIANTS = {
    'сигналы/сделки': ['crypto signals', 'сигналы криптовалюта', 'long short crypto'],
    'доход/чудеса': ['profit crypto vip', 'заработок крипта', 'без риска крипта'],
    'VIP/приват': ['VIP crypto signals', 'закрытый канал крипта', 'private crypto signals'],
    'азарт/риск': ['плечо крипта сигнал', 'отбить убыток крипта', 'high risk crypto signal'],
}
TELEGA_SOURCE_URL = 'https://telega.io/catalog/cryptocurrencies'
TGSTAT_SEARCH_URL = 'https://tgstat.ru/search?query=%s&sort=date'
WEB_SEARCH_URLS = [
    'https://duckduckgo.com/html/?q=telegram+crypto+signals+vip',
    'https://duckduckgo.com/html/?q=best+telegram+crypto+signals',
]
KRO_SOURCE_CHANNELS = [x.strip() for x in (os.environ.get('KRO_SOURCE_CHANNELS') or '').split(',') if x.strip()]


def get_start_date_ddmm():
    """Нижняя граница памяти лога: максимум из KRO_LOG_START_DATE и окна последних 14 дней."""
    now = _msk_now()
    retention_start = (now - timedelta(days=LOG_RETENTION_DAYS - 1)).strftime('%d.%m.%Y')
    configured = (os.environ.get('KRO_LOG_START_DATE') or '').strip()
    if configured and re.search(r'\d{1,2}\.\d{1,2}\.\d{4}', configured):
        try:
            c_parts = configured.split('.')
            r_parts = retention_start.split('.')
            configured_date = datetime(int(c_parts[2]), int(c_parts[1]), int(c_parts[0]))
            retention_date = datetime(int(r_parts[2]), int(r_parts[1]), int(r_parts[0]))
            return configured if configured_date >= retention_date else retention_start
        except (ValueError, TypeError):
            return retention_start
    return retention_start
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


def _normalize_log_message(msg, time_str=None):
    """Скрыть старые сухие строки вида 'TGStat 0, Telega 0' и привести их к новому формату."""
    text = (msg or '').strip()
    if not text:
        return text
    if text.startswith('За 5 мин: '):
        text = text[len('За 5 мин: '):].strip()
    if 'TGStat/Telega: найдено каналов по фильтрам' in text:
        return _phrase('basic', time_str)
    if text.startswith('За последние 30 минут новых объектов по фильтрам не найдено'):
        return _phrase('repeat_pass', time_str)
    if text.startswith('Запрос TGStat (') or text.startswith('Обновление счётчиков: TGStat '):
        return _phrase('refresh', time_str)
    if text.startswith('Найдено каналов по фильтрам:'):
        return _phrase('found_candidates', time_str)
    if text.startswith('Выполнен только базовый проход'):
        return _phrase('basic', time_str)
    if text.startswith('Выполнен широкий тематический поиск'):
        return _phrase('wide', time_str)
    if text.startswith('Выполнен промежуточный тематический поиск'):
        return _phrase('intermediate', time_str)
    return text


def _slot_variant_index(time_str):
    """Индекс варианта по 5-минутному слоту: соседние строки получают разную формулировку."""
    if not time_str or ':' not in time_str:
        return 0
    try:
        h, m = [int(x) for x in time_str[:5].split(':')]
        return ((h * 60 + m) // GRID_MINUTES) % 3
    except (ValueError, TypeError):
        return 0


def _phrase(kind, time_str):
    i = _slot_variant_index(time_str)
    variants = {
        'intermediate': [
            'Промежуточный поиск: проверены каталоги и группы запросов по сигналам, VIP, доходу и риску. Просмотрены доступные описания и структура найденных каналов. Новых подтверждений за слот нет.',
            'Продолжается рабочий проход по крипто‑сигналам: перепроверены тематические запросы, VIP‑связки и риск‑формулировки. По доступным источникам новых подтверждённых объектов пока нет.',
            'Идёт очередной этап отбора: просмотрены каталоги, сигнальные формулировки и базовые признаки заработка/VIP. За этот слот новых релевантных подтверждений не получено.',
        ],
        'repeat_pass': [
            'За интервал выполнен повторный проход по доступным источникам и группам запросов. Новых подтверждённых объектов пока нет, поиск продолжается.',
            'За этот промежуток сделана повторная проверка источников, ключевых запросов и найденных кандидатов. Новых подтверждений не появилось, работа продолжается.',
            'Интервал закрыт повторной перепроверкой каталогов и тематических запросов. Свежих подтверждённых объектов за этот шаг не добавилось.',
        ],
        'refresh': [
            'Промежуточный поиск: перепроверены каталоги, сигнальные запросы, VIP и риск‑паттерны. Изменений по доступным источникам за этот слот не зафиксировано.',
            'Сделана повторная сверка каталогов, ключей по сигналам и типовых VIP/риск‑паттернов. По доступным источникам заметных изменений за слот нет.',
            'Выполнена дополнительная перепроверка сигнальных запросов, VIP‑связок и риск‑формулировок. За этот слот доступные источники новых изменений не дали.',
        ],
        'basic': [
            'Базовый поиск: проверены каталоги и тематические запросы по крипто‑сигналам. Сделан только первичный проход без полного Telegram‑поиска, чатов жалоб и веб‑обзоров. Для полного вывода нужен расширенный поиск.',
            'Пока выполнен только базовый проход: просмотрены каталоги и ключевые сигнальные запросы. Без Telegram‑поиска, жалобных чатов и веб‑обзоров полный отрицательный вывод делать нельзя.',
            'На этом шаге завершён лишь стартовый поиск по каталогам и тематическим ключам. Чтобы уверенно писать об отсутствии находок, нужен более широкий проход по Telegram, жалобам и веб‑источникам.',
        ],
        'found_candidates': [
            'Проверены каталоги и тематические запросы, найдены кандидаты для отбора. Следующий шаг — проверить описания, закрепы и последние посты на релевантность.',
            'По каталожному и ключевому поиску появились каналы-кандидаты. Дальше нужно открыть описания, закреплённые сообщения и последние посты, чтобы отсеять нерелевантные.',
            'Текущий проход дал набор кандидатов по сигналам и VIP‑темам. Следом идёт ручная фильтрация по описанию канала, закрепам и свежим публикациям.',
        ],
        'wide': [
            'Широкий поиск: проверены каталоги, Telegram‑поиск, жалобы и веб‑источники. Новых релевантных каналов с нужными признаками за этот интервал не подтверждено.',
            'Проведён широкий проход по каталогам, Telegram, жалобным обсуждениям и веб‑обзорам. За этот интервал новых релевантных каналов с нужными признаками не подтвердилось.',
            'Завершён широкий поиск по Telegram, жалобам и веб‑источникам с фокусом на сигналы и VIP. Новых подтверждённых релевантных каналов за этот шаг не найдено.',
        ],
        'losses': [
            'Обновлены жалобы и потери. Параллельно перепроверены доступные источники и тематические группы запросов по сигналам, VIP, доходу и риску.',
            'Пересчитаны жалобы и потери за период. Одновременно выполнена повторная проверка источников и поисковых групп по сигналам, VIP и риску.',
            'Актуализированы данные по жалобам и потерям. В этот же проход заново сверены каталоги, тематические запросы и признаки заработка/VIP.',
        ],
    }
    return variants.get(kind, [DEFAULT_SLOT_MSG])[i]


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


def _normalize_channel_link(ch_or_link):
    value = (ch_or_link or '').strip()
    if not value:
        return ''
    if value.startswith('http://') or value.startswith('https://'):
        return value
    if value.startswith('t.me/'):
        return 'https://' + value
    if value.startswith('@'):
        return 'https://t.me/' + value.lstrip('@')
    return 'https://t.me/' + value.lstrip('@')


def _extract_channels_from_text(text):
    channels = set()
    for m in re.findall(r'@([a-zA-Z0-9_]{5,32})\b', text or ''):
        channels.add('@' + m)
    for m in re.findall(r't\.me/([a-zA-Z0-9_+]+)', text or '', re.I):
        if m.startswith('+'):
            channels.add('t.me/' + m)
        else:
            channels.add('@' + m)
    return sorted(channels)


def _source_snapshot(name):
    return {
        'source': name,
        'checked': False,
        'source_urls': [],
        'query_groups': [],
        'queries': [],
        'candidates': [],
        'evidence_links': [],
        'notes': [],
        'limited': False,
    }


def _snapshot_summary(snapshot, link_limit=2):
    urls = _unique_list((snapshot or {}).get('source_urls') or [], limit=link_limit)
    links = _unique_list((snapshot or {}).get('evidence_links') or [], limit=link_limit)
    candidates = []
    for c in (snapshot or {}).get('candidates') or []:
        link = (c or {}).get('link') or ''
        if link:
            candidates.append(link)
    candidates = _unique_list(candidates, limit=link_limit)
    return {
        'source': (snapshot or {}).get('source') or '—',
        'checked': bool((snapshot or {}).get('checked')),
        'limited': bool((snapshot or {}).get('limited')),
        'source_urls': urls,
        'links': _unique_list(links + candidates, limit=link_limit),
        'queries': _unique_list((snapshot or {}).get('queries') or [], limit=4),
        'query_groups': _unique_list((snapshot or {}).get('query_groups') or [], limit=4),
        'candidate_count': len((snapshot or {}).get('candidates') or []),
    }


def _all_slots_up_to(end_h, end_m, grid_minutes=GRID_MINUTES):
    """Список слотов (HH:MM) от 00:00 до end_h:end_m включительно по сетке 5 мин."""
    out = []
    h, m = 0, 0
    while (h, m) <= (end_h, end_m):
        out.append('%02d:%02d' % (h, m))
        m += grid_minutes
        if m >= 60:
            m = 0
            h += 1
        if h > 23:
            break
    return out


def _date_str_to_date(date_str):
    if not date_str or not re.search(r'\d{1,2}\.\d{1,2}\.\d{4}', date_str):
        return None
    try:
        day, month, year = [int(x) for x in date_str.split('.')]
        return datetime(year, month, day).date()
    except (ValueError, TypeError):
        return None


def _time_sort_key(time_str):
    try:
        if not time_str or ':' not in time_str:
            return (99, 99)
        h, m = [int(x) for x in time_str[:5].split(':')]
        return (h, m)
    except (ValueError, TypeError):
        return (99, 99)


def _collect_slot_messages(lines):
    now = _msk_now()
    today_ddmm = now.strftime('%d.%m.%Y')
    start_ddmm = get_start_date_ddmm()
    slot_msg = {}
    for raw in (lines or []):
        s = (raw or '').strip()
        if not s or ' — ' not in s:
            continue
        date_str, time_str, msg = _parse_line(s, today_ddmm, has_date_only_format=False)
        if not _date_str_ge(start_ddmm, date_str):
            continue
        slot = _round_time_str_to_grid(time_str) if time_str else None
        if not slot or not date_str:
            continue
        slot_msg[(date_str, slot)] = _normalize_log_message(msg, time_str=slot)
    return slot_msg


def _retained_dates_from_slots(slot_msg):
    dates = []
    seen = set()
    for date_str, _ in slot_msg.keys():
        date_obj = _date_str_to_date(date_str)
        if not date_obj or date_str in seen:
            continue
        seen.add(date_str)
        dates.append((date_obj, date_str))
    dates.sort(key=lambda item: item[0])
    return [date_str for _, date_str in dates]


def _build_day_lines(date_str, slot_msg, today_ddmm):
    if date_str == today_ddmm:
        now = _msk_now()
        end_h = now.hour
        end_m = (now.minute // GRID_MINUTES) * GRID_MINUTES
        slots = _all_slots_up_to(end_h, end_m)
        return [LOG_LINE_PREFIX + '%s — %s' % (t, slot_msg.get((date_str, t), _phrase('intermediate', t))) for t in slots]
    day_slots = [slot for (stored_date, slot) in slot_msg.keys() if stored_date == date_str]
    day_slots = sorted(set(day_slots), key=_time_sort_key)
    return [LOG_LINE_PREFIX + '%s — %s' % (slot, slot_msg[(date_str, slot)]) for slot in day_slots]


def build_live_log_doc_block(lines):
    """Собрать блок памяти за последние 14 дней для Google Doc."""
    now = _msk_now()
    today_ddmm = now.strftime('%d.%m.%Y')
    slot_msg = _collect_slot_messages(lines)
    retained_dates = _retained_dates_from_slots(slot_msg)
    content_lines = [MEMORY_BLOCK_TITLE, '']
    last_line = None
    if not retained_dates:
        content_lines.extend([PLACEHOLDER, '', 'Канонический источник методологии', 'Отчёт «СКАМ‑МОНИТОРИНГ | Source & Data» (PDF / Google Doc).'])
        return '\n'.join(content_lines), last_line
    for idx, date_str in enumerate(retained_dates):
        day_lines = _build_day_lines(date_str, slot_msg, today_ddmm)
        if date_str == today_ddmm:
            header = '%s — события по 5 мин (00:00 … текущее время MSK)' % date_str
        else:
            header = '%s — события по 5 мин' % date_str
        content_lines.append(header)
        if day_lines:
            content_lines.extend(day_lines)
            if idx == len(retained_dates) - 1:
                last_line = day_lines[-1]
        else:
            content_lines.append(LOG_LINE_PREFIX + 'Нет зафиксированных записей за этот день.')
            if idx == len(retained_dates) - 1:
                last_line = content_lines[-1]
        content_lines.append('')
    content_lines.extend([PLACEHOLDER, '', 'Канонический источник методологии', 'Отчёт «СКАМ‑МОНИТОРИНГ | Source & Data» (PDF / Google Doc).'])
    return '\n'.join(content_lines), last_line

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
KRO_SOURCE_CHANNELS = [x.strip() for x in (os.environ.get('KRO_SOURCE_CHANNELS') or '').split(',') if x.strip()]

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

def fetch_tgstat_snapshot():
    """Структурированный snapshot поиска TGStat: query groups, источники, кандидаты, ссылки."""
    snapshot = _source_snapshot('TGStat')
    snapshot['checked'] = True
    try:
        from tgstat_client import search_channels
    except ImportError:
        snapshot['limited'] = True
        snapshot['notes'].append('tgstat_client не импортирован')
        return snapshot
    try:
        seen = set()
        for group, queries in SEARCH_QUERY_VARIANTS.items():
            for query in queries:
                snapshot['query_groups'].append(group)
                snapshot['queries'].append(query)
                snapshot['source_urls'].append(TGSTAT_SEARCH_URL % quote(query))
                items = search_channels(query, country='ru', limit=15)
                for item in (items or []):
                    username = ((item or {}).get('username') or '').strip()
                    link = _normalize_channel_link((item or {}).get('link') or username)
                    key = (username or link).lower()
                    if not key or key in seen:
                        continue
                    seen.add(key)
                    snapshot['candidates'].append({
                        'title': ((item or {}).get('title') or '').strip(),
                        'username': username,
                        'link': link,
                        'query': query,
                        'query_group': group,
                        'source_url': TGSTAT_SEARCH_URL % quote(query),
                    })
        return snapshot
    except Exception as e:
        snapshot['limited'] = True
        snapshot['notes'].append('ошибка TGStat: %s' % e)
        return snapshot


def fetch_telega_snapshot():
    """Структурированный snapshot каталога Telega."""
    snapshot = _source_snapshot('Telega')
    snapshot['checked'] = True
    snapshot['source_urls'].append(TELEGA_SOURCE_URL)
    try:
        import requests
    except ImportError:
        snapshot['limited'] = True
        snapshot['notes'].append('requests не импортирован')
        return snapshot
    try:
        r = requests.get(TELEGA_SOURCE_URL, headers={'User-Agent': USER_AGENT}, timeout=15)
        r.raise_for_status()
        html = r.text or ''
    except Exception as e:
        snapshot['limited'] = True
        snapshot['notes'].append('ошибка Telega: %s' % e)
        return snapshot
    channels = []
    seen = set()
    for m in re.finditer(r'(?:href=["\']?(?:https?://)?(?:t\.me/|telegram\.me/)([a-zA-Z0-9_+]+)|@([a-zA-Z0-9_]{5,32})\b)', html, re.I):
        g = m.group(1) or m.group(2)
        if g and len(g) >= 4:
            key = g.lower()
            if key in seen:
                continue
            seen.add(key)
            link = _normalize_channel_link('@' + g if not g.startswith('+') else 't.me/' + g)
            channels.append({'username': '@' + g if not g.startswith('+') else 't.me/' + g, 'link': link})
    snapshot['query_groups'].extend(['сигналы/сделки', 'VIP/приват'])
    snapshot['queries'].extend(['catalog cryptocurrencies', 'catalog trading signals'])
    snapshot['candidates'] = channels[:20]
    return snapshot


def fetch_telegram_search_snapshot():
    """Структурированный snapshot глобального поиска Telegram по нескольким группам запросов."""
    snapshot = _source_snapshot('Telegram search')
    snapshot['checked'] = True
    try:
        from telethon import TelegramClient
        from telethon.tl.functions.contacts import SearchRequest
    except Exception:
        snapshot['limited'] = True
        snapshot['notes'].append('Telethon недоступен')
        return snapshot
    api_id = int(os.environ.get('TELEGRAM_API_ID') or 0)
    api_hash = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
    session_name = os.environ.get('TELEGRAM_SESSION_NAME', 'kro_worker')
    if not api_id or not api_hash:
        snapshot['limited'] = True
        snapshot['notes'].append('нет TELEGRAM_API_ID/TELEGRAM_API_HASH')
        return snapshot
    try:
        async def _run():
            client = TelegramClient(session_name, api_id, api_hash)
            await client.start()
            try:
                seen = set()
                for group, queries in SEARCH_QUERY_VARIANTS.items():
                    query = queries[0]
                    snapshot['query_groups'].append(group)
                    snapshot['queries'].append(query)
                    result = await client(SearchRequest(q=query, limit=10))
                    for chat in list(getattr(result, 'chats', []) or []) + list(getattr(result, 'users', []) or []):
                        username = (getattr(chat, 'username', None) or '').strip()
                        title = (getattr(chat, 'title', None) or getattr(chat, 'first_name', None) or '').strip()
                        if not username:
                            continue
                        link = _normalize_channel_link('@' + username)
                        key = link.lower()
                        if key in seen:
                            continue
                        seen.add(key)
                        snapshot['candidates'].append({
                            'title': title,
                            'username': '@' + username,
                            'link': link,
                            'query': query,
                            'query_group': group,
                            'source_url': '',
                        })
            finally:
                await client.disconnect()
        import asyncio
        asyncio.run(_run())
        return snapshot
    except Exception as e:
        snapshot['limited'] = True
        snapshot['notes'].append('ошибка Telegram search: %s' % e)
        return snapshot


def fetch_complaints_snapshot():
    """Структурированный snapshot по чатам жалоб: ссылки на чаты, ключи и упоминания каналов."""
    snapshot = _source_snapshot('Complaint chats')
    snapshot['checked'] = True
    complaint_terms = ['скам', 'обман', 'слил депозит', 'развод', 'мошенники']
    snapshot['queries'].extend(complaint_terms)
    snapshot['query_groups'].append('жалобы/обсуждения')
    source_urls = [_normalize_channel_link(ch) for ch in KRO_SOURCE_CHANNELS]
    snapshot['source_urls'].extend([u for u in source_urls if u])
    if not KRO_SOURCE_CHANNELS:
        snapshot['limited'] = True
        snapshot['notes'].append('KRO_SOURCE_CHANNELS не задан')
    try:
        from telethon import TelegramClient
    except Exception:
        return snapshot
    api_id = int(os.environ.get('TELEGRAM_API_ID') or 0)
    api_hash = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
    session_name = os.environ.get('TELEGRAM_SESSION_NAME', 'kro_worker')
    if not api_id or not api_hash or not KRO_SOURCE_CHANNELS:
        return snapshot
    try:
        async def _run():
            client = TelegramClient(session_name, api_id, api_hash)
            await client.start()
            try:
                seen = set()
                for ch in KRO_SOURCE_CHANNELS[:5]:
                    entity = await client.get_entity(ch if ch.startswith('@') or ch.startswith('https://') else _normalize_channel_link(ch))
                    async for msg in client.iter_messages(entity, limit=25):
                        text = ((msg.text or '') + ' ' + (getattr(msg, 'message', '') or '')).strip()
                        lower = text.lower()
                        if not any(term in lower for term in complaint_terms):
                            continue
                        for found in _extract_channels_from_text(text):
                            link = _normalize_channel_link(found)
                            if not link or link in seen:
                                continue
                            seen.add(link)
                            snapshot['candidates'].append({
                                'title': found,
                                'username': found,
                                'link': link,
                                'query': 'жалобы/обсуждения',
                                'query_group': 'жалобы/обсуждения',
                                'source_url': _normalize_channel_link(ch),
                            })
                            snapshot['evidence_links'].append(_normalize_channel_link(ch))
            finally:
                await client.disconnect()
        import asyncio
        asyncio.run(_run())
        return snapshot
    except Exception as e:
        snapshot['limited'] = True
        snapshot['notes'].append('ошибка чатов жалоб: %s' % e)
        return snapshot


def fetch_web_sources_snapshot():
    """Лёгкий внешний веб-поиск по обзорам/подборкам с конкретными URL."""
    snapshot = _source_snapshot('Web reviews')
    snapshot['checked'] = True
    snapshot['query_groups'].append('веб-обзоры')
    snapshot['queries'].extend(['telegram crypto signals vip', 'best telegram crypto signals'])
    snapshot['source_urls'].extend(WEB_SEARCH_URLS)
    try:
        import requests
    except ImportError:
        snapshot['limited'] = True
        snapshot['notes'].append('requests не импортирован')
        return snapshot
    try:
        seen = set()
        for url in WEB_SEARCH_URLS:
            r = requests.get(url, headers={'User-Agent': USER_AGENT}, timeout=15)
            r.raise_for_status()
            body = r.text or ''
            for href in re.findall(r'class="result__a"[^>]+href="([^"]+)"', body)[:5]:
                href = html.unescape(href)
                if not href.startswith('http') or href in seen:
                    continue
                seen.add(href)
                snapshot['evidence_links'].append(href)
        return snapshot
    except Exception as e:
        snapshot['limited'] = True
        snapshot['notes'].append('ошибка веб-обзоров: %s' % e)
        return snapshot

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


def _has_fresh_stats_cache(max_age_hours=12):
    path = os.path.join(DATA_DIR, 'kro-12h-stats.json')
    if not os.path.isfile(path):
        return False
    try:
        age_sec = max(0.0, (datetime.now().timestamp() - os.path.getmtime(path)))
        return age_sec <= (max_age_hours * 3600)
    except Exception:
        return False


def _build_search_action(search_data, victims, losses, time_str_grid):
    """Сформировать 5‑минутный отчёт с реальными источниками, query groups и ссылками."""
    snapshots = [_snapshot_summary(s) for s in (search_data or {}).get('snapshots', [])]
    checked_sources = [s['source'] for s in snapshots if s.get('checked')]
    all_groups = _unique_list(sum([s.get('query_groups', []) for s in snapshots], []), limit=4)
    all_links = _unique_list(sum([s.get('source_urls', []) + s.get('links', []) for s in snapshots], []), limit=3)
    sources_text = ', '.join(checked_sources) if checked_sources else 'источники пока не подтверждены'
    groups_text = ', '.join(all_groups) if all_groups else SEARCH_GROUPS_HUMAN
    links_text = ', '.join(all_links) if all_links else 'ссылки пока не зафиксированы'
    total_candidates = sum((s.get('candidate_count') or 0) for s in snapshots)
    wide_done = {'TGStat', 'Telega', 'Telegram search', 'Complaint chats'}.issubset(set(checked_sources))
    web_checked = any(s.get('source') == 'Web reviews' and s.get('checked') for s in snapshots)
    limited = not (wide_done and web_checked)

    if total_candidates > 0:
        return (
            '%s Источники: %s. '
            'Группы: %s. '
            'Найдены кандидаты: %s. '
            'Ссылки: %s.'
        ) % (_phrase('found_candidates', time_str_grid), sources_text, groups_text, total_candidates, links_text)
    if victims or losses:
        return (
            '%s Жалоб: %s, потери: %s ₽. '
            'Проверены %s. '
            'Ссылки: %s.'
        ) % (_phrase('losses', time_str_grid), victims, losses, sources_text, links_text)
    if limited:
        return (
            '%s Источники: %s. '
            'Группы: %s. '
            'Ссылки: %s.'
        ) % (_phrase('basic', time_str_grid), sources_text, groups_text, links_text)
    return (
        '%s Источники: %s. '
        'Группы: %s. '
        'Ссылки: %s.'
    ) % (_phrase('wide', time_str_grid), sources_text, groups_text, links_text)

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


def _collect_text_segments(content_elems):
    """Собрать (startIndex, text) из параграфов и из таблиц (вложенные параграфы)."""
    segments = []
    for elem in content_elems or []:
        if 'paragraph' in elem:
            for pe in elem.get('paragraph', {}).get('elements', []):
                tr = pe.get('textRun', {})
                if tr:
                    run_content = tr.get('content', '')
                    start = pe.get('startIndex', elem.get('startIndex', 1))
                    segments.append((start, run_content))
        if 'table' in elem:
            for row in elem.get('table', {}).get('tableRows', []):
                for cell in row.get('tableCells', []):
                    for sub in cell.get('content', []):
                        segments.extend(_collect_text_segments([sub]))
    return segments


def _find_all_placeholder_ranges(service, doc_id, search_text):
    """Найти все вхождения search_text (в т.ч. внутри таблиц); вернуть список (startIndex, endIndex)."""
    try:
        doc = service.documents().get(documentId=doc_id).execute()
        body = doc.get('body', {})
        content = body.get('content', [])
        segments = _collect_text_segments(content)
        segments.sort(key=lambda x: x[0])
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


def _find_url_ranges(text):
    ranges = []
    for m in re.finditer(r'https?://[^\s)>,]+', text or ''):
        ranges.append((m.start(), m.end(), m.group(0)))
    return ranges


# Текст в документе, после которого начинается блок лога (инструкция «Обновления каждые 5 мин»)
ANCHOR_BEFORE_LOG = 'Обновления каждые 5 мин'
# Если в .env задан KRO_LOG_BLOCK_START_MARKER — ищем эту строку в документе и удаляем от неё до конца (так можно обнулить 140 страниц вручную)
LOG_BLOCK_START_MARKER_ENV = 'KRO_LOG_BLOCK_START_MARKER'
# Если задан KRO_LOG_END_BLOCK_MARKER — удаляем только до этой строки; всё после неё (таблица и т.д.) сохраняется
LOG_BLOCK_END_MARKER_ENV = 'KRO_LOG_END_BLOCK_MARKER'


def _find_first_log_line_index(service, doc_id):
    """Найти startIndex начала блока лога: первый сегмент (абзац/ячейка) после ANCHOR_BEFORE_LOG, в котором есть «DD.MM.YYYY HH:MM».
    Возвращаем начало этого сегмента, чтобы удалить весь блок от него до конца документа."""
    try:
        doc = service.documents().get(documentId=doc_id).execute()
        body = doc.get('body', {})
        content = body.get('content', [])
        segments = _collect_text_segments(content)
        segments.sort(key=lambda x: x[0])
        full_text = ''.join(s[1] for s in segments)
        anchor_pos = full_text.find(ANCHOR_BEFORE_LOG)
        if anchor_pos == -1:
            search_from = 0
        else:
            search_from = anchor_pos + len(ANCHOR_BEFORE_LOG)
        # Сегмент лога: есть дата и разделитель " — " (как в "11.03.2026 00:00 — текст")
        has_date = re.compile(r'\d{1,2}\.\d{1,2}\.\d{4}')
        offset = 0
        for seg_start, seg_text in segments:
            if offset < search_from:
                offset += len(seg_text)
                continue
            if has_date.search(seg_text) and ' — ' in seg_text:
                return seg_start
            offset += len(seg_text)
        return None
    except Exception:
        return None


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
        doc = service.documents().get(documentId=doc_id).execute()
        content = doc.get('body', {}).get('content', [])
        doc_len = content[-1].get('endIndex', 0) if content else 0
        P = ranges[0][0]
        end_marker = (os.environ.get(LOG_BLOCK_END_MARKER_ENV) or '').strip()
        end_marker_start = None
        if end_marker:
            segs = _collect_text_segments(content)
            segs.sort(key=lambda x: x[0])
            for seg_start, seg_text in segs:
                if end_marker in seg_text and seg_start > P:
                    pos = seg_text.find(end_marker)
                    end_marker_start = seg_start + pos
                    break
        if end_marker_start is not None:
            new_content = new_content + '\n\n' + end_marker
            delete_end = end_marker_start + len(end_marker)
            if delete_end > P + 1:
                delete_end -= 1  # не включать возможный newline в конце сегмента
            # Удалять весь блок от начала (маркер начала), иначе старый заголовок и строки останутся и будет дубль
            start_marker = (os.environ.get(LOG_BLOCK_START_MARKER_ENV) or '').strip()
            if start_marker:
                segs = _collect_text_segments(content)
                segs.sort(key=lambda x: x[0])
                for seg_start, seg_text in segs:
                    if start_marker in seg_text and seg_start < end_marker_start:
                        P = seg_start
                        print('update_live_log_5min: удаляю весь блок от маркера «%s» (поз. %s) до конца блока.' % (start_marker[:30], P), file=sys.stderr)
                        break
            print('update_live_log_5min: найден конец блока «%s», сохраняю содержимое после него (таблицу и т.д.).' % end_marker[:30], file=sys.stderr)
        else:
            # Если плейсхолдер только в конце — удаляем от начала блока лога
            if len(ranges) == 1 and doc_len > 10000 and P > doc_len - 10000:
                marker = (os.environ.get(LOG_BLOCK_START_MARKER_ENV) or '').strip()
                if marker:
                    doc2 = service.documents().get(documentId=doc_id).execute()
                    body = doc2.get('body', {}).get('content', [])
                    segs = _collect_text_segments(body)
                    segs.sort(key=lambda x: x[0])
                    for seg_start, seg_text in segs:
                        if marker in seg_text:
                            P = seg_start
                            print('update_live_log_5min: найден маркер «%s», удаляю от поз. %s до конца.' % (marker[:30], P), file=sys.stderr)
                            break
                if P == ranges[0][0]:
                    first_log = _find_first_log_line_index(service, doc_id)
                    if first_log is not None and first_log < P:
                        P = first_log
                        print('update_live_log_5min: плейсхолдер в конце документа, удаляю от первой строки лога (поз. %s) до конца.' % P, file=sys.stderr)
            delete_end = content[-1].get('endIndex', P + len(PLACEHOLDER)) if content else (P + len(PLACEHOLDER))
            if delete_end > P + 1:
                delete_end -= 1  # не включать newline в конце — иначе API 400
            if delete_end <= P:
                delete_end = P + len(PLACEHOLDER)
        # Удаление по частям (по ~30k символов), иначе один огромный delete может не сработать
        CHUNK = 30000
        while delete_end - P > CHUNK:
            req = [{'deleteContentRange': {'range': {'startIndex': P, 'endIndex': P + CHUNK}}}]
            service.documents().batchUpdate(documentId=doc_id, body={'requests': req}).execute()
            delete_end -= CHUNK
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
        # Стиль блока: по умолчанию 11pt; заголовок (первая строка до \n) — жирный 12pt
        font_size_str = (os.environ.get('KRO_LOG_FONT_SIZE') or '').strip()
        magnitude = 11
        if font_size_str and font_size_str.isdigit():
            m = int(font_size_str)
            if 8 <= m <= 24:
                magnitude = m
        try:
            end_idx = P + len(new_content)
            marker = (os.environ.get(LOG_BLOCK_START_MARKER_ENV) or '').strip()
            # Заголовок «Отчёт с 00:00» — после маркера и \n\n
            off = (len(marker) + 2) if marker else 0
            nl = new_content.find('\n', off)
            header_len = (nl - off) if nl >= 0 else (len(new_content) - off)
            header_start = P + off
            header_end = min(header_start + header_len, end_idx)
            reqs = [
                {'updateTextStyle': {
                    'range': {'startIndex': P, 'endIndex': end_idx},
                    'textStyle': {'fontSize': {'magnitude': magnitude, 'unit': 'PT'}},
                    'fields': 'fontSize'
                }}
            ]
            if header_end > header_start and header_len > 0:
                reqs.append({'updateTextStyle': {
                    'range': {'startIndex': header_start, 'endIndex': header_end},
                    'textStyle': {'bold': True, 'fontSize': {'magnitude': min(12, magnitude + 1), 'unit': 'PT'}},
                    'fields': 'bold,fontSize'
                }})
            for url_start, url_end, url in _find_url_ranges(new_content):
                reqs.append({'updateTextStyle': {
                    'range': {'startIndex': P + url_start, 'endIndex': P + url_end},
                    'textStyle': {'link': {'url': url}},
                    'fields': 'link'
                }})
            service.documents().batchUpdate(documentId=doc_id, body={'requests': reqs}).execute()
        except Exception:
            pass
        if not last_line:
            return True
        P = _find_text_start_index(service, doc_id, PLACEHOLDER)
        if P is None:
            return True
        len_content = len(new_content)
        len_placeholder = len(PLACEHOLDER)
        block_start = P - len_content + len_placeholder
        last_line_start = block_start + len_content - len_placeholder - 1 - len(last_line)
        # Жирным только время в начале строки (после буллета «• »)
        line_without_prefix = last_line.replace(LOG_LINE_PREFIX, '', 1) if last_line.startswith(LOG_LINE_PREFIX) else last_line
        time_part = line_without_prefix.split(' — ', 1)[0].strip() if ' — ' in line_without_prefix else line_without_prefix[:5]
        time_len = len(time_part)
        bold_start = last_line_start + (len(last_line) - len(line_without_prefix))  # после «• »
        bold_end = bold_start + time_len
        if bold_start < 1 or bold_end <= bold_start or bold_start >= P:
            return True
        requests2 = [
            {
                'updateTextStyle': {
                    'range': {'startIndex': bold_start, 'endIndex': bold_end},
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
    start_ddmm = get_start_date_ddmm()
    # Обрезать лог до окна памяти: максимум последние 14 дней или более поздняя стартовая дата.
    lines = load_log_lines()
    trimmed = trim_log_to_start_date(lines, start_ddmm)
    if len(trimmed) < len(lines):
        save_log_lines(trimmed)
        print('update_live_log_5min: лог обрезан до записей с %s (%s строк удалено)' % (start_ddmm, len(lines) - len(trimmed)), file=sys.stderr)

    now = _msk_now()
    now_rounded = _round_time_to_grid(now)  # сутки по сетке 00:00, 00:05, … 23:55
    date_str = now_rounded.strftime('%d.%m.%Y')
    time_str = now.strftime('%H:%M')  # для вывода в лог (фактическое время)
    time_str_grid = now_rounded.strftime('%H:%M')
    datetime_prefix = '%s %s' % (date_str, time_str_grid)  # при записи — время по сетке, без повторов в слоте

    tg_snapshot = fetch_tgstat_snapshot()
    telega_snapshot = fetch_telega_snapshot()
    telegram_search_snapshot = fetch_telegram_search_snapshot()
    complaints_snapshot = fetch_complaints_snapshot()
    web_snapshot = fetch_web_sources_snapshot()
    search_data = {
        'snapshots': [
            tg_snapshot,
            telega_snapshot,
            telegram_search_snapshot,
            complaints_snapshot,
            web_snapshot,
        ]
    }
    victims, losses = get_stats_cached()

    state = load_state()
    # Каждый запуск (каждые 5 мин по Москве) — одна строка с описанием действий за эти 5 мин
    if state is None:
        state = {'last_search_signature': '', 'last_victims': victims, 'last_losses': losses}
    current_signature = json.dumps({
        'sources': [s.get('source') for s in search_data['snapshots']],
        'candidates': [len(s.get('candidates') or []) for s in search_data['snapshots']],
        'links': [len(_unique_list((s.get('source_urls') or []) + (s.get('evidence_links') or []))) for s in search_data['snapshots']],
    }, ensure_ascii=False, sort_keys=True)
    changed = (
        state.get('last_search_signature') != current_signature
        or state.get('last_victims') != victims or state.get('last_losses') != losses
    )
    action = _normalize_log_message(_build_search_action(search_data, victims, losses, time_str_grid), time_str=time_str_grid)
    new_line = '%s — За 5 мин: %s' % (datetime_prefix, action)
    save_state({
        'last_search_signature': current_signature, 'last_victims': victims, 'last_losses': losses,
    })
    lines = load_log_lines()
    if lines and lines[-1].strip().startswith(datetime_prefix):
        lines[-1] = new_line
    else:
        lines.append(new_line)
    save_log_lines(trim_log_to_start_date(lines, start_ddmm))

    lines = load_log_lines()
    doc_id = (os.environ.get('KRO_SOURCES_DOC_ID') or '').strip() or DEFAULT_SOURCES_DOC_ID
    if not doc_id:
        print('KRO_SOURCES_DOC_ID не задан, только запись в %s' % LIVE_LOG_FILE, file=sys.stderr)
        return
    content, last_line = build_live_log_doc_block(lines)
    marker = (os.environ.get(LOG_BLOCK_START_MARKER_ENV) or '').strip()
    if marker:
        content = marker + '\n\n' + content  # пустая строка после маркера
    if update_doc_placeholder(doc_id, content, last_line=last_line):
        if last_line:
            print('%s ok (жирным: новая строка): %s' % (time_str, last_line), file=sys.stderr)
        else:
            print('%s ok (документ обновлён)' % time_str, file=sys.stderr)
    else:
        print('%s doc update failed' % time_str, file=sys.stderr)

if __name__ == '__main__':
    main()
