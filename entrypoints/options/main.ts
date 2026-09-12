import './style.css';
import { browser } from 'wxt/browser';
import { getLastError, getConfig, setConfig, updateConfig } from '@/lib/config';
import { BRIDGE, DEDUPE, LOG } from '@/lib/constants';
import { verifyApiKey } from '@/lib/llm';
import { clearLog, countRecords, getRecord, listRecent } from '@/lib/logger';
import type { AnyLogRecord } from '@/lib/logger';
import { bridgeApi, DEFAULT_UI_EXTENSION_ID, probeBridge } from '@/lib/stackbridge';
import type { BridgeRuntime } from '@/lib/stackbridge';
import { describeVivaldiSignals } from '@/lib/vivaldi';
import { isDedupeRecord, isSelectionRecord, recordKind } from '@/lib/types';
import type { AnyLogRecord, AuditTab, DedupeRecord, ExclusionReason, GroupingBackend, LogIndexEntry, LogKind, RunRecord, SelectionRecord } from '@/lib/types';

const input = document.querySelector<HTMLInputElement>('#api-key')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const dedupeEnabled = document.querySelector<HTMLInputElement>('#dedupe-enabled')!;
const dedupeThreshold = document.querySelector<HTMLInputElement>('#dedupe-threshold')!;
const dedupeThresholdValue = document.querySelector<HTMLSpanElement>('#dedupe-threshold-value')!;
const dedupeIgnoreGrouped = document.querySelector<HTMLSelectElement>('#dedupe-ignore-grouped')!;
const saveDedupeButton = document.querySelector<HTMLButtonElement>('#save-dedupe')!;
const dedupeStatus = document.querySelector<HTMLParagraphElement>('#dedupe-status')!;
const groupingBackend = document.querySelector<HTMLSelectElement>('#grouping-backend')!;
const saveBackendButton = document.querySelector<HTMLButtonElement>('#save-backend')!;
const backendStatus = document.querySelector<HTMLParagraphElement>('#backend-status')!;
const errorSection = document.querySelector<HTMLElement>('#panel-settings-error')!;
const lastError = document.querySelector<HTMLParagraphElement>('#last-error')!;
const lastErrorTime = document.querySelector<HTMLParagraphElement>('#last-error-time')!;

// ---- Settings tab ----

function setStatus(message: string, kind: 'ok' | 'error' | 'muted'): void {
  status.textContent = message;
  status.className = kind;
}

/**
 * StackBridge status line: detect Vivaldi, ping the bridge, and reflect both in the UI.
 * On Vivaldi the native backend option is greyed out — invisible groups are not shipped
 * behavior there (docs/grouping-port.md), so offering the setting would be a trap.
 */
async function refreshBridgeStatus(): Promise<void> {
  const statusLine = document.querySelector<HTMLParagraphElement>('#bridge-status')!;
  try {
    const [tabs, windows] = await Promise.all([browser.tabs.query({}), browser.windows.getAll()]);
    const vivaldi = describeVivaldiSignals(tabs, navigator, windows);
    if (vivaldi.signals.length === 0) {
      statusLine.textContent = 'Not Vivaldi — grouping uses native tab groups.';
      return;
    }
    groupingBackend.querySelector<HTMLOptionElement>('option[value="native"]')!.disabled = true;
    // Display coherence with the runtime coercion: a stored 'native' cannot run on Vivaldi.
    if (groupingBackend.value === 'native') groupingBackend.value = 'auto';
    const config = await getConfig();
    const extId = config?.bridge?.uiExtensionId?.trim() || DEFAULT_UI_EXTENSION_ID;
    const probe = await probeBridge(bridgeApi(browser.runtime as unknown as BridgeRuntime), extId);
    if (probe.ok) {
      statusLine.textContent = 'StackBridge: detected. Grouping on Vivaldi creates real Tab Stacks.';
    } else if (probe.reason === 'no-listener') {
      statusLine.textContent =
        `StackBridge: not detected. Grouping on Vivaldi requires the mod (clicks will not run until it is installed) — install guide: ${BRIDGE.installDocsUrl}`;
    } else if (probe.reason === 'timeout') {
      statusLine.textContent = `StackBridge: installed but not responding. Restart Vivaldi or reinstall the mod (${BRIDGE.installDocsUrl}).`;
    } else if (probe.reason === 'not-paired') {
      statusLine.textContent = 'StackBridge: paired mode rejected this extension. Pair it in the window.html console: StackBridge.pair(<extension id>).';
    } else {
      statusLine.textContent = `StackBridge: unusable (${probe.reason ?? 'unknown'}${probe.detail ? `: ${probe.detail}` : ''}). See ${BRIDGE.installDocsUrl}`;
    }
  } catch (e) {
    statusLine.textContent = `StackBridge status unknown: ${(e as Error).message}`;
  }
}

