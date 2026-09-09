#!/usr/bin/env bash

set -euo pipefail

# TNC Network Bridge - Installation Script for Raspberry Pi OS Lite
#
# Usage: curl -fsSL https://raw.githubusercontent.com/hsh36/tnc-network-bridge/main/install.sh | bash
#
# This script will:
# - Check system requirements
# - Clone the repository
# - Install Node.js 18+ (if needed)
# - Install dependencies
# - Build the application
# - Configure systemd service
# - Start the service
# - Open setup wizard

set +u  # Disable error on undefined vars for colorized output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color
set -u

# Configuration
REPO_URL="https://github.com/hsh36/tnc-network-bridge.git"
INSTALL_DIR="${HOME}/tnc-bridge"
SERVICE_NAME="tnc-bridge"
SERVICE_USER="tnc-bridge"

# Helper functions
log_info() {
  echo -e "${BLUE}ℹ${NC} $*"
}

log_success() {
  echo -e "${GREEN}✓${NC} $*"
}

log_warn() {
  echo -e "${YELLOW}⚠${NC} $*"
}

log_error() {
  echo -e "${RED}✗${NC} $*"
}

die() {
  log_error "$@"
  exit 1
}

# Check if running on Raspberry Pi OS
check_os() {
  if ! grep -q "Raspberry Pi" /proc/device-tree/model 2>/dev/null && \
     ! grep -q "Raspberry Pi" /proc/cpuinfo 2>/dev/null && \
     ! [ -f /etc/os-release ] || ! grep -q "raspbian\|raspberry" /etc/os-release 2>/dev/null; then
    log_warn "This script is optimized for Raspberry Pi OS Lite"
    log_warn "Continuing anyway, but please ensure Node.js 18+ is installed"
  fi
}

# Install prerequisites
install_prerequisites() {
  log_info "Installing system requirements..."

  # Update package lists
  if command -v apt-get &> /dev/null; then
    sudo apt-get update || true

    # Install required tools
    local required_tools=("curl" "git")
    for tool in "${required_tools[@]}"; do
      if ! command -v "$tool" &> /dev/null; then
        log_info "Installing $tool..."
        sudo apt-get install -y "$tool" || die "Failed to install $tool"
      fi
    done
  else
    die "apt-get not found. This script requires Debian/Ubuntu-based systems."
  fi

  log_success "System requirements installed"
}

# Check and install Node.js 18+
install_nodejs() {
  if command -v node &> /dev/null; then
    local node_version=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$node_version" -ge 18 ]; then
      log_success "Node.js $(node --version) is installed"
      return 0
    fi
  fi

  log_info "Installing Node.js 18..."

  # Detect architecture
  local arch=$(uname -m)
  case "$arch" in
    armv7l) local node_arch="armv7l" ;;
    aarch64) local node_arch="arm64" ;;
    x86_64) local node_arch="x64" ;;
    i686) local node_arch="x86" ;;
    *) die "Unsupported architecture: $arch" ;;
  esac

  # Download and install Node.js
  local node_version="18.19.0"
  local download_url="https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-${node_arch}.tar.xz"

  log_info "Downloading Node.js from $download_url"
  curl -fsSL "$download_url" | tar xJ -C /usr/local --strip-components=1

  log_success "Node.js $(node --version) installed"
}

# Clone repository
clone_repository() {
  log_info "Cloning repository..."

  if [ -d "$INSTALL_DIR" ]; then
    log_warn "Install directory already exists: $INSTALL_DIR"
    log_info "Updating existing installation..."
    cd "$INSTALL_DIR"
    git pull origin main || die "Failed to update repository"
  else
    git clone "$REPO_URL" "$INSTALL_DIR" || die "Failed to clone repository"
    cd "$INSTALL_DIR"
  fi

  log_success "Repository ready at $INSTALL_DIR"
}

