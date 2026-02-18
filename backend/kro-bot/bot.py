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
    verdict = data.get("verdict") or "—"
    reply = f"""🔍 АНАЛИЗ {data.get('username', channel)}
Риск: {risk_str} ({verdict_emoji})
📢 Реклама: {ads_str}/нед
🤖 Боты: {bot_pct}
💸 Жалобы: {complaints_str} чел, {total_loss}
📊 Вердикт: {verdict}"""
    bot.reply_to(message, reply)


@bot.message_handler(commands=["report"])
def report_cmd(message):
    bot.reply_to(
        message,
        "Жалобу можно отправить через сайт (форма «Сообщить о разводе»). "
        "Укажи канал и сумму потерь — мы добавим в базу.",
    )


@bot.message_handler(commands=["start", "help"])
def start(message):
    bot.reply_to(
        message,
        "Проверка крипто-каналов на риск.\n\n"
        "/check @username — проверить канал\n"
        "/report — как отправить жалобу",
    )


if __name__ == "__main__":
    bot.infinity_polling()
