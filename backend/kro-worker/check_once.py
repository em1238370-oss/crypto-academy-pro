#!/usr/bin/env python3
"""
KRO check once: проверка одного канала по Telegram (Telethon).
Принимает один аргумент — идентификатор канала (@name, t.me/+hash).
Выводит в stdout одну строку JSON: found, risk_score, ads_per_week, bot_pct, vip_price, verdict.
При ошибке — found: false, error. Код выхода 0 всегда (для парсинга в Node).
"""
import os
import re
import sys
import json
import asyncio

from telethon import TelegramClient
from telethon.tl.functions.messages import ImportChatInviteRequest
from telethon.errors import ChannelPrivateError, InviteHashExpiredError, UsernameNotOccupiedError

TELEGRAM_API_ID = int(os.environ.get('TELEGRAM_API_ID', '0'))
TELEGRAM_API_HASH = os.environ.get('TELEGRAM_API_HASH', '')
TELEGRAM_SESSION_NAME = os.environ.get('TELEGRAM_SESSION_NAME', 'kro_worker')

KRO_SHEET_ID = os.environ.get('KRO_SHEET_ID', '')
KRO_SCAM_BASE_RANGE = os.environ.get('KRO_SCAM_BASE_RANGE', 'scam_base!A2:H')
SCAM_BASE_SHEET_NAME = KRO_SCAM_BASE_RANGE.split('!')[0] if '!' in KRO_SCAM_BASE_RANGE else 'scam_base'

RISK_KEYWORDS = [
    'vip', 'вип', 'сигнал', 'гарантия', 'гарантир', 'срочно', 'бесплатно',
    'подпишись', 'подпис', 'канал', 'результат', 'прибыль', 'доход', 'памп',
    'pump', '100%', 'скринер', 'сканер', 'копируй', 'копируем', 'заработок',
    'развод', 'скам', 'scam', 'крипта', 'крипто', 'crypto', 'btc', 'eth',
    'usdt', 'ton', 'телеграм', 'telegram', 'бот', 'bot'
]


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


async def get_entity(client, channel_id):
    channel_id = (channel_id or '').strip()
    if not channel_id:
        return None
    # Для инвайт-ссылки t.me/+hash сначала входим в чат, иначе get_entity часто не находит
    if channel_id.startswith('t.me/+'):
        hash_part = channel_id.replace('t.me/+', '').strip()
        if hash_part:
            try:
                res = await client(ImportChatInviteRequest(hash_part))
                if res.chats:
                    return res.chats[0]
            except Exception as e:
                raise RuntimeError(f'Не удалось войти по инвайт-ссылке: {e}') from e
        return None
    try:
        if channel_id.startswith('t.me/'):
            link = 'https://t.me/' + channel_id.replace('t.me/', '', 1)
            return await client.get_entity(link)
        if not channel_id.startswith('@'):
            channel_id = '@' + channel_id
        return await client.get_entity(channel_id)
    except Exception as e:
        if 'join' in str(e).lower() or 'invite' in str(e).lower() or 'not part' in str(e).lower():
            if channel_id.startswith('t.me/+'):
                hash_part = channel_id.replace('t.me/+', '').strip()
                try:
                    res = await client(ImportChatInviteRequest(hash_part))
                    if res.chats:
                        return res.chats[0]
                except Exception:
                    pass
        raise


def analyze_messages(texts):
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


async def run_check(channel_id):
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
        return {
            'found': True,
            'username': channel_id,
            'risk_score': risk,
            'ads_per_week': ads_week,
            'bot_pct': '—',
            'vip_price': vip,
            'complaints': None,
            'total_loss': None,
            'verdict': verdict
        }
    finally:
        await client.disconnect()


def append_to_scam_base(channel_id, risk, ads_week, vip, verdict):
    if not KRO_SHEET_ID or not KRO_SCAM_BASE_RANGE:
        return
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        creds = None
        json_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
        json_str = os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON')
        if json_str:
            creds = service_account.Credentials.from_service_account_info(json.loads(json_str))
        elif json_path and os.path.isfile(json_path):
            creds = service_account.Credentials.from_service_account_file(json_path)
        if not creds:
            return
        sheets = build('sheets', 'v4', credentials=creds)
        row = [channel_id, risk, ads_week, '—', vip, '—', '—', verdict]
        sheets.spreadsheets().values().append(
            spreadsheetId=KRO_SHEET_ID,
            range=f'{SCAM_BASE_SHEET_NAME}!A:H',
            valueInputOption='USER_ENTERED',
            insertDataOption='INSERT_ROWS',
            body={'values': [row]}
        ).execute()
    except Exception:
        pass


def main():
    channel_id = (sys.argv[1] if len(sys.argv) > 1 else '').strip()
    if not channel_id:
        out({'found': False, 'error': 'channel required'})
        return
    if not TELEGRAM_API_ID or not TELEGRAM_API_HASH:
        out({'found': False, 'error': 'telegram not configured'})
        return
    try:
        result = asyncio.run(run_check(channel_id))
        if result is None:
            out({'found': False, 'error': 'channel not found or inaccessible'})
            return
        append_to_scam_base(
            channel_id,
            result['risk_score'],
            result['ads_per_week'],
            result['vip_price'],
            result['verdict']
        )
        out(result)
    except Exception as e:
        out({'found': False, 'error': str(e)[:200]})


if __name__ == '__main__':
    main()
