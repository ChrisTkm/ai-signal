// I/O layer for the MCP server: locate and read the local signal cache and
// the feed configuration. No network access — the server answers from disk.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export function resolveCachePath() {
  return process.env.SIGNAL_CACHE_PATH
    ? path.resolve(process.env.SIGNAL_CACHE_PATH)
    : path.join(repoRoot, '.ai-signal', 'hn-cache.json');
}

export function resolveConfigPath() {
  return process.env.SIGNAL_CONFIG_PATH
    ? path.resolve(process.env.SIGNAL_CONFIG_PATH)
    : path.join(repoRoot, 'config', 'feeds.sample.json');
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function readSnapshot() {
  return readJson(resolveCachePath());
}

export function readConfig() {
  return readJson(resolveConfigPath());
}
