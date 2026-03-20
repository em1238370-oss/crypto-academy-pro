#!/usr/bin/env python3
"""
KRO Web Scraper: собирает упоминания скам-каналов с сайтов-разоблачителей.

Источники:
  - stop-scam1.com — разоблачение телеграм-каналов сигналов и курсов
  - fin-obzor.net  — обзоры финансовых и крипто-мошенников

Каждая найденная запись: {channel, sum_rub, description, source_url, source}
Возвращаемые данные пишутся в лист reports Google Sheets с пометкой source='web'.
"""
import re
import json
import logging
from datetime import datetime, timezone
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

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

_TIMEOUT = 15


def _fetch(url):
    """Fetch URL, return decoded text or None on error."""
    try:
        req = Request(url, headers=_HEADERS)
        with urlopen(req, timeout=_TIMEOUT) as resp:
            charset = 'utf-8'
            ct = resp.headers.get_content_charset()
            if ct:
                charset = ct
            return resp.read().decode(charset, errors='replace')
    except (URLError, HTTPError, Exception) as e:
        logger.warning('web_scraper fetch error %s: %s', url, e)
        return None


def _extract_channel_mentions(text):
    """
    Extract @username and t.me/ channel references from raw text.
    Returns list of normalised usernames (without @).
    """
    found = set()
    # @username pattern
    for m in re.finditer(r'@([A-Za-z][A-Za-z0-9_]{3,})', text):
        found.add(m.group(1).lower())
    # t.me/username pattern (skip invite links with +)
    for m in re.finditer(r't\.me/([A-Za-z][A-Za-z0-9_]{3,})', text):
        found.add(m.group(1).lower())
    return list(found)


def _extract_loss_amount(text):
    """
    Try to find a loss amount in roubles from text.
    Patterns: '15 000 рублей', '15000₽', '15к₽', '15 тыс руб'
    Returns integer roubles or 0.
    """
    # Normalise whitespace
    t = text.replace('\xa0', ' ')
    # e.g. "150 000 рублей" or "150000₽"
    m = re.search(r'(\d[\d\s]{0,9}\d|\d+)\s*(?:000)?\s*(?:₽|руб|рублей|rub)', t, re.IGNORECASE)
    if m:
        raw = re.sub(r'\s', '', m.group(0))
        digits = re.sub(r'[^\d]', '', raw)
        if digits:
            val = int(digits)
            # sanity: 100 ₽ .. 100 000 000 ₽
            if 100 <= val <= 100_000_000:
                return val
    # e.g. "15к₽" / "15 тыс"
    m = re.search(r'(\d+)\s*(?:к|тыс)\s*(?:₽|руб)?', t, re.IGNORECASE)
    if m:
        return int(m.group(1)) * 1000
    # e.g. "1.5 млн"
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*млн\s*(?:₽|руб)?', t, re.IGNORECASE)
    if m:
        return int(float(m.group(1).replace(',', '.')) * 1_000_000)
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
        if href.startswith('/'):
            href = base_url.rstrip('/') + href
        elif not href.startswith('http'):
            continue
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


# ---------------------------------------------------------------------------
# Source 1: stop-scam1.com
# ---------------------------------------------------------------------------

_STOP_SCAM1_BASE = 'https://stop-scam1.com'
_STOP_SCAM1_CATEGORY = 'https://stop-scam1.com/category/%d1%82%d0%b5%d0%bb%d0%b5%d0%b3%d1%80%d0%b0%d0%bc/'


def scrape_stop_scam1():
    """
    Scrape stop-scam1.com Telegram category for scam channel mentions.
    Returns list of {channel, sum_rub, description, source_url, source}.
    """
    results = []
    html = _fetch(_STOP_SCAM1_CATEGORY)
    if not html:
        logger.info('stop-scam1.com: no response from category page')
        return results

    article_links = _parse_article_links(html, _STOP_SCAM1_BASE)
    # Limit to 20 most recent articles per cycle
    article_links = [l for l in article_links if '/category/' not in l][:20]

    for url in article_links:
        page = _fetch(url)
        if not page:
            continue
        # Strip HTML tags for text extraction
        clean = re.sub(r'<[^>]+>', ' ', page)
        clean = re.sub(r'\s+', ' ', clean)

        channels = _extract_channel_mentions(clean)
        if not channels:
            continue

        sum_rub = _extract_loss_amount(clean)
        # Take first 400 chars after first channel mention as description
        first_ch = channels[0]
        idx = clean.lower().find(first_ch.lower())
        snippet_start = max(0, idx - 80)
        description = clean[snippet_start:snippet_start + 400].strip()

        for ch in channels[:3]:
            results.append({
                'channel': '@' + ch,
                'sum_rub': sum_rub,
                'description': description[:300],
                'source_url': url,
                'source': 'web',
            })

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
        clean = re.sub(r'<[^>]+>', ' ', page)
        clean = re.sub(r'\s+', ' ', clean)

        channels = _extract_channel_mentions(clean)
        if not channels:
            continue

        sum_rub = _extract_loss_amount(clean)
        first_ch = channels[0]
        idx = clean.lower().find(first_ch.lower())
        snippet_start = max(0, idx - 80)
        description = clean[snippet_start:snippet_start + 400].strip()

        for ch in channels[:3]:
            results.append({
                'channel': '@' + ch,
                'sum_rub': sum_rub,
                'description': description[:300],
                'source_url': url,
                'source': 'web',
            })

    logger.info('fin-obzor.net: found %d channel mentions', len(results))
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

    # Deduplicate: keep highest sum_rub per channel per source_url
    seen = {}
    for r in results:
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
        rows.append([
            date_str,
            r.get('channel', ''),
            r.get('sum_rub', 0),
            'web',
            'Активен',
            'web_parser',
            r.get('description', '')[:300],
            r.get('source_url', ''),
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