async function initSettings(): Promise<void> {
  const config = await getConfig();
  if (config?.apiKey) input.value = config.apiKey;
  const dedupe = config?.dedupe ?? { enabled: true, threshold: DEDUPE.threshold };
  dedupeEnabled.checked = dedupe.enabled;
  dedupeThreshold.value = String(dedupe.threshold);
  dedupeIgnoreGrouped.value = dedupe.ignoreGrouped == null ? 'auto' : dedupe.ignoreGrouped ? 'always' : 'never';
  renderThresholdLabel();
  groupingBackend.value = config?.groupingBackend ?? 'auto';

  const error = await getLastError();
  if (error) {
    errorSection.hidden = false;
    lastError.textContent = error.message;
    lastErrorTime.textContent = new Date(error.timestamp).toLocaleString();
  }
}

function renderThresholdLabel(): void {
  dedupeThresholdValue.textContent = `≥ ${Number(dedupeThreshold.value).toFixed(2)}`;
}

dedupeThreshold.addEventListener('input', renderThresholdLabel);

saveDedupeButton.addEventListener('click', async () => {
  saveDedupeButton.disabled = true;
  try {
    const ignoreGroupedValue = dedupeIgnoreGrouped.value;
    await updateConfig({
      dedupe: {
        enabled: dedupeEnabled.checked,
        threshold: Number(dedupeThreshold.value),
        // 'auto' stores as absent so the Vivaldi runtime detection decides.
        ignoreGrouped: ignoreGroupedValue === 'auto' ? undefined : ignoreGroupedValue === 'always',
      },
    });
    dedupeStatus.textContent = 'Dedupe settings saved.';
    dedupeStatus.className = 'ok';
  } catch (e) {
    dedupeStatus.textContent = `Save failed: ${(e as Error).message}`;
    dedupeStatus.className = 'error';
  } finally {
    saveDedupeButton.disabled = false;
  }
});

saveBackendButton.addEventListener('click', async () => {
  saveBackendButton.disabled = true;
  try {
    await updateConfig({ groupingBackend: groupingBackend.value as GroupingBackend });
    backendStatus.textContent = 'Backend saved.';
    backendStatus.className = 'ok';
  } catch (e) {
    backendStatus.textContent = `Save failed: ${(e as Error).message}`;
    backendStatus.className = 'error';
  } finally {
    saveBackendButton.disabled = false;
  }
});

saveButton.addEventListener('click', async () => {
  const apiKey = input.value.trim();
  if (!apiKey) {
    setStatus('Please enter an API key.', 'error');
    return;
  }
  saveButton.disabled = true;
  setStatus('Verifying…', 'muted');
  try {
    await verifyApiKey(apiKey);
    await updateConfig({ provider: 'openrouter', apiKey });
    setStatus('API key verified — saved.', 'ok');
    errorSection.hidden = true;
  } catch (e) {
    setStatus(`Verification failed: ${(e as Error).message}`, 'error');
  } finally {
    saveButton.disabled = false;
  }
});

// ---- Tabs (hash routing: #logs opens the logs tab, tab clicks sync the hash) ----

const TAB_NAMES = ['settings', 'logs'] as const;
type TabName = (typeof TAB_NAMES)[number];

function currentHashTab(): TabName {
  return location.hash === '#logs' ? 'logs' : 'settings';
}

function activateTab(name: TabName): void {
  const settingsTab = document.querySelector<HTMLButtonElement>('#tab-settings')!;
  const logsTab = document.querySelector<HTMLButtonElement>('#tab-logs')!;
  const isLogs = name === 'logs';
  settingsTab.classList.toggle('is-active', !isLogs);
  logsTab.classList.toggle('is-active', isLogs);
  settingsTab.setAttribute('aria-selected', String(!isLogs));
  logsTab.setAttribute('aria-selected', String(isLogs));
  for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]')) {
    // The error section keeps its own visibility; it is only force-hidden while on Logs.
    if (panel === errorSection) continue;
    panel.hidden = (panel.dataset.panel === 'logs') !== isLogs;
  }
  errorSection.hidden = isLogs || errorSection.hidden;
  if (isLogs) void refreshLogs();
}

