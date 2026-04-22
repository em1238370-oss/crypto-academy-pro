#!/usr/bin/env python3
"""
KRO check queue worker for Feature 1.

Reads pending rows from kro_check_queue, runs check_once.py via Telethon,
writes result rows to kro_check_results, and updates queue status.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build


SCRIPT_DIR = Path(__file__).resolve().parent

KRO_SHEET_ID = (os.environ.get("KRO_SHEET_ID") or "").strip()
KRO_CHECK_QUEUE_RANGE = (os.environ.get("KRO_CHECK_QUEUE_RANGE") or "kro_check_queue!A2:G").strip()
KRO_CHECK_RESULTS_RANGE = (os.environ.get("KRO_CHECK_RESULTS_RANGE") or "kro_check_results!A2:I").strip()
CHECK_USERNAME = (os.environ.get("KRO_CHECK_USERNAME") or "").strip().lower().lstrip("@")

QUEUE_SHEET = KRO_CHECK_QUEUE_RANGE.split("!")[0] if "!" in KRO_CHECK_QUEUE_RANGE else "kro_check_queue"
RESULTS_SHEET = KRO_CHECK_RESULTS_RANGE.split("!")[0] if "!" in KRO_CHECK_RESULTS_RANGE else "kro_check_results"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


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


def run_check_once(channel):
    proc = subprocess.run(
        [sys.executable, str(SCRIPT_DIR / "check_once.py"), channel, "90"],
        cwd=str(SCRIPT_DIR),
        capture_output=True,
        text=True,
        timeout=8 * 60,
        env={**os.environ},
    )
    out = (proc.stdout or "").splitlines()
    for line in out:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return None


def pick_pending_row(rows):
    for idx, row in enumerate(rows):
        req_id = (row[0] if len(row) > 0 else "").strip()
        username = (row[1] if len(row) > 1 else "").strip()
        status = (row[3] if len(row) > 3 else "").strip().lower()
        if not req_id or not username:
            continue
        if status != "pending":
            continue
        key = username.lower().lstrip("@")
        if CHECK_USERNAME and key != CHECK_USERNAME:
            continue
        return idx, row
    return None, None


def update_queue_row(svc, row_number, values):
    svc.spreadsheets().values().update(
        spreadsheetId=KRO_SHEET_ID,
        range=f"{QUEUE_SHEET}!A{row_number}:G{row_number}",
        valueInputOption="RAW",
        body={"values": [values]},
    ).execute()


def append_result_row(svc, values):
    svc.spreadsheets().values().append(
        spreadsheetId=KRO_SHEET_ID,
        range=KRO_CHECK_RESULTS_RANGE,
        valueInputOption="RAW",
        insertDataOption="INSERT_ROWS",
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

    queue_resp = svc.spreadsheets().values().get(
        spreadsheetId=KRO_SHEET_ID,
        range=KRO_CHECK_QUEUE_RANGE,
    ).execute()
    rows = queue_resp.get("values", [])
    idx, row = pick_pending_row(rows)
    if row is None:
        print("No pending queue rows")
        return 0

    row_number = idx + 2
    request_id = (row[0] if len(row) > 0 else "").strip()
    username = (row[1] if len(row) > 1 else "").strip()
    requested_at = (row[2] if len(row) > 2 else "").strip()

    started_at = now_iso()
    update_queue_row(svc, row_number, [request_id, username, requested_at, "running", started_at, "", ""])

    parsed = None
    error_text = ""
    try:
        parsed = run_check_once(username)
    except Exception as e:
        parsed = None
        error_text = str(e)[:300]

    finished_at = now_iso()
    if not parsed:
        if not error_text:
            error_text = "check_once returned no JSON payload"
        append_result_row(
            svc,
            [request_id, username, finished_at, "failed", 0, "", "", "", json.dumps({"error": error_text}, ensure_ascii=False)],
        )
        update_queue_row(svc, row_number, [request_id, username, requested_at, "failed", started_at, finished_at, error_text])
        print(f"Processed {username}: failed ({error_text})")
        return 0

    posts_read = int(parsed.get("posts_fetched") or 0)
    period_days = int(parsed.get("analysis_window_days") or 0) if parsed.get("analysis_window_days") else ""
    read_path = str(parsed.get("read_path") or "")
    risk_index = parsed.get("risk_score")
    has_posts = posts_read > 0 and bool(parsed.get("found") is True)
    result_status = "done" if has_posts else "failed"
    err = "" if has_posts else str(parsed.get("error") or "posts_not_read")

    append_result_row(
        svc,
        [
            request_id,
            username,
            finished_at,
            result_status,
            posts_read,
            period_days,
            read_path,
            risk_index if risk_index is not None else "",
            json.dumps(parsed, ensure_ascii=False),
        ],
    )
    update_queue_row(
        svc,
        row_number,
        [request_id, username, requested_at, result_status, started_at, finished_at, err],
    )
    print(f"Processed {username}: {result_status}, posts={posts_read}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
