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

  // 1.5.3: right under the blocked address, so the form is on the first screen without scrolling
  function blockedUrlEl() {
    if (!document.body) return null;
    let target = '';
    try { target = new URLSearchParams(location.search).get('redirectUrl') || ''; } catch (e) {}
    const norm = s => String(s || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    const t = norm(target);
    if (t) {
      for (const a of document.querySelectorAll('a, span, div, p')) {
        if (host && host.contains(a)) continue;
        if (a.children.length > 1) continue;
        const txt = norm(a.textContent);
        if (txt && (txt === t || (txt.length > 6 && t.startsWith(txt)) || (txt.length > 6 && txt.startsWith(t))) && isVisible(a)) return a;
      }
    }
    const lab = textNodeMatching(/url\s+blocked/i);
    if (lab) {
      let el = wrapperOf(lab);
      const nx = el.nextElementSibling;
      if (nx && String(nx.textContent || '').trim() && nx.getBoundingClientRect().height < 80) return nx;
      return el;
    }
    return null;
  }

  function place() {
    if (!host) return;
    const u = blockedUrlEl();
    if (u) {
      let el = u;
      while (el.parentElement && el.parentElement !== document.body &&
             String(el.parentElement.textContent || '').trim() === String(el.textContent || '').trim()) el = el.parentElement;
      if (el.parentElement && el.nextSibling !== host) el.parentElement.insertBefore(host, el.nextSibling);
      host.dataset.at = 'url';
      return;
    }
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

  // ---------- Looks (1.5.2): borrow the page's own font, colours and info-row columns ----------
  const RE_ROW_LABEL = /^\s*(filter action|why\s*\??|category|admin)\s*:?\s*$/i;
  function infoLabels() {
    const out = [];
    if (!document.body) return out;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const el = n.parentElement;
      if (!el || (host && host.contains(el))) continue;
      if (RE_ROW_LABEL.test(n.nodeValue || '') && String(el.textContent || '').trim().length < 30) out.push(el);
    }
    return out;
  }
  function colourOf(el, prop) {
    const c = el ? getComputedStyle(el)[prop] : '';
    return c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c) ? c : '';
  }
  function measure() {
    if (!host || !host.isConnected || !shadow) return;
    const set = (k, v) => { if (v) host.style.setProperty(k, v); else host.style.removeProperty(k); };
    try {
      const labels = infoLabels().filter(isVisible);
      const label = labels[labels.length - 1] || null;
      // the value next to the label: the first visible element after it whose box starts to its right
      let value = null, rowBox = null;
      if (label) {
        const lb = label.getBoundingClientRect();
        let row = label;
        for (let i = 0; i < 6 && row.parentElement && row.parentElement !== document.body; i++) {
          row = row.parentElement;
          if (String(row.textContent || '').trim().length > String(label.textContent || '').trim().length + 1) break;
        }
        for (const el of row.querySelectorAll('*')) {
          if (el === label || el.contains(label) || label.contains(el) || !isVisible(el)) continue;
          const b = el.getBoundingClientRect();
          if (b.left >= lb.right - 2 && Math.abs(b.top - lb.top) < lb.height * 1.5 && String(el.textContent || '').trim()) { value = el; break; }
        }
        const tbl = label.closest('table');
        rowBox = (tbl || row).getBoundingClientRect();
        const hb = host.getBoundingClientRect();
        const valLeft = value ? value.getBoundingClientRect().left : 0;
        const left = Math.min(lb.left, rowBox.left + 0);
        const width = Math.max(rowBox.right, value ? value.getBoundingClientRect().right : 0) - left;
        const PAD = 0;    // no padding or outline: the rows line up with the page's rows
        if (value && width > 300 && hb.width > 0) {
          const w = width + 2 * PAD;
          const off = Math.round(left - PAD - hb.left);
          const fits = off >= 0 && off + w <= hb.width + 1;
          set('--sr-w', Math.round(fits ? w : Math.min(w, hb.width)) + 'px');
          set('--sr-c', Math.round(valLeft - lb.left) + 'px');
          set('--sr-l', Math.round(Math.max(0, lb.left - left)) + 'px');
          set('--sr-ml', fits ? off + 'px' : '');
        } else { set('--sr-w', ''); set('--sr-c', ''); set('--sr-l', ''); set('--sr-ml', ''); }
        set('--sr-k', colourOf(label, 'color'));
      }
      const txt = value || label || document.body;
      const cs = getComputedStyle(txt);
      set('--sr-ff', cs.fontFamily ? cs.fontFamily + ', "SR Lato", Lato, "Segoe UI", Arial, sans-serif' : '');
      const fs = parseFloat(cs.fontSize);
      set('--sr-fs', fs >= 12 && fs <= 22 ? fs + 'px' : '');
      // the page's dark text: the "miscategorized? Let us know" line, else the value column
      const rep = textNodeMatching(/let us know|mis[\s-]?categori[sz]ed\?/i);
      const darkEl = (rep && rep.parentElement && !rep.parentElement.closest('a')) ? rep.parentElement : (value && !/blocked/i.test(value.textContent) ? value : null);
      set('--sr-t', darkEl ? colourOf(darkEl, 'color') : '');
      // the page's link blue ("Report miscategorization", the admin link, the blocked address)
      const link = Array.from(document.querySelectorAll('a')).find(a => !(host && host.contains(a)) && isVisible(a) && /mis[\s-]?categori/i.test(a.textContent || ''))
        || Array.from(document.querySelectorAll('a')).find(a => !(host && host.contains(a)) && isVisible(a));
      const blue = link ? colourOf(link, 'color') : '';
      set('--sr-a', blue && !/rgb\((0, 0, 0|51, 51, 51|255, 255, 255)\)/.test(blue) ? blue : '');
      host.dataset.narrow = host.getBoundingClientRect().width < 440 ? '1' : '0';
    } catch (e) { /* the built-in looks are fine */ }
  }
  addEventListener('resize', () => { if (host && host.style.display !== 'none') measure(); });

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

  const CHECK = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11"/><path d="M7 12.4l3.2 3.2L17.2 8.6" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // 1.5.2: no card. The box is drawn as part of the page: the page's own font, sizes and colours (read from the
  // page when it can, see measure()), its two-column info rows, centered like its content. Buttons: the page's
  // light gray-blue (#ecf0f2), a thin blue outline and blue text.
  const CSS = `
:host { all: initial; display: block; width: 100%; margin: 34px auto 6px; text-align: left; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.card { font-family: var(--sr-ff, "SR Lato", Lato, "Segoe UI", Roboto, Arial, sans-serif); color: var(--sr-t, #333);
  font-size: var(--sr-fs, 17px); line-height: 1.4; width: var(--sr-w, 640px); max-width: 100%; margin: 0 auto 0 var(--sr-ml, auto);
  background: transparent; border: 0; border-radius: 0; box-shadow: none; padding: 0; }
.head, .bar { text-align: center; margin: 0 0 12px; font-weight: 400; color: var(--sr-t, #333); }
.bar { display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; }
.bar b { font-weight: 700; }
.bar svg { display: block; flex: none; }
.bar svg circle { fill: var(--sr-a, #1a7db6); }
.card.ok .bar svg circle { fill: #3c8d5a; }
.bar svg path { stroke: #fff; }
.bar .when { color: var(--sr-k, #9a9a9a); }
.r { display: grid; grid-template-columns: var(--sr-c, 45%) minmax(0, 1fr); align-items: baseline; padding: 8px 0 8px var(--sr-l, 0px); }
.k { color: var(--sr-k, #9a9a9a); padding-right: 12px; }
.v { min-width: 0; overflow-wrap: anywhere; }
:host([data-narrow="1"]) .r { grid-template-columns: minmax(0, 1fr); padding-left: 0; }
:host([data-narrow="1"]) .k { padding: 0 0 3px; }
.addr { overflow-wrap: anywhere; word-break: break-all; }
.addr.guess { text-decoration: underline dotted #c98a12; text-underline-offset: 3px; }
.note { font-size: .86em; color: var(--sr-k, #9a9a9a); margin: 3px 0 0; overflow-wrap: anywhere; }
.note.bad { color: #c9302c; }
.scope, .chips { display: flex; flex-wrap: wrap; gap: 4px 20px; border: 0; margin: 0; }
.scope label { position: relative; cursor: pointer; margin: 0; }
.scope input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.scope span, .chip { display: inline-flex; align-items: center; gap: 7px; font: inherit; color: var(--sr-t, #333); background: none;
  border: 0; border-radius: 0; padding: 0; margin: 0; cursor: pointer; text-align: left; }
.scope span:before, .chip:before { content: ''; flex: none; width: 13px; height: 13px; border-radius: 50%; border: 1.5px solid #b8b8b8; background: transparent; }
.scope input:checked + span, .chip.on { color: var(--sr-a, #1a7db6); font-weight: 700; }
.scope input:checked + span:before, .chip.on:before { border-color: var(--sr-a, #1a7db6); background: var(--sr-a, #1a7db6); box-shadow: inset 0 0 0 2.5px #fff; }
.scope span:hover, .chip:hover { color: var(--sr-a, #1a7db6); }
.scope input:focus-visible + span, .chip:focus-visible { outline: 2px solid rgba(26,125,182,.35); outline-offset: 2px; }
input.in, textarea { font: inherit; font-size: .94em; color: var(--sr-t, #333); width: 100%; border: 1px solid #d6d6d6; border-radius: 4px;
  padding: 7px 9px; outline: none; background: #fff; margin: 0; box-shadow: none; }
input.in:focus, textarea:focus { border-color: var(--sr-a, #1a7db6); }
textarea { resize: vertical; min-height: 38px; height: 38px; max-height: 140px; display: block; }
.count { margin: 2px 0 0; font-size: .76em; color: var(--sr-k, #9a9a9a); text-align: right; }
.count.near { color: #c9302c; }
.row { display: flex; gap: 10px; align-items: center; }
.act { display: flex; flex-direction: column; align-items: center; gap: 6px; margin-top: 14px; text-align: center; }
/* buttons: the page's light gray-blue, a thin blue outline, blue text, the page's font */
.btn { font: inherit; font-size: .94em; font-weight: 700; color: var(--sr-a, #1a7db6); background: #ecf0f2; border: 1px solid var(--sr-a, #1a7db6);
  border-radius: 4px; padding: 8px 26px; cursor: pointer; box-shadow: none; line-height: 1.3; }
.btn { white-space: nowrap; flex-shrink: 0; }
.btn:hover { background: #e1e8ed; }
.btn:active { background: #d6e0e7; }
.btn:focus-visible { outline: 2px solid rgba(26,125,182,.35); outline-offset: 2px; }
.btn[disabled] { opacity: .45; cursor: default; background: #ecf0f2; }
.btn.small { font-size: .88em; padding: 6px 14px; }
.btn.go { margin-left: 14px; padding: 4px 14px; font-size: .88em; }
.goes { font-size: .86em; color: var(--sr-k, #9a9a9a); overflow-wrap: anywhere; }
.tobox .row { margin-top: 0; }
.status { display: flex; align-items: center; justify-content: center; gap: 8px; font-size: .9em; margin-top: 10px; text-align: center; flex-wrap: wrap; }
.status .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--sr-k, #9a9a9a); }
.status.sending .dot { background: var(--sr-a, #1a7db6); animation: pulse 1s ease-in-out infinite; }
.status.sent .dot { background: #3c8d5a; }
.status.error .dot { background: #c9302c; }
.status.error .txt { color: #c9302c; }
.status .open { font: inherit; color: var(--sr-a, #1a7db6); background: none; border: 0; padding: 0; cursor: pointer; font-weight: 700; }
.status .callline { display: block; flex-basis: 100%; margin-top: 4px; font-weight: 700; color: var(--sr-t, #333); }
.status .call { color: var(--sr-a, #1a7db6); text-decoration: none; white-space: nowrap; }
.status .subs { display: block; flex-basis: 100%; margin-top: 6px; max-height: 110px; overflow: auto; font-size: .85em; color: var(--sr-k, #9a9a9a); line-height: 1.45; }
.tag { font-weight: 400; color: var(--sr-k, #9a9a9a); }
.tag:before { content: ' \\00b7  '; }
.tag.ok { color: #3c8d5a; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.dline { display: flex; align-items: baseline; flex-wrap: wrap; }
.pill { display: inline-flex; align-items: baseline; gap: 9px; font-weight: 400; background: none; padding: 0; }
.pill:before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; transform: translateY(-2px); }
.pill.wait { color: #b8730a; }
.pill.ok { color: #3c8d5a; }
.meta { margin: 0; overflow-wrap: anywhere; }
.meta.times { color: var(--sr-k, #9a9a9a); font-size: .86em; margin-top: 2px; }
.hint { margin: 0 0 4px; font-size: .86em; color: var(--sr-k, #9a9a9a); text-align: center; font-style: italic; }
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
    const row = (k, v, id) => '<div class="r"' + (id ? ' id="' + id + '"' : '') + '><span class="k">' + k + '</span><div class="v">' + v + '</div></div>';
    shadow.innerHTML = '<style>' + CSS + '</style>' +
      '<div class="card" id="card" role="region" aria-label="Request this site">' +
        '<div class="bar" id="bar" hidden>' + CHECK + '<b>Already requested</b><span class="when" id="doneWhen"></span></div>' +
        '<div class="dinfo" id="dinfo" hidden>' +
          row('Status:', '<div class="dline"><span class="pill wait" id="doneStatus">Waiting for approval</span>' +
            '<button class="btn small go" id="reload" type="button" hidden>Reload page</button></div>') +
          row('Requested:', '<p class="meta" id="doneMeta"></p><p class="meta times" id="doneCount" hidden></p>') +
        '</div>' +
        '<div class="head" id="head">Need this site opened? Request this site:</div>' +
        row('Site:', '<div class="addr" id="addr"></div>' +
          '<input class="in" id="urlIn" type="text" placeholder="Site address, e.g. example.com" hidden>' +
          '<p class="note" id="prev" hidden></p>', 'addrRow') +
        '<div id="form">' +
        '<p class="hint" id="pageHint" hidden>Earlier request was for this page only</p>' +
        row('Request:', '<div class="scope" id="scope" role="radiogroup" aria-label="What to request">' +
          '<label><input type="radio" name="scope" value="site" checked><span>Whole site</span></label>' +
          '<label><input type="radio" name="scope" value="page"><span>Just this page</span></label>' +
          '</div><p class="note" id="scopeNote"></p>') +
        row('Reason:', '<div class="chips" id="chips" role="radiogroup" aria-label="Reason"></div>') +
        row('<label for="details">Details (optional):</label>',
          '<textarea id="details" maxlength="' + DETAILS_MAX + '" rows="1"></textarea><p class="count" id="count" hidden></p>') +
        '</div>' +
        '<div class="tobox" id="tobox" hidden>' +
          row('<label for="toIn">Send requests to:</label>',
            '<div class="row"><input class="in" id="toIn" type="email" placeholder="requests@example.com"><button class="btn small" id="toSave" type="button">Save</button></div>' +
            '<p class="note" id="toNote">The email address of the company that approves your site requests. Save it first; nothing is sent until you do.</p>') +
        '</div>' +
        '<div class="act"><button class="btn" id="send" type="button">Send request</button><span class="goes" id="goes"></span></div>' +
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
      return p.slice(-2).join('.');
    } catch (e) { return url; }
  }
  function renderScope() {
    const url = currentUrl();
    $('scopeNote').hidden = !url;
    if (url) {
      $('scopeNote').textContent = scope() === 'page'
        ? 'Only this address, not the rest of the site.'
        : 'Asks for ' + siteTarget(url) + ' and its known subdomains (every page of the site).';
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
      // 1.5.2 fix: the folded view says where a new request would go (it was empty on a fresh load)
      $('goes').textContent = info && info.hasTo && info.to ? 'Goes to ' + info.to : '';
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

  // Settings > "Phone number to call": shown under "Request sent", so you call and they review it.
  let callNumber = '';
  function loadCall() {
    try {
      chrome.storage.local.get({ callNumber: '' }, r => { callNumber = String((r && r.callNumber) || '').trim(); if (jobId && $('status') && /sent/.test($('status').className)) renderSent(); });
    } catch (e) { /* extension reloaded */ }
  }
  loadCall();
  function callLine() {
    if (!callNumber) return '';
    const d = callNumber.replace(/[^\d+]/g, '');
    const num = d.replace(/\D/g, '').length >= 3 ? '<a class="call" href="tel:' + esc(d) + '">' + esc(callNumber) + '</a>' : esc(callNumber);
    return '<span class="callline">Call ' + num + ' so they review your request.</span>';
  }

  function renderSent() {
    showStatus('sent', '<b>Request sent</b> at ' + esc(fmtTime(sentAt)) + '.' + statusTag((info && info.last) || { status: 'pending' }) + callLine(), false);
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

  // The worker reports the whole-site subdomain lookup while the request builds:
  // the found addresses tick into the animation one by one, then it says it's sending.
  let subTimer = 0;
  chrome.runtime.onMessage.addListener(msg => {
    if (!busy) return;
    if (msg && msg.type === 'allow_progress') {
      showStatus('sending', 'Finding the site\u2019s addresses\u2026<span class="subs" id="subs"></span>', false);
    } else if (msg && msg.type === 'allow_list' && Array.isArray(msg.items)) {
      const items = msg.items.map(String);
      showStatus('sending', 'Finding the site\u2019s addresses\u2026<span class="subs" id="subs"></span>', false);
      const box = $('subs');
      if (!box || !items.length) { showStatus('sending', 'Sending your request\u2026', false); return; }
      let i = 0;
      clearInterval(subTimer);
      subTimer = setInterval(() => {
        box.innerHTML += (i ? '<br>' : '') + esc(items[i]);
        box.scrollTop = box.scrollHeight;
        if (++i >= items.length) {
          clearInterval(subTimer);
          $('statusText').firstChild.textContent = 'Sending your request\u2026';
        }
      }, 80);
    }
  });

  // History changes (the approval check) update the tag live.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !shadow) return;
    if (changes.callNumber) loadCall();
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
      measure();
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
