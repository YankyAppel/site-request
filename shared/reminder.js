// Reminder: a request still not open 48 hours after it was sent is offered a short follow-up
// email, once. Pure functions: shared by the background worker and the tests.
import { entryKey } from './approval.js';

export const REMIND_AFTER_MS = 48 * 60 * 60 * 1000;
export const REMIND_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const REMIND_EVERY_MIN = 60;
export const REMIND_PREFIX = 'sr-remind|';

// Entries that should get the "send a reminder?" notification now.
export function dueReminders(history, now) {
  return (history || []).filter(h => {
    if (!h || !h.url || !h.at) return false;
    if (h.status === 'approved') return false;
    if (h.remindOfferedAt || h.remindedAt) return false;  // at most once per request
    const age = now - h.at;
    return age >= REMIND_AFTER_MS && age <= REMIND_MAX_AGE_MS;
  });
}

export function reminderId(h) {
  return REMIND_PREFIX + entryKey(h);
}

export function keyFromReminderId(id) {
  const s = String(id || '');
  return s.startsWith(REMIND_PREFIX) ? s.slice(REMIND_PREFIX.length) : '';
}

// The name shown in "Still waiting on <host>".
export function waitingLabel(h) {
  if (h.kind === 'parts') {
    const n = (h.items || []).length;
    return n === 1 ? h.items[0] : n + ' addresses on ' + (h.domain || '');
  }
  try { return new URL(h.url).hostname.replace(/^www\./, ''); } catch (e) { return h.domain || h.url; }
}
