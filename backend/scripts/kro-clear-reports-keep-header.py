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
import os
import sys

_SCRIPTS = os.path.dirname(os.path.abspath(__file__))
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

from kro_clear_google_sheet_body import clear_sheet_body  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    tab = (os.environ.get('KRO_REPORTS_SHEET') or 'reports').strip() or 'reports'
    try:
        r = clear_sheet_body(tab, 'Z', 50000, dry_run=args.dry_run)
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1

    if args.dry_run:
        print('dry-run: would clear', r)
    else:
        print('OK: cleared data rows (kept row 1 header):', r)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
