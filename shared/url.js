// URL helpers shared by the popup, the background worker and the tests.
import { reasonBlock } from './reasons.js';
import { htmlRequest, htmlFromText } from './html.js';

const BLOCK_HOST = /^filter[\w-]*\.techloq\.[a-z.]+$/i;

// Query parameter names that may carry the original address, most likely first.
export const PARAM_NAMES = [
  'redirectUrl', 'redirect_url', 'redirect', 'url', 'u', 'blockedUrl', 'blocked_url',
  'blocked', 'site', 'target', 'dest', 'destination', 'originalUrl', 'original_url',
  'requestedUrl', 'requested_url', 'link', 'href', 'page', 'q'
];

export function isBlockPage(href) {
  try {
    return BLOCK_HOST.test(new URL(href).hostname);
  } catch (e) {
    return false;
  }
}

function decodeLoose(value) {
  let s = String(value == null ? '' : value).trim();
  for (let i = 0; i < 4 && /%[0-9a-f]{2}/i.test(s); i++) {
    try {
      const d = decodeURIComponent(s);
      if (d === s) break;
      s = d;
    } catch (e) {
      break;
    }
  }
  return s;
}

// Turns a raw value into a clean http(s) address, or '' when it is not one.
export function cleanCandidate(value) {
  let s = decodeLoose(value);
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(s)) {
    try {
      const d = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
      if (/^https?:\/\//i.test(d)) s = d;
    } catch (e) { /* not base64 */ }
  }
  if (/^\/\//.test(s)) s = 'http:' + s;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(s) && /[a-z]/i.test(s.split(/[/?#:]/)[0].split('.').pop())) {
      s = 'http://' + s;
    } else {
      return '';
    }
  }
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return '';
    if (isBlockPage(u.href)) return '';
    return u.href;
  } catch (e) {
    return '';
  }
}

function looksLikeAddress(raw) {
  const s = decodeLoose(raw);
  return /^(https?:\/\/|\/\/|www\.)/i.test(s);
}

function fromParams(search) {
  const sp = new URLSearchParams(search);
  const map = {};
  for (const [k, v] of sp) {
    const lk = k.toLowerCase();
    if (!(lk in map)) map[lk] = v;
  }
  for (const name of PARAM_NAMES) {
    const lk = name.toLowerCase();
    if (!(lk in map)) continue;
    // An address that was not encoded keeps its own "&" parts: take the rest of the query.
    const re = new RegExp('[?&]' + name + '=(.*)$', 'i');
    const m = ('?' + search.replace(/^\?/, '')).match(re);
    if (m && /^https?:\/\//i.test(m[1]) && m[1].includes('&')) {
      const whole = cleanCandidate(m[1]);
      if (whole) return whole;
    }
    const c = cleanCandidate(map[lk]);
    if (c) return c;
  }
  for (const [, v] of sp) {
    if (looksLikeAddress(v)) {
      const c = cleanCandidate(v);
      if (c) return c;
    }
  }
  return '';
}

// Reads the original address out of a block page address. Returns '' when none is found.
export function extractBlockedUrl(href) {
  let u;
  try {
    u = new URL(href);
  } catch (e) {
    return '';
  }
  let found = fromParams(u.search);
  if (found) return found;

  // Hash routes, e.g. #/block-page?redirectUrl=...
  const hash = u.hash.replace(/^#!?/, '');
  const qi = hash.indexOf('?');
  if (qi >= 0) found = fromParams(hash.slice(qi));
  else if (hash.includes('=')) found = fromParams(hash);
  if (found) return found;

  // Path shapes, e.g. /block-page/https%3A%2F%2Fexample.com or /block/example.com/page
  const full = u.pathname + (qi >= 0 ? '' : u.hash);
  const m = full.match(/(https?(?::|%3A)(?:\/\/|%2F%2F|\/%2F).*)$/i);
  if (m) {
    const c = cleanCandidate(m[1] + (u.search || ''));
    if (c) return c;
  }
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length >= 2) {
    const rest = decodeLoose(segs.slice(1).join('/'));
    if (/^[\w-]+(\.[\w-]+)+$/.test(rest.split('/')[0])) {
      const c = cleanCandidate(rest + (u.search || ''));
      if (c) return c;
    }
  }
  return '';
}

