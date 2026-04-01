#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_URL="${1:-https://github.com/riba2534/happyclaw.git}"
UPSTREAM_NAME="${2:-upstream}"
UPSTREAM_BRANCH="${3:-main}"

mkdir -p sync/logs
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="sync/logs/upstream-merge-${TS}.log"

# 先检查工作区，避免因为新建日志文件导致误判脏工作区
if [[ -n "$(git status --porcelain)" ]]; then
  echo "[ERROR] Working tree is not clean. Please commit/stash before merge."
  exit 2
fi

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[INFO] UTC timestamp: ${TS}"
echo "[INFO] Working branch: $(git branch --show-current)"
echo "[INFO] Upstream: ${UPSTREAM_NAME} ${UPSTREAM_URL} (${UPSTREAM_BRANCH})"

echo "[STEP] Configure rerere for conflict reuse"
git config rerere.enabled true
git config rerere.autoupdate true

echo "[STEP] Ensure remote exists"
if git remote get-url "$UPSTREAM_NAME" >/dev/null 2>&1; then
  git remote set-url "$UPSTREAM_NAME" "$UPSTREAM_URL"
else
  git remote add "$UPSTREAM_NAME" "$UPSTREAM_URL"
fi

echo "[STEP] Fetch upstream"
if ! git fetch "$UPSTREAM_NAME"; then
  echo "[ERROR] Fetch failed. Cannot continue merge workflow."
  exit 3
fi

echo "[STEP] Start merge"
set +e
git merge --no-ff --no-edit "${UPSTREAM_NAME}/${UPSTREAM_BRANCH}"
MERGE_EXIT=$?
set -e

if [[ $MERGE_EXIT -eq 0 ]]; then
  echo "[INFO] Merge completed with no conflicts."
  exit 0
fi

echo "[WARN] Merge reported conflicts."
CONFLICT_FILES="$(git diff --name-only --diff-filter=U || true)"
if [[ -z "$CONFLICT_FILES" ]]; then
  echo "[ERROR] Merge failed but no conflict files detected."
  exit 4
fi

echo "[STEP] Conflict files:"
echo "$CONFLICT_FILES"

if [[ -f sync/conflict-allowlist.txt ]]; then
  echo "[STEP] Validate conflict files against allowlist"
  BAD=0
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if ! rg -Nx --fixed-strings "$f" sync/conflict-allowlist.txt >/dev/null 2>&1; then
      echo "[ERROR] Conflict file not in allowlist: $f"
      BAD=1
    fi
  done <<< "$CONFLICT_FILES"
  if [[ $BAD -ne 0 ]]; then
    echo "[ERROR] Conflict allowlist check failed."
    exit 5
  fi
fi

echo "[STEP] Manual conflict resolution required."
echo "[HINT] Resolve files, then run: git add <files> && git commit"
exit 6
