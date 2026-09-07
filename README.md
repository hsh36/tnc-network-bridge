# TNC Network Bridge

> A robust network bridge solution for TNC (Trusted Network Communication) environments.

## Overview

The TNC Network Bridge is a **SMB Protocol Bridge** designed to connect HEIDENHAIN TNC-controlled machines (supporting only SMB 1.0) with modern server environments (SMB 3.1.1+). Running on a Raspberry Pi 5, it provides real-time file synchronization, file locking, and a comprehensive web-based management interface.

This solves the security challenge of bridging legacy SMB 1.0 CNC machines with hardened modern networks without exposing vulnerabilities.

## Features

- Secure network bridging capabilities
- Real-time connection management
- Distributed architecture support
- Comprehensive logging and monitoring
- Extensible plugin system

## Project Status

🚧 **In Development** - Project initialization phase

## Hardware Requirements

**Minimum**: Raspberry Pi 5 (4GB RAM, dual Ethernet via USB adapter)  
**Recommended**: Raspberry Pi 5 (8GB RAM) + Waveshare Multi-functional All-in-one Mini-Computer Kit BOX-A (integrated dual Ethernet)

**OS**: Raspberry Pi OS Lite (64-bit)

## Software Prerequisites

- Node.js 18+
- Git
- Samba/SMB utilities
- systemd (included in RPi OS)

## Quick Installation

**One-liner for Raspberry Pi OS Lite:**

```bash
curl -fsSL https://raw.githubusercontent.com/hsh36/tnc-network-bridge/main/install.sh | bash
```

This will:
- Clone the repository
- Install all dependencies
- Configure systemd service
- Start the bridge and web interface
- Open setup wizard at https://localhost:443

**Manual Installation:**

```bash
git clone https://github.com/hsh36/tnc-network-bridge.git
cd tnc-network-bridge
npm install
npm run build
sudo npm run install:service
sudo systemctl start tnc-bridge
```

## Web Interface

Access the management interface at: **https://localhost:443**

### Features
- **Dashboard**: Live status, connection health, performance metrics
- **Configuration**: Network, SMB, AD service account, update schedule
- **Logging**: Comprehensive sync and error logs
- **File Locking**: View active locks and conflicts
- **Monitoring**: Disk usage, sync performance, system info
- **REST API**: For external monitoring integration (e.g., PRTG)

### Default Credentials
- Username: `admin`
- Password: Set on first startup (wizard)

## Development

### Architecture

The bridge operates with:
1. **LAN Interface** (Primary Ethernet): Connects to server-side SMB 3.1.1+ shares
2. **TNC Interface** (Secondary Ethernet): Provides SMB 1.0-compatible shares to CNC machines
3. **Local Sync Engine**: Real-time bidirectional file synchronization with conflict resolution
4. **Web Service**: HTTPS management interface (443)
5. **REST API**: Machine-readable status and metrics

See source code for detailed architecture.

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](./LICENSE) file for details.

## Contributing

Contributions are welcome! Please contact the maintainers before starting.

## Support

For issues, questions, or suggestions, please open an issue on GitHub.

## Troubleshooting

See logs in the web interface under **Logs → Sync/Error Logs** or via:
```bash
sudo journalctl -u tnc-bridge -f
```

## Maintainer

**GitHub**: [@hsh36](https://github.com/hsh36)

---

**Project Start Date**: September 2026  
**Status**: Active Development
