#!/usr/bin/env python3
"""
Создаёт лист unconfirmed_results в KRO Google Sheet и выставляет заголовки.

Запуск:
  cd backend/kro-worker
  KRO_UNCONFIRMED_RANGE="unconfirmed_results!A2:K" python3 ensure_unconfirmed_sheet.py
"""
import json
import os
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build


SCRIPT_DIR = Path(__file__).resolve().parent


def load_env():
    for base in (SCRIPT_DIR, SCRIPT_DIR.parent.parent):
        for name in ('env', '.env'):
            path = base / name
            if not path.is_file():
                continue
            for raw_line in path.read_text(encoding='utf-8', errors='replace').splitlines():
                line = raw_line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                key = key.strip()
                value = value.strip()
                if key and key not in os.environ:
                    os.environ[key] = value.strip('"').strip("'")
            return


def get_credentials():
    json_str = os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON', '').strip()
    if json_str:
        try:
            return service_account.Credentials.from_service_account_info(json.loads(json_str))
        except Exception:
            pass

    json_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS', '').strip()
    if json_path:
        path = Path(json_path)
        if not path.is_absolute():
            path = SCRIPT_DIR / json_path
        if path.is_file():
            return service_account.Credentials.from_service_account_file(str(path))

    local_credentials = SCRIPT_DIR / 'credentials.json'
    if local_credentials.is_file():
        return service_account.Credentials.from_service_account_file(str(local_credentials))

    raise RuntimeError('Google credentials not found')


def ensure_sheet(sheets, spreadsheet_id, title):
    meta = sheets.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    existing = meta.get('sheets', [])
    for item in existing:
        props = item.get('properties', {})
        if props.get('title') == title:
            return props.get('sheetId')

    response = sheets.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            'requests': [
                {
                    'addSheet': {
                        'properties': {
                            'title': title,
                            'gridProperties': {
                                'rowCount': 1000,
                                'columnCount': 11,
                            },
                        }
                    }
                }
            ]
        }
    ).execute()
    replies = response.get('replies', [])
    added = replies[0].get('addSheet', {}).get('properties', {}) if replies else {}
    return added.get('sheetId')


def main():
    load_env()
    spreadsheet_id = os.environ.get('KRO_SHEET_ID', '').strip()
    unconfirmed_range = os.environ.get('KRO_UNCONFIRMED_RANGE', 'unconfirmed_results!A2:K').strip()
    if not spreadsheet_id:
        raise RuntimeError('KRO_SHEET_ID is required')

    sheet_name = unconfirmed_range.split('!')[0].strip() if '!' in unconfirmed_range else 'unconfirmed_results'
    creds = get_credentials()
    sheets = build('sheets', 'v4', credentials=creds)

    ensure_sheet(sheets, spreadsheet_id, sheet_name)

    headers = [[
        'username',
        'confirmation_status',
        'channel_age_days',
        'vip_price',
        'complaints',
        'has_signal_offer',
        'age_ok',
        'offer_ok',
        'complaints_ok',
        'missing_criteria',
        'checked_at',
    ]]
    sheets.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=f'{sheet_name}!A1:K1',
        valueInputOption='RAW',
        body={'values': headers}
    ).execute()

    print(json.dumps({
        'ok': True,
        'spreadsheet_id': spreadsheet_id,
        'sheet_name': sheet_name,
        'range': f'{sheet_name}!A2:K',
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
