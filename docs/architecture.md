# ai-signal Architecture Notes

## Product Shape

`ai-signal` is a local signal collector for VS Code and AI assistants.

The product name is `Signal`. The repo name stays `ai-signal` because the local cache is intended to become context for AI assistants through MCP.

```text
Public sources -> Collectors -> Local cache -> Ranking -> VS Code panel
                                                -> MCP tools -> AI assistants
```

## Current Source

The active collector uses the public Hacker News Firebase API.

It reads story lists, fetches item metadata, filters by configured interests, ranks the matches, and writes a local snapshot.

```text
scripts/hn-smoke.mjs
  -> .ai-signal/hn-cache.json
  -> .ai-signal/hn-digest.md
```

## Feed Configuration

The feed preset lives in:

```text
config/feeds.sample.json
```

Each group defines:

- `name`
- `icon`
- `description`
- `weight`
- `keywords`
- `domains`

Matching should stay strict by default. Signal is meant to be personal and curated, not a generic technology firehose.

## Cache

The first storage layer is JSON.

```text
.ai-signal/
  hn-cache.json
  hn-digest.md
```

MongoDB or another database can be added later as an optional adapter, but the core install should remain local, portable, and dependency-light.

## Ranking

Ranking starts deterministic:

```text
activity = points + comments
importance = activity + feedWeight + keywordBonus - agePenalty
```

Future ranking changes should remain inspectable. If an AI summary is added later, it should sit above the deterministic cache rather than become required for collection.

## MCP Server

The MCP server should read the normalized local cache. It should not refresh sources on every chat request.

Initial tools:

- `signal_get_top`
- `signal_search`
- `signal_get_digest`
- `signal_get_item`
- `signal_get_groups`

The tools should return structured JSON with title, source, group, score, comments, age, URL, discussion URL, tags, and matched keywords.

## VS Code Extension

The extension uses the status bar as its primary surface.

The panel should remain compact, persistent, and useful while coding. The Activity Bar is intentionally not used for the MVP.

## Optional Audio

`ai-voice` can be integrated as an optional local notification layer.

Use it only for important events:

- refresh completed with new high-importance items;
- refresh failed;
- manual digest created;
- MCP server started or stopped.

Signal must keep working when `ai-voice` is not installed.
