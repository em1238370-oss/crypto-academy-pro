#!/usr/bin/env python3
"""
Удалить строки на листе scam_base, где username (колонка A) совпадает с заданным списком.

Использование:
  cd backend/kro-worker && python3 ../scripts/kro-remove-scam-base-usernames.py --dry-run --usernames telegram,poizonsector
  python3 ../scripts/kro-remove-scam-base-usernames.py --execute --usernames telegram,poizonsector,poizonsystem

Учётные данные: GOOGLE_APPLICATION_CREDENTIALS или KRO_GOOGLE_CREDENTIALS_JSON (как у воркера).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys

from dotenv import load_dotenv

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.normpath(os.path.join(_SCRIPT_DIR, '..', 'kro-worker', '.env')))
load_dotenv(os.path.normpath(os.path.join(_SCRIPT_DIR, '..', '..', '.env')))

_DEFAULT_KRO_SHEET_ID = '1C1NQwqmLRg59xgplnz5PeghRxaR_YY2lfSWZAJae6qM'


def _get_credentials_from_prune():
    p = os.path.join(_SCRIPT_DIR, 'kro-prune-scam-base-html.py')
    spec = importlib.util.spec_from_file_location('_kro_prune_creds', p)
    if spec is None or spec.loader is None:
        raise RuntimeError('cannot load kro-prune-scam-base-html.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod._get_credentials


def _norm_key(cell: str) -> str:
    s = (cell or '').strip().lower()
    if s.startswith('@'):
        s = s[1:]
    return s.split('/')[0].split('?')[0]


def main() -> int:
    parser = argparse.ArgumentParser(description='Remove scam_base rows by username (column A).')
    parser.add_argument('--usernames', required=True, help='Comma-separated @optional usernames')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.dry_run and not args.execute:
        parser.error('Укажите --dry-run или --execute')

    targets = {_norm_key(x) for x in args.usernames.split(',') if _norm_key(x)}
    if not targets:
        print('Нет валидных username в --usernames', file=sys.stderr)
        return 1

    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip() or _DEFAULT_KRO_SHEET_ID
    rng = (os.environ.get('KRO_SCAM_BASE_RANGE') or 'scam_base!A2:N').strip()
    sheet_title = (rng.split('!')[0] if '!' in rng else 'scam_base').strip() or 'scam_base'

    try:
        get_creds = _get_credentials_from_prune()
        creds = get_creds()
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1

    from googleapiclient.discovery import build

    sheets = build('sheets', 'v4', credentials=creds, cache_discovery=False)
    meta = sheets.spreadsheets().get(spreadsheetId=sheet_id).execute()
    sheet_id_num = None
    for s in meta.get('sheets', []):
        if s.get('properties', {}).get('title') == sheet_title:
            sheet_id_num = s['properties']['sheetId']
            break
    if sheet_id_num is None:
        print('Лист не найден: %s' % sheet_title, file=sys.stderr)
        return 1

    data = (
        sheets.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range='%s!A2:N' % sheet_title)
        .execute()
        .get('values', [])
    )

    # 0-based row index in sheet; row 0 = первая строка листа; данные с индекса 1 (строка 2)
    to_delete = []
    for i, row in enumerate(data):
        a0 = (row[0] if row else '') or ''
        if _norm_key(a0) in targets:
            sheet_row_index = 1 + i  # 0-based
            to_delete.append((sheet_row_index, a0.strip()))

    print('targets=%s' % sorted(targets))
    print('matched_rows=%d' % len(to_delete))
    for idx, uname in to_delete:
        print('  sheet row %d (1-based UI row %d): %r' % (idx + 1, idx + 1, uname))

    if args.dry_run:
        print('dry-run: удаление не выполнялось.')
        return 0

    if not to_delete:
        return 0

    # Удаляем снизу вверх (больший индекс первым)
    to_delete.sort(key=lambda t: t[0], reverse=True)
    requests = []
    for sheet_row_index, _ in to_delete:
        requests.append(
            {
                'deleteDimension': {
                    'range': {
                        'sheetId': sheet_id_num,
                        'dimension': 'ROWS',
                        'startIndex': sheet_row_index,
                        'endIndex': sheet_row_index + 1,
                    }
                }
            }
        )

    body = {'requests': requests}
    sheets.spreadsheets().batchUpdate(spreadsheetId=sheet_id, body=body).execute()
    print('OK: удалено строк: %d' % len(requests))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
