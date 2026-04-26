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
from pathlib import Path

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build


def _load_service_account_dict():
    """JSON из env или из файла GOOGLE_APPLICATION_CREDENTIALS (обходит битый env в CI)."""
    raw = os.environ.get("KRO_GOOGLE_CREDENTIALS_JSON", "").strip()
    if raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
    rel = (os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or "").strip()
    if rel:
        base = Path(os.environ.get("GITHUB_WORKSPACE", os.getcwd()))
        p = Path(rel) if Path(rel).is_absolute() else base / rel
        if p.is_file():
            return json.loads(p.read_text(encoding="utf-8"))
    raise ValueError("cannot load Google credentials (fix KRO_GOOGLE_CREDENTIALS_JSON or credentials file)")


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
    if not sheet_id:
        print("не задан KRO_SHEET_ID", file=sys.stderr)
        print("::warning::Проверка last_cycle_at пропущена — не задан секрет KRO_SHEET_ID")
        return 0

    try:
        creds_info = _load_service_account_dict()
    except (ValueError, json.JSONDecodeError, OSError) as e:
        print(f"ошибка загрузки ключа Google: {e}", file=sys.stderr)
        print(f"::warning::Проверка last_cycle_at — не удалось загрузить ключ: {e}")
        return 0

    try:
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
        print(f"ошибка чтения kro_meta: {e}", file=sys.stderr)
        print(f"::warning::Проверка last_cycle_at — ошибка Google Sheets: {e}")
        return 0

    if not last_cycle:
        print("kro_meta.last_cycle_at пусто", file=sys.stderr)
        print("::warning::Проверка last_cycle_at — в листе kro_meta пустое поле last_cycle_at")
        return 0

    ts = parse_cycle_ts(last_cycle)
    if ts is None:
        print(f"не удалось разобрать last_cycle_at: {last_cycle}", file=sys.stderr)
        print(
            "::warning::Проверка last_cycle_at — не удалось разобрать дату "
            f"(значение={last_cycle!r})"
        )
        return 0

    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    prev = os.environ.get("PREVIOUS_LAST_CYCLE_AT", "").strip()
    if prev and prev == last_cycle:
        print(
            f"внимание: last_cycle_at после запуска не изменился: {last_cycle}",
            file=sys.stderr,
        )
    age_h = (datetime.now(timezone.utc) - ts).total_seconds() / 3600.0
    print(f"kro_meta.last_cycle_at={last_cycle} age_hours={age_h:.2f}")
    if age_h > 13.0:
        print("last_cycle_at устарел (>13 ч)", file=sys.stderr)
        print(
            "::warning::last_cycle_at устарел (>13 ч) — проверьте, что монитор обновил лист kro_meta"
        )
        ok = False

    if ok:
        print("Проверка last_cycle_at: OK")

    # --- Минимум находок за цикл (строго >5 по умолчанию => 6): KRO_MIN_CHANNELS_FOUND_PER_CYCLE, KRO_CYCLE_VOLUME_METRIC ---
    skip_vol = os.environ.get("KRO_CI_SKIP_CYCLE_VOLUME", "").strip().lower() in ("1", "true", "yes")
    raw_min = os.environ.get("KRO_MIN_CHANNELS_FOUND_PER_CYCLE", "").strip()
    if raw_min == "":
        min_req = 6
    else:
        try:
            min_req = int(str(raw_min).replace(" ", ""), 10)
        except ValueError:
            min_req = 6
    metric = (os.environ.get("KRO_CYCLE_VOLUME_METRIC") or "either").strip().lower()

    def _parse_int_cell(v) -> int:
        try:
            return int(str(v or 0).replace(" ", "").split(".")[0], 10)
        except ValueError:
            return 0

    nic = _parse_int_cell(kv.get("new_in_cycle"))
    scan = _parse_int_cell(kv.get("channels_scanned_in_cycle"))

    if skip_vol or min_req <= 0:
        print("Проверка объёма цикла: пропущена (KRO_CI_SKIP_CYCLE_VOLUME или MIN=0)")
        return 0

    vol_ok = True
    if metric == "new_in_base":
        vol_ok = nic >= min_req
    elif metric == "scanned":
        vol_ok = scan >= min_req
    elif metric == "both":
        vol_ok = nic >= min_req and scan >= min_req
    else:
        vol_ok = nic >= min_req or scan >= min_req

    print(
        f"KRO cycle volume: new_in_cycle={nic}, channels_scanned_in_cycle={scan}, "
        f"min_required={min_req}, metric={metric}, ok={vol_ok}"
    )
    if not vol_ok:
        print(
            f"::error::Цикл: слишком мало находок (нужно ≥{min_req} по правилу «{metric}»). "
            f"new_in_cycle={nic}, channels_scanned_in_cycle={scan}. "
            "Усильте сбор или временно задайте KRO_CI_SKIP_CYCLE_VOLUME=1 / KRO_MIN_CHANNELS_FOUND_PER_CYCLE=0.",
            file=sys.stderr,
        )
        return 1

    print("Проверка объёма цикла: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
