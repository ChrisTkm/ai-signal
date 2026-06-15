// Pure, dependency-free core for ai-signal: classification and ranking.
// Kept free of I/O so it can be unit tested without network or filesystem.

export function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function keywordMatches(haystack, keyword) {
  const normalized = String(keyword).toLowerCase().trim();
  if (!normalized) {
    return false;
  }

  const escaped = normalized.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  const hasWordEdges = /^[a-z0-9][a-z0-9 ._-]*[a-z0-9]$/i.test(normalized);
  const pattern = hasWordEdges
    ? new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i')
    : new RegExp(escaped, 'i');
  return pattern.test(haystack);
}

export function classifyItem(item, feeds, options = {}) {
  const haystack = `${item.title}\n${item.url}\n${item.text}`.toLowerCase();
  let best;

  for (const feed of feeds) {
    const keywords = (feed.keywords ?? [])
      .map((keyword) => String(keyword))
      .filter((keyword) => keywordMatches(haystack, keyword));
    const domainHits = (feed.domains ?? [])
      .map((domain) => String(domain).replace(/^www\./, '').toLowerCase())
      .filter((domain) => domain && getDomain(item.url).endsWith(domain));
    const score = keywords.length * 10 + domainHits.length * 15 + Number(feed.weight ?? 0);
    const bestScore = best ? best.weight + best.keywords.length * 10 : -1;
    if ((keywords.length > 0 || domainHits.length > 0) && score > bestScore) {
      best = {
        feedName: feed.name,
        weight: Number(feed.weight ?? 0) + domainHits.length * 2,
        keywords: [...keywords, ...domainHits]
      };
    }
  }

  if (best?.keywords.length > 0) {
    return best;
  }

  if (options.strictMatching) {
    return undefined;
  }

  return { feedName: 'Deep Space Relay', weight: 1, keywords: [] };
}

export function normalizeHnItem(item, feeds, options = {}) {
  const title = String(item.title ?? '').trim();
  const url = item.url || `https://news.ycombinator.com/item?id=${item.id}`;
  const commentsUrl = `https://news.ycombinator.com/item?id=${item.id}`;
  const classification = classifyItem({ title, url, text: item.text ?? '' }, feeds, options);
  if (!classification) {
    return undefined;
  }
  const score = Number(item.score ?? 0);
  const comments = Number(item.descendants ?? 0);
  const createdUtc = Number(item.time ?? 0);

  return {
    id: `hn_${item.id}`,
    externalId: item.id,
    source: 'hacker-news',
    feed: classification.feedName,
    sourceSort: (item.signalLists ?? []).join(', '),
    sourceLabel: 'Hacker News',
    title,
    url,
    permalink: commentsUrl,
    author: item.by ?? '',
    createdUtc,
    score,
    comments,
    upvoteRatio: null,
    matchedKeywords: classification.keywords,
    feedWeight: classification.weight,
    discussionLabel: 'Comentarios HN',
    sourceDomain: getDomain(url)
  };
}

export function ageHours(createdUtc, now = Date.now()) {
  if (!createdUtc) return 9999;
  return Math.max(0, (now / 1000 - createdUtc) / 3600);
}

export function activityValue(item) {
  return Number(item.score ?? 0) + Number(item.comments ?? 0) * 3;
}

export function computeImportance(item, now = Date.now()) {
  const activity = Math.log10(Number(item.score ?? 0) + 2) * 18 + Math.log10(Number(item.comments ?? 0) + 2) * 24;
  const freshness = Math.max(0, 18 - ageHours(item.createdUtc, now) / 4);
  const matches = Math.min(25, (item.matchedKeywords?.length ?? 0) * 7);
  return Math.round(activity + freshness + matches + Number(item.feedWeight ?? 0));
}

export function rankItems(items, maxItems, now = Date.now()) {
  return [...items]
    .map((item) => ({
      ...item,
      ageHours: ageHours(item.createdUtc, now),
      importance: computeImportance(item, now)
    }))
    .sort((left, right) => {
      const activityDelta = activityValue(right) - activityValue(left);
      if (activityDelta !== 0) return activityDelta;
      return Number(right.createdUtc ?? 0) - Number(left.createdUtc ?? 0);
    })
    .slice(0, maxItems)
    .map((item, index) => ({ rank: index + 1, ...item }));
}
