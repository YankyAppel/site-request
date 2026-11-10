// Decides, from one background check of a requested address, whether the site is open now.
// Pure functions: shared by the background worker and the tests.

export const CHECK_EVERY_MIN = 30;
export const CHECK_MAX_AGE_DAYS = 30;
export const CHECK_TIMEOUT_MS = 15000;
export const CONFIRM_GAP_MS = 60 * 1000;   // the two "open" checks must be at least this far apart
export const CONFIRM_DELAY_MIN = 2;        // when the first "open" check is seen, check again this soon
export const BODY_LIMIT = 256 * 1024;

// Any host of the blocking service (filter.techloq.com, techloq.com, ...).
export function isBlockerHost(host) {
  return /(^|\.)techloq[\w-]*\.[a-z.]+$/i.test(String(host || ''));
}

function hostOf(href) {
  try { return new URL(href).hostname.toLowerCase(); } catch (e) { return ''; }
}

const TWO_PART_TLDS = /\.(co|com|org|net|gov|ac|edu|ltd|plc|me)\.[a-z]{2}$/i;

// "www.news.example.co.uk" -> "example.co.uk"; an IP stays as it is.
export function siteOf(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  const n = TWO_PART_TLDS.test(host) ? 3 : 2;
  return parts.slice(-n).join('.');
}

export function sameSite(a, b) {
  return !!a && !!b && siteOf(a) === siteOf(b);
}

const BODY_MARKERS = [
  /requested\s+url\s+blocked/i,
  /filter\s+action\s*:?\s*blocked/i,
  /filter[\w-]*\.techloq\.[a-z]+/i,
  /block-page\?redirecturl=/i,
  /<title[^>]*>[^<]*techloq/i
];

// True when a response body looks like the block page (or sends the browser to it).
export function looksLikeBlockPage(body) {
  const s = String(body || '');
  if (!s) return false;
  if (BODY_MARKERS.some(re => re.test(s))) return true;
  // A short page that only points at the blocking service (meta refresh, script redirect).
  if (s.length < 50000 && /techloq\.(com|net|org|co)\b/i.test(s) &&
      /(http-equiv\s*=\s*["']?refresh|location(\.href)?\s*=|location\.(replace|assign)\s*\()/i.test(s)) return true;
  return false;
}

// One check -> { result: 'open' | 'blocked' | 'unknown', why }.
// probe: { url (requested), finalUrl, status, redirected, body, headers: {name: value}, error }
export function classify(probe) {
  const p = probe || {};
  const want = hostOf(p.url);
  if (p.error) return { result: 'unknown', why: 'network: ' + String(p.error).slice(0, 80) };
  const finalHost = hostOf(p.finalUrl || p.url);
  if (!finalHost) return { result: 'unknown', why: 'no response' };
  if (isBlockerHost(finalHost) && !isBlockerHost(want)) return { result: 'blocked', why: 'sent to ' + finalHost };
  const headers = p.headers || {};
  for (const k of Object.keys(headers)) {
    if (/^(location|refresh|server|via|x-[\w-]*)$/i.test(k) && /techloq/i.test(String(headers[k])) && !isBlockerHost(want)) {
      return { result: 'blocked', why: 'header ' + k.toLowerCase() };
    }
  }
  if (looksLikeBlockPage(p.body)) return { result: 'blocked', why: 'block page' };
  const st = Number(p.status) || 0;
  if (!st) return { result: 'unknown', why: 'no status' };
  if (st >= 500 || st === 407 || st === 451) return { result: 'unknown', why: 'status ' + st };
  if (!sameSite(finalHost, want)) return { result: 'unknown', why: 'other site ' + finalHost };
  return { result: 'open', why: 'status ' + st };
}

// Applies one check result to a history entry. Returns { entry, approvedNow, confirmSoon }.
// Status: 'pending' (not seen yet or no answer), 'blocked' (still blocked), 'approved'.
// Approved needs two "open" checks in a row, at least CONFIRM_GAP_MS apart; a "blocked" check
// starts over, an "unknown" one (network trouble) changes nothing.
export function applyCheck(entry, check, now) {
  const e = Object.assign({}, entry);
  const out = { entry: e, approvedNow: false, confirmSoon: false };
  if (e.status === 'approved') return out;
  e.checkedAt = now;
  e.lastResult = check.result;
  e.lastWhy = check.why || '';
  if (check.result === 'blocked') {
    e.status = 'blocked';
    e.seenBlocked = true;
    e.openCount = 0;
    e.lastOpenAt = 0;
  } else if (check.result === 'open') {
    if (!e.openCount) {
      e.openCount = 1;
      e.lastOpenAt = now;
      out.confirmSoon = true;
    } else if (now - (e.lastOpenAt || 0) >= CONFIRM_GAP_MS) {
      e.openCount += 1;
      e.lastOpenAt = now;
    } else {
      out.confirmSoon = true;  // too soon after the last one to count
    }
    if (e.openCount >= 2) {
      e.status = 'approved';
      e.approvedAt = now;
      out.approvedNow = true;
      out.confirmSoon = false;
    }
  }
  if (!e.status) e.status = 'pending';
  return out;
}

// Should this entry be checked now?
export function isDue(entry, now) {
  if (!entry || !entry.url || entry.status === 'approved') return false;
  if (!/^https?:\/\//i.test(entry.url)) return false;
  return now - (entry.at || 0) <= CHECK_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

// The key that ties a history entry to its check (older entries have no id).
export function entryKey(h) {
  return h.id || ((h.at || 0) + '|' + (h.url || ''));
}

// One check per distinct target: a page address, or a blocked-parts request by its own key.
export function checkKey(h) {
  return h && h.kind === 'parts' ? 'parts:' + entryKey(h) : (h && h.url) || '';
}

// The address to check for an entry: the page itself, then its site's front page.
export function probeTargets(url) {
  try {
    const u = new URL(url);
    const origin = u.origin + '/';
    return u.href === origin ? [u.href] : [u.href, origin];
  } catch (e) {
    return [];
  }
}

// Notifications carry the address they announce in their id.
export const NOTE_PREFIX = 'sr-approved|';

export function notificationId(url) {
  return NOTE_PREFIX + url;
}

export function urlFromNotificationId(id) {
  if (!String(id || '').startsWith(NOTE_PREFIX)) return '';
  const url = id.slice(NOTE_PREFIX.length);
  return /^https?:\/\//i.test(url) ? url : '';
}
