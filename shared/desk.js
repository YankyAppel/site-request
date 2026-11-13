// 1.6.0: "Link" mode. Requests go straight to the network company's request desk instead of an email.
// Only people the desk gave a personal key can use it; everyone else sends by email.
// Each request is locked here, in the browser, with the desk's public key, so only the desk's
// own computers can open it. The desk's web address only passes the locked request on.

// The desk's address is built in and never shown. (A test build points it at a local server.)
export const DESK_URL = 'https://requests.softhere.work';
export const DESK_DEFAULT = DESK_URL;
export const DEST_LABEL = 'your request desk';

// A personal key as the desk makes it: SR-XXXX-XXXX-XXXX-XXXX (no 0, 1, I or O).
// Typed in any case, with or without the dashes or the "SR".
const KEY_RE = /^SR[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/;
export function normKey(k) {
  let s = String(k == null ? '' : k).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length === 16) s = 'SR' + s;
  return KEY_RE.test(s) ? s : '';
}
export function showKey(k) {
  const n = normKey(k);
  return n ? 'SR-' + n.slice(2).match(/.{4}/g).join('-') : String(k == null ? '' : k).trim();
}
export function hasKey(s) {
  return !!(s && normKey(s.deskKey) && s.keyOk === true);
}
const INFO = 'site-request-desk v1';
const enc = new TextEncoder();

export function isLinkMode(s) {
  return !!s && s.sendMode === 'link';
}

// The desk's base address ("https://requests.example.com"), or '' when it is not one.
// Plain http is only allowed for this computer itself.
export function deskBase(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return '';
    if (!local && !u.hostname.includes('.')) return '';
    if (u.username || u.password) return '';
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch (e) {
    return '';
  }
}

export function deskLabel(v) {
  const b = deskBase(v);
  try { return b ? new URL(b).host : ''; } catch (e) { return ''; }
}

// Whether requests have somewhere to go: an email address, or a valid personal key in Link mode.
export function hasDestination(s, isEmail) {
  if (isLinkMode(s)) return hasKey(s);
  return isEmail(s && s.to);
}

// What the user sees as the place a request goes. The desk's address itself is never shown.
export function destLabel(s, isEmail) {
  if (isLinkMode(s)) return hasKey(s) ? DEST_LABEL : '';
  return isEmail(s && s.to) ? String(s.to).trim() : '';
}

function b64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function fingerprint(pub) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(pub.x) + '.' + String(pub.y))));
  const h = [...d.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
  return h.match(/.{4}/g).join(' ');
}

// Locks one request for the desk: a one-time key pair, ECDH with the desk's public key, HKDF, AES-GCM.
export async function lockForDesk(pubJwk, deskId, obj) {
  if (!pubJwk || pubJwk.kty !== 'EC' || pubJwk.crv !== 'P-256') throw new Error('bad_key');
  const pub = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: pubJwk.x, y: pubJwk.y }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256);
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: ephRaw, info: enc.encode(INFO) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('desk:' + deskId) }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, e: b64(ephRaw), iv: b64(iv), ct: b64(ct) };
}

// The desk API paths this file may call. Nothing else is ever fetched.
const API_PATHS = ['/api/key', '/api/check', '/api/send'];

async function call(base, path, opts, ms) {
  // The fetched address is rebuilt here from a deskBase()-validated base and a
  // fixed API path: no caller-supplied URL ever reaches fetch().
  if (!API_PATHS.includes(path)) return { status: 0, data: { error: 'bad_path' } };
  const b = deskBase(base);
  if (!b) return { status: 0, data: { error: 'bad_desk' } };
  const url = new URL(path, b).href;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 15000);
  try {
    const r = await fetch(url, Object.assign({ credentials: 'omit', cache: 'no-store', signal: ctl.signal }, opts));
    let data = null;
    try { data = await r.json(); } catch (e) { /* not JSON */ }
    return { status: r.status, data };
  } finally {
    clearTimeout(t);
  }
}

// Sends one request to the desk with the person's key. Returns { ok, id, fp } or { ok: false, error }.
// desk_key_off: the desk does not take this key (turned off, or not a key of this desk).
export async function sendToDesk(deskUrl, key, payload, fetchKey) {
  const base = deskBase(deskUrl);
  if (!base) return { ok: false, error: 'bad_desk' };
  const k0 = normKey(key);
  if (!k0) return { ok: false, error: 'desk_no_key' };
  let k;
  try {
    k = fetchKey ? await fetchKey(base) : await call(base, '/api/key', { method: 'GET' });
  } catch (e) {
    return { ok: false, error: 'desk_unreachable' };
  }
  if (!k || k.status !== 200 || !k.data || !k.data.ok) return { ok: false, error: k && k.status === 404 ? 'not_a_desk' : 'desk_unreachable' };
  if (!k.data.ready) return { ok: false, error: 'desk_not_ready' };
  let env;
  try {
    env = await lockForDesk(k.data.pub, k.data.deskId, Object.assign({}, payload, { key: k0 }));
  } catch (e) {
    return { ok: false, error: 'desk_bad_key' };
  }
  let r;
  try {
    r = await call(base, '/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deskId: k.data.deskId, key: k0, env }) });
  } catch (e) {
    return { ok: false, error: 'desk_unreachable' };
  }
  if (r.status === 200 && r.data && r.data.ok) return { ok: true, id: r.data.id, fp: k.data.fp || '' };
  if (r.status === 429) return { ok: false, error: 'desk_busy' };
  if (r.status === 409 && r.data && r.data.error === 'not_ready') return { ok: false, error: 'desk_not_ready' };
  if (r.status === 403 && r.data && /^key_/.test(r.data.error || '')) return { ok: false, error: 'desk_key_off' };
  return { ok: false, error: 'desk_refused' };
}

// Checks a personal key with the desk: { ok: true, valid } or { ok: false, error }.
export async function checkKey(deskUrl, key) {
  const base = deskBase(deskUrl);
  if (!base) return { ok: false, error: 'bad_desk' };
  const k = normKey(key);
  if (!k) return { ok: true, valid: false, format: false };
  try {
    const r = await call(base, '/api/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: k }) });
    if (r.status === 429) return { ok: false, error: 'desk_busy' };
    if (r.status !== 200 || !r.data || !r.data.ok) return { ok: false, error: r.status === 409 ? 'desk_not_ready' : 'desk_unreachable' };
    return { ok: true, valid: !!r.data.valid, off: !!r.data.off };
  } catch (e) {
    return { ok: false, error: 'desk_unreachable' };
  }
}

// What the desk gets: the site, the page, the reasons and your account details from Settings.
export function deskPayload(s, meta) {
  const why = meta.reason && typeof meta.reason === 'object' ? meta.reason : null;
  const p = {
    v: 1, id: meta.id, kind: meta.kind || 'site', at: meta.at || Date.now(),
    url: meta.url || '', domain: meta.domain || '', scope: meta.scope || '', target: meta.target || '',
    blockReason: meta.blockReason || '',
    why: why ? { label: String(why.label || ''), text: String(why.text || ''), details: String(why.details || '') } : null,
    name: String(s.name || '').trim(), phone: String(s.phone || '').trim(), pin: String(s.pin || '').trim(), notes: String(s.notes || '').trim(),
    nth: meta.nth || 1, ver: meta.ver || ''
  };
  if (meta.items) p.items = meta.items.slice(0, 40);
  if (meta.ref) { p.ref = meta.ref; p.refAt = meta.refAt || 0; }
  return p;
}
