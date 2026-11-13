import {
  DEFAULTS, isBlockPage, composeUrl, isEmail, cleanCandidate, buildEmail, buildPartsEmail, buildReminderEmail, extractBlockedUrl,
  cleanReason, scopeTarget, baseDomain, fetchSubdomains, mergedAllowList
} from './shared/url.js';
import { checkLatest, compareVersions } from './shared/update.js';
import {
  CHECK_EVERY_MIN, CHECK_TIMEOUT_MS, CONFIRM_DELAY_MIN, BODY_LIMIT,
  classify, applyCheck, isDue, probeTargets, notificationId, urlFromNotificationId, entryKey, checkKey
} from './shared/approval.js';
import { blockSignal, needsBodyCheck, bodySignal, newRecord, addSignal, summary, hostOf } from './shared/parts.js';
import { normalizeReasons, chosenReason, defaultReasonId, reasonSummary } from './shared/reasons.js';
import { requestedInfo, matchRequests, countLine, metaLine, fmtWhen, ordinal, badgeFor } from './shared/requested.js';
import { dueReminders, reminderId, keyFromReminderId, waitingLabel, REMIND_EVERY_MIN } from './shared/reminder.js';

const JOB_TIMEOUT_MIN = 1.5;
const HISTORY_MAX = 25;

async function getSettings() {
  return chrome.storage.local.get(DEFAULTS);
}

// The reason a request carries. mine = { id, details } from the popup; 'default' = the default reason.
async function getChoice(mine) {
  const st = await chrome.storage.local.get({ reasons: null, defaultReason: DEFAULTS.defaultReason });
  const list = normalizeReasons(st.reasons);
  if (mine === 'default') return chosenReason(list, defaultReasonId(list, st.defaultReason), '');
  if (!mine || typeof mine !== 'object') return null;
  return chosenReason(list, String(mine.id || ''), mine.details);
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
  const entry = {
    id: job.id, url: job.url, domain: job.domain, to: job.to, at: Date.now(),
    fromBlockPage: !!job.fromBlockPage, status: 'pending',
    kind: job.kind, scope: job.scope, subject: job.subject, target: job.target
  };
  if (job.reason) entry.reason = job.reason;
  if (job.nth > 1) entry.nth = job.nth;
  if (job.kind === 'parts') {
    entry.items = job.items;
    entry.samples = job.samples;
  }
  history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
}

async function markReminded(key) {
  const { history } = await chrome.storage.local.get({ history: [] });
  const now = Date.now();
  await chrome.storage.local.set({ history: history.map(h => (entryKey(h) === key ? Object.assign({}, h, { remindedAt: now }) : h)) });
}

async function finish(job, state, error) {
  if (job.state !== 'sending') return;
  job.state = state;
  job.error = error || '';
  job.ended = Date.now();
  if (state === 'sent') {
    if (job.kind === 'reminder') await markReminded(job.entryKey);
    else await addHistory(job);
  }
  await putJob(job);
  if (state === 'sent') {
    setTimeout(() => { chrome.tabs.remove(job.tabId).catch(() => {}); }, 1500);
  }
  // Requests sent from the right-click menu or a notification have no popup to show the result.
  // The block-page panel shows the result itself, like the popup.
  if (job.via && job.via !== 'popup' && job.via !== 'panel') notifyJobResult(job).catch(() => {});
}

// Compose tabs being opened right now; Gmail may ask about a tab before its job is stored.
let opening = Promise.resolve();

function serial(p) {
  opening = p.catch(() => {});
  return p;
}

function startRequest(rawUrl, reason, fromBlockPage, scope, via, mine, tabId) {
  return serial(doStartRequest(rawUrl, reason, fromBlockPage, scope, via, mine, tabId));
}

async function doStartRequest(rawUrl, reason, fromBlockPage, scope, via, mine, tabId) {
  const url = cleanCandidate(rawUrl);
  if (!url) return { ok: false, error: 'bad_url' };
  const s = await getSettings();
  if (!isEmail(s.to)) return { ok: false, error: 'no_address' };
  const choice = await getChoice(mine);
  // Whole-site asks list every subdomain the certificate logs know (Techloq has no wildcard entries).
  // The block-page panel shows the lookup live: "finding addresses", then the list that goes in the email.
  let allow = null;
  if (scope !== 'page') {
    if (tabId) chrome.tabs.sendMessage(tabId, { type: 'allow_progress' }).catch(() => {});
    allow = await fetchSubdomains(baseDomain(hostOf(url))).catch(() => []);
    if (tabId) chrome.tabs.sendMessage(tabId, { type: 'allow_list', items: mergedAllowList(url, allow) }).catch(() => {});
  }
  const mail = buildEmail(s, url, new Date(), reason, scope, choice, allow);
  const { history } = await chrome.storage.local.get({ history: [] });
  return sendMail(s, mail, {
    kind: 'site', url, domain: mail.domain, fromBlockPage: !!fromBlockPage,
    scope: mail.scope, target: mail.target, via: via || 'popup', reason: choice,
    nth: matchRequests(history, url).length + 1
  });
}

