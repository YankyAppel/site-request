import { DEFAULTS, isEmail } from '../shared/url.js';
import { compareVersions } from '../shared/update.js';

const $ = id => document.getElementById(id);
const FIELDS = ['to', 'name', 'phone', 'pin', 'notes', 'account', 'subject', 'body'];

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  for (const f of FIELDS) $(f).value = s[f];
  $('checkApproved').checked = !!s.checkApproved;
}

$('checkApproved').addEventListener('change', async () => {
  await chrome.storage.local.set({ checkApproved: $('checkApproved').checked });
});

function statusLabel(h) {
  if (h.status === 'approved') return 'Approved';
  if (h.status === 'blocked') return 'Still blocked';
  return '';
}

async function renderHistory() {
  const { history } = await chrome.storage.local.get({ history: [] });
  const ul = $('history');
  ul.textContent = '';
  if (!history.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No requests yet';
    ul.appendChild(li);
    return;
  }
  for (const h of history) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = h.url;
    a.target = '_blank';
    a.textContent = h.url;
    const t = document.createElement('span');
    t.textContent = new Date(h.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    const label = statusLabel(h);
    if (label) {
      const st = document.createElement('span');
      st.className = 'st' + (h.status === 'approved' ? ' ok' : '');
      st.textContent = label;
      if (h.checkedAt) st.title = 'Checked ' + new Date(h.checkedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
      li.append(a, st, t);
    } else {
      li.append(a, t);
    }
    ul.appendChild(li);
  }
}

$('form').addEventListener('submit', async e => {
  e.preventDefault();
  const to = $('to').value.trim();
  if (to && !isEmail(to)) {
    $('to').focus();
    $('to').setCustomValidity('Please enter one valid email address.');
    $('to').reportValidity();
    return;
  }
  $('to').setCustomValidity('');
  await chrome.storage.local.set({
    to,
    name: $('name').value.trim(),
    phone: $('phone').value.trim(),
    pin: $('pin').value.trim(),
    notes: $('notes').value.trim(),
    account: $('account').value.trim() || '0',
    subject: $('subject').value || DEFAULTS.subject,
    body: $('body').value || DEFAULTS.body
  });
  $('saved').hidden = false;
  setTimeout(() => { $('saved').hidden = true; }, 2000);
});

$('to').addEventListener('input', () => $('to').setCustomValidity(''));

$('reset').addEventListener('click', () => {
  for (const f of ['to', 'account', 'subject', 'body']) $(f).value = DEFAULTS[f];
});

$('showPin').addEventListener('click', () => {
  const pin = $('pin');
  const show = pin.type === 'password';
  pin.type = show ? 'text' : 'password';
  $('showPin').textContent = show ? 'Hide' : 'Show';
});

$('clear').addEventListener('click', async () => {
  await chrome.storage.local.set({ history: [] });
  renderHistory();
});

// ---- Updates ----
const VERSION = chrome.runtime.getManifest().version;
$('version').textContent = 'v' + VERSION;
$('version2').textContent = VERSION;

function showUpdate(update) {
  const newer = update && update.latest && compareVersions(update.latest, VERSION) > 0;
  $('getUpdate').hidden = !newer;
  $('reloadExt').hidden = !newer;
  if (newer) {
    $('updateMsg').className = 'upd new';
    $('updateMsg').textContent = 'New version ' + update.latest + ' available';
    $('updateSteps').hidden = !update.downloaded;
  } else {
    $('updateSteps').hidden = true;
  }
}

$('checkUpdate').addEventListener('click', async () => {
  $('checkUpdate').disabled = true;
  $('updateMsg').className = 'upd';
  $('updateMsg').textContent = 'Checking\u2026';
  const r = await chrome.runtime.sendMessage({ type: 'check_update' });
  $('checkUpdate').disabled = false;
  if (!r || r.state === 'error') {
    $('updateMsg').textContent = 'Couldn\u2019t check for updates right now. Try again later.';
  } else if (r.state === 'newer') {
    const { update } = await chrome.storage.local.get({ update: null });
    showUpdate(update);
  } else {
    showUpdate(null);
    $('updateMsg').textContent = 'You have the latest version.';
  }
});

$('getUpdate').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'download_update' });
  $('updateSteps').hidden = false;
});

$('reloadExt').addEventListener('click', () => chrome.runtime.reload());

chrome.storage.local.get({ update: null }).then(({ update }) => showUpdate(update));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.history) renderHistory();
});

load();
renderHistory();
