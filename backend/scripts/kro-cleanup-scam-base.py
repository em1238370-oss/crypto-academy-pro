#!/usr/bin/env python3
"""
Чистка листа scam_base.

Строгий gate (нужен авторизованный Telethon на CI или локально):
  User/бот → удалить строку | подписчики < 100 → удалить | нет описания → удалить
  | нет постов за 60 дней → удалить | нет крипто-терминов в свежих постах → удалить
  | признаки взлома в постах → удалить | сущность недоступна / нет прав / ошибка чтения → удалить

Важно для владельца таблицы:
- Комментарии в произвольных ячейках скрипт НЕ парсит. Чтобы удалить канал:
  1) Добавьте @username в лист **kro_remove_queue**, колонка A (с строки 2), один на строку
     (лист можно создать в той же книге); или
  2) Задайте секрет GitHub **KRO_CLEANUP_EXTRA_DELETE** (или env): список @ через запятую/перенос; или
  3) В колонке N (content_analysis) для строки впишите маркер **__KRO_REMOVE__** — строка будет удалена.
- На CI: секрет **KRO_TELEGRAM_SESSION_STRING** (Telethon StringSession, см. `backend/kro-worker/convert_session.py`).
"""
import argparse
import asyncio
import json
import os
import re
import sys
_KRO_WORKER = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'kro-worker'))
if _KRO_WORKER not in sys.path:
    sys.path.insert(0, _KRO_WORKER)

from kro_telegram_channel_gate import (  # noqa: E402
    norm_username_for_gate as _norm_username,
    validate_telegram_scam_base_row_strict as _validate_row_strict,
)

# Явный список (эталонные «плохие» из ТЗ + очередь до первого прогона строгих правил).
TARGET_DELETE = {
    '@poizongo',
    '@auraselect',
    '@vipbyrodion_bot',
    '@snipervip0001_bot',
    '@copytradiings',
    '@copytradlngss',
    '@ukrainchuk_yuriy',
    '@alex_wise_trade',
    '@poizonstorm',
    '@rublevinvestrus',
    '@trader_servver',
    '@vladislav_belokrylov',
    '@maxcrypto_adm',
}

# Эталон «хорошей» строки — после чистки должен остаться (если был в листе).
ETALON_USERNAME = '@sergeytrader_plus'


def _load_env():
    root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
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
        if not cred_path:
            cred_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'kro-worker', 'credentials.json')
        if not os.path.isfile(cred_path):
            raise RuntimeError('Google credentials not found')
        creds = service_account.Credentials.from_service_account_file(
            cred_path, scopes=['https://www.googleapis.com/auth/spreadsheets']
        )
    return build('sheets', 'v4', credentials=creds, cache_discovery=False)


def _extra_delete_from_env() -> set:
    raw = (os.environ.get('KRO_CLEANUP_EXTRA_DELETE') or '').strip()
    if not raw:
        return set()
    out = set()
    for part in re.split(r'[\s,;|]+', raw):
        u = _norm_username(part)
        if u:
            out.add(u)
    return out


def _fetch_remove_queue_usernames(svc, sheet_id: str) -> set:
    from googleapiclient.errors import HttpError

    try:
        resp = (
            svc.spreadsheets()
            .values()
            .get(spreadsheetId=sheet_id, range='kro_remove_queue!A2:A')
            .execute()
        )
    except HttpError as e:
        code = getattr(getattr(e, 'resp', None), 'status', None)
        if code in (400, 404):
            print('INFO: лист kro_remove_queue не найден или пуст — пропуск (создайте лист и колонку A с @)')
            return set()
        raise
    out = set()
    for row in resp.get('values') or []:
        if not row:
            continue
        u = _norm_username(row[0])
        if u:
            out.add(u)
    if out:
        print('из листа kro_remove_queue:', len(out), 'username(s)')
    return out


def _row_marked_for_removal(rr: list) -> bool:
    """Колонка N (content_analysis): маркер __KRO_REMOVE__ — удалить строку при следующем прогоне."""
    blob = ((rr[13] if len(rr) > 13 else '') or '').strip().lower()
    return '__kro_remove__' in blob