// One email for the chosen blocked parts of a page.
function startPartsRequest(pageUrl, items, samples, mine) {
  return serial((async () => {
    const page = cleanCandidate(pageUrl);
    const list = (items || []).map(String).filter(Boolean);
    if (!page || !list.length) return { ok: false, error: 'bad_url' };
    const s = await getSettings();
    if (!isEmail(s.to)) return { ok: false, error: 'no_address' };
    const choice = await getChoice(mine);
    const mail = buildPartsEmail(s, page, list, new Date(), choice);
    return sendMail(s, mail, {
      kind: 'parts', url: page, domain: mail.domain, fromBlockPage: false, items: list,
      samples: (samples || []).map(String).filter(Boolean).slice(0, 40), via: 'popup', reason: choice
    });
  })());
}

// The follow-up email for a request that is still waiting (at most one per request).
function startReminder(key) {
  return serial((async () => {
    const { history } = await chrome.storage.local.get({ history: [] });
    const entry = history.find(h => entryKey(h) === key);
    if (!entry) return { ok: false, error: 'not_found' };
    if (entry.remindedAt) return { ok: false, error: 'already_reminded' };
    if (entry.status === 'approved') return { ok: false, error: 'approved' };
    const jobs = await getJobs();
    if (Object.values(jobs).some(j => j.kind === 'reminder' && j.entryKey === key && j.state === 'sending')) return { ok: false, error: 'busy' };
    const s = await getSettings();
    if (!isEmail(s.to)) return { ok: false, error: 'no_address' };
    const mail = buildReminderEmail(s, entry, Date.now());
    if (!isEmail(mail.to)) return { ok: false, error: 'no_address' };
    return sendMail(s, mail, { kind: 'reminder', url: entry.url, domain: entry.domain, entryKey: key, via: 'notification' });
  })());
}

async function sendMail(s, mail, meta) {
  const link = composeUrl({ to: mail.to, subject: mail.subject, body: mail.body, account: s.account });
  const tab = await chrome.tabs.create({ url: link, active: false });
  const job = Object.assign({
    id: crypto.randomUUID(), tabId: tab.id, to: mail.to, subject: mail.subject,
    composeUrl: link, html: mail.html || '', state: 'sending', error: '', started: Date.now()
  }, meta);
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
        return startRequest(msg.url, msg.reason, msg.fromBlockPage, msg.scope, msg.via === 'panel' && sender.tab ? 'panel' : 'popup', msg.mine, sender.tab && sender.tab.id);
      case 'panel_info':
        return panelInfo(msg, sender);
      case 'job_status':
        return jobStatus(msg.id);
      case 'save_to':
        return saveTo(msg.to);
      case 'request_parts':
        return startPartsRequest(msg.pageUrl, msg.items, msg.samples, msg.mine);
      case 'hidden_blocks':
        return hiddenBlocks(msg.tabId);
      case 'check_reminders':
        return runReminderCheck();
      case 'check_now':
        return runApprovalCheck({ force: true });
      case 'check_update':
        return checkForUpdate();
      case 'popup_opened': {
        const approval = await checkApprovalFromPopup();
        checkForUpdateSoon().catch(() => {});
        return { ok: true, approval };
      }
      case 'download_update':
        return downloadUpdate();
      case 'open_compose':
        return openCompose(msg.id);
      case 'gmail_ready': {
        // Only compose tabs this extension opened itself are ever touched.
        if (!sender.tab || !/^https:\/\/mail\.google\.com\//.test(sender.url || '')) return { auto: false };
        await opening;
        const job = await findJobByTab(sender.tab.id);
        return job ? { auto: true, id: job.id, to: job.to, html: job.html || '' } : { auto: false };
      }
      case 'gmail_html': {
        // Whether the formatted version went in (kept on the job, for the tests and for "why plain text").
        if (!sender.tab) return { ok: false };
        const job = await findJobByTab(sender.tab.id);
        if (!job || job.id !== msg.id) return { ok: false };
        job.htmlIn = !!msg.ok;
        await putJob(job);
        return { ok: true };
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
  if (alarm.name === REMIND_ALARM) return runReminderCheck();
  if (alarm.name === APPROVAL_ALARM || alarm.name === APPROVAL_SOON) return runApprovalCheck({ force: false });
  if (!alarm.name.startsWith('job:')) return;
  const jobs = await getJobs();
  const job = jobs[alarm.name.slice(4)];
  if (job && job.state === 'sending') await finish(job, 'error', 'timeout');
});

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  setupMenus();
  ensureReasons().catch(() => {});
  ensureReminderAlarm();
  ensureUpdateAlarm();
  checkForUpdate();
  await ensureApprovalAlarm();
  checkApprovalSoon(1);
});

