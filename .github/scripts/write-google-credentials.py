#!/usr/bin/env python3
"""
Пишет backend/kro-worker/credentials.json из KRO_GOOGLE_CREDENTIALS_JSON.
Нужен вместо echo '...' в CI: одинарные кавычки в JSON (например в private_key) ломают shell.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> int:
    raw = os.environ.get("KRO_GOOGLE_CREDENTIALS_JSON", "").strip()
    if not raw:
        print("missing KRO_GOOGLE_CREDENTIALS_JSON", file=sys.stderr)
        return 1
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"invalid JSON in KRO_GOOGLE_CREDENTIALS_JSON: {e}", file=sys.stderr)
        return 1
    root = Path(os.environ.get("GITHUB_WORKSPACE", os.getcwd())).resolve()
    out = root / "backend" / "kro-worker" / "credentials.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
