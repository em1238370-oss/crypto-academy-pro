#!/usr/bin/env python3
"""
Пишет backend/kro-worker/credentials.json из KRO_GOOGLE_CREDENTIALS_JSON.
Без echo в shell — кавычки в private_key не ломают файл.

Пишем строку как есть (UTF-8), затем проверяем json.loads — без round-trip dumps,
чтобы не исказить ключ.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> int:
    raw = os.environ.get("KRO_GOOGLE_CREDENTIALS_JSON", "")
    if isinstance(raw, str):
        raw = raw.strip()
    if not raw:
        print("missing KRO_GOOGLE_CREDENTIALS_JSON", file=sys.stderr)
        return 1
    # BOM из некоторых редакторов
    if raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")

    root = Path(os.environ.get("GITHUB_WORKSPACE", os.getcwd())).resolve()
    out = root / "backend" / "kro-worker" / "credentials.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(raw, encoding="utf-8")

    try:
        json.loads(raw)
    except json.JSONDecodeError as e:
        print(
            f"KRO_GOOGLE_CREDENTIALS_JSON is not valid JSON after write: {e}",
            file=sys.stderr,
        )
        print(
            "Проверьте в GitHub → Secrets: один цельный JSON в одну строку или корректный многострочный.",
            file=sys.stderr,
        )
        return 1

    print(f"wrote {out} (OK, JSON valid)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
