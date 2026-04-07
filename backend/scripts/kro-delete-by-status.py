#!/usr/bin/env python3
"""
Удалить из scam_base все строки, где колонка M (статус) содержит «не по теме»
или маркер off_topic. Не зависит от формата username в колонке A.

Требуется: KRO_SHEET_ID, GOOGLE_APPLICATION_CREDENTIALS или KRO_GOOGLE_CREDENTIALS_JSON
(как в kro-delete-scam-base-row.py).

Опционально: KRO_SCAM_BASE_RANGE (по умолчанию scam_base!A2:N) — берётся имя листа.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), '..', 'kro-worker')))


def _load_env():
    root = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
    for base in (root, os.path.join(root, 'backend', 'kro-worker')):
        for name in ('.env', 'env'):
            p = os.path.join(base, name)
            if not os.path.isfile(p):
                continue
            with open(p, 'r', encoding='utf-8', errors='replace') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line:
                        continue
                    k, _, v = line.partition('=')
                    k, v = k.strip(), v.strip()
                    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                        v = v[1:-1]
                    if k and k not in os.environ:
                        os.environ[k] = v
            break


def _norm_status(cell: str) -> str:
    s = unicodedata.normalize('NFKC', (cell or '').replace('\u00a0', ' '))
    s = re.sub(r'\s+', ' ', s).strip().lower()
    return s


def _status_is_off_topic(cell: str) -> bool:
    s = _norm_status(cell)
    if not s:
        return False
    if 'не по теме' in s:
        return True
    if 'непотеме' in s.replace(' ', ''):
        return True
    u = s.replace('-', '_').replace(' ', '_')
    if 'off_topic' in u:
        return True
    if 'off topic' in s:
        return True
    return False


def _get_creds():
    from google.oauth2 import service_account

    def _from_json_string(raw: str):
        return service_account.Credentials.from_service_account_info(
            json.loads(raw), scopes=['https://www.googleapis.com/auth/spreadsheets']
        )

    raw = (os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON') or '').strip()
    if raw.startswith('{'):
        return _from_json_string(raw)
    cred_path = (os.environ.get('GOOGLE_APPLICATION_CREDENTIALS') or '').strip()
    if cred_path and not os.path.isabs(cred_path):
        cred_path = os.path.join(os.getcwd(), cred_path)
    if not cred_path:
        cred_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), '..', 'kro-worker', 'credentials.json'
        )
    if not os.path.isfile(cred_path):
        raise SystemExit(
            'Нужны учётные данные: KRO_GOOGLE_CREDENTIALS_JSON (JSON) '
            'или GOOGLE_APPLICATION_CREDENTIALS=путь/credentials.json'
        )
    return service_account.Credentials.from_service_account_file(
        cred_path, scopes=['https://www.googleapis.com/auth/spreadsheets']
    )


def _sheet_id_numeric(svc, spreadsheet_id: str, title: str) -> int:
    meta = svc.spreadsheets().get(spreadsheetId=spreadsheet_id, fields='sheets.properties').execute()
    for sh in meta.get('sheets', []) or []:
        p = sh.get('properties', {}) or {}
        if p.get('title') == title:
            return int(p['sheetId'])
    raise SystemExit('Лист %r не найден в таблице.' % title)


def main() -> int:
    _load_env()
    ap = argparse.ArgumentParser(description='Delete scam_base rows where column M is off-topic.')
    ap.add_argument(
        '--dry-run',
        action='store_true',
        help='Only print how many rows would be deleted.',
    )
    args = ap.parse_args()

    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip()
    if not sheet_id:
        print('KRO_SHEET_ID required', file=sys.stderr)
        return 1
    if not re.fullmatch(r'[A-Za-z0-9_-]+', sheet_id) or len(sheet_id) < 20:
        print('KRO_SHEET_ID должен быть ID из URL таблицы Google.', file=sys.stderr)
        return 1

    rng = (os.environ.get('KRO_SCAM_BASE_RANGE') or 'scam_base!A2:N').strip()
    sheet_name = (rng.split('!')[0] if '!' in rng else 'scam_base').strip() or 'scam_base'

    from googleapiclient.discovery import build

    creds = _get_creds()
    svc = build('sheets', 'v4', credentials=creds, cache_discovery=False)

    rows = (
        svc.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range='%s!A2:N' % sheet_name)
        .execute()
        .get('values', [])
    )

    # 1-based row numbers in the spreadsheet (row 1 = header)
    to_delete: list[int] = []
    for i, row in enumerate(rows):
        m_cell = (row[12] if len(row) > 12 else '').strip()
        if _status_is_off_topic(m_cell):
            to_delete.append(i + 2)

    to_delete.sort(reverse=True)
    print('scam_base rows scanned:', len(rows))
    print('rows to delete (column M off-topic):', len(to_delete))
    if args.dry_run:
        print('dry-run: no changes.')
        return 0
    if not to_delete:
        print('Nothing to delete.')
        return 0

    sid = _sheet_id_numeric(svc, sheet_id, sheet_name)
    # batchUpdate: max ~500 requests; delete from bottom to top in one batch
    chunk = 400
    deleted = 0
    for start in range(0, len(to_delete), chunk):
        part = to_delete[start : start + chunk]
        requests = [
            {
                'deleteDimension': {
                    'range': {
                        'sheetId': sid,
                        'dimension': 'ROWS',
                        'startIndex': r - 1,
                        'endIndex': r,
                    }
                }
            }
            for r in part
        ]
        svc.spreadsheets().batchUpdate(
            spreadsheetId=sheet_id,
            body={'requests': requests},
        ).execute()
        deleted += len(part)
        print('batchUpdate: deleted %d rows (cumulative %d)' % (len(part), deleted))

    print('OK: total rows removed:', deleted)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
