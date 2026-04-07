#!/usr/bin/env python3
"""
KRO Web Scraper: собирает упоминания скам-каналов с сайтов-разоблачителей.

Источники:
  - stop-scam1.com    — разоблачение телеграм-каналов сигналов и курсов
  - fin-obzor.net     — обзоры финансовых и крипто-мошенников
  - brokers-check.ru  — доп. источник жалоб, если сайт доступен и содержит крипто-каналы
  - cryptorussia.ru   — разборы крипто-каналов и трейдеров с отзывами и схемами обмана
  - vklader.com       — чёрный список Telegram-каналов и пользовательские проверки
  - telltrue.net      — blacklist-telegram (формат как у vklader)
  - forteck.net       — blacklist-telegram (формат как у vklader)
  - kurs.expert       — черный список фейковых крипто-обменников (домены из таблицы)

Каждая найденная запись: {channel, sum_rub, description, source_url, source[, object_type]}
Возвращаемые данные пишутся в лист reports Google Sheets с пометкой source='web'.
"""
import os
import re
import json
import logging
from datetime import datetime, timezone
from urllib.parse import urljoin, quote_plus, urlparse

logger = logging.getLogger(__name__)
_LAST_SOURCE_STATUS = []

_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/122.0.0.0 Safari/537.36'
    ),
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

def _running_on_github_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS", "").lower() == "true"


def _fetch_timeout() -> float:
    """На раннерах GitHub DDG/часть сайтов таймаутятся; короче таймаут = меньше шума в логе."""
    if _running_on_github_actions():
        return float(os.environ.get("KRO_WEB_FETCH_TIMEOUT_GHA", "12"))
    return float(os.environ.get("KRO_WEB_FETCH_TIMEOUT", "25"))


# Сообщение про пропуск DDG в CI — один раз за процесс
_DDG_SKIP_IN_CI_LOGGED = False
_CRYPTO_HINTS = (
    'telegram', 'телеграм', 't.me', '@',
    'crypto', 'крипт', 'сигнал', 'signal',
    'vip', 'вип', 'трейд', 'trading', 'инвест', 'бирж',
)

_SCAM_FACT_HINTS = (
    'обман', 'мошенн', 'скам', 'развод', 'не отвечает', 'перестал отвечать',
    'заблокир', 'не возвращ', 'не вернул', 'слил депозит', 'слив депозита',
    'гарантир', 'обещал', 'обещают', 'платн', 'vip', 'вип', 'подписк',
    'после оплаты', 'выман', 'потерял', 'потеряла', 'жалоб', 'отзыв',
)


def _set_source_status(name, status, count=0):
    global _LAST_SOURCE_STATUS
    _LAST_SOURCE_STATUS = [s for s in _LAST_SOURCE_STATUS if s.get('name') != name]
    _LAST_SOURCE_STATUS.append({
        'name': name,
        'status': status,
        'count': int(count or 0),
    })


def get_last_source_statuses():
    return list(_LAST_SOURCE_STATUS)


def _fetch(url):
    """
    Fetch URL. Uses requests library (handles Cloudflare better than urllib).
    Falls back to urllib if requests is unavailable.
    Returns decoded text or None on error.
    """
    # --- requests (preferred: bypasses Cloudflare bot checks better) ---
    try:
        import requests
        sess = requests.Session()
        sess.headers.update(_HEADERS)
        resp = sess.get(url, timeout=_fetch_timeout(), allow_redirects=True)
        resp.raise_for_status()
        return resp.text
    except Exception as e:
        logger.debug('requests fetch failed for %s: %s', url, e)
    # --- urllib fallback ---
    try:
        from urllib.request import urlopen, Request as URequest
        from urllib.error import URLError, HTTPError
        req = URequest(url, headers=_HEADERS)
        with urlopen(req, timeout=_fetch_timeout()) as resp:
            charset = resp.headers.get_content_charset() or 'utf-8'
            return resp.read().decode(charset, errors='replace')
    except Exception as e:
        logger.warning('web_scraper fetch error %s: %s', url, e)
        return None


_JSON_LD_NOISE = frozenset({
    'context', 'graph', 'type', 'id', 'name', 'url', 'image',
    'datePublished', 'dateModified', 'author', 'publisher',
    'description', 'breadcrumb', 'itemListElement', 'item',
    'potentialAction', 'target', 'query',
})


_CHANNEL_NOISE = frozenset({
    # Generic internet/email services — not Telegram channels
    'gmail', 'yahoo', 'mail', 'yandex', 'outlook', 'hotmail', 'protonmail',
    # Stop-scam1.com site admin contact
    'feel340',
    # Common social media handles mistaken for TG channels
    'instagram', 'facebook', 'twitter', 'youtube', 'tiktok', 'vkontakte',
    # Anti-scam watchdog channels — should never be classified as scam
    'cryptoscammsup', 'crypt0scamm', 'publicryptoscamm', 'scamrsalert',
    'vklader', 'telltrue', 'forteck',
    # Generic words sometimes parsed as @mentions
    'support', 'admin', 'help', 'info', 'news', 'official', 'channel',
    'contact', 'manager', 'operator', 'bot', 'feedback',
})


def _extract_channel_mentions(text):
    """
    Extract @username and t.me/ channel references from plain text.
    Filters out JSON-LD schema noise, known non-channel handles (email services,
    site admins, generic words), and very short strings.
    Returns list of normalised usernames (without @).
    """
    found = set()
    for m in re.finditer(r'@([A-Za-z][A-Za-z0-9_]{3,})', text):
        uname = m.group(1)
        uname_lower = uname.lower()
        if uname_lower in _JSON_LD_NOISE:
            continue
        if uname_lower in _CHANNEL_NOISE:
            continue
        if len(uname) < 5:
            continue
        found.add(uname_lower)
    # t.me/username (skip invite links with +, skip known service paths)
    _skip_paths = frozenset({'joinchat', 'addstickers', 'share', 'proxy', 'm', 's'})
    for m in re.finditer(r't\.me/([A-Za-z][A-Za-z0-9_]{3,})', text):
        uname = m.group(1)
        uname_lower = uname.lower()
        if uname_lower in _skip_paths or uname_lower in _JSON_LD_NOISE:
            continue
        if uname_lower in _CHANNEL_NOISE:
            continue
        found.add(uname_lower)
    return list(found)


