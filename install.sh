#!/usr/bin/env bash

# TNC Network Bridge - Installation Script for Raspberry Pi OS Lite
#
# Usage: curl -fsSL https://raw.githubusercontent.com/hsh36/tnc-network-bridge/main/install.sh | bash
#
# This script will:
# - Check system requirements and install the packages the bridge shells out to
# - Install Node.js (if the running version is too old)
# - Clone and build the application into /opt
# - Create the service account and the privilege-separation helper
# - Create the runtime directories and the secret key
# - Configure and start the systemd service
#
# `set -E` matters: without it an ERR trap is not inherited by shell functions, and every
# failure inside one of the functions below would abort the script with no message at all.
set -Eeuo pipefail

set +u # Disable error on undefined vars for colorized output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color
set -u

# Configuration
REPO_URL="https://github.com/hsh36/tnc-network-bridge.git"
# /opt, not $HOME: the unit below sets ProtectHome=yes, under which a WorkingDirectory
# inside /home does not exist as far as the service is concerned.
INSTALL_DIR="/opt/tnc-bridge"
SERVICE_NAME="tnc-bridge"
# Must match `SERVICE_GROUP` in src/backend/privileged/handlers.ts and the `%tncbridge`
# rule in install/sudoers.d/tnc-bridge — sudo silently refuses a group that never matches.
SERVICE_USER="tncbridge"
SERVICE_GROUP="tncbridge"

# The package.json `engines` floor. Node 18 cannot run this build.
NODE_MAJOR_MIN=22
NODE_VERSION="22.23.2"

CONFIG_DIR="/etc/tnc-bridge"
STATE_DIR="/var/lib/tnc-bridge"
LOG_DIR="/var/log/tnc-bridge"
# Parent of every share's cache_path (/srv/tnc/<name>, see 001_init.sql).
CACHE_DIR="/srv/tnc"
# Parent of every share's mount_point. The service mounts the server export below here,
# so it has to exist and be owned by the service account before the first reconcile.
MOUNT_DIR="/mnt/tnc-server"
SECRET_KEY="${CONFIG_DIR}/secret.key"
HELPER_DIR="/usr/local/lib/tnc-bridge"
HELPER_PATH="${HELPER_DIR}/helper"
SUDOERS_PATH="/etc/sudoers.d/tnc-bridge"

# Helper functions
log_info() {
  echo -e "${BLUE}i${NC} $*"
}

log_success() {
  echo -e "${GREEN}OK${NC} $*"
}

log_warn() {
  echo -e "${YELLOW}!${NC} $*"
}

log_error() {
  echo -e "${RED}x${NC} $*" >&2
}

die() {
  log_error "$@"
  exit 1
}

# Confirm we can actually become root before doing half an installation.
#
# When this script is piped from curl, stdin is the pipe, so sudo cannot read a password
# from it. sudo prompts on /dev/tty instead, which exists in an interactive shell and does
# not exist under `ssh host 'curl ... | bash'` — the case where a mid-run prompt would
# otherwise hang forever with no output.
require_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    die "Do not run this script as root. It uses sudo for the steps that need it, and
   building as root would leave the working tree owned by the wrong user."
  fi

  if sudo -n true 2>/dev/null; then
    return 0
  fi

  if [ ! -t 0 ] && [ ! -e /dev/tty ]; then
    die "sudo needs a password but there is no terminal to ask on.
   Run 'sudo -v' first, then re-run this installer."
  fi

  log_info "Requesting sudo access..."
  sudo -v < /dev/tty || die "sudo authentication failed"
}

# Warn when this is not a Raspberry Pi.
#
# Each indicator is checked on its own. The obvious one-liner — chaining them with && and
# || — does not do what it looks like: those operators are left-associative and do not
# group, so the last check decides the result and a genuine Pi still gets the warning.
check_os() {
  if grep -qi "raspberry pi" /proc/device-tree/model 2>/dev/null; then
    return 0
  fi
  if grep -qi "raspberry pi" /proc/cpuinfo 2>/dev/null; then
    return 0
  fi
  if grep -qi "raspbian\|raspberry" /etc/os-release 2>/dev/null; then
    return 0
  fi
  log_warn "This script is optimized for Raspberry Pi OS Lite"
  log_warn "Continuing anyway, but please ensure Node.js ${NODE_MAJOR_MIN}+ is available"
}

