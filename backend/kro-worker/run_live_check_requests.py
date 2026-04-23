#!/usr/bin/env python3
"""
Process pending live channel check requests from Google Sheets.

Sheet schema:
id, username, status, result, created_at
"""
import json
import os
import subprocess
import sys
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build


SCRIPT_DIR = Path(__file__).resolve().parent
KRO_SHEET_ID = (os.environ.get("KRO_SHEET_ID") or "").strip()
KRO_CHECK_REQUESTS_RANGE = (os.environ.get("KRO_CHECK_REQUESTS_RANGE") or "kro_check_requests!A2:E").strip()
CHECK_USERNAME = (os.environ.get("KRO_CHECK_USERNAME") or "").strip().lower().lstrip("@")
REQUESTS_SHEET = KRO_CHECK_REQUESTS_RANGE.split("!")[0] if "!" in KRO_CHECK_REQUESTS_RANGE else "kro_check_requests"


def get_sheets_client():
    creds = None
    json_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    json_raw = os.environ.get("KRO_GOOGLE_CREDENTIALS_JSON")
    if json_raw:
        creds = service_account.Credentials.from_service_account_info(json.loads(json_raw))
    elif json_path and os.path.isfile(json_path):
        creds = service_account.Credentials.from_service_account_file(json_path)
    if not creds:
        return None
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def run_check_once(username):
    proc = subprocess.run(
        [sys.executable, str(SCRIPT_DIR / "check_once.py"), username, "90"],
        cwd=str(SCRIPT_DIR),
        capture_output=True,
        text=True,
        timeout=8 * 60,
        env={**os.environ},
    )
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return None


def pick_request(rows):
    for idx, row in enumerate(rows):
        rid = (row[0] if len(row) > 0 else "").strip()
        username = (row[1] if len(row) > 1 else "").strip()
        status = (row[2] if len(row) > 2 else "").strip().lower()
        if not rid or not username or status != "pending":
            continue
        if CHECK_USERNAME and username.lower().lstrip("@") != CHECK_USERNAME:
            continue
        return idx, rid, username, row
    return None, None, None, None


def update_row(svc, row_number, values):
    svc.spreadsheets().values().update(
        spreadsheetId=KRO_SHEET_ID,
        range=f"{REQUESTS_SHEET}!A{row_number}:E{row_number}",
        valueInputOption="RAW",
        body={"values": [values]},
    ).execute()


def main():
    if not KRO_SHEET_ID:
        print("KRO_SHEET_ID is required", file=sys.stderr)
        return 1
    if not os.environ.get("TELEGRAM_API_ID") or not os.environ.get("TELEGRAM_API_HASH"):
        print("TELEGRAM_API_ID and TELEGRAM_API_HASH are required", file=sys.stderr)
        return 1

    svc = get_sheets_client()
    if not svc:
        print("Google Sheets credentials are missing", file=sys.stderr)
        return 1

    resp = svc.spreadsheets().values().get(
        spreadsheetId=KRO_SHEET_ID,
        range=KRO_CHECK_REQUESTS_RANGE,
    ).execute()
    rows = resp.get("values", [])
    idx, request_id, username, row = pick_request(rows)
    if row is None:
        print("No pending requests")
        return 0

    row_number = idx + 2
    created_at = (row[4] if len(row) > 4 else "").strip()
    update_row(svc, row_number, [request_id, username, "running", "", created_at])

    try:
      parsed = run_check_once(username)
    except Exception as exc:
      parsed = {"error": str(exc)[:400]}

    if not parsed:
        parsed = {"error": "check_once returned no JSON payload"}

    status = "done" if parsed.get("found") is True and int(parsed.get("posts_fetched") or 0) > 0 else "failed"
    update_row(
        svc,
        row_number,
        [request_id, username, status, json.dumps(parsed, ensure_ascii=False), created_at],
    )
    print(f"Processed {username}: {status}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
