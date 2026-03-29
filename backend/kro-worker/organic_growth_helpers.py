#!/usr/bin/env python3
"""
Органический рост: проверка доменов обменников через открытый поиск, состояние между циклами.
Не пишет в Sheets — только логика; вызывается из run_12h_monitor.
"""
import json
import logging
import os
import re
import time
from urllib.parse import quote_plus

logger = logging.getLogger(__name__)

_ORGANIC_NEG_HINTS = (
    'скам', 'мошен', 'обман', 'кидал', 'развод', 'жалоб', 'жалоба', 'не вывод',
    'не возвращ', 'заблокир', 'blacklist', 'чёрн', 'черный список', 'лохотрон',
    'кидок', 'украл', 'потерял', 'слил', 'доплат', 'aml', 'разводят',
)
_ORGANIC_POS_HINTS = (
    'надежн', 'проверен', 'рекоменд', 'положительн', 'хорош', 'нормальн',
    'без проблем', 'работает', 'доволен', 'довольна', 'честн', 'легальн',
)

_TG_HANDLE_RE = re.compile(
    r'(?:https?://)?t\.me/([a-zA-Z][a-zA-Z0-9_]{3,60})',
    re.IGNORECASE,
)
_SKIP_TG = frozenset({
    'joinchat', 'addstickers', 'share', 'proxy', 's', 'iv', 'login', 'addlist',
})


def _ddg_search_html(query):
    try:
        import web_scraper as ws
        url = 'https://duckduckgo.com/html/?q=' + quote_plus(query)
        return ws._fetch(url)
    except Exception as e:
        logger.debug('ddg fetch failed: %s', e)
        return None


def _ddg_blocked(html):
    if not html or len(html) < 800:
        return True
    low = html.lower()
    if 'anomaly-modal' in low or 'select all squares containing a duck' in low:
        return True
    return False


def _collect_result_texts_for_query(query, max_pages=2, pause_sec=2.5):
    """Собрать текст с нескольких страниц из выдачи (без сниппетов — тянем целевые URL)."""
    try:
        import web_scraper as ws
    except ImportError:
        return '', []

    html = _ddg_search_html(query)
    if _ddg_blocked(html):
        return '', []

    urls = []
    seen = set()
    for link in ws._parse_search_result_links(html):
        low = link.lower()
        if any(x in low for x in (
            'duckduckgo.com', 'google.com', 'bing.com', 'yandex.',
            'facebook.com', 'twitter.com', 'x.com',
        )):
            continue
        if link not in seen:
            seen.add(link)
            urls.append(link)
        if len(urls) >= 5:
            break

    chunks = []
    used_urls = []
    for u in urls[:max_pages]:
        time.sleep(max(0.5, pause_sec))
        page = ws._fetch(u)
        if not page:
            continue
        txt = ws._clean_html_text(page)[:3500].lower()
        if len(txt) > 200:
            chunks.append(txt)
            used_urls.append(u)
    return ' '.join(chunks), used_urls


def score_open_web_text(blob):
    """Счётчики негативных/позитивных маркеров в агрегированном тексте."""
    if not blob:
        return 0, 0
    neg = sum(blob.count(h) for h in _ORGANIC_NEG_HINTS)
    pos = sum(blob.count(h) for h in _ORGANIC_POS_HINTS)
    return neg, pos