// The starter reasons are stored once (on install or on the update to 1.4.0); after that the list is yours.
async function ensureReasons() {
  const { reasons } = await chrome.storage.local.get({ reasons: null });
  if (!Array.isArray(reasons)) await chrome.storage.local.set({ reasons: normalizeReasons(null) });
}

chrome.runtime.onStartup.addListener(async () => {
  ensureReminderAlarm();
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
const UPDATE_EVERY_MIN = 2 * 60;
const POPUP_CHECK_GAP_MS = 2 * 60 * 1000;

function currentVersion() {
  return chrome.runtime.getManifest().version;
}

async function ensureUpdateAlarm() {
  const a = await chrome.alarms.get(UPDATE_ALARM);
  // An alarm left by an older version (every 6 hours) is replaced.
  if (!a || a.periodInMinutes !== UPDATE_EVERY_MIN) {
    chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: UPDATE_EVERY_MIN, periodInMinutes: UPDATE_EVERY_MIN });
  }
}

async function showBadge(update) {
  const newer = update && compareVersions(update.latest, currentVersion()) > 0;
  updatePending = !!newer;
  await chrome.action.setBadgeText({ text: newer ? 'NEW' : '' });
  refreshTabBadges().catch(() => {});
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
    await chrome.storage.local.set({ update, lastCheck: { at: checkedAt, state: r.state, route: r.route } });
    await showBadge(update);
  } else if (r.state === 'error') {
    // Offline or GitHub unreachable: keep whatever was known, say nothing.
    await chrome.storage.local.set({ lastCheck: { at: checkedAt, state: 'error', errors: r.errors || {} } });
    const { update } = await chrome.storage.local.get({ update: null });
    await showBadge(update);
  } else {
    await chrome.storage.local.remove('update');
    await chrome.storage.local.set({ lastCheck: { at: checkedAt, state: r.state, route: r.route } });
    await showBadge(null);
  }
  return { state: r.state, current: r.current, latest: r.latest, pageUrl: r.pageUrl, error: r.error, errors: r.errors, route: r.route };
}

