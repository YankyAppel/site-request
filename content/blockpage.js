// The block page: answers the popup with the blocked address, and (from 1.5.0) shows the Request panel
// on the page itself when the page has no request option of its own (shared/detect.js decides).
(function () {
  if (window.__siteRequestBlockPage) return;
  window.__siteRequestBlockPage = true;

  function pick(text) {
    const m = String(text || '').match(/\bhttps?:\/\/[^\s"'<>]+/i);
    return m ? m[0].replace(/[),.;]+$/, '') : '';
  }
  function findUrl() {
    const own = location.hostname.toLowerCase();
    const links = Array.from(document.querySelectorAll('a[href^="http"]'))
      .map(a => a.href)
      .filter(h => { try { return !new URL(h).hostname.toLowerCase().endsWith('techloq.com'); } catch (e) { return false; } });
    const inputs = Array.from(document.querySelectorAll('input,textarea')).map(i => pick(i.value)).filter(Boolean);
    const text = document.body ? document.body.innerText : '';
    const fromText = (text.match(/\bhttps?:\/\/[^\s"'<>]+/gi) || [])
      .map(s => s.replace(/[),.;]+$/, ''))
      .filter(h => { try { return new URL(h).hostname.toLowerCase() !== own && !new URL(h).hostname.endsWith('techloq.com'); } catch (e) { return false; } });
    return inputs[0] || fromText[0] || links[0] || '';
  }
  // The "Why?" line of the block page, e.g. 'Locked Web Category: "Uncategorized"'.
  function findReason() {
    const text = document.body ? document.body.innerText : '';
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^why\s*\??\s*:?\s*(.*)$/i);
      if (!m) continue;
      let r = m[1].trim();
      if (!r && lines[i + 1] && !/^(requested url|filter action|why)\b/i.test(lines[i + 1])) r = lines[i + 1];
      r = r.replace(/\s+/g, ' ').trim();
      if (r) return r.slice(0, 300);
    }
    // Newer pages: a "Locked Web Category" title with a "Category: ..." line.
    const title = lines.find(l => /^(locked|blocked)\s+web\s+category$/i.test(l));
    const cat = lines.map(l => l.match(/^category\s*:\s*(.+)$/i)).find(Boolean);
    if (title && cat) return (title + ': "' + cat[1].trim() + '"').slice(0, 300);
    return '';
  }
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg && msg.type === 'find_url') reply({ url: findUrl(), reason: findReason(), href: location.href });
  });

  const D = globalThis.SRDetect;
  if (!D) return;

  // ---------- Detection ----------
  const CAND = 'button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"], input[type="image"], form, [onclick], [ng-click], [routerlink]';
  let host = null;

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    }
    return true;
  }

  function attrsOf(el) {
    const out = {};
    for (const a of ['id', 'name', 'href', 'action', 'formaction', 'data-action', 'routerlink', 'ng-reflect-router-link']) {
      const v = el.getAttribute(a);
      if (v) out[a] = v;
    }
    const c = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
    if (c) out.class = c;
    return out;
  }

  function candidates() {
    const out = [];
    for (const el of document.querySelectorAll(CAND)) {
      if (host && (el === host || host.contains(el))) continue;
      const isForm = el.tagName === 'FORM';
      const text = isForm ? '' : String(el.innerText || el.textContent || '').slice(0, 200);
      const label = [el.getAttribute('aria-label'), el.getAttribute('title'),
        /^(INPUT|BUTTON)$/.test(el.tagName) ? el.value : '', el.getAttribute('alt')].filter(Boolean).join(' ').slice(0, 200);
      out.push({
        text, label, attrs: attrsOf(el), visible: isForm ? isVisible(el) || el.getClientRects().length > 0 : isVisible(el),
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'
      });
    }
    return out;
  }

  function headings() {
    return Array.from(document.querySelectorAll('h1, h2, h3, h4, [class*="title" i], [class*="heading" i]'))
      .filter(e => !(host && host.contains(e)))
      .map(e => String(e.innerText || '').trim()).filter(t => t && t.length < 120).slice(0, 20).join('\n');
  }

  function pageInfo() {
    return { title: document.title, headings: headings(), why: findReason(), text: document.body ? String(document.body.innerText || '').slice(0, 6000) : '' };
  }

  function detect() {
    return D.classify(candidates(), pageInfo());
  }

  // ---------- Placement: right above "Report miscategorization" ----------
  function textNodeMatching(re) {
    if (!document.body) return null;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (n.parentElement && !(host && host.contains(n.parentElement)) && re.test(n.nodeValue || '')) return n;
    }
    return null;
  }
  const RE_REPORT = /mis[\s-]?categori[sz]/i;
  const RE_INFO = /^\s*(admin|filter action|category|why)\b/i;

  // Climbs to the largest wrapper that holds nothing but this text.
  function wrapperOf(node) {
    let el = node.parentElement;
    const t = String(el.textContent || '').trim();
    while (el.parentElement && el.parentElement !== document.body &&
           String(el.parentElement.textContent || '').trim() === t) el = el.parentElement;
    return el;
  }

  // The report part may be two lines ("The page is miscategorized? Let us know:" + the link): take all of it.
  const RE_REPORT_LINE = /mis[\s-]?categori[sz]|let us know/i;
  function onlyReport(el) {
    const lines = String(el.innerText || el.textContent || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
    return lines.length > 0 && lines.every(l => RE_REPORT_LINE.test(l));
  }
  function reportBlock(node) {
    let el = wrapperOf(node);
    while (el.parentElement && el.parentElement !== document.body && onlyReport(el.parentElement)) el = el.parentElement;
    return el;
  }

  function lastInfoNode() {
    if (!document.body) return null;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, last = null;
    while ((n = w.nextNode())) if (RE_INFO.test(n.nodeValue || '') && !(host && host.contains(n.parentElement))) last = n;
    return last;
  }

  function place() {
    if (!host) return;
    const rep = textNodeMatching(RE_REPORT);
    if (rep) {
      const el = reportBlock(rep);
      if (host.nextSibling !== el) el.parentElement.insertBefore(host, el);
      host.dataset.at = 'report';
      return;
    }
    const info = lastInfoNode();
    if (info) {
      let el = wrapperOf(info);
      // the whole info row (label + value), not just the label
      while (el.parentElement && el.parentElement !== document.body && el.parentElement.children.length === 1) el = el.parentElement;
      if (el.nextSibling !== host) el.parentElement.insertBefore(host, el.nextSibling);
      host.dataset.at = 'info';
      return;
    }
    if (host.parentElement !== document.body) document.body.appendChild(host);
    host.dataset.at = 'end';
  }

  // ---------- The panel ----------
  const MESSAGES = {
    bad_url: 'Please enter a valid site address.',
    no_address: 'Add the email address for requests first.',
    signed_out: 'Gmail is not signed in. Sign in to Gmail in Chrome, then try again.',
    no_send_button: 'Gmail opened, but the Send button was not found.',
    no_confirmation: 'Could not confirm that Gmail sent the email.',
    timeout: 'Gmail took too long. The email may not have been sent.',
    tab_closed: 'The email tab was closed before it was sent.'
  };
  const DETAILS_MAX = 500;
  const MARK = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#1a7db6"/><path fill="#fff" d="M5.6 6.1c-.2-.6.4-1.1 1-.8l12 5.9c.5.3.5 1 0 1.3l-12 5.9c-.6.3-1.2-.2-1-.8L7.4 12 5.6 6.1zm3.2 6.6-1.3 3.8 8.6-4.3-8.6-4.4 1.3 3.9H13v1H8.8z"/></svg>';

  const CHECK = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#fff"/><path d="M7 12.4l3.2 3.2L17.2 8.6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const CSS = `
:host { all: initial; display: block; width: 100%; max-width: 560px; margin: 18px auto 14px; text-align: left; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.card { font-family: "SR Lato", Lato, "Segoe UI", Roboto, Arial, sans-serif; color: #1d1e26; background: #fff;
  border: 1px solid #d0d2e0; border-radius: 10px; box-shadow: 0 2px 10px rgba(29,30,38,.07); padding: 14px 16px 15px; font-size: 13px; line-height: 1.35; }
.head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
.head svg { display: block; flex: none; }
.head .t { font-weight: 700; font-size: 15px; color: #1d1e26; }
.head .s { margin-left: auto; font-size: 12px; color: #73788F; }
.addr { font-size: 13px; color: #3b3e4f; background: #F6F7FB; border: 1px solid #e3e5ee; border-radius: 6px; padding: 7px 9px;
  overflow-wrap: anywhere; word-break: break-all; }
.addr.guess { border-color: #f2c94c; }
label.l { display: block; font-size: 12px; font-weight: 700; color: #3b3e4f; margin: 11px 0 5px; }
.scope { display: flex; border: 1px solid #d0d2e0; border-radius: 6px; overflow: hidden; margin-top: 10px; }
.scope label { flex: 1; position: relative; cursor: pointer; margin: 0; }
.scope input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.scope span { display: block; text-align: center; padding: 6px 4px; font-size: 12.5px; color: #3b3e4f; }
.scope label + label span { border-left: 1px solid #d0d2e0; }
.scope input:checked + span { background: #1a7db6; color: #fff; font-weight: 700; }
.scope input:focus-visible + span { outline: 2px solid #9cc9e3; outline-offset: -2px; }
.note { font-size: 12px; color: #73788F; margin: 5px 0 0; overflow-wrap: anywhere; }
.note.bad { color: #a42323; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip { font: inherit; font-size: 12.5px; color: #1d1e26; background: #fff; border: 1px solid #d0d2e0; border-radius: 14px; padding: 4px 11px; cursor: pointer; }
.chip:hover { border-color: #9cc9e3; }
.chip.on { background: #1a7db6; border-color: #1a7db6; color: #fff; font-weight: 700; }
.chip:focus-visible { outline: 2px solid #9cc9e3; outline-offset: 1px; }
input.in, textarea { font: inherit; font-size: 13px; color: #1d1e26; width: 100%; border: 1px solid #d0d2e0; border-radius: 6px; padding: 7px 9px; outline: none; background: #fff; margin: 0; }
input.in:focus, textarea:focus { border-color: #1a7db6; }
textarea { resize: vertical; min-height: 38px; height: 38px; max-height: 140px; display: block; }
.count { margin: 2px 0 0; font-size: 11px; color: #73788F; text-align: right; }
.count.near { color: #a42323; }
.row { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
.btn { font: inherit; font-size: 14px; font-weight: 700; color: #fff; background: #1a7db6; border: 0; border-radius: 6px; padding: 9px 18px; cursor: pointer; }
.btn:hover { background: #156a9c; }
.btn:active { background: #115a85; }
.btn[disabled] { background: #9cc9e3; cursor: default; }
.btn.small { font-size: 13px; padding: 7px 12px; }
.tobox { margin-top: 12px; padding: 10px; border: 1px solid #f2c94c; background: #FFFBEA; border-radius: 6px; }
.tobox .row { margin-top: 6px; }
.status { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-top: 10px; }
.status .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #73788F; }
.status.sending .dot { background: #1a7db6; animation: pulse 1s ease-in-out infinite; }
.status.sent .dot { background: #13703f; }
.status.sent .txt b { color: #13703f; }
.status.error .dot { background: #a42323; }
.status.error .txt { color: #a42323; }
.status .txt { flex: 1; }
.status .open { font: inherit; font-size: 12px; color: #1a7db6; background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
.tag { display: inline-block; font-size: 11px; font-weight: 700; border-radius: 9px; padding: 1px 7px; margin-left: 4px; background: #F1F2F7; color: #3b3e4f; vertical-align: 1px; }
.tag.ok { background: #e3f4ea; color: #13703f; }
.goes { margin-left: auto; font-size: 11.5px; color: #73788F; overflow-wrap: anywhere; text-align: right; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.card.done { border-color: #1a7db6; }
.card.done.ok { border-color: #13703f; }
.bar { display: flex; align-items: center; gap: 8px; margin: -14px -16px 10px; padding: 10px 16px; border-radius: 9px 9px 0 0;
  background: #1a7db6; color: #fff; font-size: 14px; }
.card.ok .bar { background: #13703f; }
.bar svg { display: block; flex: none; }
.bar b { font-weight: 700; font-size: 15px; }
.bar .when { font-size: 13px; opacity: .92; }
.bar .s { margin-left: auto; font-size: 12px; opacity: .8; }
.dinfo { margin: 0 0 10px; }
.dline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pill { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; border-radius: 12px; padding: 3px 10px 3px 8px; }
.pill:before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.pill.wait { background: #FFF3D6; color: #9a5b00; }
.pill.ok { background: #e3f4ea; color: #13703f; }
.btn.go { background: #13703f; }
.btn.go:hover { background: #0f5c33; }
.meta { margin: 6px 0 0; font-size: 12.5px; color: #3b3e4f; overflow-wrap: anywhere; }
.meta.times { color: #73788F; font-size: 12px; }
.bar svg path { stroke: #1a7db6; }
.card.ok .bar svg path { stroke: #13703f; }
.hint { margin: 10px 0 0; padding: 6px 9px; font-size: 12px; color: #3b3e4f; background: #F6F7FB; border-radius: 6px; }
.btn.light { border: 1px solid #d0d2e0; color: #1a7db6; font-weight: 700; background: #fff; }
.btn.light:hover { background: #F1F7FB; border-color: #9cc9e3; }
`;

  let shadow = null;
  let info = null;           // what the background answered (panel_info)
  let chosen = '';           // reason id
  let touched = false;       // once the person starts filling the panel, it is never hidden by detection
  let jobId = '';
  let pollTimer = 0;
  let sentAt = 0;
  let expanded = false;     // "Send another request" opens the form again
  let busy = false;
  const $ = id => shadow.getElementById(id);

  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function fmtDay(ms) {
    const d = new Date(ms);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'today at ' + fmtTime(ms);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' at ' + fmtTime(ms);
  }
  // "Nov 10, 3:08 PM" (the same words as shared/requested.js fmtWhen, in this page's own clock)
  function fmtWhen(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + fmtTime(ms);
  }
  function statusTag(last) {
    if (!last) return '';
    if (last.status === 'approved') return '<span class="tag ok">Approved</span>';
    if (last.remindedAt) return '<span class="tag">Reminded</span>';
    if (last.status === 'blocked') return '<span class="tag">Still blocked</span>';
    return '<span class="tag">Waiting for approval</span>';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function loadFont() {
    try {
      if (!document.fonts || loadFont.done) return;
      loadFont.done = true;
      for (const [w, f] of [['400', 'lato-regular.woff2'], ['700', 'lato-bold.woff2']]) {
        const ff = new FontFace('SR Lato', 'url(' + chrome.runtime.getURL('fonts/' + f) + ')', { weight: w });
        ff.load().then(x => document.fonts.add(x)).catch(() => {});
      }
    } catch (e) { /* the system font is fine */ }
  }

  function build() {
    host = document.createElement('site-request-panel');
    host.id = 'site-request-panel';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>' + CSS + '</style>' +
      '<div class="card" id="card" role="region" aria-label="Site Request">' +
        '<div class="bar" id="bar" hidden>' + CHECK + '<b>Already requested</b><span class="when" id="doneWhen"></span><span class="s">Site Request</span></div>' +
        '<div class="dinfo" id="dinfo" hidden>' +
          '<div class="dline"><span class="pill wait" id="doneStatus">Waiting for approval</span>' +
          '<button class="btn small go" id="reload" type="button" hidden>Reload page</button></div>' +
          '<p class="meta" id="doneMeta"></p>' +
          '<p class="meta times" id="doneCount" hidden></p>' +
        '</div>' +
        '<div class="head" id="head">' + MARK + '<span class="t">Request this site</span><span class="s">Site Request</span></div>' +
        '<div class="addr" id="addr"></div>' +
        '<input class="in" id="urlIn" type="text" placeholder="Site address, e.g. example.com" hidden>' +
        '<p class="note" id="prev" hidden></p>' +
        '<div id="form">' +
        '<p class="hint" id="pageHint" hidden>Earlier request was for this page only</p>' +
        '<div class="scope" id="scope" role="radiogroup" aria-label="What to request">' +
          '<label><input type="radio" name="scope" value="site" checked><span>Whole site</span></label>' +
          '<label><input type="radio" name="scope" value="page"><span>Just this page</span></label>' +
        '</div>' +
        '<p class="note" id="scopeNote"></p>' +
        '<label class="l">Reason</label>' +
        '<div class="chips" id="chips" role="radiogroup" aria-label="Reason"></div>' +
        '<label class="l" for="details">Add details <span style="font-weight:400;color:#73788F">(optional)</span></label>' +
        '<textarea id="details" maxlength="' + DETAILS_MAX + '" rows="1"></textarea>' +
        '<p class="count" id="count" hidden></p>' +
        '</div>' +
        '<div class="tobox" id="tobox" hidden>' +
          '<label class="l" for="toIn" style="margin-top:0">Send requests to (email)</label>' +
          '<div class="row"><input class="in" id="toIn" type="email" placeholder="requests@example.com"><button class="btn small" id="toSave" type="button">Save</button></div>' +
          '<p class="note" id="toNote">The email address of the company that approves your site requests. Save it first; nothing is sent until you do.</p>' +
        '</div>' +
        '<div class="row"><button class="btn" id="send" type="button">Send request</button><span class="goes" id="goes"></span></div>' +
        '<div class="status" id="status" hidden><span class="dot"></span><span class="txt" id="statusText"></span><button class="open" id="openMail" type="button" hidden>Open the email</button></div>' +
      '</div>';

    for (const r of shadow.querySelectorAll('input[name="scope"]')) r.addEventListener('change', () => { touched = true; renderScope(); });
    $('details').addEventListener('input', () => { touched = true; renderCount(); });
    $('urlIn').addEventListener('input', () => { touched = true; renderScope(); });
    $('toIn').addEventListener('input', () => { touched = true; $('toNote').className = 'note'; });
    $('toIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('toSave').click(); });
    $('toSave').addEventListener('click', saveTo);
    $('send').addEventListener('click', send);
    $('reload').addEventListener('click', () => { const u = (info && info.url) || ''; if (u) location.href = u; });
    $('openMail').addEventListener('click', () => { if (jobId) chrome.runtime.sendMessage({ type: 'open_compose', id: jobId }); });
    // Keys typed in the panel stay in the panel (the page may have its own shortcuts).
    for (const ev of ['keydown', 'keyup', 'keypress']) shadow.addEventListener(ev, e => e.stopPropagation());
    loadFont();
  }

  function currentUrl() {
    if (info && info.url && $('urlIn').hidden) return info.url;
    const v = $('urlIn').value.trim();
    if (!v) return '';
    return /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : 'https://' + v;
  }
  function scope() {
    const c = shadow.querySelector('input[name="scope"]:checked');
    return c && c.value === 'page' ? 'page' : 'site';
  }
  function siteTarget(url) {
    if (info && info.targets && url === info.url) return info.targets.site;
    try {
      const h = new URL(url).hostname.toLowerCase();
      const p = h.split('.');
      return '*.' + p.slice(-2).join('.');
    } catch (e) { return url; }
  }
  function renderScope() {
    const url = currentUrl();
    $('scopeNote').hidden = !url;
    if (url) {
      $('scopeNote').textContent = scope() === 'page'
        ? 'Only this address, not the rest of the site.'
        : 'Asks for ' + siteTarget(url) + ' (every page of the site).';
    }
  }
  function renderChips() {
    const box = $('chips');
    box.textContent = '';
    const all = [{ id: '', label: 'None' }].concat((info && info.reasons) || []);
    for (const r of all) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (r.id === chosen ? ' on' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', r.id === chosen ? 'true' : 'false');
      b.dataset.id = r.id;
      b.textContent = r.label;
      if (r.text) b.title = r.text;
      b.addEventListener('click', () => { touched = true; chosen = r.id; renderChips(); });
      box.append(b);
    }
  }
  function renderCount() {
    const box = $('details');
    box.style.height = 'auto';
    box.style.height = Math.max(38, Math.min(140, box.scrollHeight + 2)) + 'px';
    const n = box.value.length;
    $('count').hidden = n < DETAILS_MAX - 100;
    $('count').className = 'count' + (n >= DETAILS_MAX ? ' near' : '');
    $('count').textContent = n + ' / ' + DETAILS_MAX;
  }
  function renderAddress() {
    const has = info && info.hasTo;
    $('tobox').hidden = !!has;
    $('send').disabled = !has || busy;
    $('send').title = has ? '' : 'Save the email address first';
    $('goes').textContent = has ? 'Goes to ' + info.to : 'Save the email address first';
  }
  // From 1.5.1 the "Already requested" bar says it; this older line stays hidden.
  function renderPrev() {
    $('prev').hidden = true;
  }

  // ---------- Already requested (1.5.1) ----------
  function requested() { return (info && info.requested) || null; }
  function folded() { return !!requested() && !expanded; }

  function renderDone() {
    const d = requested();
    $('bar').hidden = !d;
    $('dinfo').hidden = !d;
    $('head').hidden = !!d;
    const ok = !!d && d.status === 'approved';
    $('card').className = 'card' + (d ? ' done' + (ok ? ' ok' : '') : '');
    host.dataset.requested = d ? (ok ? 'approved' : 'pending') : '';
    if (!d) { $('pageHint').hidden = true; return; }
    $('doneWhen').textContent = fmtWhen(d.at);
    $('doneStatus').className = 'pill ' + (ok ? 'ok' : 'wait');
    $('doneStatus').textContent = ok ? 'Approved' : 'Waiting for approval';
    $('reload').hidden = !ok || !(info && info.url);
    $('doneMeta').textContent = (d.meta || '') + (!ok && d.remindedAt ? ' \u00b7 reminder sent' : '');
    const times = d.count > 1 ? 'Requested ' + d.count + ' times \u00b7 last ' + fmtWhen(d.at) : '';
    $('doneCount').hidden = !times;
    $('doneCount').textContent = times;
    $('pageHint').hidden = !d.pageOnly;
  }

  function renderMode() {
    renderDone();
    const send = $('send');
    $('form').hidden = folded();
    if (folded()) {
      send.textContent = 'Send another request';
      send.className = 'btn light';
      send.disabled = busy;
      send.title = '';
      $('tobox').hidden = true;
      return;
    }
    send.textContent = requested() ? 'Send again' : 'Send request';
    send.className = 'btn';
    renderAddress();
  }

  function expand() {
    touched = true;
    expanded = true;
    const d = requested();
    if (d && d.pageOnly) {
      const site = shadow.querySelector('input[name="scope"][value="site"]');
      if (site) site.checked = true;
    }
    renderScope();
    renderMode();
    $('status').hidden = true;
  }
  function render(first) {
    if (first) {
      chosen = info.defaultReason || '';
      if (info.url) {
        $('addr').textContent = info.url;
        $('addr').className = 'addr' + (info.guess ? ' guess' : '');
        $('addr').title = info.guess ? 'Please check the address' : '';
        $('addr').hidden = false;
        $('urlIn').hidden = true;
      } else {
        $('addr').hidden = true;
        $('urlIn').hidden = false;
      }
    }
    if (!info.reasons.some(r => r.id === chosen)) chosen = '';
    renderChips();
    renderScope();
    renderCount();
    renderMode();
    renderPrev();
  }

  function showStatus(state, html, canOpen) {
    $('status').hidden = false;
    $('status').className = 'status ' + state;
    $('statusText').innerHTML = html;
    $('openMail').hidden = !canOpen;
  }

  function renderSent() {
    showStatus('sent', '<b>Request sent</b> at ' + esc(fmtTime(sentAt)) + '.' + statusTag((info && info.last) || { status: 'pending' }), false);
  }

  async function saveTo() {
    touched = true;
    const to = $('toIn').value.trim();
    const r = await chrome.runtime.sendMessage({ type: 'save_to', to });
    if (!r || !r.ok) {
      $('toNote').className = 'note bad';
      $('toNote').textContent = 'Please enter one valid email address.';
      $('toIn').focus();
      return;
    }
    info.hasTo = true;
    info.to = r.to;
    renderAddress();
    showStatus('sent', 'Saved. Requests go to ' + esc(r.to) + '.', false);
    setTimeout(() => { if (!jobId && /^Saved\./.test($('statusText').textContent)) $('status').hidden = true; }, 4000);
  }

  async function send() {
    if ($('send').disabled) return;
    if (folded()) { expand(); return; }
    touched = true;
    const url = currentUrl();
    if (!url) { showStatus('error', esc(MESSAGES.bad_url), false); $('urlIn').focus(); return; }
    const details = $('details').value;
    busy = true;
    $('send').disabled = true;
    showStatus('sending', 'Sending your request\u2026', false);
    const fromBlock = !!(info && info.url && url === info.url);
    const r = await chrome.runtime.sendMessage({
      type: 'request', via: 'panel', url, reason: fromBlock ? info.why : '', fromBlockPage: true,
      scope: scope(), mine: { id: chosen, details }
    });
    if (!r || !r.ok) {
      busy = false;
      $('send').disabled = false;
      showStatus('error', esc(MESSAGES[r && r.error] || 'Something went wrong.'), false);
      if (r && r.error === 'no_address') { info.hasTo = false; renderAddress(); $('toIn').focus(); }
      return;
    }
    jobId = r.id;
    renderPrev();
    poll(0);
  }

  function poll(n) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      let r = null;
      try { r = await chrome.runtime.sendMessage({ type: 'job_status', id: jobId }); } catch (e) { /* worker restarting */ }
      if (r && r.ok && r.state === 'sent') {
        sentAt = r.ended || Date.now();
        if (r.last) info.last = r.last;
        if (r.requested) info.requested = r.requested;
        busy = false;
        expanded = false;      // back to the "Already requested" view, with the new count
        $('details').value = '';
        renderCount();
        renderMode();
        renderSent();
        return;
      }
      if (r && r.ok && r.state === 'error') {
        busy = false;
        $('send').disabled = false;
        const e = String(r.error || '');
        const t = MESSAGES[e] || (e.startsWith('gmail_said:') ? 'Gmail said: ' + e.slice(11).trim() : 'Something went wrong.');
        showStatus('error', esc(t), e !== 'tab_closed');
        return;
      }
      if (n < 240) poll(n + 1);
      else { busy = false; renderMode(); }
    }, n ? 600 : 300);
  }

  // History changes (the approval check) update the tag live.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !shadow) return;
    if (changes.blockPanel || changes.blockPanelAuto || changes.reasons || changes.defaultReason || changes.to || changes.history) refresh(false);
  });

  // ---------- Life cycle ----------
  const WATCH_MS = 6000;     // the page's own scripts may add a request button late
  let watchUntil = 0;
  let lastResult = null;
  let observer = null;
  let reattach = 0;
  let scheduled = 0;
  let started = false;

  async function refresh(first) {
    let r = null;
    try {
      r = await chrome.runtime.sendMessage({ type: 'panel_info', href: location.href, found: findUrl(), why: findReason() });
    } catch (e) { return; }
    if (!r || !r.ok) return;
    const firstInfo = !info;
    if (info && !first) {
      // keep the address the panel already shows
      r.url = info.url; r.guess = info.guess; r.targets = info.targets;
    }
    info = r;
    if (!host) build();
    render(firstInfo || first);
    if (sentAt && info.last) renderSent();
    apply();
  }

  function apply() {
    if (!info || !host) return;
    if (!lastResult || Date.now() < watchUntil) lastResult = detect();
    const show = D.shouldShow(info.settings, lastResult) || (touched && info.settings.blockPanel !== false);
    host.dataset.own = lastResult.own ? '1' : '0';
    host.dataset.locked = lastResult.locked ? '1' : '0';
    if (show) {
      if (!host.isConnected || host.hidden) { host.hidden = false; }
      place();
      host.style.display = '';
    } else {
      host.style.display = 'none';
      if (!host.isConnected) place();
    }
  }

  function onMutations() {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = 0;
      if (host && !host.isConnected && reattach < 30) { reattach++; place(); }
      if (Date.now() < watchUntil) apply();
    }, 120);
  }

  function start() {
    if (started) return;
    started = true;
    watchUntil = Date.now() + WATCH_MS;
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'disabled'] });
    // A last look when the watch ends, in case nothing changed in the DOM to wake the observer.
    setTimeout(() => { if (info) apply(); }, WATCH_MS + 200);
    refresh(true);
  }

  // The block page is a single-page app: it can load "/" first and route to the block page after.
  function bootCheck() {
    if (started) return true;
    if (!document.body) return false;
    if (D.looksLikeBlockPage(location.href, document.body.innerText)) { start(); return true; }
    return false;
  }
  if (!bootCheck()) {
    const t0 = Date.now();
    const bootObs = new MutationObserver(() => { if (bootCheck() || Date.now() - t0 > 30000) bootObs.disconnect(); });
    bootObs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    const iv = setInterval(() => { if (bootCheck() || Date.now() - t0 > 30000) { clearInterval(iv); bootObs.disconnect(); } }, 500);
  }
})();