// ---- Logs tab ----

const logList = document.querySelector<HTMLUListElement>('#log-list')!;
const loadMore = document.querySelector<HTMLButtonElement>('#load-more')!;
const logEmpty = document.querySelector<HTMLParagraphElement>('#log-empty')!;
const logCount = document.querySelector<HTMLSpanElement>('#log-count')!;

type LogFilter = 'all' | LogKind;

// Newest-first array of the entries currently loaded.
let entries: LogIndexEntry[] = [];
let logFilter: LogFilter = 'all';
let logsRenderedOnce = false;

const FILTER_BUTTONS: Array<[LogFilter, string]> = [
  ['all', '#filter-all'],
  ['run', '#filter-run'],
  ['selection', '#filter-selection'],
  ['dedupe', '#filter-dedupe'],
];

function outcomeLabel(o: LogIndexEntry['outcome']): string {
  return o === 'success' ? 'ok' : o;
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleString();
}

function visibleEntries(): LogIndexEntry[] {
  return logFilter === 'all' ? entries : entries.filter((e) => e.kind === logFilter);
}

function renderList(): void {
  logList.innerHTML = '';
  visibleEntries().forEach(addRow);
  logEmpty.hidden = visibleEntries().length > 0;
}

function metaLabel(entry: LogIndexEntry): string {
  if (entry.kind === 'selection') {
    const kept = (entry.tabCount ?? 0) - (entry.excludedCount ?? 0);
    return `read ${entry.tabCount ?? '-'} · kept ${kept} · excluded ${entry.excludedCount ?? '-'}`;
  }
  if (entry.kind === 'dedupe') {
    return `eligible ${entry.tabCount ?? '-'} · closed ${entry.closedCount ?? '-'}`;
  }
  const bits: string[] = [];
  if (entry.model) bits.push(`model: ${entry.model}`);
  bits.push(`tabs: ${entry.tabCount ?? '-'}`);
  return bits.join(' · ');
}

function addRow(entry: LogIndexEntry): void {
  const li = document.createElement('li');
  li.className = `log-row kind-${entry.kind} outcome-${entry.outcome}`;
  const head = document.createElement('div');
  head.className = 'log-row-head';
  head.innerHTML =
    `<span class="log-kind">${entry.kind}</span>` +
    (entry.kind === 'run' ? `<span class="log-outcome">${outcomeLabel(entry.outcome)}</span>` : '') +
    `<span class="log-time">${timeLabel(entry.ts)}</span>` +
    `<span class="log-meta" data-id="${entry.id}"></span>` +
    (entry.kind === 'run' ? `<span class="log-duration">${entry.durationMs}ms</span>` : '');
  head.querySelector<HTMLSpanElement>('.log-meta')!.textContent = metaLabel(entry);

  const detail = document.createElement('div');
  detail.className = 'log-detail';
  detail.hidden = true;

  li.appendChild(head);
  li.appendChild(detail);
  logList.appendChild(li);

  head.addEventListener('click', () => {
    void toggleDetail(detail, entry);
  });
}

