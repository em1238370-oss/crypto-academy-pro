#!/usr/bin/env python3
"""
Один раз локально: прочитать kro_worker.session и вывести строку для GitHub Secret
KRO_TELEGRAM_SESSION_STRING (короче, чем base64 всего файла).

Запуск из backend/kro-worker при заданных TELEGRAM_API_ID / TELEGRAM_API_HASH в env или .env:

  cd backend/kro-worker && python3 export_telethon_string_session.py

Скопируйте одну строку вывода в Settings → Secrets → KRO_TELEGRAM_SESSION_STRING.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def _load_dotenv() -> None:
    for name in ('.env', 'env'):
        p = SCRIPT_DIR / name
        if not p.is_file():
            continue
        for line in p.read_text(encoding='utf-8', errors='replace').splitlines():
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


async def main() -> None:
    _load_dotenv()
    api_id = int(os.environ.get('TELEGRAM_API_ID') or 0)
    api_hash = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
    if not api_id or not api_hash:
        print('Задайте TELEGRAM_API_ID и TELEGRAM_API_HASH (env или .env в kro-worker).', file=sys.stderr)
        raise SystemExit(1)

    from telethon import TelegramClient
    from telethon.sessions import StringSession

    name = (os.environ.get('TELEGRAM_SESSION_NAME') or 'kro_worker').strip()
    base = SCRIPT_DIR / name
    client = TelegramClient(str(base), api_id, api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        print('Сессия не авторизована. Сначала войдите (login_via_qr.py и т.д.).', file=sys.stderr)
        raise SystemExit(1)

    ss = StringSession()
    ss.set_dc(client.session.dc_id, client.session.server_address, client.session.port)
    ss.auth_key = client.session.auth_key
    line = ss.save()
    if not line:
        print('Не удалось сформировать StringSession (нет auth_key?).', file=sys.stderr)
        raise SystemExit(1)
    print(line)
    await client.disconnect()


if __name__ == '__main__':
    asyncio.run(main())
