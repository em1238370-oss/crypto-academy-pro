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
CHANNEL_YOUNG_DAYS = 90  # <90 дн. без жалоб — жёлтый; при жалобах — красный (см. collect_unified_flags)

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


def _has_strong_whistleblower_source(source_primary: str, source_evidence: str) -> bool:
    blob = _lower(' '.join((source_primary or '', source_evidence or '')))
    return any(marker in blob for marker in BLACKLIST_SOURCE_MARKERS)


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
    subscribers: Optional[int],
    last_post_dt: Optional[datetime],
    username: str,
    link: str,
    title: str,
    about: str,
    posts_blob: str,
    source_primary: str,
    source_evidence: str,
    object_type: str,
    content_analysis_text: str,
) -> Tuple[bool, str]:
    # Подписчики из Telethon/HTML могут отсутствовать (FloodWait, скрытый счётчик) — тогда не отклоняем.
    # Если Telegram-данные неполные, но есть сильный whistleblower-источник + крипто-контекст в источнике,
    # не считаем такой объект «не по теме» только из-за отсутствия/устаревания телега-метрик.
    strong_source_crypto_fallback = (
        _has_strong_whistleblower_source(source_primary, source_evidence)
        and has_mandatory_crypto_topic(source_primary, source_evidence)
    )
    source_crypto_fallback = (
        subscribers is None and has_mandatory_crypto_topic(source_primary, source_evidence)
    ) or strong_source_crypto_fallback
    if subscribers is not None and subscribers < 100:
        return False, 'mandatory_subs_below_100'
    if last_post_dt is None:
        if source_crypto_fallback:
            return True, 'ok_source_crypto_fallback_no_post_date'
        return False, 'mandatory_no_post_date'
    lp = last_post_dt
    if lp.tzinfo is None:
        lp = lp.replace(tzinfo=timezone.utc)
    age_days = (datetime.now(timezone.utc) - lp).days
    if age_days > MANDATORY_LAST_POST_DAYS:
        if source_crypto_fallback:
            return True, 'ok_source_crypto_fallback_stale_posts'
        return False, 'mandatory_last_post_stale'
    if not has_mandatory_crypto_topic(
        username, link, title, about, posts_blob, source_primary, source_evidence, object_type, content_analysis_text,
    ):
        if source_crypto_fallback:
            return True, 'ok_source_crypto_fallback_topic'
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

    try:
        complaints = int(obj.get('complaints') or 0)
    except (TypeError, ValueError):
        complaints = 0

    # 9 возраст канала < 90 дн.; при жалобах — красный флаг (вес +2 в политике источников), иначе жёлтый
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
    young = age_days is not None and age_days < CHANNEL_YOUNG_DAYS
    if young and complaints >= 1:
        add_red('канал моложе 90 дней при наличии жалоб')
    elif young:
        add_yellow('канал моложе 3 месяцев')

    # 10 накрутка просмотров
    vc = view_counts or analysis.get('post_view_counts') or []
    if engagement_flag_yellow(subscribers, vc):
        add_yellow('низкое соотношение просмотров к подписчикам (<5%)')

    # 11 жалобы (комбинацию «молодой + жалобы» уже отразили отдельным красным в п.9)
    if complaints >= 1 and not (young and complaints >= 1):
        add_red('есть жалобы от пользователей')

    # 12 сайты-разоблачители
    sp = _lower(obj.get('source_primary', ''))
    se = _lower(obj.get('source_evidence', ''))
    blob_src = sp + ' ' + se
    if any(m in blob_src for m in BLACKLIST_SOURCE_MARKERS):
        add_red('упоминание на сайте-разоблачителе')

    # 13 Сеть связей — красный флаг (не жёлтый): перекрёстные упоминания; если цель в базе KRO — отдельная формулировка
    keys = known_base_keys or set()
    self_key = _norm_username_key(obj.get('username', ''), obj.get('link', ''))
    mentions = analysis.get('network_mentions') or []
    kro_hit = False
    other_net = False
    for edge in mentions:
        tgt = _norm_username_key(edge.get('target_channel', ''), '')
        if not tgt or tgt == self_key:
            continue
        if tgt in keys:
            kro_hit = True
            break
        other_net = True
    if kro_hit:
        add_red('рекламирует канал из базы KRO (подтверждённый скам)')
    elif other_net:
        add_red('перекрёстные упоминания каналов (сеть связей)')

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
    subscribers: Optional[int] = None,
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
    # Корпус постов с HTML/Telethon (см. _summarize_content_messages → unified_mandatory_posts_blob).
    # При публичном HTML без Telethon title/about и даты постов должны попасть в blob; иначе дублируем из полей анализа.
    raw_blob = analysis.get('unified_mandatory_posts_blob')
    posts_blob = (raw_blob if isinstance(raw_blob, str) else '') or ''
    posts_blob = posts_blob.strip()
    if not posts_blob:
        t = _lower(analysis.get('channel_title'))
        a = _lower(analysis.get('channel_about'))
        lpa = analysis.get('last_post_at')
        if lpa:
            posts_blob = ('%s %s %s' % (t, a, _lower(str(lpa)))).strip()
        else:
            posts_blob = ('%s %s' % (t, a)).strip()
    if len(posts_blob) > 50000:
        posts_blob = posts_blob[:50000]
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
            source_primary=obj.get('source_primary', '') or '',
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
        subscribers=subscribers if subscribers is not None else 0,
        channel_created_dt=channel_created_dt,
        view_counts=view_counts,
        known_base_keys=known_base_keys,
    )
    if not gate_ok:
        # Каналы со статусом 'не по теме' не записываются в scam_base (run_12h_monitor: _scam_base_status_is_off_topic).
        # Правило: лучше меньше но правда
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


