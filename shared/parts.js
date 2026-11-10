// Hidden blocks: parts of an open page (images, scripts, styles, video, frames, data calls)
// that did not load because their address is blocked. Pure functions: shared by the
// background worker and the tests.
import { isBlockerHost, looksLikeBlockPage } from './approval.js';
import { extractBlockedUrl, baseDomain } from './url.js';

// Request type -> the word shown in the popup.
const KINDS = {
  image: 'images', imageset: 'images', script: 'scripts', stylesheet: 'styles', font: 'fonts',
  media: 'video', sub_frame: 'frames', object: 'frames', xmlhttprequest: 'data', websocket: 'data',
  ping: 'data', csp_report: 'data', other: 'other'
};
export function kindOf(type) {
  return KINDS[type] || 'other';
}

// Errors that point at the network refusing the address. Errors that come from the page
// or the browser itself (ERR_ABORTED, ERR_BLOCKED_BY_CLIENT from an ad blocker, ...) are not counted.
const ERRORS = [
  [/^net::ERR_(SSL_[A-Z0-9_]+|CERT_[A-Z0-9_]+|BAD_SSL_CLIENT_AUTH_CERT)$/, 'secure connection failed'],
  [/^net::ERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED)$/, 'name lookup failed'],
  [/^net::ERR_(CONNECTION_(RESET|CLOSED|REFUSED|TIMED_OUT|FAILED)|TIMED_OUT|EMPTY_RESPONSE|ADDRESS_UNREACHABLE|TUNNEL_CONNECTION_FAILED|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR|NETWORK_ACCESS_DENIED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED)$/, 'connection cut']
];
export function errorWhy(error) {
  const e = String(error || '');
  for (const [re, why] of ERRORS) if (re.test(e)) return why;
  return '';
}

export function hostOf(href) {
  try { return new URL(href).hostname.toLowerCase().replace(/\.$/, ''); } catch (e) { return ''; }
}

function headerMarker(headers) {
  for (const h of headers || []) {
    const name = String(h.name || '').toLowerCase();
    if (/^(location|refresh|server|via|x-[\w-]*)$/.test(name) && /techloq/i.test(String(h.value || ''))) return name;
  }
  return '';
}

// One webRequest event -> { host, why } when it shows a blocked part, else null.
// ev: { event: 'redirect' | 'error' | 'headers' | 'completed', url, redirectUrl, error, statusCode,
//       type, responseHeaders: [{name, value}] }
// ctx: { pageHost }
export function blockSignal(ev, ctx) {
  if (!ev || ev.type === 'main_frame') return null;
  const c = ctx || {};
  let host = hostOf(ev.url);
  if (!host) return null;
  if (isBlockerHost(host)) {
    // A frame or resource that ended on the block page itself: the page names the address.
    if (ev.event === 'error') return null;
    const orig = hostOf(extractBlockedUrl(ev.url));
    if (!orig || orig === c.pageHost || isBlockerHost(orig)) return null;
    return { host: orig, why: 'block page' };
  }
  if (host === c.pageHost) return null;
  if (ev.event === 'redirect') {
    return isBlockerHost(hostOf(ev.redirectUrl)) ? { host, why: 'sent to block page' } : null;
  }
  if (ev.event === 'error') {
    const why = errorWhy(ev.error);
    return why ? { host, why } : null;
  }
  // headers / completed
  const marker = headerMarker(ev.responseHeaders);
  if (marker === 'location') return { host, why: 'sent to block page' };
  if (marker) return { host, why: 'block page' };
  if (Number(ev.statusCode) === 451) return { host, why: 'block page' };
  return null;
}

// Chrome refuses a web page sent in place of an image, script or style (ERR_BLOCKED_BY_ORB) and
// does not show it to extensions. Such an answer is fetched once more in the background and its
// text is checked; true when that check is worth doing for this event.
export function needsBodyCheck(ev, ctx) {
  if (!ev || ev.event !== 'error' || ev.type === 'main_frame') return false;
  if (!/^net::ERR_BLOCKED_BY_(ORB|RESPONSE)$/.test(String(ev.error || ''))) return false;
  const host = hostOf(ev.url);
  return !!host && !isBlockerHost(host) && host !== ((ctx && ctx.pageHost) || '') && /^https?:/i.test(ev.url);
}