def _clean_html_text(raw_html):
    """
    Strip <script>, <style>, and all other HTML tags, then collapse whitespace.
    Removing scripts prevents JSON-LD schema (@context, @graph) from polluting text.
    """
    h = raw_html or ''
    # Remove script and style blocks entirely (including their content)
    h = re.sub(r'<script[^>]*>.*?</script>', ' ', h, flags=re.DOTALL | re.IGNORECASE)
    h = re.sub(r'<style[^>]*>.*?</style>', ' ', h, flags=re.DOTALL | re.IGNORECASE)
    # Remove remaining HTML tags
    h = re.sub(r'<[^>]+>', ' ', h)
    return re.sub(r'\s+', ' ', h).strip()


def _has_crypto_context(text, url=''):
    haystack = f'{text} {url}'.lower()
    return any(hint in haystack for hint in _CRYPTO_HINTS)


def _has_concrete_scam_facts(text):
    haystack = (text or '').lower()
    return any(hint in haystack for hint in _SCAM_FACT_HINTS)


_SITE_PROMO_PHRASES = (
    'прошел проверку и принес',
    'ручаемся',
    'метод заработка',
    'надежный метод',
    'проверенный заработок',
)


def _extract_loss_amount(text):
    """
    Try to find a victim loss amount in roubles from text.
    Ignores site's own promo texts (e.g. "250 тысяч рублей принес метод").
    Returns integer roubles or 0.
    """
    t = text.replace('\xa0', ' ')

    # Remove site promo sentences so "250 тыс" from the promo isn't picked up
    for phrase in _SITE_PROMO_PHRASES:
        # Remove the sentence containing the promo phrase
        t = re.sub(r'[^.!?]*' + re.escape(phrase) + r'[^.!?]*[.!?]?', ' ', t, flags=re.IGNORECASE)

    # Loss context words: we look for amounts near victim language
    # e.g. "передала 400 долларов", "потеряла 15 000 рублей", "слил 30к₽"
    loss_context = re.search(
        r'(?:передал[аи]?|потерял[аи]?|слил[аи]?|вложил[аи]?|заплатил[аи]?|отдал[аи]?)\s+'
        r'([\d\s]{1,15}(?:тыс|к|млн)?\s*(?:₽|руб|рублей|долларов|долл|usd|\$|€)?)',
        t, re.IGNORECASE
    )
    if loss_context:
        raw = loss_context.group(1).strip()
        # Convert to rubles (rough: 1 USD ≈ 90 RUB)
        if re.search(r'долл|usd|\$', raw, re.IGNORECASE):
            digits = int(re.sub(r'[^\d]', '', raw) or '0')
            return digits * 90
        if re.search(r'€|евро', raw, re.IGNORECASE):
            digits = int(re.sub(r'[^\d]', '', raw) or '0')
            return digits * 100
        if re.search(r'млн', raw, re.IGNORECASE):
            return int(float(re.sub(r'[^\d.]', '', raw) or '0') * 1_000_000)
        if re.search(r'тыс|к', raw, re.IGNORECASE):
            return int(re.sub(r'[^\d]', '', raw) or '0') * 1000
        digits = int(re.sub(r'[^\d]', '', raw) or '0')
        if 100 <= digits <= 100_000_000:
            return digits

    # Fallback: any ruble amount in text
    m = re.search(r'(\d[\d\s]{1,8}\d|\d+)\s*(?:₽|руб|рублей)', t, re.IGNORECASE)
    if m:
        digits = int(re.sub(r'[^\d]', '', m.group(0)) or '0')
        if 100 <= digits <= 10_000_000:
            return digits
    return 0


def _parse_article_links(html, base_url, pattern_hint=''):
    """
    Extract article URLs from a listing page.
    Returns list of absolute URLs.
    """
    links = []
    # Look for <a href="...">
    for m in re.finditer(r'<a\s[^>]*href=["\']([^"\']+)["\']', html, re.IGNORECASE):
        href = m.group(1).strip()
        if not href or href.startswith('#') or href.startswith('javascript'):
            continue
        if not href.startswith('http'):
            href = urljoin(base_url.rstrip('/') + '/', href)
        # Keep only same-domain links that look like articles
        if base_url.split('/')[2] in href:
            links.append(href)
    # Deduplicate preserving order
    seen = set()
    result = []
    for l in links:
        if l not in seen:
            seen.add(l)
            result.append(l)
    return result


def _parse_search_result_links(html):
    """
    Extract outbound result links from simple search-engine HTML pages.
    Best-effort only: if layout changes or engine blocks requests, returns [].
    """
    links = []
    for m in re.finditer(r'href=["\'](https?://[^"\']+)["\']', html or '', re.IGNORECASE):
        href = m.group(1).strip()
        if not href:
            continue
        bad = (
            'duckduckgo.com' in href or
            'google.com/search' in href or
            'bing.com/search' in href or
            'yandex.' in href and '/search/' in href
        )
        if bad:
            continue
        links.append(href)
    seen = set()
    out = []
    for link in links:
        if link not in seen:
            seen.add(link)
            out.append(link)
    return out


_SEARCH_ENGINE_URLS = (
    'https://duckduckgo.com/html/?q={q}',
    'https://www.bing.com/search?q={q}',
)

_VICTIM_QUERY_LIMIT_PER_QUERY = 5

# Запросы, которыми реально пользуются пострадавшие и люди перед входом в канал/сервис.
_VICTIM_SCAM_CHANNEL_QUERIES = [
    'крипто сигналы телеграм заработок отзывы',
    'VIP сигналы крипта развод обман',
    'быстрый заработок криптовалюта телеграм',
    'трейдинг сигналы гарантия прибыль телеграм',
    'крипто гуру телеграм развод',
    'сигналы long short телеграм мошенники',
    'инвестиции крипта телеграм бот отзывы',
    'доверительное управление крипта телеграм',
    'крипто наставник телеграм скам',
    'заработок на бирже телеграм сигналы обман',
]

_VICTIM_EXCHANGER_QUERIES = [
    'крипто обменник не выводит деньги',
    'телеграм обменник криптовалюта развод',
    'P2P обменник крипта мошенники',
    'обменник USDT заблокировал вывод',
]

_VICTIM_INVEST_BOT_QUERIES = [
    'инвест бот телеграм процент в день',
    'торговый бот крипта автоматический заработок развод',
    'бот трейдинг телеграм депозит не выводит',
]