// The popup asks on every open; a check runs when the last one is more than 2 minutes old.
let updateRun = null;
async function checkForUpdateSoon() {
  const { lastCheck } = await chrome.storage.local.get({ lastCheck: null });
  if (lastCheck && Date.now() - (lastCheck.at || 0) < POPUP_CHECK_GAP_MS) return { ok: true, skipped: 'recent' };
  if (!updateRun) updateRun = checkForUpdate().finally(() => { updateRun = null; });
  return updateRun;
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

// A request for the blocked parts of a page: each address seen on the page is checked at its
// front page. Open only when every one of them opens; blocked when any is still blocked.
async function checkParts(samples) {
  const list = [...new Set((samples || []).filter(Boolean))].slice(0, 12);
  if (!list.length) return { result: 'unknown', why: 'no addresses' };
  const cs = await mapLimit(list, 3, h => checkUrl('https://' + h + '/'));
  const bad = cs.findIndex(c => c.result === 'blocked');
  if (bad >= 0) return { result: 'blocked', why: list[bad] + ': ' + cs[bad].why };
  if (cs.every(c => c.result === 'open')) return { result: 'open', why: list.length + ' open' };
  return { result: 'unknown', why: 'some did not answer' };
}

function checkEntry(h) {
  return h.kind === 'parts' ? checkParts(h.samples) : checkUrl(h.url);
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
    title: 'Site approved: ' + (entry.kind === 'parts' ? waitingLabel(entry) : hostLabel(entry.url)),
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
  const due = new Map();
  for (const h of before) if (isDue(h, started) && !due.has(checkKey(h))) due.set(checkKey(h), h);
  const keys = [...due.keys()];
  // The popup shows "Checking…" on these rows; each result is saved the moment it is known.
  await chrome.storage.session.set({ checking: keys });
  const approved = [];
  let confirmSoon = false;
  const seen = new Set();
  let saving = Promise.resolve();
  const save = (key, c) => {
    saving = saving.then(async () => {
      const now = Date.now();
      const { history } = await chrome.storage.local.get({ history: [] });
      const updated = history.map(h => {
        if (checkKey(h) !== key || !isDue(h, now)) return h;
        const r = applyCheck(h, c, now);
        if (r.confirmSoon) confirmSoon = true;
        if (r.approvedNow && !seen.has(key)) {
          seen.add(key);
          // Only announce sites that were really blocked (old entries were all sent from the block page).
          if (h.fromBlockPage !== false || r.entry.seenBlocked) {
            r.entry.notifiedAt = now;
            approved.push(r.entry);
          }
        }
        return r.entry;
      });
      const { checking } = await chrome.storage.session.get({ checking: [] });
      await chrome.storage.local.set({ history: updated });
      await chrome.storage.session.set({ checking: checking.filter(k => k !== key) });
    }).catch(() => {});
    return saving;
  };
  try {
    await mapLimit(keys, PARALLEL, async key => save(key, await checkEntry(due.get(key))));
    await saving;
  } finally {
    await chrome.storage.session.set({ checking: [] });
  }
  const now = Date.now();
  const { history: updated } = await chrome.storage.local.get({ history: [] });
  const counts = { checked: keys.length, approved: 0, blocked: 0, unknown: 0, confirming: 0 };
  for (const u of keys) {
    const e = updated.find(h => checkKey(h) === u);
    if (!e) continue;
    if (e.status === 'approved') counts.approved++;
    else if (e.lastResult === 'unknown') counts.unknown++;
    else if (e.openCount) counts.confirming++;
    else counts.blocked++;
  }
  await chrome.storage.local.set({ approvalCheck: { at: now, counts } });
  for (const e of approved) {
    try { await notifyApproved(e); } catch (err) { /* notifications turned off in Windows/Chrome */ }
  }
  if (confirmSoon) checkApprovalSoon(CONFIRM_DELAY_MIN);
  runReminderCheck().catch(() => {});
  return Object.assign({ ok: true, at: now }, counts);
}

// Opening the popup checks the pending requests too, at most once every 2 minutes.
async function checkApprovalFromPopup() {
  const { checkApproved, approvalCheck, history } = await chrome.storage.local.get({ checkApproved: DEFAULTS.checkApproved, approvalCheck: null, history: [] });
  if (!checkApproved) return { skipped: 'off' };
  if (approvalRun) return { skipped: 'running' };
  if (approvalCheck && Date.now() - (approvalCheck.at || 0) < POPUP_CHECK_GAP_MS) return { skipped: 'recent' };
  if (!history.some(h => isDue(h, Date.now()))) return { skipped: 'nothing' };
  runApprovalCheck({ force: false }).catch(() => {});
  return { started: true };
}

async function onNotificationClick(id) {
  const key = keyFromReminderId(id);
  if (key) {
    chrome.notifications.clear(id);
    const r = await startReminder(key);
    if (r && r.error === 'no_address') notifyError(JOB_ERRORS.no_address).catch(() => {});
    return r;
  }
  if (String(id).startsWith(JOB_NOTE)) {
    chrome.notifications.clear(id);
    return openCompose(String(id).slice(JOB_NOTE.length));
  }
  const url = urlFromNotificationId(id);
  if (!url) return null;
  chrome.notifications.clear(id);
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab && tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return { ok: true };
}

chrome.notifications.onClicked.addListener(id => { onNotificationClick(id); });
chrome.notifications.onButtonClicked.addListener(id => { onNotificationClick(id); });
// The tests call these directly (a real click on a system notification or menu cannot be scripted).
globalThis.srNotificationClick = onNotificationClick;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'checkApproved' in changes) ensureApprovalAlarm();
  if (area === 'local' && 'remind' in changes) ensureReminderAlarm();
});

// ---- Results of requests sent without the popup (right-click menu, reminder) ----
const JOB_NOTE = 'sr-job|';
const JOB_ERRORS = {
  bad_url: 'That is not a site address.',
  no_address: 'Set the email address for requests in the Site Request popup first (click the extension icon).',
  signed_out: 'Gmail is not signed in. Sign in to Gmail in Chrome, then try again.',
  no_send_button: 'Gmail opened, but the Send button was not found.',
  no_confirmation: 'Could not confirm that Gmail sent the email.',
  timeout: 'Gmail took too long. The email may not have been sent.',
  tab_closed: 'The email tab was closed before it was sent.'
};

