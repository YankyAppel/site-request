import { DEFAULTS, isBlockPage, composeUrl, isEmail, cleanCandidate, buildEmail } from './shared/url.js';
import { checkLatest, compareVersions } from './shared/update.js';
import {
  CHECK_EVERY_MIN, CHECK_TIMEOUT_MS, CONFIRM_DELAY_MIN, BODY_LIMIT,
  classify, applyCheck, isDue, probeTargets, notificationId, urlFromNotificationId
} from './shared/approval.js';

const JOB_TIMEOUT_MIN = 1.5;
const HISTORY_MAX = 25;

async function getSettings() {
  return chrome.storage.local.get(DEFAULTS);
}

async function getJobs() {
  const { jobs } = await chrome.storage.session.get({ jobs: {} });
  return jobs;
}

async function putJob(job) {
  const jobs = await getJobs();
  jobs[job.id] = job;
  await chrome.storage.session.set({ jobs, status: job });
}

async function findJobByTab(tabId) {
  const jobs = await getJobs();
  return Object.values(jobs).find(j => j.tabId === tabId && j.state === 'sending') || null;
}

async function addHistory(job) {
  const { history } = await chrome.storage.local.get({ history: [] });
  history.unshift({
    id: job.id, url: job.url, domain: job.domain, to: job.to, at: Date.now(),
    fromBlockPage: !!job.fromBlockPage, status: 'pending'
  });
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
}

async function finish(job, state, error) {
  if (job.state !== 'sending') return;
  job.state = state;
  job.error = error || '';
  job.ended = Date.now();
  if (state === 'sent') await addHistory(job);
  await putJob(job);
  if (state === 'sent') {
    setTimeout(() => { chrome.tabs.remove(job.tabId).catch(() => {}); }, 1500);
  }
}

// Compose tabs being opened right now; Gmail may ask about a tab before its job is stored.
let opening = Promise.resolve();

function startRequest(rawUrl, reason, fromBlockPage) {
  const p = doStartRequest(rawUrl, reason, fromBlockPage);
  opening = p.catch(() => {});
  return p;
}

async function doStartRequest(rawUrl, reason, fromBlockPage) {
  const url = cleanCandidate(rawUrl);
  if (!url) return { ok: false, error: 'bad_url' };
  const s = await getSettings();
  if (!isEmail(s.to)) return { ok: false, error: 'no_address' };
  const mail = buildEmail(s, url, new Date(), reason);
  const link = composeUrl({ to: mail.to, subject: mail.subject, body: mail.body, account: s.account });
  const tab = await chrome.tabs.create({ url: link, active: false });
  const job = {
    id: crypto.randomUUID(), tabId: tab.id, url, domain: mail.domain, to: mail.to,
    composeUrl: link, state: 'sending', error: '', started: Date.now(), fromBlockPage: !!fromBlockPage
  };
  await putJob(job);
  try {
    const now = await chrome.tabs.get(tab.id);
    if (now.url && /^https:\/\/accounts\.google\.com\//.test(now.url)) await finish(job, 'error', 'signed_out');
  } catch (e) { /* tab already gone */ }
  chrome.alarms.create('job:' + job.id, { delayInMinutes: JOB_TIMEOUT_MIN });
  return { ok: true, id: job.id };
}

async function openCompose(id) {
  const jobs = await getJobs();
  const job = jobs[id];
  if (!job) return { ok: false };
  try {
    const tab = await chrome.tabs.get(job.tabId);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) {
    await chrome.tabs.create({ url: job.composeUrl, active: true });
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg && msg.type) {
      case 'request':
        return startRequest(msg.url, msg.reason, msg.fromBlockPage);
      case 'check_now':
        return runApprovalCheck({ force: true });
      case 'check_update':
        return checkForUpdate();
      case 'download_update':
        return downloadUpdate();
      case 'open_compose':
        return openCompose(msg.id);
      case 'gmail_ready': {
        // Only compose tabs this extension opened itself are ever touched.
        if (!sender.tab || !/^https:\/\/mail\.google\.com\//.test(sender.url || '')) return { auto: false };
        await opening;
        const job = await findJobByTab(sender.tab.id);
        return job ? { auto: true, id: job.id, to: job.to } : { auto: false };
      }
      case 'gmail_result': {
        if (!sender.tab) return { ok: false };
        const job = await findJobByTab(sender.tab.id);
        if (!job || job.id !== msg.id) return { ok: false };
        await finish(job, msg.state === 'sent' ? 'sent' : 'error', msg.error);
        return { ok: true };
      }
      default:
        return null;
    }
  })().then(reply, err => reply({ ok: false, error: String(err && err.message || err) }));
  return true;
});