_VICTIM_CRYPTO_STRICT_HINTS = (
    'крипт', 'crypto', 'btc', 'eth', 'usdt', 'usdc', 'ton', 'sol', 'bnb',
    'binance', 'bybit', 'okx', 'kucoin', 'p2p', 'обменник', 'бирж',
    'фьючерс', 'спот', 'блокчейн', 'blockchain', 'кошел', 'wallet',
)
_VICTIM_NON_CRYPTO_HINTS = (
    'недвижим', 'квартир', 'новострой', 'ипотек', 'риелт', 'аренд',
    'автомоб', 'машин', 'автосалон', 'дилер', 'real estate', 'mortgage',
)


def _search_urls_for_query(query, max_links=20):
    links = []
    seen = set()
    for engine_tpl in _SEARCH_ENGINE_URLS:
        search_url = engine_tpl.format(q=quote_plus(query))
        html = _fetch(search_url)
        if not html:
            continue
        for link in _parse_search_result_links(html):
            low = link.lower()
            if any(skip in low for skip in (
                'duckduckgo.com', 'google.com', 'bing.com', 'yandex.', 'yahoo.com/search',
            )):
                continue
            if link in seen:
                continue
            seen.add(link)
            links.append(link)
            if len(links) >= max_links:
                return links
    return links


def _victim_query_page_is_crypto_relevant(page, url, query, object_type):
    """
    Early anti-noise filter before _build_findings_from_page:
    keep only pages with explicit crypto context and no obvious non-crypto context.
    """
    clean = _clean_html_text(page or '')
    low = f'{query} {url} {clean[:3500]}'.lower()
    if any(h in low for h in _VICTIM_NON_CRYPTO_HINTS):
        return False
    if object_type == 'крипто-обменник':
        return any(h in low for h in ('обменник', 'exchange', 'usdt', 'p2p', 'крипт', 'crypto'))
    if object_type == 'инвест-бот':
        return any(h in low for h in ('бот', 'bot', 'депозит', 'крипт', 'crypto', 'трейдинг'))
    return any(h in low for h in _VICTIM_CRYPTO_STRICT_HINTS)


def _scrape_victim_queries():
    """
    Поисковый контур по «живым» victim-запросам:
    - скам-каналы;
    - крипто-обменники;
    - инвест-боты.
    Для каждого query берём максимум 5 новых объектов, чтобы не засорять базу.
    """
    query_groups = [
        ('сигнал-канал', _VICTIM_SCAM_CHANNEL_QUERIES),
        ('крипто-обменник', _VICTIM_EXCHANGER_QUERIES),
        ('инвест-бот', _VICTIM_INVEST_BOT_QUERIES),
    ]
    out = []
    all_unique = set()
    total_queries = 0

    for object_type, queries in query_groups:
        for query in queries:
            total_queries += 1
            per_query_count = 0
            per_query_seen = set()
            urls = _search_urls_for_query(query, max_links=18)
            for url in urls:
                page = _fetch(url)
                if not page:
                    continue
                if not _victim_query_page_is_crypto_relevant(page, url, query, object_type):
                    continue
                findings = _build_findings_from_page(page, url, 'web-search')
                for f in findings:
                    ch = (f.get('channel') or '').strip().lower()
                    if not ch:
                        continue
                    if ch in per_query_seen or ch in all_unique:
                        continue
                    # Обогащаем запись классификацией по группе запроса.
                    f = dict(f)
                    f['object_type'] = object_type
                    # Чётко фиксируем источник и поисковый интент.
                    desc = (f.get('description') or '')
                    f['description'] = ('Поиск: "%s" | %s' % (query, desc))[:500]
                    out.append(f)
                    per_query_seen.add(ch)
                    all_unique.add(ch)
                    per_query_count += 1
                    if per_query_count >= _VICTIM_QUERY_LIMIT_PER_QUERY:
                        break
                if per_query_count >= _VICTIM_QUERY_LIMIT_PER_QUERY:
                    break

    unique_channels = len({r.get('channel') for r in out if r.get('channel')})
    _set_source_status('web-victim-search', 'found' if unique_channels else 'not_found', unique_channels)
    logger.info('web-victim-search: queries=%d, findings=%d', total_queries, len(out))
    return out


def _search_review_urls_for_username(username, max_links=3):
    """
    Search public web pages for '@username скам' / '@username развод'.
    Used as an additional enrichment source, not as the primary source of truth.
    """
    uname = (username or '').strip().lstrip('@').lower()
    if not uname or len(uname) < 4:
        return []
    queries = [
        f'@{uname} скам',
        f'@{uname} развод',
    ]
    results = []
    seen = set()
    for query in queries:
        search_url = 'https://duckduckgo.com/html/?q=' + quote_plus(query)
        html = _fetch(search_url)
        if not html:
            continue
        for link in _parse_search_result_links(html):
            low = link.lower()
            if any(skip in low for skip in (
                'stop-scam1.com', 'fin-obzor.net', 'brokers-check.ru',
                'kurs.expert',
                'duckduckgo.com', 'google.com', 'bing.com', 'yandex.'
            )):
                continue
            if link not in seen:
                seen.add(link)
                results.append(link)
            if len(results) >= max_links:
                return results
    return results


def _collect_article_links(listing_urls, base_url, max_links=20):
    """Fetch listing pages and collect unique same-domain article links."""
    links = []
    seen = set()
    for listing_url in listing_urls:
        html = _fetch(listing_url)
        if not html:
            continue
        for link in _parse_article_links(html, base_url):
            if '/category/' in link or '/tag/' in link or '/page/' in link:
                continue
            if link not in seen:
                seen.add(link)
                links.append(link)
            if len(links) >= max_links:
                return links
    return links


def _unique_list(items):
    seen = set()
    out = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _extract_article_body(page):
    """
    Try to isolate the main article body before the footer/navigation.
    Looks for common article markers and cuts at footer.
    """
    # Remove script/style first
    h = re.sub(r'<script[^>]*>.*?</script>', ' ', page or '', flags=re.DOTALL | re.IGNORECASE)
    h = re.sub(r'<style[^>]*>.*?</style>', ' ', h, flags=re.DOTALL | re.IGNORECASE)

    # Try to find the article body between common content markers
    # Cut at footer markers to avoid picking up navigation/contact info
    footer_markers = [
        r'<footer', r'class=["\'][^"\']*footer',
        r'id=["\']footer', r'По всем вопросам пишите',
        r'Все права защищены', r'Copyright',
        r'class=["\'][^"\']*widget', r'class=["\'][^"\']*sidebar',
    ]
    for marker in footer_markers:
        m = re.search(marker, h, re.IGNORECASE)
        if m:
            h = h[:m.start()]
            break

    # Also try to start from article content (after nav/header)
    article_start = re.search(r'<article|<main|class=["\'][^"\']*entry-content|class=["\'][^"\']*post-content', h, re.IGNORECASE)
    if article_start:
        h = h[article_start.start():]

    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', h)).strip()


