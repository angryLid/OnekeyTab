import { browser } from 'wxt/browser';
import { BADGE, BADGE_COLORS, LIMITS } from './constants';

let skipTimer: ReturnType<typeof setTimeout> | null = null;

function cancelSkipTimer(): void {
  if (skipTimer != null) {
    clearTimeout(skipTimer);
    skipTimer = null;
  }
}

export async function setPending(): Promise<void> {
  cancelSkipTimer();
  await browser.action.setBadgeBackgroundColor({ color: BADGE_COLORS.pending });
  await browser.action.setBadgeText({ text: BADGE.pending });
}

export async function setError(): Promise<void> {
  cancelSkipTimer();
  await browser.action.setBadgeBackgroundColor({ color: BADGE_COLORS.error });
  await browser.action.setBadgeText({ text: BADGE.error });
}

export async function clearBadge(): Promise<void> {
  cancelSkipTimer();
  await browser.action.setBadgeText({ text: '' });
}

export async function setSkip(): Promise<void> {
  cancelSkipTimer();
  await browser.action.setBadgeBackgroundColor({ color: BADGE_COLORS.skip });
  await browser.action.setBadgeText({ text: BADGE.skip });
  skipTimer = setTimeout(() => {
    skipTimer = null;
    void clearBadge();
  }, LIMITS.skipBadgeMs);
}

// On service worker cold start the in-flight flag is gone; any transient badge left behind ("…" or "✓") is an orphan and must be cleared. The red error badge is informational idle state and stays.
export async function reconcileOnStartup(): Promise<void> {
  const text = await browser.action.getBadgeText({});
  if (text === BADGE.pending || text === BADGE.skip) {
    await clearBadge();
  }
}