export function domainOf(href) {
  try {
    return new URL(href).hostname.replace(/^www\./i, '');
  } catch (e) {
    return '';
  }
}

export function formatDate(d) {
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(url|domain|date|reason|target|ask|page|why)\}/gi, (_, k) => vars[k.toLowerCase()] || '');
}

// Cleans the reason text read from a block page; '' when there is none.
export function cleanReason(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s || s.length > 300) return s ? s.slice(0, 300) : '';
  return s;
}

// Reads the reason from block page text, e.g. 'Why? Locked Web Category: "Uncategorized"'.
export function reasonFromText(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^why\s*\??\s*:?\s*(.*)$/i);
    if (!m) continue;
    const rest = m[1].trim();
    if (rest) return cleanReason(rest);
    if (lines[i + 1] && !/^(requested url|filter action|why)\b/i.test(lines[i + 1])) return cleanReason(lines[i + 1]);
  }
  return '';
}

export function composeUrl({ to, subject, body, account }) {
  const acct = String(account == null ? '' : account).trim() || '0';
  return 'https://mail.google.com/mail/u/' + encodeURIComponent(acct) +
    '/?view=cm&fs=1&tf=1' +
    '&to=' + encodeURIComponent(to) +
    '&su=' + encodeURIComponent(subject) +
    '&body=' + encodeURIComponent(body);
}

export const DEFAULTS = {
  to: '',
  account: '0',
  name: '',
  phone: '',
  pin: '',
  notes: '',
  subject: 'Site request: {domain}',
  checkApproved: true,
  remind: true,
  callNumber: '',
  htmlMail: true,
  defaultReason: '',
  blockPanel: true,
  blockPanelAuto: true,
  body: 'Hello,\n\n{ask}\n\n{target}\n\n{why}\n\nSite: {domain}\nPage: {page}\nRequested: {date}\nBlocked as: {reason}\n\nThank you very much.'
};

// The default message of 1.3.0 and 1.3.1. A saved copy of it is read as the new default too.
export const BODY_13 = 'Hello,\n\n{ask}\n\n{target}\n\nSite: {domain}\nPage: {page}\nRequested: {date}\nReason: {reason}\n\nThank you very much.';

// The message every version up to 1.2.0 used by default. A saved copy of it is read as the new default.
export const OLD_DEFAULT_BODY = 'Hello,\n\nPlease open the following site for my account:\n\n{url}\n\nSite: {domain}\nRequested: {date}\nReason: {reason}\n\nThank you very much.';

export function bodyTemplate(s) {
  const b = String((s && s.body) || '');
  return !b.trim() || b === OLD_DEFAULT_BODY || b === BODY_13 ? DEFAULTS.body : b;
}

// Same registrable-domain rule as the approval check: "www.news.example.co.uk" -> "example.co.uk".
const TWO_PART_TLDS = /\.(co|com|org|net|gov|ac|edu|ltd|plc|me)\.[a-z]{2}$/i;
export function baseDomain(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  return parts.slice(-(TWO_PART_TLDS.test(host) ? 3 : 2)).join('.');
}

// What a request asks for: 'site' = the whole domain, 'page' = the exact address.
// Techloq has no wildcard entries, so a whole-site ask is the plain base domain;
// the addresses to allow, one per line, come from siteAllowList().
export function scopeTarget(url, scope) {
  if (scope === 'page') return url;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return url; }
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  return baseDomain(host);
}

