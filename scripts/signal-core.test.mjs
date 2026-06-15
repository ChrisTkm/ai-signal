import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activityValue,
  ageHours,
  classifyItem,
  computeImportance,
  getDomain,
  keywordMatches,
  normalizeHnItem,
  rankItems
} from './lib/signal-core.mjs';

const FEEDS = [
  {
    name: 'Cortex Feed',
    weight: 14,
    keywords: ['claude', 'mcp', 'model context protocol'],
    domains: ['anthropic.com']
  },
  {
    name: 'Nostromo Finance',
    weight: 9,
    keywords: ['postgres', 'postgresql'],
    domains: ['postgresql.org']
  }
];

// A fixed clock so age/importance assertions are deterministic.
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z

test('getDomain strips www and tolerates bad input', () => {
  assert.equal(getDomain('https://www.anthropic.com/news'), 'anthropic.com');
  assert.equal(getDomain('not a url'), '');
});

test('keywordMatches respects word edges', () => {
  assert.equal(keywordMatches('a new mcp server', 'mcp'), true);
  // "mcp" inside "mcpx" should not match because of the word-edge guard.
  assert.equal(keywordMatches('the mcpx toolkit', 'mcp'), false);
  assert.equal(keywordMatches('', 'mcp'), false);
});

test('classifyItem picks the strongest matching feed', () => {
  const result = classifyItem(
    { title: 'Claude gets a new MCP server', url: 'https://example.com', text: '' },
    FEEDS,
    { strictMatching: true }
  );
  assert.equal(result.feedName, 'Cortex Feed');
  assert.ok(result.keywords.includes('claude'));
  assert.ok(result.keywords.includes('mcp'));
});

test('classifyItem matches by domain even without keywords', () => {
  const result = classifyItem(
    { title: 'A release post', url: 'https://www.postgresql.org/about/news', text: '' },
    FEEDS,
    { strictMatching: true }
  );
  assert.equal(result.feedName, 'Nostromo Finance');
});

test('classifyItem returns undefined under strict matching when nothing matches', () => {
  const result = classifyItem(
    { title: 'Unrelated kitchen gadget', url: 'https://example.com', text: '' },
    FEEDS,
    { strictMatching: true }
  );
  assert.equal(result, undefined);
});

test('classifyItem falls back to a default feed when not strict', () => {
  const result = classifyItem(
    { title: 'Unrelated kitchen gadget', url: 'https://example.com', text: '' },
    FEEDS,
    { strictMatching: false }
  );
  assert.equal(result.feedName, 'Deep Space Relay');
});

test('normalizeHnItem shapes a Hacker News item', () => {
  const item = normalizeHnItem(
    {
      id: 123,
      title: 'Claude and MCP',
      url: 'https://example.com/post',
      score: 100,
      descendants: 40,
      time: 1700000000,
      by: 'someone',
      signalLists: ['topstories']
    },
    FEEDS,
    { strictMatching: true }
  );
  assert.equal(item.id, 'hn_123');
  assert.equal(item.feed, 'Cortex Feed');
  assert.equal(item.permalink, 'https://news.ycombinator.com/item?id=123');
  assert.equal(item.score, 100);
  assert.equal(item.comments, 40);
});

test('normalizeHnItem drops non-matching items under strict matching', () => {
  const item = normalizeHnItem(
    { id: 9, title: 'random', url: 'https://example.com', time: 1700000000 },
    FEEDS,
    { strictMatching: true }
  );
  assert.equal(item, undefined);
});

test('activityValue weights comments more than points', () => {
  assert.equal(activityValue({ score: 10, comments: 5 }), 25);
});

test('ageHours returns a sentinel for missing timestamps', () => {
  assert.equal(ageHours(0, NOW), 9999);
  const oneHourAgo = NOW / 1000 - 3600;
  assert.equal(Math.round(ageHours(oneHourAgo, NOW)), 1);
});

test('computeImportance rewards fresher, higher-activity items', () => {
  const base = { score: 50, comments: 20, matchedKeywords: ['claude'], feedWeight: 14, createdUtc: NOW / 1000 - 3600 };
  const older = { ...base, createdUtc: NOW / 1000 - 3600 * 72 };
  assert.ok(computeImportance(base, NOW) > computeImportance(older, NOW));
});

test('rankItems sorts by activity and assigns ranks', () => {
  const items = [
    { id: 'a', score: 5, comments: 1, createdUtc: NOW / 1000 - 3600 },
    { id: 'b', score: 100, comments: 50, createdUtc: NOW / 1000 - 3600 },
    { id: 'c', score: 20, comments: 2, createdUtc: NOW / 1000 - 3600 }
  ];
  const ranked = rankItems(items, 2, NOW);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, 'b');
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].rank, 2);
  assert.ok(typeof ranked[0].importance === 'number');
  assert.ok(typeof ranked[0].ageHours === 'number');
});
