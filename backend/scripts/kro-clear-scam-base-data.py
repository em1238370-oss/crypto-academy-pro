#!/usr/bin/env python3
"""
Удалить все строки данных на листе scam_base, оставив строку 1 (заголовок).

Не трогает kro_meta, kro_history, reports и другие листы.

Учётные данные — как у kro-prune-scam-base-html.py (через тот же _get_credentials).

  cd backend/kro-worker
  python3 ../scripts/kro-clear-scam-base-data.py --dry-run
  python3 ../scripts/kro-clear-scam-base-data.py --execute

Диапазон очистки: из KRO_SCAM_BASE_RANGE (по умолчанию scam_base!A2:N) берётся имя листа
и очищается блок A2:N (14 колонок под формат KRO v2).
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import re
import sys

from dotenv import load_dotenv

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.normpath(os.path.join(_SCRIPT_DIR, '..', 'kro-worker', '.env')))
load_dotenv(os.path.normpath(os.path.join(_SCRIPT_DIR, '..', '..', '.env')))

# Как в kro-prune-scam-base-html: если KRO_SHEET_ID пустой — тот же прод-ID по умолчанию.
_DEFAULT_KRO_SHEET_ID = '1C1NQwqmLRg59xgplnz5PeghRxaR_YY2lfSWZAJae6qM'


def _get_credentials_from_prune():
    p = os.path.join(_SCRIPT_DIR, 'kro-prune-scam-base-html.py')
    spec = importlib.util.spec_from_file_location('_kro_prune_creds', p)
    if spec is None or spec.loader is None:
        raise RuntimeError('cannot load kro-prune-scam-base-html.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod._get_credentials


def main() -> int:
    parser = argparse.ArgumentParser(description='Clear scam_base data rows (keep header row 1).')
    parser.add_argument('--dry-run', action='store_true', help='Only print row count; no clear.')
    parser.add_argument('--execute', action='store_true', help='Call Sheets API clear on data range.')
    args = parser.parse_args()
    if not args.dry_run and not args.execute:
        parser.error('Укажите --dry-run или --execute')

    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip() or _DEFAULT_KRO_SHEET_ID
    if not re.fullmatch(r'[A-Za-z0-9_-]+', sheet_id) or len(sheet_id) < 20:
        print('KRO_SHEET_ID должен быть ID из URL таблицы Google.', file=sys.stderr)
        return 1

    rng = (os.environ.get('KRO_SCAM_BASE_RANGE') or 'scam_base!A2:N').strip()
    sheet_name = (rng.split('!')[0] if '!' in rng else 'scam_base').strip() or 'scam_base'
    clear_range = f'{sheet_name}!A2:N'

    try:
        get_creds = _get_credentials_from_prune()
        creds = get_creds()
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1

    from googleapiclient.discovery import build

    sheets = build('sheets', 'v4', credentials=creds, cache_discovery=False)
    header = (
        sheets.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range=f'{sheet_name}!A1:N1')
        .execute()
        .get('values', [])
    )
    rows = (
        sheets.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range=clear_range)
        .execute()
        .get('values', [])
    )
    n_data = len(rows)
    print('sheet=%s spreadsheetId=%s…' % (sheet_name, sheet_id[:8]))
    print('clear_range=%s' % clear_range)
    print('header_row_present=%s (cells in A1:N1: %d)' % (bool(header), sum(len(r) for r in header)))
    print('data_rows_before=%d' % n_data)

    if args.dry_run:
        print('dry-run: очистка не выполнялась.')
        return 0

    sheets.spreadsheets().values().clear(spreadsheetId=sheet_id, range=clear_range, body={}).execute()
    print('cleared OK: %s' % clear_range)
    print('data_rows_after=0 (заголовок в строке 1 сохранён)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
