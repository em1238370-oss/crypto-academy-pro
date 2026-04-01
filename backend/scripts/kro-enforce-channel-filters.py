#!/usr/bin/env python3
import os
import re
import json
import asyncio
import sys
from typing import List, Tuple

# kro-worker на PYTHONPATH (скрипт запускают из корня репозитория)
_KW = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'kro-worker'))
if _KW not in sys.path:
    sys.path.insert(0, _KW)

try:
    from kro_telethon_limits import tw_call, tw_collect_messages
except ImportError:
    tw_call = None
    tw_collect_messages = None

MIN_TELEGRAM_SUBSCRIBERS = 100
TELETHON_TIMEOUT_SECONDS = 10.0
REQUIRED_SIGNAL_TERMS = (
    'сигнал', 'signal',
    'long', 'short',
    'vip',
    'депозит', 'deposit',
    'трейдинг', 'trading',
    'заработок на крипте',
    'копитрейдинг', 'copytrading',
    'обменник usdt', 'usdt exchange',
)
NOTE = 'не по теме: канал не проходит фильтры (мин. 100 подписчиков + обязательные сигнальные признаки)'

USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
)


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
    raw = (os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON') or '').strip()
    if raw:
        try:
            info = json.loads(raw)
            return service_account.Credentials.from_service_account_info(
                info, scopes=['https://www.googleapis.com/auth/spreadsheets']
            )
        except Exception:
            if os.path.isfile(raw):
                return service_account.Credentials.from_service_account_file(
                    raw, scopes=['https://www.googleapis.com/auth/spreadsheets']
                )
    cred_path = (
        (os.environ.get('GOOGLE_APPLICATION_CREDENTIALS') or '').strip()
        or '/etc/secrets/google-credentials.json'
        or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'kro-worker', 'service_account.json')
    )
    if not os.path.isfile(cred_path):
        raise RuntimeError('Google credentials not found')
    return service_account.Credentials.from_service_account_file(
        cred_path, scopes=['https://www.googleapis.com/auth/spreadsheets']
    )


def _normalize_channel_link(ch_or_link: str) -> str:
    ch = (ch_or_link or '').strip()
    if not ch:
        return ''
    if ch.startswith('http'):
        if 't.me/' in ch:
            return ch.split('t.me/')[-1].split('?')[0].strip()
        return ''
    if ch.startswith('t.me/'):
        return ch.split('/', 1)[-1].split('?')[0].strip()
    if ch.startswith('@'):
        return ch.lstrip('@').split('?')[0].strip()
    if 't.me/' in ch:
        return ch.split('t.me/')[-1].split('?')[0].strip()
    return ''


def _has_required_terms(*parts) -> bool:
    blob = ' '.join((p or '') for p in parts).lower()
    return any(term in blob for term in REQUIRED_SIGNAL_TERMS)


def _is_telegram_row(row: List[str]) -> bool:
    username = (row[0] if len(row) > 0 else '').strip()
    link = (row[1] if len(row) > 1 else '').strip()
    obj_type = (row[5] if len(row) > 5 else '').strip().lower()
    if 't.me/' in username.lower() or 't.me/' in link.lower():
        return True
    if username.startswith('@'):
        return True
    return 'сигнал' in obj_type


