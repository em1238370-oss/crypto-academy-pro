# -*- coding: utf-8 -*-
"""
Red flags по типу объекта KRO: чёткие текстовые маркеры в корпусе постов / выдачи поиска.
Чем больше сработавших флагов — тем выше риск (см. scoring в run_12h_monitor).
"""

from __future__ import annotations

import re


def _lower(s):
    return (s or "").lower()


def _any(haystack, needles):
    return any(n in haystack for n in needles)


# --- сигнал-канал (Telegram): маркетинг и скрытие рисков ---
SIGNAL_RED_FLAGS = (
    (
        "гарантия дохода / без риска / 100%",
        (
            "гарантир",
            "гарантируем доход",
            "гарантированн",
            "стабильный доход",
            "доход без риска",
            "без риска",
            "no risk",
            "risk free",
            "100%",
            "безубыточн",
            "не теряешь",
        ),
    ),
    (
        "VIP доступ за деньги",
        (
            "vip за",
            "вип за",
            "платный vip",
            "vip доступ",
            "вступить в vip",
            "оплата vip",
            "подписка за",
            "закрытый клуб",
            "закрытый канал",
            "платный доступ",
            "usdt за доступ",
            "оплата в usdt",
        ),
    ),
    (
        "только прибыльные сделки без убытков",
        (
            "только в плюс",
            "без убытков",
            "без минусов",
            "one way profit",
            "only profit",
            "без лос",
            "безloss",
        ),
    ),
    (
        "давление срочностью",
        (
            "срочно",
            "urgent",
            "успей",
            "последний шанс",
            "только сегодня",
            "осталось мест",
            "ограниченное время",
            "не упусти",
            "закрыт набор",
            "скидка только",
        ),
    ),
)

# --- крипто-обменник: типичные схемы ---
EXCHANGER_RED_FLAGS = (
    (
        "обещает спред выше 5%",
        (
            "спред",
            "spread",
            "% выше рынка",
            "курс лучше",
            "выгодный курс",
            "9%",
            "10%",
            "12%",
            "15%",
            "выше бирж",
            "премиум курс",
        ),
    ),
    (
        "требует доплату для вывода средств",
        (
            "доплат",
            "комиссия за вывод",
            "разблокировк вывод",
            "чтобы вывести нужно",
            "оплатите для вывода",
            "verification fee",
            "release fee",
            "additional payment to withdraw",
        ),
    ),
    (
        "AML-блокировка как предлог",
        (
            "aml",
            "aml-провер",
            "aml провер",
            "заморозк по aml",
            "блокировка aml",
            "антимониторинг",
            "compliance fee",
            "разблокировка счета",
        ),
    ),
    (
        "домен зарегистрирован недавно (по текстам)",
        (
            "свежий домен",
            "недавно зарегистрирован",
            "зарегистрирован менее",
            "моложе 3 месяцев",
            "моложе трёх месяцев",
            "newly registered",
            "recently registered domain",
            "domain age",
            "creation date",
        ),
    ),
    (
        "нет реальных контактов / юр. данных (по отзывам)",
        (
            "нет контактов",
            "контакты не указаны",
            "нет адреса",
            "нет телефона",
            "анонимн",
            "неизвестен владелец",
            "no company details",
            "fake company",
        ),
    ),
)

# --- инвест-бот ---
INVEST_BOT_RED_FLAGS = (
    (
        "обещает % в день автоматически",
        (
            "% в день",
            "процент в день",
            "в день доход",
            "ежедневн",
            "автоматическ",
            "автодоход",
            "passive income daily",
            "per day profit",
            "1% per day",
            "2% per day",
            "3% daily",
        ),
    ),
    (
        "требует пополнить депозит для активации",
        (
            "пополните депозит",
            "пополнить счет для активац",
            "активац аккаунта",
            "минимальное пополнение",
            "депозит для старта",
            "fund your account to activate",
            "activation deposit",
        ),
    ),
    (
        "блокирует вывод под предлогом верификации",
        (
            "верификац",
            "kyc",
            "документы для вывода",
            "подтвердите личность для вывода",
            "withdrawal pending verification",
            "verify to withdraw",
        ),
    ),
    (
        "анонимный создатель",
        (
            "анонимн админ",
            "неизвестен создатель",
            "who is admin",
            "anonymous team",
            "скрыт владелец",
        ),
    ),
    (
        "рекламируется в скам-каналах (по тексту)",
        (
            "реклама в скам",
            "рекламировали в канале",
            "разводной канал",
            "скам канал реклам",
            "реклама мошенник",
            "promoted in scam channel",
        ),
    ),
)


def _labels_from_groups(groups, corpus_lower):
    out = []
    for label, needles in groups:
        if _any(corpus_lower, needles):
            out.append(label)
    return out


def signal_channel_red_flag_labels(corpus: str, *, only_profit_posts: bool = False) -> list:
    """Корпус — склеенные тексты постов в lower."""
    lo = _lower(corpus)
    labels = _labels_from_groups(SIGNAL_RED_FLAGS, lo)
    if only_profit_posts:
        extra = "только прибыльные сделки без убытков"
        if extra not in labels:
            labels.append(extra)
    seen = set()
    out = []
    for L in labels:
        if L not in seen:
            seen.add(L)
            out.append(L)
    return out


def exchanger_red_flag_labels(corpus: str) -> list:
    lo = _lower(corpus)
    labels = _labels_from_groups(EXCHANGER_RED_FLAGS, lo)
    # Спред: отдельно ловим «6%»..«99%» рядом с «спред|курс|выгод»
    if "спред" in lo or "spread" in lo or "курс" in lo:
        if re.search(r"\b([6-9]|[1-9]\d)\s*%", lo):
            hit = "обещает спред выше 5%"
            if hit not in labels:
                labels.append(hit)
    return labels


def invest_bot_red_flag_labels(corpus: str) -> list:
    return _labels_from_groups(INVEST_BOT_RED_FLAGS, _lower(corpus))


def all_red_flags_by_type(
    corpus: str, *, only_profit_posts: bool = False
) -> dict:
    """Для JSON в content_analysis: все три набора по одному корпусу."""
    return {
        "сигнал-канал": signal_channel_red_flag_labels(
            corpus, only_profit_posts=only_profit_posts
        ),
        "крипто-обменник": exchanger_red_flag_labels(corpus),
        "инвест-бот": invest_bot_red_flag_labels(corpus),
    }


def object_type_red_flag_key(object_type: str) -> str:
    t = (object_type or "").strip().lower()
    if "обменник" in t:
        return "крипто-обменник"
    if "инвест" in t and "бот" in t:
        return "инвест-бот"
    return "сигнал-канал"
