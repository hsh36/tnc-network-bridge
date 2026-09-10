#!/usr/bin/env bash
#
# Update the bridge to a given git ref, and put it back if the result does not come up.
#
# Run as root by the privileged helper, inside a transient systemd unit — never as a
# child of the service. The last thing this script does is restart tnc-bridge, which
# kills anything descended from it, so a script running under the service would be
# killed in the middle of the switch and leave a half-built tree behind.
#
#   self-update.sh <target-ref> [rollback-if-non-empty]
#
# Progress is written to a status file rather than reported over a pipe, for the same
# reason: the process that asked for the update is gone by the time the interesting
# part happens. The service reads that file back on startup, so the UI picks the
# progress up again after the restart instead of showing an update that vanished.

set -uo pipefail

INSTALL_DIR="${TNC_INSTALL_DIR:-/opt/tnc-bridge}"
STATE_DIR="${TNC_STATE_DIR:-/var/lib/tnc-bridge}"
STATUS_FILE="${STATE_DIR}/update-status.json"
SERVICE_NAME="${TNC_SERVICE_NAME:-tnc-bridge}"
SERVICE_USER="${TNC_SERVICE_USER:-tncbridge}"
SERVICE_GROUP="${TNC_SERVICE_GROUP:-tncbridge}"
HEALTH_URL="${TNC_HEALTH_URL:-https://127.0.0.1/api/v1/health}"
HEALTH_TIMEOUT="${TNC_HEALTH_TIMEOUT:-120}"

TARGET_REF="${1:-}"
# Whether a rollback is wanted at all. Empty means no — the very first update on a
# fresh install has nothing to go back to.
ROLLBACK_WANTED="${2:-}"

# Where to go back to, resolved here rather than taken from the caller.
#
# The caller derives its idea of "the previous version" from the running version
# string, which assumes the checkout is exactly the tag matching it. That is false on
# every ordinary install: install.sh does `git reset --hard origin/main`, so a bridge
# reporting 0.1.0 is usually somewhere ahead of the v0.1.0 tag. Rolling back to the tag
# would silently undo everything merged since it — a downgrade dressed up as a recovery.
# The commit actually checked out is the only correct answer, and this is the only
# place that knows it.
PREVIOUS_REF=""
if [ -n "$ROLLBACK_WANTED" ]; then
  PREVIOUS_REF="$(git -C "${TNC_INSTALL_DIR:-/opt/tnc-bridge}" rev-parse HEAD 2>/dev/null || true)"
fi

[ -n "$TARGET_REF" ] || {
  echo "usage: self-update.sh <target-ref> [rollback-if-non-empty]" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# Status reporting
# ---------------------------------------------------------------------------

# The file is the only channel back to the UI, so it is written atomically. A reader
# that catches a half-written file sees invalid JSON and reports the update as broken
# when it is merely in progress.
report() {
  local phase="$1" pct="$2" error="${3:-}"
  local tmp="${STATUS_FILE}.tmp"

  mkdir -p "$STATE_DIR" 2>/dev/null || true
  {
    printf '{"phase":"%s","progressPct":%s,"target":"%s","previous":"%s","ts":%s' \
      "$phase" "$pct" "$TARGET_REF" "$PREVIOUS_REF" "$(date +%s)"
    if [ -n "$error" ]; then
      # Only the characters that would break the document; the message is a shell
      # string, not attacker input, but a stray quote would still corrupt the file.
      printf ',"error":"%s"' "$(printf '%s' "$error" | tr -d '"\\' | tr '\n' ' ')"
    fi
    printf '}\n'
  } > "$tmp" && mv -f "$tmp" "$STATUS_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$STATUS_FILE" 2>/dev/null || true

  echo "[self-update] $phase ${pct}% ${error}"
}

fail() {
  local message="$1"
  echo "[self-update] FAILED: $message" >&2
  if [ -n "$PREVIOUS_REF" ]; then
    report rolling_back 0 "$message"
    if restore_previous; then
      report failed 100 "$message (rolled back to $PREVIOUS_REF)"
      exit 1
    fi
    report failed 100 "$message (rollback also failed — service may be down)"
    exit 1
  fi
  report failed 100 "$message"
  exit 1
}

# ---------------------------------------------------------------------------
# The update itself
# ---------------------------------------------------------------------------

build_at() {
  local ref="$1"
  git -C "$INSTALL_DIR" checkout --quiet --force "$ref" || return 1
  # `npm ci` and not `npm install`: the lockfile is the thing under version control,
  # and an update that quietly resolves a different dependency tree than the one that
  # was tested is not the release it claims to be.
  (cd "$INSTALL_DIR" && npm ci --prefer-offline --no-audit --fund=false) || return 1
  (cd "$INSTALL_DIR" && npm run build) || return 1
  [ -f "$INSTALL_DIR/dist/backend/service.js" ] || return 1
  [ -f "$INSTALL_DIR/dist/frontend/index.html" ] || return 1
  # Same ownership install.sh sets: root owns the code, the service account only reads
  # it. The other way round, an attacker who reached the web tier could rewrite the
  # helper's entry point and have sudo run it as root.
  chown -R "root:$SERVICE_GROUP" "$INSTALL_DIR" 2>/dev/null || true
  chmod -R u=rwX,g=rX,o= "$INSTALL_DIR" 2>/dev/null || true
  return 0
}

restore_previous() {
  build_at "$PREVIOUS_REF" || return 1
  systemctl restart "$SERVICE_NAME" || return 1
  wait_for_health || return 1
  return 0
}

# The gate that decides whether the new release stays. Anything short of a green
# /health inside the window counts as a failure — including the service never coming
# back at all, which is the failure mode an operator cannot fix from the web UI they
# just lost.
wait_for_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -ksSf --max-time 5 "$HEALTH_URL" > /dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

report downloading 0 ""
git -C "$INSTALL_DIR" fetch --quiet --tags --force origin ||
  fail "Could not fetch from GitHub"

report verifying 20 ""
git -C "$INSTALL_DIR" rev-parse --verify --quiet "${TARGET_REF}^{commit}" > /dev/null ||
  fail "Release $TARGET_REF does not exist in the repository"

report installing 40 ""
build_at "$TARGET_REF" || fail "Build failed for $TARGET_REF"

report restarting 80 ""
systemctl restart "$SERVICE_NAME" || fail "Service did not restart"

report health_gate 90 ""
wait_for_health || fail "Service did not report healthy within ${HEALTH_TIMEOUT}s"

report done 100 ""
exit 0
