#!/usr/bin/env python3
"""
Загружает переменные из файла env или .env и запускает check_once.py.
Использование: python3 run_with_env.py @username
Так не нужно вручную делать source env — и JSON в env не ломает shell.
"""
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def load_env_file(path):
    if not os.path.isfile(path):
        return False
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' not in line:
                continue
            key, _, value = line.partition('=')
            key = key.strip()
            value = value.strip()
            if key:
                if (value.startswith("'") and value.endswith("'")) or (value.startswith('"') and value.endswith('"')):
                    value = value[1:-1]
                os.environ[key] = value
    return True


def main():
    for name in ('env', '.env'):
        if load_env_file(os.path.join(SCRIPT_DIR, name)):
            break
    else:
        print('Файл env или .env не найден в', SCRIPT_DIR, file=sys.stderr)
        sys.exit(1)

    # Запуск check_once.py с текущим окружением
    import subprocess
    result = subprocess.run(
        [sys.executable, os.path.join(SCRIPT_DIR, 'check_once.py')] + sys.argv[1:],
        cwd=SCRIPT_DIR,
        env=os.environ,
    )
    sys.exit(result.returncode)


if __name__ == '__main__':
    main()
