#!/usr/bin/env python3
"""
Чистка листа scam_base по публичному HTML t.me (без Telethon).

Удаляется строка Telegram-канала, если выполняется хотя бы одно:
- канал недоступен (ошибка HTTP, страница ошибки t.me, не существует и т.п.);
- в описании и в текстах постов с превью t.me/s/… нет ни одного крипто-маркера.

Учётные данные Google Sheets (по умолчанию):
  backend/kro-worker/kro-google-credentials.json

Дополнительно: GOOGLE_APPLICATION_CREDENTIALS, KRO_GOOGLE_CREDENTIALS_JSON,
backend/kro-worker/credentials.json.

Запуск из backend/kro-worker:
  python3 ../scripts/kro-prune-scam-base-html.py --dry-run
  python3 ../scripts/kro-prune-scam-base-html.py

Нужны KRO_SHEET_ID (и опционально KRO_SCAM_BASE_RANGE, по умолчанию scam_base!A2:N).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import Any, Dict, List, Tuple

_KW = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'kro-worker'))
if _KW not in sys.path:
    sys.path.insert(0, _KW)

USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
)
USER_AGENT_ALT = 'Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0'

CRYPTO_TERMS = (
    'крипт',
    'bitcoin',
    'btc',
    'usdt',
    'трейд',
    'сигнал',
    'invest',
    'trade',
    'forex',
    'бинанс',
    'bybit',
)

REQUEST_PAUSE_SEC = 1.35
_DEFAULT_CREDS = os.path.join(_KW, 'kro-google-credentials.json')
_FALLBACK_CREDS = os.path.join(_KW, 'credentials.json')


def _load_env():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root = os.path.normpath(os.path.join(script_dir, '..', '..'))
    worker = os.path.join(root, 'backend', 'kro-worker')
    for base in (worker, root):
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
                    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                        value = value[1:-1]
                    if key and key not in os.environ:
                        os.environ[key] = value
            break


def _get_credentials():
    from google.oauth2 import service_account

    gac = (os.environ.get('GOOGLE_APPLICATION_CREDENTIALS') or '').strip()
    if gac:
        path = gac if os.path.isabs(gac) else os.path.join(os.getcwd(), gac)
        if os.path.isfile(path):
            return service_account.Credentials.from_service_account_file(
                path, scopes=['https://www.googleapis.com/auth/spreadsheets']
            )

    for path in (_DEFAULT_CREDS, _FALLBACK_CREDS):
        if os.path.isfile(path):
            return service_account.Credentials.from_service_account_file(
                path, scopes=['https://www.googleapis.com/auth/spreadsheets']
            )

    raw = (os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON') or '').strip()
    if raw.startswith('{'):
        try:
            info = json.loads(raw)
            return service_account.Credentials.from_service_account_info(
                info, scopes=['https://www.googleapis.com/auth/spreadsheets']
            )
        except json.JSONDecodeError:
            pass
    elif raw and os.path.isfile(os.path.expanduser(raw)):
        return service_account.Credentials.from_service_account_file(
            os.path.expanduser(raw), scopes=['https://www.googleapis.com/auth/spreadsheets']
        )

    raise RuntimeError(
        'Google credentials not found. Положите ключ в backend/kro-worker/kro-google-credentials.json '
        'или задайте GOOGLE_APPLICATION_CREDENTIALS / KRO_GOOGLE_CREDENTIALS_JSON.'
    )


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


def _is_telegram_row(row: List[str]) -> bool:
    username = (row[0] if len(row) > 0 else '').strip()
    link = (row[1] if len(row) > 1 else '').strip()
    obj_type = (row[5] if len(row) > 5 else '').strip().lower()
    if 't.me/' in username.lower() or 't.me/' in link.lower():
        return True
    if username.startswith('@'):
        return True
    return 'сигнал' in obj_type


def _extract_post_text_from_widget(msg) -> str:
    if not msg:
        return ''
    text_node = msg.select_one('.tgme_widget_message_text')
    if text_node:
        return re.sub(r'\s+', ' ', text_node.get_text(' ', strip=True) or '').strip()
    alt = msg.select_one('.tgme_widget_message_text.js-message_text')
    if alt:
        return re.sub(r'\s+', ' ', alt.get_text(' ', strip=True) or '').strip()
    for sel in ('.tgme_widget_message_photo_caption', '.message_media_not_supported_text'):
        cap = msg.select_one(sel)
        if cap:
            return re.sub(r'\s+', ' ', cap.get_text(' ', strip=True) or '').strip()
    return ''


def _looks_unavailable(soup, status_code: int, raw_lower: str) -> bool:
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


def _fetch_and_analyze(slug: str) -> Dict[str, Any]:
    import requests
    from bs4 import BeautifulSoup

    slug = slug.lstrip('@').split('/')[0]
    out: Dict[str, Any] = {
        'slug': slug,
        'unavailable': False,
        'has_crypto_term': False,
        'reasons': [],
    }
    if not slug or slug.startswith('joinchat') or slug.startswith('+'):
        out['reasons'].append('skip_invite_or_empty_slug')
        return out

    last_status = 0
    raw = ''
    for url in (f'https://t.me/s/{slug}', f'https://t.me/{slug}'):
        for ua in (USER_AGENT, USER_AGENT_ALT):
            try:
                resp = requests.get(
                    url,
                    headers={'User-Agent': ua, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'},
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
        out['unavailable'] = True
        out['reasons'].append('http_error_or_empty')
        return out

    raw_lower = raw.lower()
    soup = BeautifulSoup(raw, 'html.parser')

    if _looks_unavailable(soup, last_status, raw_lower):
        out['unavailable'] = True
        out['reasons'].append('tme_unavailable_or_error_page')
        return out

    desc_el = soup.select_one('.tgme_page_description')
    desc = desc_el.get_text(' ', strip=True) if desc_el else ''

    post_chunks: List[str] = []
    for w in soup.select('.tgme_widget_message')[:50]:
        t = _extract_post_text_from_widget(w)
        if t:
            post_chunks.append(t.lower())

    posts_blob = ' '.join(post_chunks)
    blob = f'{desc.lower()} {posts_blob}'

    if not any(term in blob for term in CRYPTO_TERMS):
        out['reasons'].append('no_crypto_markers_in_desc_or_posts')

    out['has_crypto_term'] = any(term in blob for term in CRYPTO_TERMS)
    return out


def _should_remove(analysis: Dict[str, Any]) -> Tuple[bool, str]:
    if analysis.get('reasons') == ['skip_invite_or_empty_slug']:
        return False, 'skip_non_public_slug'

    if analysis.get('unavailable'):
        return True, 'unavailable'

    if 'no_crypto_markers_in_desc_or_posts' in (analysis.get('reasons') or []):
        return True, 'no_crypto_terms'

    return False, 'keep'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true', help='только печать, без записи в Sheets')
    args = parser.parse_args()

    _load_env()
    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip()
    if not sheet_id:
        print('KRO_SHEET_ID required', file=sys.stderr)
        return 1

    try:
        creds = _get_credentials()
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1

    from googleapiclient.discovery import build

    sheets = build('sheets', 'v4', credentials=creds, cache_discovery=False)
    sheet_name = ((os.environ.get('KRO_SCAM_BASE_RANGE') or 'scam_base!A2:N').split('!')[0] or 'scam_base').strip()
    range_all = f'{sheet_name}!A2:N'

    rows = sheets.spreadsheets().values().get(spreadsheetId=sheet_id, range=range_all).execute().get('values') or []
    print('rows in %s: %d' % (sheet_name, len(rows)))

    slug_cache: Dict[str, Dict[str, Any]] = {}
    remove_indices: List[int] = []
    log_lines: List[str] = []

    for i, row in enumerate(rows):
        if not _is_telegram_row(row):
            continue
        u = (row[0] if len(row) > 0 else '').strip()
        link = (row[1] if len(row) > 1 else '').strip()
        slug = _normalize_slug(link or u)
        if not slug or slug.startswith('+'):
            log_lines.append('skip row %d: %s — no public slug' % (i + 2, u or link))
            continue

        if slug not in slug_cache:
            slug_cache[slug] = _fetch_and_analyze(slug)
            time.sleep(REQUEST_PAUSE_SEC)

        an = slug_cache[slug]
        kill, why = _should_remove(an)
        label = u or link
        if kill:
            remove_indices.append(i)
            log_lines.append('REMOVE row %d: %s — %s (%s)' % (i + 2, label, why, ','.join(an.get('reasons') or [])))
        else:
            log_lines.append('keep row %d: %s' % (i + 2, label))

    print('---')
    print('telegram rows checked (unique slugs): %d' % len(slug_cache))
    print('rows to remove: %d' % len(remove_indices))

    for line in log_lines:
        print(line)

    if args.dry_run:
        print('--- dry-run: no changes written')
        return 0

    if not remove_indices:
        print('nothing to remove')
        return 0

    kept = [rows[j] for j in range(len(rows)) if j not in set(remove_indices)]
    for j, r in enumerate(kept):
        kept[j] = (list(r) + [''] * 14)[:14]

    sheets.spreadsheets().values().clear(spreadsheetId=sheet_id, range=range_all, body={}).execute()
    if kept:
        sheets.spreadsheets().values().append(
            spreadsheetId=sheet_id,
            range=f'{sheet_name}!A2:N',
            valueInputOption='USER_ENTERED',
            insertDataOption='INSERT_ROWS',
            body={'values': kept},
        ).execute()
    print('--- wrote %d rows back (removed %d)' % (len(kept), len(remove_indices)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