async function notifyJobResult(job) {
  const what = job.kind === 'reminder' ? 'Reminder' : 'Request';
  const ok = job.state === 'sent';
  let msg = ok ? 'The email was sent from your Gmail.' : (JOB_ERRORS[job.error] || (String(job.error || '').startsWith('gmail_said:') ? 'Gmail said: ' + job.error.slice(11).trim() : 'Something went wrong.'));
  if (!ok) msg += ' Click to open the email.';
  if (ok) {
    const { callNumber } = await chrome.storage.local.get({ callNumber: '' });
    if (String(callNumber || '').trim()) msg += ' Call ' + String(callNumber).trim() + ' so they review your request.';
  }
  await chrome.notifications.create(JOB_NOTE + job.id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: (ok && job.kind === 'site' && job.nth > 1 ? 'Sent again (' + ordinal(job.nth) + ' request): ' : what + (ok ? ' sent: ' : ' not sent: ')) +
      (job.target && job.scope === 'site' ? job.target : job.domain || ''),
    message: msg,
    priority: ok ? 0 : 1
  });
}

async function notifyError(text) {
  await chrome.notifications.create('sr-error|' + Date.now(), {
    type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: 'Site Request', message: text, priority: 1
  });
}

// ---- Reminder: still waiting after 2 days? ----
const REMIND_ALARM = 'reminder-check';

async function ensureReminderAlarm() {
  const { remind } = await chrome.storage.local.get({ remind: DEFAULTS.remind });
  if (!remind) return chrome.alarms.clear(REMIND_ALARM);
  const a = await chrome.alarms.get(REMIND_ALARM);
  if (!a) chrome.alarms.create(REMIND_ALARM, { delayInMinutes: 2, periodInMinutes: REMIND_EVERY_MIN });
}

let reminderRun = null;
function runReminderCheck() {
  if (!reminderRun) reminderRun = doReminderCheck().finally(() => { reminderRun = null; });
  return reminderRun;
}

async function doReminderCheck() {
  const { remind, history } = await chrome.storage.local.get({ remind: DEFAULTS.remind, history: [] });
  if (!remind) return { ok: true, offered: 0, skipped: 'off' };
  const now = Date.now();
  const due = dueReminders(history, now);
  if (!due.length) return { ok: true, offered: 0 };
  const keys = new Set(due.map(entryKey));
  // Marked first, so a notification is never shown twice for one request.
  await chrome.storage.local.set({ history: history.map(h => (keys.has(entryKey(h)) ? Object.assign({}, h, { remindOfferedAt: now }) : h)) });
  for (const h of due) {
    try {
      await chrome.notifications.create(reminderId(h), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Still waiting on ' + waitingLabel(h) + ' \u2014 send a reminder?',
        message: 'You requested it on ' + new Date(h.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
          '. Click to send a short follow-up email.',
        buttons: [{ title: 'Send reminder' }],
        requireInteraction: true,
        priority: 1
      });
    } catch (e) { /* notifications turned off */ }
  }
  return { ok: true, offered: due.length };
}

// ---- Right-click menu ----
const MENU_SITE = 'sr-site';
const MENU_PAGE = 'sr-page';
const MENU_WHY = 'sr-why';

// 1.5.5: one setup at a time, and an item that is already there is fine (this was the
// "Cannot create item with duplicate id" line on the extensions page after a Reload).
let menusBusy = Promise.resolve();
function setupMenus() {
  menusBusy = menusBusy.then(() => new Promise(done => {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      const items = [
        { id: MENU_SITE, title: 'Request this site', contexts: ['page', 'link'] },
        { id: MENU_PAGE, title: 'Request just this page', contexts: ['page', 'link'] },
        { id: MENU_WHY, title: 'Request with reason\u2026', contexts: ['page', 'link'] }
      ];
      let left = items.length;
      for (const it of items) chrome.contextMenus.create(it, () => { void chrome.runtime.lastError; if (--left === 0) done(); });
    });
  })).catch(() => {});
  return menusBusy;
}

