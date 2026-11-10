// Update check against the project's GitHub releases.
// Route 1: github.com/<repo>/releases/latest redirects to /releases/tag/vX.Y.Z; the version is read
//          from where it lands (no API call, works where api.github.com is not reachable).
// Route 2: the GitHub releases API.
// Route 3: a small version.json on a backup address, when one is set (BACKUP_VERSION_URL).

export const REPO = 'YankyAppel/site-request';
export const RELEASES_API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
export const RELEASES_PAGE = 'https://github.com/' + REPO + '/releases/latest';
export const ASSET_NAME = 'site-request.zip';
export const BACKUP_VERSION_URL = '';
const TIMEOUT_MS = 15000;

// "v1.2.3" -> [1, 2, 3]; null when it is not a version.
export function parseVersion(v) {
  const m = String(v == null ? '' : v).trim().match(/^v?(\d+(?:\.\d+){0,3})$/i);
  return m ? m[1].split('.').map(Number) : null;
}

// 1 when a is newer than b, -1 when older, 0 when the same.
export function compareVersions(a, b) {
  const x = parseVersion(a) || [0];
  const y = parseVersion(b) || [0];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// "https://github.com/<repo>/releases/tag/v1.3.0" -> "v1.3.0"; '' for anything else.
export function tagFromReleaseUrl(url) {
  const esc = REPO.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const m = String(url || '').match(new RegExp('^https://github\\.com/' + esc + '/releases/tag/([^/?#]+)/?(?:[?#].*)?$', 'i'));
  if (!m) return '';
  let tag = m[1];
  try { tag = decodeURIComponent(tag); } catch (e) { /* keep */ }
  return parseVersion(tag) ? tag : '';
}

async function timedFetch(f, url, opts) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    return await f(url, Object.assign({ cache: 'no-store', credentials: 'omit', signal: ctl ? ctl.signal : undefined }, opts || {}));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errText(e) {
  return e && e.name === 'AbortError' ? 'timeout' : 'network';
}

async function viaPage(f) {
  let res;
  try {
    res = await timedFetch(f, RELEASES_PAGE, { redirect: 'follow' });
  } catch (e) {
    return { error: errText(e) };
  }
  try { if (res && res.body && res.body.cancel) res.body.cancel().catch(() => {}); } catch (e) { /* nothing to cancel */ }
  const tag = tagFromReleaseUrl(res && res.url);
  if (!tag) return { error: res && res.ok === false ? 'http_' + res.status : 'no_tag' };
  return {
    tag,
    assetUrl: 'https://github.com/' + REPO + '/releases/download/' + encodeURIComponent(tag) + '/' + ASSET_NAME,
    pageUrl: 'https://github.com/' + REPO + '/releases/tag/' + encodeURIComponent(tag),
    notes: ''
  };
}

async function viaApi(f) {
  let res;
  try {
    res = await timedFetch(f, RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
  } catch (e) {
    return { error: errText(e) };
  }
  if (!res || !res.ok) return { error: 'http_' + (res ? res.status : 0) };
  let rel;
  try { rel = await res.json(); } catch (e) { return { error: 'bad_answer' }; }
  const tag = String((rel && rel.tag_name) || '');
  if (!parseVersion(tag) || rel.draft || rel.prerelease) return { error: 'no_release' };
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const zip = assets.find(a => a && a.name === ASSET_NAME) || assets.find(a => a && /\.zip$/i.test(a.name || ''));
  return {
    tag,
    assetUrl: zip ? String(zip.browser_download_url || '') : '',
    pageUrl: String(rel.html_url || RELEASES_PAGE),
    notes: String(rel.body || '').slice(0, 2000)
  };
}

// version.json: { "version": "1.3.0", "zip": "https://.../site-request.zip", "page": "https://..." }
async function viaBackup(f, url) {
  let res;
  try {
    res = await timedFetch(f, url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    return { error: errText(e) };
  }
  if (!res || !res.ok) return { error: 'http_' + (res ? res.status : 0) };
  let j;
  try { j = await res.json(); } catch (e) { return { error: 'bad_answer' }; }
  const tag = String((j && j.version) || '');
  if (!parseVersion(tag)) return { error: 'no_release' };
  const https = s => (/^https:\/\//i.test(String(s || '')) ? String(s) : '');
  return { tag, assetUrl: https(j.zip), pageUrl: https(j.page) || https(j.zip) || RELEASES_PAGE, notes: String(j.notes || '').slice(0, 2000) };
}

// Never throws.
// Result: { state: 'newer' | 'same' | 'older' | 'error', current, latest, assetUrl, pageUrl, notes, route, errors, error }
export async function checkLatest(current, fetchImpl, opts) {
  const f = fetchImpl || fetch;
  const backup = opts && 'backupUrl' in opts ? opts.backupUrl : BACKUP_VERSION_URL;
  const out = { state: 'error', current, latest: '', assetUrl: '', pageUrl: RELEASES_PAGE, notes: '', route: '', errors: {}, error: '' };
  const routes = [['github.com', () => viaPage(f)], ['api.github.com', () => viaApi(f)]];
  if (backup) routes.push(['backup', () => viaBackup(f, backup)]);
  for (const [name, run] of routes) {
    let r;
    try { r = await run(); } catch (e) { r = { error: 'network' }; }
    if (r.error) {
      out.errors[name] = r.error;
      continue;
    }
    out.route = name;
    out.latest = r.tag.replace(/^v/i, '');
    out.assetUrl = r.assetUrl;
    out.pageUrl = r.pageUrl;
    out.notes = r.notes;
    const c = compareVersions(out.latest, current);
    out.state = c > 0 ? 'newer' : c < 0 ? 'older' : 'same';
    return out;
  }
  // The last route's reason, as before ('network', 'http_404', ...).
  const names = Object.keys(out.errors);
  out.error = names.length ? out.errors[names[names.length - 1]] : 'network';
  return out;
}
