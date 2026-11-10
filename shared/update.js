// Update check against the project's GitHub releases.

export const REPO = 'YankyAppel/site-request';
export const RELEASES_API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
export const RELEASES_PAGE = 'https://github.com/' + REPO + '/releases/latest';
export const ASSET_NAME = 'site-request.zip';

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

// Asks GitHub for the latest release. Never throws.
// Result: { state: 'newer' | 'same' | 'older' | 'error', current, latest, assetUrl, pageUrl, notes, error }
export async function checkLatest(current, fetchImpl) {
  const f = fetchImpl || fetch;
  const out = { state: 'error', current, latest: '', assetUrl: '', pageUrl: RELEASES_PAGE, notes: '', error: '' };
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 15000) : null;
    let res;
    try {
      res = await f(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
        signal: ctl ? ctl.signal : undefined
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res || !res.ok) {
      out.error = 'http_' + (res ? res.status : 0);
      return out;
    }
    const rel = await res.json();
    const tag = String((rel && rel.tag_name) || '');
    if (!parseVersion(tag) || rel.draft || rel.prerelease) {
      out.error = 'no_release';
      return out;
    }
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const zip = assets.find(a => a && a.name === ASSET_NAME) || assets.find(a => a && /\.zip$/i.test(a.name || ''));
    out.latest = tag.replace(/^v/i, '');
    out.assetUrl = zip ? String(zip.browser_download_url || '') : '';
    out.pageUrl = String(rel.html_url || RELEASES_PAGE);
    out.notes = String(rel.body || '').slice(0, 2000);
    const c = compareVersions(out.latest, current);
    out.state = c > 0 ? 'newer' : c < 0 ? 'older' : 'same';
    return out;
  } catch (e) {
    out.error = 'network';
    return out;
  }
}
