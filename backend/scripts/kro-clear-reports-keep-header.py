#!/usr/bin/env python3
"""
Очистка листа reports в Google Sheets: удалить все строки кроме первой (заголовок).

Окружение: KRO_SHEET_ID, GOOGLE_APPLICATION_CREDENTIALS или KRO_GOOGLE_CREDENTIALS_JSON.
Имя листа: KRO_REPORTS_SHEET (по умолчанию reports).

Запуск из корня репозитория:
  GOOGLE_APPLICATION_CREDENTIALS=backend/kro-worker/credentials.json \\
  KRO_SHEET_ID=... python3 backend/scripts/kro-clear-reports-keep-header.py

Или с флагом --dry-run (только показать диапазон).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

_KRO_WORKER = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'kro-worker'))
if _KRO_WORKER not in sys.path:
    sys.path.insert(0, _KRO_WORKER)


def _quote_sheet_tab(title: str) -> str:
    t = (title or '').strip()
    if not t:
        return ''
    if re.match(r'^[A-Za-z0-9_]+$', t):
        return t
    return "'" + t.replace("'", "''") + "'"


def _get_sheet_client():
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    raw = (os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON') or '').strip()
    creds = None
    if raw:
        try:
            info = json.loads(raw)
            creds = service_account.Credentials.from_service_account_info(
                info, scopes=['https://www.googleapis.com/auth/spreadsheets']
            )
        except Exception:
            pass
    if creds is None:
        cred_path = (os.environ.get('GOOGLE_APPLICATION_CREDENTIALS') or '').strip()
        if cred_path and not os.path.isabs(cred_path):
            cred_path = os.path.join(os.getcwd(), cred_path)
        if not cred_path or not os.path.isfile(cred_path):
            cred_path = os.path.join(_KRO_WORKER, 'credentials.json')
        if not os.path.isfile(cred_path):
            raise RuntimeError('Google credentials not found (GOOGLE_APPLICATION_CREDENTIALS or KRO_GOOGLE_CREDENTIALS_JSON)')
        creds = service_account.Credentials.from_service_account_file(
            cred_path, scopes=['https://www.googleapis.com/auth/spreadsheets']
        )
    return build('sheets', 'v4', credentials=creds, cache_discovery=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip()
    if not sheet_id:
        print('KRO_SHEET_ID is required', file=sys.stderr)
        return 1

    tab = (os.environ.get('KRO_REPORTS_SHEET') or 'reports').strip() or 'reports'
    q = _quote_sheet_tab(tab)
    clear_range = '%s!A2:Z50000' % q

    if args.dry_run:
        print('dry-run: would clear', clear_range)
        return 0

    svc = _get_sheet_client()
    svc.spreadsheets().values().clear(
        spreadsheetId=sheet_id,
        range=clear_range,
        body={},
    ).execute()
    print('OK: cleared data rows (kept row 1 header):', clear_range)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
