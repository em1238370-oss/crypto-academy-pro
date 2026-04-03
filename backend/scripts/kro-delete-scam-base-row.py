#!/usr/bin/env python3
"""
Удалить из листа scam_base все строки с указанным @username (колонка A или ссылка в B).

Требуется: KRO_SHEET_ID и один из вариантов учётки (как в cleanup):
  KRO_GOOGLE_CREDENTIALS_JSON (JSON строкой) или GOOGLE_APPLICATION_CREDENTIALS / credentials.json в kro-worker.

  cd backend/kro-worker
  export KRO_SHEET_ID=1abc...   # реальный ID из URL таблицы, не текст-заглушка
  # Вариант A — целиком JSON одной строкой (из Render/GitHub скопировать полностью):
  export KRO_GOOGLE_CREDENTIALS_JSON='{"type":"service_account",...}'
  # Вариант B — путь к скачанному ключу:
  export GOOGLE_APPLICATION_CREDENTIALS=/полный/путь/credentials.json
  python3 ../scripts/kro-delete-scam-base-row.py @vladislav_belokrylov
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), '..', 'kro-worker')))


def _norm(v: str) -> str:
    s = (v or '').strip().lower()
    if not s:
        return ''
    if s.startswith('https://t.me/'):
        s = '@' + s.split('https://t.me/', 1)[-1].split('/')[0]
    elif s.startswith('t.me/'):
        s = '@' + s.split('t.me/', 1)[-1].split('/')[0]
    if not s.startswith('@'):
        s = '@' + s.lstrip('@')
    return s


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


def main():
    _load_env()
    if len(sys.argv) < 2:
        print('Usage: python3 kro-delete-scam-base-row.py @username', file=sys.stderr)
        return 1
    target = _norm(sys.argv[1])
    if not target:
        return 1

    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip()
    if not sheet_id:
        print('KRO_SHEET_ID required', file=sys.stderr)
        return 1
    if not re.fullmatch(r'[A-Za-z0-9_-]+', sheet_id) or len(sheet_id) < 20:
        print(
            'KRO_SHEET_ID должен быть латинским ID из URL таблицы '
            '(docs.google.com/spreadsheets/d/…/edit), не текст вроде «ваш_id_таблицы».',
            file=sys.stderr,
        )
        return 1

    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    def _creds_from_json_string(s: str):
        info = json.loads(s)
        return service_account.Credentials.from_service_account_info(
            info, scopes=['https://www.googleapis.com/auth/spreadsheets']
        )

    raw = (os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON') or '').strip()
    creds = None
    json_err = None
    if raw:
        if raw.startswith('{'):
            try:
                creds = _creds_from_json_string(raw)
            except json.JSONDecodeError as e:
                json_err = e
            except Exception as e:
                json_err = e
        else:
            path = raw if os.path.isabs(raw) else os.path.join(os.getcwd(), raw)
            if os.path.isfile(path):
                try:
                    with open(path, encoding='utf-8') as f:
                        creds = _creds_from_json_string(f.read())
                except Exception as e:
                    json_err = e
            else:
                print(
                    'KRO_GOOGLE_CREDENTIALS_JSON не начинается с { и не является путём к существующему файлу: %s'
                    % path[:120],
                    file=sys.stderr,
                )
                return 1
    if creds is None and json_err is not None:
        print(
            'KRO_GOOGLE_CREDENTIALS_JSON не удалось разобрать: %s. '
            'Нужен полный JSON ключа (как в секрете Render), не текст с «...» из примера.'
            % json_err,
            file=sys.stderr,
        )
        return 1
    if creds is None:
        cred_path = (os.environ.get('GOOGLE_APPLICATION_CREDENTIALS') or '').strip()
        if cred_path and not os.path.isabs(cred_path):
            cred_path = os.path.join(os.getcwd(), cred_path)
        if not cred_path:
            cred_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'kro-worker', 'credentials.json')
        if not os.path.isfile(cred_path):
            print(
                'Google credentials: задайте полный JSON в KRO_GOOGLE_CREDENTIALS_JSON '
                '(скопируйте целиком из секрета, без сокращения «...») '
                'или GOOGLE_APPLICATION_CREDENTIALS=путь/к/credentials.json '
                'или положите backend/kro-worker/credentials.json',
                file=sys.stderr,
            )
            return 1
        creds = service_account.Credentials.from_service_account_file(
            cred_path, scopes=['https://www.googleapis.com/auth/spreadsheets']
        )
    svc = build('sheets', 'v4', credentials=creds, cache_discovery=False)

    rows = (
        svc.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range='scam_base!A2:N')
        .execute()
        .get('values', [])
    )
    before = len(rows)
    kept = []
    removed = 0
    for r in rows:
        rr = list(r) + [''] * (14 - len(r))
        u = _norm(rr[0])
        link = _norm(rr[1])
        if u == target or link == target:
            removed += 1
            continue
        kept.append(rr[:14])

    print('scam_base rows before:', before)
    print('rows matching %s removed: %s' % (target, removed))
    print('rows after:', len(kept))

    if removed == 0:
        print('No matching row — check spelling in column A/B or sheet name scam_base.')
        return 0

    svc.spreadsheets().values().clear(spreadsheetId=sheet_id, range='scam_base!A2:N', body={}).execute()
    if kept:
        svc.spreadsheets().values().append(
            spreadsheetId=sheet_id,
            range='scam_base!A2:N',
            valueInputOption='USER_ENTERED',
            insertDataOption='INSERT_ROWS',
            body={'values': kept},
        ).execute()
    print('Sheet updated OK.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