# Install prerequisites
#
# The runtime packages are not optional extras: the bridge does not reimplement SMB,
# firewalling or DHCP, it drives the system's own daemons through the privileged helper
# (see src/backend/privileged/exec.ts for the exact binaries). Installing them here is
# what keeps the first failure from being a missing binary three screens into the setup
# wizard.
install_prerequisites() {
  log_info "Installing system requirements..."

  command -v apt-get > /dev/null 2>&1 ||
    die "apt-get not found. This script requires Debian/Ubuntu-based systems."

  sudo apt-get update || log_warn "apt-get update reported an error; continuing"

  local packages=(
    curl git ca-certificates xz-utils
    samba samba-common-bin smbclient cifs-utils
    nftables fail2ban dnsmasq network-manager
  )

  # DEBIAN_FRONTEND keeps a package's post-install script from trying to open a dialog on
  # a terminal that is not there.
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}" ||
    die "Failed to install required packages"

  # dnsmasq answers DNS on port 53 the moment it is installed, which on a bridge that is
  # not yet configured means hijacking name resolution for whatever is plugged into the
  # TNC port. The DHCP server is opt-in in the web UI, and the helper starts it there.
  sudo systemctl disable --now dnsmasq > /dev/null 2>&1 || true

  # Samba, in contrast, is the machine-facing half of the product and must come back on
  # its own after a reboot. It is safe to enable before it is configured: the service
  # writes an smb.conf bound to the TNC interface at startup, and until it does, Debian's
  # stock file binds nothing this bridge exposes.
  #
  # nmbd as well as smbd. A TNC on SMB1 finds its server by NetBIOS name broadcast, not
  # by DNS, so without nmbd the share is reachable by address and invisible by name —
  # which on a control configured years ago with a name is the same as not working.
  sudo systemctl enable smbd nmbd > /dev/null 2>&1 || log_warn "Could not enable smbd/nmbd"

  log_success "System requirements installed"
}

# Check and install Node.js
install_nodejs() {
  if command -v node > /dev/null 2>&1; then
    local current
    current="$(node --version | sed 's/^v//' | cut -d. -f1)"
    if [ "$current" -ge "$NODE_MAJOR_MIN" ]; then
      log_success "Node.js $(node --version) is installed"
      return 0
    fi
    log_warn "Node.js $(node --version) is too old; ${NODE_MAJOR_MIN}+ is required"
  fi

  log_info "Installing Node.js ${NODE_VERSION}..."

  local arch node_arch
  arch="$(uname -m)"
  case "$arch" in
    armv7l) node_arch="armv7l" ;;
    aarch64) node_arch="arm64" ;;
    x86_64) node_arch="x64" ;;
    *) die "Unsupported architecture: $arch" ;;
  esac

  local url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  # No template with a suffix: mktemp requires the X's to end the name, and tar reads the
  # compression from the stream rather than from the file name anyway.
  local tarball
  tarball="$(mktemp)"
  # shellcheck disable=SC2064 # $tarball is fixed at trap time on purpose.
  trap "rm -f '$tarball'" RETURN

  log_info "Downloading Node.js from $url"
  curl -fsSL "$url" -o "$tarball" || die "Failed to download Node.js"
  # Unpacking into /usr/local writes as root. Piping curl straight into tar without sudo
  # fails on every single entry, and does so after the download has already succeeded.
  sudo tar xJf "$tarball" -C /usr/local --strip-components=1 ||
    die "Failed to unpack Node.js into /usr/local"

  hash -r
  command -v node > /dev/null 2>&1 || die "Node.js was unpacked but 'node' is not on PATH"
  log_success "Node.js $(node --version) installed"
}