# Install dependencies and build
build_application() {
  log_info "Installing dependencies..."
  npm ci --prefer-offline || die "Failed to install dependencies"

  log_info "Building application..."
  npm run build || die "Build failed"

  log_success "Application built successfully"
}

# Create system user (if not exists)
create_system_user() {
  if ! id "$SERVICE_USER" &>/dev/null; then
    log_info "Creating system user: $SERVICE_USER"
    sudo useradd -r -s /bin/bash "$SERVICE_USER" || die "Failed to create system user"
    log_success "System user created"
  else
    log_info "System user already exists: $SERVICE_USER"
  fi
}

# Setup systemd service
setup_systemd() {
  log_info "Setting up systemd service..."

  local service_file="/etc/systemd/system/${SERVICE_NAME}.service"

  # Create service file
  sudo tee "$service_file" > /dev/null <<EOF
[Unit]
Description=TNC Network Bridge - SMB Protocol Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) dist/backend/index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tnc-bridge

# Security hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$INSTALL_DIR

[Install]
WantedBy=multi-user.target
EOF

  # Reload systemd and enable service
  sudo systemctl daemon-reload || die "Failed to reload systemd"
  sudo systemctl enable "$SERVICE_NAME" || die "Failed to enable service"

  log_success "Systemd service configured"
}

# Fix permissions
fix_permissions() {
  log_info "Fixing file permissions..."

  sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" || die "Failed to set ownership"
  sudo chmod -R u+rwX,go-rwx "$INSTALL_DIR" || die "Failed to set permissions"

  log_success "File permissions set"
}

# Start service
start_service() {
  log_info "Starting service..."

  sudo systemctl start "$SERVICE_NAME" || die "Failed to start service"

  # Wait for service to be ready
  sleep 2

  if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    log_success "Service started successfully"
  else
    die "Service failed to start. Check logs with: sudo journalctl -u $SERVICE_NAME -n 50"
  fi
}

# Show final instructions
show_instructions() {
  local ip=$(hostname -I | awk '{print $1}')

  echo ""
  echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  TNC Network Bridge Installation Complete! 🎉${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "📍 Installation directory: ${BLUE}$INSTALL_DIR${NC}"
  echo -e "🔧 Service name: ${BLUE}$SERVICE_NAME${NC}"
  echo ""
  echo -e "🌐 Access the web interface:"
  echo -e "   ${BLUE}https://${ip}:443${NC}"
  echo -e "   ${BLUE}https://localhost:443${NC} (local access)"
  echo ""
  echo -e "📋 Service management:"
  echo -e "   Start:   ${BLUE}sudo systemctl start $SERVICE_NAME${NC}"
  echo -e "   Stop:    ${BLUE}sudo systemctl stop $SERVICE_NAME${NC}"
  echo -e "   Status:  ${BLUE}sudo systemctl status $SERVICE_NAME${NC}"
  echo -e "   Logs:    ${BLUE}sudo journalctl -u $SERVICE_NAME -f${NC}"
  echo ""
  echo -e "⚙️  Next steps:"
  echo -e "   1. Open https://${ip}:443 in your browser"
  echo -e "   2. Complete the setup wizard (network, AD credentials, shares)"
  echo -e "   3. Configure sync policies and file locking as needed"
  echo ""
  echo -e "${YELLOW}Note:${NC} The service runs with a self-signed certificate."
  echo -e "Your browser may show a security warning — this is normal."
  echo ""
}

# Main installation flow
main() {
  echo ""
  echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  TNC Network Bridge Installation${NC}"
  echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
  echo ""

  # Check if running as root (some commands need sudo)
  if [ "$EUID" -eq 0 ] && [ "${SUDO_USER:-}" = "" ]; then
    die "Please run this script without sudo. It will use sudo for necessary commands."
  fi

  check_os
  install_prerequisites
  install_nodejs
  clone_repository
  build_application
  create_system_user
  setup_systemd
  fix_permissions
  start_service
  show_instructions
}

# Error handler
trap 'die "Installation failed"' ERR

# Run installation
main
