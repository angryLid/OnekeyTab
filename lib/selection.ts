import type { Browser } from 'wxt/browser';
import { LIMITS } from './constants';
import { isUngroupedGroupId } from './types';
import { sanitizeUrl } from './model-input';
import type { GroupInfo, PortCaps } from './types';
import type { AuditTab, ExclusionReason } from './types';

const INTERNAL_SCHEMES = ['about:', 'chrome:', 'edge:', 'chrome-extension:', 'moz-extension:', 'extension:', 'vivaldi:'];

function isInternalUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return INTERNAL_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

/**
 * The selection context: what the active port says about grouping in this window. Built from
 * `port.caps` + `port.listGroups` (selectionContextFromGroups); the default reproduces
 * Chrome-native semantics from raw tab groupIds, so tests and tooling need no port at all.
 */
export interface SelectionContext {
  /** Tab id -> visible group id, from the active port's listGroups. */
  stacks: ReadonlyMap<number, string>;
  /** Label the port's visible-group membership excludes under: 'grouped' is droppable in dedupe, 'stacked' never. */
  visibleGroupReason: 'grouped' | 'stacked';
  /** When false, native groupIds are invisible/stale state and never exclude (Vivaldi). */
  nativeGroupsTrustworthy: boolean;
}

export function selectionContextFromGroups(
  groups: readonly GroupInfo[],
  caps: Pick<PortCaps, 'visibleGroupReason' | 'nativeGroupsTrustworthy'>,
): SelectionContext {
  const stacks = new Map<number, string>();
  for (const group of groups) {
    for (const tabId of group.tabIds) stacks.set(tabId, group.id);
  }
  return { stacks, visibleGroupReason: caps.visibleGroupReason, nativeGroupsTrustworthy: caps.nativeGroupsTrustworthy };
}

/** Chrome-parity context derived straight from tab groupIds; the default when no port context exists. */
export function defaultSelectionContext(tabs: readonly Browser.tabs.Tab[]): SelectionContext {
  const stacks = new Map<number, string>();
  for (const tab of tabs) {
    if (tab.id != null && !isUngroupedGroupId(tab.groupId)) stacks.set(tab.id, String(tab.groupId));
  }
  return { stacks, visibleGroupReason: 'grouped', nativeGroupsTrustworthy: true };
}

/** First exclusion rule the tab trips, in filter-chain order; null when it is a candidate. */
export function exclusionReason(tab: Browser.tabs.Tab, ctx: SelectionContext): ExclusionReason | null {
  if (tab.id == null) return 'no-id';
  if (tab.pinned) return 'pinned';
  // Visible-group membership first: under a bridge context a leftover invisible groupId must
  // never downgrade a visible stack member into the (droppable) grouped case.
  if (ctx.stacks.get(tab.id) != null) return ctx.visibleGroupReason;
  if (ctx.nativeGroupsTrustworthy && !isUngroupedGroupId(tab.groupId)) return 'grouped';
  if (typeof tab.url !== 'string' || tab.url.length === 0) return 'no-url';
  if (isInternalUrl(tab.url)) return 'internal-url';
  return null;
}

/** Convenience wrapper over exclusionReason with the Chrome-default context. */
export function firstExclusionReason(tab: Browser.tabs.Tab): ExclusionReason | null {
  return exclusionReason(tab, defaultSelectionContext([tab]));
}

/**
 * Dedupe eligibility: the selection chain, with the `grouped` rule ignorable — on Vivaldi a
 * groupId is invisible state that must not hide tabs from dedupe (closing one just shrinks an
 * unrendered group). The visible-stack rule (`stacked`) is never ignored: a stack member is
 * visible, so closing its duplicate visibly shrinks a user-facing stack.
 */
export function dedupeEligibilityReason(
  tab: Browser.tabs.Tab,
  ctx: SelectionContext,
  ignoreGrouped: boolean,
): ExclusionReason | null {
  const reason = exclusionReason(tab, ctx);
  if (reason === 'grouped' && ignoreGrouped) return null;
  return reason;
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
export function auditSelection(tabs: Browser.tabs.Tab[], context: SelectionContext = defaultSelectionContext(tabs)): SelectionAudit {
  const passing = tabs.filter((tab) => exclusionReason(tab, context) == null);
  passing.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const candidates = passing.slice(0, LIMITS.maxTabs);
  const capped = new Set(candidates.map((tab) => tab.id as number));
  const audited = tabs.map((tab): AuditTab => {
    const reason = exclusionReason(tab, context) ?? (capped.has(tab.id as number) ? null : 'over-cap');
    return toAuditTab(tab, reason, context);
  });
  return { tabs: audited, candidates };
}

function toAuditTab(tab: Browser.tabs.Tab, reason: ExclusionReason | null, ctx: SelectionContext): AuditTab {
  const audit: AuditTab = {
    id: tab.id ?? null,
    title: (tab.title ?? '').slice(0, LIMITS.titleMax),
    pinned: tab.pinned ?? false,
    selected: reason == null,
  };
  if (typeof tab.url === 'string' && tab.url.length > 0) audit.url = sanitizeUrl(tab.url);
  if (tab.groupId != null && tab.groupId > 0) audit.groupId = tab.groupId;
  if (reason === 'stacked' && tab.id != null) {
    const stackId = ctx.stacks.get(tab.id);
    if (stackId != null) audit.stackId = stackId;
  }
  if (reason === 'over-cap') audit.lastAccessed = tab.lastAccessed;
  if (reason != null) audit.reason = reason;
  return audit;
}

export function selectCandidates(
  tabs: Browser.tabs.Tab[],
  context: SelectionContext = defaultSelectionContext(tabs),
): Browser.tabs.Tab[] {
  return auditSelection(tabs, context).candidates;
}
