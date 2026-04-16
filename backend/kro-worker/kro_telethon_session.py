"""
Единая точка создания TelegramClient для KRO.

Приоритет:
1) KRO_TELEGRAM_SESSION_STRING (или TELEGRAM_SESSION_STRING) — Telethon StringSession,
   короткая строка для GitHub Secrets (вместо огромного .session в base64).
2) TELEGRAM_SESSION_B64 — base64 от бинарного файла *.session (SQLite), как в run_worker_loop.sh
   на Render: printf '%s' "$TELEGRAM_SESSION_B64" | base64 -d > /tmp/kro_worker.session
3) Файл backend/kro-worker/<TELEGRAM_SESSION_NAME>.session (по умолчанию kro_worker.session).
4) Имя сессии относительно текущего cwd (как раньше у Telethon).
"""
from __future__ import annotations

import base64
from typing import Optional
import binascii
import os
import tempfile
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent

# Минимальный размер SQLite-сессии Telethon (порядок сотен байт; отсекаем мусор).
_MIN_SESSION_FILE_BYTES = 64


def _decode_session_b64(raw: str) -> Optional[bytes]:
    """Декодировать TELEGRAM_SESSION_B64 в байты файла .session (как в bash base64 -d)."""
    s = ''.join((raw or '').strip().split())
    if not s:
        return None
    for dec in (base64.b64decode, base64.urlsafe_b64decode):
        pad = (-len(s)) % 4
        try:
            data = dec(s + ('=' * pad), validate=False)
            if len(data) >= _MIN_SESSION_FILE_BYTES:
                return data
        except (binascii.Error, ValueError):
            continue
    return None


def _telegram_client_path_from_b64() -> Optional[str]:
    """
    Записать декодированный .session во временный файл, вернуть путь БЕЗ суффикса .session
    (контракт Telethon: TelegramClient('/tmp/foo', ...) → /tmp/foo.session).
    """
    raw = (os.environ.get('TELEGRAM_SESSION_B64') or '').strip()
    if not raw:
        return None
    data = _decode_session_b64(raw)
    if not data:
        return None
    tmp = Path(tempfile.gettempdir()) / f'kro_telegram_b64_{os.getpid()}.session'
    tmp.write_bytes(data)
    return str(tmp.with_suffix(''))


def has_configured_session() -> bool:
    """
    True, если check_once / worker смогут авторизоваться без интерактива:
    StringSession в env, TELEGRAM_SESSION_B64, явный путь к .session, или файл рядом со скриптом.
    """
    if (os.environ.get('KRO_TELEGRAM_SESSION_STRING') or os.environ.get('TELEGRAM_SESSION_STRING') or '').strip():
        return True
    if (os.environ.get('TELEGRAM_SESSION_B64') or '').strip():
        return True
    explicit = (os.environ.get('TELEGRAM_SESSION_PATH') or '').strip()
    if explicit:
        p = Path(explicit)
        if not str(p).endswith('.session'):
            p = p.with_suffix('.session')
        return p.is_file()
    name = (os.environ.get('TELEGRAM_SESSION_NAME') or 'kro_worker').strip()
    if (_SCRIPT_DIR / name).with_suffix('.session').is_file():
        return True
    return Path(name + '.session').is_file()


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

    b64_path = _telegram_client_path_from_b64()
    if b64_path:
        return TelegramClient(b64_path, api_id, api_hash)

    name = (os.environ.get('TELEGRAM_SESSION_NAME') or 'kro_worker').strip()
    explicit = (os.environ.get('TELEGRAM_SESSION_PATH') or '').strip()
    if explicit:
        return TelegramClient(explicit, api_id, api_hash)

    candidate = _SCRIPT_DIR / name
    if candidate.with_suffix('.session').is_file():
        return TelegramClient(str(candidate), api_id, api_hash)
    return TelegramClient(name, api_id, api_hash)