// Opens the popup with the site filled in, so a reason can be picked. If Chrome will not open
// the toolbar popup from here, the same page opens in a small window.
async function openReasonPopup(prefill, tab) {
  await chrome.storage.session.set({ prefill: Object.assign({ at: Date.now() }, prefill) });
  try {
    if (!chrome.action.openPopup) throw new Error('no openPopup');
    await chrome.action.openPopup(tab && tab.windowId != null ? { windowId: tab.windowId } : undefined);
    return { ok: true, opened: 'popup' };
  } catch (e) {
    const w = await chrome.windows.create({
      url: chrome.runtime.getURL('popup/popup.html?window=1'), type: 'popup', width: 300, height: 640, focused: true
    });
    return { ok: true, opened: 'window', windowId: w && w.id };
  }
}

async function onMenuClick(info, tab) {
  const why = info.menuItemId === MENU_WHY;
  const scope = info.menuItemId === MENU_PAGE ? 'page' : info.menuItemId === MENU_SITE || why ? 'site' : '';
  if (!scope) return null;
  let raw = info.linkUrl || info.pageUrl || (tab && tab.url) || '';
  let fromBlockPage = false;
  let reason = '';
  if (isBlockPage(raw)) {
    fromBlockPage = true;
    const onPage = !info.linkUrl && tab && tab.id != null;
    let found = extractBlockedUrl(raw);
    if (onPage) {
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'find_url' });
        if (!found) found = cleanCandidate(r && r.url);
        reason = (r && r.reason) || '';
      } catch (e) { /* page script not ready */ }
      if (!found) {
        const key = 'nav_' + tab.id;
        const s = await chrome.storage.session.get(key);
        found = cleanCandidate(s[key]);
      }
    }
    raw = found;
  }
  if (why) {
    const url = cleanCandidate(raw);
    if (!url) {
      notifyError(JOB_ERRORS.bad_url).catch(() => {});
      return { ok: false, error: 'bad_url' };
    }
    return openReasonPopup({ url, reason, fromBlockPage, scope: 'site' }, tab);
  }
  const r = await startRequest(raw, reason, fromBlockPage, scope, 'menu', 'default');
  if (!r.ok) {
    notifyError(JOB_ERRORS[r.error] || 'The request could not be sent.').catch(() => {});
  }
  return r;
}

chrome.contextMenus.onClicked.addListener((info, tab) => { onMenuClick(info, tab); });
globalThis.srMenuClick = onMenuClick;

// ---- Hidden blocks: parts of an open page that are blocked ----
// Every request a tab makes is watched (nothing is changed or slowed down). A part counts as
// blocked when it is sent to the block page, when its connection fails while the page itself
// loaded, or when the answer comes from the blocking service. The count shows on the icon.
const AMBER = '#f29900';
let updatePending = false;
const tabRecs = new Map();
const tabChains = new Map();
const counted = new Set();

function withTab(tabId, fn) {
  const prev = tabChains.get(tabId) || Promise.resolve();
  const next = prev.then(fn, fn).catch(() => {});
  tabChains.set(tabId, next);
  return next;
}

async function loadRec(tabId) {
  if (tabRecs.has(tabId)) return tabRecs.get(tabId);
  const k = 'hb_' + tabId;
  const s = await chrome.storage.session.get(k);
  let rec = s[k] || null;
  if (!rec) {
    let url = '';
    try { url = (await chrome.tabs.get(tabId)).url || ''; } catch (e) { return null; }
    rec = newRecord(/^https?:/i.test(url) ? url : '', Date.now());
  }
  tabRecs.set(tabId, rec);
  return rec;
}

function saveRec(tabId, rec) {
  return chrome.storage.session.set({ ['hb_' + tabId]: rec });
}

// The address a tab is about: the blocked address on a block page, else the page itself.
async function tabAddress(tabId, hint) {
  let url = hint || '';
  if (!url) {
    try { url = (await chrome.tabs.get(tabId)).url || ''; } catch (e) { return ''; }
  }
  if (!/^https?:/i.test(url)) return '';
  if (!isBlockPage(url)) return url;
  let u = extractBlockedUrl(url);
  if (!u) {
    const k = 'nav_' + tabId;
    const s = await chrome.storage.session.get(k);
    u = cleanCandidate(s[k]);
  }
  return u || '';
}

// One tab's icon. Order (shared/requested.js badgeFor): red NEW (a new version) > amber count
// (blocked parts on the page) > blue check (this site was already requested, still waiting).
async function setTabBadge(tabId, n, hint) {
  try {
    const url = await tabAddress(tabId, hint);
    let requested = null;
    if (url) {
      const { history } = await chrome.storage.local.get({ history: [] });
      requested = requestedInfo(history, url);
    }
    const b = badgeFor({ update: updatePending, parts: n, requested });
    await chrome.action.setBadgeText({ tabId, text: b.text });
    if (b.text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: b.color });
      if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ tabId, color: b.textColor });
    }
    await chrome.action.setTitle({ tabId, title: b.title });
  } catch (e) { /* tab closed */ }
}