_FOOTER_NOISE = [
    'по всем вопросам', 'feel340', 'написать нам', 'свяжитесь с нами',
    'все права защищены', 'copyright', 'политика конфиденциальности',
    'подписывайтесь на нас', 'наш email', 'наша почта', 'согласие на обработку',
]
_NAV_NOISE = [
    'перейти к содержимому', 'меню навигации', 'поиск по сайту',
    'написать в whatsapp', 'оставить отзыв о мошеннике', 'задать вопрос',
]


def _extract_article_paragraphs(html):
    """
    Use BeautifulSoup to extract meaningful paragraphs from article body.
    Filters out footer, navigation, and contact noise.
    Returns list of clean paragraph strings.
    """
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, 'html.parser')
        # Remove noise elements
        for tag in soup.find_all(['script', 'style', 'nav', 'footer', 'header',
                                   'aside', 'form', 'button', 'noscript', 'iframe']):
            tag.decompose()
        # Find article container
        article = (
            soup.find('article') or
            soup.find('div', class_=re.compile(r'post[-_]?(content|body|entry|text)', re.I)) or
            soup.find('div', class_=re.compile(r'entry[-_]?(content|body)', re.I)) or
            soup.find('div', {'itemprop': 'articleBody'}) or
            soup.find('main')
        )
        if not article:
            all_divs = [d for d in soup.find_all('div') if len(d.get_text()) > 200]
            article = max(all_divs, key=lambda d: len(d.get_text()), default=soup)
        paragraphs = []
        for p in article.find_all(['p', 'li']):
            t = p.get_text(' ', strip=True)
            if len(t) < 50:
                continue
            tl = t.lower()
            if any(m in tl for m in _FOOTER_NOISE + _NAV_NOISE):
                continue
            if t.count('http') > 2:
                continue
            paragraphs.append(t)
            if len(paragraphs) >= 4:
                break
        return paragraphs
    except ImportError:
        # BeautifulSoup not available — fallback to regex extraction
        return []


def _select_evidence_paragraphs(paragraphs):
    """
    Prefer paragraphs with concrete scam facts over generic intro text.
    """
    if not paragraphs:
        return []
    fact_paragraphs = [p for p in paragraphs if _has_concrete_scam_facts(p)]
    return fact_paragraphs[:3] if fact_paragraphs else paragraphs[:3]


def _extract_title_from_html(page):
    title_match = re.search(r'<h1[^>]*>(.*?)</h1>', page or '', re.IGNORECASE | re.DOTALL)
    if title_match:
        return _clean_html_text(title_match.group(1))
    title_match = re.search(r'<title[^>]*>(.*?)</title>', page or '', re.IGNORECASE | re.DOTALL)
    if title_match:
        return _clean_html_text(title_match.group(1))
    return ''


def _extract_cryptorussia_channels(page, url):
    """
    Для честной классификации берём только явные @username / t.me
    из текста статьи или заголовка. Ничего не додумываем из slug/title.
    """
    title = _extract_title_from_html(page)
    clean = _clean_html_text(page)
    channels = [c for c in _extract_channel_mentions(f'{title} {clean}') if c != 'cryptorussia']
    return _unique_list(channels)


def _build_findings_from_page(page, url, source_name, max_channels=3):
    """
    Turn a fetched article page into complaint findings.
    Uses BeautifulSoup for clean description extraction (no footer noise).
    """
    # Try BS4-based paragraph extraction first
    paragraphs = _extract_article_paragraphs(page)
    if paragraphs:
        evidence_paragraphs = _select_evidence_paragraphs(paragraphs)
        clean_for_channels = ' '.join(paragraphs)
        desc_snippet = ' | '.join(evidence_paragraphs)
    else:
        # Fallback to regex article body extraction
        clean_for_channels = _extract_article_body(page) or _clean_html_text(page)
        desc_snippet = clean_for_channels[:400].strip()

    if not clean_for_channels:
        return []
    channels = _extract_channel_mentions(clean_for_channels)
    if not channels:
        # Also scan full page for channel mentions (in case BS4 missed them)
        full_clean = _clean_html_text(page)
        channels = _extract_channel_mentions(full_clean)
    if not channels:
        return []
    if not _has_crypto_context(clean_for_channels, url):
        return []
    if not _has_concrete_scam_facts(desc_snippet or clean_for_channels):
        return []

    sum_rub = _extract_loss_amount(clean_for_channels)

    # Build source_evidence: source URL + clean description
    evidence = f"Источник: {url} | {desc_snippet[:400]}"

    findings = []
    for ch in channels[:max_channels]:
        findings.append({
            'channel': '@' + ch,
            'sum_rub': sum_rub,
            'description': evidence[:500],
            'source_url': url,
            'source': source_name,
        })
    return findings


def _extract_blacklist_site_article_links(html, base_url, limit=25):
    """Extract relevant article links from blacklist-style sites (same layout as vklader)."""
    links = []
    seen = set()
    skip_paths = (
        '/blacklist-telegram', '/proverka-telegram', '/vash-post/', '/pamyatka/',
        '/rubrika/', '/tag/', '/page/', '/wp-content/', '/wp-json/', '/comment',
    )
    for link in _parse_article_links(html, base_url):
        low = link.lower()
        if any(skip in low for skip in skip_paths):
            continue
        path = urlparse(link).path.strip('/')
        if not path or '/' in path:
            continue
        if link not in seen:
            seen.add(link)
            links.append(link)
        if len(links) >= limit:
            break
    return links


