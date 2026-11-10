import { DEFAULTS, isEmail, bodyTemplate } from '../shared/url.js';
import { compareVersions } from '../shared/update.js';
import { normalizeReasons, addReason, updateReason, deleteReason, moveReason, defaultReasonId, reasonSummary, LABEL_MAX, TEXT_MAX } from '../shared/reasons.js';

const $ = id => document.getElementById(id);
const FIELDS = ['to', 'name', 'phone', 'pin', 'notes', 'account', 'subject', 'body'];

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  for (const f of FIELDS) $(f).value = s[f];
  $('body').value = bodyTemplate(s);
  $('checkApproved').checked = !!s.checkApproved;
  $('remind').checked = !!s.remind;
}

$('remind').addEventListener('change', async () => {
  await chrome.storage.local.set({ remind: $('remind').checked });
});

$('checkApproved').addEventListener('change', async () => {
  await chrome.storage.local.set({ checkApproved: $('checkApproved').checked });
});

function statusLabel(h) {
  if (h.status === 'approved') return 'Approved';
  if (h.remindedAt) return 'Reminded';
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
    a.textContent = h.kind === 'parts' ? (h.domain || '') + ': ' + (h.items || []).join(', ')
      : h.scope === 'site' && h.target ? h.target + ' (' + h.url + ')' : h.url;
    const t = document.createElement('span');
    t.textContent = new Date(h.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    li.append(a);
    const why = reasonSummary(h.reason);
    if (why) {
      const rs = document.createElement('span');
      rs.className = 'rs';
      rs.textContent = why;
      rs.title = reasonTitle(h.reason);
      li.append(rs);
    }
    const label = statusLabel(h);
    if (label) {
      const st = document.createElement('span');
      st.className = 'st' + (h.status === 'approved' ? ' ok' : '');
      st.textContent = label;
      if (h.checkedAt) st.title = 'Checked ' + new Date(h.checkedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
      li.append(st);
    }
    li.append(t);
    ul.appendChild(li);
  }
}

function reasonTitle(r) {
  if (!r) return '';
  return [r.text ? 'Reason: ' + r.text : '', r.details ? 'Details: ' + r.details : ''].filter(Boolean).join('\n');
}

// ---- Reasons ----
let reasons = [];
let editing = '';

function reasonError(code) {
  return {
    no_label: 'Please give the reason a button name.',
    same_label: 'There is already a reason with that name.',
    too_many: 'That is the most reasons you can have. Delete one first.',
    not_found: 'That reason was already deleted.'
  }[code] || 'Something went wrong.';
}

function reasonMsg(text, cls) {
  $('reasonMsg').className = 'rmsg' + (cls ? ' ' + cls : '');
  $('reasonMsg').textContent = text || '';
}

async function loadReasons() {
  const st = await chrome.storage.local.get({ reasons: null, defaultReason: DEFAULTS.defaultReason });
  reasons = normalizeReasons(st.reasons);
  // The starters are written once, so they can be changed like any other reason.
  if (!Array.isArray(st.reasons)) await chrome.storage.local.set({ reasons });
  renderReasons(st.defaultReason);
}

async function saveReasons(list, msg) {
  reasons = list;
  const { defaultReason } = await chrome.storage.local.get({ defaultReason: DEFAULTS.defaultReason });
  const d = defaultReasonId(list, defaultReason);
  await chrome.storage.local.set({ reasons: list, defaultReason: d });
  renderReasons(d);
  reasonMsg(msg, 'ok');
}

function btn(text, title, fn, disabled) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn light small';
  b.textContent = text;
  if (title) b.title = title;
  b.disabled = !!disabled;
  b.addEventListener('click', fn);
  return b;
}