async function toggleDetail(detail: HTMLDivElement, entry: LogIndexEntry): Promise<void> {
  if (!detail.hidden) {
    detail.hidden = true;
    return;
  }
  const record = await getRecord(entry.id);
  detail.hidden = false;
  if (!record) {
    detail.textContent = 'Record no longer available.';
    return;
  }
  if (isDedupeRecord(record)) renderDedupeDetail(detail, record);
  else if (isSelectionRecord(record)) renderSelectionDetail(detail, record);
  else renderDetail(detail, record);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderDetail(detail: HTMLDivElement, record: RunRecord): void {
  const parts: string[] = [];
  if (record.reason) parts.push(`<p class="muted">${escapeHtml(record.reason)}</p>`);
  if (record.error) parts.push(`<p class="error">${escapeHtml(record.error)}</p>`);
  if (record.windowId != null) parts.push(`<p class="muted">window ${record.windowId} · total ${record.durationMs}ms</p>`);
  if (record.backend) {
    const probe = record.probe;
    const probeLabel = probe == null ? '' : probe.ok ? ' · bridge probe ok' : ` · bridge probe failed (${escapeHtml(probe.reason ?? 'unknown')})`;
    parts.push(`<p class="muted">backend ${record.backend}${probeLabel}</p>`);
  }
  if (record.calls?.length) {
    record.calls.forEach((call, i) => {
      parts.push(
        `<details class="call" open>` +
          `<summary>Call ${i + 1} — ${escapeHtml(call.model)} · ${call.durationMs}ms${call.parseError ? ' · <span class="error">parse failed</span>' : ''}</summary>` +
          `<div class="call-body">` +
          `<h4>Request</h4><pre>${escapeHtml(JSON.stringify(call.request, null, 2))}</pre>` +
          `<h4>Response</h4><pre>${escapeHtml(call.response)}</pre>` +
          (call.parseError ? `<p class="error">${escapeHtml(call.parseError)}</p>` : '') +
          `</div>` +
          `</details>`,
      );
    });
  }
  parts.push(`<button type="button" class="row-export">Export this run</button>`);
  detail.innerHTML = parts.join('');
  detail.querySelector<HTMLButtonElement>('.row-export')!.addEventListener('click', () => void exportRecords([record]));
  if (record.selectionId) addLinkedRecordButton(detail, 'Show tab selection audit for this run', record.selectionId, 'selection');
  if (record.dedupeId) addLinkedRecordButton(detail, 'Show the dedupe audit for this run', record.dedupeId, 'dedupe');
}

/** Inline expandable link to a sibling record (selection / dedupe / run) of the same click. */
function addLinkedRecordButton(
  detail: HTMLDivElement,
  label: string,
  recordId: string,
  expected: 'selection' | 'dedupe' | 'run',
): void {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `row-${expected}`;
  btn.textContent = label;
  const container = document.createElement('div');
  container.hidden = true;
  btn.addEventListener('click', () => {
    if (!container.hidden) {
      container.hidden = true;
      return;
    }
    void (async () => {
      const linked = await getRecord(recordId);
      container.hidden = false;
      const matches = linked != null && recordKind(linked) === expected;
      if (!matches) {
        const label = expected === 'run' ? 'Run' : expected === 'selection' ? 'Selection' : 'Dedupe';
        container.textContent = `${label} record no longer available.`;
        return;
      }
      if (isSelectionRecord(linked)) renderSelectionDetail(container, linked);
      else if (isDedupeRecord(linked)) renderDedupeDetail(container, linked);
      else renderDetail(container, linked);
    })();
  });
  detail.appendChild(btn);
  detail.appendChild(container);
}

/** One audit-table row: status glyph, kept/dropped styling, and pre-escaped cell HTML. */
interface AuditTableRow {
  status: string;
  kept: boolean;
  cells: string[];
}

/** Shared audit-table skeleton: status column, escaped cells, and the export button wiring. */
function renderAuditTable(detail: HTMLDivElement, headers: string[], rows: AuditTableRow[], record: AnyLogRecord): void {
  const parts: string[] = [];
  parts.push(`<table class="sel-table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>`);
  for (const row of rows) {
    parts.push(
      `<tr class="${row.kept ? 'sel-kept' : 'sel-dropped'}">` +
        `<td class="sel-status">${row.status}</td>` +
        row.cells.map((cell) => `<td>${cell}</td>`).join('') +
        `</tr>`,
    );
  }
  parts.push('</tbody></table>');
  parts.push(`<button type="button" class="row-export">Export this audit</button>`);
  detail.innerHTML = parts.join('');
  detail.querySelector<HTMLButtonElement>('.row-export')!.addEventListener('click', () => void exportRecords([record]));
}

const ROLE_LABELS: Record<DedupeRecord['tabs'][number]['role'], string> = {
  baseline: 'survivor (newest of its family)',
  closed: 'closed',
  ignored: 'ignored (unparseable URL)',
};

function renderDedupeDetail(detail: HTMLDivElement, record: DedupeRecord): void {
  const p = record.params;
  const parts: string[] = [];
  parts.push(
    `<p class="muted">window ${record.windowId} · threshold ${p.threshold} · weights ${p.weightPath}/${p.weightQuery} · substitute cost ${p.substituteCost}${p.ignoreGrouped ? ' · grouped tabs in scope (Vivaldi)' : ''} · planned ${record.plannedCloseCount} · closed ${record.closedCount ?? '…'}</p>`,
  );
  const rows = record.tabs.map((tab) => ({
    status: tab.role === 'closed' ? '✗' : tab.role === 'baseline' ? '✓' : '–',
    kept: tab.role !== 'closed',
    cells: [
      `${escapeHtml(ROLE_LABELS[tab.role])}${tab.outcome ? ` · ${tab.outcome}` : ''}`,
      tab.score != null ? tab.score.toFixed(2) : '',
      escapeHtml(tab.title || '(untitled)'),
      tab.url ? escapeHtml(tab.url) : '<span class="muted">—</span>',
    ],
  }));
  renderAuditTable(detail, ['', 'role', 'score', 'title', 'url'], rows, record);
  if (record.runId) addLinkedRecordButton(detail, 'Show the run record for this dedupe pass', record.runId, 'run');
}

const REASON_LABELS: Record<ExclusionReason, string> = {
  'no-id': 'no tab id',
  pinned: 'pinned',
  stacked: 'in a Vivaldi stack',
  grouped: 'already grouped',
  'no-url': 'no url',
  'internal-url': 'internal url',
  'over-cap': 'beyond 50-tab cap',
};

function reasonLabel(tab: AuditTab): string {
  if (!tab.reason) return '';
  const base = REASON_LABELS[tab.reason];
  if (tab.reason === 'grouped' && tab.groupId != null) return `${base} (group ${tab.groupId})`;
  if (tab.reason === 'stacked' && tab.stackId != null) return `${base} (${tab.stackId})`;
  return base;
}

function renderSelectionDetail(detail: HTMLDivElement, record: SelectionRecord): void {
  const parts: string[] = [];
  parts.push(
    `<p class="muted">window ${record.windowId} · read ${record.totalTabs} · kept ${record.selectedCount} · excluded ${record.excludedCount}</p>`,
  );
  const rows = record.tabs.map((tab) => ({
    status: tab.selected ? '✓' : '✗',
    kept: tab.selected,
    cells: [escapeHtml(reasonLabel(tab)), escapeHtml(tab.title || '(untitled)'), tab.url ? escapeHtml(tab.url) : '<span class="muted">—</span>'],
  }));
  renderAuditTable(detail, ['', 'exclusion reason', 'title', 'url'], rows, record);
}

/** Render the list and sync the count + "Load earlier" visibility from one countRecords call. */
async function renderLogsView(): Promise<void> {
  renderList();
  const total = await countRecords();
  logCount.textContent = `${total} record${total === 1 ? '' : 's'} recorded`;
  loadMore.hidden = entries.length >= total;
}

async function refreshLogs(): Promise<void> {
  if (!logsRenderedOnce) {
    entries = await listRecent(LOG.listWindow); // newest-first, up to 100
    logsRenderedOnce = true;
  }
  await renderLogsView();
}

for (const [name, selector] of FILTER_BUTTONS) {
  document.querySelector<HTMLButtonElement>(selector)!.addEventListener('click', () => {
    logFilter = name;
    for (const [n, s] of FILTER_BUTTONS) {
      document.querySelector<HTMLButtonElement>(s)!.classList.toggle('is-active', n === name);
    }
    renderList();
  });
}

loadMore.addEventListener('click', async () => {
  entries = await listRecent(entries.length + LOG.listWindow);
  await renderLogsView();
});

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportRecords(records: AnyLogRecord[]): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  download(`ai-tab-grouper-logs-${stamp}.json`, JSON.stringify(records, null, 2));
}

