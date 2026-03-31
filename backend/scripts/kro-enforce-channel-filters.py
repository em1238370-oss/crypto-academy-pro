#!/usr/bin/env python3
import os
import re
import json
import asyncio
from typing import List, Tuple

MIN_TELEGRAM_SUBSCRIBERS = 100
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


async def _validate_row(client, row: List[str]) -> Tuple[bool, str]:
    from telethon.tl.functions.channels import GetFullChannelRequest

    username = (row[0] if len(row) > 0 else '').strip()
    link = (row[1] if len(row) > 1 else '').strip()
    source_evidence = (row[10] if len(row) > 10 else '').strip()
    content_analysis = (row[13] if len(row) > 13 else '').strip()
    ref_norm = _normalize_channel_link(link or username)
    if not ref_norm or ref_norm.startswith('joinchat/'):
        return False, 'invalid_or_invite_ref'
    ref = 'https://t.me/' + ref_norm if not ref_norm.startswith('@') else ref_norm
    try:
        entity = await client.get_entity(ref)
    except Exception:
        return False, 'channel_unavailable_or_blocked'
    if bool(getattr(entity, 'deleted', False)):
        return False, 'channel_deleted'
    participants = 0
    about = ''
    try:
        full = await client(GetFullChannelRequest(entity))
        participants = int(getattr(getattr(full, 'full_chat', None), 'participants_count', 0) or 0)
        about = str(getattr(getattr(full, 'full_chat', None), 'about', '') or '')
    except Exception:
        participants = int(getattr(entity, 'participants_count', 0) or 0)
    if participants < MIN_TELEGRAM_SUBSCRIBERS:
        return False, 'subscribers_below_100'
    posts = []
    try:
        async for msg in client.iter_messages(entity, limit=40):
            txt = ((getattr(msg, 'text', None) or '') + ' ' + (getattr(msg, 'message', None) or '')).strip().lower()
            if txt:
                posts.append(txt)
    except Exception:
        pass
    if not _has_required_terms(username, link, about, source_evidence, content_analysis, ' '.join(posts)):
        return False, 'missing_required_signal_terms'
    return True, 'ok'


async def _run():
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
        return

    client = await _open_telethon_client()
    if client is None:
        raise RuntimeError('Telethon unavailable or unauthorized; cannot enforce strict channel filters')

    updates = []
    failed = 0
    checked = 0
    try:
        for i, row in enumerate(rows):
            if not _is_telegram_row(row):
                continue
            checked += 1
            ok, reason = await _validate_row(client, row)
            if ok:
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
            print(f"mark_not_relevant: {(padded[0] or padded[1] or 'unknown')} — {reason}")
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass

    if updates:
        sheets.spreadsheets().values().batchUpdate(
            spreadsheetId=sheet_id,
            body={'valueInputOption': 'USER_ENTERED', 'data': updates},
        ).execute()
    print(f'Checked telegram rows: {checked}')
    print(f'Marked "не по теме": {failed}')
    print(f'Updated rows: {len(updates)}')


if __name__ == '__main__':
    asyncio.run(_run())
