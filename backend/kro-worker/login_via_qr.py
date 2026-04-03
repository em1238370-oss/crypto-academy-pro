#!/usr/bin/env python3
"""
Вход в Telegram по QR-коду. Код в приложении не нужен.

1. Запусти скрипт (env уже подгружен).
2. Откроется окно с QR-кодом.
3. В Telegram на телефоне: Настройки → Устройства → Подключить устройство → отсканируй QR.
4. Готово — сессия сохранится как kro_worker.session.

Запуск:
  cd backend/kro-worker
  source venv/bin/activate
  set -a && source env && set +a
  python3 login_via_qr.py
"""
import asyncio
import getpass
import os
import shlex
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _apply_env_file(path: str) -> None:
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, value = line.partition('=')
            key, value = key.strip(), value.strip()
            if not key:
                continue
            if (value.startswith("'") and value.endswith("'")) or (value.startswith('"') and value.endswith('"')):
                value = value[1:-1]
            if not value.strip():
                continue
            os.environ[key] = value.strip()


def load_env():
    """Корень репозитория .env, затем env и .env в kro-worker (непустые значения перекрывают)."""
    repo_root = os.path.normpath(os.path.join(SCRIPT_DIR, '..', '..'))
    paths = [
        os.path.join(repo_root, '.env'),
        os.path.join(SCRIPT_DIR, 'env'),
        os.path.join(SCRIPT_DIR, '.env'),
    ]
    found = False
    for path in paths:
        if os.path.isfile(path):
            _apply_env_file(path)
            found = True
    return found


async def main():
    if not load_env():
        print('Файл env или .env не найден в', SCRIPT_DIR, file=sys.stderr)
        sys.exit(1)

    api_id_raw = (os.environ.get('TELEGRAM_API_ID') or '').strip()
    api_hash = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
    session_name = (os.environ.get('TELEGRAM_SESSION_NAME') or 'kro_worker').strip()

    if not api_id_raw.isdigit() or not api_hash:
        print('В env нужны TELEGRAM_API_ID и TELEGRAM_API_HASH.', file=sys.stderr)
        sys.exit(1)

    api_id = int(api_id_raw)
    session_path = os.path.join(SCRIPT_DIR, session_name)

    from telethon import TelegramClient
    from telethon.errors import PasswordHashInvalidError, SessionPasswordNeededError

    client = TelegramClient(session_path, api_id, api_hash)

    await client.connect()
    if await client.is_user_authorized():
        me = await client.get_me()
        print('Уже авторизован:', me.phone or me.username or me.id)
        await client.disconnect()
        print('Сессия:', session_path + '.session')
        return

    try:
        qr_login = await client.qr_login()
    except Exception as e:
        print('Ошибка запроса QR:', e, file=sys.stderr)
        await client.disconnect()
        sys.exit(1)

    # Показать QR: сохраняем в файл и открываем окном
    try:
        import qrcode
        img = qrcode.make(qr_login.url)
        qr_file = os.path.join(SCRIPT_DIR, 'kro_qr_login.png')
        img.save(qr_file)
        if sys.platform == 'darwin':
            os.system('open ' + repr(qr_file))
        elif sys.platform == 'win32':
            os.startfile(qr_file)
        else:
            os.system('xdg-open ' + repr(qr_file) + ' 2>/dev/null || true')
        print('Открыто окно с QR-кодом.')
    except Exception as e:
        print('Ссылка для входа (открой в Telegram на телефоне):', qr_login.url[:80] + '...', file=sys.stderr)
        print('Или установи: pip install qrcode[pil]', file=sys.stderr)

    print('В Telegram на телефоне: Настройки → Устройства → Подключить устройство → отсканируй QR.')
    print('Ожидание сканирования (QR действует около 30 сек)...')

    try:
        user = await qr_login.wait()
        print('Вход выполнен:', user.phone or user.username or user.id)
    except SessionPasswordNeededError:
        print(
            'Нужен облачный пароль Telegram (Настройки → Конфиденциальность → Двухэтапная аутентификация). '
            'Это НЕ пароль от Mac.',
            file=sys.stderr,
        )
        for attempt in range(1, 4):
            pwd = getpass.getpass('Пароль 2FA (попытка %d/3): ' % attempt)
            try:
                await client.sign_in(password=pwd)
                print('Вход выполнен.')
                break
            except PasswordHashInvalidError:
                print('Telegram отклонил пароль — неверный или опечатка.', file=sys.stderr)
                if attempt >= 3:
                    print(
                        'Удалите файл сессии и начните снова: rm -f '
                        + shlex.quote(session_path + '.session'),
                        file=sys.stderr,
                    )
                    print('Восстановление пароля 2FA — в том же разделе настроек Telegram (часто через e-mail).', file=sys.stderr)
                    await client.disconnect()
                    sys.exit(1)
    except asyncio.TimeoutError:
        print('Время вышло. Запусти скрипт снова и отсканируй QR быстрее.', file=sys.stderr)
        await client.disconnect()
        sys.exit(1)
    except Exception as e:
        print('Ошибка:', e, file=sys.stderr)
        await client.disconnect()
        sys.exit(1)

    await client.disconnect()
    print('Сессия сохранена:', session_path + '.session')
    print('Дальше: python3 run_with_env.py @durov  и  ./run_worker_loop.sh')


if __name__ == '__main__':
    asyncio.run(main())
