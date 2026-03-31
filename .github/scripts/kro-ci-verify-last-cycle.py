#!/usr/bin/env python3
"""
CI-only: проверка kro_meta.last_cycle_at после цикла монитора.
Всегда завершается с кодом 0, чтобы GitHub Actions не создавал Annotations «exit code 1».
Ненормальные ситуации — stderr + при необходимости ::warning::.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build


def parse_cycle_ts(raw: str):
    s = str(raw or "").strip()
    if not s:
        return None
    s = re.sub(r"\s+MSK\s*$", "", s, flags=re.IGNORECASE).strip()
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        pass
    m = re.match(
        r"^(\d{1,2})\.(\d{1,2})\.(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?$",
        s,
    )
    if m:
        dd, mo, yy, hh, mi, ss = (
            m.group(1),
            m.group(2),
            m.group(3),
            m.group(4),
            m.group(5),
            m.group(6) or "0",
        )
        iso = f"{yy}-{int(mo):02d}-{int(dd):02d}T{int(hh):02d}:{int(mi):02d}:{int(ss):02d}+03:00"
        try:
            return datetime.fromisoformat(iso)
        except Exception:
            return None
    m = re.match(
        r"^(\d{1,2})/(\d{1,2})/(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?$",
        s,
    )
    if m:
        mo, dd, yy, hh, mi, ss = (
            m.group(1),
            m.group(2),
            m.group(3),
            m.group(4),
            m.group(5),
            m.group(6) or "0",
        )
        iso = f"{yy}-{int(mo):02d}-{int(dd):02d}T{int(hh):02d}:{int(mi):02d}:{int(ss):02d}+03:00"
        try:
            return datetime.fromisoformat(iso)
        except Exception:
            return None
    try:
        num = float(s)
        if 20000 < num < 800000:
            ts = (num - 25569) * 86400.0
            return datetime.fromtimestamp(ts, tz=timezone.utc)
    except Exception:
        pass
    return None


def main() -> int:
    ok = True
    sheet_id = os.environ.get("KRO_SHEET_ID", "").strip()
    raw = os.environ.get("KRO_GOOGLE_CREDENTIALS_JSON", "").strip()
    if not sheet_id or not raw:
        print(
            "missing KRO_SHEET_ID or KRO_GOOGLE_CREDENTIALS_JSON",
            file=sys.stderr,
        )
        print("::warning::last_cycle_at verify skipped — missing env")
        return 0

    try:
        creds_info = json.loads(raw)
        creds = Credentials.from_service_account_info(
            creds_info,
            scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
        )
        svc = build("sheets", "v4", credentials=creds, cache_discovery=False)
        rows = (
            svc.spreadsheets()
            .values()
            .get(spreadsheetId=sheet_id, range="kro_meta!A:B")
            .execute()
            .get("values", [])
        )
        kv = {
            (r[0] if len(r) > 0 else ""): (r[1] if len(r) > 1 else "")
            for r in rows
        }
        last_cycle = str(kv.get("last_cycle_at", "")).strip()
    except Exception as e:
        print(f"kro_meta read error: {e}", file=sys.stderr)
        print(f"::warning::last_cycle_at verify failed to read sheet: {e}")
        return 0

    if not last_cycle:
        print("kro_meta.last_cycle_at is empty", file=sys.stderr)
        print("::warning::last_cycle_at verify — kro_meta.last_cycle_at is empty")
        return 0

    ts = parse_cycle_ts(last_cycle)
    if ts is None:
        print(f"invalid last_cycle_at: {last_cycle}", file=sys.stderr)
        print(
            "::warning::last_cycle_at verify — could not parse timestamp "
            f"(value={last_cycle!r})"
        )
        return 0

    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    prev = os.environ.get("PREVIOUS_LAST_CYCLE_AT", "").strip()
    if prev and prev == last_cycle:
        print(
            f"warning: last_cycle_at did not change after run: {last_cycle}",
            file=sys.stderr,
        )
    age_h = (datetime.now(timezone.utc) - ts).total_seconds() / 3600.0
    print(f"kro_meta.last_cycle_at={last_cycle} age_hours={age_h:.2f}")
    if age_h > 13.0:
        print("last_cycle_at is stale (>13h)", file=sys.stderr)
        print(
            "::warning::last_cycle_at is stale (>13h) — check that the monitor "
            "updated kro_meta"
        )
        ok = False

    if ok:
        print("last_cycle_at verify OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
