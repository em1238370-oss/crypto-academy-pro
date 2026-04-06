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
    # Файл credentials.json записан Python-скриптом; env JSON иногда битый в раннере —
    # заставляем Node читать только файл (как в локальной разработке).
    gac = (env.get("GOOGLE_APPLICATION_CREDENTIALS") or "").strip()
    if gac:
        gac_path = Path(gac) if Path(gac).is_absolute() else root / gac
        if gac_path.is_file():
            env.pop("KRO_GOOGLE_CREDENTIALS_JSON", None)

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
            f"::warning::Проверка scam_base (Node): скрипт завершился с кодом {r.returncode}",
            file=sys.stderr,
        )
        if r.stderr:
            print(r.stderr, file=sys.stderr)
        return

    try:
        q = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        print(f"::warning::Проверка scam_base: не удалось разобрать JSON ({e})", file=sys.stderr)
        print(r.stdout[:2000], file=sys.stderr)
        return

    bad_loss = [x.get("username") for x in (q.get("lossStatusRows") or []) if x.get("username")]
    bad_crypto = [x.get("username") for x in (q.get("nonCryptoRows") or []) if x.get("username")]
    nc = int(q.get("nonCryptoCount") or 0)
    lm = int(q.get("lossStatusMismatchCount") or 0)
    print(json.dumps(q, ensure_ascii=False, indent=2))
    if nc > 0 or lm > 0:
        print(
            "KRO: замечания по scam_base — строк без крипто-маркеров в тексте: %s; "
            "несовпадение «есть потери, но статус не «в риске»»: %s"
            % (nc, lm),
            file=sys.stderr,
        )
        if bad_crypto:
            print(
                "Проверьте строки (мало признаков крипто-контекста): "
                + ", ".join(bad_crypto),
                file=sys.stderr,
            )
        if bad_loss:
            print(
                "Потери > 0, но статус не «в риске»: " + ", ".join(bad_loss),
                file=sys.stderr,
            )
        print(
            "::warning::KRO / scam_base: "
            f"{nc} строк без явного крипто-текста, {lm} несовпадений статуса при потерях. "
            "Исправьте в Google Таблице или запустите "
            "`node backend/scripts/kro-data-quality.mjs --apply` для авто-статуса «в риске».",
            file=sys.stderr,
        )
    else:
        print("Проверка качества scam_base: OK")


def main() -> int:
    root = _workspace()
    try:
        verify_main = _load_verify_main()
        verify_main()
    except Exception as e:
        print(f"::warning::Проверка last_cycle_at: сбой ({e})", file=sys.stderr)

    try:
        run_data_quality(root)
    except Exception as e:
        print(f"::warning::Проверка scam_base: сбой ({e})", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
