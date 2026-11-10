// Was this site already requested? (1.5.1) Pure functions, shared by bg.js and the popup.
// A request covers an address when it asked for that exact page, or for the whole site the page is on.
import { baseDomain, scopeTarget } from './url.js';

function parse(u) {
  try {
    const x = new URL(String(u || '').trim());
    if (!/^https?:$/.test(x.protocol)) return null;
    return x;
  } catch (e) { return null; }
}

// The same page: protocol, "www.", the #part and a trailing "/" don't matter.
export function samePage(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  const key = u => u.hostname.toLowerCase().replace(/^www\./, '') + (u.port ? ':' + u.port : '') +
    (u.pathname.replace(/\/+$/, '') || '') + u.search;
  return key(x) === key(y);
}

// What a whole-site request asked for, e.g. "*.example.com" (an IP address asks for that host only).
function siteOf(entry) {
  const t = String(entry.target || '');
  if (t.startsWith('*.')) return t.slice(2).toLowerCase();
  const fromUrl = scopeTarget(entry.url, 'site');
  return String(fromUrl || '').replace(/^\*\./, '').toLowerCase();
}

export function covers(entry, url) {
  if (!entry || entry.kind === 'parts' || entry.kind === 'reminder') return false;
  const u = parse(url);
  if (!u) return false;
  if (entry.scope === 'page') return samePage(entry.url, url);
  const site = siteOf(entry);
  if (!site) return false;
  const host = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(site) || site.includes(':')) return host === site;
  return host === site || host.endsWith('.' + site);
}

// Every earlier request that covers this address, newest first.
export function matchRequests(history, url) {
  return (Array.isArray(history) ? history : []).filter(h => covers(h, url)).sort((a, b) => (b.at || 0) - (a.at || 0));
}

// What the block page box, the popup and the toolbar icon show. null = never requested.
export function requestedInfo(history, url) {
  const hits = matchRequests(history, url);
  if (!hits.length) return null;
  const last = hits[0];
  const reason = last.reason || null;
  return {
    count: hits.length,
    at: last.at || 0,
    status: last.status === 'approved' ? 'approved' : 'pending',
    approvedAt: last.approvedAt || 0,
    remindedAt: last.remindedAt || 0,
    scope: last.scope === 'page' ? 'page' : 'site',
    target: last.target || '',
    label: (reason && reason.label) || '',
    details: (reason && reason.details) || '',
    pageOnly: hits.every(h => h.scope === 'page'),
    url: last.url || ''
  };
}

export function ordinal(n) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  const t = n % 100;
  if (t >= 11 && t <= 13) return n + 'th';
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
}

// "Nov 10, 3:08 PM"
export function fmtWhen(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// "Requested 3 times · last Nov 10, 3:08 PM" (only when more than once)
export function countLine(info) {
  if (!info || info.count < 2) return '';
  return 'Requested ' + info.count + ' times \u00b7 last ' + fmtWhen(info.at);
}

// "For work · whole site", "This page"
export function metaLine(info, summary) {
  if (!info) return '';
  const what = info.scope === 'page' ? 'this page' : 'whole site';
  const why = String(summary || '').trim();
  return why ? why + ' \u00b7 ' + what : what.charAt(0).toUpperCase() + what.slice(1);
}

// The toolbar icon of one tab. Order: a new version (red NEW) > blocked parts on the page (amber count)
// > a request still waiting for approval ("✓"). Approved or never requested shows nothing of its own.
export const BADGE = { red: '#d93a3a', amber: '#f29900', requested: '#1a7db6' };
export function badgeFor({ update, parts, requested }) {
  const n = Math.max(0, Number(parts) || 0);
  const waiting = !!(requested && requested.status !== 'approved');
  const partsText = n ? n + (n === 1 ? ' blocked part' : ' blocked parts') + ' on this page' : '';
  const reqText = waiting ? 'already requested ' + fmtWhen(requested.at) + ', waiting for approval' : '';
  const extra = [partsText, reqText].filter(Boolean);
  if (update) {
    return { text: 'NEW', color: BADGE.red, textColor: '#ffffff',
      title: 'Site Request: a new version is available' + (extra.length ? ' \u00b7 ' + extra.join(' \u00b7 ') : '') };
  }
  if (n) {
    return { text: String(Math.min(n, 99)), color: BADGE.amber, textColor: '#1d1e26',
      title: 'Site Request: ' + extra.join(' \u00b7 ') };
  }
  if (waiting) {
    return { text: '\u2713', color: BADGE.requested, textColor: '#ffffff', title: 'Site Request: ' + reqText };
  }
  return { text: '', color: '', textColor: '', title: 'Site Request' };
}