async def _open_tg_client():
    import kro_telethon_session as _kro_ts

    api_id = (os.environ.get('TELEGRAM_API_ID') or '').strip().lstrip('\ufeff')
    api_hash = (os.environ.get('TELEGRAM_API_HASH') or '').strip()
    sess_len = len((os.environ.get('KRO_TELEGRAM_SESSION_STRING') or '').strip())
    if not api_id or not api_hash:
        print(
            'WARNING: для cleanup нужны TELEGRAM_API_ID и TELEGRAM_API_HASH в env шага '
            '(репозиторий → Secrets → Actions).',
            file=sys.stderr,
        )
        return None
    if sess_len == 0:
        print(
            'WARNING: пустой KRO_TELEGRAM_SESSION_STRING — строгий gate в cleanup не включится.',
            file=sys.stderr,
        )
    try:
        api_id_int = int(api_id)
    except ValueError:
        print('WARNING: TELEGRAM_API_ID не число:', repr(api_id[:20]), file=sys.stderr)
        return None
    print('cleanup Telethon env: SESSION_STRING_len=%d' % sess_len)
    try:
        c = _kro_ts.build_kro_telegram_client(api_id_int, api_hash)
        await c.connect()
        if not await c.is_user_authorized():
            await c.disconnect()
            print('WARNING: Telethon не авторизован (проверьте KRO_TELEGRAM_SESSION_STRING или .session)')
            return None
        print('INFO: Telethon подключён, строгие проверки строк включены')
        return c
    except Exception as ex:
        print('WARNING: Telethon connect failed:', ex)
        return None


def _row_telegram_keys(rr: list) -> tuple:
    """(username_norm, link_norm) для поиска сущности."""
    u = _norm_username(rr[0] if len(rr) > 0 else '')
    link = _norm_username(rr[1] if len(rr) > 1 else '')
    ref = u or link
    return u, link, ref


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    _load_env()
    sheet_id = (os.environ.get('KRO_SHEET_ID') or '').strip()
    if not sheet_id:
        raise RuntimeError('KRO_SHEET_ID is required')
    svc = _get_sheet_client()

    rows = svc.spreadsheets().values().get(
        spreadsheetId=sheet_id,
        range='scam_base!A2:N',
    ).execute().get('values', [])
    print('scam_base rows before:', len(rows))

    delete_extra = _extra_delete_from_env()
    delete_queue = _fetch_remove_queue_usernames(svc, sheet_id)
    delete_set = set(TARGET_DELETE) | delete_extra | delete_queue
    if delete_extra:
        print('из KRO_CLEANUP_EXTRA_DELETE:', len(delete_extra))
    print('всего username на полное удаление строки (код+env+лист):', len(delete_set))

    client = await _open_tg_client()
    if client is None:
        print('WARNING: Telethon недоступен — строки не помечаются строгим gate; удаляются только списком/маркером.')

    kept = []
    deleted_names = []
    strict_removed = []

    for r in rows:
        rr = list(r) + [''] * (14 - len(r))
        u_col, _link_col, ref = _row_telegram_keys(rr)

        if not ref:
            deleted_names.append('(empty_username_link)')
            continue

        # Step 1: полное удаление — список, env, kro_remove_queue, маркер N
        if ref in delete_set or u_col in delete_set:
            deleted_names.append(ref)
            continue
        if _row_marked_for_removal(rr):
            deleted_names.append(ref)
            continue

        # Step 2: строгий Telethon-gate — любое нарушение → строка удаляется целиком
        if client is not None:
            ok, reason, remove_row = await _validate_row_strict(
                client, {'username': rr[0], 'link': rr[1]}
            )
            if not ok and remove_row:
                deleted_names.append(ref)
                strict_removed.append((ref, reason))
                continue

        kept.append(rr[:14])

    if client is not None:
        try:
            await client.disconnect()
        except Exception:
            pass

    print('removed rows (total):', len(deleted_names))
    if deleted_names:
        print('removed sample:', ', '.join(sorted(set(deleted_names))[:40]))
        if len(set(deleted_names)) > 40:
            print('... и ещё', len(set(deleted_names)) - 40, 'уникальных')
    print('strict_gate removals:', len(strict_removed))
    if strict_removed:
        print('strict_gate sample:', strict_removed[:15])
    print('rows after cleanup:', len(kept))

    etalon_n = _norm_username(ETALON_USERNAME)
    etalon_kept = any(_row_telegram_keys(k)[2] == etalon_n for k in kept)
    print(
        'etalon %s in result: %s'
        % (ETALON_USERNAME, 'YES' if etalon_kept else 'NO (не было в листе или удалён правилами — проверьте вручную)')
    )

    if args.dry_run:
        return 0

    # Rewrite A2:N with kept rows
    svc.spreadsheets().values().clear(
        spreadsheetId=sheet_id,
        range='scam_base!A2:N',
        body={},
    ).execute()
    if kept:
        svc.spreadsheets().values().append(
            spreadsheetId=sheet_id,
            range='scam_base!A2:N',
            valueInputOption='USER_ENTERED',
            insertDataOption='INSERT_ROWS',
            body={'values': kept},
        ).execute()
    print('cleanup applied')
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))

