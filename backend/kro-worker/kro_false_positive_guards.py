# -*- coding: utf-8 -*-
"""
Глобальные исключения для KRO: официальные платформы, экосистема Telegram,
маркетплейс Poizon (одежда/кроссовки — не крипто-скам).

Используется в run_12h_monitor, web_scraper, check_once; паритет с server.js (KRO_CHANNEL_EXCLUSION).

Почему раньше появлялись «чужие» каналы в scam_base и как не допускать повторения
---------------------------------------------------------------------------
1) Парсинг статей без контекста — в тексте рядом с «мошенник» попадали @telegram,
   @proton и т.д. как «каналы». Лечение: web_scraper (шапка статьи / первый абзац),
   should_never_scam_base_norm_key, blocklist.

2) Жалобы только из формы без URL разоблачителя — порог «2 жалобы» тянул левые темы.
   Лечение: в scam_base только при маркере сайта-разоблачителя; вес источников.

3) Poizon / одежда — отдельная вертикаль, не крипто-скам. Лечение: префикс poizon*,
   off_topic по HTML t.me, blocklist для известных slug.

4) Устаревшие строки оставались в Google Sheets, пока API начал их скрывать.
   Лечение: prune_scam_base_blocklist_rows каждый цикл + kro-prune-scam-base-html.py.

5) Дубликаты строк на листе. Лечение: дедуп при записи + dedupe в API + чистка.
"""
from __future__ import annotations

# Username в нижнем регистре без @ — как после _norm_ch_key для t.me
OFFICIAL_PLATFORM_USERNAMES = frozenset({
    # Telegram / TON
    'telegram', 'durov', 'toncoin', 'fragment', 'wallet',
    # Крупные платформы (никогда не считать «скам-каналом» по совпадению username)
    'instagram', 'tiktok', 'youtube', 'vk', 'ok',
    'proton',  # Proton Mail / VPN — не крипто-скам по упоминанию в статьях
    'whatsapp', 'viber', 'signal', 'discord', 'reddit',
    'twitter', 'x', 'facebook', 'meta',
    'google', 'apple', 'microsoft', 'amazon',
    'alibaba', 'aliexpress', 'wildberries', 'ozon',
    'avito', 'sbermegamarket',
})


def should_never_scam_base_norm_key(norm_key: str) -> bool:
    """
    True — канал не должен попадать в scam_base / reports web pipeline / промо,
    даже при жалобах на разоблачителях (официальный @telegram, Poizon и т.д.).
    norm_key: результат _norm_ch_key (@name / t.me → нижний slug).
    """
    k = (norm_key or '').strip().lower()
    if not k:
        return False
    if k.startswith('poizon'):
        return True
    if k in OFFICIAL_PLATFORM_USERNAMES:
        return True
    return False