# Clone repository
#
# The tree is owned by the invoking user for the duration of the build so that npm never
# runs as root, and handed to root:$SERVICE_GROUP at the end (see fix_permissions).
clone_repository() {
  log_info "Preparing $INSTALL_DIR..."

  sudo mkdir -p "$INSTALL_DIR" || die "Failed to create $INSTALL_DIR"
  sudo chown -R "$(id -u):$(id -g)" "$INSTALL_DIR" || die "Failed to take ownership of $INSTALL_DIR"

  if [ -d "$INSTALL_DIR/.git" ]; then
    log_info "Updating existing installation..."
    git -C "$INSTALL_DIR" fetch --quiet origin main || die "Failed to fetch updates"
    git -C "$INSTALL_DIR" reset --hard --quiet origin/main || die "Failed to update repository"
  else
    # An existing but empty (or partially populated) directory would make `git clone`
    # refuse; cloning beside it and moving the contents in keeps re-runs working.
    local staging
    staging="$(mktemp -d)"
    git clone --quiet "$REPO_URL" "$staging/repo" || die "Failed to clone repository"
    # shellcheck disable=SC2086 # Word splitting of the glob is what moves the entries.
    (shopt -s dotglob && mv "$staging"/repo/* "$INSTALL_DIR"/) ||
      die "Failed to populate $INSTALL_DIR"
    rm -rf "$staging"
  fi

  log_success "Repository ready at $INSTALL_DIR"
}

# Install dependencies and build
build_application() {
  log_info "Installing dependencies..."
  (cd "$INSTALL_DIR" && npm ci --prefer-offline --no-audit --fund=false) ||
    die "Failed to install dependencies"

  log_info "Building application (this takes a few minutes on a Pi)..."
  (cd "$INSTALL_DIR" && npm run build) || die "Build failed"

  [ -f "$INSTALL_DIR/dist/backend/service.js" ] ||
    die "Build finished but dist/backend/service.js is missing"
  [ -f "$INSTALL_DIR/dist/frontend/index.html" ] ||
    die "Build finished but the admin UI bundle is missing"

  log_success "Application built successfully"
}

# Create the service account
#
# A system account with no home and no login shell: it exists to own a process and a few
# directories, and nothing should ever be able to log in as it.
create_system_user() {
  if getent group "$SERVICE_GROUP" > /dev/null 2>&1; then
    log_info "Service group already exists: $SERVICE_GROUP"
  else
    sudo groupadd --system "$SERVICE_GROUP" || die "Failed to create group $SERVICE_GROUP"
    log_success "Service group created: $SERVICE_GROUP"
  fi

  if id "$SERVICE_USER" > /dev/null 2>&1; then
    log_info "Service user already exists: $SERVICE_USER"
  else
    sudo useradd --system --gid "$SERVICE_GROUP" --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER" ||
      die "Failed to create system user $SERVICE_USER"
    log_success "Service user created: $SERVICE_USER"
  fi
}

# Runtime directories and the secret key
#
# The key encrypts stored credentials (the AD service account among them). It is created
# once and never regenerated: a new key would not fail loudly, it would turn every stored
# credential into undecryptable bytes.
create_runtime_dirs() {
  log_info "Creating runtime directories..."

  local dir
  for dir in "$CONFIG_DIR" "$CONFIG_DIR/tls" "$STATE_DIR" "$LOG_DIR" "$CACHE_DIR" "$MOUNT_DIR"; do
    sudo install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$dir" ||
      die "Failed to create $dir"
  done

  # `sudo test`, not `[ -f ]`. This script runs as the invoking user, and $CONFIG_DIR is
  # 0750 owned by the service account — so an unprivileged existence check on a file
  # inside it is false whether or not the file is there. Getting this wrong regenerated
  # the key on *every* update, and a new key does not fail loudly: it silently turns
  # every stored credential, including the AD service account and every share password,
  # into bytes nothing can decrypt.
  if sudo test -f "$SECRET_KEY"; then
    log_info "Secret key already present; keeping it"
  else
    log_info "Generating secret key..."
    local staged
    # umask 077 before the file exists: a key that is world-readable even for the second
    # between creation and chmod is a key that a local process could have copied.
    staged="$(umask 077 && mktemp)"
    # 64 hex characters, the format loadSecretKey() expects. openssl is not a hard
    # dependency, so /dev/urandom is the fallback rather than a failed install.
    if command -v openssl > /dev/null 2>&1; then
      openssl rand -hex 32 > "$staged"
    else
      head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$staged"
      printf '\n' >> "$staged"
    fi
    sudo install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0600 "$staged" "$SECRET_KEY" ||
      die "Failed to install the secret key"
    rm -f "$staged"
    log_success "Secret key created at $SECRET_KEY"
  fi

  # loadSecretKey() refuses any key with a group or other bit set, so a key left over
  # from an earlier, laxer install must be tightened rather than tolerated.
  sudo chown "$SERVICE_USER:$SERVICE_GROUP" "$SECRET_KEY"
  sudo chmod 0600 "$SECRET_KEY"

  log_success "Runtime directories ready"
}

# Install the privilege-separation helper
#
# The service account runs the Node process and owns nothing privileged. This helper, and
# only this helper, is reachable through sudo, takes no arguments, and reads its request
# as JSON on stdin (see install/sudoers.d/tnc-bridge for why).
install_privileged_helper() {
  log_info "Installing the privileged helper..."

  local node_bin
  node_bin="$(command -v node)"

  sudo install -d -o root -g root -m 0755 "$HELPER_DIR" || die "Failed to create $HELPER_DIR"

  local wrapper
  wrapper="$(mktemp)"
  cat > "$wrapper" <<HELPER
#!/bin/sh
# Installed by install.sh - do not edit.
#
# No "\$@": the sudoers rule matches this command with no arguments at all, and the
# helper itself refuses argv. The request is read from stdin as JSON.
exec ${node_bin} ${INSTALL_DIR}/dist/backend/privileged/main.js
HELPER
  sudo install -o root -g root -m 0755 "$wrapper" "$HELPER_PATH" ||
    die "Failed to install $HELPER_PATH"
  rm -f "$wrapper"

  local sudoers_src="$INSTALL_DIR/install/sudoers.d/tnc-bridge"
  [ -f "$sudoers_src" ] || die "Missing $sudoers_src"

  # A malformed file in /etc/sudoers.d breaks sudo for every user on the machine, so it
  # is validated before it is installed, not after.
  sudo visudo -cf "$sudoers_src" > /dev/null || die "$sudoers_src failed validation"
  sudo install -o root -g root -m 0440 "$sudoers_src" "$SUDOERS_PATH" ||
    die "Failed to install $SUDOERS_PATH"

  log_success "Privileged helper installed"
}

# Fix permissions
#
# root owns the code, the service account only reads it. The other way round, an attacker
# who reached the web tier could rewrite dist/backend/privileged/main.js and then have
# sudo run it as root — which would make the privilege separation above decorative.
fix_permissions() {
  log_info "Fixing file permissions..."

  sudo chown -R "root:$SERVICE_GROUP" "$INSTALL_DIR" || die "Failed to set ownership"
  sudo chmod -R u=rwX,g=rX,o= "$INSTALL_DIR" || die "Failed to set permissions"

  log_success "File permissions set"
}

# Setup systemd service
setup_systemd() {
  log_info "Setting up systemd service..."

  local node_bin
  node_bin="$(command -v node)"

  sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null <<UNIT
[Unit]
Description=TNC Network Bridge - SMB Protocol Bridge
Documentation=https://github.com/hsh36/tnc-network-bridge
After=network-online.target
Wants=network-online.target

[Service]
# notify, not simple: the service tells systemd when its subsystems are actually up, so
# units ordered after it do not start against a bridge that is still opening its database.
Type=notify
NotifyAccess=all
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
ExecStart=${node_bin} ${INSTALL_DIR}/dist/backend/service.js
Restart=always
RestartSec=10
TimeoutStartSec=120
WatchdogSec=60
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tnc-bridge

# Binding 443 as a non-root user needs this one capability and nothing else.
AmbientCapabilities=CAP_NET_BIND_SERVICE

# CapabilityBoundingSet is deliberately NOT narrowed to that one capability, for the
# same reason NoNewPrivileges is off below. The bounding set caps what *any* process in
# this unit may ever hold, sudo included — and sudo is setuid-root, so with a bounding
# set of CAP_NET_BIND_SERVICE alone it cannot even change to the root gid:
#
#   sudo: unable to change to root gid: Operation not permitted
#
# Every privileged operation the bridge performs goes through 'sudo ${HELPER_PATH}', so
# narrowing it does not harden the service, it silently disables network changes, Samba
# and dnsmasq configuration, the firewall and certificate installation.

# Security hardening.
#
# NoNewPrivileges is deliberately NOT set: the whole privilege-separation design routes
# root operations through 'sudo ${HELPER_PATH}', and NoNewPrivileges makes any setuid
# binary - sudo included - fail. Setting it would not harden the service, it would break
# every network, SMB and firewall change and leave the UI reporting mysterious errors.
#
# ProtectSystem and ProtectKernelTunables are off for the same reason. A process started
# through sudo inherits this unit's mount namespace, so a read-only /etc is read-only for
# the helper too — which is the one process whose entire job is writing /etc/samba,
# /etc/dnsmasq.d and /etc/nftables.d as root:
#
#   ENOENT: no such file or directory, mkdir '/etc/nftables.d'
#
# What keeps the service away from those paths is not the namespace, it is that the
# service runs as ${SERVICE_USER} and does not own them. The namespace only ever stopped
# the helper.
PrivateTmp=yes
ProtectHome=yes
ProtectControlGroups=yes
RestrictSUIDSGID=no
RestrictNamespaces=yes
LockPersonality=yes
# ProtectHome hides /home; these are the paths the service itself writes to, listed so
# that a later tightening of ProtectSystem does not have to rediscover them. The install
# directory is deliberately not among them — the service reads its own code, never
# writes it.
ReadWritePaths=${STATE_DIR} ${LOG_DIR} ${CONFIG_DIR} ${CACHE_DIR} ${MOUNT_DIR}

[Install]
WantedBy=multi-user.target
UNIT

  sudo systemctl daemon-reload || die "Failed to reload systemd"
  sudo systemctl enable "$SERVICE_NAME" > /dev/null || die "Failed to enable service"

  log_success "Systemd service configured"
}

# Verify the installation before handing it to systemd
#
# A self-test that runs the real startup path turns "the unit keeps restarting" into a
# named cause - an unreadable key, a schema behind the code - while the operator is still
# looking at the installer's output.
self_check() {
  log_info "Running self-check..."
  local node_bin
  node_bin="$(command -v node)"

  if sudo -u "$SERVICE_USER" "$node_bin" "$INSTALL_DIR/dist/backend/index.js" --check; then
    log_success "Self-check passed"
  else
    die "Self-check failed. The service was not started; see the output above."
  fi
}

# Start service
start_service() {
  log_info "Starting service..."

  sudo systemctl restart "$SERVICE_NAME" ||
    die "Failed to start service. Check: sudo journalctl -u $SERVICE_NAME -n 50"

  # systemd returns from `restart` once the unit reports ready (Type=notify), but give a
  # crash-on-first-request a moment to show up before declaring success.
  sleep 2

  if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    log_success "Service started successfully"
  else
    log_error "Service failed to start. Recent log:"
    sudo journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2 || true
    die "Installation aborted"
  fi
}

# Show final instructions
show_instructions() {
  local ip
  ip="$(hostname -I | awk '{print $1}')"

  echo ""
  echo -e "${GREEN}============================================================${NC}"
  echo -e "${GREEN}  TNC Network Bridge Installation Complete!${NC}"
  echo -e "${GREEN}============================================================${NC}"
  echo ""
  echo -e "Installation directory: ${BLUE}$INSTALL_DIR${NC}"
  echo -e "Service name:           ${BLUE}$SERVICE_NAME${NC}"
  echo ""
  echo -e "Access the web interface:"
  echo -e "   ${BLUE}https://${ip}/${NC}"
  echo ""
  echo -e "Service management:"
  echo -e "   Status:  ${BLUE}sudo systemctl status $SERVICE_NAME${NC}"
  echo -e "   Logs:    ${BLUE}sudo journalctl -u $SERVICE_NAME -f${NC}"
  echo -e "   Restart: ${BLUE}sudo systemctl restart $SERVICE_NAME${NC}"
  echo ""
  echo -e "Next steps:"
  echo -e "   1. Open https://${ip}/ in your browser"
  echo -e "   2. Complete the setup wizard (network, AD credentials, shares)"
  echo -e "   3. Configure sync policies and file locking as needed"
  echo ""
  echo -e "${YELLOW}Note:${NC} The service uses a self-signed certificate on first start."
  echo -e "Your browser will show a security warning - this is expected."
  echo ""
}

# Main installation flow
main() {
  echo ""
  echo -e "${BLUE}============================================================${NC}"
  echo -e "${BLUE}  TNC Network Bridge Installation${NC}"
  echo -e "${BLUE}============================================================${NC}"
  echo ""

  require_sudo
  check_os
  install_prerequisites
  install_nodejs
  clone_repository
  build_application
  create_system_user
  create_runtime_dirs
  install_privileged_helper
  fix_permissions
  setup_systemd
  self_check
  start_service
  show_instructions
}

# Error handler. Reached only for a failure that was not already reported by die().
trap 'log_error "Installation failed at line $LINENO"' ERR

main
