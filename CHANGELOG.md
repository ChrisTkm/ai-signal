# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-06-15

### Added

- Read-only **MCP server** (`src/mcp/`) over stdio (JSON-RPC 2.0), with zero
  runtime dependencies. Signal's path out of VS Code: a standalone process any
  MCP client can consume.
  - Tools: `signal_get_top`, `signal_search`, `signal_get_digest`,
    `signal_get_item`, `signal_get_groups`.
  - Projects the local cache into the documented public schema; accepts group
    names or slugs; derives `period` from `ageHours`; reports cache freshness.
  - Configurable via `SIGNAL_CACHE_PATH` and `SIGNAL_CONFIG_PATH`.
  - 14 unit tests for the tool/projection logic.

### Changed

- Documentation and install steps now use **pnpm** (`pnpm dlx`, `pnpm mcp`)
  instead of npm/npx.

## [0.1.0] - 2026-06-14

### Added

- VS Code status-bar extension with a compact ranked panel for public
  technical activity.
- Local Hacker News collector (`scripts/hn-smoke.mjs`) writing a ranked cache
  and markdown digest under `.ai-signal/`.
- Personal feed groups (Cargo Bay, Cortex Feed, Deep Space Relay, Nostromo
  Finance) with strict keyword/domain matching.
- Pure classification/ranking core (`scripts/lib/signal-core.mjs`) with
  `node:test` unit tests.

[0.1.1]: https://github.com/ChrisTkm/ai-signal/releases/tag/v0.1.1
[0.1.0]: https://github.com/ChrisTkm/ai-signal/releases/tag/v0.1.0
