#!/usr/bin/env python3
"""
Если у @incom_biz в scam_base пустое source_evidence — обнуляет total_loss_rub и
записывает честное пояснение (данные должны быть проверяемыми).

Запуск в CI после batch-delete или вручную.
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "kro-worker")))


def _norm_user(v: str) -> str:
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


def main() -> int:
    _load_env()
    target = _norm_user("@incom_biz")
    sheet_id = (os.environ.get("KRO_SHEET_ID") or "").strip()
    if not sheet_id or not re.fullmatch(r"[A-Za-z0-9_-]+", sheet_id) or len(sheet_id) < 20:
        print("KRO_SHEET_ID invalid", file=sys.stderr)
        return 1

    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    raw = (os.environ.get("KRO_GOOGLE_CREDENTIALS_JSON") or "").strip()
    creds = None
    if raw.startswith("{"):
        creds = service_account.Credentials.from_service_account_info(
            json.loads(raw), scopes=["https://www.googleapis.com/auth/spreadsheets"]
        )
    if creds is None:
        cred_path = (os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or "").strip()
        if not cred_path:
            cred_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "kro-worker", "credentials.json"
            )
        if not os.path.isabs(cred_path):
            cred_path = os.path.join(os.getcwd(), cred_path)
        if os.path.isfile(cred_path):
            creds = service_account.Credentials.from_service_account_file(
                cred_path, scopes=["https://www.googleapis.com/auth/spreadsheets"]
            )
    if creds is None:
        print("Google credentials missing", file=sys.stderr)
        return 1

    svc = build("sheets", "v4", credentials=creds, cache_discovery=False)
    resp = (
        svc.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range="scam_base!A2:N")
        .execute()
    )
    rows = resp.get("values") or []
    row_idx = None
    row_data = None
    for i, r in enumerate(rows):
        rr = list(r) + [""] * (14 - len(r))
        if _norm_user(rr[0]) == target:
            row_idx = i + 2
            row_data = rr
            break

    if row_idx is None:
        print("No row for @incom_biz in scam_base — skip.")
        return 0

    ev = (row_data[10] if len(row_data) > 10 else "").strip()
    if ev:
        print("incom_biz already has source_evidence — skip:", ev[:80])
        return 0

    note = "сумма потерь не подтверждена источником"
    # Columns I (index 8) and K (index 10); 1-based: I, K
    range_update = f"scam_base!I{row_idx}:K{row_idx}"
    body = {"values": [["0", row_data[9] if len(row_data) > 9 else "", note]]}
    svc.spreadsheets().values().update(
        spreadsheetId=sheet_id,
        range=range_update,
        valueInputOption="USER_ENTERED",
        body=body,
    ).execute()
    print(f"Updated {range_update}: total_loss_rub=0, source_evidence set.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
