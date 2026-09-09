import './style.css';
import { getLastError, getConfig, setConfig } from '@/lib/config';
import { verifyApiKey } from '@/lib/llm';
import { LOG } from '@/lib/constants';
import { clearLog, countRuns, getRun, listRecent } from '@/lib/logger';
import type { RunIndexEntry, RunRecord } from '@/lib/types';

const input = document.querySelector<HTMLInputElement>('#api-key')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
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

  const error = await getLastError();
  if (error) {
    errorSection.hidden = false;
    lastError.textContent = error.message;
    lastErrorTime.textContent = new Date(error.timestamp).toLocaleString();
  }
}

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
    await setConfig({ provider: 'openrouter', apiKey });
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

// Newest-first array of the entries currently displayed.
let entries: RunIndexEntry[] = [];
let logsRenderedOnce = false;

function outcomeLabel(o: RunIndexEntry['outcome']): string {
  return o === 'success' ? 'ok' : o;
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleString();
}

function addRow(entry: RunIndexEntry): void {
  const li = document.createElement('li');
  li.className = `log-row outcome-${entry.outcome}`;
  const head = document.createElement('div');
  head.className = 'log-row-head';
  head.innerHTML =
    `<span class="log-outcome">${outcomeLabel(entry.outcome)}</span>` +
    `<span class="log-time">${timeLabel(entry.ts)}</span>` +
    `<span class="log-meta" data-id="${entry.id}"></span>` +
    `<span class="log-duration">${entry.durationMs}ms</span>`;
  const meta = head.querySelector<HTMLSpanElement>('.log-meta')!;
  const metaBits: string[] = [];
  if (entry.model) metaBits.push(`model: ${entry.model}`);
  metaBits.push(`tabs: ${entry.tabCount ?? '-'}`);
  meta.textContent = metaBits.join(' · ');

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

async function toggleDetail(detail: HTMLDivElement, entry: RunIndexEntry): Promise<void> {
  if (!detail.hidden) {
    detail.hidden = true;
    return;
  }
  const record = await getRun(entry.id);
  detail.hidden = false;
  if (!record) {
    detail.textContent = 'Record no longer available.';
    return;
  }
  renderDetail(detail, record);
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
  const exportBtn = `<button type="button" class="row-export">Export this run</button>`;
  parts.push(exportBtn);
  detail.innerHTML = parts.join('');
  const btn = detail.querySelector<HTMLButtonElement>('.row-export')!;
  btn.addEventListener('click', () => void exportRuns([record]));
}

async function refreshCount(): Promise<void> {
  const total = await countRuns();
  logCount.textContent = `${total} run${total === 1 ? '' : 's'} recorded`;
}

async function refreshLogs(): Promise<void> {
  if (!logsRenderedOnce) {
    entries = await listRecent(LOG.listWindow); // newest-first, up to 100
    logList.innerHTML = '';
    entries.forEach(addRow);
    logsRenderedOnce = true;
  }
  await refreshCount();
  logEmpty.hidden = entries.length > 0;
  loadMore.hidden = entries.length >= (await countRuns());
}

loadMore.addEventListener('click', async () => {
  const next = await listRecent(entries.length + LOG.listWindow);
  const newly = next.slice(entries.length);
  newly.forEach(addRow);
  entries = next;
  await refreshCount();
  logEmpty.hidden = entries.length > 0;
  loadMore.hidden = entries.length >= (await countRuns());
});

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportRuns(records: RunRecord[]): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  download(`ai-tab-grouper-logs-${stamp}.json`, JSON.stringify(records, null, 2));
}

document.querySelector<HTMLButtonElement>('#export-all')!.addEventListener('click', async () => {
  // Export the currently visible window (recent up to LOG.listWindow).
  const entries = await listRecent(LOG.listWindow);
  const records: RunRecord[] = [];
  for (const e of entries) {
    const r = await getRun(e.id);
    if (r) records.push(r);
  }
  await exportRuns(records);
});

document.querySelector<HTMLButtonElement>('#clear-log')!.addEventListener('click', async () => {
  const total = await countRuns();
  if (total === 0) return;
  if (!confirm(`Clear all ${total} recorded run(s)? This cannot be undone.`)) return;
  await clearLog();
  logList.innerHTML = '';
  entries = [];
  logsRenderedOnce = false;
  await refreshLogs();
});

// ---- Boot ----

void initSettings();

document.querySelector<HTMLButtonElement>('#tab-settings')!.addEventListener('click', () => activateTab('settings'));
document.querySelector<HTMLButtonElement>('#tab-logs')!.addEventListener('click', () => activateTab('logs'));
