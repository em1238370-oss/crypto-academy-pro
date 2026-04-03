# -*- coding: utf-8 -*-
"""
Единые обязательные условия и скоринг риска для объектов KRO (каналы, боты, обменники).
Статусы: без нарушений | под наблюдением | в риске | подтверждённый скам
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import kro_red_flags as _kro_red_flags
from kro_tme_http_gate import SCAM_BASE_HTTP_CRYPTO_TERMS, SCAM_BASE_HTTP_POST_MAX_AGE_DAYS

# Синхронно с HTTP-gate scam_base (kro_tme_http_gate)
MANDATORY_CRYPTO_TERMS = SCAM_BASE_HTTP_CRYPTO_TERMS
MANDATORY_LAST_POST_DAYS = SCAM_BASE_HTTP_POST_MAX_AGE_DAYS
CHANNEL_YOUNG_DAYS = 90  # < 3 месяцев — жёлтый флаг

BLACKLIST_SOURCE_MARKERS = (
    'stop-scam', 'fin-obzor', 'vklader', 'telltrue', 'forteck',
    'cryptorussia', 'brokers-check', 'kurs.expert',
)

ANON_PATTERNS = (
    'аноним', 'anonymous', 'неизвестен владелец', 'скрыт админ',
    'без верификации', 'no verification',
)


def _lower(s: str) -> str:
    return (str(s) if s is not None else '').lower()


def has_mandatory_crypto_topic(*parts: str) -> bool:
    blob = _lower(' '.join(p or '' for p in parts))
    return any(t in blob for t in MANDATORY_CRYPTO_TERMS)


def _parse_views_string(raw: str) -> Optional[int]:
    if not raw:
        return None
    s = raw.strip().lower().replace('\xa0', ' ')
    s = re.sub(r'[^\d.,kmk\s]', '', s)
    m = re.search(r'([\d\s.,]+)\s*([km])?\b', s)
    if not m:
        nums = re.sub(r'[^\d]', '', s)
        return int(nums) if nums else None
    num = m.group(1).replace(' ', '').replace(',', '.')
    try:
        v = float(num)
    except ValueError:
        return None
    suf = (m.group(2) or '').lower()
    if suf == 'k':
        v *= 1000
    elif suf == 'm':
        v *= 1_000_000
    return int(round(v))


def engagement_flag_yellow(subscribers: int, view_counts: List[int]) -> bool:
    """Соотношение средних просмотров к подписчикам < 5% — подозрение на накрутку."""
    if subscribers <= 0 or not view_counts:
        return False
    avg = sum(view_counts) / len(view_counts)
    if avg <= 0:
        return False
    ratio = avg / float(subscribers)
    return ratio < 0.05


def mandatory_gate_telegram(
    *,
    subscribers: int,
    last_post_dt: Optional[datetime],
    username: str,
    link: str,
    title: str,
    about: str,
    posts_blob: str,
    source_evidence: str,
    object_type: str,
    content_analysis_text: str,
) -> Tuple[bool, str]:
    if subscribers < 100:
        return False, 'mandatory_subs_below_100'
    if last_post_dt is None:
        return False, 'mandatory_no_post_date'
    lp = last_post_dt
    if lp.tzinfo is None:
        lp = lp.replace(tzinfo=timezone.utc)
    age_days = (datetime.now(timezone.utc) - lp).days
    if age_days > MANDATORY_LAST_POST_DAYS:
        return False, 'mandatory_last_post_stale'
    if not has_mandatory_crypto_topic(
        username, link, title, about, posts_blob, source_evidence, object_type, content_analysis_text,
    ):
        return False, 'mandatory_not_crypto_topic'
    return True, 'ok'


def mandatory_gate_non_telegram(
    *,
    username: str,
    object_type: str,
    source_primary: str,
    source_evidence: str,
    content_analysis_text: str = '',
) -> Tuple[bool, str]:
    if not has_mandatory_crypto_topic(
        username, object_type, source_primary, source_evidence, content_analysis_text,
    ):
        return False, 'mandatory_not_crypto_topic'
    return True, 'ok'


def _is_telegram_object(username: str, link: str, object_type: str) -> bool:
    blob = _lower(' '.join((username, link, object_type)))
    if 't.me/' in blob:
        return True
    if username.strip().startswith('@'):
        return True
    return 'сигнал' in _lower(object_type) and 'обменник' not in _lower(object_type)


def collect_unified_flags(
    obj: Dict[str, Any],
    analysis: Dict[str, Any],
    *,
    subscribers: int = 0,
    channel_created_dt: Optional[datetime] = None,
    view_counts: Optional[List[int]] = None,
    known_base_keys: Optional[Set[str]] = None,
) -> Tuple[List[str], List[str]]:
    """Возвращает (red_flag_labels, yellow_flag_labels)."""
    red: List[str] = []
    yellow: List[str] = []
    ot_key = _kro_red_flags.object_type_red_flag_key(obj.get('object_type') or '')
    corpus = ' '.join(
        _lower(x) for x in (
            obj.get('username', ''),
            obj.get('link', ''),
            obj.get('source_evidence', ''),
            obj.get('vip_price', ''),
            json_corpus_from_analysis(analysis),
        )
    )
    typed = analysis.get('red_flags_typed') or _kro_red_flags.all_red_flags_by_type(
        corpus, only_profit_posts=bool(analysis.get('only_profit_posts')),
    )
    labels = list(typed.get(ot_key) or [])
    if not labels and ot_key != 'сигнал-канал':
        labels = list(typed.get('сигнал-канал') or [])

    def add_red(msg: str):
        if msg not in red:
            red.append(msg)

    def add_yellow(msg: str):
        if msg not in yellow:
            yellow.append(msg)

    # 4–7: маркеры из kro_red_flags (VIP, гарантии, only profit, срочность и т.д.)
    for L in labels:
        add_red(L)

    vp = (obj.get('vip_price') or '').strip()
    if vp and vp not in ('—', '-', 'н/д', 'n/d') and re.search(r'\d', vp):
        add_red('VIP / платные сигналы (указана цена в таблице)')

    # 8 анонимный админ — жёлтый
    if any(p in corpus for p in ANON_PATTERNS):
        add_yellow('анонимный админ / без верификации')

    # 9 возраст канала < 3 мес
    age_days = None
    if channel_created_dt is not None:
        cd = channel_created_dt
        if cd.tzinfo is None:
            cd = cd.replace(tzinfo=timezone.utc)
        age_days = (datetime.now(timezone.utc) - cd).days
    elif obj.get('channel_age_days') is not None:
        try:
            age_days = int(obj.get('channel_age_days'))
        except (TypeError, ValueError):
            age_days = None
    if age_days is not None and age_days < CHANNEL_YOUNG_DAYS:
        add_yellow('канал моложе 3 месяцев')

    # 10 накрутка просмотров
    vc = view_counts or analysis.get('post_view_counts') or []
    if engagement_flag_yellow(subscribers, vc):
        add_yellow('низкое соотношение просмотров к подписчикам (<5%)')

    # 11 жалобы
    try:
        complaints = int(obj.get('complaints') or 0)
    except (TypeError, ValueError):
        complaints = 0
    if complaints >= 1:
        add_red('есть жалобы от пользователей')

    # 12 сайты-разоблачители
    sp = _lower(obj.get('source_primary', ''))
    se = _lower(obj.get('source_evidence', ''))
    blob_src = sp + ' ' + se
    if any(m in blob_src for m in BLACKLIST_SOURCE_MARKERS):
        add_red('упоминание на сайте-разоблачителе')

    # 13 реклама каналов из базы
    keys = known_base_keys or set()
    self_key = _norm_username_key(obj.get('username', ''), obj.get('link', ''))
    for edge in analysis.get('network_mentions') or []:
        tgt = _norm_username_key(edge.get('target_channel', ''), '')
        if tgt and tgt != self_key and tgt in keys:
            add_yellow('рекламирует канал из базы KRO')
            break

    return red, yellow


def _norm_username_key(username: str, link: str = '') -> str:
    u = (username or '').strip().lstrip('@').lower()
    if u:
        return u
    link = (link or '').lower()
    if 't.me/' in link:
        part = link.split('t.me/', 1)[-1].split('?')[0].strip('/')
        if part.startswith('s/'):
            part = part[2:]
        return part.split('/')[0].lower()
    return ''


def json_corpus_from_analysis(analysis: Dict[str, Any]) -> str:
    parts = []
    d = analysis.get('keywords')
    if isinstance(d, dict):
        parts.append(' '.join(str(v) for v in d.values()))
    sf = analysis.get('sheet_facts')
    if isinstance(sf, dict):
        parts.append(' '.join(str(v) for v in sf.values()))
    return ' '.join(parts)


def status_from_flag_counts(red_n: int, yellow_n: int) -> str:
    """
    ТЗ KRO ч.3: много жёлтых вместе = серьёзный сигнал.
    0 флагов → без нарушений; 1–2 жёлтых → под наблюдением; 3+ жёлтых → в риске;
    1+ красный → в риске; 2+ красных → подтверждённый скам.
    """
    if red_n >= 2:
        return 'подтверждённый скам'
    if red_n >= 1:
        return 'в риске'
    if yellow_n >= 3:
        return 'в риске'
    if 1 <= yellow_n <= 2:
        return 'под наблюдением'
    return 'без нарушений'


def apply_unified_risk_to_row(
    obj: Dict[str, Any],
    analysis: Optional[Dict[str, Any]],
    *,
    subscribers: int = 0,
    channel_created_dt: Optional[datetime] = None,
    view_counts: Optional[List[int]] = None,
    known_base_keys: Optional[Set[str]] = None,
) -> Tuple[str, Dict[str, Any]]:
    """
    Возвращает (status, patch_for_analysis). patch мержится в analysis JSON.
    """
    analysis = dict(analysis) if isinstance(analysis, dict) else {}
    is_tg = _is_telegram_object(
        obj.get('username', '') or '',
        obj.get('link', '') or '',
        obj.get('object_type', '') or '',
    )
    last_post = None
    lpa = analysis.get('last_post_at')
    if lpa:
        try:
            last_post = datetime.fromisoformat(str(lpa).replace('Z', '+00:00'))
        except ValueError:
            last_post = None
    posts_blob = ''
    # восстановить корпус постов из network + keywords слабо; используем пустой — флаги из typed уже в analysis
    title = analysis.get('channel_title') or ''
    about = analysis.get('channel_about') or ''

    gate_ok = True
    gate_reason = 'ok'
    if is_tg:
        gate_ok, gate_reason = mandatory_gate_telegram(
            subscribers=subscribers,
            last_post_dt=last_post,
            username=obj.get('username', '') or '',
            link=obj.get('link', '') or '',
            title=title,
            about=about,
            posts_blob=posts_blob,
            source_evidence=obj.get('source_evidence', '') or '',
            object_type=obj.get('object_type', '') or '',
            content_analysis_text='',
        )
    else:
        gate_ok, gate_reason = mandatory_gate_non_telegram(
            username=obj.get('username', '') or '',
            object_type=obj.get('object_type', '') or '',
            source_primary=obj.get('source_primary', '') or '',
            source_evidence=obj.get('source_evidence', '') or '',
        )

    red, yellow = collect_unified_flags(
        obj,
        analysis,
        subscribers=subscribers,
        channel_created_dt=channel_created_dt,
        view_counts=view_counts,
        known_base_keys=known_base_keys,
    )
    if not gate_ok:
        status = 'не по теме'
    else:
        status = status_from_flag_counts(len(red), len(yellow))

    patch = {
        'unified_risk': {
            'gate_ok': gate_ok,
            'gate_reason': gate_reason,
            'red_flags': red,
            'yellow_flags': yellow,
            'red_count': len(red),
            'yellow_count': len(yellow),
            'status': status,
            'telegram_subscribers_sample': subscribers,
        },
    }
    return status, patch