def _build_blacklist_page_findings(page, url, source_field, noise_handles=()):
    """
    Parse inline blacklist entries from a blacklist-telegram style page (vklader / telltrue / forteck).
    Keeps source_url on the blacklist page for direct verification.
    noise_handles: site @handles to skip in promo lines (e.g. 'vklader', 'telltrue').
    """
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(page or '', 'html.parser')
    except ImportError:
        soup = None

    results = []
    seen = set()
    blocks = []

    if soup is not None:
        article = soup.find('article') or soup.find('main') or soup
        for node in article.find_all(['p', 'li']):
            text = node.get_text(' ', strip=True)
            if '@' not in text:
                continue
            blocks.append(text)
    else:
        blocks = re.findall(r'>([^<>]*@[^<>]{10,500})<', page or '', re.IGNORECASE)

    for text in blocks:
        clean = re.sub(r'\s+', ' ', text).strip()
        clean_lower = clean.lower()
        if len(clean) < 20:
            continue
        skip_noise = False
        for h in noise_handles or ():
            if h and ('@' + str(h).lower()) in clean_lower:
                skip_noise = True
                break
        if skip_noise:
            continue
        if 'подписывайтесь' in clean_lower or 'финсайд' in clean_lower:
            continue
        channels = _extract_channel_mentions(clean)
        if not channels:
            continue
        if not (_has_concrete_scam_facts(clean) or 'черн' in clean_lower or 'лохотрон' in clean_lower or 'мошенн' in clean_lower):
            continue
        evidence = f'Источник: {url} | {clean[:400]}'
        sum_rub = _extract_loss_amount(clean)
        for ch in channels[:3]:
            key = ('@' + ch, url, clean[:120])
            if key in seen:
                continue
            seen.add(key)
            results.append({
                'channel': '@' + ch,
                'sum_rub': sum_rub,
                'description': evidence[:500],
                'source_url': url,
                'source': source_field,
            })
    return results


def _dedupe_findings_channel_per_url(results):
    """Deduplicate findings by (channel_lower, source_url)."""
    dedup = {}
    for r in results:
        source_url = (r.get('source_url') or '').strip()
        channel = (r.get('channel') or '').strip().lower()
        if not source_url or not channel:
            continue
        key = (channel, source_url)
        if key not in dedup:
            dedup[key] = r
    return list(dedup.values())


_DOMAIN_HOST_RE = re.compile(
    r'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$',
    re.IGNORECASE,
)


def _looks_like_domain_host(text):
    t = (text or '').strip().lower().rstrip('.')
    if not t or len(t) < 4 or ' ' in t or '/' in t or '<' in t:
        return False
    return bool(_DOMAIN_HOST_RE.match(t))


def _classify_kurs_domain_object_type(hostname):
    """
    Чёрный список kurs.expert — в основном фейковые обменники.
    Эвристика «инвест-бот» для доменов с явным bot в имени (не все подряд).
    """
    h = (hostname or '').strip().lower()
    if re.search(r'(?:^|[._-])bot(?:[._-]|$)|\.bot\.|bot\.(?:io|com|net|org|ru|app)\b', h):
        return 'инвест-бот'
    return 'крипто-обменник'


def _parse_kurs_expert_blacklist_domains(html, max_entries=400):
    """
    Таблица class ~exchangers_blacklist: ячейки с доменами, столбцы с номерами пропускаем.
    """
    domains = []
    seen = set()
    if not html:
        return domains
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, 'html.parser')
        table = soup.find('table', class_=re.compile(r'exchangers_blacklist'))
        if not table:
            return domains
        for td in table.find_all('td'):
            cls = ' '.join(td.get('class') or [])
            if 'numbs' in cls:
                continue
            text = td.get_text(strip=True)
            if not text:
                continue
            if re.match(r'^\d+\.$', text):
                continue
            if not _looks_like_domain_host(text):
                continue
            host = text.strip().lower().rstrip('.')
            if host in ('kurs.expert', 'www.kurs.expert'):
                continue
            if host not in seen:
                seen.add(host)
                domains.append(host)
            if len(domains) >= max_entries:
                break
        return domains
    except ImportError:
        pass
    # Regex fallback (без BeautifulSoup)
    m = re.search(
        r'<table[^>]+class="[^"]*exchangers_blacklist[^"]*"[^>]*>(.*?)</table>',
        html,
        re.IGNORECASE | re.DOTALL,
    )
    if not m:
        return domains
    block = m.group(1)
    for mm in re.finditer(r'<td(?:\s[^>]*)?>([^<]*)</td>', block, re.IGNORECASE):
        text = re.sub(r'\s+', ' ', mm.group(1)).strip()
        if not text or re.match(r'^\d+\.$', text):
            continue
        if not _looks_like_domain_host(text):
            continue
        host = text.lower().rstrip('.')
        if host in ('kurs.expert', 'www.kurs.expert'):
            continue
        if host not in seen:
            seen.add(host)
            domains.append(host)
        if len(domains) >= max_entries:
            break
    return domains


_KURS_EXPERT_PAGE_URLS = (
    'https://kurs.expert/ru/cherniy-spisok-obmennikov.html',
    'https://kurs.expert/ru/cherniy-spisok-obmennikov/',
)


def scrape_kurs_expert():
    """
    Чёрный список фейковых обменников kurs.expert: домен + краткое описание.
    Лимит строк за проход: KRO_KURS_BLACKLIST_MAX (по умолчанию 400).
    """
    results = []
    max_entries = 400
    try:
        max_entries = max(50, min(5000, int(os.environ.get('KRO_KURS_BLACKLIST_MAX', '400') or '400')))
    except ValueError:
        max_entries = 400

    html = None
    page_url = None
    for url in _KURS_EXPERT_PAGE_URLS:
        html = _fetch(url)
        if html:
            page_url = url
            break
    if not html or not page_url:
        _set_source_status('kurs.expert', 'unavailable', 0)
        logger.info('kurs.expert: blacklist page unavailable')
        return results

    domains = _parse_kurs_expert_blacklist_domains(html, max_entries=max_entries)
    if not domains:
        _set_source_status('kurs.expert', 'not_found', 0)
        logger.info('kurs.expert: no domains parsed from blacklist table')
        return results

    intro = _extract_title_from_html(html) or 'Чёрный список обменников'
    for host in domains:
        obj_type = _classify_kurs_domain_object_type(host)
        if obj_type == 'инвест-бот':
            risk_hint = (
                'Типовые признаки инвест-бота: обещание процента в день, требование пополнить депозит, блокировка вывода.'
            )
        else:
            risk_hint = (
                'Типовые признаки фейкового обменника: завышенный спред (часто 9–15% и выше), '
                'доплата за вывод, ссылка на AML-блокировку средств.'
            )
        desc = (
            f'Источник: {page_url} | {intro}. Домен: {host}. {risk_hint}'
        )
        results.append({
            'channel': host,
            'sum_rub': 0,
            'description': desc[:500],
            'source_url': page_url,
            'source': 'kurs.expert',
            'object_type': obj_type,
        })

    _set_source_status('kurs.expert', 'found', len(domains))
    logger.info('kurs.expert: parsed %d blacklist domains', len(domains))
    return results


