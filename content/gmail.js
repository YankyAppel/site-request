// Runs on Gmail. It does nothing unless this tab is a compose window opened by this extension.
(function () {
  if (window.top !== window) return;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function labelOf(el) {
    return ((el.getAttribute('data-tooltip') || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
  }

  function findSend() {
    const all = Array.from(document.querySelectorAll('div[role="button"], button')).filter(visible);
    const strip = s => s.replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
    return (
      all.find(e => /^send\b/i.test(strip(e.getAttribute('data-tooltip') || ''))) ||
      all.find(e => /^send\b/i.test(strip(e.getAttribute('aria-label') || ''))) ||
      all.find(e => /(ctrl|\u2318)\s*-?\s*(enter|\u21b5)/i.test(labelOf(e)) && !/schedul|more|option/i.test(labelOf(e))) ||
      all.find(e => e.classList.contains('aoO')) ||
      all.find(e => /^(send|\u05e9\u05dc\u05d9\u05d7\u05d4|\u05e9\u05dc\u05d7)$/i.test(strip(e.textContent || '')))
    ) || null;
  }

  function sentSignal() {
    if (document.getElementById('link_vsm')) return true;
    const live = Array.from(document.querySelectorAll('[role="alert"], [aria-live], .bAq, .vh'));
    return live.some(el => /message sent|\u05d4\u05d4\u05d5\u05d3\u05e2\u05d4 \u05e0\u05e9\u05dc\u05d7\u05d4/i.test(el.textContent || ''));
  }

  function errorDialog() {
    const d = Array.from(document.querySelectorAll('[role="alertdialog"]')).find(visible);
    return d ? (d.innerText || d.textContent || '').trim().slice(0, 200) : '';
  }

  async function waitFor(fn, ms, step = 250) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function press(el) {
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function ctrlEnter() {
    const target = document.querySelector('div[role="textbox"][contenteditable="true"]') || document.activeElement || document.body;
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, ctrlKey: true, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // 1.5.5: put the formatted version of the email into the compose box, keeping your Gmail signature.
  // Returns true when it is in. On any problem nothing is changed and the plain text is sent.
  function findBody() {
    const boxes = Array.from(document.querySelectorAll('div[contenteditable="true"][role="textbox"], div[contenteditable="true"].editable, div[contenteditable="true"][g_editable="true"]')).filter(visible);
    return boxes.find(b => /message body|\u05d2\u05d5\u05e3 \u05d4\u05d4\u05d5\u05d3\u05e2\u05d4/i.test(b.getAttribute('aria-label') || '')) || boxes[0] || null;
  }
  function putHtml(html) {
    try {
      if (!html) return false;
      const box = findBody();
      if (!box) return false;
      const before = box.innerHTML;
      const sig = box.querySelector('.gmail_signature');
      const sigWrap = sig ? (sig.closest('[data-smartmail="gmail_signature"]') || sig.closest('div.gmail_signature_prefix') || sig) : null;
      const keep = sigWrap ? sigWrap.cloneNode(true) : null;
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      // Only the email itself goes in: no scripts or event handlers.
      tpl.content.querySelectorAll('script, iframe, object, embed').forEach(n => n.remove());
      // Your Gmail signature goes after "Thank you", above the "Sent with" line.
      if (keep) {
        const foot = tpl.content.querySelector('[data-sr-footer]');
        const sigBox = document.createElement('div');
        sigBox.style.margin = '0 0 18px';
        sigBox.appendChild(keep);
        if (foot) foot.parentNode.insertBefore(sigBox, foot); else tpl.content.appendChild(sigBox);
      }
      box.innerHTML = '';
      box.appendChild(tpl.content);
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
      if (!/Sent with Site Request/.test(box.textContent || '')) { box.innerHTML = before; box.dispatchEvent(new InputEvent('input', { bubbles: true })); return false; }
      return true;
    } catch (e) { return false; }
  }

  function report(id, state, error) {
    try { chrome.runtime.sendMessage({ type: 'gmail_result', id, state, error: error || '' }); } catch (e) { /* extension reloaded */ }
  }

  async function run(job) {
    const btn = await waitFor(findSend, 45000);
    if (!btn) return report(job.id, 'error', 'no_send_button');
    await sleep(1500);
    if (job.html) {
      const ok = putHtml(job.html);
      try { chrome.runtime.sendMessage({ type: 'gmail_html', id: job.id, ok }); } catch (e) { /* extension reloaded */ }
      await sleep(ok ? 300 : 0);
    }
    press(btn);

    let result = await waitFor(() => (sentSignal() ? 'sent' : errorDialog() ? 'dialog' : null), 6000);
    if (!result) {
      const still = findSend();
      if (still && still === btn && visible(btn)) {
        // The click did not register: try the keyboard shortcut once.
        ctrlEnter();
      }
      result = await waitFor(() => (sentSignal() ? 'sent' : errorDialog() ? 'dialog' : (!findSend() ? 'closed' : null)), 20000);
    }
    if (result === 'sent' || result === 'closed') {
      if (result === 'closed') await waitFor(sentSignal, 4000);
      return report(job.id, 'sent');
    }
    if (result === 'dialog') return report(job.id, 'error', 'gmail_said: ' + errorDialog());
    return report(job.id, 'error', 'no_confirmation');
  }

  let started = false;
  async function check() {
    if (started) return;
    let job;
    try { job = await chrome.runtime.sendMessage({ type: 'gmail_ready' }); } catch (e) { return; }
    if (!job || !job.auto || started) return;
    started = true;
    run(job);
  }
  check();
})();
