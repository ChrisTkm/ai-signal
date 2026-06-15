const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const COMMANDS = {
  open: 'aiSignal.open',
  refresh: 'aiSignal.refresh',
  close: 'aiSignal.close',
  openDigest: 'aiSignal.openDigest'
};

let statusItem;
let output;
let extensionRoot;
let signalPanel;
let lastPanelColumn = vscode.ViewColumn.Beside;

function activate(context) {
  extensionRoot = context.extensionPath;
  output = vscode.window.createOutputChannel('AI Signal');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 94);
  statusItem.name = 'AI Signal';
  statusItem.text = '$(pulse) Signal';
  statusItem.tooltip = 'AI Signal';
  statusItem.command = COMMANDS.open;
  statusItem.show();

  context.subscriptions.push(
    output,
    statusItem,
    vscode.commands.registerCommand(COMMANDS.open, openSignals),
    vscode.commands.registerCommand(COMMANDS.refresh, refreshSignals),
    vscode.commands.registerCommand(COMMANDS.close, closeSignals),
    vscode.commands.registerCommand(COMMANDS.openDigest, openDigest)
  );

  void updateStatusFromCache();
}

function deactivate() {}

function getPreferredPanelColumn() {
  const configured = Number(vscode.workspace.getConfiguration('aiSignal').get('lastViewColumn', lastPanelColumn));
  return configured || lastPanelColumn || vscode.ViewColumn.Beside;
}

function closeSignals() {
  if (signalPanel) {
    lastPanelColumn = signalPanel.viewColumn ?? lastPanelColumn;
    void vscode.workspace.getConfiguration('aiSignal').update('lastViewColumn', lastPanelColumn, vscode.ConfigurationTarget.Workspace);
    signalPanel.dispose();
    signalPanel = undefined;
  }
}

async function openSignals() {
  const snapshot = await readSnapshot();
  if (!snapshot || !Array.isArray(snapshot.items) || snapshot.items.length === 0) {
    const action = await vscode.window.showInformationMessage(
      'AI Signal has no cached signals yet.',
      'Refresh Hacker News'
    );
    if (action === 'Refresh Hacker News') {
      await refreshSignals();
    }
    return;
  }

  if (signalPanel) {
    closeSignals();
    return;
  }

  signalPanel = vscode.window.createWebviewPanel(
    'aiSignal.panel',
    'AI Signal',
    getPreferredPanelColumn(),
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );
  signalPanel.iconPath = undefined;
  signalPanel.onDidChangeViewState((event) => {
    if (event.webviewPanel.viewColumn) {
      lastPanelColumn = event.webviewPanel.viewColumn;
      void vscode.workspace.getConfiguration('aiSignal').update('lastViewColumn', lastPanelColumn, vscode.ConfigurationTarget.Workspace);
    }
  });
  signalPanel.onDidDispose(() => {
    if (signalPanel?.viewColumn) {
      lastPanelColumn = signalPanel.viewColumn;
      void vscode.workspace.getConfiguration('aiSignal').update('lastViewColumn', lastPanelColumn, vscode.ConfigurationTarget.Workspace);
    }
    signalPanel = undefined;
  });
  signalPanel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type === 'openExternal' && message.url) {
      await vscode.env.openExternal(vscode.Uri.parse(message.url));
    }
    if (message?.type === 'refresh') {
      await refreshSignals();
    }
    if (message?.type === 'openDigest') {
      await openDigest();
    }
    if (message?.type === 'close') {
      closeSignals();
    }
  });
  updatePanel(snapshot);
}