def get_kurs_expert_blacklist_hosts(max_hosts=8000):
    """
    Только список доменов с страницы чёрного списка (для органического цикла).
    Возвращает (hosts: list[str], page_url: str или '').
    """
    max_hosts = max(100, min(12000, int(max_hosts or 8000)))
    html = None
    page_url = None
    for url in _KURS_EXPERT_PAGE_URLS:
        html = _fetch(url)
        if html:
            page_url = url
            break
    if not html:
        return [], ''
    hosts = _parse_kurs_expert_blacklist_domains(html, max_entries=max_hosts)
    return hosts, (page_url or '')


# ---------------------------------------------------------------------------
# Source 1: stop-scam1.com
# ---------------------------------------------------------------------------

_STOP_SCAM1_BASE = 'https://stop-scam1.com'
# Main page lists all recent articles — category pages return 404.
# We scrape the homepage and filter for Telegram channel articles by URL pattern.
_STOP_SCAM1_LISTINGS = [
    'https://stop-scam1.com/',
]
_STOP_SCAM1_ARTICLE_HINTS = ('telegramm-kanal', 'crypto', 'krip', 'signal', 'trading')


def scrape_stop_scam1():
    """
    Scrape stop-scam1.com homepage for Telegram scam channel articles.
    Filters article links by keyword hints (telegramm-kanal, crypto, signal...).
    Returns list of {channel, sum_rub, description, source_url, source}.
    """
    results = []
    html = _fetch(_STOP_SCAM1_LISTINGS[0])
    if not html:
        _set_source_status('stop-scam1.com', 'unavailable', 0)
        logger.info('stop-scam1.com: homepage unavailable')
        return results
    all_links = _parse_article_links(html, _STOP_SCAM1_BASE)
    # Keep only articles that look like Telegram channel reviews
    article_links = [
        l for l in all_links
        if any(h in l.lower() for h in _STOP_SCAM1_ARTICLE_HINTS)
    ][:20]
    if not article_links:
        _set_source_status('stop-scam1.com', 'not_found', 0)
        logger.info('stop-scam1.com: no listing pages available')
        return results

    for url in article_links:
        page = _fetch(url)
        if not page:
            continue
        results.extend(_build_findings_from_page(page, url, 'stop-scam1'))

    unique_channels = len({r.get('channel') for r in results if r.get('channel')})
    _set_source_status('stop-scam1.com', 'found' if unique_channels else 'not_found', unique_channels)
    logger.info('stop-scam1.com: found %d channel mentions', len(results))
    return results


# ---------------------------------------------------------------------------
# Source 2: fin-obzor.net
# ---------------------------------------------------------------------------

_FIN_OBZOR_BASE = 'https://fin-obzor.net'
_FIN_OBZOR_LISTING = 'https://fin-obzor.net/'


def scrape_fin_obzor():
    """
    Scrape fin-obzor.net for scam crypto channel reviews.
    Returns list of {channel, sum_rub, description, source_url, source}.
    """
    results = []
    html = _fetch(_FIN_OBZOR_LISTING)
    if not html:
        _set_source_status('fin-obzor.net', 'unavailable', 0)
        logger.info('fin-obzor.net: no response from listing page')
        return results

    article_links = _parse_article_links(html, _FIN_OBZOR_BASE)
    # Keep crypto/signal/vip related articles; limit to 20
    keywords = ['крипт', 'signal', 'сигнал', 'vip', 'вип', 'трейд', 'инвест', 'foma', 'cortes', 'trade']
    filtered = []
    for l in article_links:
        if any(kw in l.lower() for kw in keywords):
            filtered.append(l)
    if not filtered:
        filtered = [l for l in article_links if '/category/' not in l]
    filtered = filtered[:20]
    if not filtered:
        _set_source_status('fin-obzor.net', 'not_found', 0)
        logger.info('fin-obzor.net: no suitable article links found')
        return results

    for url in filtered:
        page = _fetch(url)
        if not page:
            continue
        results.extend(_build_findings_from_page(page, url, 'fin-obzor'))

    unique_channels = len({r.get('channel') for r in results if r.get('channel')})
    _set_source_status('fin-obzor.net', 'found' if unique_channels else 'not_found', unique_channels)
    logger.info('fin-obzor.net: found %d channel mentions', len(results))
    return results


# ---------------------------------------------------------------------------
# Source 3: brokers-check.ru
# ---------------------------------------------------------------------------

_BROKERS_CHECK_BASE = 'https://brokers-check.ru'
_BROKERS_CHECK_LISTINGS = [
    'https://brokers-check.ru/category/telegram/',
    'https://brokers-check.ru/category/crypto/',
    'https://brokers-check.ru/tag/telegram/',
    'https://brokers-check.ru/tag/crypto/',
    'https://brokers-check.ru/',
]


def scrape_brokers_check():
    """
    Scrape brokers-check.ru for crypto Telegram complaint pages if the site is reachable.
    Returns list of {channel, sum_rub, description, source_url, source}.
    """
    results = []
    article_links = []
    seen = set()
    available = False
    for listing_url in _BROKERS_CHECK_LISTINGS:
        html = _fetch(listing_url)
        if not html:
            continue
        available = True
        for link in _parse_article_links(html, _BROKERS_CHECK_BASE):
            if '/category/' in link or '/tag/' in link or '/page/' in link:
                continue
            if link not in seen:
                seen.add(link)
                article_links.append(link)
            if len(article_links) >= 20:
                break
        if len(article_links) >= 20:
            break
    if not available:
        _set_source_status('brokers-check.ru', 'unavailable', 0)
        logger.info('brokers-check.ru: site unreachable')
        return results
    if not article_links:
        _set_source_status('brokers-check.ru', 'not_found', 0)
        logger.info('brokers-check.ru: no listing pages available')
        return results

    for url in article_links:
        page = _fetch(url)
        if not page:
            continue
        findings = _build_findings_from_page(page, url, 'brokers-check')
        if findings:
            results.extend(findings)

    unique_channels = len({r.get('channel') for r in results if r.get('channel')})
    _set_source_status('brokers-check.ru', 'found' if unique_channels else 'not_found', unique_channels)
    logger.info('brokers-check.ru: found %d channel mentions', len(results))
    return results