// Remember the address each tab tried to open, in case a block page does not carry it.
chrome.webNavigation.onBeforeNavigate.addListener(d => {
  if (d.frameId !== 0 || !/^https?:/i.test(d.url) || isBlockPage(d.url)) return;
  chrome.storage.session.set({ ['nav_' + d.tabId]: d.url });
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const url = info.url || (info.status ? tab.url : '');
  if (!url) return;
  const job = await findJobByTab(tabId);
  if (!job) return;
  if (/^https:\/\/accounts\.google\.com\//.test(url) || /\/ServiceLogin/i.test(url)) {
    await finish(job, 'error', 'signed_out');
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  chrome.storage.session.remove('nav_' + tabId);
  const job = await findJobByTab(tabId);
  if (job) await finish(job, 'error', 'tab_closed');
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === UPDATE_ALARM) return checkForUpdate();
  if (alarm.name === APPROVAL_ALARM || alarm.name === APPROVAL_SOON) return runApprovalCheck({ force: false });
  if (!alarm.name.startsWith('job:')) return;
  const jobs = await getJobs();
  const job = jobs[alarm.name.slice(4)];
  if (job && job.state === 'sending') await finish(job, 'error', 'timeout');
});

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  ensureUpdateAlarm();
  checkForUpdate();
  await ensureApprovalAlarm();
  checkApprovalSoon(1);
});

chrome.runtime.onStartup.addListener(async () => {
  ensureUpdateAlarm();
  checkForUpdate();
  await ensureApprovalAlarm();
  checkApprovalSoon(1);
});

// ---- Updates from GitHub releases ----
// Chrome cannot replace the files of an extension loaded from a folder, so a newer
// release is announced (badge + bar in the popup), its zip is downloaded on request,
// and the extension reloads itself once the new files are in the folder.

const UPDATE_ALARM = 'update-check';
const UPDATE_EVERY_MIN = 6 * 60;

function currentVersion() {
  return chrome.runtime.getManifest().version;
}

async function ensureUpdateAlarm() {
  const a = await chrome.alarms.get(UPDATE_ALARM);
  if (!a) chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: UPDATE_EVERY_MIN, periodInMinutes: UPDATE_EVERY_MIN });
}

async function showBadge(update) {
  const newer = update && compareVersions(update.latest, currentVersion()) > 0;
  await chrome.action.setBadgeText({ text: newer ? 'NEW' : '' });
  if (newer) {
    await chrome.action.setBadgeBackgroundColor({ color: '#d93a3a' });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    await chrome.action.setTitle({ title: 'Site Request: version ' + update.latest + ' is available' });
  } else {
    await chrome.action.setTitle({ title: 'Site Request' });
  }
}

async function checkForUpdate() {
  const r = await checkLatest(currentVersion());
  const checkedAt = Date.now();
  if (r.state === 'newer') {
    const { update: old } = await chrome.storage.local.get({ update: null });
    const update = {
      latest: r.latest, assetUrl: r.assetUrl, pageUrl: r.pageUrl, notes: r.notes, checkedAt,
      downloaded: old && old.latest === r.latest ? !!old.downloaded : false
    };
    await chrome.storage.local.set({ update, lastCheck: { at: checkedAt, state: r.state } });
    await showBadge(update);
  } else if (r.state === 'error') {
    // Offline or GitHub unreachable: keep whatever was known, say nothing.
    await chrome.storage.local.set({ lastCheck: { at: checkedAt, state: 'error' } });
    const { update } = await chrome.storage.local.get({ update: null });
    await showBadge(update);
  } else {
    await chrome.storage.local.remove('update');
    await chrome.storage.local.set({ lastCheck: { at: checkedAt, state: r.state } });
    await showBadge(null);
  }
  return { state: r.state, current: r.current, latest: r.latest, pageUrl: r.pageUrl, error: r.error };
}

async function downloadUpdate() {
  const { update } = await chrome.storage.local.get({ update: null });
  if (!update) return { ok: false, error: 'no_update' };
  if (!update.assetUrl) {
    await chrome.tabs.create({ url: update.pageUrl, active: true });
    return { ok: true, opened: 'page' };
  }
  try {
    const id = await chrome.downloads.download({
      url: update.assetUrl,
      filename: 'site-request-' + update.latest + '.zip',
      conflictAction: 'uniquify',
      saveAs: false
    });
    update.downloaded = true;
    await chrome.storage.local.set({ update });
    return { ok: true, id };
  } catch (e) {
    await chrome.tabs.create({ url: update.pageUrl, active: true });
    return { ok: true, opened: 'page' };
  }
}

// ---- Was my request approved? ----
// Every 30 minutes (and once after the browser starts) each recent request that is not
// approved yet is opened in the background, without cookies. When the site itself answers
// twice in a row, at least a minute apart, it counts as approved and a notification is shown.

