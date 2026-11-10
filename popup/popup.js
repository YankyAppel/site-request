import { compareVersions } from '../shared/update.js';
import { checkKey } from '../shared/approval.js';
import { isBlockPage, extractBlockedUrl, cleanCandidate, cleanReason, domainOf, DEFAULTS, isEmail, scopeTarget } from '../shared/url.js';

const $ = id => document.getElementById(id);
let currentJobId = null;

const MESSAGES = {
  bad_url: 'Please enter a valid site address.',
  no_address: 'Add the email address for requests in Settings first.',
  signed_out: 'Gmail is not signed in. Sign in to Gmail in Chrome, then try again.',
  no_send_button: 'Gmail opened, but the Send button was not found.',
  no_confirmation: 'Could not confirm that Gmail sent the email.',
  timeout: 'Gmail took too long. The email may not have been sent.',
  tab_closed: 'The email tab was closed before it was sent.'
};

function showStatus(state, text, canOpen) {
  const box = $('status');
  box.hidden = false;
  box.className = 'status ' + state;
  $('statusText').textContent = text;
  $('openMail').hidden = !canOpen;
  $('openSettings').hidden = true;
}

function errorText(code) {
  if (!code) return 'Something went wrong.';
  if (code.startsWith('gmail_said:')) return 'Gmail said: ' + code.slice(11).trim();
  return MESSAGES[code] || ('Error: ' + code);
}

function renderJob(job) {
  if (!job) return;
  currentJobId = job.id;
  if (job.state === 'sending') {
    showStatus('sending', 'Sending your request\u2026', false);
    setBusy(true);
  } else if (job.state === 'sent') {
    showStatus('sent', 'Request sent \u2713', false);
    setBusy(false);
    loadHistory();
  } else {
    showStatus('error', errorText(job.error), true);
    setBusy(false);
  }
}

function setBusy(busy) {
  $('request').classList.toggle('not-active', busy);
}

function timeAgo(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function tag(text, cls) {
  const s = document.createElement('span');
  s.className = 'tag' + (cls ? ' ' + cls : '');
  s.textContent = text;
  return s;
}

function statusTitle(h) {
  if (h.status === 'approved') return '\nApproved' + (h.approvedAt ? ' \u00b7 ' + timeAgo(h.approvedAt) : '') + '. Click to open.';
  if (!h.checkedAt) return '';
  const word = h.openCount ? 'Looks open, checking again' : h.status === 'blocked' ? 'Still blocked' : 'No answer';
  return '\n' + word + ' \u00b7 checked ' + timeAgo(h.checkedAt);
}

function checkedText(r) {
  if (!r) return '';
  if (!r.checked) return 'Nothing to check right now.';
  const parts = [];
  if (r.approved) parts.push(r.approved + ' approved');
  if (r.confirming) parts.push(r.confirming + (r.confirming === 1 ? ' looks' : ' look') + ' open (checking again in 2 minutes)');
  if (r.blocked) parts.push(r.blocked + ' still blocked');
  if (r.unknown) parts.push(r.unknown + ' no answer');
  return 'Checked ' + timeAgo(r.at || Date.now()) + ': ' + parts.join(', ') + '.';
}

async function loadHistory() {
  const { history } = await chrome.storage.local.get({ history: [] });
  const { checking } = await chrome.storage.session.get({ checking: [] });
  const busy = new Set(checking || []);
  const ul = $('history');
  ul.textContent = '';
  if (!history.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No requests yet';
    ul.appendChild(li);
  }
  for (const h of history.slice(0, 5)) {
    const li = document.createElement('li');
    const what = h.kind === 'parts' ? (h.items || []).join('\n') : h.target && h.scope === 'site' ? h.target : h.url;
    li.title = what + statusTitle(h) + (h.remindedAt ? '\nReminder sent ' + timeAgo(h.remindedAt) : '');
    const d = document.createElement('span');
    d.className = 'd';
    d.textContent = h.kind === 'parts'
      ? (h.domain || '') + ' \u00b7 ' + (h.items || []).length + ((h.items || []).length === 1 ? ' part' : ' parts')
      : (h.domain || h.url) + (h.scope === 'page' ? ' \u00b7 page' : '');
    li.append(d);
    if (h.status !== 'approved' && busy.has(checkKey(h))) {
      li.append(tag('Checking\u2026', 'busy'));
    } else if (h.status === 'approved') {
      li.append(tag('Approved', 'ok'));
      li.classList.add('open');
      li.addEventListener('click', () => chrome.tabs.create({ url: h.url, active: true }));
    } else if (h.status === 'blocked' && !h.openCount) {
      li.append(tag(h.remindedAt ? 'Reminded' : 'Blocked', ''));
    } else if (h.remindedAt) {
      li.append(tag('Reminded', ''));
    }
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = timeAgo(h.at);
    li.append(t);
    ul.appendChild(li);
  }
  return history;
}

async function noteIfRequestedBefore(url) {
  const { history } = await chrome.storage.local.get({ history: [] });
  const hit = history.find(h => h.url === url);
  const note = $('note');
  if (hit) {
    note.hidden = false;
    note.textContent = 'You already requested this on ' +
      new Date(hit.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '.';
  } else {
    note.hidden = true;
  }
}

let blockReason = '';
let blockedUrl = '';
let pageMode = 'none';
let activeTab = null;

async function detect() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  const href = (tab && tab.url) || '';
  let url = '';
  let mode = 'none';
  if (isBlockPage(href)) {
    mode = 'blocked';
    url = extractBlockedUrl(href);
    if (tab) {
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'find_url' });
        if (!url) url = cleanCandidate(r && r.url);
        blockReason = cleanReason(r && r.reason);
      } catch (e) { /* page script not ready */ }
    }
    if (!url && tab) {
      const key = 'nav_' + tab.id;
      const s = await chrome.storage.session.get(key);
      url = cleanCandidate(s[key]);
      if (url) mode = 'guess';
    }
  } else if (/^https?:\/\//i.test(href)) {
    mode = 'page';
    url = href;
  }
  return { url, mode };
}

