import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { normalizeHnItem, rankItems } from './lib/signal-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(rootDir, args.config ?? 'config/feeds.sample.json');
const outDir = path.resolve(rootDir, args.out ?? '.ai-signal');
const cachePath = path.join(outDir, 'hn-cache.json');
const digestPath = path.join(outDir, 'hn-digest.md');
const lists = (args.lists ?? 'topstories,beststories,newstories,showstories,askstories')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const limitPerList = Number(args.limitPerList ?? 30);
const maxItems = Number(args.maxItems ?? 50);
const concurrency = Number(args.concurrency ?? 8);
const timeoutMs = Number(args.timeoutMs ?? 10000);

const startedAt = performance.now();
const config = JSON.parse(await readFile(configPath, 'utf8'));
const feeds = config.feeds ?? [];
const strictMatching = config.strictMatching !== false;
const errors = [];
const idsByList = await fetchStoryIds(lists, { limitPerList, timeoutMs, errors });
const plannedSourceCount = lists.length;
const uniqueTargets = dedupeTargets(idsByList);
const itemResults = await runLimited(uniqueTargets, concurrency, (target) => fetchItem(target, { timeoutMs }));
const rawItems = [];

for (const result of itemResults) {
  if (result.status === 'fulfilled' && result.value.item) {
    rawItems.push(result.value.item);
  } else if (result.status === 'fulfilled' && result.value.error) {
    errors.push(result.value.error);
  } else {
    errors.push({ source: 'Hacker News/item', error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  }
}

const normalized = rawItems
  .filter((item) => item && !item.deleted && !item.dead && ['story', 'job'].includes(item.type))
  .map((item) => normalizeHnItem(item, feeds, { strictMatching }))
  .filter(Boolean);
const ranked = rankItems(normalized, maxItems);
const elapsedMs = Math.round(performance.now() - startedAt);
const generatedAt = new Date().toISOString();
const snapshot = {
  generatedAt,
  elapsedMs,
  source: 'hacker-news',
  sourceCount: lists.length,
  plannedSourceCount,
  fetchedCount: normalized.length,
  itemCount: ranked.length,
  errorCount: errors.length,
  errors,
  items: ranked
};

await mkdir(outDir, { recursive: true });
await writeFile(cachePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
await writeFile(digestPath, renderMarkdown(snapshot), 'utf8');

console.log('ai-signal hacker news smoke');
console.log(`config: ${path.relative(rootDir, configPath)}`);
console.log(`lists: ${lists.join(',')}`);
console.log(`targets: ${uniqueTargets.length}`);
console.log(`fetched: ${normalized.length}`);
console.log(`ranked: ${ranked.length}`);
console.log(`errors: ${errors.length}`);
console.log(`elapsed: ${elapsedMs}ms`);
console.log(`json: ${path.relative(rootDir, cachePath)}`);
console.log(`markdown: ${path.relative(rootDir, digestPath)}`);
if (errors.length > 0) {
  console.log(`first error: ${errors[0].source} - ${errors[0].error}`);
}

async function fetchStoryIds(listNames, options) {
  const pairs = [];
  const results = await runLimited(listNames, Math.min(4, listNames.length), async (listName) => {
    const url = `https://hacker-news.firebaseio.com/v0/${encodeURIComponent(listName)}.json`;
    const payload = await fetchJson(url, options.timeoutMs);
    if (!Array.isArray(payload)) {
      return { listName, ids: [], error: `${listName} did not return an array` };
    }
    return { listName, ids: payload.slice(0, options.limitPerList) };
  });

  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value.error) {
        options.errors.push({ source: `Hacker News/${result.value.listName}`, error: result.value.error });
      }
      for (const id of result.value.ids) {
        pairs.push({ listName: result.value.listName, id });
      }
    } else {
      options.errors.push({ source: 'Hacker News/list', error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    }
  }
  return pairs;
}

function dedupeTargets(targets) {
  const byId = new Map();
  for (const target of targets) {
    const existing = byId.get(target.id);
    if (existing) {
      existing.lists.push(target.listName);
    } else {
      byId.set(target.id, { id: target.id, lists: [target.listName] });
    }
  }
  return [...byId.values()];
}

async function fetchItem(target, options) {
  try {
    const item = await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${target.id}.json`, options.timeoutMs);
    return { item: { ...item, signalLists: target.lists } };
  } catch (error) {
    return {
      error: {
        source: `Hacker News/item/${target.id}`,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runLimited(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        results[currentIndex] = { status: 'fulfilled', value: await worker(items[currentIndex]) };
      } catch (error) {
        results[currentIndex] = { status: 'rejected', reason: error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return results;
}

function renderMarkdown(snapshot) {
  const lines = [
    '# ai-signal Hacker News smoke',
    '',
    `Generated: ${snapshot.generatedAt}`,
    `Elapsed: ${snapshot.elapsedMs}ms`,
    `Fetched: ${snapshot.fetchedCount}`,
    `Ranked: ${snapshot.itemCount}`,
    `Errors: ${snapshot.errorCount}`,
    ''
  ];

  for (const item of snapshot.items) {
    lines.push(
      `## ${item.rank}. ${escapeMarkdown(item.title)}`,
      '',
      `- Feed: ${item.feed}`,
      `- Source: Hacker News / ${item.sourceSort}`,
      `- Activity: ${item.score} points, ${item.comments} comments`,
      `- Link: ${item.url}`,
      `- Comments: ${item.permalink}`,
      ''
    );
  }
  return `${lines.join('\n')}\n`;
}

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = 'true';
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}
