#!/usr/bin/env node
// Zero-dependency MCP server for Signal over stdio.
//
// Implements the subset of the Model Context Protocol needed to expose the
// local signal cache: `initialize`, `tools/list`, and `tools/call`. Messages
// are newline-delimited JSON-RPC 2.0, per the MCP stdio transport.
//
// stdout carries the protocol only. All diagnostics go to stderr.

import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readConfig, readSnapshot } from './cache.mjs';
import { TOOL_DEFINITIONS, callTool } from './tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const pkg = JSON.parse(await readFile(path.join(here, '..', '..', 'package.json'), 'utf8'));
const SERVER_INFO = { name: 'ai-signal', version: pkg.version ?? '0.0.0' };

function log(...parts) {
  process.stderr.write(`[ai-signal mcp] ${parts.join(' ')}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const known = TOOL_DEFINITIONS.some((tool) => tool.name === name);
  if (!known) {
    replyError(id, -32602, `Unknown tool: ${name}`);
    return;
  }

  // Read fresh on every call so cache refreshes from VS Code are picked up.
  const [snapshot, config] = await Promise.all([readSnapshot(), readConfig()]);

  try {
    const result = callTool(name, args, { snapshot, config });
    reply(id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: false
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    reply(id, { content: [{ type: 'text', text }], isError: true });
  }
}

async function handleMessage(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return; // notification, no response
    case 'ping':
      if (isRequest) reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOL_DEFINITIONS });
      return;
    case 'tools/call':
      await handleToolCall(id, params);
      return;
    default:
      if (isRequest) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Track in-flight handlers so we can drain them before exiting when stdin
// closes (e.g. batch/piped input), instead of dropping pending responses.
const pending = new Set();
let inputClosed = false;

function maybeExit() {
  if (inputClosed && pending.size === 0) process.exit(0);
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    log('failed to parse line as JSON');
    return;
  }
  const work = Promise.resolve(handleMessage(message)).catch((error) => {
    log('handler error:', error instanceof Error ? error.message : String(error));
    if (message?.id !== undefined && message?.id !== null) {
      replyError(message.id, -32603, 'Internal error');
    }
  });
  pending.add(work);
  work.finally(() => {
    pending.delete(work);
    maybeExit();
  });
});

rl.on('close', () => {
  inputClosed = true;
  maybeExit();
});

log(`ready (${SERVER_INFO.name}@${SERVER_INFO.version})`);