def verify_exchanger_domain_via_search(hostname, kurs_page_url, pause_sec=2.5):
    """
    Проверка домена по открытому поиску (не судебный вердикт — честная эвристика).
    Возвращает dict: status (без нарушений / под наблюдением / в риске),
    evidence_lines (list str), search_ok (bool), queries_used.
    """
    host = (hostname or '').strip().lower().rstrip('.')
    queries_used = []
    all_blob = []
    all_urls = []
    search_ok = False

    for q in (
        '%s отзывы обменник' % host,
        '%s скам обман жалоба' % host,
    ):
        queries_used.append(q)
        blob, urls = _collect_result_texts_for_query(q, max_pages=2, pause_sec=pause_sec)
        if blob:
            search_ok = True
            all_blob.append(blob)
            all_urls.extend(urls)

    combined = ' '.join(all_blob)
    neg, pos = score_open_web_text(combined)

    kurs_note = (
        'Домен указан в публичном чёрном списке обменников kurs.expert '
        '(%s). ' % (kurs_page_url or 'kurs.expert')
    )

    lines = [kurs_note.strip()]

    if not search_ok:
        lines.append(
            'Автоматическая выдача поиска недоступна или пуста (защита/блокировка ботов). '
            'Статус консервативный: под наблюдением до ручной проверки.'
        )
        return {
            'status': 'под наблюдением',
            'evidence_lines': lines,
            'search_ok': False,
            'queries_used': queries_used,
            'neg': neg,
            'pos': pos,
            'sample_urls': all_urls[:4],
        }

    lines.append(
        'Проанализированы фрагменты до %d сторонних страниц из выдачи; '
        'условные маркеры: негативных упоминаний ≈%d, позитивных ≈%d.' % (
            min(len(all_urls), 4), neg, pos,
        )
    )
    if all_urls:
        lines.append('Примеры URL: ' + '; '.join(all_urls[:3]))

    if neg >= 3 or (neg >= 2 and neg > pos + 1):
        status = 'в риске'
        lines.append('По совокупности открытого текста преобладают сигналы жалоб/негатива.')
    elif neg >= 1:
        status = 'под наблюдением'
        lines.append('Есть отдельные негативные формулировки в проанализированных страницах.')
    elif pos >= 1 and neg == 0:
        status = 'без нарушений'
        lines.append(
            'В выборке страниц из поиска негативных маркеров не найдено; '
            'встречаются нейтральные или позитивные формулировки — это не гарантия, а сигнал для базы.'
        )
    else:
        status = 'под наблюдением'
        lines.append(
            'Явных «жалобных» или «хвалебных» маркеров в выборке мало — данных мало для уверенного вывода.'
        )

    return {
        'status': status,
        'evidence_lines': lines,
        'search_ok': True,
        'queries_used': queries_used,
        'neg': neg,
        'pos': pos,
        'sample_urls': all_urls[:4],
    }


def load_organic_state(path):
    if not path or not os.path.isfile(path):
        return {'kurs_processed_hosts': []}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {'kurs_processed_hosts': []}
        hosts = data.get('kurs_processed_hosts') or []
        if not isinstance(hosts, list):
            hosts = []
        return {'kurs_processed_hosts': [str(h).lower().strip().rstrip('.') for h in hosts if h]}
    except Exception as e:
        logger.warning('organic state read failed: %s', e)
        return {'kurs_processed_hosts': []}


def save_organic_state(path, state):
    if not path:
        return
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    hosts = state.get('kurs_processed_hosts') or []
    # не раздувать файл бесконечно
    if len(hosts) > 40000:
        hosts = hosts[-35000:]
    out = {'kurs_processed_hosts': hosts}
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, indent=0)
    except Exception as e:
        logger.error('organic state write failed: %s', e)


def pick_new_kurs_hosts(all_hosts, processed_set, scam_keys, count):
    """Первые count доменов из списка kurs, ещё не в state и не в scam_base."""
    out = []
    for h in all_hosts or []:
        hn = (h or '').strip().lower().rstrip('.')
        if not hn or hn in processed_set or hn in scam_keys:
            continue
        out.append(hn)
        if len(out) >= count:
            break
    return out


def extract_invest_bot_handles_from_text(*text_parts):
    """
    Username ботов из текстов записей скам-каналов (t.me/... с bot в имени).
    """
    found = []
    seen = set()
    blob = ' '.join((t or '') for t in text_parts if t)
    for m in _TG_HANDLE_RE.finditer(blob):
        u = m.group(1).strip()
        low = u.lower()
        if low in _SKIP_TG:
            continue
        if not re.search(r'bot', low, re.I):
            continue
        if len(low) < 5:
            continue
        if low not in seen:
            seen.add(low)
            found.append(low)
    return found