async function refreshTabBadges() {
  const all = await chrome.storage.session.get(null);
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (e) { /* no tabs */ }
  for (const t of tabs) {
    if (t.id == null || t.id < 0) continue;
    const rec = tabRecs.get(t.id) || all['hb_' + t.id];
    await setTabBadge(t.id, rec ? summary(rec).count : 0, t.url);
  }
}

// A new request, an approval or a deleted history row changes the check on the icons.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.history) refreshTabBadges().catch(() => {});
});

// The block page is a single-page app: its address can change without a new page load.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.url && info.status !== 'complete') return;
  withTab(tabId, async () => {
    const rec = await loadRec(tabId);
    await setTabBadge(tabId, rec ? summary(rec).count : 0, (tab && tab.url) || info.url);
  });
});

function onMainFrame(d) {
  if (d.tabId < 0 || d.type !== 'main_frame') return;
  withTab(d.tabId, async () => {
    const rec = newRecord(/^https?:/i.test(d.url) ? d.url : '', Date.now());
    tabRecs.set(d.tabId, rec);
    await saveRec(d.tabId, rec);
    await setTabBadge(d.tabId, 0, d.url);
  });
}

// One background re-fetch per host and page, for answers Chrome refused to show (see needsBodyCheck).
const bodyChecked = new Set();
const BODY_CHECK_MAX = 8;

