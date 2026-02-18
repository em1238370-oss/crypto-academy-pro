#!/usr/bin/env python3
"""
KRO live-check worker: читает очередь check_queue в Google Sheets,
проверяет канал через Telethon (сообщения, ключевые слова),
дописывает строку в scam_base и удаляет задачу из очереди.
Запуск: раз в 1–2 минуты (cron или loop с sleep).
"""
import os
import re
import asyncio
from datetime import datetime

# Google Sheets
from google.oauth2 import service_account
from googleapiclient.discovery import build

# Telethon
from telethon import TelegramClient
from telethon.tl.functions.messages import ImportChatInviteRequest
from telethon.errors import ChannelPrivateError, InviteHashExpiredError, UsernameNotOccupiedError

# --- env ---
KRO_SHEET_ID = os.environ.get('KRO_SHEET_ID', '')
KRO_QUEUE_RANGE = os.environ.get('KRO_CHECK_QUEUE_RANGE', 'check_queue!A2:B')
KRO_SCAM_BASE_RANGE = os.environ.get('KRO_SCAM_BASE_RANGE', 'scam_base!A2:H')
# Лист для очереди — имя из диапазона (check_queue или Sheet3)
QUEUE_SHEET_NAME = KRO_QUEUE_RANGE.split('!')[0] if '!' in KRO_QUEUE_RANGE else 'check_queue'
SCAM_BASE_SHEET_NAME = KRO_SCAM_BASE_RANGE.split('!')[0] if '!' in KRO_SCAM_BASE_RANGE else 'scam_base'

TELEGRAM_API_ID = int(os.environ.get('TELEGRAM_API_ID', '0'))
TELEGRAM_API_HASH = os.environ.get('TELEGRAM_API_HASH', '')
TELEGRAM_SESSION_NAME = os.environ.get('TELEGRAM_SESSION_NAME', 'kro_worker')

# Ключевые слова для оценки риска (реклама, VIP, гарантии)
RISK_KEYWORDS = [
    'vip', 'вип', 'сигнал', 'гарантия', 'гарантир', 'срочно', 'бесплатно',
    'подпишись', 'подпис', 'канал', 'результат', 'прибыль', 'доход', 'памп',
    'pump', '100%', 'скринер', 'сканер', 'копируй', 'копируем', 'заработок',
    'развод', 'скам', 'scam', 'крипта', 'крипто', 'crypto', 'btc', 'eth',
    'usdt', 'ton', 'телеграм', 'telegram', 'бот', 'bot'
]


def get_sheets_client():
    creds = None
    json_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
    json_str = os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON')
    if json_str:
        import json
        creds = service_account.Credentials.from_service_account_info(json.loads(json_str))
    elif json_path and os.path.isfile(json_path):
        creds = service_account.Credentials.from_service_account_file(json_path)
    if not creds:
        return None
    return build('sheets', 'v4', credentials=creds)


def queue_range_data_only():
    """Диапазон данных очереди без листа (для update)."""
    part = KRO_QUEUE_RANGE.split('!')[-1]
    return f'{QUEUE_SHEET_NAME}!{part}'


def scam_base_append_range():
    """Диапазон для append в scam_base (следующая свободная строка не нужна — append сам допишет)."""
    return f'{SCAM_BASE_SHEET_NAME}!A:H'


async def get_entity(client, channel_id):
    """Получить entity канала по @username или t.me/+hash."""
    channel_id = (channel_id or '').strip()
    if not channel_id:
        return None
    try:
        if channel_id.startswith('t.me/'):
            link = 'https://t.me/' + channel_id.replace('t.me/', '', 1)
            return await client.get_entity(link)
        if not channel_id.startswith('@'):
            channel_id = '@' + channel_id
        return await client.get_entity(channel_id)
    except (ChannelPrivateError, InviteHashExpiredError, UsernameNotOccupiedError, ValueError) as e:
        if 'join' in str(e).lower() or 'invite' in str(e).lower() or 'not part' in str(e).lower():
            if channel_id.startswith('t.me/+'):
                hash_part = channel_id.replace('t.me/+', '').strip()
                try:
                    from telethon.tl.functions.messages import CheckChatInviteRequest
                    res = await client(ImportChatInviteRequest(hash_part))
                    if res.chats:
                        return res.chats[0]
                except Exception:
                    pass
        raise
    return None


def analyze_messages(texts):
    """Простой анализ: количество «рекламных» ключевых слов, оценка риска 0–100."""
    total = 0
    matches = 0
    for t in texts:
        if not t or len(t) < 5:
            continue
        total += 1
        lower = t.lower()
        for kw in RISK_KEYWORDS:
            if kw in lower:
                matches += 1
                break
    if total == 0:
        return 0, 0
    pct = (matches / total) * 100
    risk = min(100, int(pct * 1.2))
    return risk, matches


