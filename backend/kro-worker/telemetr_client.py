"""
Опциональный клиент Telemetr API для чекера KRO (критерий 6: усиление эвристики ботов).
При TELEMETR_API_KEY делается один запрос за инфо по каналу; при ошибке или отсутствии ключа возвращается None.
"""
import os
import re

TELEMETR_API_KEY = (os.environ.get('TELEMETR_API_KEY') or '').strip()
TELEMETR_BASE = 'https://api.telemetr.io'
REQUEST_TIMEOUT = 10


def _normalize_channel_id(channel_id):
    """Приводит к виду username без @ для API."""
    s = (channel_id or '').strip()
    if not s:
        return None
    s = re.sub(r'^https?://t\.me/', '', s, flags=re.I)
    s = s.replace('t.me/', '')
    if s.startswith('@'):
        s = s[1:]
    return s if s else None


def fetch_channel_info(channel_id):
    """
    Опциональный запрос к Telemetr по каналу. Возвращает dict с полями при успехе или None.
    При отсутствии ключа или ошибке проверка не ломается.
    """
    if not TELEMETR_API_KEY:
        return None
    username = _normalize_channel_id(channel_id)
    if not username or username.startswith('+'):
        return None
    try:
        import urllib.request
        url = f'{TELEMETR_BASE}/v1/channels/{username}' if username else None
        if not url:
            return None
        req = urllib.request.Request(url, headers={
            'x-api-key': TELEMETR_API_KEY,
            'User-Agent': 'KRO-Checker/1.0'
        })
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            import json
            data = json.loads(resp.read().decode('utf-8'))
            return data if data else None
    except Exception:
        return None
