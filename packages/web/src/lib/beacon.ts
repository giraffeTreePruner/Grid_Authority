/**
 * Telling the server a page was looked at.
 *
 * One request, no cookie, no identifier held by the browser. The server derives a
 * per-day pseudonym from the request itself; nothing is stored here, so there is
 * nothing here to clear, export or leak.
 *
 * Deliberately quiet about failure. An analytics call that surfaces an error, retries,
 * or blocks anything has its priorities wrong — if a count is lost, the count is wrong
 * and the page still works, which is the correct trade in that order.
 */
import { API_BASE } from '../api/client.ts';

let sent = false;

/**
 * Report one page view.
 *
 * Guarded so a re-render cannot double-count. React's StrictMode deliberately runs
 * effects twice in development, which would otherwise make every local page load look
 * like two.
 */
export const reportPageView = (path: string): void => {
  if (sent) return;
  sent = true;

  const body = JSON.stringify({ path });

  // sendBeacon where it exists: the browser owns the request from here, so it survives
  // the page being closed in the same moment, and it never delays a navigation.
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      // text/plain avoids a CORS preflight. The request is same-origin either way, but
      // a preflight would be a second round trip for nothing.
      navigator.sendBeacon(`${API_BASE}/hit`, new Blob([body], { type: 'text/plain' }));
      return;
    } catch {
      // Some privacy extensions replace sendBeacon with something that throws. Fall
      // through to fetch rather than letting a counting call break the page.
    }
  }

  void fetch(`${API_BASE}/hit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {
    // Counting is not worth a console error in a reader's browser.
  });
};

/** Test seam: lets a test start from a clean slate. */
export const resetBeaconForTests = (): void => {
  sent = false;
};
