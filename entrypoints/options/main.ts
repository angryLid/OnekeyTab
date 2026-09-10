import './style.css';
import { getLastError, getConfig, setConfig } from '@/lib/config';
import { verifyApiKey } from '@/lib/llm';
import { DEDUPE, LOG } from '@/lib/constants';
import { clearLog, countRecords, getRecord, listRecent } from '@/lib/logger';
import type { AnyLogRecord } from '@/lib/logger';
import type { AuditTab, DedupeRecord, ExclusionReason, LogIndexEntry, LogKind, RunRecord, SelectionRecord } from '@/lib/types';

const input = document.querySelector<HTMLInputElement>('#api-key')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const dedupeEnabled = document.querySelector<HTMLInputElement>('#dedupe-enabled')!;
const dedupeThreshold = document.querySelector<HTMLInputElement>('#dedupe-threshold')!;
const dedupeThresholdValue = document.querySelector<HTMLSpanElement>('#dedupe-threshold-value')!;
const dedupeIgnoreGrouped = document.querySelector<HTMLSelectElement>('#dedupe-ignore-grouped')!;
const saveDedupeButton = document.querySelector<HTMLButtonElement>('#save-dedupe')!;
const dedupeStatus = document.querySelector<HTMLParagraphElement>('#dedupe-status')!;
const errorSection = document.querySelector<HTMLElement>('#panel-settings-error')!;
const lastError = document.querySelector<HTMLParagraphElement>('#last-error')!;
const lastErrorTime = document.querySelector<HTMLParagraphElement>('#last-error-time')!;

// ---- Settings tab ----

function setStatus(message: string, kind: 'ok' | 'error' | 'muted'): void {
  status.textContent = message;
  status.className = kind;
}

async function initSettings(): Promise<void> {
  const config = await getConfig();
  if (config?.apiKey) input.value = config.apiKey;
  const dedupe = config?.dedupe ?? { enabled: true, threshold: DEDUPE.threshold };
  dedupeEnabled.checked = dedupe.enabled;
  dedupeThreshold.value = String(dedupe.threshold);
  dedupeIgnoreGrouped.value = dedupe.ignoreGrouped == null ? 'auto' : dedupe.ignoreGrouped ? 'always' : 'never';
  renderThresholdLabel();

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
    const existing = await getConfig();
    const ignoreGroupedValue = dedupeIgnoreGrouped.value;
    await setConfig({
      provider: existing?.provider ?? 'openrouter',
      apiKey: existing?.apiKey ?? '',
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
    const existing = await getConfig();
    await setConfig({ provider: 'openrouter', apiKey, dedupe: existing?.dedupe });
    setStatus('API key verified — saved.', 'ok');
    errorSection.hidden = true;
  } catch (e) {
    setStatus(`Verification failed: ${(e as Error).message}`, 'error');
  } finally {
    saveButton.disabled = false;
  }
});

// ---- Tabs ----

