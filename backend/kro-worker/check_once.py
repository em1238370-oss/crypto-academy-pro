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
В scam_base записываются только каналы, которые прошли 3 критерия подтверждения.
"""
import os
import re
import sys
import json
import asyncio
import os.path
from datetime import datetime, timezone, timedelta
from urllib.request import urlopen, Request
from urllib.parse import urlencode
from urllib.error import URLError, HTTPError

from telethon import TelegramClient
from telethon.tl.functions.messages import ImportChatInviteRequest
from telethon.errors import ChannelPrivateError, InviteHashExpiredError, UsernameNotOccupiedError
from google.oauth2 import service_account
from googleapiclient.discovery import build

_raw_id = (os.environ.get('TELEGRAM_API_ID') or '').strip()
TELEGRAM_API_ID = int(_raw_id) if _raw_id.isdigit() else 0
TELEGRAM_API_HASH = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
TELEGRAM_SESSION_NAME = os.environ.get('TELEGRAM_SESSION_NAME', 'kro_worker')

KRO_SHEET_ID = os.environ.get('KRO_SHEET_ID', '')
KRO_SCAM_BASE_RANGE = os.environ.get('KRO_SCAM_BASE_RANGE', 'scam_base!A2:H')
SCAM_BASE_SHEET_NAME = KRO_SCAM_BASE_RANGE.split('!')[0] if '!' in KRO_SCAM_BASE_RANGE else 'scam_base'
KRO_REPORTS_RANGE = os.environ.get('KRO_REPORTS_RANGE', 'A2:F')
KRO_UNCONFIRMED_RANGE = os.environ.get('KRO_UNCONFIRMED_RANGE', '')
UNCONFIRMED_SHEET_NAME = KRO_UNCONFIRMED_RANGE.split('!')[0] if '!' in KRO_UNCONFIRMED_RANGE else ''

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


def _parse_int(value):
    digits = re.sub(r'[^\d]', '', str(value or ''))
    return int(digits) if digits else None


def _parse_vip_price_number(vip_price):
    n = _parse_int(vip_price)
    return n if n is not None else 0


def _normalize_channel_key(channel):
    s = (channel or '').strip().lower().replace(' ', '')
    if not s:
        return ''
    if s.startswith('https://t.me/'):
        s = s.replace('https://t.me/', 't.me/', 1)
    elif s.startswith('http://t.me/'):
        s = s.replace('http://t.me/', 't.me/', 1)
    if s.startswith('t.me/+'):
        return s
    if s.startswith('t.me/'):
        s = s[5:]
    if s.startswith('@'):
        s = s[1:]
    return s


def _format_total_loss(total_sum):
    if total_sum >= 1000000:
        return (f'{total_sum / 1000000:.1f}'.rstrip('0').rstrip('.')) + 'млн₽'
    if total_sum >= 1000:
        return f'{round(total_sum / 1000)}к₽'
    return f'{total_sum}₽'


def _get_sheets_client():
    if not KRO_SHEET_ID:
        return None
    creds = None
    json_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
    json_str = os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON')
    if json_str:
        creds = service_account.Credentials.from_service_account_info(json.loads(json_str))
    elif json_path and os.path.isfile(json_path):
        creds = service_account.Credentials.from_service_account_file(json_path)
    if not creds:
        return None
    return build('sheets', 'v4', credentials=creds)


def get_complaints_and_loss_for_channel(channel_id):
    client = _get_sheets_client()
    if not client:
        return None, None
    key = _normalize_channel_key(channel_id)
    if not key:
        return None, None
    try:
        response = client.spreadsheets().values().get(
            spreadsheetId=KRO_SHEET_ID,
            range=KRO_REPORTS_RANGE
        ).execute()
        rows = response.get('values', [])
    except Exception:
        return None, None

    complaints = 0
    total_sum = 0
    for row in rows:
        row_channel = str(row[1] if len(row) > 1 else '').strip()
        if _normalize_channel_key(row_channel) != key:
            continue
        complaints += 1
        total_sum += _parse_int(row[2] if len(row) > 2 else '') or 0

    if complaints == 0:
        return None, None
    return complaints, _format_total_loss(total_sum)


def _has_signal_offer(texts):
    if not texts:
        return False
    combined = ' '.join((t or '').lower() for t in texts)
    markers = [
        'лонг', 'шорт', 'long', 'short', 'signal', 'signals', 'сигнал',
        'сигналы', 'take profit', 'stop loss', 'tp', 'sl'
    ]
    return any(marker in combined for marker in markers)


def _build_confirmation(result):
    age_days = result.get('channel_age_days')
    vip_number = _parse_vip_price_number(result.get('vip_price'))
    complaints = result.get('complaints')
    age_ok = age_days is not None and age_days <= 14
    offer_ok = vip_number >= 10000 or bool(result.get('has_signal_offer'))
    complaints_ok = complaints is not None and complaints >= 2

    checks = {
        'channel_age_under_14_days': age_ok,
        'vip_10000_or_signals': offer_ok,
        'two_or_more_real_complaints': complaints_ok,
    }
    missing = []
    if not age_ok:
        missing.append('канал старше 14 дней или дата создания не подтверждена')
    if not offer_ok:
        missing.append('не найден VIP от 10000₽ и нет явных long/short сигналов')
    if not complaints_ok:
        missing.append('жалоб от минимум 2 реальных людей пока нет')

    is_confirmed = all(checks.values())
    result['confirmation_checks'] = checks
    result['missing_criteria'] = missing
    result['is_confirmed'] = is_confirmed
    result['confirmation_status'] = 'confirmed' if is_confirmed else 'not_confirmed'
    result['risk_verdict'] = result.get('verdict')
    result['verdict'] = 'scam' if is_confirmed else 'not_confirmed'
    result['message'] = (
        'Канал подтверждён по трём критериям и может быть записан в scam_base.'
        if is_confirmed else
        'Канал проверен, но пока не проходит 3 критерия подтверждённого скам-канала: ' + '; '.join(missing) + '.'
    )
    return result


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
            for m in messages[:50]:
                if not m or not getattr(m.replies, 'replies', 0):
                    continue
                replies = await client.get_messages(entity, reply_to=m.id, limit=25)
                for r in replies:
                    if r and r.text:
                        reply_texts.append(r.text)
                if len(reply_texts) >= 100:
                    break
        except Exception:
            pass
        bot_pct = bot_pct_from_reply_texts(reply_texts)

        # Метрики по 12 критериям: наши функции и TGStat
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

        canonical_channel_id = ('@' + entity.username) if getattr(entity, 'username', None) else channel_id
        complaints, total_loss = get_complaints_and_loss_for_channel(canonical_channel_id)
        has_signal_offer = _has_signal_offer(texts)

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
            'username': canonical_channel_id,
            'risk_score': risk_score,
            'ads_per_week': ads_week,
            'bot_pct': bot_pct,
            'vip_price': vip,
            'complaints': complaints,
            'total_loss': total_loss,
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
            'has_signal_offer': has_signal_offer,
        }
    finally:
        await client.disconnect()


def append_to_scam_base(channel_id, risk, ads_week, bot_pct, vip, complaints, total_loss, verdict,
                        result_obj=None):
    """Write confirmed channel to scam_base using v2 schema (13 cols A:M)."""
    if not KRO_SHEET_ID or not KRO_SCAM_BASE_RANGE:
        return
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        from datetime import datetime, timezone
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
        now_iso = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        r = result_obj or {}
        # v2 schema: A username | B link | C detected_at | D created_at | E age_days |
        #            F object_type | G vip_price | H complaints | I total_loss_rub |
        #            J source_primary | K source_evidence | L cycle_window | M status
        link = r.get('link') or ('https://t.me/' + str(channel_id).lstrip('@'))
        created_at = r.get('created_at') or ''
        age_days = r.get('channel_age_days') or ''
        obj_type = 'сигнал-канал'
        vip_price_str = str(vip) if vip and vip != '—' else ''
        complaints_val = complaints if complaints is not None else ''
        try:
            total_loss_rub = int(str(total_loss).replace('млн₽', '000000').replace('к₽', '000').replace('₽', '').replace(' ', '')) if total_loss and total_loss != '—' else ''
        except (ValueError, TypeError):
            total_loss_rub = ''
        cycle_window = ''
        status = 'в риске'
        row = [
            str(channel_id),
            link,
            now_iso,
            created_at,
            age_days,
            obj_type,
            vip_price_str,
            complaints_val,
            total_loss_rub,
            '',  # source_primary
            '',  # source_evidence
            cycle_window,
            status,
        ]
        sheets.spreadsheets().values().append(
            spreadsheetId=KRO_SHEET_ID,
            range=f'{SCAM_BASE_SHEET_NAME}!A:M',
            valueInputOption='USER_ENTERED',
            insertDataOption='INSERT_ROWS',
            body={'values': [row]}
        ).execute()
    except Exception:
        pass


def append_to_unconfirmed_base(result):
    if not KRO_SHEET_ID or not KRO_UNCONFIRMED_RANGE or not UNCONFIRMED_SHEET_NAME:
        return
    try:
        client = _get_sheets_client()
        if not client:
            return
        checks = result.get('confirmation_checks') or {}
        row = [
            result.get('username') or '',
            result.get('confirmation_status') or 'not_confirmed',
            result.get('channel_age_days') if result.get('channel_age_days') is not None else '—',
            result.get('vip_price') or '—',
            result.get('complaints') if result.get('complaints') is not None else '—',
            'yes' if result.get('has_signal_offer') else 'no',
            'yes' if checks.get('channel_age_under_14_days') else 'no',
            'yes' if checks.get('vip_10000_or_signals') else 'no',
            'yes' if checks.get('two_or_more_real_complaints') else 'no',
            '; '.join(result.get('missing_criteria') or []),
            datetime.now(timezone.utc).isoformat(),
        ]
        client.spreadsheets().values().append(
            spreadsheetId=KRO_SHEET_ID,
            range=KRO_UNCONFIRMED_RANGE,
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
        result = _build_confirmation(result)
        if result.get('is_confirmed'):
            append_to_scam_base(
                result['username'],
                result['risk_score'],
                result['ads_per_week'],
                result['bot_pct'],
                result['vip_price'],
                result['complaints'],
                result['total_loss'],
                result['verdict'],
                result_obj=result
            )
        else:
            append_to_unconfirmed_base(result)
        out(result)
    except Exception as e:
        out({'found': False, 'error': str(e)[:200]})


if __name__ == '__main__':
    main()
