#!/usr/bin/env python3
"""
Сброс данных для страницы /monitor (API /api/kro/monitor-data):

  - channels_watch  — блок «Все найденные каналы»
  - channels_network — связи каналов (рядом с watch)
  - kro_meta        — «последний цикл», счётчики, «источники данных» (sources_checked), метрики качества
  - kro_history     — «История циклов» (строка заголовка в строке 1 сохраняется)

Не трогает: scam_base, reports, лист первой вкладки с жалобами и т.д.

Учётные данные — как kro-prune-scam-base-html (_get_credentials).

  cd backend/kro-worker
  python3 ../scripts/kro-reset-monitor-dashboard.py --dry-run
  python3 ../scripts/kro-reset-monitor-dashboard.py --execute

Переменные (как на Render / в server.js):
  KRO_SHEET_ID
  KRO_CHANNELS_WATCH_RANGE   (по умолчанию channels_watch!A2:M)
  KRO_CHANNELS_NETWORK_RANGE   (по умолчанию channels_network!A2:G)
  KRO_META_RANGE               (по умолчанию kro_meta!A:B; пишем ключи в A1:B7)
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

_DEFAULT_KRO_SHEET_ID = '1C1NQwqmLRg59xgplnz5PeghRxaR_YY2lfSWZAJae6qM'


def _get_credentials_from_prune():
    p = os.path.join(_SCRIPT_DIR, 'kro-prune-scam-base-html.py')
    spec = importlib.util.spec_from_file_location('_kro_prune_creds', p)
    if spec is None or spec.loader is None:
        raise RuntimeError('cannot load kro-prune-scam-base-html.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod._get_credentials


def _count_rows(sheets, spreadsheet_id: str, rng: str) -> int:
    rows = (
        sheets.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=rng)
        .execute()
        .get('values', [])
    )
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description='Reset Google Sheets data used by /monitor dashboard.')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.dry_run and not args.execute:
        parser.error('Укажите --dry-run или --execute')

    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip() or _DEFAULT_KRO_SHEET_ID
    if not re.fullmatch(r'[A-Za-z0-9_-]+', sheet_id) or len(sheet_id) < 20:
        print('KRO_SHEET_ID должен быть ID из URL таблицы Google.', file=sys.stderr)
        return 1

    watch_rng = (os.environ.get('KRO_CHANNELS_WATCH_RANGE') or 'channels_watch!A2:M').strip()
    network_rng = (os.environ.get('KRO_CHANNELS_NETWORK_RANGE') or 'channels_network!A2:G').strip()
    meta_rng = (os.environ.get('KRO_META_RANGE') or 'kro_meta!A:B').strip()
    meta_sheet = (meta_rng.split('!')[0] if '!' in meta_rng else 'kro_meta').strip() or 'kro_meta'
    history_sheet = 'kro_history'
    history_clear_rng = f'{history_sheet}!A2:F'

    try:
        get_creds = _get_credentials_from_prune()
        creds = get_creds()
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1

    from googleapiclient.discovery import build

    sheets = build('sheets', 'v4', credentials=creds, cache_discovery=False)

    wn = _count_rows(sheets, sheet_id, watch_rng)
    nn = _count_rows(sheets, sheet_id, network_rng)
    hn = _count_rows(sheets, sheet_id, history_clear_rng)

    print('spreadsheetId=%s…' % sheet_id[:8])
    print('channels_watch %s: rows=%d' % (watch_rng, wn))
    print('channels_network %s: rows=%d' % (network_rng, nn))
    print('kro_history %s: data rows=%d (row 1 = заголовок)' % (history_clear_rng, hn))
    print('kro_meta: будет записан сброс в %s!A1:B7' % meta_sheet)

    if args.dry_run:
        print('dry-run: изменений нет.')
        return 0

    sheets.spreadsheets().values().clear(spreadsheetId=sheet_id, range=watch_rng, body={}).execute()
    sheets.spreadsheets().values().clear(spreadsheetId=sheet_id, range=network_rng, body={}).execute()
    sheets.spreadsheets().values().clear(spreadsheetId=sheet_id, range=history_clear_rng, body={}).execute()

    meta_rows = [
        ['key', 'value'],
        ['last_cycle_at', ''],
        ['new_in_cycle', '0'],
        ['sources_checked', '[]'],
        ['false_positive_signals', '0'],
        ['avg_source_weight', ''],
        ['channels_with_complaints_only', '0'],
    ]
    sheets.spreadsheets().values().update(
        spreadsheetId=sheet_id,
        range='%s!A1:B7' % meta_sheet,
        valueInputOption='RAW',
        body={'values': meta_rows},
    ).execute()

    print('OK: watch + network + history очищены; kro_meta сброшена.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
