import { DEFAULTS, isBlockPage, composeUrl, isEmail, cleanCandidate, buildEmail } from './shared/url.js';
import { checkLatest, compareVersions } from './shared/update.js';

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
  history.unshift({ url: job.url, domain: job.domain, to: job.to, at: Date.now() });
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

function startRequest(rawUrl, reason) {
  const p = doStartRequest(rawUrl, reason);
  opening = p.catch(() => {});
  return p;
}

async function doStartRequest(rawUrl, reason) {
  const url = cleanCandidate(rawUrl);
  if (!url) return { ok: false, error: 'bad_url' };
  const s = await getSettings();
  if (!isEmail(s.to)) return { ok: false, error: 'no_address' };
  const mail = buildEmail(s, url, new Date(), reason);
  const link = composeUrl({ to: mail.to, subject: mail.subject, body: mail.body, account: s.account });
  const tab = await chrome.tabs.create({ url: link, active: false });
  const job = {
    id: crypto.randomUUID(), tabId: tab.id, url, domain: mail.domain, to: mail.to,
    composeUrl: link, state: 'sending', error: '', started: Date.now()
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
        return startRequest(msg.url, msg.reason);
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
  if (!alarm.name.startsWith('job:')) return;
  const jobs = await getJobs();
  const job = jobs[alarm.name.slice(4)];
  if (job && job.state === 'sending') await finish(job, 'error', 'timeout');
});

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  ensureUpdateAlarm();
  checkForUpdate();
});

chrome.runtime.onStartup.addListener(() => {
  ensureUpdateAlarm();
  checkForUpdate();
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

// A service worker that wakes up after the browser was left open for days still checks.
ensureUpdateAlarm();
chrome.storage.local.get({ update: null }).then(({ update }) => showBadge(update)).catch(() => {});
