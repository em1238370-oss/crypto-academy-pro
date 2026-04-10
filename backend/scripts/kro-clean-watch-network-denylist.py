#!/usr/bin/env python3
"""
Удалить строки на листах channels_watch и channels_network, если username попадает под
kro_permanent_blocklist.json или глобальные исключения (Poizon*, официальные платформы) —
та же логика, что telegram_scam_base_row_matches_denylist для scam_base.

Колонки (как в server.js):
  channels_watch: A — канал, B — ссылка (опц.)
  channels_network: A — канал-источник, B — канал-цель

Переменные окружения:
  KRO_SHEET_ID
  KRO_CHANNELS_WATCH_RANGE (по умолчанию channels_watch!A2:M)
  KRO_CHANNELS_NETWORK_RANGE (по умолчанию channels_network!A2:G)

Запуск из backend/kro-worker:
  python3 ../scripts/kro-clean-watch-network-denylist.py --dry-run
  python3 ../scripts/kro-clean-watch-network-denylist.py --execute
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import sys

from dotenv import load_dotenv

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_KW = os.path.normpath(os.path.join(_SCRIPT_DIR, '..', 'kro-worker'))
if _KW not in sys.path:
    sys.path.insert(0, _KW)
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
    if 't.me/' in s:
        s = s.split('t.me/', 1)[-1].split('/')[0]
    return s.split('/')[0].split('?')[0]


def _cell_matches_telegram_denylist(cell: str, telegram_scam_base_row_matches_denylist) -> bool:
    s = (cell or '').strip()
    if not s:
        return False
    k = _norm_key(s)
    if not k or len(k) < 4:
        return False
    link = 'https://t.me/' + k
    u = s if s.startswith('@') or 't.me' in s.lower() else '@' + k
    fake_row = [u, link] + [''] * 12
    return telegram_scam_base_row_matches_denylist(fake_row)


def _sheet_title_from_range(rng: str) -> str:
    t = (rng or '').strip().split('!')[0].strip()
    return t or 'channels_watch'


def _collect_rows_to_delete(
    sheets,
    spreadsheet_id: str,
    range_full: str,
    row_matches,
):
    """Возвращает (список (0-based startIndex строки листа, метка), имя листа)."""
    sheet_title = _sheet_title_from_range(range_full)
    data = (
        sheets.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=range_full)
        .execute()
        .get('values', [])
    )
    out = []
    for i, row in enumerate(data):
        if not row_matches(row):
            continue
        sheet_row_index = 1 + i
        hint = (row[0] or '')[:40] + (' | ' + (row[1] or '')[:30] if len(row) > 1 else '')
        out.append((sheet_row_index, hint.strip(' |')))
    return out, sheet_title


def _delete_rows(
    sheets,
    spreadsheet_id: str,
    sheet_title: str,
    to_delete: list[tuple[int, str]],
    dry_run: bool,
) -> int:
    if not to_delete:
        return 0
    meta = sheets.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    sheet_id_num = None
    for s in meta.get('sheets', []):
        if s.get('properties', {}).get('title') == sheet_title:
            sheet_id_num = s['properties']['sheetId']
            break
    if sheet_id_num is None:
        print('Лист не найден: %s' % sheet_title, file=sys.stderr)
        return 0
    print('%s: matched_rows=%d' % (sheet_title, len(to_delete)))
    for idx, hint in to_delete:
        print('  sheet row %d: %r' % (idx + 1, hint))
    if dry_run:
        print('  dry-run: удаление не выполнялось.')
        return len(to_delete)
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
    sheets.spreadsheets().batchUpdate(spreadsheetId=spreadsheet_id, body={'requests': requests}).execute()
    print('  OK: удалено строк: %d' % len(requests))
    return len(requests)


def main() -> int:
    parser = argparse.ArgumentParser(description='Clean channels_watch / channels_network denylist rows.')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.dry_run and not args.execute:
        parser.error('Укажите --dry-run или --execute')

    from kro_tme_http_gate import telegram_scam_base_row_matches_denylist  # noqa: E402

    def watch_matches(row):
        u = (row[0] if row else '').strip()
        if not u:
            return False
        return _cell_matches_telegram_denylist(u, telegram_scam_base_row_matches_denylist)

    def network_matches(row):
        a = (row[0] if row else '').strip()
        b = (row[1] if len(row) > 1 else '').strip()
        return _cell_matches_telegram_denylist(a, telegram_scam_base_row_matches_denylist) or _cell_matches_telegram_denylist(
            b, telegram_scam_base_row_matches_denylist
        )

    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip() or _DEFAULT_KRO_SHEET_ID
    watch_rng = (os.environ.get('KRO_CHANNELS_WATCH_RANGE') or 'channels_watch!A2:M').strip()
    net_rng = (os.environ.get('KRO_CHANNELS_NETWORK_RANGE') or 'channels_network!A2:G').strip()

    try:
        get_creds = _get_credentials_from_prune()
        creds = get_creds()
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1

    from googleapiclient.discovery import build

    sheets = build('sheets', 'v4', credentials=creds, cache_discovery=False)

    total = 0
    for rng, matcher, label in (
        (watch_rng, watch_matches, 'watch'),
        (net_rng, network_matches, 'network'),
    ):
        print('--- %s (%s) ---' % (label, rng))
        to_del, stitle = _collect_rows_to_delete(sheets, sheet_id, rng, matcher)
        total += _delete_rows(sheets, sheet_id, stitle, to_del, args.dry_run)

    print('done. total_removed_or_matched=%d' % total)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
