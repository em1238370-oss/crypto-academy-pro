#!/usr/bin/env python3
"""
KRO live-check worker: читает очередь check_queue в Google Sheets,
запускает check_once.py (Telethon) для проверки канала,
дописывает результат в scam_base и удаляет задачу из очереди.
Используется одна логика с check_once (реклам/неделя, % ботов).
Запуск: раз в 1–2 минуты (cron или run_worker_loop.sh).
"""
import os
import json
import subprocess
import sys

# Google Sheets
from google.oauth2 import service_account
from googleapiclient.discovery import build

# Директория скрипта — нужна до загрузки env
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _load_env_file():
    """Подгружает переменные из env или .env, чтобы воркер работал при запуске через run_worker_loop.sh без ручного source env."""
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
        return


_load_env_file()

# --- env ---
KRO_SHEET_ID = os.environ.get('KRO_SHEET_ID', '')
KRO_QUEUE_RANGE = os.environ.get('KRO_CHECK_QUEUE_RANGE', 'check_queue!A2:B')
KRO_SCAM_BASE_RANGE = os.environ.get('KRO_SCAM_BASE_RANGE', 'scam_base!A2:H')
QUEUE_SHEET_NAME = KRO_QUEUE_RANGE.split('!')[0] if '!' in KRO_QUEUE_RANGE else 'check_queue'
SCAM_BASE_SHEET_NAME = KRO_SCAM_BASE_RANGE.split('!')[0] if '!' in KRO_SCAM_BASE_RANGE else 'scam_base'

# Директория скрипта (там же check_once.py и сессия Telethon)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def get_sheets_client():
    creds = None
    json_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
    json_str = os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON')
    if json_str:
        creds = service_account.Credentials.from_service_account_info(json.loads(json_str))
    elif json_path and os.path.isfile(json_path):
        creds = service_account.Credentials.from_service_account_file(json_path)
    if not creds:
        return None
    return build('sheets', 'v4', credentials=creds)


def queue_range_data_only():
    part = KRO_QUEUE_RANGE.split('!')[-1]
    return f'{QUEUE_SHEET_NAME}!{part}'


def scam_base_append_range():
    return f'{SCAM_BASE_SHEET_NAME}!A:H'


def run_check_once(channel_id):
    """Запускает check_once.py, возвращает распарсенный JSON или None."""
    env = {**os.environ}
    try:
        proc = subprocess.run(
            [sys.executable, os.path.join(SCRIPT_DIR, 'check_once.py'), channel_id],
            cwd=SCRIPT_DIR,
            capture_output=True,
            text=True,
            timeout=90,
            env=env
        )
        for line in (proc.stdout or '').splitlines():
            line = line.strip()
            if line.startswith('{'):
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    continue
    except subprocess.TimeoutExpired:
        return None
    except Exception as e:
        print('check_once run error:', e, file=sys.stderr)
        return None
    return None


def run_worker_once():
    if not KRO_SHEET_ID or not KRO_QUEUE_RANGE or not KRO_SCAM_BASE_RANGE:
        print('KRO_SHEET_ID, KRO_CHECK_QUEUE_RANGE, KRO_SCAM_BASE_RANGE required', file=sys.stderr)
        return
    if not os.environ.get('TELEGRAM_API_ID') or not os.environ.get('TELEGRAM_API_HASH'):
        print('TELEGRAM_API_ID and TELEGRAM_API_HASH required for live check', file=sys.stderr)
        return

    sheets = get_sheets_client()
    if not sheets:
        json_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS', '')
        json_set = bool(os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON', '').strip())
        print('Google Sheets credentials not found.', file=sys.stderr)
        if json_path:
            exists = 'да' if os.path.isfile(json_path) else 'нет (файл не найден)'
            print('  GOOGLE_APPLICATION_CREDENTIALS =', json_path, '— файл существует:', exists, file=sys.stderr)
        else:
            print('  GOOGLE_APPLICATION_CREDENTIALS не задан.', file=sys.stderr)
        if not json_set and not (json_path and os.path.isfile(json_path)):
            print('  KRO_GOOGLE_CREDENTIALS_JSON не задан или пустой.', file=sys.stderr)
        print('  Проверь файл env в папке', SCRIPT_DIR, file=sys.stderr)
        return

    try:
        result = sheets.spreadsheets().values().get(
            spreadsheetId=KRO_SHEET_ID,
            range=KRO_QUEUE_RANGE
        ).execute()
        rows = result.get('values', [])
    except Exception as e:
        print('Queue read error:', e, file=sys.stderr)
        return

    if not rows:
        return

    channel_id = (rows[0][0] or '').strip()
    if not channel_id:
        remaining = rows[1:]
        if remaining:
            try:
                sheets.spreadsheets().values().update(
                    spreadsheetId=KRO_SHEET_ID,
                    range=queue_range_data_only(),
                    valueInputOption='USER_ENTERED',
                    body={'values': remaining}
                ).execute()
            except Exception as e:
                print('Queue update error:', e, file=sys.stderr)
        return

    parsed = run_check_once(channel_id)

    if parsed and parsed.get('found') and (parsed.get('risk_score') is not None or parsed.get('verdict')):
        # check_once.py уже дописал в scam_base
        row_data = None
    else:
        # Канал не найден или ошибка — пишем заглушку, чтобы при повторном «Проверить» пользователь увидел запись
        row_data = [
            channel_id,
            0,
            0,
            '—',
            '—',
            '—',
            '—',
            'unknown'
        ]
        try:
            sheets.spreadsheets().values().append(
                spreadsheetId=KRO_SHEET_ID,
                range=scam_base_append_range(),
                valueInputOption='USER_ENTERED',
                insertDataOption='INSERT_ROWS',
                body={'values': [row_data]}
            ).execute()
        except Exception as e:
            print('Scam base append error:', e, file=sys.stderr)
            return

    remaining = rows[1:]
    try:
        if remaining:
            sheets.spreadsheets().values().update(
                spreadsheetId=KRO_SHEET_ID,
                range=queue_range_data_only(),
                valueInputOption='USER_ENTERED',
                body={'values': remaining}
            ).execute()
        else:
            first_row_range = f'{QUEUE_SHEET_NAME}!A2:B2'
            sheets.spreadsheets().values().clear(
                spreadsheetId=KRO_SHEET_ID,
                range=first_row_range
            ).execute()
    except Exception as e:
        print('Queue update error:', e, file=sys.stderr)

    verdict = (parsed.get('verdict') if parsed else None) or 'unknown'
    print('Processed:', channel_id, '->', verdict)


if __name__ == '__main__':
    run_worker_once()
