#!/usr/bin/env python3
"""
KRO check once: проверка одного канала по Telegram (Telethon).
Принимает: идентификатор канала (@name, t.me/+hash), опционально period_days (30|180|365).
Выводит в stdout одну строку JSON: found, risk_score, ads_per_week, bot_pct, vip_price, verdict, period_days.
При ошибке — found: false, error. Код выхода 0 всегда (для парсинга в Node).
"""
import os
import re
import sys
import json
import asyncio
from datetime import datetime, timedelta, timezone

from telethon import TelegramClient
from telethon.tl.functions.messages import ImportChatInviteRequest
from telethon.errors import ChannelPrivateError, InviteHashExpiredError, UsernameNotOccupiedError

_raw_id = (os.environ.get('TELEGRAM_API_ID') or '').strip()
TELEGRAM_API_ID = int(_raw_id) if _raw_id.isdigit() else 0
TELEGRAM_API_HASH = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
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

VERDICT_PHRASES = {
    'scam': 'живут на VIP-подписках',
    'grey': 'серая зона',
    'safe': 'низкий риск'
}


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
    """Возвращает risk (0–100), matches, total, risk_pct (доля постов с VIP/сигналы/курс)."""
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
        return 0, 0, 0, 0
    risk_pct = round((matches / total) * 100)
    risk = min(100, int(risk_pct * 1.2))
    return risk, matches, total, risk_pct


def count_ads_last_7_days(messages_with_dates):
    """Считает посты с рекламными ключевыми словами за последние 7 дней. messages_with_dates: [(text, date), ...]."""
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=7)
    count = 0
    for text, msg_date in messages_with_dates:
        if not text or len(text) < 5:
            continue
        if msg_date and getattr(msg_date, 'tzinfo', None) is None:
            msg_date = msg_date.replace(tzinfo=timezone.utc)
        if msg_date and msg_date < cutoff:
            continue
        lower = text.lower()
        for kw in RISK_KEYWORDS:
            if kw in lower:
                count += 1
                break
    return min(99, count)


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


def _is_ad_like(text):
    """Пост считается рекламным, если содержит ключевые слова риска."""
    if not text or len(text) < 5:
        return False
    lower = text.lower()
    for kw in RISK_KEYWORDS:
        if kw in lower:
            return True
    return False


def ads_per_week_from_messages(messages):
    """
    Считает число рекламных постов за последнюю неделю.
    messages: список (text, date) где date — datetime или None.
    """
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)
    ad_count = 0
    for text, msg_date in messages:
        if not _is_ad_like(text):
            continue
        if msg_date is None:
            ad_count += 1
            continue
        if msg_date.tzinfo is None:
            msg_date = msg_date.replace(tzinfo=timezone.utc)
        if msg_date >= week_ago:
            ad_count += 1
    return min(99, ad_count)


def bot_pct_from_reply_texts(reply_texts):
    """
    Эвристика: «ботоподобные» комментарии — очень короткие или дубликаты.
    Возвращает строку "N%" или "—" если комментариев нет.
    """
    if not reply_texts:
        return '—'
    stripped = []
    for t in reply_texts:
        s = (t or '').strip()
        if s:
            stripped.append(s)
    if not stripped:
        return '—'
    bot_like = 0
    seen = {}
    for s in stripped:
        if len(s) < 12:
            bot_like += 1
        else:
            key = s.lower()[:50]
            seen[key] = seen.get(key, 0) + 1
    for count in seen.values():
        if count >= 3:
            bot_like += count
    pct = min(100, int(100 * bot_like / len(stripped)))
    return f'{pct}%'


