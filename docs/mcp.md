# MCP Context Server

Signal's MCP server exposes the local signal cache to AI assistants.

The server should be local, read-only by default, and fast. It should answer from `.ai-signal/hn-cache.json` instead of calling public sources during a chat request.

## Tools

### `signal_get_top`

Returns ranked signals.

Input:

```json
{
  "group": "cortex-feed",
  "period": "day",
  "limit": 10
}
```

Output:

```json
{
  "items": [
    {
      "id": "hn_123",
      "title": "Example signal",
      "source": "hacker-news",
      "group": "Cortex Feed",
      "activity": 980,
      "importance": 142,
      "ageHours": 12.5,
      "url": "https://example.com/post",
      "discussionUrl": "https://news.ycombinator.com/item?id=123",
      "tags": ["claude", "mcp"],
      "matchedKeywords": ["claude"]
    }
  ]
}
```

### `signal_search`

Searches cached signals by query, group, domain, source, or keyword.

Input:

```json
{
  "query": "postgres",
  "limit": 10
}
```

### `signal_get_digest`

Returns a compact digest grouped by feed.

Input:

```json
{
  "period": "week",
  "groups": ["Cortex Feed", "Nostromo Finance"]
}
```

### `signal_get_item`

Returns full metadata for one cached signal.

Input:

```json
{
  "id": "hn_123"
}
```

### `signal_get_groups`

Returns the configured feed groups, weights, keywords, and domains.

Input:

```json
{}
```

## Assistant Behavior

The assistant should reason over Signal's structured output.

Signal collects, filters, ranks, and links. The AI assistant explains why the signals matter in the user's current context.

## Implementation

The server is implemented as a **zero-dependency stdio MCP server**, consistent with the project's no-runtime-dependency stance. It speaks newline-delimited JSON-RPC 2.0 and handles `initialize`, `tools/list`, and `tools/call`.

```text
src/mcp/
  server.mjs   # stdio JSON-RPC transport + dispatch
  tools.mjs    # pure tool logic + projection (unit tested)
  cache.mjs    # reads .ai-signal/hn-cache.json and config/feeds.sample.json
  tools.test.mjs
```

It reads the cache fresh on every `tools/call`, so refreshes triggered from VS Code are picked up without restarting the server. It never fetches from public sources during a request.

### Schema projection

The cache stays faithful to the source; the MCP layer projects each item into the documented public shape (`tools.mjs` → `projectItem`):

| Public field    | Cache field                              |
| --------------- | ---------------------------------------- |
| `group`         | `feed`                                    |
| `groupSlug`     | `toSlug(feed)` (e.g. `cortex-feed`)       |
| `activity`      | derived: `score + comments * 3`           |
| `tags`          | `matchedKeywords`                         |
| `discussionUrl` | `permalink`                               |
| `ageHours`      | `ageHours`                                |
| `importance`    | `importance`                              |

Resolved design questions:

- **Group identifiers** — tools accept either the display name (`Cortex Feed`) or the slug (`cortex-feed`); both are normalized.
- **`period`** — derived at query time from `ageHours` (`hour`/`day`/`week`/`month`/`all`); the cache remains a single rolling snapshot.
- **Freshness / missing cache** — every response carries a `meta` block with `staleMinutes` and `itemCount`. When no cache exists, `meta.available` is `false` with a hint instead of an error.

## Running the server

```powershell
pnpm mcp
# or directly:
node src/mcp/server.mjs
```

Paths can be overridden with environment variables:

- `SIGNAL_CACHE_PATH` — absolute path to `hn-cache.json` (default: `<repo>/.ai-signal/hn-cache.json`).
- `SIGNAL_CONFIG_PATH` — absolute path to the feeds config (default: `<repo>/config/feeds.sample.json`).

### Client configuration

Any MCP client that launches a stdio server works. Example entry:

```json
{
  "mcpServers": {
    "ai-signal": {
      "command": "node",
      "args": ["C:/dev/ai-signal/src/mcp/server.mjs"],
      "env": {
        "SIGNAL_CACHE_PATH": "C:/dev/ai-signal/.ai-signal/hn-cache.json"
      }
    }
  }
}
```

For Claude Code: `claude mcp add ai-signal -- node C:/dev/ai-signal/src/mcp/server.mjs`.