# ---------------------------------------------------------------------------
# Source 4: cryptorussia.ru
# ---------------------------------------------------------------------------

_CRYPTORUSSIA_BASE = 'https://cryptorussia.ru'
_CRYPTORUSSIA_LISTINGS = [
    'https://cryptorussia.ru/',
]
_CRYPTORUSSIA_ARTICLE_HINTS = (
    'otzyv', 'otzyvy', 'telegram', 'bot', 'trejder', 'trader',
    'scam', 'moshennichestvo',
)
_CRYPTORUSSIA_SKIP_PATHS = (
    '/blog', '/trading/', '/knowledge/', '/zametki/', '/trejdery/',
    '/wp-json', '/wp-content', '/category/', '/tag/'
)
_CRYPTORUSSIA_FRAUD_WORDS = (
    'мошенничество',
    'мошенничеств',
    'скам',
    'обманули',
    'обманул',
    'не выводят',
    'не выводит',
    'пропали',
    'пропал',
    'взяли деньги',
    'взял деньги',
)


def _extract_cryptorussia_rating(text):
    m = re.search(r'средняя\s+оценка\s+([0-9]+(?:[.,][0-9]+)?)\s*/\s*5', text or '', re.IGNORECASE)
    if not m:
        return None
    try:
        return float(m.group(1).replace(',', '.'))
    except Exception:
        return None


def _extract_cryptorussia_reviews_count(text):
    m = re.search(r'отзывы\s*\((\d+)\)', text or '', re.IGNORECASE)
    if not m:
        return 0
    try:
        return int(m.group(1))
    except Exception:
        return 0


def _has_cryptorussia_scam_evidence(text):
    lowered = (text or '').lower()
    has_fraud_words = any(hint in lowered for hint in _CRYPTORUSSIA_FRAUD_WORDS)
    rating = _extract_cryptorussia_rating(lowered)
    reviews_count = _extract_cryptorussia_reviews_count(lowered)
    has_user_complaints = ('жалоб' in lowered or 'отзывы' in lowered) and reviews_count > 0
    return has_fraud_words or ((rating is not None and rating < 3.0) and has_user_complaints)


def scrape_cryptorussia():
    """
    Scrape cryptorussia.ru for Telegram/crypto review pages with scam evidence.
    Returns list of {channel, sum_rub, description, source_url, source}.
    """
    results = []
    html = _fetch(_CRYPTORUSSIA_LISTINGS[0])
    if not html:
        _set_source_status('cryptorussia.ru', 'unavailable', 0)
        logger.info('cryptorussia.ru: homepage unavailable')
        return results

    article_links = []
    for link in _parse_article_links(html, _CRYPTORUSSIA_BASE):
        low = link.lower()
        if any(skip in low for skip in _CRYPTORUSSIA_SKIP_PATHS):
            continue
        path = urlparse(link).path.strip('/')
        if '/' in path:
            continue
        if any(h in low for h in _CRYPTORUSSIA_ARTICLE_HINTS):
            article_links.append(link)

    article_links = _unique_list(article_links)[:25]
    if not article_links:
        _set_source_status('cryptorussia.ru', 'not_found', 0)
        logger.info('cryptorussia.ru: no suitable review links found')
        return results

    for url in article_links:
        page = _fetch(url)
        if not page:
            continue
        title = _extract_title_from_html(page).lower()
        clean = _clean_html_text(page)
        clean_lower = clean.lower()
        channels = _extract_cryptorussia_channels(page, url)
        has_badge = 'скам' in clean_lower or 'не рекомендуем сотрудничать' in clean_lower
        has_review_context = 'отзывы' in clean_lower or 'разоблачение' in title or 'скам' in title
        has_telegram_context = (
            'телеграм' in clean_lower or 'telegram' in url.lower() or
            'bot' in url.lower() or 'бот' in clean_lower
        )
        if not channels:
            continue
        if not (has_badge or has_review_context):
            continue
        if not has_telegram_context:
            continue
        if not _has_cryptorussia_scam_evidence(clean):
            continue
        paragraphs = _extract_article_paragraphs(page)
        evidence_paragraphs = _select_evidence_paragraphs(paragraphs)
        desc_snippet = ' | '.join(evidence_paragraphs)[:400] if evidence_paragraphs else clean[:400]
        sum_rub = _extract_loss_amount(clean)
        for ch in channels[:2]:
            results.append({
                'channel': '@' + ch,
                'sum_rub': sum_rub,
                'description': f'Источник: {url} | {desc_snippet[:400]}'[:500],
                'source_url': url,
                'source': 'cryptorussia',
            })

    unique_channels = len({r.get('channel') for r in results if r.get('channel')})
    _set_source_status('cryptorussia.ru', 'found' if unique_channels else 'not_found', unique_channels)
    logger.info('cryptorussia.ru: found %d channel mentions', len(results))
    return results


# ---------------------------------------------------------------------------
# Source 5: vklader.com
# ---------------------------------------------------------------------------

_VKLADER_BASE = 'https://vklader.com'
_VKLADER_BLACKLIST_URL = 'https://vklader.com/blacklist-telegram/'
_VKLADER_PROVERKA_URL = 'https://vklader.com/proverka-telegram/'


def scrape_vklader():
    """
    Scrape vklader.com blacklist and user verification pages.
    Returns list of {channel, sum_rub, description, source_url, source}.
    """
    results = []

    blacklist_html = _fetch(_VKLADER_BLACKLIST_URL)
    proverka_html = _fetch(_VKLADER_PROVERKA_URL)
    if not blacklist_html and not proverka_html:
        _set_source_status('vklader.com', 'unavailable', 0)
        logger.info('vklader.com: both pages unavailable')
        return results

    if blacklist_html:
        results.extend(_build_blacklist_page_findings(
            blacklist_html, _VKLADER_BLACKLIST_URL, 'vklader', noise_handles=('vklader',)
        ))
        for url in _extract_blacklist_site_article_links(blacklist_html, _VKLADER_BASE, limit=20):
            page = _fetch(url)
            if not page:
                continue
            results.extend(_build_findings_from_page(page, url, 'vklader', max_channels=3))

    if proverka_html:
        for url in _extract_blacklist_site_article_links(proverka_html, _VKLADER_BASE, limit=12):
            page = _fetch(url)
            if not page:
                continue
            results.extend(_build_findings_from_page(page, url, 'vklader', max_channels=3))

    deduped = _dedupe_findings_channel_per_url(results)
    unique_channels = len({r.get('channel') for r in deduped if r.get('channel')})
    _set_source_status('vklader.com', 'found' if unique_channels else 'not_found', unique_channels)
    logger.info('vklader.com: found %d channel mentions', len(deduped))
    return deduped


