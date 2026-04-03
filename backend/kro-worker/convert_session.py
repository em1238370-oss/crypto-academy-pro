#!/usr/bin/env python3
"""
Локально: kro_worker.session → одна строка Telethon StringSession для GitHub Secret
KRO_TELEGRAM_SESSION_STRING.

  cd backend/kro-worker
  python3 convert_session.py

Нужны TELEGRAM_API_ID и TELEGRAM_API_HASH (корневой .env, env или .env в этой папке).
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def _apply_env_lines(text: str) -> None:
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, _, v = line.partition('=')
        k, v = k.strip(), v.strip()
        if not k:
            continue
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        if not v.strip():
            continue
        os.environ[k] = v.strip()


def _load_dotenv() -> None:
    repo_root = SCRIPT_DIR.parent.parent
    for p in (repo_root / '.env', SCRIPT_DIR / 'env', SCRIPT_DIR / '.env'):
        if p.is_file():
            _apply_env_lines(p.read_text(encoding='utf-8', errors='replace'))


_HELP_ENV = """
Нет TELEGRAM_API_ID / TELEGRAM_API_HASH (или только пустые значения после =).

Читаются по порядку: корень репозитория .env → backend/kro-worker/env → backend/kro-worker/.env

  https://my.telegram.org → API development tools → впишите в .env
  Затем: python3 convert_session.py
"""

_HELP_SESSION = """
Нет файла сессии: {path}

  python3 login_via_qr.py
  См. ВХОД_ПО_QR.md
"""


async def main() -> None:
    _load_dotenv()
    api_id = int(os.environ.get('TELEGRAM_API_ID') or 0)
    api_hash = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
    if not api_id or not api_hash:
        print(_HELP_ENV.strip(), file=sys.stderr)
        raise SystemExit(1)

    from telethon import TelegramClient
    from telethon.sessions import StringSession

    name = (os.environ.get('TELEGRAM_SESSION_NAME') or 'kro_worker').strip()
    base = SCRIPT_DIR / name
    sess_file = base.with_suffix('.session')
    if not sess_file.is_file():
        print(_HELP_SESSION.format(path=sess_file).strip(), file=sys.stderr)
        raise SystemExit(1)

    client = TelegramClient(str(base), api_id, api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        print('Сессия не авторизована. Сначала: python3 login_via_qr.py', file=sys.stderr)
        raise SystemExit(1)

    ss = StringSession()
    ss.set_dc(client.session.dc_id, client.session.server_address, client.session.port)
    ss.auth_key = client.session.auth_key
    line = ss.save()
    if not line:
        print('Не удалось сформировать StringSession.', file=sys.stderr)
        raise SystemExit(1)
    print(line)
    await client.disconnect()


if __name__ == '__main__':
    asyncio.run(main())
