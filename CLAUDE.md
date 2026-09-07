# TNC Network Bridge - Development Guide

## Project Overview

**Project Name**: TNC Network Bridge  
**Start Date**: September 2026  
**License**: GNU General Public License v3.0  
**Repository**: [Will be linked to GitHub]

### Purpose

This project aims to build a comprehensive network bridge solution for TNC (Trusted Network Communication) environments, enabling secure and reliable communication across distributed network segments.

## Architecture

[Architecture documentation will be added during planning phase]

## Development Workflow

### Team Composition

- **Lead Architect (Claude Opus 5)**: Overall architecture, complex problem-solving, task coordination
- **Implementation Support (Claude Sonnet 5)**: Component development, auxiliary tasks, testing support

### How to Work with the Agents

1. **Architecture & Planning Phase**: Opus leads the design process
2. **Implementation Phase**: Opus coordinates overall implementation, can delegate to Sonnet for:
   - Component implementation
   - Unit testing
   - Documentation
   - Refactoring tasks
3. **Review & Integration**: Opus reviews and integrates Sonnet's work

### Development Standards

#### Code Style
- [To be defined during architecture phase]

#### Testing
- [To be defined during architecture phase]

#### Documentation
- All public APIs must be documented
- Complex algorithms should include implementation notes
- See code comments for inline documentation

#### Git Workflow

- Branch naming: `feature/`, `bugfix/`, `docs/`, `refactor/`
- Commit messages: Clear, descriptive, reference issue numbers where applicable
- PR reviews: All PRs require review before merging to main

## Getting Started

### Initial Setup

```bash
# Clone repository
git clone https://github.com/yourusername/tnc-network-bridge.git

# Install dependencies
npm install

# Run tests
npm test
```

### Project Structure

```
tnc-network-bridge/
├── src/                 # Source code
├── tests/              # Test files
├── docs/               # Documentation
├── .github/            # GitHub configuration
└── CLAUDE.md          # This file
```

## Planning Phase

During the planning phase, we will:
1. Define overall architecture and design patterns
2. Break down the project into manageable components
3. Establish coding standards and best practices
4. Create detailed implementation plan
5. Assign initial tasks to Opus and Sonnet

## Next Steps

- [ ] Architecture & design planning
- [ ] GitHub repository creation and public configuration
- [ ] Project structure finalization
- [ ] Task breakdown and delegation to agents
- [ ] Implementation begins

---

**Updated**: September 7, 2026
