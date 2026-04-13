"""
Общий строгий Telethon-gate для scam_base: cleanup-скрипт и запись из run_12h_monitor.
Логика совпадает с прежним kro-cleanup-scam-base._validate_row_strict.
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone

from telethon.errors import FloodWaitError

from kro_tme_http_gate import SCAM_BASE_HTTP_CRYPTO_TERMS

CRYPTO_TERMS = SCAM_BASE_HTTP_CRYPTO_TERMS
MIN_SUBSCRIBERS_STRICT = 50
MAX_POST_AGE_DAYS_STRICT = 90


def _has_whistleblower_crypto_marker(row_obj: dict) -> bool:
    blob = ' '.join(
        str(x or '')
        for x in (
            row_obj.get('source_primary'),
            row_obj.get('source_evidence'),
        )
    ).lower()
    has_whistleblower = any(marker in blob for marker in ('stop-scam1', 'fin-obzor', 'vklader', 'telltrue', 'forteck'))
    has_crypto = any(term in blob for term in CRYPTO_TERMS)
    return has_whistleblower and has_crypto


def norm_username_for_gate(v: str) -> str:
    s = (v or '').strip()
    if not s:
        return ''
    if s.startswith('https://t.me/'):
        part = s.split('https://t.me/', 1)[-1].split('/')[0].lstrip('@')
        s = '@' + part if part else ''
    elif s.startswith('t.me/'):
        part = s.split('t.me/', 1)[-1].split('/')[0].lstrip('@')
        s = '@' + part if part else ''
    if not s:
        return ''
    if not s.startswith('@'):
        s = '@' + s.lstrip('@')
    return s.lower()


async def validate_telegram_scam_base_row_strict(client, row_obj: dict):
    """
    (ok, reason, remove_row).
    remove_row=True — строку не должно быть в scam_base при успешной проверке.
    client is None → (False, 'telethon_unavailable', False) — cleanup сохраняет строку;
    pre-write фильтр трактует отсутствие клиента как «пропустить gate».
    """
    from telethon.tl.functions.channels import GetFullChannelRequest
    from telethon.tl.types import Channel, Chat, User

    uname = norm_username_for_gate(row_obj.get('username') or row_obj.get('link') or '')
    if not uname:
        return False, 'empty_username', True
    # До записи в базу не отсекаем вручную подтверждённые whistleblower crypto-кейсы
    # только из-за неполного ответа Telethon.
    if _has_whistleblower_crypto_marker(row_obj):
        return True, 'ok_whistleblower_crypto_bypass', False
    if client is None:
        return False, 'telethon_unavailable', False

    try:
        ent = await asyncio.wait_for(client.get_entity(uname), timeout=10.0)
    except FloodWaitError as e:
        print(
            'telethon_gate flood_wait get_entity %s: %s' % (uname, e),
            file=sys.stderr,
        )
        return False, 'telegram_flood_wait', False
    except Exception:
        return False, 'entity_unavailable', True

    if isinstance(ent, User):
        return False, 'entity_is_user_or_bot', True
    if not isinstance(ent, (Channel, Chat)):
        return False, 'entity_not_channel_or_chat', True
    if bool(getattr(ent, 'deleted', False)):
        return False, 'channel_deleted', True

    try:
        full = await asyncio.wait_for(client(GetFullChannelRequest(ent)), timeout=10.0)
    except FloodWaitError as e:
        print(
            'telethon_gate flood_wait GetFullChannel %s: %s' % (uname, e),
            file=sys.stderr,
        )
        return False, 'telegram_flood_wait', False
    except Exception:
        return False, 'cannot_read_full_channel', True

    subs = int(getattr(getattr(full, 'full_chat', None), 'participants_count', 0) or 0)
    if subs < MIN_SUBSCRIBERS_STRICT:
        return False, 'subs_below_50', True

    about = str(getattr(getattr(full, 'full_chat', None), 'about', '') or '')
    if not about.strip():
        return False, 'empty_description', True

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
    except FloodWaitError as e:
        print(
            'telethon_gate flood_wait iter_messages %s: %s' % (uname, e),
            file=sys.stderr,
        )
        return False, 'telegram_flood_wait', False
    except Exception:
        return False, 'iter_messages_error', True

    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_POST_AGE_DAYS_STRICT)
    if not post_dates or not any(dt >= cutoff for dt in post_dates):
        return False, 'no_posts_90d', True

    recent_blob = ' '.join(posts[:10])
    if not any(t in recent_blob for t in CRYPTO_TERMS):
        return False, 'posts_not_crypto', True

    hacked = ('взлом', 'взломан', 'hacked', 'канал взломали', 'аккаунт взломан')
    if any(h in ' '.join(posts) for h in hacked):
        return False, 'channel_hacked_notice', True

    return True, 'ok', False