async function init() {
  const { url, mode } = await detect();
  const label = $('mode');
  if (mode === 'blocked') {
    label.textContent = url ? 'Blocked page detected' : 'Blocked page \u2014 enter the site address';
    label.classList.add('blocked');
  } else if (mode === 'guess') {
    label.textContent = 'Blocked page \u2014 please check the address';
    label.classList.add('blocked');
  } else if (mode === 'page') {
    label.textContent = 'This page';
  } else {
    label.textContent = 'Enter the site address';
  }
  $('url').value = url;
  blockedUrl = url;
  pageMode = mode;
  if (blockReason) {
    $('reason').hidden = false;
    $('reason').textContent = 'Why: ' + blockReason;
  }
  if (url) noteIfRequestedBefore(url);
  else $('url').focus();
  renderScope();
  if (mode === 'page') loadParts();

  loadHistory();

  const { status } = await chrome.storage.session.get({ status: null });
  if (status && (status.state === 'sending' || Date.now() - (status.ended || 0) < 3 * 60 * 1000) &&
      (!url || status.url === cleanCandidate(url))) {
    renderJob(status);
  }

  const settings = await chrome.storage.local.get(DEFAULTS);
  if (!isEmail(settings.to)) {
    showStatus('error', MESSAGES.no_address, false);
    $('openSettings').hidden = false;
  }
}

$('request').addEventListener('click', async () => {
  if ($('request').classList.contains('not-active')) return;
  const url = cleanCandidate($('url').value);
  if (!url) {
    showStatus('error', MESSAGES.bad_url, false);
    $('url').focus();
    return;
  }
  setBusy(true);
  showStatus('sending', 'Sending your request\u2026', false);
  // The reason belongs to the blocked address; it is not sent for an address typed in by hand.
  const sameAsBlocked = url === cleanCandidate(blockedUrl);
  const reason = blockReason && sameAsBlocked ? blockReason : '';
  const fromBlockPage = sameAsBlocked && /^(blocked|guess)$/.test(pageMode);
  const r = await chrome.runtime.sendMessage({ type: 'request', url, reason, fromBlockPage, scope: currentScope() });
  if (!r || !r.ok) {
    setBusy(false);
    showStatus('error', errorText(r && r.error), false);
    if (r && r.error === 'no_address') $('openSettings').hidden = false;
    return;
  }
  currentJobId = r.id;
});

$('url').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('request').click();
});
$('url').addEventListener('input', () => { $('note').hidden = true; renderScope(); });

// ---- Whole site / Just this page ----
function currentScope() {
  const c = document.querySelector('input[name="scope"]:checked');
  return c && c.value === 'page' ? 'page' : 'site';
}

function renderScope() {
  const url = cleanCandidate($('url').value);
  $('scopeRow').hidden = !url;
  $('scopeNote').hidden = !url;
  const scope = currentScope();
  $('request').textContent = scope === 'page' ? 'Request just this page' : 'Request this site';
  if (url) {
    $('scopeNote').textContent = scope === 'page'
      ? 'Only this address, not the rest of the site.'
      : 'Asks for ' + scopeTarget(url, 'site') + ' (every page of the site).';
  }
}

for (const r of document.querySelectorAll('input[name="scope"]')) r.addEventListener('change', renderScope);

// ---- Hidden blocks on this page ----
let partGroups = [];
const partChoice = new Map();

function kindText(kinds) {
  return (kinds || []).join(', ');
}

function chosenParts() {
  return partGroups.filter(g => partChoice.has(g.label) ? partChoice.get(g.label) : !g.ad);
}