_WATCH_GATE_REASON_RU = {
    'mandatory_subs_below_100': 'мало подписчиков (<100) для критерия крипто-канала',
    'mandatory_no_post_date': 'нет даты поста и по полям канала не видно крипто-темы',
    'mandatory_last_post_stale': 'давно не было постов — вне активного крипто-контента по правилам мониторинга',
    'mandatory_not_crypto_topic': 'в описании и источниках нет маркеров крипто-темы',
    'ok_watch_without_post_date': '',
}


def mandatory_gate_watch_relaxed(
    *,
    subscribers: Optional[int],
    last_post_dt: Optional[datetime],
    username: str,
    link: str,
    title: str,
    about: str,
    posts_blob: str,
    source_primary: str,
    source_evidence: str,
    object_type: str,
) -> Tuple[bool, str]:
    """
    Широкий мониторинг (channels_watch): при известной дате поста — полный mandatory_gate_telegram;
    устаревшие/пропущенные посты не переводят в «не по теме» — только проверка крипто-маркеров.
    """
    if last_post_dt is not None:
        ok, r = mandatory_gate_telegram(
            subscribers=subscribers,
            last_post_dt=last_post_dt,
            username=username,
            link=link,
            title=title,
            about=about,
            posts_blob=posts_blob,
            source_primary=source_primary,
            source_evidence=source_evidence,
            object_type=object_type,
            content_analysis_text='',
        )
        if ok:
            return True, r
        if r in ('mandatory_last_post_stale', 'mandatory_no_post_date'):
            if subscribers is not None and subscribers > 0 and subscribers < 100:
                return False, 'mandatory_subs_below_100'
            if not has_mandatory_crypto_topic(
                username, link, title, about, posts_blob, source_evidence, object_type, '',
            ):
                return False, 'mandatory_not_crypto_topic'
            return True, 'ok_watch_relaxed_stale_posts'
        return ok, r
    if subscribers is not None and subscribers > 0 and subscribers < 100:
        return False, 'mandatory_subs_below_100'
    if not has_mandatory_crypto_topic(
        username, link, title, about, posts_blob, source_evidence, object_type, '',
    ):
        return False, 'mandatory_not_crypto_topic'
    return True, 'ok_watch_without_post_date'


