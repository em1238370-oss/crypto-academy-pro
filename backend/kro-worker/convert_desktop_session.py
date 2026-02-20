#!/usr/bin/env python3
"""
Конвертация сессии из Telegram Desktop в формат Telethon (kro_worker.session).
Код вводить не нужно — используется уже авторизованный Telegram Desktop.

Требования:
  - Telegram Desktop установлен и ты в нём уже залогинена.
  - pip install opentele (уже в requirements.txt).

Запуск:
  cd backend/kro-worker
  source venv/bin/activate
  set -a && source env && set +a   # или: python3 run_with_env.py не нужен, только env для API_ID/HASH
  python3 convert_desktop_session.py

После успеха появится файл kro_worker.session — тогда можно запускать run_with_env.py и воркер.
"""
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Загружаем env из файла env или .env
def load_env():
    for name in ('env', '.env'):
        path = os.path.join(SCRIPT_DIR, name)
        if not os.path.isfile(path):
            continue
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                key, value = key.strip(), value.strip()
                if (value.startswith("'") and value.endswith("'")) or (value.startswith('"') and value.endswith('"')):
                    value = value[1:-1]
                if key:
                    os.environ[key] = value
        return True
    return False


def main():
    if not load_env():
        print('Файл env или .env не найден. Создай env в папке', SCRIPT_DIR, file=sys.stderr)
        sys.exit(1)

    api_id_raw = (os.environ.get('TELEGRAM_API_ID') or '').strip()
    api_hash = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
    session_name = (os.environ.get('TELEGRAM_SESSION_NAME') or 'kro_worker').strip()

    if not api_id_raw.isdigit() or not api_hash:
        print('В env нужны TELEGRAM_API_ID и TELEGRAM_API_HASH.', file=sys.stderr)
        sys.exit(1)

    api_id = int(api_id_raw)

    # Путь к tdata на macOS (Telegram Desktop)
    home = os.path.expanduser('~')
    tdata_default = os.path.join(home, 'Library', 'Application Support', 'Telegram Desktop', 'tdata')
    tdata_path = os.environ.get('TDATA_PATH', tdata_default)

    if not os.path.isdir(tdata_path):
        print('Папка tdata не найдена:', tdata_path, file=sys.stderr)
        print('Убедись, что Telegram Desktop установлен и ты в нём залогинена.', file=sys.stderr)
        print('Если tdata в другом месте, задай: export TDATA_PATH=/путь/к/tdata', file=sys.stderr)
        sys.exit(1)

    try:
        from opentele.td import TDesktop
        from opentele.tl import TelegramClient
        from opentele.api import UseCurrentSession, API
        import asyncio
    except ImportError as e:
        print('Установи opentele: pip install opentele', file=sys.stderr)
        sys.exit(1)

    # UseCurrentSession требует тот же API, что и Telegram Desktop (tdata). Используем официальный API.TelegramDesktop.
    # Итоговая сессия будет работать с нашим api_id/api_hash в check_once — Telethon подставляет их при подключении.
    session_path = os.path.join(SCRIPT_DIR, session_name + '.session')
    api = API.TelegramDesktop.Generate(system='macos', unique_id=session_name)

    async def run():
        tdesk = TDesktop(tdata_path, api=api)
        if not tdesk.isLoaded():
            print('В tdata нет залогиненного аккаунта. Войди в Telegram Desktop и попробуй снова.', file=sys.stderr)
            sys.exit(1)
        client = await tdesk.ToTelethon(session_path, UseCurrentSession, api)
        await client.connect()
        me = await client.get_me()
        print('Готово. Сессия сохранена:', session_path)
        print('Аккаунт:', me.phone or me.username or me.id)
        await client.disconnect()

    asyncio.run(run())
    print('Теперь можно запускать: python3 run_with_env.py @durov  и  ./run_worker_loop.sh')


if __name__ == '__main__':
    main()
