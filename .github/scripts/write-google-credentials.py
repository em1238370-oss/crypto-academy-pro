#!/usr/bin/env python3
"""
Пишет backend/kro-worker/credentials.json.

В GitHub Actions используем ТОЛЬКО KRO_GOOGLE_CREDENTIALS_BASE64 (секрет JSON в env не передаём —
иначе битый KRO_GOOGLE_CREDENTIALS_JSON снова ломает шаг).

Локально можно задать KRO_GOOGLE_CREDENTIALS_JSON или BASE64.

Base64: base64 -i файл.json | tr -d '\\n' | pbcopy
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import sys
from pathlib import Path


def _decode_b64(s: str) -> str:
    s = "".join(s.split())
    pad = (-len(s)) % 4
    if pad:
        s += "=" * pad
    return base64.b64decode(s).decode("utf-8")


def main() -> int:
    in_gha = os.environ.get("GITHUB_ACTIONS", "").lower() == "true"
    b64 = (os.environ.get("KRO_GOOGLE_CREDENTIALS_BASE64") or "").strip()
    raw_json = (os.environ.get("KRO_GOOGLE_CREDENTIALS_JSON") or "").strip()

    if in_gha:
        if not b64:
            print(
                "В Actions нужен секрет KRO_GOOGLE_CREDENTIALS_BASE64 (base64 всего JSON ключа). "
                "Шаг намеренно не читает KRO_GOOGLE_CREDENTIALS_JSON — см. write-google-credentials.py",
                file=sys.stderr,
            )
            return 1
        try:
            raw = _decode_b64(b64)
        except (binascii.Error, UnicodeDecodeError) as e:
            print(f"KRO_GOOGLE_CREDENTIALS_BASE64: ошибка декодирования: {e}", file=sys.stderr)
            return 1
    else:
        if b64:
            try:
                raw = _decode_b64(b64)
            except (binascii.Error, UnicodeDecodeError) as e:
                print(f"BASE64 decode failed: {e}", file=sys.stderr)
                return 1
        elif raw_json:
            raw = raw_json
        else:
            print(
                "Нужен KRO_GOOGLE_CREDENTIALS_BASE64 или KRO_GOOGLE_CREDENTIALS_JSON",
                file=sys.stderr,
            )
            return 1

    if raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")

    root = Path(os.environ.get("GITHUB_WORKSPACE", os.getcwd())).resolve()
    out = root / "backend" / "kro-worker" / "credentials.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(raw, encoding="utf-8")

    try:
        json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"После декодирования не валидный JSON: {e}", file=sys.stderr)
        return 1

    print(f"wrote {out} (OK)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