function renderReasons(def) {
  const ul = $('reasonList');
  ul.textContent = '';
  if (!reasons.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No reasons yet. Add one below.';
    ul.append(li);
  }
  reasons.forEach((r, i) => {
    const li = document.createElement('li');
    li.dataset.id = r.id;
    if (editing === r.id) {
      li.className = 'editing';
      const l = document.createElement('input');
      l.type = 'text'; l.maxLength = LABEL_MAX; l.value = r.label; l.className = 'edit-label'; l.setAttribute('aria-label', 'Button name');
      const x = document.createElement('input');
      x.type = 'text'; x.maxLength = TEXT_MAX; x.value = r.text; x.className = 'edit-text'; x.setAttribute('aria-label', 'Text in the email');
      const rb = document.createElement('span');
      rb.className = 'rb';
      const save = async () => {
        const res = updateReason(reasons, r.id, l.value, x.value);
        if (!res.ok) return reasonMsg(reasonError(res.error), 'bad');
        editing = '';
        await saveReasons(res.list, 'Saved \u2713');
      };
      rb.append(btn('Save', '', save), btn('Cancel', '', () => { editing = ''; renderReasons($('defaultReason').value); reasonMsg(''); }));
      for (const inp of [l, x]) inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
      li.append(l, x, rb);
      ul.append(li);
      setTimeout(() => l.focus(), 0);
      return;
    }
    const rt = document.createElement('span');
    rt.className = 'rt';
    const rl = document.createElement('span');
    rl.className = 'rl';
    rl.textContent = r.label;
    const rx = document.createElement('span');
    rx.className = 'rx';
    rx.textContent = r.text;
    rx.title = r.text;
    rt.append(rl, rx);
    const rb = document.createElement('span');
    rb.className = 'rb';
    rb.append(
      btn('\u2191', 'Move up', async () => saveReasons(moveReason(reasons, r.id, -1).list, ''), i === 0),
      btn('\u2193', 'Move down', async () => saveReasons(moveReason(reasons, r.id, 1).list, ''), i === reasons.length - 1),
      btn('Edit', '', () => { editing = r.id; renderReasons($('defaultReason').value); reasonMsg(''); }),
      btn('Delete', '', async () => {
        const res = deleteReason(reasons, r.id);
        if (res.ok) await saveReasons(res.list, 'Deleted "' + r.label + '"');
      })
    );
    rb.querySelector('button').classList.add('up');
    rb.children[1].classList.add('down');
    rb.children[2].classList.add('edit');
    rb.children[3].classList.add('del');
    li.append(rt, rb);
    ul.append(li);
  });
  const sel = $('defaultReason');
  sel.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'None';
  sel.append(none);
  for (const r of reasons) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = r.label;
    sel.append(o);
  }
  sel.value = defaultReasonId(reasons, def);
}

$('addReason').addEventListener('click', async () => {
  const res = addReason(reasons, $('newLabel').value, $('newText').value);
  if (!res.ok) {
    reasonMsg(reasonError(res.error), 'bad');
    $('newLabel').focus();
    return;
  }
  $('newLabel').value = '';
  $('newText').value = '';
  await saveReasons(res.list, 'Added "' + res.item.label + '"');
});
for (const id of ['newLabel', 'newText']) {
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('addReason').click(); } });
}

$('defaultReason').addEventListener('change', async () => {
  await chrome.storage.local.set({ defaultReason: $('defaultReason').value });
  reasonMsg('Default reason saved \u2713', 'ok');
});

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
  for (const f of ['account', 'subject', 'body']) $(f).value = DEFAULTS[f];
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
    $('updateMsg').className = 'upd err';
    $('updateMsg').textContent = failText(r && r.errors, Date.now());
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

function failText(errors, at) {
  const where = ['github.com', 'api.github.com'].filter(k => errors && k in errors);
  const hosts = where.length ? where.join(' and ') : 'github.com';
  return 'Couldn\u2019t check for updates (' + new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) +
    '): ' + hosts + ' did not answer. Your network may block ' + (where.length > 1 ? 'them' : 'it') + '.';
}

chrome.storage.local.get({ update: null, lastCheck: null }).then(({ update, lastCheck }) => {
  showUpdate(update);
  // The automatic checks fail silently; the last failure is shown here.
  const newer = update && update.latest && compareVersions(update.latest, VERSION) > 0;
  if (!newer && lastCheck && lastCheck.state === 'error') {
    $('updateMsg').className = 'upd err';
    $('updateMsg').textContent = failText(lastCheck.errors, lastCheck.at);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.history) renderHistory();
});

load();
loadReasons();
renderHistory();
