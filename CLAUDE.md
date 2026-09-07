# TNC Network Bridge - Development Guide

**⚠️ NOTE: This file is local-only (see .gitignore) and not pushed to GitHub. Use for development reference only.**

## Project Overview

**Project Name**: TNC Network Bridge  
**GitHub**: [@hsh36/tnc-network-bridge](https://github.com/hsh36/tnc-network-bridge)  
**Start Date**: September 2026  
**License**: GNU General Public License v3.0  
**Maintainer**: hsh36

### Purpose

**SMB Protocol Bridge** for HEIDENHAIN TNC CNC machines. The bridge connects legacy SMB 1.0-only machines to modern SMB 3.1.1+ server environments via a Raspberry Pi 5, providing:
- Real-time bidirectional file synchronization
- Intelligent file locking during edits
- Secure HTTPS management interface
- REST API for monitoring integration

## Technical Specifications

### Hardware
- **Target**: Raspberry Pi 5 (8GB RAM recommended)
- **Networking**: Dual Ethernet (onboard + Waveshare Box-A)
  - **LAN Interface**: Connection to modern server (SMB 3.1.1+)
  - **TNC Interface**: Bridge to CNC machines (SMB 1.0)

### OS & Runtime
- **OS**: Raspberry Pi OS Lite (64-bit)
- **Runtime**: Node.js 18+
- **Language**: TypeScript 5 (strict mode)
- **Database**: SQLite for config/logs

### Core Features

#### 1. File Synchronization
- Real-time bidirectional sync (LAN ↔ Local ↔ TNC)
- Chokidar-based file watching
- Bandwidth-aware syncing
- Selective sync patterns

#### 2. File Locking & Conflict Resolution
- File locking when opened on TNC machines
- Conflict modes: **TNC Wins** / **Server Wins** / **Last Write Wins** (default)
- Automatic failover to read-only if server unreachable
- Conflict log for troubleshooting

#### 3. Web Management Interface (HTTPS/443)
- **Authentication**: Session-based, timeout configurable
- **Dashboard**: Live status, performance metrics, active locks
- **Configuration**:
  - Network settings (LAN/TNC interfaces, DHCP options)
  - AD Service Account credentials + connection test
  - IPv6 enable/disable
  - Auto-update scheduling (day/time)
  - GitHub self-update configuration
  - SMB protocol preferences
- **Logging**: Comprehensive sync/error logs with filters
- **Monitoring**: Disk usage, sync throughput, system health
- **Security**: 
  - Self-signed or custom SSL certificates
  - Fail2Ban integration (brute-force protection)
  - Firewall rules configuration (default: allow all)

#### 4. Advanced Features
- **Multi-TNC Support**: Simultaneous connections from multiple CNC machines
- **File Versioning**: Local version history with restore capability
- **Scheduling**: Automatic file lock/unlock periods (default: no locks)
- **REST API**: Status, metrics, logs (for PRTG integration, etc.)
- **Auto-Updates**: 
  - GitHub-based updates (configurable schedule)
  - Auto-restart after updates (day/time configurable)
- **Monitoring**: systemd integration, journalctl logging

## Architecture

### Component Structure
```
tnc-network-bridge/
├── src/
│   ├── backend/              # Node.js/Express server
│   │   ├── sync/            # File sync engine
│   │   ├── smb/             # SMB protocol handling
│   │   ├── web/             # REST API & web routes
│   │   ├── config/          # Configuration management
│   │   └── security/        # Auth, SSL, firewall
│   ├── frontend/            # React/TypeScript UI
│   │   ├── components/      # Dashboard, forms, logs
│   │   ├── pages/           # Dashboard, Config, Logs, Monitoring
│   │   └── api/             # Frontend API client
│   └── cli/                 # Installation & management scripts
├── tests/                   # Unit & integration tests
├── docs/                    # API docs, guides
├── scripts/
│   ├── install.sh           # One-liner installation script
│   └── systemd-setup.sh     # systemd service configuration
└── package.json
```

### Data Flow
1. **Server Side**: Modern SMB 3.1.1+ share → Local Sync Engine (via AD credentials)
2. **Sync Engine**: File watcher + diff engine → Local cache (SQLite index)
3. **TNC Side**: Local share → SMB 1.0-compatible Samba instance
4. **Locking**: File open on TNC → Lock entry in DB → Server-side file lock
5. **Web UI**: HTTPS API calls → Config management → systemd services

## Development Workflow

### Agents
- **Opus 5**: Architecture, core sync engine, security features, task coordination
- **Sonnet 5**: Web UI components, tests, documentation, auxiliary implementations

### Code Standards

#### TypeScript
- Strict mode enforced
- ESLint with @typescript-eslint
- No `any` types without justification
- Comprehensive JSDoc comments for public APIs

#### Testing
- Jest + ts-jest
- Unit tests for all sync logic
- Integration tests for SMB operations
- Test coverage target: 80%+

#### Git Workflow
- Branches: `feature/`, `bugfix/`, `docs/`, `refactor/`
- All PRs require code review
- Commit messages: Clear, reference related features
- Squash commits before merge

## Installation & Setup

### For Development
```bash
git clone https://github.com/hsh36/tnc-network-bridge.git
cd tnc-network-bridge
npm install
npm run dev
```

### For Production (Raspberry Pi)
```bash
curl -fsSL https://raw.githubusercontent.com/hsh36/tnc-network-bridge/main/install.sh | bash
```

### Configuration
After installation, access https://localhost:443 and run the setup wizard:
1. Set admin password
2. Configure LAN/TNC network interfaces
3. Add AD service account
4. Test connectivity
5. Configure sync behavior & schedules

## Implementation Phases

### Phase 1: Core (Current)
- File sync engine (LAN ↔ Local)
- SMB bridge (Local ↔ TNC, v1.0 compatible)
- Basic file locking
- Web UI dashboard & config
- REST API (monitoring)

### Phase 2: Polish
- File versioning UI
- Advanced scheduling
- Comprehensive logging analysis tools
- Performance optimization

### Phase 3: Enterprise (Optional)
- Multi-instance clustering
- Replication across regions
- Advanced analytics

## Key Decisions

1. **Conflict Resolution**: Last-Write-Wins (default), configurable per user
2. **Failover**: Read-only mode if server unreachable
3. **Security**: No external network access assumed (internal only)
4. **Updates**: GitHub-based auto-update + manual trigger option
5. **Database**: SQLite for simplicity on RPi (no separate DB service)

## Debugging & Testing

### Logs
```bash
# Application logs
sudo journalctl -u tnc-bridge -f

# Web UI logs
tail -f logs/web.log

# Sync logs
tail -f logs/sync.log
```

### Testing Sync
```bash
npm run test:sync   # Sync engine tests
npm run test:smb    # SMB protocol tests
npm run test:web    # Web API tests
```

---

**Last Updated**: September 7, 2026  
**Status**: Architecture & Planning Phase Complete → Ready for Implementation
