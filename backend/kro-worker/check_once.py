#!/usr/bin/env python3
"""
KRO check once: проверка одного канала по Telegram (Telethon).
Принимает один аргумент — идентификатор канала (@name, t.me/+hash).
Выводит в stdout одну строку JSON: found, risk_score, verdict, fomo_pct, promoted_channels_*, и др.
Формула риска и 12 критериев: см. docs/ru/10_KRO_ТЕЛЕГРАМ_НАСТРОЙКА и план 12 критериев.
Критерии: 1 рост подписчиков (TGStat), 2 охват vs подписчики (TGStat), 3 возраст/переименования (TGStat),
4 FOMO-слова, 5 стыдовые фразы, 6 однотипные отзывы (bot_pct), 7 реклама vs трейд (ads_ratio),
8 цена VIP, 9 только профиты (only_profits_flag), 10 связи каналов (promoted_channels),
11 скорость ответа на жалобы (complaint_ignore_hours), 12 IP/прокси — не реализован.
При ошибке — found: false, error. Код выхода 0 всегда (для парсинга в Node).
"""
import os
import re
import sys
import json
import asyncio
from datetime import datetime, timezone, timedelta
from urllib.request import urlopen, Request
from urllib.parse import urlencode
from urllib.error import URLError, HTTPError

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

# Критерий 4: FOMO-слова (доля постов с такими словами)
FOMO_KEYWORDS = [
    'срочно', 'последний', 'осталось', 'никогда', 'успей', 'все уже', 'все в деле',
    'не успел', 'последний шанс', 'ограничен', 'limited', 'last chance', 'hurry'
]

# Критерий 5: стыдовые фразы
SHAME_PHRASES = [
    'все уже в деле кроме тебя', 'только ты не успел', 'остался один ты',
    'все купили кроме тебя', 'все уже на lambo', 'ты один не в теме'
]

# Критерий 9: слова убытков (если постов много и нет таких — only_profits_flag)
LOSS_KEYWORDS = ['убыток', 'слив', 'потеря', 'минус', 'просадка', 'loss', 'drawdown']


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


def _fomo_pct(texts):
    """Доля постов (0–100), содержащих хотя бы одно FOMO-слово."""
    if not texts:
        return 0
    total = 0
    matches = 0
    for t in texts:
        if not t or len(t) < 3:
            continue
        total += 1
        lower = t.lower()
        for kw in FOMO_KEYWORDS:
            if kw in lower:
                matches += 1
                break
    return round((matches / total) * 100) if total else 0


def _shame_phrases_detected(texts):
    """Список фраз из SHAME_PHRASES, встретившихся в постах."""
    found = []
    combined = ' '.join((t or '').lower() for t in texts)
    for phrase in SHAME_PHRASES:
        if phrase in combined:
            found.append(phrase)
    return found


def _ads_ratio(messages):
    """Доля постов с рекламными ключевыми за период (0–100). messages: (text, date)."""
    if not messages:
        return 0
    total = sum(1 for t, _ in messages if t and len(t) >= 5)
    if total == 0:
        return 0
    ad_count = sum(1 for t, _ in messages if t and _is_ad_like(t))
    return min(100, round((ad_count / total) * 100))


def _only_profits_flag(texts):
    """True, если постов >= 20 и ни в одном нет LOSS_KEYWORDS."""
    if not texts or len(texts) < 20:
        return False
    combined = ' '.join((t or '').lower() for t in texts)
    for kw in LOSS_KEYWORDS:
        if kw in combined:
            return False
    return True


def _extract_promoted_channels(texts):
    """Из текстов извлечь t.me/... и @channel, уникальный набор. Возвращает (list, count)."""
    seen = set()
    tme_re = re.compile(r't\.me/(\+?[a-zA-Z0-9_]+)', re.I)
    at_re = re.compile(r'@([a-zA-Z][a-zA-Z0-9_]{4,31})\b')
    for t in (texts or []):
        if not t:
            continue
        for m in tme_re.finditer(t):
            seen.add(('t.me/' + m.group(1)).lower())
        for m in at_re.finditer(t):
            seen.add(('@' + m.group(1)).lower())
    lst = sorted(seen)
    return lst, len(lst)


def _bot_ratio_from_pct(bot_pct_str):
    """Из строки "N%" или "—" извлечь число 0–100."""
    if not bot_pct_str or bot_pct_str.strip() == '—':
        return 0
    m = re.search(r'(\d+)', str(bot_pct_str))
    return min(100, int(m.group(1))) if m else 0


