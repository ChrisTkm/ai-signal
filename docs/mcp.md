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

## Implementation Notes (open before building)

The server is not implemented yet. These are the gaps to close first, so the design and the real cache do not drift apart.

### 1. Reconcile the output schema with the actual cache

The examples above use field names that the collector does not currently produce. Map them before freezing the tool contract:

| Doc field        | Cache field (`hn-cache.json`)            |
| ---------------- | ---------------------------------------- |
| `group`          | `feed`                                   |
| `activity`       | derived: `score + comments * 3`          |
| `tags`           | `matchedKeywords` (no separate tags yet) |
| `discussionUrl`  | `permalink`                              |
| `ageHours`       | `ageHours` (already present)             |
| `importance`     | `importance` (already present)           |

Either change the collector to emit the documented names, or have the MCP layer project the cache into the public shape. Projecting in the MCP layer keeps the cache faithful to the source and is the recommended option.

### 2. Group identifiers

`signal_get_top` takes `"group": "cortex-feed"` (kebab-case) but the cache stores display names (`"Cortex Feed"`). Pick one canonical id and expose the display name separately, or accept both and normalize.

### 3. `period` semantics

`period` (`day` / `week`) is documented but the cache has no period dimension — it is a single rolling snapshot. The server must derive periods from `ageHours`/`createdUtc` at query time, or the field should be dropped from v1.

### 4. Cache freshness and contract

The server reads `.ai-signal/hn-cache.json` and must not fetch on each request. Decide and document: behavior when the cache is missing or stale (return empty + a `staleMinutes` hint vs. error), and the exact path resolution (extension writes the cache under its own `extensionRoot`).

### 5. Suggested shape

A read-only stdio MCP server (`@modelcontextprotocol/sdk`) under `src/mcp/` that imports the existing pure core (`scripts/lib/signal-core.mjs`) for any ranking/search filtering, so the VS Code panel and the MCP server stay consistent.
