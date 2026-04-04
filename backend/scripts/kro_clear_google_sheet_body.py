#!/usr/bin/env python3
"""
Очистка тела листа Google Sheets (строки со 2-й), строка 1 (заголовок) не трогается.

Использование:
  python3 backend/scripts/kro_clear_google_sheet_body.py reports --last-col Z
  python3 backend/scripts/kro_clear_google_sheet_body.py channels_watch --last-col M

Окружение: KRO_SHEET_ID, GOOGLE_APPLICATION_CREDENTIALS (или KRO_GOOGLE_CREDENTIALS_JSON).
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
            raise RuntimeError('Google credentials not found')
        creds = service_account.Credentials.from_service_account_file(
            cred_path, scopes=['https://www.googleapis.com/auth/spreadsheets']
        )
    return build('sheets', 'v4', credentials=creds, cache_discovery=False)


def clear_sheet_body(
    sheet_tab: str,
    last_col: str = 'Z',
    max_row: int = 50000,
    *,
    dry_run: bool = False,
) -> str:
    """
    Очищает строки 2..max_row на вкладке, заголовок (строка 1) не трогается.
    Возвращает человекочитаемый диапазон (для логов).
    """
    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip()
    if not sheet_id:
        raise RuntimeError('KRO_SHEET_ID is required')

    last = (last_col or 'Z').strip().upper()
    if not re.match(r'^[A-Z]{1,2}$', last):
        raise ValueError('Invalid last_col %r' % last_col)

    q = _quote_sheet_tab(sheet_tab)
    clear_range = '%s!A2:%s%d' % (q, last, max_row)

    if dry_run:
        return clear_range

    svc = _get_sheet_client()
    svc.spreadsheets().values().clear(
        spreadsheetId=sheet_id,
        range=clear_range,
        body={},
    ).execute()
    return clear_range


def main() -> int:
    p = argparse.ArgumentParser(description='Clear sheet body (keep row 1 header)')
    p.add_argument('sheet_tab', help='Имя вкладки, например reports или channels_watch')
    p.add_argument('--last-col', default='Z', help='Последняя колонка диапазона (default Z)')
    p.add_argument('--max-row', type=int, default=50000, help='Нижняя строка диапазона (default 50000)')
    p.add_argument('--dry-run', action='store_true')
    args = p.parse_args()

    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip()
    if not sheet_id:
        print('KRO_SHEET_ID is required', file=sys.stderr)
        return 1

    try:
        r = clear_sheet_body(
            args.sheet_tab,
            args.last_col,
            args.max_row,
            dry_run=args.dry_run,
        )
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1

    if args.dry_run:
        print('dry-run: would clear', r)
    else:
        print('OK: cleared', r)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