// The addresses a filter that cannot allow wildcards needs for a whole site, one per line:
// the host you were on, the bare domain, and its www. twin. IP addresses stay a single host.
export function siteAllowList(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return [url]; }
  if (/^[\d.]+$/.test(host) || host.includes(':')) return [host];
  const base = baseDomain(host);
  return [...new Set([host, base, 'www.' + base])];
}

export const ASK = {
  site: 'Please open this whole site for my account, including all of its pages. Each address below needs its own allow line (a wildcard like *.example.com cannot be entered):',
  page: 'Please open just this one page for my account (not the whole site):'
};

// The subdomains of a domain the public certificate logs know about, one name per line.
// Techloq has no wildcard entries, so each known subdomain needs its own allow line.
// Two sources are tried: crt.sh, then the Cert Spotter API when crt.sh is down or slow.
// Returns [] on any failure — the request still goes out with the basic addresses.
export async function fetchSubdomains(base, max) {
  max = max || 40;
  base = String(base || '').toLowerCase();
  if (!base || /^[\d.]+$/.test(base) || base.includes(':')) return [];
  const keep = n => {
    const name = String(n || '').toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    return (name === base || name.endsWith('.' + base)) && !/[\s*]/.test(name) ? name : '';
  };
  const finish = set => [...set].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, max);
  for (const source of ['crtsh', 'certspotter']) {
    try {
      const url = source === 'crtsh'
        ? 'https://crt.sh/?q=%25.' + encodeURIComponent(base) + '&output=json'
        : 'https://api.certspotter.com/v1/issuances?domain=' + encodeURIComponent(base) +
          '&include_subdomains=true&expand=dns_names';
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;      // crt.sh 502s under load — move to the next source
      const rows = await r.json();
      const out = new Set();
      for (const row of Array.isArray(rows) ? rows : []) {
        const names = source === 'crtsh'
          ? String(row.common_name || '') + '\n' + String(row.name_value || '')
          : (row.dns_names || []).join('\n');
        for (const h of String(names).split(/\s+/)) {
          const name = keep(h);
          if (name) out.add(name);
        }
      }
      if (out.size) return finish(out);
    } catch (e) {
      // Timeout or bad JSON from this source — fall through to the next one.
      console.warn('site-request: ' + source + ' subdomain lookup failed:', e);
    }
  }
  return [];
}

// The full whole-site list: the host, the bare domain, www.<domain>, plus the subdomains crt.sh knows.
export function mergedAllowList(url, subdomains) {
  const seen = new Set(siteAllowList(url));
  const rest = (subdomains || []).filter(h => !seen.has(h));
  return [...seen, ...rest];
}

export function isEmail(s) {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(s || '').trim());
}

// The account details block added under the message. Empty fields are left out.
export function detailsBlock(s) {
  const lines = [];
  if (String(s.name || '').trim()) lines.push('Name: ' + s.name.trim());
  if (String(s.phone || '').trim()) lines.push('Phone: ' + s.phone.trim());
  if (String(s.pin || '').trim()) lines.push('Account PIN: ' + s.pin.trim());
  const notes = String(s.notes || '').trim();
  if (!lines.length && !notes) return '';
  return '\n\n--\nAccount details:\n' + lines.join('\n') + (notes ? (lines.length ? '\n' : '') + notes : '');
}

// Fills the message. A line holding {reason}, {page} or {why} is left out when it has no value;
// when the template has no {reason}, a found block reason is added as its own line, and when it has
// no {why}, your reason is added at the end. A message of your own without {ask} or {target} gets
// one line saying what is asked for.
function fillBody(tpl, vars, scope) {
  let t = String(tpl || '');
  for (const k of ['reason', 'page', 'why']) {
    const re = new RegExp('\\{' + k + '\\}', 'i');
    if (!vars[k] && re.test(t)) t = t.split('\n').filter(l => !re.test(l)).join('\n');
  }
  let body = fillTemplate(t, vars);
  if (!/\{reason\}/i.test(t) && vars.reason) body += '\n\nBlocked as: ' + vars.reason;
  if (!/\{(ask|target)\}/i.test(t)) {
    body += scope === 'page'
      ? '\n\nPlease open just this page, not the whole site.'
      : '\n\nPlease open the whole site:\n' + vars.target;
  }
  if (!/\{why\}/i.test(t) && vars.why) body += '\n\n' + vars.why;
  return body.replace(/\n{3,}/g, '\n\n');
}

