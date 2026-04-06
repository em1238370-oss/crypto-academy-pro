#!/usr/bin/env python3
"""
Исправить колонку B (ссылка) на листе scam_base: убрать @ и %40 из пути t.me,
telegram.me → t.me, tg://resolve?domain= → https://t.me/username.

  python3 backend/scripts/kro-fix-scam-base-telegram-links.py --dry-run
  python3 backend/scripts/kro-fix-scam-base-telegram-links.py --execute

Переменные: GOOGLE_APPLICATION_CREDENTIALS, KRO_SHEET_ID,
опционально KRO_SCAM_BASE_RANGE (по умолчанию scam_base!A2:N — берётся только колонка B).
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import re
import sys
from urllib.parse import parse_qsl, unquote, urlparse

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


def clean_telegram_link(raw: str) -> str:
    """Синхронно с backend cleanTelegramLink / monitor canonical (публичные каналы)."""
    s = (raw or '').strip()
    if not s:
        return s
    low = s.lower()
    if low.startswith('tg://'):
        u = urlparse(s)
        if u.netloc.lower() == 'resolve':
            for k, v in parse_qsl(u.query, keep_blank_values=True):
                if k.lower() == 'domain':
                    dom = unquote(v).strip().lstrip('@')
                    if re.fullmatch(r'[A-Za-z0-9_]{3,64}', dom):
                        return f'https://t.me/{dom}'
        return ''

    if not re.search(r't\.me|telegram\.me', s, re.I):
        bare = s.lstrip('@')
        if re.fullmatch(r'[A-Za-z0-9_]{3,64}', bare) and not re.match(r'https?://', low) and '/' not in s:
            return f'https://t.me/{bare}'
        return s

    u = s
    if not re.match(r'https?://', low):
        u = 'https://' + re.sub(r'^(?:https?:)?//?', '', s, flags=re.I)

    try:
        pu = urlparse(u)
    except Exception:
        return s

    host = re.sub(r'^www\.', '', (pu.hostname or '').lower(), flags=re.I)
    if host not in ('t.me', 'telegram.me'):
        return s

    path = pu.path or '/'
    try:
        path = unquote(path)
    except Exception:
        pass
    path = re.sub(r'/@+', '/', path)
    parts: list[str] = []
    for seg in path.split('/'):
        if not seg:
            continue
        base = seg.split('?', 1)[0]
        base = re.sub(r'^@+', '', base)
        base = re.sub(r'^(?:%40)+', '', base, flags=re.I)
        if base:
            parts.append(base)

    if not parts:
        return s

    p0, p1 = parts[0], parts[1] if len(parts) > 1 else ''
    tail = ('?' + pu.query) if pu.query else ''

    if p0.lower() == 'joinchat' and p1:
        h = re.sub(r'^@+|^(?:%40)+', '', p1, flags=re.I)
        if re.fullmatch(r'[\w-]+', h):
            return f'https://t.me/joinchat/{h}{tail}'
    if p0.startswith('+'):
        inv = p0[1:]
        inv = re.sub(r'^@+|^(?:%40)+', '', inv, flags=re.I)
        if re.fullmatch(r'[\w-]+', inv):
            return f'https://t.me/+{inv}{tail}'
    if p0 == 's' and p1:
        un = re.sub(r'^@+|^(?:%40)+', '', p1, flags=re.I)
        if re.fullmatch(r'[A-Za-z0-9_]{3,64}', un):
            return f'https://t.me/s/{un}{tail}'

    return f'https://t.me/{"/".join(parts)}{tail}'


def main() -> int:
    parser = argparse.ArgumentParser(description='Normalize Telegram links in scam_base column B.')
    parser.add_argument('--dry-run', action='store_true', help='Print changes only.')
    parser.add_argument('--execute', action='store_true', help='Write updates to the sheet.')
    args = parser.parse_args()
    if not args.dry_run and not args.execute:
        parser.error('Укажите --dry-run или --execute')

    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip() or _DEFAULT_KRO_SHEET_ID
    if not re.fullmatch(r'[A-Za-z0-9_-]+', sheet_id) or len(sheet_id) < 20:
        print('KRO_SHEET_ID должен быть ID из URL таблицы Google.', file=sys.stderr)
        return 1

    rng = (os.environ.get('KRO_SCAM_BASE_RANGE') or 'scam_base!A2:N').strip()
    sheet_name = (rng.split('!')[0] if '!' in rng else 'scam_base').strip() or 'scam_base'
    col_b_range = f'{sheet_name}!B2:B'

    try:
        get_creds = _get_credentials_from_prune()
        creds = get_creds()
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1

    from googleapiclient.discovery import build

    sheets = build('sheets', 'v4', credentials=creds, cache_discovery=False)
    resp = (
        sheets.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range=col_b_range)
        .execute()
    )
    values = resp.get('values') or []

    updates: list[list[str]] = []
    changed = 0
    for i, row in enumerate(values):
        cell = (row[0] if row else '') or ''
        new_val = clean_telegram_link(cell)
        updates.append([new_val])
        if new_val != cell:
            changed += 1
            print(f'row {i + 2}: {cell!r} -> {new_val!r}')

    print(f'sheet={sheet_name} rows={len(values)} changed={changed}')

    if args.dry_run:
        print('dry-run: записи в таблицу не выполнялись.')
        return 0

    if not values:
        print('Нет строк данных в колонке B — нечего обновлять.')
        return 0

    sheets.spreadsheets().values().update(
        spreadsheetId=sheet_id,
        range=col_b_range,
        valueInputOption='USER_ENTERED',
        body={'values': updates},
    ).execute()
    print(f'updated OK: {col_b_range} ({len(updates)} ячеек)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
