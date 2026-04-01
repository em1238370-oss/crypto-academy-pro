"""
Единая точка создания TelegramClient для KRO.

Приоритет:
1) KRO_TELEGRAM_SESSION_STRING (или TELEGRAM_SESSION_STRING) — Telethon StringSession,
   короткая строка для GitHub Secrets (вместо огромного .session в base64).
2) Файл backend/kro-worker/<TELEGRAM_SESSION_NAME>.session (по умолчанию kro_worker.session).
3) Имя сессии относительно текущего cwd (как раньше у Telethon).
"""
from __future__ import annotations

import os
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent


def build_kro_telegram_client(api_id: int, api_hash: str):
    """
    Возвращает TelegramClient (ещё не connect).
    """
    from telethon import TelegramClient
    from telethon.sessions import StringSession

    raw = (
        os.environ.get('KRO_TELEGRAM_SESSION_STRING')
        or os.environ.get('TELEGRAM_SESSION_STRING')
        or ''
    ).strip()
    if raw:
        return TelegramClient(StringSession(raw), api_id, api_hash)

    name = (os.environ.get('TELEGRAM_SESSION_NAME') or 'kro_worker').strip()
    explicit = (os.environ.get('TELEGRAM_SESSION_PATH') or '').strip()
    if explicit:
        return TelegramClient(explicit, api_id, api_hash)

    candidate = _SCRIPT_DIR / name
    if candidate.with_suffix('.session').is_file():
        return TelegramClient(str(candidate), api_id, api_hash)
    return TelegramClient(name, api_id, api_hash)