const APPROVAL_ALARM = 'approval-check';
const APPROVAL_SOON = 'approval-soon';
const PARALLEL = 4;

async function ensureApprovalAlarm() {
  const { checkApproved } = await chrome.storage.local.get({ checkApproved: DEFAULTS.checkApproved });
  if (!checkApproved) {
    await chrome.alarms.clear(APPROVAL_ALARM);
    await chrome.alarms.clear(APPROVAL_SOON);
    return;
  }
  const a = await chrome.alarms.get(APPROVAL_ALARM);
  if (!a) chrome.alarms.create(APPROVAL_ALARM, { delayInMinutes: CHECK_EVERY_MIN, periodInMinutes: CHECK_EVERY_MIN });
}

function checkApprovalSoon(minutes) {
  chrome.alarms.create(APPROVAL_SOON, { delayInMinutes: minutes });
}

async function readBody(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  try {
    while (out.length < BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return out;
}

async function probe(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'follow', signal: ctl.signal
    });
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    const body = await readBody(res);
    return { url, finalUrl: res.url || url, status: res.status, redirected: res.redirected, headers, body };
  } catch (e) {
    return { url, error: ctl.signal.aborted ? 'timeout' : String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// One address -> { result, why }. The site's front page is tried only when the page
// itself moved to another site (a sign-in page, for example).
async function checkUrl(url) {
  const targets = probeTargets(url);
  let c = { result: 'unknown', why: 'bad address' };
  for (let i = 0; i < targets.length; i++) {
    c = classify(Object.assign(await probe(targets[i]), { url: targets[i] }));
    if (!(c.result === 'unknown' && /^other site/.test(c.why))) break;
  }
  return c;
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
}

async function notifyApproved(entry) {
  const id = notificationId(entry.url);
  await chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Site approved: ' + hostLabel(entry.url),
    message: 'Your request was approved. Click here to open the site.',
    priority: 2
  });
}

let approvalRun = null;

function runApprovalCheck(opts) {
  if (!approvalRun) {
    approvalRun = doApprovalCheck(opts || {}).finally(() => { approvalRun = null; });
  }
  return approvalRun;
}

async function doApprovalCheck({ force }) {
  const { checkApproved } = await chrome.storage.local.get({ checkApproved: DEFAULTS.checkApproved });
  if (!checkApproved && !force) return { ok: true, skipped: 'off' };
  const started = Date.now();
  const { history: before } = await chrome.storage.local.get({ history: [] });
  const urls = [...new Set(before.filter(h => isDue(h, started)).map(h => h.url))];
  const checks = await mapLimit(urls, PARALLEL, checkUrl);
  const byUrl = new Map(urls.map((u, i) => [u, checks[i]]));

  // Read again: a request may have been added while the checks ran.
  const now = Date.now();
  const { history } = await chrome.storage.local.get({ history: [] });
  const approved = [];
  let confirmSoon = false;
  const seen = new Set();
  const updated = history.map(h => {
    const c = byUrl.get(h.url);
    if (!c || !isDue(h, now)) return h;
    const r = applyCheck(h, c, now);
    if (r.confirmSoon) confirmSoon = true;
    if (r.approvedNow && !seen.has(h.url)) {
      seen.add(h.url);
      // Only announce sites that were really blocked (old entries were all sent from the block page).
      if (h.fromBlockPage !== false || r.entry.seenBlocked) {
        r.entry.notifiedAt = now;
        approved.push(r.entry);
      }
    }
    return r.entry;
  });
  const counts = { checked: urls.length, approved: 0, blocked: 0, unknown: 0, confirming: 0 };
  for (const u of urls) {
    const e = updated.find(h => h.url === u);
    if (!e) continue;
    if (e.status === 'approved') counts.approved++;
    else if (e.lastResult === 'unknown') counts.unknown++;
    else if (e.openCount) counts.confirming++;
    else counts.blocked++;
  }
  await chrome.storage.local.set({ history: updated, approvalCheck: { at: now, counts } });
  for (const e of approved) {
    try { await notifyApproved(e); } catch (err) { /* notifications turned off in Windows/Chrome */ }
  }
  if (confirmSoon) checkApprovalSoon(CONFIRM_DELAY_MIN);
  return Object.assign({ ok: true, at: now }, counts);
}

chrome.notifications.onClicked.addListener(async id => {
  const url = urlFromNotificationId(id);
  if (!url) return;
  chrome.notifications.clear(id);
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab && tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'checkApproved' in changes) ensureApprovalAlarm();
});

// A service worker that wakes up after the browser was left open for days still checks.
ensureApprovalAlarm();
ensureUpdateAlarm();
chrome.storage.local.get({ update: null }).then(({ update }) => showBadge(update)).catch(() => {});
