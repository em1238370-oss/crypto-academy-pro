#!/usr/bin/env python3
"""
KRO Telegram Bot: проверка канала по API бэкенда.
Команды: /check @username, /report
"""
import os
import requests

try:
    import telebot
except ImportError:
    raise SystemExit("Install: pip install pyTelegramBotAPI requests")

BOT_TOKEN = os.environ.get("KRO_BOT_TOKEN") or os.environ.get("BOT_TOKEN")
KRO_API_URL = (os.environ.get("KRO_API_URL") or "http://localhost:4000").rstrip("/")

if not BOT_TOKEN:
    raise SystemExit("Set KRO_BOT_TOKEN or BOT_TOKEN")

bot = telebot.TeleBot(BOT_TOKEN)


def normalize_channel(text):
    s = (text or "").strip().replace(" ", "")
    if not s:
        return ""
    return s if s.startswith("@") else "@" + s


@bot.message_handler(commands=["check"])
def check_channel(message):
    text = (message.text or "").strip()
    parts = text.split(maxsplit=1)
    channel = normalize_channel(parts[1] if len(parts) > 1 else "")
    if not channel:
        bot.reply_to(
            message,
            "Укажи канал: /check @username\nПример: /check @TONPumpKing",
        )
        return
    try:
        r = requests.get(
            f"{KRO_API_URL}/api/kro/check",
            params={"channel": channel},
            timeout=10,
        )
        data = r.json() if r.ok else {}
    except Exception as e:
        bot.reply_to(message, f"Ошибка запроса к API: {e}")
        return
    if not data.get("found"):
        bot.reply_to(
            message,
            f"Канал {channel} не найден в базе.\nНапиши /report чтобы отправить жалобу.",
        )
        return
    risk = data.get("risk_score")
    if risk is None:
        risk_str = "—"
    else:
        risk_str = f"{risk}/100"
    if risk is not None:
        if risk < 30:
            verdict_emoji = "🟢 Низкий"
        elif risk < 70:
            verdict_emoji = "🟡 Средний"
        else:
            verdict_emoji = "🔴 Высокий"
    else:
        verdict_emoji = data.get("verdict") or "—"
    ads = data.get("ads_per_week")
    ads_str = str(ads) if ads is not None else (data.get("ads_per_week") or "—")
    bot_pct = data.get("bot_pct") or "—"
    vip = data.get("vip_price") or "—"
    complaints = data.get("complaints")
    complaints_str = str(complaints) if complaints is not None else "—"
    total_loss = data.get("total_loss") or "—"
    verdict = data.get("verdictText") or data.get("verdict") or "—"
    reply = f"""🔍 АНАЛИЗ {data.get('username', channel)}
Риск: {risk_str} ({verdict_emoji})
📢 Реклама: {ads_str}/нед
🤖 Боты: {bot_pct}
💸 Жалобы: {complaints_str} чел, {total_loss}
📊 Вердикт: {verdict}"""
    bot.reply_to(message, reply)


@bot.message_handler(commands=["new"])
def new_scams(message):
    data = _get_live_counter()
    channels_today = data.get("channelsToday", 0)
    total_lost = data.get("totalLost", 0)
    top3 = data.get("top3") or []
    total_str = _format_sum(total_lost)
    lines = [
        f"🔴 НОВЫЕ СКАМЫ за сегодня",
        f"Каналов: {channels_today}",
        f"Потери: {total_str}",
    ]
    if top3:
        lines.append("Топ-3 по сумме:")
        for i, row in enumerate(top3, 1):
            ch = row.get("channel", "—")
            s = row.get("sum", 0)
            st = row.get("status", "—")
            lines.append(f"  {i}. {ch} → {_format_sum(s)} → {st}")
    bot.reply_to(message, "\n".join(lines))


@bot.message_handler(commands=["report"])
def report_cmd(message):
    text = (message.text or "").strip()
    parts = text.split(maxsplit=2)[1:] if len(text.split()) > 1 else []
    channel = ""
    sum_rub = None
    if len(parts) >= 1:
        channel = normalize_channel(parts[0])
    if len(parts) >= 2:
        raw = re.sub(r"[\s\u00a0,]", "", parts[1])
        try:
            sum_rub = int(raw)
        except ValueError:
            pass
    if not channel:
        bot.reply_to(
            message,
            "Укажи канал и сумму: /report @username 50000\n"
            "Пример: /report @ScamChannel 50000",
        )
        return
    if sum_rub is None or sum_rub < 0:
        bot.reply_to(
            message,
            "Укажи сумму потерь числом: /report @username 50000",
        )
        return
    try:
        r = requests.post(
            f"{KRO_API_URL}/api/kro/report-scam",
            json={"channel": channel, "sumRub": sum_rub, "from": "telegram"},
            timeout=10,
        )
        if r.ok and (r.json() or {}).get("ok"):
            bot.reply_to(message, "✅ Жалоба добавлена в базу. Спасибо.")
        else:
            j = r.json() if r.ok else {}
            err = j.get("error", "Ошибка сервера")
            bot.reply_to(message, f"Не удалось добавить: {err}")
    except Exception as e:
        bot.reply_to(message, f"Ошибка запроса: {e}")


@bot.message_handler(commands=["stats"])
def stats_cmd(message):
    data = _get_live_counter()
    channels_today = data.get("channelsToday", 0)
    total_lost = data.get("totalLost", 0)
    telegram_count = data.get("telegramCount", 0)
    courses_count = data.get("coursesCount", 0)
    total_str = _format_sum(total_lost)
    bot.reply_to(
        message,
        f"📊 Статистика\n"
        f"За сегодня: {channels_today} каналов, потери {total_str}\n"
        f"Всего TG-каналов в базе: {telegram_count}\n"
        f"Курсы/фейк-продукты: {courses_count}",
    )


@bot.message_handler(commands=["start", "help"])
def start(message):
    bot.reply_to(
        message,
        "Проверка крипто-каналов на риск.\n\n"
        "/check @username — проверить канал\n"
        "/report @username сумма — отправить жалобу\n"
        "/new — свежие скамы за день\n"
        "/stats — общая статистика",
    )


if __name__ == "__main__":
    bot.infinity_polling()
