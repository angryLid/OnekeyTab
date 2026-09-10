import type { Browser } from 'wxt/browser';
import { LIMITS } from './constants';
import { sanitizeUrl } from './model-input';
import type { AuditTab, ExclusionReason } from './types';

const INTERNAL_SCHEMES = ['about:', 'chrome:', 'edge:', 'chrome-extension:', 'moz-extension:', 'extension:', 'vivaldi:'];

function isInternalUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return INTERNAL_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

function isUngrouped(tab: Browser.tabs.Tab): boolean {
  return tab.groupId == null || tab.groupId <= 0;
}

/**
 * Dedupe eligibility: the selection chain, but on Vivaldi the `grouped` rule is ignored —
 * Vivaldi does not render native tab groups, so a groupId there is invisible state that must
 * not hide tabs from dedupe (closing one just shrinks an unrendered group).
 */
export function dedupeEligibilityReason(tab: Browser.tabs.Tab, ignoreGrouped: boolean): ExclusionReason | null {
  const reason = firstExclusionReason(tab);
  if (reason === 'grouped' && ignoreGrouped) return null;
  return reason;
}

/** First exclusion rule the tab trips, in filter-chain order; null when it is a candidate. */
export function firstExclusionReason(tab: Browser.tabs.Tab): ExclusionReason | null {
  if (tab.id == null) return 'no-id';
  if (tab.pinned) return 'pinned';
  if (!isUngrouped(tab)) return 'grouped';
  if (typeof tab.url !== 'string' || tab.url.length === 0) return 'no-url';
  if (isInternalUrl(tab.url)) return 'internal-url';
  return null;
}

export interface SelectionAudit {
  /** Every tab read, in query order, each marked selected or excluded (+ reason). */
  tabs: AuditTab[];
  /** The tabs offered to the model, after sorting and the maxTabs cap. */
  candidates: Browser.tabs.Tab[];
}

/**
 * Classify every tab the window query returned: selected, or excluded by which rule.
 * The one source of truth for candidate selection — `selectCandidates` derives from this,
 * so the audit can never disagree with what the model actually receives.
 */
export function auditSelection(tabs: Browser.tabs.Tab[]): SelectionAudit {
  const passing = tabs.filter((tab) => firstExclusionReason(tab) == null);
  passing.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const candidates = passing.slice(0, LIMITS.maxTabs);
  const capped = new Set(candidates.map((tab) => tab.id as number));
  const audited = tabs.map((tab): AuditTab => {
    const reason = firstExclusionReason(tab) ?? (capped.has(tab.id as number) ? null : 'over-cap');
    return toAuditTab(tab, reason);
  });
  return { tabs: audited, candidates };
}

function toAuditTab(tab: Browser.tabs.Tab, reason: ExclusionReason | null): AuditTab {
  const audit: AuditTab = {
    id: tab.id ?? null,
    title: (tab.title ?? '').slice(0, LIMITS.titleMax),
    pinned: tab.pinned ?? false,
    selected: reason == null,
  };
  if (typeof tab.url === 'string' && tab.url.length > 0) audit.url = sanitizeUrl(tab.url);
  if (tab.groupId != null && tab.groupId > 0) audit.groupId = tab.groupId;
  if (reason === 'over-cap') audit.lastAccessed = tab.lastAccessed;
  if (reason != null) audit.reason = reason;
  return audit;
}

export function selectCandidates(tabs: Browser.tabs.Tab[]): Browser.tabs.Tab[] {
  return auditSelection(tabs).candidates;
}