def _fetch_html_subscribers_and_posts(slug: str, post_limit: int = 40):
    """Возвращает (subscribers_or_none, posts_text_blob_lower)."""
    try:
        import requests
        from bs4 import BeautifulSoup
    except ImportError:
        return None, ''
    slug = slug.lstrip('@').split('/')[0]
    if not slug or slug.startswith('joinchat'):
        return None, ''
    urls = ['https://t.me/s/%s' % slug, 'https://t.me/%s' % slug]
    last_err = None
    for url in urls:
        try:
            resp = requests.get(
                url,
                headers={'User-Agent': USER_AGENT, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'},
                timeout=18,
            )
            resp.raise_for_status()
        except Exception as exc:
            last_err = exc
            continue

        soup = BeautifulSoup(resp.text or '', 'html.parser')
        extra = soup.select_one('.tgme_page_extra')
        subs = None
        if extra:
            text = extra.get_text(' ', strip=True).lower()
            m = re.search(
                r'([\d\s\u00a0.,]+)\s*([km])?\s*(?:subscribers|subscriber|подписчик)',
                text.replace('\xa0', ' '),
            )
            if not m:
                m = re.search(r'([\d\s\u00a0.,]+)\s*([km])?\b', text.replace('\xa0', ' '))
            if m:
                num = m.group(1).replace(' ', '').replace(',', '.')
                try:
                    v = float(num)
                    suf = (m.group(2) or '').lower()
                    if suf == 'k':
                        v *= 1000
                    elif suf == 'm':
                        v *= 1_000_000
                    subs = int(round(v))
                except ValueError:
                    pass
        chunks = []
        for w in soup.select('.tgme_widget_message')[:post_limit]:
            tn = w.select_one('.tgme_widget_message_text')
            if tn:
                chunks.append(tn.get_text(' ', strip=True).lower())
        if subs is not None or chunks:
            return subs, ' '.join(chunks)

    if last_err is not None:
        return None, ''
    return None, ''


async def _open_telethon_client():
    from telethon import TelegramClient
    api_id = (os.environ.get('TELEGRAM_API_ID') or '').strip()
    api_hash = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
    session = (os.environ.get('TELEGRAM_SESSION_NAME') or 'kro_session').strip()
    if not api_id or not api_hash:
        return None
    client = TelegramClient(session, int(api_id), api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        await client.disconnect()
        return None
    return client


def _validate_row_html(row: List[str]) -> Tuple[str, str]:
    username = (row[0] if len(row) > 0 else '').strip()
    link = (row[1] if len(row) > 1 else '').strip()
    source_evidence = (row[10] if len(row) > 10 else '').strip()
    content_analysis = (row[13] if len(row) > 13 else '').strip()
    ref_norm = _normalize_channel_link(link or username)
    if not ref_norm or ref_norm.startswith('joinchat/'):
        return 'failed', 'invalid_or_invite_ref'
    subs, blob = _fetch_html_subscribers_and_posts(ref_norm)
    if subs is None:
        print('html_fallback: %s — subscribers_unknown' % (username or link))
        return 'skipped', 'subscribers_unknown_html'
    if subs < MIN_TELEGRAM_SUBSCRIBERS:
        return 'failed', 'subscribers_below_100'
    if not _has_required_terms(username, link, source_evidence, content_analysis, blob):
        return 'failed', 'missing_required_signal_terms'
    print('html_fallback_ok: %s (subs≈%s)' % ((username or link), subs))
    return 'passed', 'ok_html'


async def _validate_row_telethon(client, row: List[str]) -> Tuple[str, str]:
    from telethon.tl.functions.channels import GetFullChannelRequest

    username = (row[0] if len(row) > 0 else '').strip()
    link = (row[1] if len(row) > 1 else '').strip()
    source_evidence = (row[10] if len(row) > 10 else '').strip()
    content_analysis = (row[13] if len(row) > 13 else '').strip()
    ref_norm = _normalize_channel_link(link or username)
    if not ref_norm or ref_norm.startswith('joinchat/'):
        return 'failed', 'invalid_or_invite_ref'
    ref = 'https://t.me/' + ref_norm if not ref_norm.startswith('@') else ref_norm
    if tw_call is None:
        return _validate_row_html(row)
    try:
        entity = await asyncio.wait_for(
            tw_call(client.get_entity(ref)),
            timeout=TELETHON_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        print('telethon_timeout get_entity: %s' % (username or link))
        return 'skipped', 'telethon_timeout_get_entity'
    except Exception:
        return 'skipped', 'telethon_error_get_entity'
    if bool(getattr(entity, 'deleted', False)):
        return 'failed', 'channel_deleted'
    participants = 0
    about = ''
    try:
        full = await asyncio.wait_for(
            tw_call(client(GetFullChannelRequest(entity))),
            timeout=TELETHON_TIMEOUT_SECONDS,
        )
        participants = int(getattr(getattr(full, 'full_chat', None), 'participants_count', 0) or 0)
        about = str(getattr(getattr(full, 'full_chat', None), 'about', '') or '')
    except asyncio.TimeoutError:
        return 'skipped', 'telethon_timeout_get_full_channel'
    except Exception:
        return 'skipped', 'telethon_error_get_full_channel'
    if participants < MIN_TELEGRAM_SUBSCRIBERS:
        return 'failed', 'subscribers_below_100'
    posts = []
    try:
        if tw_collect_messages:
            msgs = await asyncio.wait_for(
                tw_collect_messages(client, entity, limit=40),
                timeout=TELETHON_TIMEOUT_SECONDS,
            )
        else:
            msgs = []
            agen = client.iter_messages(entity, limit=40).__aiter__()
            while True:
                try:
                    msg = await asyncio.wait_for(agen.__anext__(), timeout=TELETHON_TIMEOUT_SECONDS)
                except (StopAsyncIteration, asyncio.TimeoutError):
                    break
                msgs.append(msg)
        for msg in msgs:
            txt = ((getattr(msg, 'text', None) or '') + ' ' + (getattr(msg, 'message', None) or '')).strip().lower()
            if txt:
                posts.append(txt)
    except asyncio.TimeoutError:
        return 'skipped', 'telethon_timeout_iter_messages'
    except Exception:
        return 'skipped', 'telethon_error_iter_messages'
    posts_blob = ' '.join(posts)
    if not _has_required_terms(username, link, about, source_evidence, content_analysis, posts_blob):
        return 'failed', 'missing_required_signal_terms'
    return 'passed', 'ok'


async def _run_async():
    from googleapiclient.discovery import build

    _load_env()
    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip()
    if not sheet_id:
        raise RuntimeError('KRO_SHEET_ID is required')

    creds = _get_credentials()
    sheets = build('sheets', 'v4', credentials=creds)
    sheet_name = ((os.environ.get('KRO_SCAM_BASE_RANGE') or 'scam_base!A2:N').split('!')[0] or 'scam_base').strip()
    range_all = f'{sheet_name}!A2:N'
    rows = (sheets.spreadsheets().values().get(spreadsheetId=sheet_id, range=range_all).execute().get('values') or [])
    if not rows:
        print('No rows in scam_base')
        return 0

    client = await _open_telethon_client()
    mode = 'telethon' if client is not None else 'html_fallback'
    print('enforce-channel-filters: mode=%s' % mode)
    if client is None:
        print('Telethon unavailable or unauthorized; using public t.me HTML for subscriber/signal checks.')

    updates = []
    failed = 0
    checked = 0
    try:
        for i, row in enumerate(rows):
            if not _is_telegram_row(row):
                continue
            checked += 1
            if client is not None:
                status, reason = await _validate_row_telethon(client, row)
            else:
                status, reason = _validate_row_html(row)
            if status == 'passed':
                continue
            if status == 'skipped':
                print('skip_channel: %s — %s' % ((row[0] if len(row) > 0 else row[1] if len(row) > 1 else 'unknown'), reason))
                continue
            failed += 1
            padded = list(row) + [''] * max(0, 14 - len(row))
            evidence = (padded[10] or '').strip()
            if NOTE not in evidence:
                padded[10] = (NOTE + (' | ' + evidence if evidence else ''))[:500]
            padded[12] = 'не по теме'
            updates.append({
                'range': f'{sheet_name}!A{i+2}:N{i+2}',
                'values': [padded[:14]],
            })
            print('mark_not_relevant: %s — %s' % ((padded[0] or padded[1] or 'unknown'), reason))
    finally:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass

    if updates:
        sheets.spreadsheets().values().batchUpdate(
            spreadsheetId=sheet_id,
            body={'valueInputOption': 'USER_ENTERED', 'data': updates},
        ).execute()
    print('Checked telegram rows: %d' % checked)
    print('Marked "не по теме": %d' % failed)
    print('Updated rows: %d' % len(updates))
    return 0


def main():
    return asyncio.run(_run_async())


if __name__ == '__main__':
    raise SystemExit(main())