async function refreshSignals() {
  const config = vscode.workspace.getConfiguration('aiSignal');
  const maxItems = Math.max(10, Number(config.get('maxItems', 50) || 50));
  const args = [
    path.join(extensionRoot, 'scripts', 'hn-smoke.mjs'),
    '--limitPerList',
    '30',
    '--maxItems',
    String(maxItems),
    '--lists',
    'topstories,beststories,newstories,showstories,askstories'
  ];

  statusItem.text = '$(sync~spin) Signal';
  statusItem.tooltip = 'AI Signal is refreshing Hacker News...';
  output.show(true);
  output.appendLine(`> node ${args.map(quoteArg).join(' ')}`);

  try {
    await runProcess('node', args, extensionRoot);
    await updateStatusFromCache();
    const snapshot = await readSnapshot();
    updatePanel(snapshot);
    vscode.window.showInformationMessage(
      `AI Signal refreshed ${snapshot?.itemCount ?? 0} signals in ${snapshot?.elapsedMs ?? 0}ms.`
    );
  } catch (error) {
    statusItem.text = '$(warning) Signal';
    statusItem.tooltip = error instanceof Error ? error.message : String(error);
    vscode.window.showWarningMessage(`AI Signal refresh failed: ${statusItem.tooltip}`);
  }
}

function updatePanel(snapshot) {
  if (!signalPanel || !snapshot) {
    return;
  }

  signalPanel.webview.html = renderSignalHtml(snapshot, signalPanel.webview);
}

async function openDigest() {
  const digestPath = path.join(extensionRoot, '.ai-signal', 'hn-digest.md');
  try {
    const document = await vscode.workspace.openTextDocument(digestPath);
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    vscode.window.showInformationMessage('No AI Signal digest found yet. Run refresh first.');
  }
}

async function updateStatusFromCache() {
  const snapshot = await readSnapshot();
  if (!snapshot) {
    statusItem.text = '$(pulse) Signal';
    statusItem.tooltip = 'AI Signal: no cache yet. Click to refresh.';
    return;
  }

  const staleMinutes = Math.round((Date.now() - new Date(snapshot.generatedAt).getTime()) / 60000);
  const warning = snapshot.errorCount > 0 ? '!' : '';
  statusItem.text = `$(pulse) Signal ${snapshot.itemCount ?? 0}${warning}`;
  statusItem.tooltip = [
    `AI Signal`,
    `${snapshot.itemCount ?? 0} cached signals`,
    `${snapshot.errorCount ?? 0} refresh errors`,
    `Updated ${staleMinutes}m ago`,
    `Elapsed ${snapshot.elapsedMs ?? 0}ms`
  ].join('\n');
}