document.querySelector<HTMLButtonElement>('#export-all')!.addEventListener('click', async () => {
  // Export the currently visible window (recent up to LOG.listWindow).
  const recent = await listRecent(LOG.listWindow);
  const records: AnyLogRecord[] = [];
  for (const e of recent) {
    const r = await getRecord(e.id);
    if (r) records.push(r);
  }
  await exportRecords(records);
});

document.querySelector<HTMLButtonElement>('#clear-log')!.addEventListener('click', async () => {
  const total = await countRecords();
  if (total === 0) return;
  if (!confirm(`Clear all ${total} recorded record(s)? This cannot be undone.`)) return;
  await clearLog();
  entries = [];
  logsRenderedOnce = false;
  await refreshLogs();
});

// ---- Boot ----

// Apply the tab from the URL, then keep it in sync with navigation.
const applyTabFromHash = (): void => activateTab(currentHashTab());
applyTabFromHash();
window.addEventListener('hashchange', applyTabFromHash);

document.querySelector<HTMLButtonElement>('#tab-settings')!.addEventListener('click', () => {
  if (currentHashTab() === 'settings') activateTab('settings');
  else location.hash = '#settings';
});
document.querySelector<HTMLButtonElement>('#tab-logs')!.addEventListener('click', () => {
  if (currentHashTab() === 'logs') activateTab('logs');
  else location.hash = '#logs';
});

void initSettings();
void refreshBridgeStatus();
