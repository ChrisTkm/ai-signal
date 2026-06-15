import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOOL_DEFINITIONS,
  buildMeta,
  callTool,
  getDigest,
  getGroups,
  getItem,
  getTop,
  projectItem,
  search,
  toSlug
} from './tools.mjs';

function makeItem(over = {}) {
  return {
    id: 'hn_1',
    externalId: 1,
    rank: 1,
    source: 'hacker-news',
    feed: 'Cortex Feed',
    title: 'Claude ships MCP',
    url: 'https://example.com/claude',
    permalink: 'https://news.ycombinator.com/item?id=1',
    author: 'alice',
    createdUtc: 1700000000,
    score: 100,
    comments: 40,
    importance: 150,
    ageHours: 5,
    sourceDomain: 'example.com',
    matchedKeywords: ['claude', 'mcp'],
    ...over
  };
}

const SNAPSHOT = {
  source: 'hacker-news',
  generatedAt: new Date().toISOString(),
  itemCount: 4,
  errorCount: 0,
  items: [
    makeItem({ id: 'hn_1', externalId: 1, feed: 'Cortex Feed', score: 100, comments: 40, ageHours: 5 }),
    makeItem({ id: 'hn_2', externalId: 2, feed: 'Cortex Feed', title: 'MCP servers', url: 'https://anthropic.com/mcp', sourceDomain: 'anthropic.com', score: 10, comments: 2, ageHours: 200, matchedKeywords: ['mcp'] }),
    makeItem({ id: 'hn_3', externalId: 3, feed: 'Nostromo Finance', title: 'Postgres 18', url: 'https://postgresql.org/p', sourceDomain: 'postgresql.org', score: 300, comments: 10, ageHours: 12, matchedKeywords: ['postgres'] }),
    makeItem({ id: 'hn_4', externalId: 4, feed: 'Cargo Bay', title: 'Node 24', url: 'https://nodejs.org/n', sourceDomain: 'nodejs.org', score: 50, comments: 1, ageHours: 1, matchedKeywords: ['node'] })
  ]
};

const CONFIG = {
  strictMatching: true,
  feeds: [
    { name: 'Cortex Feed', weight: 14, description: 'AI', keywords: ['claude', 'mcp'], domains: ['anthropic.com'] },
    { name: 'Nostromo Finance', weight: 9, description: 'DB', keywords: ['postgres'], domains: ['postgresql.org'] },
    { name: 'Cargo Bay', weight: 10, description: 'JS', keywords: ['node'], domains: ['nodejs.org'] }
  ]
};

test('toSlug normalizes display names', () => {
  assert.equal(toSlug('Cortex Feed'), 'cortex-feed');
  assert.equal(toSlug('  Deep  Space  Relay '), 'deep-space-relay');
});

test('projectItem maps internal fields to the public shape', () => {
  const p = projectItem(makeItem());
  assert.equal(p.group, 'Cortex Feed');
  assert.equal(p.groupSlug, 'cortex-feed');
  assert.equal(p.activity, 100 + 40 * 3);
  assert.equal(p.discussionUrl, 'https://news.ycombinator.com/item?id=1');
  assert.deepEqual(p.tags, ['claude', 'mcp']);
});

test('getTop sorts by activity and respects limit', () => {
  const res = getTop(SNAPSHOT, { limit: 2 });
  assert.equal(res.count, 2);
  assert.equal(res.items[0].id, 'hn_3'); // 300 + 30 = 330, highest activity
  assert.equal(res.items[1].id, 'hn_1'); // 100 + 120 = 220
});

test('getTop filters by group (slug or display name)', () => {
  const bySlug = getTop(SNAPSHOT, { group: 'cortex-feed' });
  const byName = getTop(SNAPSHOT, { group: 'Cortex Feed' });
  assert.equal(bySlug.count, 2);
  assert.equal(byName.count, 2);
  assert.ok(bySlug.items.every((i) => i.group === 'Cortex Feed'));
});

test('getTop filters by period using ageHours', () => {
  const day = getTop(SNAPSHOT, { period: 'day' }); // <= 24h: hn_1(5), hn_3(12), hn_4(1)
  assert.equal(day.count, 3);
  assert.ok(!day.items.some((i) => i.id === 'hn_2')); // 200h old
});

test('search matches free text across title, domain, keywords', () => {
  assert.equal(search(SNAPSHOT, { query: 'postgres' }).count, 1);
  assert.equal(search(SNAPSHOT, { query: 'mcp' }).count, 2);
});

test('search filters by keyword, domain, source, and group', () => {
  assert.equal(search(SNAPSHOT, { keyword: 'claude' }).count, 1);
  assert.equal(search(SNAPSHOT, { domain: 'nodejs.org' }).count, 1);
  assert.equal(search(SNAPSHOT, { source: 'hacker-news' }).count, 4);
  assert.equal(search(SNAPSHOT, { source: 'reddit' }).count, 0);
  assert.equal(search(SNAPSHOT, { group: 'nostromo-finance' }).count, 1);
});

test('getDigest groups items and caps per group', () => {
  const res = getDigest(SNAPSHOT, { perGroup: 1 });
  const cortex = res.groups.find((g) => g.group === 'Cortex Feed');
  assert.ok(cortex);
  assert.equal(cortex.count, 1);
  assert.equal(cortex.items[0].title, 'Claude ships MCP'); // highest activity in group
});

test('getDigest honors an explicit group list', () => {
  const res = getDigest(SNAPSHOT, { groups: ['Nostromo Finance'] });
  assert.equal(res.groups.length, 1);
  assert.equal(res.groups[0].group, 'Nostromo Finance');
});

test('getItem resolves by full id and external id', () => {
  assert.equal(getItem(SNAPSHOT, { id: 'hn_3' }).item.id, 'hn_3');
  assert.equal(getItem(SNAPSHOT, { id: '3' }).item.id, 'hn_3');
  assert.equal(getItem(SNAPSHOT, { id: 'nope' }).item, null);
});

test('getGroups reports config plus cached counts', () => {
  const res = getGroups(SNAPSHOT, CONFIG);
  assert.equal(res.count, 3);
  const cortex = res.groups.find((g) => g.slug === 'cortex-feed');
  assert.equal(cortex.cachedCount, 2);
  assert.equal(cortex.weight, 14);
});

test('buildMeta flags an unavailable cache', () => {
  const meta = buildMeta(null);
  assert.equal(meta.available, false);
  assert.match(meta.hint, /Refresh/);
});

test('every tool definition has a name and input schema', () => {
  assert.equal(TOOL_DEFINITIONS.length, 5);
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(tool.name);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('callTool dispatches and rejects unknown tools', () => {
  assert.equal(callTool('signal_get_groups', {}, { snapshot: SNAPSHOT, config: CONFIG }).count, 3);
  assert.throws(() => callTool('bogus', {}, { snapshot: SNAPSHOT, config: CONFIG }), /Unknown tool/);
});