# ---------------------------------------------------------------------------
# Source 6–7: telltrue.net / forteck.net (blacklist-telegram, same layout as vklader)
# ---------------------------------------------------------------------------

_TELLTRUE_BASE = 'https://telltrue.net'
_TELLTRUE_BLACKLIST_URL = 'https://telltrue.net/blacklist-telegram/'
_FORTECK_BASE = 'https://forteck.net'
_FORTECK_BLACKLIST_URL = 'https://forteck.net/blacklist-telegram/'


def _scrape_blacklist_telegram_portal(base_url, blacklist_url, status_name, source_tag, noise_handles, article_limit=20):
    """Single blacklist-telegram hub + linked articles (vklader-style)."""
    results = []
    html = _fetch(blacklist_url)
    if not html:
        _set_source_status(status_name, 'unavailable', 0)
        logger.info('%s: blacklist page unavailable', status_name)
        return results
    results.extend(_build_blacklist_page_findings(html, blacklist_url, source_tag, noise_handles=noise_handles))
    for url in _extract_blacklist_site_article_links(html, base_url, limit=article_limit):
        page = _fetch(url)
        if not page:
            continue
        results.extend(_build_findings_from_page(page, url, source_tag, max_channels=3))
    deduped = _dedupe_findings_channel_per_url(results)
    unique_channels = len({r.get('channel') for r in deduped if r.get('channel')})
    _set_source_status(status_name, 'found' if unique_channels else 'not_found', unique_channels)
    logger.info('%s: found %d channel mentions', status_name, len(deduped))
    return deduped


def scrape_telltrue():
    """telltrue.net/blacklist-telegram — тот же формат, что у vklader."""
    return _scrape_blacklist_telegram_portal(
        _TELLTRUE_BASE, _TELLTRUE_BLACKLIST_URL, 'telltrue.net', 'telltrue', ('telltrue',), article_limit=20
    )


def scrape_forteck():
    """forteck.net/blacklist-telegram — тот же формат, что у vklader."""
    return _scrape_blacklist_telegram_portal(
        _FORTECK_BASE, _FORTECK_BLACKLIST_URL, 'forteck.net', 'forteck', ('forteck',), article_limit=20
    )


# ---------------------------------------------------------------------------
# Combined entry point
# ---------------------------------------------------------------------------

def scrape_all():
    """
    Run all scrapers and return deduplicated list of findings.
    Each item: {channel, sum_rub, description, source_url, source[, object_type]}.
    """
    global _LAST_SOURCE_STATUS
    _LAST_SOURCE_STATUS = []
    results = []
    results.extend(scrape_stop_scam1())
    results.extend(scrape_cryptorussia())
    results.extend(scrape_fin_obzor())
    results.extend(scrape_brokers_check())
    # Массовая заливка kurs в reports отключена по умолчанию — см. органический цикл в run_12h_monitor
    if (os.environ.get('KRO_KURS_BULK_WEB_REPORTS') or '').strip().lower() in ('1', 'true', 'yes', 'on'):
        results.extend(scrape_kurs_expert())
    results.extend(scrape_vklader())
    results.extend(scrape_telltrue())
    results.extend(scrape_forteck())
    results.extend(_scrape_victim_queries())

    # Additional enrichment: search internet reviews for usernames already found
    # in primary sources. This makes it easy to expand evidence without changing
    # the rest of the pipeline.
    def _is_seed_telegram_ref(ch):
        c = (ch or '').strip().lower()
        return bool(c) and (c.startswith('@') or 't.me/' in c)

    seed_usernames = sorted({
        (r.get('channel') or '').strip()
        for r in results
        if _is_seed_telegram_ref(r.get('channel'))
    })[:20]
    for channel in seed_usernames:
        for url in _search_review_urls_for_username(channel, max_links=2):
            page = _fetch(url)
            if not page:
                continue
            results.extend(_build_findings_from_page(page, url, 'web-search'))

    # Deduplicate: keep highest sum_rub per channel per source_url
    seen = {}
    for r in results:
        if not r.get('source_url'):
            continue
        key = (r['channel'].lower(), r['source_url'])
        if key not in seen or r['sum_rub'] > seen[key]['sum_rub']:
            seen[key] = r
    deduped = list(seen.values())
    logger.info('web_scraper.scrape_all: %d unique findings', len(deduped))
    return deduped


def write_web_reports_to_sheet(sheets_client, sheet_id, reports, reports_range='A:I'):
    """
    Append web-sourced reports to the reports sheet.
    Schema A:I: date, channel, sum_rub, source='web', status='Активен',
                reporter='web_parser', description, proof_url=source_url, object_type (опц.)
    """
    if not sheets_client or not sheet_id or not reports:
        return 0
    now = datetime.now(timezone.utc)
    date_str = now.strftime('%d.%m.%Y')
    rows = []
    for r in reports:
        source_url = (r.get('source_url') or '').strip()
        if not source_url:
            continue
        rows.append([
            date_str,
            r.get('channel', ''),
            r.get('sum_rub', 0),
            'web',
            'Активен',
            'web_parser',
            r.get('description', '')[:300],
            source_url,
            (r.get('object_type') or '').strip(),
        ])
    if not rows:
        return 0
    try:
        sheets_client.spreadsheets().values().append(
            spreadsheetId=sheet_id,
            range=reports_range,
            valueInputOption='USER_ENTERED',
            insertDataOption='INSERT_ROWS',
            body={'values': rows}
        ).execute()
        logger.info('web_scraper: wrote %d web reports to sheet', len(rows))
        return len(rows)
    except Exception as e:
        logger.error('web_scraper: sheet write error: %s', e)
        return 0


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    findings = scrape_all()
    print(json.dumps(findings, ensure_ascii=False, indent=2))