async function readSnapshot() {
  const cachePath = path.join(extensionRoot, '.ai-signal', 'hn-cache.json');
  try {
    return JSON.parse(await fs.readFile(cachePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function runProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false
    });

    child.stdout.on('data', (chunk) => output.append(chunk.toString()));
    child.stderr.on('data', (chunk) => output.append(chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function formatAge(ageHours) {
  if (typeof ageHours !== 'number') {
    return 'unknown age';
  }
  if (ageHours < 1) {
    return `${Math.round(ageHours * 60)}m`;
  }
  if (ageHours < 48) {
    return `${ageHours.toFixed(1)}h`;
  }
  return `${Math.round(ageHours / 24)}d`;
}

function renderSignalHtml(snapshot, webview) {
  const nonce = getNonce();
  const signalItems = sortByActivity(snapshot.items ?? []);
  const items = [...signalItems, ...buildErrorItems(snapshot.errors ?? [])];
  const encodedItems = JSON.stringify(items).replace(/</g, '\\u003c');
  const initialId = items[0]?.id ?? '';
  const updated = snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString() : 'unknown';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Signal</title>
  <style nonce="${nonce}">
    :root {
      --bg: #171717;
      --panel: #1b1b1b;
      --panel-2: #202020;
      --border: #262626;
      --border-strong: rgba(242, 206, 126, 0.42);
      --brand: #f2ce7e;
      --text: #e5e5e5;
      --muted: #8a8a8a;
      --live: #34d399;
      --beta: #38bdf8;
      --alpha: #fbbf24;
      --soon: #a78bfa;
      --danger: #f87171;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 0;
      color: var(--text);
      background: var(--bg);
      font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 10px;
      letter-spacing: 0;
      overflow: hidden;
    }

    .shell {
      display: grid;
      grid-template-rows: auto 1fr;
      height: 100vh;
      min-width: 0;
      background: var(--bg);
      border: 1px solid var(--border);
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px 10px;
      border-bottom: 1px solid var(--border);
    }

    .brand {
      min-width: 0;
      font-size: 11px;
      font-weight: 700;
      color: var(--brand);
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .brand::before {
      content: "/// ";
      color: var(--muted);
    }

    .meta {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 22px;
      padding: 0 9px;
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      color: var(--brand);
      font-size: 9px;
      text-transform: uppercase;
    }

    .pill::before {
      content: "";
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--brand);
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(220px, 37%) minmax(260px, 1fr);
      height: 100%;
      min-height: 0;
    }

    .list {
      min-height: 0;
      overflow: auto;
      border-right: 1px solid var(--border);
      background: #161616;
    }

    .toolbar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 8px;
      padding: 10px 10px;
      border-bottom: 1px solid var(--border);
      background: rgba(23, 23, 23, 0.96);
    }

    .source-status {
      min-width: 0;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    button {
      min-width: 0;
      height: 24px;
      padding: 0 9px;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      background: var(--panel);
      font: inherit;
      cursor: pointer;
    }

    button:hover,
    button:focus {
      outline: none;
      border-color: var(--border-strong);
      color: var(--brand);
      background: var(--panel-2);
    }

    .feed-card {
      display: grid;
      grid-template-columns: 28px 1fr;
      gap: 9px;
      width: 100%;
      min-height: 48px;
      padding: 9px 10px;
      border: 0;
      border-bottom: 1px solid var(--border);
      border-radius: 0;
      text-align: left;
      background: transparent;
    }

    .feed-card:hover {
      background: #1f1f1f;
      color: var(--text);
    }

    .feed-card.active {
      background: #211f19;
      box-shadow: inset 2px 0 0 var(--brand);
    }

    .icon {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 7px;
      border: 1px solid var(--border);
      color: var(--bg);
      font-size: 9px;
      font-weight: 800;
    }

    .icon svg {
      display: block;
      width: 15px;
      height: 15px;
      fill: none;
      stroke: #171717;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .feed-cargo-bay {
      background: var(--brand);
      border-color: rgba(242, 206, 126, 0.65);
    }

    .feed-cortex-feed {
      background: var(--beta);
      border-color: rgba(56, 189, 248, 0.65);
    }

    .feed-deep-space-relay {
      background: var(--soon);
      border-color: rgba(167, 139, 250, 0.65);
    }

    .feed-nostromo-finance {
      background: var(--live);
      border-color: rgba(52, 211, 153, 0.65);
    }

    .feed-default {
      background: var(--muted);
      border-color: var(--border);
    }

    .card-title {
      color: var(--text);
      line-height: 1.35;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .topic-highlight {
      display: inline;
      padding: 0 3px;
      border-radius: 3px;
      color: #171717;
      background: #fb7185;
      font-weight: 800;
    }

    .detail-title .topic-highlight {
      padding: 1px 5px;
      background: var(--brand);
      color: #171717;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }

    .card-sub {
      margin-top: 4px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .detail {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      padding: 18px 18px 20px;
      background: var(--bg);
    }

    .detail-empty {
      display: grid;
      height: 100%;
      place-items: center;
      color: var(--muted);
    }

    .detail-kicker {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 18px;
      color: var(--muted);
      text-transform: uppercase;
      font-size: 9px;
      letter-spacing: 1.6px;
    }

    .detail-title {
      margin: 0 0 14px;
      color: var(--text);
      font-size: 15px;
      line-height: 1.35;
      font-weight: 700;
    }

    .detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin: 16px 0;
    }

    .stat {
      min-height: 44px;
      padding: 9px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #191919;
    }

    .stat-label {
      color: var(--muted);
      text-transform: uppercase;
      font-size: 8px;
      letter-spacing: 1px;
    }

    .stat-value {
      margin-top: 5px;
      color: var(--text);
      font-size: 11px;
    }

    .keywords {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 18px 0;
    }

    .keyword {
      padding: 3px 7px;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--muted);
      background: #181818;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }

    .primary {
      border-color: var(--border-strong);
      color: var(--brand);
    }

    .muted-line {
      color: var(--muted);
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .error-box {
      margin: 14px 0;
      padding: 10px;
      border: 1px solid rgba(248, 113, 113, 0.32);
      border-radius: 8px;
      color: var(--muted);
      background: rgba(248, 113, 113, 0.06);
      line-height: 1.5;
    }

    @media (max-width: 760px) {
      .layout {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(0, 1fr) min-content;
        height: 100%;
        min-height: 0;
      }

      .list {
        min-height: 0;
        border-right: 0;
        border-bottom: 1px solid var(--border);
      }

      .detail {
        max-height: min(48vh, 430px);
        padding: 16px 18px 18px;
        border-top: 1px solid var(--border);
      }

      .detail-title {
        font-size: 14px;
      }

      .detail-grid {
        margin: 12px 0;
      }
    }

    @media (max-width: 420px) {
      .header {
        padding: 10px 12px 8px;
      }

      .brand {
        max-width: 100px;
      }

      .meta span:first-child {
        display: none;
      }

      .toolbar {
        grid-template-columns: minmax(0, 1fr) auto;
      }

      #digest {
        display: none;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="header">
      <div class="brand">AI SIGNAL</div>
      <div class="meta">
        <span>${escapeHtml(String(signalItems.length))} signals</span>
        <span class="pill">top activity</span>
        <button id="close" title="Close AI Signal">Close</button>
      </div>
    </header>
    <main class="layout">
      <section class="list">
        <div class="toolbar">
          <span class="source-status">${escapeHtml(buildSourceStatus(snapshot, items))}</span>
          <button id="refresh" title="Refresh Hacker News">Refresh</button>
          <button id="digest" title="Open markdown digest">Digest</button>
        </div>
        <div id="cards"></div>
      </section>
      <section id="detail" class="detail"></section>
    </main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const items = ${encodedItems};
    let selectedId = ${JSON.stringify(initialId)};
    const feedStyles = ${JSON.stringify(FEED_STYLES).replace(/</g, '\\u003c')};

    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
    document.getElementById('digest').addEventListener('click', () => {
      vscode.postMessage({ type: 'openDigest' });
    });
    document.getElementById('close').addEventListener('click', () => {
      vscode.postMessage({ type: 'close' });
    });

    function renderCards() {
      const host = document.getElementById('cards');
      host.innerHTML = items.map((item) => {
        const style = getFeedStyle(item.feed);
        const active = item.id === selectedId ? ' active' : '';
        return '<button class="feed-card' + active + '" data-id="' + escapeAttr(item.id) + '" title="' + escapeAttr(item.feed || 'Signal') + '">' +
          '<span class="icon ' + style.className + '" title="' + escapeAttr(item.feed || 'Signal') + '">' + style.iconSvg + '</span>' +
          '<span>' +
            '<span class="card-title">' + highlightTitle(item) + '</span>' +
            '<span class="card-sub">' + escapeHtml(activityLine(item)) + '</span>' +
          '</span>' +
        '</button>';
      }).join('');
      host.querySelectorAll('.feed-card').forEach((button) => {
        button.addEventListener('click', () => {
          selectedId = button.dataset.id;
          renderCards();
          renderDetail();
        });
      });
    }

    function renderDetail() {
      const item = items.find((entry) => entry.id === selectedId);
      const host = document.getElementById('detail');
      if (!item) {
        host.innerHTML = '<div class="detail-empty">No signal selected</div>';
        return;
      }
      if (item.isError) {
        const style = getFeedStyle(item.feed);
        host.innerHTML =
          '<div class="detail-kicker"><span class="icon ' + style.className + '" title="' + escapeAttr(item.feed || 'Signal') + '">' + style.iconSvg + '</span>' +
          '<span>' + escapeHtml(item.feed) + ' / refresh warning</span></div>' +
          '<h1 class="detail-title">' + escapeHtml(item.title) + '</h1>' +
          '<div class="error-box">' + escapeHtml(item.detail || 'Source failed during refresh.') + '</div>' +
          '<p class="muted-line">This feed exists in the configuration, but the source did not return items for it in the last refresh.</p>';
        return;
      }
      const style = getFeedStyle(item.feed);
      host.innerHTML =
        '<div class="detail-kicker"><span class="icon ' + style.className + '" title="' + escapeAttr(item.feed || 'Signal') + '">' + style.iconSvg + '</span>' +
        '<span>' + escapeHtml(item.feed) + ' / ' + escapeHtml(item.sourceLabel || item.source || 'source') + '</span></div>' +
        '<h1 class="detail-title">' + highlightTitle(item) + '</h1>' +
        '<p class="muted-line">' + escapeHtml(item.url) + '</p>' +
        errorBox() +
        '<div class="detail-grid">' +
          stat('activity', String(activityScore(item))) +
          stat('importance', String(item.importance ?? 0)) +
          stat('age', formatAge(item.ageHours)) +
          stat('source', item.sourceSort || 'feed') +
        '</div>' +
        '<div class="keywords">' + keywordHtml(item.matchedKeywords) + '</div>' +
        actionButtons(item);

      const openUrl = document.getElementById('open-url');
      if (openUrl) {
        openUrl.addEventListener('click', () => {
          vscode.postMessage({ type: 'openExternal', url: item.url });
        });
      }
      const openComments = document.getElementById('open-comments');
      if (openComments) {
        openComments.addEventListener('click', () => {
          vscode.postMessage({ type: 'openExternal', url: item.permalink || item.url });
        });
      }
    }

    function stat(label, value) {
      return '<div class="stat"><div class="stat-label">' + escapeHtml(label) + '</div><div class="stat-value">' + escapeHtml(value) + '</div></div>';
    }

    function keywordHtml(keywords) {
      if (!Array.isArray(keywords) || keywords.length === 0) {
        return '<span class="keyword">no keywords</span>';
      }
      return keywords.slice(0, 8).map((keyword) => '<span class="keyword">' + escapeHtml(keyword) + '</span>').join('');
    }

    function actionButtons(item) {
      const isHnThread = String(item.url || '').includes('news.ycombinator.com/item?id=');
      if (isHnThread) {
        return '<div class="actions">' +
          '<button class="primary" id="open-comments">Ver discusión HN</button>' +
        '</div>';
      }
      return '<div class="actions">' +
        '<button class="primary" id="open-url">Ver noticia</button>' +
        '<button id="open-comments">' + escapeHtml(item.discussionLabel || 'Comentarios HN') + '</button>' +
      '</div>';
    }

    function activityLine(item) {
      return activityScore(item) + ' act / ' + formatAge(item.ageHours) + ' / ' + (item.sourceLabel || item.source || 'source');
    }

    function activityScore(item) {
      return Number(item.score || 0) + Number(item.comments || 0) * 3;
    }

    function formatAge(ageHours) {
      if (typeof ageHours !== 'number') return 'unknown';
      if (ageHours < 1) return Math.round(ageHours * 60) + 'm';
      if (ageHours < 48) return ageHours.toFixed(1) + 'h';
      return Math.round(ageHours / 24) + 'd';
    }

    function getFeedStyle(feed) {
      return feedStyles[feed] || feedStyles.default;
    }

    function errorBox() {
      const errors = ${JSON.stringify((snapshot.errors ?? []).slice(0, 5)).replace(/</g, '\\u003c')};
      if (!errors.length) return '';
      return '<div class="error-box">' +
        '<strong>Refresh warnings</strong><br>' +
        errors.map((error) => escapeHtml(error.source + ': ' + error.error)).join('<br>') +
      '</div>';
    }

    function highlightTitle(item) {
      const title = String(item.title ?? '');
      const topic = pickMainTopic(item);
      if (!topic) {
        return escapeHtml(title);
      }

      const escapedTopic = escapeRegex(topic);
      const pattern = new RegExp('(' + escapedTopic + ')', 'i');
      const parts = title.split(pattern);
      return parts.map((part) => {
        if (part.toLowerCase() === topic.toLowerCase()) {
          return '<span class="topic-highlight">' + escapeHtml(part) + '</span>';
        }
        return escapeHtml(part);
      }).join('');
    }

    function pickMainTopic(item) {
      const title = String(item.title ?? '').toLowerCase();
      const keywords = Array.isArray(item.matchedKeywords) ? item.matchedKeywords : [];
      const sorted = keywords
        .map((keyword) => String(keyword))
        .filter((keyword) => keyword && title.includes(keyword.toLowerCase()))
        .sort((left, right) => right.length - left.length);
      return sorted[0] || '';
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]);
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/"/g, '&quot;');
    }

    function escapeRegex(value) {
      return String(value).replace(/[|\\\\{}()[\\]^$+*?.]/g, '\\\\$&');
    }

    renderCards();
    renderDetail();
  </script>
</body>
</html>`;
}

function buildSourceStatus(snapshot, items) {
  const feeds = new Set((snapshot.items ?? []).map((item) => item.feed).filter(Boolean));
  const parts = [
    `${feeds.size}/4 feeds`,
    `${snapshot.sourceCount ?? 0}/${snapshot.plannedSourceCount ?? 0} sources`
  ];
  if ((snapshot.errorCount ?? 0) > 0) {
    parts.push(`${snapshot.errorCount} errors`);
  }
  return parts.join(' / ');
}

function buildErrorItems(errors) {
  return errors.map((error, index) => {
    const [feed = 'Unknown Feed', source = 'source'] = String(error.source ?? '').split('/');
    return {
      id: `error_${index}_${feed}_${source}`,
      isError: true,
      feed,
      sourceLabel: source,
      title: `Sin señales: ${source}`,
      detail: `${error.source}: ${error.error}`,
      score: -1,
      comments: 0,
      importance: -1,
      matchedKeywords: []
    };
  });
}

const FEED_STYLES = {
  'Cargo Bay': {
    className: 'feed-cargo-bay',
    iconSvg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8h12l2 4v6H4v-6l2-4Z"/><path d="M8 8V6h8v2"/><path d="M8 14h8"/><path d="M10 18v-4"/></svg>'
  },
  'Cortex Feed': {
    className: 'feed-cortex-feed',
    iconSvg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16"/><path d="M5 9h14"/><path d="M7 15h10"/><circle cx="12" cy="12" r="3"/><path d="M5 9l-2-2"/><path d="M19 9l2-2"/><path d="M7 15l-2 2"/><path d="M17 15l2 2"/></svg>'
  },
  'Deep Space Relay': {
    className: 'feed-deep-space-relay',
    iconSvg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19v-7"/><path d="M8 21h8"/><path d="M5 11a7 7 0 0 1 14 0"/><path d="M8 11a4 4 0 0 1 8 0"/><path d="M11 11h2"/><path d="M4 5l3 3"/><path d="M20 5l-3 3"/></svg>'
  },
  'Nostromo Finance': {
    className: 'feed-nostromo-finance',
    iconSvg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14v12H5z"/><path d="M8 9h8"/><path d="M8 13h3"/><path d="M14 13h2"/><path d="M8 16h3"/><path d="M14 16h2"/><path d="M5 6l2-2h10l2 2"/></svg>'
  },
  default: {
    className: 'feed-default',
    iconSvg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/><path d="M12 4v16"/><circle cx="12" cy="12" r="4"/></svg>'
  }
};

function sortByActivity(items) {
  return [...items].sort((left, right) => {
    const activityDelta = activityValue(right) - activityValue(left);
    if (activityDelta !== 0) {
      return activityDelta;
    }
    const importanceDelta = Number(right.importance ?? 0) - Number(left.importance ?? 0);
    if (importanceDelta !== 0) {
      return importanceDelta;
    }
    return Number(right.createdUtc ?? 0) - Number(left.createdUtc ?? 0);
  });
}

function activityValue(item) {
  return Number(item.score ?? 0) + Number(item.comments ?? 0) * 3;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 16; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function quoteArg(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

module.exports = {
  activate,
  deactivate
};
