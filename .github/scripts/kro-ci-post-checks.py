#!/usr/bin/env python3
"""
Один процесс для CI: last_cycle_at + data-quality.
Дочерние проверки (node) идут через subprocess — у GitHub Actions не появляются
лишние Annotations «exit code 1» от дочернего node (как при spawn из отдельного .mjs).

Всегда завершается с кодом 0.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path


def _workspace() -> Path:
    return Path(os.environ.get("GITHUB_WORKSPACE", os.getcwd())).resolve()


def _load_verify_main():
    script = Path(__file__).resolve().parent / "kro-ci-verify-last-cycle.py"
    spec = importlib.util.spec_from_file_location("kro_ci_verify_last_cycle", script)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {script}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.main


def run_data_quality(root: Path) -> None:
    node_script = root / "backend" / "scripts" / "kro-data-quality.mjs"
    env = os.environ.copy()
    r = subprocess.run(
        ["node", str(node_script), "--json"],
        cwd=str(root),
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    if r.returncode != 0:
        print(
            f"::warning::kro-data-quality.mjs exited with {r.returncode}",
            file=sys.stderr,
        )
        if r.stderr:
            print(r.stderr, file=sys.stderr)
        return

    try:
        q = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        print(f"::warning::failed to parse kro-data-quality JSON: {e}", file=sys.stderr)
        print(r.stdout[:2000], file=sys.stderr)
        return

    bad_loss = [x.get("username") for x in (q.get("lossStatusRows") or []) if x.get("username")]
    bad_crypto = [x.get("username") for x in (q.get("nonCryptoRows") or []) if x.get("username")]
    nc = int(q.get("nonCryptoCount") or 0)
    lm = int(q.get("lossStatusMismatchCount") or 0)
    print(json.dumps(q, ensure_ascii=False, indent=2))
    if nc > 0 or lm > 0:
        print("KRO quality violations:", nc, lm, file=sys.stderr)
        if bad_crypto:
            print("Non-crypto usernames:", ", ".join(bad_crypto), file=sys.stderr)
        if bad_loss:
            print("Loss-status usernames:", ", ".join(bad_loss), file=sys.stderr)
        print(
            "::warning::KRO data-quality: "
            f"{nc} non-crypto / {lm} loss-status mismatches — fix in Sheets or run migration",
            file=sys.stderr,
        )
    else:
        print("KRO quality check OK")


def main() -> int:
    root = _workspace()
    try:
        verify_main = _load_verify_main()
        verify_main()
    except Exception as e:
        print(f"::warning::last_cycle verify crashed: {e}", file=sys.stderr)

    try:
        run_data_quality(root)
    except Exception as e:
        print(f"::warning::data-quality runner crashed: {e}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
