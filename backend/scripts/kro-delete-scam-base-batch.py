#!/usr/bin/env python3
"""
Удалить из scam_base все строки, чей @username (колонка A) или ссылка (B) совпадает
с любым из списка в файле (по одному имени на строку).

Использование:
  python3 kro-delete-scam-base-batch.py path/to/list.txt

Переменные окружения: как у kro-delete-scam-base-row.py (KRO_SHEET_ID, KRO_GOOGLE_CREDENTIALS_JSON, …).
"""
import os
import re
import sys

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "kro-worker")))


def _norm(v: str) -> str:
    s = (v or "").strip().lower()
    if not s:
        return ""
    if s.startswith("https://t.me/"):
        s = "@" + s.split("https://t.me/", 1)[-1].split("/")[0]
    elif s.startswith("t.me/"):
        s = "@" + s.split("t.me/", 1)[-1].split("/")[0]
    if not s.startswith("@"):
        s = "@" + s.lstrip("@")
    return s


def _load_env():
    root = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
    for base in (root, os.path.join(root, "backend", "kro-worker")):
        for name in (".env", "env"):
            p = os.path.join(base, name)
            if not os.path.isfile(p):
                continue
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, _, v = line.partition("=")
                    k, v = k.strip(), v.strip()
                    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                        v = v[1:-1]
                    if k and k not in os.environ:
                        os.environ[k] = v
            break


def _load_targets(path: str):
    targets: set[str] = set()
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            n = _norm(line)
            if n:
                targets.add(n)
    return targets


def main() -> int:
    _load_env()
    if len(sys.argv) < 2:
        print("Usage: python3 kro-delete-scam-base-batch.py list.txt", file=sys.stderr)
        return 1
    list_path = os.path.abspath(sys.argv[1])
    if not os.path.isfile(list_path):
        print("File not found:", list_path, file=sys.stderr)
        return 1

    targets = _load_targets(list_path)
    if not targets:
        print("No usernames in list", file=sys.stderr)
        return 1

    sheet_id = (os.environ.get("KRO_SHEET_ID") or "").strip()
    if not sheet_id:
        print("KRO_SHEET_ID required", file=sys.stderr)
        return 1
    if not re.fullmatch(r"[A-Za-z0-9_-]+", sheet_id) or len(sheet_id) < 20:
        print("KRO_SHEET_ID invalid", file=sys.stderr)
        return 1

    import json
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    def _creds_from_json_string(s: str):
        info = json.loads(s)
        return service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/spreadsheets"]
        )

    raw = (os.environ.get("KRO_GOOGLE_CREDENTIALS_JSON") or "").strip()
    creds = None
    if raw.startswith("{"):
        creds = _creds_from_json_string(raw)
    if creds is None:
        cred_path = (os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or "").strip()
        if cred_path and not os.path.isabs(cred_path):
            cred_path = os.path.join(os.getcwd(), cred_path)
        if not cred_path:
            cred_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "kro-worker", "credentials.json"
            )
        if os.path.isfile(cred_path):
            creds = service_account.Credentials.from_service_account_file(
                cred_path, scopes=["https://www.googleapis.com/auth/spreadsheets"]
            )
    if creds is None:
        print("Google credentials missing", file=sys.stderr)
        return 1

    svc = build("sheets", "v4", credentials=creds, cache_discovery=False)
    rows = (
        svc.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range="scam_base!A2:N")
        .execute()
        .get("values", [])
    )
    before = len(rows)
    kept = []
    removed = 0
    for r in rows:
        rr = list(r) + [""] * (14 - len(r))
        u = _norm(rr[0])
        link = _norm(rr[1])
        if u in targets or link in targets:
            removed += 1
            continue
        kept.append(rr[:14])

    print("scam_base rows before:", before)
    print("targets in list:", len(targets))
    print("rows removed:", removed)
    print("rows after:", len(kept))

    if removed == 0:
        print("No matching rows — nothing to do.")
        return 0

    svc.spreadsheets().values().clear(spreadsheetId=sheet_id, range="scam_base!A2:N", body={}).execute()
    if kept:
        svc.spreadsheets().values().append(
            spreadsheetId=sheet_id,
            range="scam_base!A2:N",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": kept},
        ).execute()
    print("Sheet updated OK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
