#!/usr/bin/env python3
"""
Проверка Telethon StringSession из KRO_BYO_SESSION_STRING (env) без записи в Sheets.
Одна строка JSON в stdout: {"ok": true, "user_id": ...} или {"ok": false, "error": "..."}.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def out(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False))


async def main() -> None:
    raw = (os.environ.get('KRO_BYO_SESSION_STRING') or os.environ.get('TELEGRAM_SESSION_STRING') or '').strip()
    api_id_raw = (os.environ.get('TELEGRAM_API_ID') or '').strip()
    api_hash = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
    if not raw:
        out({'ok': False, 'error': 'empty_session'})
        return
    if not api_id_raw.isdigit() or not api_hash:
        out({'ok': False, 'error': 'missing_api_credentials'})
        return
    api_id = int(api_id_raw)
    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession
    except ImportError:
        out({'ok': False, 'error': 'telethon_missing'})
        return

    client = TelegramClient(StringSession(raw), api_id, api_hash)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            out({'ok': False, 'error': 'not_authorized'})
            return
        me = await client.get_me()
        uid = getattr(me, 'id', None)
        un = getattr(me, 'username', None) or ''
        out({'ok': True, 'user_id': uid, 'username': un})
    except Exception as e:
        out({'ok': False, 'error': str(e)[:200]})
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass


if __name__ == '__main__':
    asyncio.run(main())