function renderPartsButton() {
  const n = chosenParts().length;
  const btn = $('requestParts');
  btn.disabled = !n;
  btn.textContent = n && n === partGroups.filter(g => !g.ad).length && !partGroups.some(g => g.ad && partChoice.get(g.label))
    ? 'Request all' : 'Request ' + n + (n === 1 ? ' address' : ' addresses');
}

function renderParts(r) {
  partGroups = (r && r.groups) || [];
  const count = (r && r.count) || 0;
  $('parts').hidden = !partGroups.length;
  if (!partGroups.length) return;
  $('partsTitle').textContent = count
    ? 'This page has ' + count + (count === 1 ? ' blocked part' : ' blocked parts')
    : 'Only ads or trackers are blocked on this page';
  const ul = $('partsList');
  ul.textContent = '';
  for (const g of partGroups) {
    const li = document.createElement('li');
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = partChoice.has(g.label) ? partChoice.get(g.label) : !g.ad;
    cb.addEventListener('change', () => { partChoice.set(g.label, cb.checked); renderPartsButton(); });
    const txt = document.createElement('span');
    txt.className = 'txt';
    const hEl = document.createElement('span');
    hEl.className = 'h';
    hEl.textContent = g.label;
    hEl.title = g.hosts.join('\n');
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = kindText(g.kinds) + (g.wildcard ? ' \u00b7 ' + g.hosts.length + ' addresses' : '');
    txt.append(hEl, k);
    lab.append(cb, txt);
    if (g.ad) {
      const ad = document.createElement('span');
      ad.className = 'ad';
      ad.textContent = 'ad';
      ad.title = 'Ad or tracker. Left out unless you tick it.';
      lab.append(ad);
    }
    li.append(lab);
    ul.append(li);
  }
  renderPartsButton();
}

async function loadParts() {
  if (!activeTab || activeTab.id == null) return;
  const r = await chrome.runtime.sendMessage({ type: 'hidden_blocks', tabId: activeTab.id });
  if (r && r.ok) renderParts(r);
}

$('requestParts').addEventListener('click', async () => {
  const chosen = chosenParts();
  if (!chosen.length || !activeTab) return;
  $('requestParts').disabled = true;
  showStatus('sending', 'Sending your request\u2026', false);
  const r = await chrome.runtime.sendMessage({
    type: 'request_parts', pageUrl: activeTab.url,
    items: chosen.map(g => g.label),
    samples: chosen.flatMap(g => g.hosts)
  });
  $('requestParts').disabled = false;
  if (!r || !r.ok) {
    showStatus('error', errorText(r && r.error), false);
    if (r && r.error === 'no_address') $('openSettings').hidden = false;
    return;
  }
  currentJobId = r.id;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && activeTab && changes['hb_' + activeTab.id] && pageMode === 'page') loadParts();
});

$('openMail').addEventListener('click', () => {
  if (currentJobId) chrome.runtime.sendMessage({ type: 'open_compose', id: currentJobId });
});

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && changes.history) || (area === 'session' && changes.checking)) loadHistory();
  if (area === 'session' && changes.status && changes.status.newValue) {
    const job = changes.status.newValue;
    if (!currentJobId || job.id === currentJobId) renderJob(job);
  }
});

// ---- Was it approved? ----
async function showCheckNow() {
  const { checkApproved, history } = await chrome.storage.local.get({ checkApproved: DEFAULTS.checkApproved, history: [] });
  $('checkNow').hidden = !checkApproved || !history.some(h => h.status !== 'approved');
}

$('checkNow').addEventListener('click', async () => {
  const btn = $('checkNow');
  btn.disabled = true;
  btn.textContent = 'Checking\u2026';
  $('checked').hidden = true;
  const r = await chrome.runtime.sendMessage({ type: 'check_now' });
  btn.disabled = false;
  btn.textContent = 'Check now';
  $('checked').hidden = false;
  $('checked').textContent = r && r.ok ? checkedText(r) : 'Couldn\u2019t check right now. Try again later.';
  showCheckNow();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.history || changes.checkApproved)) showCheckNow();
});
showCheckNow();

// ---- Update bar ----
function renderUpdate(update) {
  const box = $('update');
  const v = chrome.runtime.getManifest().version;
  if (!update || !update.latest || compareVersions(update.latest, v) <= 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('updateText').textContent = 'New version ' + update.latest + ' available';
  $('updateSteps').hidden = !update.downloaded;
  $('updateBtn').textContent = update.downloaded ? 'Download again' : 'Update';
}

$('updateBtn').addEventListener('click', async () => {
  $('updateBtn').disabled = true;
  await chrome.runtime.sendMessage({ type: 'download_update' });
  $('updateBtn').disabled = false;
  $('updateSteps').hidden = false;
});

$('reloadBtn').addEventListener('click', () => chrome.runtime.reload());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'update' in changes) renderUpdate(changes.update.newValue);
});

chrome.storage.local.get({ update: null }).then(({ update }) => renderUpdate(update));
chrome.runtime.sendMessage({ type: 'popup_opened' }).catch(() => {});

init();