// The background re-fetch of such an answer -> { host, why } or null.
// probe: { finalUrl, body, error }
export function bodySignal(url, probe) {
  const host = hostOf(url);
  if (!host || !probe || probe.error) return null;
  if (isBlockerHost(hostOf(probe.finalUrl || url))) return { host, why: 'sent to block page' };
  return looksLikeBlockPage(probe.body) ? { host, why: 'block page' } : null;
}

// A short built-in list of ad and tracker hosts. They are listed, but left out of a request
// unless ticked.
export const AD_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'googletagservices.com', 'adservice.google.com', 'connect.facebook.net',
  'scorecardresearch.com', 'adnxs.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
  'amazon-adsystem.com', 'hotjar.com', 'quantserve.com', 'moatads.com', 'pubmatic.com',
  'rubiconproject.com', 'openx.net', 'adsrvr.org', 'casalemedia.com', 'bat.bing.com', 'clarity.ms',
  'quantcount.com', 'chartbeat.com', 'newrelic.com', 'nr-data.net', 'mixpanel.com', 'segment.io'
];
export function isAdHost(host) {
  const h = String(host || '').toLowerCase();
  return AD_HOSTS.some(a => h === a || h.endsWith('.' + a));
}

// Hosts -> request lines. Two or more hosts under the same base become one wildcard
// ("a.cdn.example.com" + "b.cdn.example.com" -> "*.cdn.example.com"); the longest shared
// base wins, and a base is never shorter than the site's own domain ("*.com" never happens).
// Returns [{ label, hosts, base, wildcard, ad }], sorted: not-ads first, then by label.
export function groupHosts(hostList) {
  const hosts = [...new Set((hostList || []).map(h => String(h || '').toLowerCase().replace(/\.$/, '')).filter(Boolean))].sort();
  const bases = new Map();  // base -> hosts below it (or equal to it)
  for (const h of hosts) {
    if (/^[\d.]+$/.test(h) || h.includes(':')) continue;
    const site = baseDomain(h);
    const labels = h.split('.');
    const min = site.split('.').length;
    for (let n = labels.length - 1; n >= min; n--) {
      const b = labels.slice(-n).join('.');
      if (!bases.has(b)) bases.set(b, []);
      bases.get(b).push(h);
    }
  }
  for (const h of hosts) if (bases.has(h)) bases.get(h).push(h);  // "example.com" itself joins "*.example.com"
  const order = [...bases.keys()].sort((a, b) => b.split('.').length - a.split('.').length || a.localeCompare(b));
  const used = new Set();
  const out = [];
  for (const b of order) {
    const free = [...new Set(bases.get(b))].filter(h => !used.has(h));
    if (free.length < 2) continue;
    free.forEach(h => used.add(h));
    out.push({ label: (free.includes(b) ? b + ', *.' : '*.') + b, hosts: free.sort(), base: b, wildcard: true });
  }
  for (const h of hosts) {
    if (!used.has(h)) out.push({ label: h, hosts: [h], base: h, wildcard: false });
  }
  for (const g of out) g.ad = g.hosts.every(isAdHost);
  return out.sort((a, b) => (a.ad - b.ad) || a.label.replace(/^\*\./, '').localeCompare(b.label.replace(/^\*\./, '')));
}

// The per-tab record kept by the background worker.
// { page, pageHost, at, hosts: { host: { why, kinds: [..], n } } }
export function newRecord(pageUrl, now) {
  return { page: pageUrl || '', pageHost: hostOf(pageUrl), at: now || Date.now(), hosts: {} };
}

// Adds one signal; returns true when the record changed.
export function addSignal(rec, sig, type) {
  if (!rec || !sig || !sig.host) return false;
  const k = kindOf(type);
  const cur = rec.hosts[sig.host];
  if (!cur) {
    rec.hosts[sig.host] = { why: sig.why, kinds: [k], n: 1 };
    return true;
  }
  cur.n += 1;
  if (!cur.kinds.includes(k)) cur.kinds.push(k);
  return true;
}

// The groups for a record, and the count shown on the badge (ads and trackers not counted).
export function summary(rec) {
  const groups = groupHosts(Object.keys((rec && rec.hosts) || {}));
  for (const g of groups) {
    const kinds = new Set();
    const whys = new Set();
    for (const h of g.hosts) {
      const x = rec.hosts[h] || {};
      (x.kinds || []).forEach(k => kinds.add(k));
      if (x.why) whys.add(x.why);
    }
    g.kinds = [...kinds];
    g.whys = [...whys];
  }
  return { groups, count: groups.filter(g => !g.ad).length };
}