def _fetch_tgstat(channel_id_for_api):
    """
    Запрос к TGStat API (критерии 1–2): рост подписчиков, охват.
    channel_id_for_api: @username или t.me/username (не t.me/+).
    Возвращает dict: subscriber_growth_per_day, growth_anomaly, reach_ratio, dead_ratio.
    """
    out_result = {
        'subscriber_growth_per_day': 0,
        'growth_anomaly': 0,
        'reach_ratio': 0.0,
        'dead_ratio': 0
    }
    token = (os.environ.get('TGSTAT_API_KEY') or '').strip()
    if not token or not channel_id_for_api or 't.me/+' in channel_id_for_api.lower():
        return out_result
    channel_param = channel_id_for_api if channel_id_for_api.startswith('@') else ('@' + channel_id_for_api.replace('t.me/', '', 1).lstrip('/'))
    timeout = 8
    try:
        stat_url = 'https://api.tgstat.ru/channels/stat?' + urlencode({'token': token, 'channelId': channel_param})
        req = Request(stat_url, headers={'User-Agent': 'KRO-check-once/1'})
        with urlopen(req, timeout=timeout) as r:
            stat_data = json.loads(r.read().decode())
        if stat_data.get('status') == 'ok' and 'response' in stat_data:
            resp = stat_data['response']
            participants = int(resp.get('participants_count') or 0)
            avg_reach = int(resp.get('avg_post_reach') or 0)
            if participants > 0:
                out_result['reach_ratio'] = round(avg_reach / participants, 4)
                out_result['dead_ratio'] = 100 if (avg_reach / participants) < 0.05 else 0
    except (URLError, HTTPError, ValueError, KeyError, OSError):
        pass
    try:
        sub_url = 'https://api.tgstat.ru/channels/subscribers?' + urlencode({
            'token': token, 'channelId': channel_param, 'group': 'day'
        })
        req = Request(sub_url, headers={'User-Agent': 'KRO-check-once/1'})
        with urlopen(req, timeout=timeout) as r:
            sub_data = json.loads(r.read().decode())
        if sub_data.get('status') == 'ok' and sub_data.get('response') and len(sub_data['response']) >= 2:
            arr = sub_data['response']
            cur = int(arr[0].get('participants_count') or 0)
            prev = int(arr[1].get('participants_count') or 0)
            growth = cur - prev
            out_result['subscriber_growth_per_day'] = growth
            out_result['growth_anomaly'] = 100 if growth > 5000 else 0
    except (URLError, HTTPError, ValueError, KeyError, OSError):
        pass
    return out_result


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
        messages_with_dates = []
        for m in messages:
            if m and m.text:
                texts.append(m.text)
                messages_with_dates.append((m.text, m.date))
        risk, _ = analyze_messages(texts)
        vip = extract_vip_price(texts)
        ads_week = ads_per_week_from_messages(messages_with_dates) if messages_with_dates else 0

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

        # Новые метрики по 12 критериям (без TGStat/Telemetr пока)
        fomo_pct = _fomo_pct(texts)
        shame_phrases_detected = _shame_phrases_detected(texts)
        ads_ratio = _ads_ratio(messages_with_dates)
        only_profits_flag = _only_profits_flag(texts)
        promoted_list, promoted_count = _extract_promoted_channels(texts)
        promoted_sample = promoted_list[:10] if promoted_list else []

        bot_ratio = _bot_ratio_from_pct(bot_pct)
        review_similarity = bot_ratio
        complaint_ignore_time = 0  # Этап 5: таблица
        network_connections = min(promoted_count * 20, 100)

        # TGStat (критерии 1–2): рост подписчиков, охват
        channel_id_for_tgstat = getattr(entity, 'username', None) and ('@' + entity.username) or (channel_id if not channel_id.startswith('t.me/+') else None)
        tgstat = _fetch_tgstat(channel_id_for_tgstat or '') if channel_id_for_tgstat else {}
        growth_anomaly = tgstat.get('growth_anomaly', 0)
        dead_ratio = tgstat.get('dead_ratio', 0)
        subscriber_growth_per_day = tgstat.get('subscriber_growth_per_day', 0)
        reach_ratio = tgstat.get('reach_ratio', 0.0)

        # Возраст канала (критерий 3) из Telethon
        channel_age_days = None
        if getattr(entity, 'date', None):
            try:
                created = entity.date
                if created.tzinfo is None:
                    created = created.replace(tzinfo=timezone.utc)
                channel_age_days = (datetime.now(timezone.utc) - created).days
            except Exception:
                pass

        # Новая формула риска (все компоненты 0–100); dead_ratio добавляем к growth_anomaly по весу
        risk_score = round(
            fomo_pct * 0.15 +
            bot_ratio * 0.20 +
            ads_ratio * 0.25 +
            growth_anomaly * 0.15 +
            review_similarity * 0.10 +
            network_connections * 0.10 +
            complaint_ignore_time * 0.05 +
            dead_ratio * 0.05  # мёртвая аудитория
        )
        risk_score = max(0, min(100, risk_score))

        if risk_score >= 70:
            verdict = 'scam'
        elif risk_score >= 35:
            verdict = 'grey'
        else:
            verdict = 'safe'

        return {
            'found': True,
            'username': channel_id,
            'risk_score': risk_score,
            'ads_per_week': ads_week,
            'bot_pct': bot_pct,
            'vip_price': vip,
            'complaints': None,
            'total_loss': None,
            'verdict': verdict,
            'fomo_pct': fomo_pct,
            'shame_phrases_detected': shame_phrases_detected,
            'ads_ratio': ads_ratio,
            'only_profits_flag': only_profits_flag,
            'promoted_channels_count': promoted_count,
            'promoted_channels_sample': promoted_sample,
            'subscriber_growth_per_day': subscriber_growth_per_day,
            'growth_anomaly': growth_anomaly,
            'reach_ratio': reach_ratio,
            'channel_age_days': channel_age_days,
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
            result['bot_pct'],
            result['vip_price'],
            result['verdict']
        )
        out(result)
    except Exception as e:
        out({'found': False, 'error': str(e)[:200]})


if __name__ == '__main__':
    main()
