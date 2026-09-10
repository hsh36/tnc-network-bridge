#!/usr/bin/env bash
#
# Raspberry Pi OS package updates.
#
# Run as root by the privileged helper, inside a transient systemd unit. Not because
# this restarts the bridge — it does not — but because an apt run on a Pi takes minutes
# and must not be tied to the lifetime of an HTTP request, and because rebooting from
# inside the service's own cgroup is a good way to be killed halfway through.
#
#   os-update.sh [--reboot]
#
# Progress goes to a status file, read back by the service the same way self-update.sh's
# is. That matters most in the reboot case, which is the one where nothing in memory
# survives to report what happened.

set -uo pipefail

STATE_DIR="${TNC_STATE_DIR:-/var/lib/tnc-bridge}"
STATUS_FILE="${STATE_DIR}/os-update-status.json"
SERVICE_USER="${TNC_SERVICE_USER:-tncbridge}"
LOG_FILE="${STATE_DIR}/os-update.log"

REBOOT=no
[ "${1:-}" = "--reboot" ] && REBOOT=yes

export DEBIAN_FRONTEND=noninteractive

report() {
  local phase="$1" pct="$2" detail="${3:-}"
  local tmp="${STATUS_FILE}.tmp"

  mkdir -p "$STATE_DIR" 2>/dev/null || true
  {
    printf '{"phase":"%s","progressPct":%s,"reboot":"%s","ts":%s' \
      "$phase" "$pct" "$REBOOT" "$(date +%s)"
    if [ -n "$detail" ]; then
      printf ',"detail":"%s"' "$(printf '%s' "$detail" | tr -d '"\\' | tr '\n' ' ')"
    fi
    printf '}\n'
  } > "$tmp" && mv -f "$tmp" "$STATUS_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$STATUS_FILE" 2>/dev/null || true

  echo "[os-update] $phase ${pct}% ${detail}"
}

run_apt() {
  # Output is kept: when an upgrade breaks something, the operator needs to see which
  # packages moved, and journalctl for a transient unit is easy to lose.
  "$@" >> "$LOG_FILE" 2>&1
}

mkdir -p "$STATE_DIR" 2>/dev/null || true
: > "$LOG_FILE"
chown "$SERVICE_USER:$SERVICE_USER" "$LOG_FILE" 2>/dev/null || true

report refreshing 10 ""
run_apt apt-get update || {
  report failed 100 "apt-get update failed"
  exit 1
}

# `upgrade`, never `dist-upgrade` (`full-upgrade`). dist-upgrade is allowed to *remove*
# packages to resolve a dependency change, and on an appliance the thing it removes
# unattended could be cifs-utils or network-manager — which is to say the machine's
# reason for existing, or its way back onto the network.
report upgrading 40 ""
run_apt apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade || {
  report failed 100 "apt-get upgrade failed — see os-update.log"
  exit 1
}

report cleaning 80 ""
run_apt apt-get -y autoremove || true

# Whether a reboot is actually needed, as opposed to whether one was asked for. A kernel
# or libc upgrade leaves this file; nothing else should cost the machine its uptime.
NEEDED=no
[ -f /var/run/reboot-required ] && NEEDED=yes

if [ "$REBOOT" = yes ] && [ "$NEEDED" = yes ]; then
  report rebooting 95 "reboot required by an upgraded package"
  # Deferred by a few seconds so this status write lands and the unit exits cleanly
  # before init starts tearing the system down.
  shutdown -r +1 "TNC Bridge: rebooting after system updates" >> "$LOG_FILE" 2>&1 || {
    report failed 100 "could not schedule the reboot"
    exit 1
  }
  exit 0
fi

if [ "$NEEDED" = yes ]; then
  report done 100 "a reboot is required to finish"
else
  report done 100 ""
fi
exit 0