function activateTab(name: 'settings' | 'logs'): void {
  const settingsTab = document.querySelector<HTMLButtonElement>('#tab-settings')!;
  const logsTab = document.querySelector<HTMLButtonElement>('#tab-logs')!;
  const isLogs = name === 'logs';
  settingsTab.classList.toggle('is-active', !isLogs);
  logsTab.classList.toggle('is-active', isLogs);
  settingsTab.setAttribute('aria-selected', String(!isLogs));
  logsTab.setAttribute('aria-selected', String(isLogs));
  document.querySelector<HTMLElement>('#panel-settings')!.hidden = isLogs;
  document.querySelector<HTMLElement>('#panel-settings-privacy')!.hidden = isLogs;
  document.querySelector<HTMLElement>('#panel-settings-security')!.hidden = isLogs;
  document.querySelector<HTMLElement>('#panel-settings-dedupe')!.hidden = isLogs;
  // The error section keeps its own visibility; only force-hidden while on Logs.
  document.querySelector<HTMLElement>('#panel-settings-error')!.hidden = isLogs ? true : errorSection.hidden;
  document.querySelector<HTMLElement>('#panel-logs')!.hidden = !isLogs;
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
  if ('plannedCloseCount' in record) renderDedupeDetail(detail, record);
  else if ('tabs' in record) renderSelectionDetail(detail, record);
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
      const matches =
        linked != null &&
        (expected === 'selection'
          ? 'selectedCount' in linked
          : expected === 'dedupe'
            ? 'plannedCloseCount' in linked
            : !('selectedCount' in linked) && !('plannedCloseCount' in linked));
      if (!matches) {
        container.textContent = `${expected === 'selection' ? 'Selection' : expected === 'dedupe' ? 'Dedupe' : 'Run'} record no longer available.`;
        return;
      }
      if (expected === 'selection') renderSelectionDetail(container, linked as SelectionRecord);
      else if (expected === 'dedupe') renderDedupeDetail(container, linked as DedupeRecord);
      else renderDetail(container, linked as RunRecord);
    })();
  });
  detail.appendChild(btn);
  detail.appendChild(container);
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
  parts.push(
    `<table class="sel-table"><thead><tr><th></th><th>role</th><th>score</th><th>title</th><th>url</th></tr></thead><tbody>`,
  );
  for (const tab of record.tabs) {
    const status = tab.role === 'closed' ? '✗' : tab.role === 'baseline' ? '✓' : '–';
    const outcome = tab.outcome ? ` · ${tab.outcome}` : '';
    parts.push(
      `<tr class="${tab.role === 'closed' ? 'sel-dropped' : 'sel-kept'}">` +
        `<td class="sel-status">${status}</td>` +
        `<td>${escapeHtml(ROLE_LABELS[tab.role])}${outcome}</td>` +
        `<td>${tab.score != null ? tab.score.toFixed(2) : ''}</td>` +
        `<td>${escapeHtml(tab.title || '(untitled)')}</td>` +
        `<td>${tab.url ? escapeHtml(tab.url) : '<span class="muted">—</span>'}</td>` +
        `</tr>`,
    );
  }
  parts.push('</tbody></table>');
  parts.push(`<button type="button" class="row-export">Export this audit</button>`);
  detail.innerHTML = parts.join('');
  detail.querySelector<HTMLButtonElement>('.row-export')!.addEventListener('click', () => void exportRecords([record]));
  if (record.runId) addLinkedRecordButton(detail, 'Show the run record for this dedupe pass', record.runId, 'run');
}

const REASON_LABELS: Record<ExclusionReason, string> = {
  'no-id': 'no tab id',
  pinned: 'pinned',
  grouped: 'already grouped',
  'no-url': 'no url',
  'internal-url': 'internal url',
  'over-cap': 'beyond 50-tab cap',
};

function reasonLabel(tab: AuditTab): string {
  if (!tab.reason) return '';
  const base = REASON_LABELS[tab.reason];
  return tab.reason === 'grouped' && tab.groupId != null ? `${base} (group ${tab.groupId})` : base;
}

function renderSelectionDetail(detail: HTMLDivElement, record: SelectionRecord): void {
  const parts: string[] = [];
  parts.push(
    `<p class="muted">window ${record.windowId} · read ${record.totalTabs} · kept ${record.selectedCount} · excluded ${record.excludedCount}</p>`,
  );
  parts.push(
    `<table class="sel-table"><thead><tr><th></th><th>exclusion reason</th><th>title</th><th>url</th></tr></thead><tbody>`,
  );
  for (const tab of record.tabs) {
    parts.push(
      `<tr class="${tab.selected ? 'sel-kept' : 'sel-dropped'}">` +
        `<td class="sel-status">${tab.selected ? '✓' : '✗'}</td>` +
        `<td>${escapeHtml(reasonLabel(tab))}</td>` +
        `<td>${escapeHtml(tab.title || '(untitled)')}</td>` +
        `<td>${tab.url ? escapeHtml(tab.url) : '<span class="muted">—</span>'}</td>` +
        `</tr>`,
    );
  }
  parts.push('</tbody></table>');
  parts.push(`<button type="button" class="row-export">Export this audit</button>`);
  detail.innerHTML = parts.join('');
  detail.querySelector<HTMLButtonElement>('.row-export')!.addEventListener('click', () => void exportRecords([record]));
}

async function refreshCount(): Promise<void> {
  const total = await countRecords();
  logCount.textContent = `${total} record${total === 1 ? '' : 's'} recorded`;
}

async function refreshLogs(): Promise<void> {
  if (!logsRenderedOnce) {
    entries = await listRecent(LOG.listWindow); // newest-first, up to 100
    logsRenderedOnce = true;
  }
  renderList();
  await refreshCount();
  loadMore.hidden = entries.length >= (await countRecords());
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
  renderList();
  await refreshCount();
  loadMore.hidden = entries.length >= (await countRecords());
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

void initSettings();

document.querySelector<HTMLButtonElement>('#tab-settings')!.addEventListener('click', () => activateTab('settings'));
document.querySelector<HTMLButtonElement>('#tab-logs')!.addEventListener('click', () => activateTab('logs'));
