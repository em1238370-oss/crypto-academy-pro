# -*- coding: utf-8 -*-
"""
Единый публичный HTTP-gate для записи в scam_base (без Telethon).
Используется: run_12h_monitor, check_once, kro-prune-scam-base-html, опционально — полная чистка за цикл.

Почему раньше появлялись «чужие» каналы (и как не повторять):
  • Парсер тянул @username из текста статей без различия «платформа Telegram» и «обвиняемый канал»
    → web_scraper: приоритет заголовка/1-го абзаца; kro_false_positive_guards для платформ и Poizon*.
  • В scam_base попадали жалобы только из формы без ссылки на разоблачитель
    → порог: только с маркером сайта-разоблачителя в агрегате.
  • В листе копились старые строки, а API отдавал сырые дубликаты
    → dedupe в server.js; периодическая чистка по denylist (см. telegram_scam_base_row_matches_denylist).
  • «Взломан» только в описании канала не отсекался HTTP-gate
    → маркеры взлома в описании + постах (tme_preview_combined_lower).

Правила перед записью / удержанием строки Telegram (канал):
  1) публичная страница доступна;
  2) не считаем личным профилем (эвристика HTML);
  3) число подписчиков видно и >= 50;
  4) в описании или постах есть крипто-маркеры;
  5) есть пост с датой не старше SCAM_BASE_HTTP_POST_MAX_AGE_DAYS;
  + посты без маркеров взлома.

Для объекта-бота (инвест-бот / @*bot): без требования 50 подписчиков; нужна
публичная кнопка Start/Запустить (?start=); крипто-маркеры; если есть посты с датами — не старше лимита.
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
)
USER_AGENT_CHROME = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/122.0.0.0 Safari/537.36'
)

MIN_TELEGRAM_SUBSCRIBERS_HTTP = 50
SCAM_BASE_HTTP_POST_MAX_AGE_DAYS = 90
# Синхронно с ТЗ KRO (фильтр 4) и server.js KRO_TME_HTTP_GATE_CRYPTO.
# + forex / бинанс — для англ. «forex» и кириллического написания биржи.
SCAM_BASE_HTTP_CRYPTO_TERMS = (
    'крипт',
    'bitcoin',
    'btc',
    'usdt',
    'заработок',
    'доход',
    'прибыль',
    'вложение',
    'капитал',
    'трейдер',
    'аналитик',
    'прогноз',
    'трейд',
    'сигнал',
    'вип',
    'premium',
    'profit',
    'earn',
    'money',
    'trading',
    'signals',
    'invest',
    'trade',
    'форекс',
    'обменник',
    'binance',
    'bybit',
    'биткоин',
    'альткоин',
    'депозит',
    'профит',
    'лонг',
    'шорт',
    'фьючерс',
    'спот',
    'defi',
    'nft',
    'токен',
    'майнинг',
    'crypto',
    'signal',
    'forex',
    'бинанс',
)

# Не наша тема: казино / ставки / гемблинг — не писать в scam_base (см. server.js KRO_GAMBLING_*).
GAMBLING_TOPIC_SUBSTRINGS_RU = (
    'казино',
    'букмекер',
    'букмекеры',
    'букмекерская',
    'рулетка',
    'покер',
    'слоты',
    'gambling',
    'casino',
    'slots',
    'bookmaker',
    'bookmakers',
)
_GAMBLING_RE_EN = re.compile(
    r'(?i)\b(?:gambling|casinos?|roulette|poker|slots?|bookmakers?|betting|bets?)\b|\bbet\b'
)
# «ставки» / «ставка» как отдельные слова (реже ложные срабатывания вроде «расстановки»)
_GAMBLING_STAVKI_RE = re.compile(
    r'(?i)(?<![а-яёa-z])ставки(?![а-яёa-z])|(?<![а-яёa-z])ставка(?![а-яёa-z])'
)

OFFTOPIC_TOPIC_SUBSTRINGS = (
    # Одежда / мода / Poizon (маркетплейс кроссовок — не крипто-KRO)
    'poizon', 'одежда', 'мода', 'кроссовки', 'обувь', 'fashion', 'shoes', 'sneakers', 'streetwear',
    'дроп', 'лимитка', 'коллаб', 'коллаборация', 'найк', 'адидас', 'nike', 'adidas', 'jordan', 'yeezy', 'supreme',
    'сникер', 'кросовки',
    'бренд одежды', 'одяг', 'кросівки',
    'бренд', 'бутик', 'магазин одежды',
    # Еда / рестораны
    'ресторан', 'доставка еды', 'суши', 'пицца', 'кафе', 'food delivery',
    # Недвижимость
    'квартира', 'аренда', 'продажа квартир', 'недвижимость', 'риэлтор', 'жильё', 'жилье',
    # Авто
    'продажа авто', 'автосалон', 'машина купить',
    # Работа / вакансии
    'вакансия', 'найм', 'hr', 'работа в',
    # Спорт / развлечения — не крипто-KRO (личные контакты «про футбол» и т.п.)
    'футбол', 'футболь', 'чемпионат мира',
)
_OFFTOPIC_RE_EN = re.compile(
    r'(?i)\b(?:poizon|sneakers?|sneakerhead|streetwear|collab(?:oration)?|nike|adidas|jordan|yeezy|supreme|'
    r'fashion|shoes?|boutique|restaurant|pizza|sushi|cafe|food\s+delivery|'
    r'real\s*estate|realtor|apartment\s+rent|car\s+sale|dealer|vacanc(?:y|ies)|'
    r'hiring|recruit(?:er|ment)|hr|football|soccer)\b'
)


def gambling_topic_match(*parts: str) -> Optional[str]:
    """
    Если в объединённом тексте есть маркеры казино/ставок — вернуть первый найденный фрагмент (для лога), иначе None.
    """
    blob = ' '.join(
        (p or '') if isinstance(p, str) else str(p or '')
        for p in parts
    )
    if not blob.strip():
        return None
    low = blob.lower()
    for s in GAMBLING_TOPIC_SUBSTRINGS_RU:
        t = (s or '').strip().lower()
        if t and t in low:
            return t
    m = _GAMBLING_STAVKI_RE.search(blob)
    if m:
        return m.group(0).strip().lower()
    m2 = _GAMBLING_RE_EN.search(blob)
    if m2:
        return m2.group(0).strip().lower()
    return None


def off_topic_business_match(*parts: str) -> Optional[str]:
    """
    Маркеры «не по теме» для KRO (одежда/еда/недвижимость/авто/вакансии).
    Возвращает первый найденный фрагмент для логов или None.
    """
    blob = ' '.join(
        (p or '') if isinstance(p, str) else str(p or '')
        for p in parts
    )
    if not blob.strip():
        return None
    low = blob.lower()
    for s in OFFTOPIC_TOPIC_SUBSTRINGS:
        t = (s or '').strip().lower()
        if t and t in low:
            return t
    m = _OFFTOPIC_RE_EN.search(blob)
    if m:
        return m.group(0).strip().lower()
    return None


TME_HACKED_POST_MARKERS = (
    'взлом',
    'взломан',
    'hacked',
    'канал взломали',
    'канал взломан',
    'аккаунт взломан',
    'меня взломали',
    'не я пишу',
    'мошенники захватили',
)

# Жёсткий список: строки scam_base с этими @ всегда удалять при чистке.
FORCE_REMOVE_USERNAMES = frozenset(
    {
        '@poizongo',
        '@auraselect',
        '@vipbyrodion_bot',
        '@snipervip0001_bot',
        '@copytradiings',
        '@copytradlngss',
        '@ukrainchuk_yuriy',
        '@alex_wise_trade',
        '@poizonstorm',
        '@rublevinvestrus',
        '@vladislav_belokrylov',
        '@maxcrypto_adm',
        '@trader_servver',
    }
)

_PERM_BLOCKLIST_NORM_KEYS: Optional[frozenset] = None


def _norm_key_scam_base_cell(cell: str) -> str:
    s = (cell or '').strip().lower()
    if not s:
        return ''
    if s.startswith('@'):
        s = s[1:]
    if 't.me/' in s:
        s = s.split('t.me/', 1)[-1].split('/')[0].split('?')[0]
    return (s or '').strip()


def _load_permanent_blocklist_norm_keys() -> frozenset:
    """Нормализованные username из kro_permanent_blocklist.json (кэш на процесс)."""
    global _PERM_BLOCKLIST_NORM_KEYS
    if _PERM_BLOCKLIST_NORM_KEYS is not None:
        return _PERM_BLOCKLIST_NORM_KEYS
    keys: set = set()
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'kro_permanent_blocklist.json')
    try:
        with open(path, encoding='utf-8') as f:
            raw = json.load(f)
        for u in raw or []:
            nk = _norm_key_scam_base_cell(str(u))
            if nk:
                keys.add(nk)
    except Exception:
        pass
    _PERM_BLOCKLIST_NORM_KEYS = frozenset(keys)
    return _PERM_BLOCKLIST_NORM_KEYS


def telegram_scam_base_row_matches_denylist(row: List[str]) -> bool:
    """
    True — строка scam_base (Telegram) не должна быть в листе: постоянный blocklist,
    префикс poizon*, официальные платформы (kro_false_positive_guards). Без HTTP к t.me.
    """
    if not is_telegram_scam_base_row(row):
        return False
    u = (row[0] if len(row) > 0 else '').strip()
    link = (row[1] if len(row) > 1 else '').strip()
    bl = _load_permanent_blocklist_norm_keys()
    for cell in (u, link):
        key = _norm_key_scam_base_cell(cell)
        if not key:
            continue
        if key in bl:
            return True
        try:
            from kro_false_positive_guards import should_never_scam_base_norm_key
        except ImportError:
            should_never_scam_base_norm_key = lambda _k: False  # type: ignore
        if should_never_scam_base_norm_key(key):
            return True
    return False


def normalize_channel_link(ch_or_link: str) -> str:
    ch = (ch_or_link or '').strip()
    if not ch or '.' in ch.split('/')[-1].split('@')[-1] and '@' not in ch and 't.me/' not in ch:
        return ''
    if ch.startswith('http'):
        if 't.me/' in ch:
            return ch.split('t.me/')[-1].split('?')[0].strip() or ''
        return ''
    if ch.startswith('t.me/'):
        return ch.split('/', 1)[-1].split('?')[0].strip() or ''
    if ch.startswith('@'):
        return ch.lstrip('@').split('?')[0].strip() or ''
    return ch.split('?')[0].strip() or ''


def norm_username_cell(v: str) -> str:
    s = (v or '').strip()
    if not s:
        return ''
    if s.startswith('https://t.me/'):
        s = '@' + s.split('https://t.me/', 1)[-1].split('/')[0]
    elif s.startswith('t.me/'):
        s = '@' + s.split('t.me/', 1)[-1].split('/')[0]
    if not s.startswith('@'):
        s = '@' + s.lstrip('@')
    return s.lower()


def is_telegram_scam_base_row(row: List[str]) -> bool:
    username = (row[0] if len(row) > 0 else '').strip()
    link = (row[1] if len(row) > 1 else '').strip()
    obj_type = (row[5] if len(row) > 5 else '').strip().lower()
    if 't.me/' in username.lower() or 't.me/' in link.lower():
        return True
    if username.startswith('@'):
        return True
    return 'сигнал' in obj_type


def _normalize_slug(ch_or_link: str) -> str:
    ch = (ch_or_link or '').strip()
    if not ch:
        return ''
    if ch.startswith('http'):
        if 't.me/' in ch:
            return ch.split('t.me/')[-1].split('?')[0].strip().lstrip('/')
        return ''
    if ch.startswith('t.me/'):
        return ch.split('/', 1)[-1].split('?')[0].strip()
    if ch.startswith('@'):
        return ch.lstrip('@').split('?')[0].strip()
    if 't.me/' in ch:
        return ch.split('t.me/')[-1].split('?')[0].strip()
    return ''


normalize_tme_slug = _normalize_slug


def _normalize_message_text(text: str) -> str:
    return re.sub(r'\s+', ' ', (text or '').strip())


def _extract_post_text_from_widget(msg) -> str:
    if not msg:
        return ''
    text_node = msg.select_one('.tgme_widget_message_text')
    if text_node:
        return _normalize_message_text(text_node.get_text(' ', strip=True) or '')
    alt = msg.select_one('.tgme_widget_message_text.js-message_text')
    if alt:
        return _normalize_message_text(alt.get_text(' ', strip=True) or '')
    for sel in (
        '.tgme_widget_message_photo_caption',
        '.message_media_not_supported_text',
        '.tgme_widget_message_document_wrap + .tgme_widget_message_text',
    ):
        cap = msg.select_one(sel)
        if cap:
            return _normalize_message_text(cap.get_text(' ', strip=True) or '')
    inner = msg.select_one('.tgme_widget_message_bubble')
    if inner:
        text = _normalize_message_text(inner.get_text(' ', strip=True) or '')
        if len(text) > 15:
            return text
    return ''


def _parse_subscriber_count_from_extra_text(text: str) -> Optional[int]:
    if not text:
        return None
    t = text.replace('\xa0', ' ').lower()
    m = re.search(
        r'([\d\s.,]+)\s*([km])?\s*(?:subscribers|subscriber|подписчик)',
        t,
    )
    if not m:
        m = re.search(r'([\d\s.,]+)\s*([km])?\b', t)
    if not m:
        return None
    num = m.group(1).replace(' ', '').replace(',', '.')
    try:
        v = float(num)
    except ValueError:
        return None
    suf = (m.group(2) or '').lower()
    if suf == 'k':
        v *= 1000
    elif suf == 'm':
        v *= 1_000_000
    return int(round(v))


def _page_unavailable(soup, status_code: int, raw_lower: str) -> bool:
    if status_code in (404, 410):
        return True
    if soup.select_one('.tgme_page_error'):
        return True
    for phrase in (
        "doesn't exist",
        'does not exist',
        'username is not available',
        'channel is private',
        'канал недоступен',
        'пользователь не найден',
        'не существует',
        'sorry, too many',
    ):
        if phrase in raw_lower:
            return True
    return False


def _looks_like_user_profile(extra_text: str, raw_lower: str) -> bool:
    ex = (extra_text or '').lower()
    if any(
        x in ex
        for x in (
            'last seen',
            'was online',
            'online',
            'в сети',
            'заходил',
            'заходила',
            'недавно',
            'long ago',
        )
    ):
        if 'подписчик' not in ex and 'subscriber' not in ex:
            return True
    ex_l = ex
    if re.search(r'"type"\s*:\s*"user"', raw_lower):
        if 'подписчик' not in ex_l and 'subscriber' not in ex_l:
            return True
    if '@type":"person"' in raw_lower or '"@type": "person"' in raw_lower:
        return True
    return False


def _slug_looks_like_telegram_bot(slug: str, object_type: str) -> bool:
    s = (slug or '').strip().lower().rstrip('/')
    if s.endswith('bot') or s.endswith('_bot'):
        return True
    ot = (object_type or '').strip().lower()
    ot_compact = ot.replace(' ', '').replace('-', '')
    if 'инвестбот' in ot_compact:
        return True
    if 'бот' in ot and 'канал' not in ot:
        return True
    return False


def _tme_bot_page_has_start(soup, raw_lower: str) -> bool:
    if 'tgme_page_error' in raw_lower:
        return False
    if 'chat not found' in raw_lower or 'bot was blocked' in raw_lower:
        return False
    if '?start=' in raw_lower and ('t.me/' in raw_lower or 'telegram.me' in raw_lower):
        return True
    for sel in ('a.tgme_action_button_new', 'a.tgme_action_button'):
        for a in soup.select(sel):
            href = (a.get('href') or '').lower()
            if '?start=' in href or 'start=' in href:
                return True
            t = (a.get_text() or '').strip().lower()
            if any(w in t for w in ('start', 'запустить', 'открыть', 'open', 'launch')):
                return True
    return False


def fetch_tme_public_preview(slug: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        'ok_fetch': False,
        'unavailable': True,
        'is_user_profile': False,
        'subs': None,
        'desc': '',
        'posts_blob_lower': '',
        'last_post_dt': None,
        'bot_start_visible': False,
    }
    slug = (slug or '').lstrip('@').split('/')[0]
    if not slug or slug.startswith('joinchat') or slug.startswith('+'):
        return out
    try:
        import requests
        from bs4 import BeautifulSoup
    except ImportError:
        return out

    last_status = 0
    raw = ''
    for url in (f'https://t.me/s/{slug}', f'https://t.me/{slug}'):
        for ua in (USER_AGENT, USER_AGENT_CHROME):
            try:
                resp = requests.get(
                    url,
                    headers={
                        'User-Agent': ua,
                        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
                    },
                    timeout=22,
                )
                last_status = resp.status_code
                raw = resp.text or ''
                if resp.status_code == 200 and len(raw) > 200:
                    break
            except Exception:
                continue
        if last_status == 200 and len(raw) > 200:
            break

    if last_status != 200 or len(raw) < 200:
        return out

    raw_lower = raw.lower()
    soup = BeautifulSoup(raw, 'html.parser')
    if _page_unavailable(soup, last_status, raw_lower):
        return out

    out['ok_fetch'] = True
    out['unavailable'] = False
    extra_el = soup.select_one('.tgme_page_extra')
    extra_text = extra_el.get_text(' ', strip=True) if extra_el else ''
    out['subs'] = _parse_subscriber_count_from_extra_text(extra_text)
    desc_el = soup.select_one('.tgme_page_description')
    out['desc'] = (desc_el.get_text(' ', strip=True) if desc_el else '') or ''
    if _looks_like_user_profile(extra_text, raw_lower):
        out['is_user_profile'] = True

    texts: List[str] = []
    last_dt = None
    for w in soup.select('.tgme_widget_message')[:50]:
        t = _extract_post_text_from_widget(w)
        if t:
            texts.append(t.lower())
        time_node = w.select_one('time')
        if time_node and time_node.get('datetime'):
            try:
                dt = datetime.fromisoformat(time_node['datetime'].replace('Z', '+00:00')).astimezone(timezone.utc)
                if last_dt is None or dt > last_dt:
                    last_dt = dt
            except ValueError:
                pass
    out['posts_blob_lower'] = ' '.join(texts)
    out['last_post_dt'] = last_dt
    out['bot_start_visible'] = _tme_bot_page_has_start(soup, raw_lower)
    return out


def tme_preview_combined_lower(prev: Dict[str, Any]) -> str:
    """Описание + посты публичной страницы t.me (нижний регистр) — единый blob для off_topic / crypto / gambling."""
    return ((prev.get('desc') or '') + ' ' + (prev.get('posts_blob_lower') or '')).lower()


def tme_http_gate_for_scam_base_write(
    username_or_link: str,
    object_type: str = '',
    source_evidence: str = '',
    content_analysis: str = '',
) -> Tuple[bool, str, Dict[str, Any]]:
    """
    True = можно писать в scam_base; False + код причины.
    Третий элемент — метаданные превью (subs и т.д.) для пост-правил на стороне монитора.

    off_topic (одежда/еда/авто/…): только по реальному HTML t.me (описание + посты), не по тексту разоблачителя.
    Крипта и гемблинг по каналу/боту — только по этому же blob после fetch (source_evidence/content_analysis не подмешиваются).
    Параметры source_evidence/content_analysis оставлены для совместимости вызовов.
    """
    meta: Dict[str, Any] = {'subs': None, 'slug': '', 'tme_preview_ok': False}
    uname = normalize_channel_link(username_or_link)
    if not uname:
        return True, 'not_telegram', meta
    if uname.startswith('joinchat/'):
        return False, 'invite_link_not_supported', meta
    slug = uname.lstrip('@').split('/')[0]
    meta['slug'] = slug
    prev = fetch_tme_public_preview(slug)
    is_bot = _slug_looks_like_telegram_bot(slug, object_type)

    if not prev['ok_fetch'] or prev['unavailable']:
        return False, 'tme_unavailable_or_no_public_page', meta

    meta['tme_preview_ok'] = True
    meta['subs'] = prev.get('subs')

    tme_blob = tme_preview_combined_lower(prev)
    ot_tme = off_topic_business_match(tme_blob)
    if ot_tme:
        return False, 'blocked_offtopic_tme:%s' % ot_tme, meta

    if is_bot:
        if not prev.get('bot_start_visible'):
            return False, 'tme_bot_not_working_no_start', meta
        gm_bot = gambling_topic_match(tme_blob, username_or_link, object_type)
        if gm_bot:
            return False, 'blocked_gambling_tme:%s' % gm_bot, meta
        if not any(term in tme_blob for term in SCAM_BASE_HTTP_CRYPTO_TERMS):
            return False, 'tme_no_crypto_terms_in_desc_or_posts', meta
        now = datetime.now(timezone.utc)
        last_dt = prev['last_post_dt']
        if last_dt is not None:
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=timezone.utc)
            if (now - last_dt).days > SCAM_BASE_HTTP_POST_MAX_AGE_DAYS:
                return False, 'tme_no_fresh_post_%dd' % SCAM_BASE_HTTP_POST_MAX_AGE_DAYS, meta
        if any(hm in tme_preview_combined_lower(prev) for hm in TME_HACKED_POST_MARKERS):
            return False, 'tme_channel_reported_hacked', meta
        return True, 'ok_tme_http_gate_bot', meta

    if prev['is_user_profile']:
        return False, 'tme_personal_account_not_channel', meta

    subs = prev['subs']
    if subs is None:
        return False, 'tme_subscribers_not_visible_reject', meta
    if subs < MIN_TELEGRAM_SUBSCRIBERS_HTTP:
        return False, 'tme_subscribers_below_%d' % MIN_TELEGRAM_SUBSCRIBERS_HTTP, meta

    gm_ch = gambling_topic_match(tme_blob, username_or_link, object_type)
    if gm_ch:
        return False, 'blocked_gambling_tme:%s' % gm_ch, meta
    if not any(term in tme_blob for term in SCAM_BASE_HTTP_CRYPTO_TERMS):
        return False, 'tme_no_crypto_terms_in_desc_or_posts', meta

    now = datetime.now(timezone.utc)
    last_dt = prev['last_post_dt']
    if last_dt is None:
        return False, 'tme_no_public_posts_or_dates', meta
    if last_dt.tzinfo is None:
        last_dt = last_dt.replace(tzinfo=timezone.utc)
    if (now - last_dt).days > SCAM_BASE_HTTP_POST_MAX_AGE_DAYS:
        return False, 'tme_no_fresh_post_%dd' % SCAM_BASE_HTTP_POST_MAX_AGE_DAYS, meta

    if any(hm in tme_preview_combined_lower(prev) for hm in TME_HACKED_POST_MARKERS):
        return False, 'tme_channel_reported_hacked', meta

    return True, 'ok_tme_http_gate', meta


def prune_scam_base_telegram_rows_http(
    sheets,
    spreadsheet_id: str,
    *,
    sheet_name: Optional[str] = None,
    dry_run: bool = False,
    pause_sec: float = 0.4,
) -> Dict[str, Any]:
    """
    Удалить из scam_base строки Telegram, не проходящие HTTP-gate или из FORCE_REMOVE_USERNAMES.
    """
    rng = (os.environ.get('KRO_SCAM_BASE_RANGE') or 'scam_base!A2:N').strip()
    sn = sheet_name or (rng.split('!')[0] if '!' in rng else 'scam_base')
    range_all = f'{sn}!A2:N'

    rows = (
        sheets.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=range_all)
        .execute()
        .get('values', [])
    )

    slug_cache: Dict[str, Tuple[bool, str, Dict[str, Any]]] = {}
    remove_idx: List[int] = []
    pause_sec = max(0.1, min(float(pause_sec), 3.0))

    for i, row in enumerate(rows):
        if not is_telegram_scam_base_row(row):
            continue
        if telegram_scam_base_row_matches_denylist(row):
            remove_idx.append(i)
            continue
        u = (row[0] if len(row) > 0 else '').strip()
        link = (row[1] if len(row) > 1 else '').strip()
        u_n = norm_username_cell(u)
        link_n = norm_username_cell(link)
        if u_n in FORCE_REMOVE_USERNAMES or link_n in FORCE_REMOVE_USERNAMES:
            remove_idx.append(i)
            continue
        slug = _normalize_slug(link or u)
        if not slug or slug.startswith('+'):
            continue
        if slug not in slug_cache:
            slug_cache[slug] = tme_http_gate_for_scam_base_write(
                link or u,
                object_type=(row[5] if len(row) > 5 else '') or '',
                source_evidence=(row[10] if len(row) > 10 else '') or '',
                content_analysis=(row[13] if len(row) > 13 else '') or '',
            )
            time.sleep(pause_sec)
        ok, _, _meta = slug_cache[slug]
        if not ok:
            remove_idx.append(i)

    out = {
        'rows_before': len(rows),
        'removed': len(remove_idx),
        'dry_run': dry_run,
    }
    if dry_run or not remove_idx:
        return out

    kept = [rows[j] for j in range(len(rows)) if j not in set(remove_idx)]
    for j, r in enumerate(kept):
        kept[j] = (list(r) + [''] * 14)[:14]

    sheets.spreadsheets().values().clear(spreadsheetId=spreadsheet_id, range=range_all, body={}).execute()
    if kept:
        sheets.spreadsheets().values().append(
            spreadsheetId=spreadsheet_id,
            range=f'{sn}!A2:N',
            valueInputOption='USER_ENTERED',
            insertDataOption='INSERT_ROWS',
            body={'values': kept},
        ).execute()
    out['rows_after'] = len(kept)
    return out
