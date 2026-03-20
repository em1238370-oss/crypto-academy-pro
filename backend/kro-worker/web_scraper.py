#!/usr/bin/env python3
"""
KRO Web Scraper: собирает упоминания скам-каналов с сайтов-разоблачителей.

Источники:
  - stop-scam1.com   — разоблачение телеграм-каналов сигналов и курсов
  - fin-obzor.net    — обзоры финансовых и крипто-мошенников
  - brokers-check.ru — доп. источник жалоб, если сайт доступен и содержит крипто-каналы

Каждая найденная запись: {channel, sum_rub, description, source_url, source}
Возвращаемые данные пишутся в лист reports Google Sheets с пометкой source='web'.
"""
import re
import json
import logging
from datetime import datetime, timezone
from urllib.parse import urljoin

logger = logging.getLogger(__name__)

_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/122.0.0.0 Safari/537.36'
    ),
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

_TIMEOUT = 25
_CRYPTO_HINTS = (
    'telegram', 'телеграм', 't.me', '@',
    'crypto', 'крипт', 'сигнал', 'signal',
    'vip', 'вип', 'трейд', 'trading', 'инвест', 'бирж',
)


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
        resp = sess.get(url, timeout=_TIMEOUT, allow_redirects=True)
        resp.raise_for_status()
        return resp.text
    except Exception as e:
        logger.debug('requests fetch failed for %s: %s', url, e)
    # --- urllib fallback ---
    try:
        from urllib.request import urlopen, Request as URequest
        from urllib.error import URLError, HTTPError
        req = URequest(url, headers=_HEADERS)
        with urlopen(req, timeout=_TIMEOUT) as resp:
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


def _extract_channel_mentions(text):
    """
    Extract @username and t.me/ channel references from plain text.
    Filters out JSON-LD schema fields (@context, @graph, @type, etc.)
    and generic words that are not Telegram usernames.
    Returns list of normalised usernames (without @).
    """
    found = set()
    for m in re.finditer(r'@([A-Za-z][A-Za-z0-9_]{3,})', text):
        uname = m.group(1)
        if uname.lower() in _JSON_LD_NOISE:
            continue
        if len(uname) < 5:
            continue
        found.add(uname.lower())
    # t.me/username (skip invite links with +, skip known service paths)
    _skip_paths = frozenset({'joinchat', 'addstickers', 'share', 'proxy', 'm', 's'})
    for m in re.finditer(r't\.me/([A-Za-z][A-Za-z0-9_]{3,})', text):
        uname = m.group(1)
        if uname.lower() in _skip_paths or uname.lower() in _JSON_LD_NOISE:
            continue
        found.add(uname.lower())
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


def _build_findings_from_page(page, url, source_name, max_channels=3):
    """
    Turn a fetched article page into complaint findings.
    Uses BeautifulSoup for clean description extraction (no footer noise).
    """
    # Try BS4-based paragraph extraction first
    paragraphs = _extract_article_paragraphs(page)
    if paragraphs:
        clean_for_channels = ' '.join(paragraphs)
        desc_snippet = ' | '.join(paragraphs[:3])
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
    all_links = _collect_article_links(_STOP_SCAM1_LISTINGS, _STOP_SCAM1_BASE, max_links=60)
    # Keep only articles that look like Telegram channel reviews
    article_links = [
        l for l in all_links
        if any(h in l.lower() for h in _STOP_SCAM1_ARTICLE_HINTS)
    ][:20]
    if not article_links:
        logger.info('stop-scam1.com: no listing pages available')
        return results

    for url in article_links:
        page = _fetch(url)
        if not page:
            continue
        results.extend(_build_findings_from_page(page, url, 'stop-scam1'))

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

    for url in filtered:
        page = _fetch(url)
        if not page:
            continue
        results.extend(_build_findings_from_page(page, url, 'fin-obzor'))

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
    article_links = _collect_article_links(_BROKERS_CHECK_LISTINGS, _BROKERS_CHECK_BASE, max_links=20)
    if not article_links:
        logger.info('brokers-check.ru: no listing pages available or site unreachable')
        return results

    for url in article_links:
        page = _fetch(url)
        if not page:
            continue
        findings = _build_findings_from_page(page, url, 'brokers-check')
        if findings:
            results.extend(findings)

    logger.info('brokers-check.ru: found %d channel mentions', len(results))
    return results


# ---------------------------------------------------------------------------
# Combined entry point
# ---------------------------------------------------------------------------

def scrape_all():
    """
    Run all scrapers and return deduplicated list of findings.
    Each item: {channel, sum_rub, description, source_url, source}.
    """
    results = []
    results.extend(scrape_stop_scam1())
    results.extend(scrape_fin_obzor())
    results.extend(scrape_brokers_check())

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


def write_web_reports_to_sheet(sheets_client, sheet_id, reports, reports_range='A:H'):
    """
    Append web-sourced reports to the reports sheet.
    Schema A:H: date, channel, sum_rub, source='web', status='Активен',
                reporter='web_parser', description, proof_url=source_url
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
