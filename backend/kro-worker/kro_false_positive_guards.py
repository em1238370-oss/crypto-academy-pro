# -*- coding: utf-8 -*-
"""
Глобальные исключения для KRO: официальные платформы, экосистема Telegram,
маркетплейс Poizon (одежда/кроссовки — не крипто-скам).

Используется в run_12h_monitor, web_scraper, check_once; паритет с server.js (KRO_CHANNEL_EXCLUSION).

Профилактика ложных каналов: один источник правды — kro_permanent_blocklist.json + этот модуль;
парсер (web_scraper) не должен считать обвиняемым @ в теле статьи без «шапки»;
запись в scam_base только с маркером разоблачителя в агрегате; публичный API (server.js)
фильтрует те же ключи; после цикла CI удаляет хвосты из листа (kro-remove … --from-permanent-blocklist).
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
