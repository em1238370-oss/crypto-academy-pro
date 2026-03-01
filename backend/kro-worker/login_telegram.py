#!/usr/bin/env python3
"""
Один раз запусти этот скрипт, введи номер и КОД ИЗ ПРИЛОЖЕНИЯ TELEGRAM.
Код приходит в сам Telegram (чаты или «Вход в Telegram») — обычно 5 цифр.
"""
import os
import asyncio

# Берём ключи из .env в корне проекта или из переменных окружения
env_path = os.path.join(os.path.dirname(__file__), '..', '..', '.env')
if os.path.isfile(env_path):
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, _, v = line.partition('=')
                k, v = k.strip(), v.strip()
                if k in ('TELEGRAM_API_ID', 'TELEGRAM_API_HASH') and k not in os.environ:
                    os.environ[k] = v

api_id = int(os.environ.get('TELEGRAM_API_ID', '0'))
api_hash = os.environ.get('TELEGRAM_API_HASH', '')
if not api_id or not api_hash:
    print('Ошибка: задай TELEGRAM_API_ID и TELEGRAM_API_HASH в .env в корне проекта.')
    exit(1)

from telethon import TelegramClient

async def main():
    print()
    print('Код приходит ТОЛЬКО в приложение Telegram (не в SMS). Куда смотреть:')
    print('  1. Телефон: открой приложение Telegram — код может появиться всплывающим окном.')
    print('  2. Чат «Telegram» в списке чатов (самый первый) — открой его и посмотри сообщение с цифрами.')
    print('  3. Если Telegram открыт на планшете или втором телефоне — зайди туда, код мог прийти туда.')
    print('  4. На Mac: если установлен Telegram Desktop — открой его, иногда код приходит туда.')
    print()
    print('Если код не пришёл за 2–3 минуты: закрой и снова открой Telegram на телефоне и запусти этот скрипт заново (новый код придёт).')
    print()
    client = TelegramClient('kro_worker', api_id, api_hash)
    await client.start()
    print()
    print('Готово! Сессия сохранена. Больше ничего вводить не нужно.')

if __name__ == '__main__':
    asyncio.run(main())
