# -*- coding: utf-8 -*-
"""
Веса источников и качество жалоб для записи в scam_base (аналитический слой поверх сырых данных).
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from kro_tme_http_gate import SCAM_BASE_HTTP_CRYPTO_TERMS

# Хабы vklader/telltrue — не считать «страницей канала»
_HUB_SLUGS = frozenset({
    'blacklist-telegram', 'proverka-telegram', 'wp-admin', 'feed', 'category', 'author', 'page', 'tag',
})


def score_complaint_quality(text: str) -> float:
    """
    1.0 — слабая жалоба; до 2.0 — сильная (суммы, схема, действие мошенника, длина).
    """
    t = (text or '').strip()
    if not t:
        return 1.0
    low = t.lower()
    score = 1.0
    if len(t) > 100:
        score += 0.5
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
    return min(2.0, score)


def _dedicated_listing_weight_from_blob(blob: str) -> float:
    """+2 за URL вида vklader.com/slug или telltrue.net/slug (каждый хост до +2)."""
    low = (blob or '').lower()
    w = 0.0
    m = re.search(r'vklader\.com/([a-z][a-z0-9_]{3,31})(?:/|\?|$)', low)
    if m and m.group(1).lower() not in _HUB_SLUGS:
        w += 2.0
    m2 = re.search(r'telltrue\.net/([a-z][a-z0-9_]{3,31})(?:/|\?|$)', low)
    if m2 and m2.group(1).lower() not in _HUB_SLUGS:
        w += 2.0
    return w


def _form_and_web_report_weights(rows: Optional[List[Dict[str, Any]]]) -> float:
    w = 0.0
    for row in rows or []:
        src = (row.get('source') or '').strip().lower()
        desc = (row.get('description') or '').strip()
        if src == 'form' or src.endswith('form'):
            if len(desc) < 12:
                w += 1.0
            else:
                w += min(2.0, score_complaint_quality(desc))
        elif src == 'web':
            # веб-строка без отдельного URL в маркерах — минимальный вклад
            if len(desc) > 40:
                w += min(2.0, max(1.0, score_complaint_quality(desc) * 0.75))
    return w


def temporal_young_channel_complaints_weight(obj: Dict[str, Any]) -> float:
    """Канал < 90 дн. и уже есть жалобы → +2 к суммарному весу."""
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


def compute_source_weight(
    obj: Dict[str, Any],
    *,
    report_rows: Optional[List[Dict[str, Any]]] = None,
) -> float:
    """
    Суммарный вес источников для канала. Запись в scam_base — при сумме >= 3 (вызывающая сторона проверяет).
    """
    sp = (obj.get('source_primary') or '').strip()
    ev = (obj.get('source_evidence') or '').strip()
    blob = f'{sp} {ev}'.lower()

    w = 0.0
    if 'stop-scam1.com' in blob or 'stop-scam1' in blob:
        w += 3.0
    if 'fin-obzor.net' in blob or 'fin-obzor' in blob:
        w += 3.0

    w += _dedicated_listing_weight_from_blob(sp + ' ' + ev)

    w += _form_and_web_report_weights(report_rows)

    w += temporal_young_channel_complaints_weight(obj)

    return float(w)


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


def evidence_is_thin_vklader_telltrue_only(obj: Dict[str, Any]) -> bool:
    """Только vklader/telltrue в полях, без развёрнутого текста доказательств."""
    sp = (obj.get('source_primary') or '').lower()
    ev = (obj.get('source_evidence') or '').strip()
    blob = f'{sp} {ev}'.lower()
    if 'vklader.com' not in blob and 'telltrue.net' not in blob:
        return False
    if 'stop-scam1' in blob or 'fin-obzor' in blob:
        return False
    # «Подробно»: не только URL — есть осмысленный текст кроме ссылок
    stripped = re.sub(r'https?://[^\s]+', '', ev, flags=re.I).strip()
    return len(stripped) < 80


def should_cap_status_reputation(
    obj: Dict[str, Any],
    *,
    http_subs: Optional[int],
    form_complaint_count: int,
) -> bool:
    """
    >10k подписчиков, нет жалоб формы, единственный след — vklader/telltrue с коротким evidence.
    """
    subs = http_subs
    if subs is None or subs <= 10000:
        return False
    if form_complaint_count and form_complaint_count > 0:
        return False
    return evidence_is_thin_vklader_telltrue_only(obj)


def status_cap_observation_only(status: str) -> str:
    """Потолок «под наблюдением» без суффикса потерь из normalizeRiskStatusByLoss — вызывать до floor по потерям."""
    s = (status or '').strip()
    low = s.lower()
    if 'под наблюдением' in low:
        return s
    return 'под наблюдением'