async function bodyCheck(d) {
  const rec = await loadRec(d.tabId);
  if (!rec || !needsBodyCheck({ event: 'error', url: d.url, error: d.error, type: d.type }, { pageHost: rec.pageHost })) return;
  const host = hostOf(d.url);
  const key = d.tabId + '|' + rec.at + '|' + host;
  if (bodyChecked.has(key)) return;
  const mine = [...bodyChecked].filter(k => k.startsWith(d.tabId + '|' + rec.at + '|')).length;
  if (mine >= BODY_CHECK_MAX) return;
  bodyChecked.add(key);
  if (bodyChecked.size > 1000) bodyChecked.clear();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  let probeResult;
  try {
    const res = await fetch(d.url, { credentials: 'omit', cache: 'no-store', redirect: 'follow', signal: ctl.signal });
    let body = '';
    if (/text\/html|xml|text\/plain/i.test(res.headers.get('content-type') || '')) body = (await readBody(res)).slice(0, 65536);
    else if (res.body) res.body.cancel().catch(() => {});
    probeResult = { finalUrl: res.url, body };
  } catch (e) {
    probeResult = { error: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
  const sig = bodySignal(d.url, probeResult);
  if (!sig) return;
  await withTab(d.tabId, async () => {
    const r = await loadRec(d.tabId);
    if (!r || r.at !== rec.at || !addSignal(r, sig, d.type)) return;
    await saveRec(d.tabId, r);
    await setTabBadge(d.tabId, summary(r).count);
  });
}

function onPartEvent(event, d) {
  if (d.tabId < 0 || d.type === 'main_frame') return;
  if (counted.has(d.requestId)) return;
  if (event === 'error' && /^net::ERR_BLOCKED_BY_(ORB|RESPONSE)$/.test(d.error || '')) {
    counted.add(d.requestId);
    bodyCheck(d).catch(() => {});
    return;
  }
  const quick = blockSignal({ event, url: d.url, redirectUrl: d.redirectUrl, error: d.error, statusCode: d.statusCode, type: d.type, responseHeaders: d.responseHeaders }, {});
  if (!quick) return;
  counted.add(d.requestId);
  if (counted.size > 2000) counted.clear();
  withTab(d.tabId, async () => {
    const rec = await loadRec(d.tabId);
    if (!rec) return;
    const sig = blockSignal({ event, url: d.url, redirectUrl: d.redirectUrl, error: d.error, statusCode: d.statusCode, type: d.type, responseHeaders: d.responseHeaders }, { pageHost: rec.pageHost });
    if (!sig || !addSignal(rec, sig, d.type)) return;
    await saveRec(d.tabId, rec);
    await setTabBadge(d.tabId, summary(rec).count);
  });
}

const ALL = { urls: ['<all_urls>'] };
chrome.webRequest.onBeforeRequest.addListener(onMainFrame, { urls: ['<all_urls>'], types: ['main_frame'] });
chrome.webRequest.onBeforeRedirect.addListener(d => onPartEvent('redirect', d), ALL);
chrome.webRequest.onErrorOccurred.addListener(d => onPartEvent('error', d), ALL);
chrome.webRequest.onHeadersReceived.addListener(d => onPartEvent('headers', d), ALL, ['responseHeaders']);
chrome.webRequest.onCompleted.addListener(d => onPartEvent('completed', d), ALL, ['responseHeaders']);

chrome.tabs.onRemoved.addListener(tabId => {
  tabRecs.delete(tabId);
  tabChains.delete(tabId);
  chrome.storage.session.remove('hb_' + tabId);
});

async function hiddenBlocks(tabId) {
  if (tabId == null) return { ok: false };
  const rec = await withTab(tabId, () => loadRec(tabId)).then(() => tabRecs.get(tabId));
  if (!rec) return { ok: true, count: 0, groups: [] };
  const s = summary(rec);
  return { ok: true, page: rec.page, pageHost: rec.pageHost, count: s.count, groups: s.groups };
}

// A service worker that wakes up after the browser was left open for days still checks.
ensureReminderAlarm();
ensureApprovalAlarm();
ensureUpdateAlarm();
chrome.storage.local.get({ update: null }).then(({ update }) => showBadge(update)).catch(() => {});

// ---- The Request panel on the block page itself (content/blockpage.js) ----
// The panel asks here for everything it shows; the request itself goes through the same 'request' path as the popup.
function historyNote(h) {
  if (!h) return null;
  return {
    at: h.at, status: h.status === 'approved' ? 'approved' : h.status === 'blocked' ? 'blocked' : 'pending',
    remindedAt: h.remindedAt || 0, scope: h.scope || 'site', label: (h.reason && h.reason.label) || ''
  };
}

async function panelInfo(msg, sender) {
  const href = (sender.tab && sender.tab.url) || String(msg.href || '');
  let url = extractBlockedUrl(href) || extractBlockedUrl(String(msg.href || '')) || cleanCandidate(msg.found);
  let guess = false;
  if (!url && sender.tab) {
    const key = 'nav_' + sender.tab.id;
    const s = await chrome.storage.session.get(key);
    url = cleanCandidate(s[key]);
    guess = !!url;
  }
  const st = await chrome.storage.local.get({
    to: DEFAULTS.to, reasons: null, defaultReason: DEFAULTS.defaultReason, history: [],
    blockPanel: DEFAULTS.blockPanel, blockPanelAuto: DEFAULTS.blockPanelAuto
  });
  const list = normalizeReasons(st.reasons);
  const hit = url ? st.history.find(h => h.url === url && h.kind !== 'parts') : null;
  return {
    ok: true, url, guess, why: cleanReason(msg.why),
    targets: url ? { site: scopeTarget(url, 'site'), page: scopeTarget(url, 'page') } : null,
    hasTo: isEmail(st.to), to: isEmail(st.to) ? String(st.to).trim() : '',
    reasons: list.map(r => ({ id: r.id, label: r.label, text: r.text })),
    defaultReason: defaultReasonId(list, st.defaultReason),
    settings: { blockPanel: st.blockPanel !== false, blockPanelAuto: st.blockPanelAuto !== false },
    last: historyNote(hit),
    requested: url ? requestedView(st.history, url) : null
  };
}

// "Already requested" for the block page box: the words are made here, where the shared helpers live.
function requestedView(history, url) {
  const d = requestedInfo(history, url);
  if (!d) return null;
  const hit = matchRequests(history, url)[0];
  return Object.assign(d, {
    when: fmtWhen(d.at), countLine: countLine(d), meta: metaLine(d, reasonSummary(hit && hit.reason))
  });
}

async function jobStatus(id) {
  const jobs = await getJobs();
  const job = jobs[id];
  if (!job) return { ok: false };
  let last = null;
  let requested = null;
  if (job.state === 'sent') {
    const { history } = await chrome.storage.local.get({ history: [] });
    last = historyNote(history.find(h => h.id === job.id) || history.find(h => h.url === job.url));
    if (job.kind === 'site') requested = requestedView(history, job.url);
  }
  return { ok: true, state: job.state, error: job.error || '', ended: job.ended || 0, last, requested };
}

async function saveTo(to) {
  to = String(to || '').trim();
  if (!isEmail(to)) return { ok: false, error: 'bad_address' };
  await chrome.storage.local.set({ to });
  return { ok: true, to };
}
