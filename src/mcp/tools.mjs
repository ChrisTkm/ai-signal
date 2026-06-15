// Pure MCP tool logic. Takes an already-loaded snapshot/config and returns
// plain JSON. No I/O here so it can be unit tested without disk or network.

import { activityValue } from '../../scripts/lib/signal-core.mjs';

const PERIOD_HOURS = { hour: 1, day: 24, week: 168, month: 720 };

export function toSlug(name) {
  return String(name ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function periodHours(period) {
  if (!period || period === 'all') return Infinity;
  return PERIOD_HOURS[period] ?? Infinity;
}

function groupMatches(feed, requested) {
  if (!requested) return true;
  return toSlug(feed) === toSlug(requested) || feed === requested;
}

function withinPeriod(item, period) {
  return Number(item.ageHours ?? Infinity) <= periodHours(period);
}

// Project an internal cache item into the documented public shape, while
// keeping the original fields available for assistants that want them.
export function projectItem(item) {
  return {
    id: item.id,
    rank: item.rank,
    title: item.title,
    source: item.source,
    group: item.feed,
    groupSlug: toSlug(item.feed),
    activity: activityValue(item),
    score: item.score,
    comments: item.comments,
    importance: item.importance,
    ageHours: item.ageHours,
    url: item.url,
    discussionUrl: item.permalink,
    domain: item.sourceDomain,
    author: item.author,
    createdUtc: item.createdUtc,
    tags: item.matchedKeywords ?? [],
    matchedKeywords: item.matchedKeywords ?? []
  };
}

export function buildMeta(snapshot) {
  if (!snapshot) {
    return {
      available: false,
      hint: 'No signal cache found. Run "Signal: Refresh Hacker News" in VS Code or `node scripts/hn-smoke.mjs`.'
    };
  }
  const generatedAt = snapshot.generatedAt ?? null;
  const staleMinutes = generatedAt
    ? Math.round((Date.now() - new Date(generatedAt).getTime()) / 60000)
    : null;
  return {
    available: true,
    source: snapshot.source ?? 'hacker-news',
    generatedAt,
    staleMinutes,
    itemCount: snapshot.itemCount ?? (snapshot.items?.length ?? 0),
    errorCount: snapshot.errorCount ?? 0
  };
}

function items(snapshot) {
  return Array.isArray(snapshot?.items) ? snapshot.items : [];
}

function bySortedActivity(list) {
  return [...list].sort((a, b) => activityValue(b) - activityValue(a));
}

export function getTop(snapshot, { group, period, limit = 10 } = {}) {
  const filtered = items(snapshot)
    .filter((item) => groupMatches(item.feed, group))
    .filter((item) => withinPeriod(item, period));
  const ranked = bySortedActivity(filtered).slice(0, clampLimit(limit, 10));
  return { meta: buildMeta(snapshot), count: ranked.length, items: ranked.map(projectItem) };
}

export function search(snapshot, { query, group, domain, source, keyword, limit = 20 } = {}) {
  const q = String(query ?? '').toLowerCase().trim();
  const kw = String(keyword ?? '').toLowerCase().trim();
  const dom = String(domain ?? '').toLowerCase().trim();
  const src = String(source ?? '').toLowerCase().trim();

  const filtered = items(snapshot).filter((item) => {
    if (!groupMatches(item.feed, group)) return false;
    if (src && String(item.source ?? '').toLowerCase() !== src) return false;
    if (dom && !String(item.sourceDomain ?? '').toLowerCase().includes(dom)) return false;
    if (kw && !(item.matchedKeywords ?? []).some((k) => String(k).toLowerCase() === kw)) return false;
    if (q) {
      const haystack = [item.title, item.url, item.sourceDomain, ...(item.matchedKeywords ?? [])]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const ranked = bySortedActivity(filtered).slice(0, clampLimit(limit, 20));
  return { meta: buildMeta(snapshot), count: ranked.length, items: ranked.map(projectItem) };
}

export function getDigest(snapshot, { period, groups, perGroup = 5 } = {}) {
  const wanted = Array.isArray(groups) && groups.length > 0 ? groups : null;
  const pool = items(snapshot).filter((item) => withinPeriod(item, period));
  const names = wanted ?? [...new Set(pool.map((item) => item.feed).filter(Boolean))];

  const digest = names.map((name) => {
    const groupItems = bySortedActivity(pool.filter((item) => groupMatches(item.feed, name)))
      .slice(0, clampLimit(perGroup, 5));
    return {
      group: groupItems[0]?.feed ?? name,
      groupSlug: toSlug(name),
      count: groupItems.length,
      items: groupItems.map((item) => ({
        title: item.title,
        activity: activityValue(item),
        ageHours: item.ageHours,
        url: item.url,
        discussionUrl: item.permalink
      }))
    };
  });

  return { meta: buildMeta(snapshot), period: period ?? 'all', groups: digest };
}

export function getItem(snapshot, { id } = {}) {
  if (!id) return { meta: buildMeta(snapshot), item: null, error: 'Missing required "id".' };
  const target = String(id);
  const candidates = [target, `hn_${target}`];
  const found = items(snapshot).find(
    (item) => candidates.includes(String(item.id)) || String(item.externalId) === target
  );
  if (!found) return { meta: buildMeta(snapshot), item: null };
  // Full metadata: raw cache fields augmented with the public projection.
  return { meta: buildMeta(snapshot), item: { ...found, ...projectItem(found), raw: found } };
}

export function getGroups(snapshot, config) {
  const counts = new Map();
  for (const item of items(snapshot)) {
    counts.set(item.feed, (counts.get(item.feed) ?? 0) + 1);
  }
  const feeds = Array.isArray(config?.feeds) ? config.feeds : [];
  const groups = feeds.map((feed) => ({
    name: feed.name,
    slug: toSlug(feed.name),
    description: feed.description ?? '',
    weight: feed.weight ?? 0,
    keywords: feed.keywords ?? [],
    domains: feed.domains ?? [],
    cachedCount: counts.get(feed.name) ?? 0
  }));
  return {
    meta: buildMeta(snapshot),
    strictMatching: config?.strictMatching !== false,
    count: groups.length,
    groups
  };
}

function clampLimit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(100, Math.floor(n));
}

export const TOOL_DEFINITIONS = [
  {
    name: 'signal_get_top',
    description:
      'Return the top ranked signals from the local cache, optionally filtered by feed group and time period.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Feed group name or slug, e.g. "Cortex Feed" or "cortex-feed".' },
        period: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'all'], description: 'Time window. Defaults to all.' },
        limit: { type: 'number', description: 'Max items to return (1-100). Default 10.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'signal_search',
    description: 'Search cached signals by free-text query, group, domain, source, or matched keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text match against title, url, domain, and keywords.' },
        group: { type: 'string', description: 'Feed group name or slug.' },
        domain: { type: 'string', description: 'Substring match against the source domain.' },
        source: { type: 'string', description: 'Exact source id, e.g. "hacker-news".' },
        keyword: { type: 'string', description: 'Exact matched keyword.' },
        limit: { type: 'number', description: 'Max items to return (1-100). Default 20.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'signal_get_digest',
    description: 'Return a compact digest of top signals grouped by feed, optionally limited to a period or set of groups.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'all'], description: 'Time window. Defaults to all.' },
        groups: { type: 'array', items: { type: 'string' }, description: 'Group names or slugs. Defaults to all groups present.' },
        perGroup: { type: 'number', description: 'Max items per group (1-100). Default 5.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'signal_get_item',
    description: 'Return the full metadata for a single cached signal by id (e.g. "hn_123" or "123").',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Signal id ("hn_123") or external id ("123").' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'signal_get_groups',
    description: 'List configured feed groups with their weights, keywords, domains, and how many cached signals each currently holds.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

export function callTool(name, args = {}, { snapshot, config } = {}) {
  switch (name) {
    case 'signal_get_top':
      return getTop(snapshot, args);
    case 'signal_search':
      return search(snapshot, args);
    case 'signal_get_digest':
      return getDigest(snapshot, args);
    case 'signal_get_item':
      return getItem(snapshot, args);
    case 'signal_get_groups':
      return getGroups(snapshot, config);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
