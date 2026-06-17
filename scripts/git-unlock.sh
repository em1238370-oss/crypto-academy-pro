#!/usr/bin/env bash
# Удаляет зависшие *.lock в .git (index.lock, refs/*.lock и т.д.).
# GitHub Desktop: «A lock file already exists in the repository…»
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "git-unlock: не git-репозиторий" >&2
  exit 1
fi

FORCE=0
for arg in "$@"; do
  case "$arg" in
    -f|--force) FORCE=1 ;;
  esac
done

removed=0
while IFS= read -r -d '' lockfile; do
  if [[ "$FORCE" -eq 1 ]]; then
    rm -f "$lockfile"
    echo "removed: $lockfile"
    removed=$((removed + 1))
    continue
  fi
  # Без --force: только «протухшие» lock (>90 с) — не трогаем активный git-процесс
  if find "$lockfile" -mmin +1.5 -print -quit 2>/dev/null | grep -q .; then
    rm -f "$lockfile"
    echo "removed stale: $lockfile"
    removed=$((removed + 1))
  else
    echo "skip (fresh lock, use --force): $lockfile" >&2
  fi
done < <(find "$ROOT/.git" -name '*.lock' -type f -print0 2>/dev/null || true)

if [[ "$removed" -eq 0 ]]; then
  echo "git-unlock: lock-файлов нет (или все свежие — закройте GitHub Desktop и: bash scripts/git-unlock.sh --force)"
fi

exit 0
