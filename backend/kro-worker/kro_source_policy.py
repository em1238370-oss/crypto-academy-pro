# -*- coding: utf-8 -*-
"""
Веса источников и качество жалоб для записи в scam_base (аналитический слой поверх сырых данных).
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from kro_tme_http_gate import SCAM_BASE_HTTP_CRYPTO_TERMS

# Хабы vklader — не считать «посвящённой страницей канала»
_HUB_SLUGS = frozenset({
    'blacklist-telegram', 'proverka-telegram', 'wp-admin', 'feed', 'category', 'author', 'page', 'tag',
})

# Минимальная сумма весов для записи в scam_base (проверяет вызывающий код).
MIN_SOURCE_WEIGHT_FOR_SCAM_BASE = 3.0


def _score_complaint_quality(text: str) -> float:
    """
    Качество текста жалобы: каждый признак +0.5 (максимум 2.0 с четырёх пунктов).
    - сумма в ₽/$/€
    - описание схемы (маркеры)
    - конкретное действие мошенника
    - длина > 100 символов
    """
    t = (text or '').strip()
    if not t:
        return 0.0
    low = t.lower()
    score = 0.0
    if re.search(r'\d[\d\s\u00a0.,]*\s*(?:₽|р\.|руб|rub|usd|\$|\beur\b)', t, re.I):
        score += 0.5
    scheme_markers = (
        'оплат', 'vip', 'вип', 'подписк', 'перевёл', 'перевел', 'схем', 'депозит',
        'инвест', 'сигнал', 'гарант', 'курс', 'обучен',
    )
    if any(m in low for m in scheme_markers):
        score += 0.5
    action_markers = (
        'заблок', 'удалил', 'не отвеч', 'обман', 'кинул', 'кидал', 'слил', 'мошен',
        'не вернул', 'пропал',
    )
    if any(m in low for m in action_markers):
        score += 0.5
    if len(t) > 100:
        score += 0.5
    return min(2.0, score)


def score_complaint_quality(text: str) -> float:
    """Удобная шкала 1.0…3.0 (слабая…сильная) на базе _score_complaint_quality."""
    return min(3.0, 1.0 + _score_complaint_quality(text))


def _dedicated_vklader_weight(blob: str) -> float:
    """+2 за URL vklader.com/{slug} (посвящённая страница канала, не хаб)."""
    low = (blob or '').lower()
    m = re.search(r'vklader\.com/([a-z][a-z0-9_]{3,31})(?:/|\?|$)', low)
    if m and m.group(1).lower() not in _HUB_SLUGS:
        return 2.0
    return 0.0


def _telltrue_net_weight(blob: str) -> float:
    """+2 за источник telltrue.net (упоминание хоста в наводке)."""
    if 'telltrue.net' in (blob or '').lower():
        return 2.0
    return 0.0


def _form_complaint_row_weights(rows: Optional[List[Dict[str, Any]]]) -> float:
    """Жалобы через форму: с описанием = 2, без описания = 1 (на строку)."""
    w = 0.0
    for row in rows or []:
        src = (row.get('source') or '').strip().lower()
        if src != 'form' and not src.endswith('form'):
            continue
        desc = (row.get('description') or '').strip()
        w += 2.0 if desc else 1.0
    return w


def temporal_young_channel_complaints_weight(obj: Dict[str, Any]) -> float:
    """Канал < 90 дн. и уже есть жалобы → +2 (временной красный флаг в сумме весов)."""
    try:
        comp = int(obj.get('complaints') or 0)
    except (TypeError, ValueError):
        comp = 0
    if comp < 1:
        return 0.0
    raw_age = obj.get('channel_age_days')
    if raw_age is None or raw_age == '':
        return 0.0
    try:
        age = int(raw_age)
    except (TypeError, ValueError):
        return 0.0
    if 0 <= age < 90:
        return 2.0
    return 0.0


def _compute_source_weight(
    obj: Dict[str, Any],
    report_rows: Optional[List[Dict[str, Any]]] = None,
) -> float:
    """
    Сумма весов источников:
    stop-scam1.com = 3, fin-obzor.net = 3, vklader.com (страница /slug) = 2, telltrue.net = 2,
    форма: с описанием = 2 / без = 1 на строку; молодой канал (<90 дн.) при жалобах = +2.
    """
    sp = (obj.get('source_primary') or '').strip()
    ev = (obj.get('source_evidence') or '').strip()
    blob = f'{sp} {ev}'.lower()

    w = 0.0
    if 'stop-scam1.com' in blob or 'stop-scam1' in blob:
        w += 3.0
    if 'fin-obzor.net' in blob or 'fin-obzor' in blob:
        w += 3.0

    w += _dedicated_vklader_weight(blob)
    w += _telltrue_net_weight(blob)
    w += _form_complaint_row_weights(report_rows)
    w += temporal_young_channel_complaints_weight(obj)

    return float(w)


def compute_source_weight(
    obj: Dict[str, Any],
    *,
    report_rows: Optional[List[Dict[str, Any]]] = None,
) -> float:
    """Публичный алиас к _compute_source_weight (минимум 3 для записи в scam_base — снаружи)."""
    return _compute_source_weight(obj, report_rows=report_rows)


def source_signal_a_crypto(obj: Dict[str, Any]) -> bool:
    """Сигнал А: крипто-маркеры в тексте наводки (источник/жалобы), не в Telethon-blob."""
    parts = [
        obj.get('source_primary') or '',
        obj.get('source_evidence') or '',
        obj.get('object_type') or '',
        obj.get('complaint_texts_joined') or '',
    ]
    blob = ' '.join(str(p) for p in parts).lower()
    if not blob.strip():
        return False
    return any(term in blob for term in SCAM_BASE_HTTP_CRYPTO_TERMS)


def should_cap_status_reputation(
    obj: Dict[str, Any],
    *,
    http_subs: Optional[int],
    form_complaint_count: int,
) -> bool:
    """
    >10k подписчиков, нет жалоб через форму, единственный след — без подробного описания
    (короткий текст после вырезания URL; без сильных маркеров stop-scam1 / fin-obzor).
    → статус не выше «под наблюдением».
    """
    subs = http_subs
    if subs is None or subs <= 10000:
        return False
    if form_complaint_count and form_complaint_count > 0:
        return False
    sp = (obj.get('source_primary') or '').strip()
    ev = (obj.get('source_evidence') or '').strip()
    blob = f'{sp} {ev}'.lower()
    if 'stop-scam1' in blob or 'fin-obzor' in blob:
        return False
    stripped = re.sub(r'https?://[^\s]+', '', ev, flags=re.I).strip()
    if len(stripped) >= 80:
        return False
    return True


def status_cap_observation_only(status: str) -> str:
    """Потолок «под наблюдением» без суффикса потерь из normalizeRiskStatusByLoss — вызывать до floor по потерям."""
    s = (status or '').strip()
    low = s.lower()
    if 'под наблюдением' in low:
        return s
    return 'под наблюдением'
