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

  function report(id, state, error) {
    try { chrome.runtime.sendMessage({ type: 'gmail_result', id, state, error: error || '' }); } catch (e) { /* extension reloaded */ }
  }

  async function run(job) {
    const btn = await waitFor(findSend, 45000);
    if (!btn) return report(job.id, 'error', 'no_send_button');
    await sleep(1500);
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
