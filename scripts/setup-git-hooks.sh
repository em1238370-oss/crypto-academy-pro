#!/usr/bin/env bash
# Один раз после clone/pull: включает .githooks и снимает зависшие lock.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

chmod +x scripts/git-unlock.sh scripts/setup-git-hooks.sh 2>/dev/null || true
chmod +x .githooks/* 2>/dev/null || true

git config core.hooksPath .githooks
echo "core.hooksPath = .githooks"

bash scripts/git-unlock.sh --force || true
echo "Готово. При ошибке GitHub Desktop: bash scripts/git-unlock.sh --force"