def extract_vip_price(texts):
    """Попытка вытащить цену VIP из текста (руб, usdt)."""
    price_patterns = [
        r'(?:vip|вип|подписк)[^\d]{0,20}(\d[\d\s]{2,10})\s*(?:р|руб|₽|usdt|долл)',
        r'(\d[\d\s]{2,10})\s*(?:р|руб|₽)\s*(?:vip|вип|на\s+канал)',
    ]
    for t in texts:
        for pat in price_patterns:
            m = re.search(pat, t, re.I)
            if m:
                num = re.sub(r'\s', '', m.group(1))
                if num.isdigit():
                    return num + '₽'
    return '—'


def run_worker_once():
    if not KRO_SHEET_ID or not KRO_QUEUE_RANGE or not KRO_SCAM_BASE_RANGE:
        print('KRO_SHEET_ID, KRO_CHECK_QUEUE_RANGE, KRO_SCAM_BASE_RANGE required')
        return
    if not TELEGRAM_API_ID or not TELEGRAM_API_HASH:
        print('TELEGRAM_API_ID and TELEGRAM_API_HASH required for live check')
        return

    sheets = get_sheets_client()
    if not sheets:
        print('Google Sheets credentials not found')
        return

    # Читаем очередь
    try:
        result = sheets.spreadsheets().values().get(
            spreadsheetId=KRO_SHEET_ID,
            range=KRO_QUEUE_RANGE
        ).execute()
        rows = result.get('values', [])
    except Exception as e:
        print('Queue read error:', e)
        return

    if not rows:
        return

    channel_id = (rows[0][0] or '').strip()
    if not channel_id:
        # Удаляем пустую строку
        remaining = rows[1:]
        if remaining:
            sheets.spreadsheets().values().update(
                spreadsheetId=KRO_SHEET_ID,
                range=queue_range_data_only(),
                valueInputOption='USER_ENTERED',
                body={'values': remaining}
            ).execute()
        return

    async def do_telethon():
        client = TelegramClient(
            TELEGRAM_SESSION_NAME,
            TELEGRAM_API_ID,
            TELEGRAM_API_HASH
        )
        await client.start()
        try:
            entity = await get_entity(client, channel_id)
            if not entity:
                return None
            messages = await client.get_messages(entity, limit=80)
            texts = []
            for m in messages:
                if m and m.text:
                    texts.append(m.text)
            risk, _ = analyze_messages(texts)
            vip = extract_vip_price(texts)
            ads_week = min(99, len(texts))
            if risk >= 70:
                verdict = 'scam'
            elif risk >= 35:
                verdict = 'grey'
            else:
                verdict = 'safe'
            # В базу пишем тот же channel_id, что в очереди, чтобы повторный запрос пользователя нашёл строку
            return [
                channel_id,
                risk,
                ads_week,
                '—',
                vip,
                '—',
                '—',
                verdict
            ]
        finally:
            await client.disconnect()

    try:
        row_data = asyncio.run(do_telethon())
    except Exception as e:
        print('Telethon error for', channel_id, e)
        row_data = None

    if not row_data:
        row_data = [
            channel_id,
            0,
            0,
            '—',
            '—',
            '—',
            '—',
            'unknown'
        ]

    # Дописываем в scam_base
    try:
        sheets.spreadsheets().values().append(
            spreadsheetId=KRO_SHEET_ID,
            range=scam_base_append_range(),
            valueInputOption='USER_ENTERED',
            insertDataOption='INSERT_ROWS',
            body={'values': [row_data]}
        ).execute()
    except Exception as e:
        print('Scam base append error:', e)
        return

    # Удаляем первую строку из очереди (перезаписываем без неё)
    remaining = rows[1:]
    try:
        if remaining:
            sheets.spreadsheets().values().update(
                spreadsheetId=KRO_SHEET_ID,
                range=queue_range_data_only(),
                valueInputOption='USER_ENTERED',
                body={'values': remaining}
            ).execute()
        else:
            # Очищаем только первую строку данных (A2:B2)
            first_row_range = f'{QUEUE_SHEET_NAME}!A2:B2'
            sheets.spreadsheets().values().clear(
                spreadsheetId=KRO_SHEET_ID,
                range=first_row_range
            ).execute()
    except Exception as e:
        print('Queue update error:', e)
    print('Processed:', channel_id, '->', row_data[7])


if __name__ == '__main__':
    run_worker_once()
