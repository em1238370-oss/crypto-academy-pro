#!/usr/bin/env python3
import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone


TARGET_DELETE = {
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
}
CHECK_PERSONAL = {'@vladislav_belokrylov', '@maxcrypto_adm'}
CRYPTO_TERMS = ('bitcoin', 'btc', 'крипт', 'crypto', 'usdt', 'трейдинг', 'trading', 'сигнал', 'signal', 'обменник')


def _norm_username(v: str) -> str:
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


def _load_env():
    root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
    for base in (root, os.path.join(root, 'backend', 'kro-worker')):
        for name in ('.env', 'env'):
            p = os.path.join(base, name)
            if not os.path.isfile(p):
                continue
            with open(p, 'r', encoding='utf-8', errors='replace') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line:
                        continue
                    k, _, v = line.partition('=')
                    k, v = k.strip(), v.strip()
                    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                        v = v[1:-1]
                    if k and k not in os.environ:
                        os.environ[k] = v
            break


def _get_sheet_client():
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    raw = (os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON') or '').strip()
    creds = None
    if raw:
        try:
            info = json.loads(raw)
            creds = service_account.Credentials.from_service_account_info(
                info, scopes=['https://www.googleapis.com/auth/spreadsheets']
            )
        except Exception:
            pass
    if creds is None:
        cred_path = (os.environ.get('GOOGLE_APPLICATION_CREDENTIALS') or '').strip()
        if cred_path and not os.path.isabs(cred_path):
            cred_path = os.path.join(os.getcwd(), cred_path)
        if not cred_path:
            cred_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'kro-worker', 'credentials.json')
        if not os.path.isfile(cred_path):
            raise RuntimeError('Google credentials not found')
        creds = service_account.Credentials.from_service_account_file(
            cred_path, scopes=['https://www.googleapis.com/auth/spreadsheets']
        )
    return build('sheets', 'v4', credentials=creds, cache_discovery=False)


async def _open_tg_client():
    api_id = (os.environ.get('TELEGRAM_API_ID') or '').strip()
    api_hash = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
    if not api_id or not api_hash:
        return None
    try:
        from telethon import TelegramClient
        c = TelegramClient((os.environ.get('TELEGRAM_SESSION_NAME') or 'kro_session').strip(), int(api_id), api_hash)
        await c.connect()
        if not await c.is_user_authorized():
            await c.disconnect()
            return None
        return c
    except Exception:
        return None


async def _is_personal_user(client, username: str) -> bool:
    if client is None:
        return False
    try:
        from telethon.tl.types import User
        ent = await asyncio.wait_for(client.get_entity(username), timeout=10.0)
        return isinstance(ent, User)
    except Exception:
        return False


async def _validate_row_strict(client, row_obj):
    """
    Возвращает (ok, reason, mark_deleted)
    mark_deleted=True для удалённых/недоступных объектов (периодическая проверка).
    """
    from telethon.tl.functions.channels import GetFullChannelRequest
    from telethon.tl.types import Channel, Chat, User

    uname = _norm_username(row_obj.get('username') or row_obj.get('link') or '')
    if not uname:
        return False, 'empty_username', False
    if client is None:
        return False, 'telethon_unavailable_strict_reject', False
    try:
        ent = await asyncio.wait_for(client.get_entity(uname), timeout=10.0)
    except Exception:
        return False, 'entity_unavailable', True
    if isinstance(ent, User):
        return False, 'entity_is_user', False
    if not isinstance(ent, (Channel, Chat)):
        return False, 'entity_not_channel_or_chat', False
    if bool(getattr(ent, 'deleted', False)):
        return False, 'channel_deleted', True

    try:
        full = await asyncio.wait_for(client(GetFullChannelRequest(ent)), timeout=10.0)
    except Exception:
        return False, 'cannot_read_full_channel', True
    subs = int(getattr(getattr(full, 'full_chat', None), 'participants_count', 0) or 0)
    if subs < 100:
        return False, 'subs_below_100', False
    about = str(getattr(getattr(full, 'full_chat', None), 'about', '') or '')
    if not about.strip():
        return False, 'empty_description', False

    posts = []
    post_dates = []
    try:
        async for m in client.iter_messages(ent, limit=20):
            t = ((getattr(m, 'text', None) or '') + ' ' + (getattr(m, 'message', None) or '')).strip()
            if t:
                posts.append(t.lower())
            dt = getattr(m, 'date', None)
            if dt:
                if getattr(dt, 'tzinfo', None) is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                post_dates.append(dt)
    except Exception:
        return False, 'iter_messages_error', True

    cutoff = datetime.now(timezone.utc) - timedelta(days=60)
    if not any(dt >= cutoff for dt in post_dates):
        return False, 'no_posts_60d', True
    recent_blob = ' '.join(posts[:10])
    if not any(t in recent_blob for t in CRYPTO_TERMS):
        return False, 'posts_not_crypto', False
    hacked = ('взлом', 'взломан', 'hacked', 'канал взломали', 'аккаунт взломан')
    if any(h in ' '.join(posts) for h in hacked):
        return False, 'channel_hacked_notice', True
    return True, 'ok', False


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    _load_env()
    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip()
    if not sheet_id:
        raise RuntimeError('KRO_SHEET_ID is required')
    svc = _get_sheet_client()

    rows = svc.spreadsheets().values().get(
        spreadsheetId=sheet_id,
        range='scam_base!A2:N',
    ).execute().get('values', [])
    print('scam_base rows before:', len(rows))

    client = await _open_tg_client()
    if client is None:
        print('WARNING: Telethon unavailable; strict validation will reject/skip telethon checks.')

    kept = []
    deleted_names = []
    marked_deleted = []

    for r in rows:
        rr = list(r) + [''] * (14 - len(r))
        uname = _norm_username(rr[0])

        # Step 1: explicit remove list
        if uname in TARGET_DELETE:
            deleted_names.append(uname)
            continue

        # Step 2: verify two personal-account suspects via Telethon
        if uname in CHECK_PERSONAL and client is not None:
            if await _is_personal_user(client, uname):
                deleted_names.append(uname)
                continue

        # Step 3/periodic: strict gate for all telegram usernames
        if uname:
            ok, reason, mark_del = await _validate_row_strict(client, {'username': rr[0], 'link': rr[1]})
            if not ok and mark_del:
                rr[12] = 'удалён'
                marked_deleted.append((uname, reason))
        kept.append(rr[:14])

    if client is not None:
        try:
            await client.disconnect()
        except Exception:
            pass

    print('explicitly deleted rows:', len(deleted_names))
    if deleted_names:
        print('deleted:', ', '.join(sorted(set(deleted_names))))
    print('marked as удалён:', len(marked_deleted))
    if marked_deleted:
        print('marked_deleted_sample:', marked_deleted[:10])
    print('rows after cleanup:', len(kept))

    if args.dry_run:
        return 0

    # Rewrite A2:N with kept rows
    svc.spreadsheets().values().clear(
        spreadsheetId=sheet_id,
        range='scam_base!A2:N',
        body={},
    ).execute()
    if kept:
        svc.spreadsheets().values().append(
            spreadsheetId=sheet_id,
            range='scam_base!A2:N',
            valueInputOption='USER_ENTERED',
            insertDataOption='INSERT_ROWS',
            body={'values': kept},
        ).execute()
    print('cleanup applied')
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))