def watch_evaluate_status(
    obj: Dict[str, Any],
    analysis: Dict[str, Any],
    *,
    subscribers: Optional[int],
    channel_created_dt: Optional[datetime],
    view_counts: Optional[List[int]],
    known_base_keys: Optional[Set[str]],
    complaints_count: int,
    has_whistleblower_external: bool,
) -> Tuple[str, str, List[str], List[str]]:
    """
    Итоговая оценка для channels_watch.
    Жалобы не дублируются как красные флаги в collect: complaints=0 в копии obj.

    Возвращает (status, status_reason_ru, red_flags, yellow_flags).
    """
    obj2 = dict(obj)
    obj2['complaints'] = 0
    analysis = dict(analysis) if isinstance(analysis, dict) else {}
    red, yellow = collect_unified_flags(
        obj2,
        analysis,
        subscribers=subscribers if subscribers is not None else 0,
        channel_created_dt=channel_created_dt,
        view_counts=view_counts,
        known_base_keys=known_base_keys,
    )
    raw_blob = analysis.get('unified_mandatory_posts_blob')
    posts_blob = (raw_blob if isinstance(raw_blob, str) else '') or ''
    posts_blob = posts_blob.strip()
    if not posts_blob:
        t = _lower(analysis.get('channel_title'))
        a = _lower(analysis.get('channel_about'))
        posts_blob = ('%s %s' % (t, a)).strip()
    title = str(analysis.get('channel_title') or '')
    about = str(analysis.get('channel_about') or '')
    lp = analysis.get('last_post_at')
    last_post_dt = None
    if lp:
        try:
            last_post_dt = datetime.fromisoformat(str(lp).replace('Z', '+00:00'))
        except ValueError:
            last_post_dt = None

    gate_ok, gate_reason = mandatory_gate_watch_relaxed(
        subscribers=subscribers,
        last_post_dt=last_post_dt,
        username=str(obj.get('username', '') or ''),
        link=str(obj.get('link', '') or ''),
        title=title,
        about=about,
        posts_blob=posts_blob,
        source_primary=str(obj.get('source_primary', '') or ''),
        source_evidence=str(obj.get('source_evidence', '') or ''),
        object_type=str(obj.get('object_type', '') or 'сигнал-канал'),
    )

    R = len(red)
    Y = len(yellow)
    try:
        C = max(0, int(complaints_count or 0))
    except (TypeError, ValueError):
        C = 0

    if not gate_ok:
        msg = _WATCH_GATE_REASON_RU.get(gate_reason) or (gate_reason or 'вне темы крипто-мониторинга')
        return 'не по теме', msg, red, yellow

    if R >= 2 and has_whistleblower_external:
        tail = '…' if len(red) > 5 else ''
        reason = '≥2 признаков риска и внешний источник (разоблачитель/статья): %s%s' % (
            '; '.join(red[:5]),
            tail,
        )
        return 'подтверждённый скам', reason, red, yellow

    if R >= 1:
        tail = '…' if len(red) > 6 else ''
        return (
            'в риске',
            'Красные флаги по контенту/сети: %s%s' % ('; '.join(red[:6]), tail),
            red,
            yellow,
        )

    if C >= 2:
        return (
            'в риске',
            'Несколько жалоб или сигналов в данных (%d) без отдельных контент-флагов в выборке.' % C,
            red,
            yellow,
        )

    if Y >= 1 or C == 1:
        parts = []
        if Y >= 1:
            ytail = '…' if len(yellow) > 4 else ''
            parts.append('Жёлтые флаги: %s%s' % ('; '.join(yellow[:4]), ytail))
        if C == 1:
            parts.append('одна зафиксированная жалоба или сигнал')
        return 'под наблюдением', '. '.join(parts), red, yellow

    return (
        'без нарушений',
        'Контент-флагов нет; повторных жалоб нет — по текущей выборке канал выглядит чистым.',
        red,
        yellow,
    )