// mine = the reason you chose: { label, text, details } or null.
// allow = extra whole-site addresses (subdomains from crt.sh) merged into siteAllowList.
export function buildEmail(s, url, now, reason, scope, mine, allow) {
  scope = scope === 'page' ? 'page' : 'site';
  const vars = {
    url, domain: domainOf(url), date: formatDate(now || new Date()), reason: cleanReason(reason),
    target: scope === 'site' ? mergedAllowList(url, allow).join('\n') : url, ask: ASK[scope],
    page: scope === 'site' ? url : '', why: reasonBlock(mine)
  };
  return {
    to: String(s.to || '').trim(),
    subject: fillTemplate(s.subject || DEFAULTS.subject, vars),
    body: fillBody(bodyTemplate(s), vars, scope) + detailsBlock(s),
    // 1.5.5: the formatted version. Your own message from Settings keeps its words (as paragraphs).
    html: s.htmlMail === false ? '' : (bodyTemplate(s) === DEFAULTS.body
      ? htmlRequest({ domain: vars.domain, target: vars.target, url, scope, why: mine }, s)
      : htmlFromText(fillBody(bodyTemplate(s), vars, scope), s)),
    domain: vars.domain,
    reason: vars.reason,
    scope,
    target: vars.target
  };
}

// One email for the blocked parts of a page: every address on its own line.
export function buildPartsEmail(s, pageUrl, items, now, mine) {
  const domain = domainOf(pageUrl);
  const why = reasonBlock(mine);
  const list = items.map(i => String(i).trim()).filter(Boolean);
  const n = list.length;
  const out = {
    to: String(s.to || '').trim(),
    subject: 'Site request: ' + n + (n === 1 ? ' address' : ' addresses') + ' used by ' + domain,
    body: 'Hello,\n\nThe site ' + domain + ' opens, but parts of it do not load because ' +
      (n === 1 ? 'this address is' : 'these addresses are') + ' blocked. Please open ' + (n === 1 ? 'it' : 'them') + ' for my account:\n\n' +
      list.join('\n') + (why ? '\n\n' + why : '') + '\n\nPage: ' + pageUrl + '\nRequested: ' + formatDate(now || new Date()) + '\n\nThank you very much.' + detailsBlock(s),
    domain
  };
  if (s.htmlMail !== false) out.html = htmlFromText(out.body, s);
  return out;
}

// The short follow-up for a request that is still not open.
export function buildReminderEmail(s, entry, now) {
  let subject = entry.subject;
  let target = entry.target;
  if (!subject || !target) {
    const orig = buildEmail(s, entry.url, new Date(entry.at || Date.now()), '', entry.scope);
    subject = subject || orig.subject;
    target = target || orig.target;
  }
  const what = entry.kind === 'parts' && Array.isArray(entry.items) ? entry.items.join('\n') : target;
  const why = reasonBlock(entry.reason);
  const out = {
    to: String(entry.to || s.to || '').trim(),
    subject: 'Reminder: ' + subject,
    body: 'Hello,\n\nThis is a short reminder about my request from ' + formatDate(new Date(entry.at || now)) +
      '. It is still blocked:\n\n' + what + (why ? '\n\n' + why : '') + '\n\nCould you please take a look?\n\nThank you very much.' + detailsBlock(s)
  };
  if (s.htmlMail !== false) out.html = htmlFromText(out.body, s);
  return out;
}