async def run_check(channel_id, period_days=30):
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
        now = datetime.now(timezone.utc)
        min_date = now - timedelta(days=period_days)

        if period_days <= 30:
            raw = await client.get_messages(entity, limit=150)
            messages = []
            for m in raw:
                if not m or not m.date:
                    continue
                md = m.date.replace(tzinfo=timezone.utc) if getattr(m.date, 'tzinfo', None) is None else m.date
                if md >= min_date:
                    messages.append(m)
        else:
            max_count = 500 if period_days <= 180 else 1000
            messages = []
            async for m in client.iter_messages(entity, limit=max_count):
                if not m or not m.date:
                    continue
                md = m.date.replace(tzinfo=timezone.utc) if getattr(m.date, 'tzinfo', None) is None else m.date
                if md < min_date:
                    break
                messages.append(m)

        texts = []
        messages_with_dates = []
        for m in messages:
            if m and m.text:
                texts.append(m.text)
                messages_with_dates.append((m.text, m.date))

        risk, matches, total, risk_pct = analyze_messages(texts)
        # Канал не про крипту/скрипторий — проверяем только тематические
        if total >= 5 and matches == 0:
            return {
                'found': False,
                'not_crypto': True,
                'username': channel_id,
                'error': 'Канал не связан с криптой. Мы проверяем только каналы, связанные с криптой/скрипторием. Другие не проверяем.'
            }
        vip = extract_vip_price(texts)
        ads_week = count_ads_last_7_days(messages_with_dates)

        reply_texts = []
        try:
            for m in messages[:25]:
                if not m or not getattr(m.replies, 'replies', 0):
                    continue
                replies = await client.get_messages(entity, reply_to=m.id, limit=15)
                for r in replies:
                    if r and r.text:
                        reply_texts.append(r.text)
                if len(reply_texts) >= 50:
                    break
        except Exception:
            pass
        bot_pct = bot_pct_from_reply_texts(reply_texts)

        if risk >= 70:
            verdict = 'scam'
        elif risk >= 35:
            verdict = 'grey'
        else:
            verdict = 'safe'
        verdict_phrase = VERDICT_PHRASES.get(verdict, verdict)
        reasons = []
        reasons.append(f'реклама ({ads_week} постов/нед)')
        reasons.append('боты: нет данных (доступ к комментариям канала через API отсутствует)')
        if vip and vip != '—':
            reasons.append(f'VIP ({vip})')
        return {
            'found': True,
            'username': channel_id,
            'risk_score': risk,
            'ads_per_week': ads_week,
            'bot_pct': bot_pct,
            'vip_price': vip,
            'complaints': None,
            'total_loss': None,
            'verdict': verdict,
            'verdict_phrase': verdict_phrase,
            'reasons': reasons,
            'risk_pct': risk_pct,
            'period_days': period_days
        }
    finally:
        await client.disconnect()


def append_to_scam_base(channel_id, risk, ads_week, bot_pct, vip, verdict):
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
        row = [channel_id, risk, ads_week, bot_pct or '—', vip, '—', '—', verdict]
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
    period_days = 30
    if len(sys.argv) > 2:
        raw = (sys.argv[2] or '').strip()
        if raw in ('30', '180', '365'):
            period_days = int(raw)
    if not TELEGRAM_API_ID or not TELEGRAM_API_HASH:
        out({'found': False, 'error': 'telegram not configured'})
        return
    session_file = TELEGRAM_SESSION_NAME + '.session'
    if not os.path.isfile(session_file):
        out({
            'found': False,
            'error': 'Сначала один раз войдите в Telegram. В терминале из папки проекта выполните: node scripts/kro-login.js'
        })
        return
    try:
        result = asyncio.run(run_check(channel_id, period_days))
        if result is None:
            out({'found': False, 'error': 'channel not found or inaccessible'})
            return
        if result.get('not_crypto'):
            out(result)
            return
        append_to_scam_base(
            channel_id,
            result['risk_score'],
            result['ads_per_week'],
            result['bot_pct'],
            result['vip_price'],
            result['verdict']
        )
        out(result)
    except Exception as e:
        out({'found': False, 'error': str(e)[:200]})


if __name__ == '__main__':
    main()
