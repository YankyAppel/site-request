// Does the block page offer its own way to request the site? Used by content/blockpage.js.
// Plain script (no import/export) so it runs as a content script; the tests load it in node.
(function (root) {
  'use strict';

  // "Report miscategorization" is on every block page, with or without a request option, so it never counts.
  const EXCLUDE = /mis[\s-]?categori[sz]|report\s+(a\s+)?(wrong|incorrect|bad)\s+categor|\bcategor(y|ies)\s+(is\s+)?(wrong|incorrect)/i;

  // Words a request button, link or form would carry.
  const WORDS = new RegExp([
    'request(?!ed\\b)(ing)?\\b',          // Request, Request access, Submit request (not "Requested URL")
    'un-?block',
    'white[\\s-]?list(ing)?',
    'allow[\\s-]?list',
    'ask\\s+(us\\s+)?to\\s+(open|unblock|allow|access|approve)',
    'ask\\s+for\\s+access',
    'grant\\s+access',
    'open\\s+(this|the)\\s+(site|page|website)',
    'approve\\s+(this|the)\\s+(site|page|website)'
  ].map(s => '\\b' + s).join('|'), 'i');

  // Attribute names whose words count as weak signs (an id or class like "request-btn").
  const WEAK_ATTRS = ['id', 'class', 'name', 'href', 'action', 'formaction', 'data-action', 'routerlink', 'ng-reflect-router-link'];

  // Splits "requestAccessBtn" / "request_access" / "/site-request/new" into words.
  function words(s) {
    return String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-/.?=&#:]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // A link's address counts by its path only (the query may carry the blocked address itself),
  // and a link to another site (the blocked one) does not count at all.
  function hintValue(name, v) {
    v = String(v || '');
    if (name === 'href' || name === 'action' || name === 'formaction') {
      if (/^(https?:)?\/\//i.test(v) && !/^(https?:)?\/\/[^/]*techloq\./i.test(v)) return '';
      if (/^(javascript|mailto|tel):/i.test(v)) return '';
      v = v.replace(/^(https?:)?\/\/[^/]+/i, '').split(/[?#]/)[0];
    }
    return words(v);
  }

  // The blocked address shown as a link is not a button, whatever words its address has.
  const LOOKS_LIKE_URL = /^\s*(https?:\/\/|www\.)\S+\s*$/i;

  function means(s) {
    s = String(s || '');
    if (!s.trim() || EXCLUDE.test(s)) return false;
    return WORDS.test(s);
  }

  // A "locked" category is the Enhanced plan's sign that the request must go another way.
  function isLocked(info) {
    const parts = [info && info.title, info && info.headings, info && info.why].filter(Boolean).join('\n');
    if (/\blocked\b/i.test(parts)) return true;
    return /\blocked\s+(web\s+)?(category|categories|site|url|content)\b/i.test(String((info && info.text) || ''));
  }

  // cands: [{ text, label, attrs: {name: value}, visible, disabled }]
  //   text  = the visible words; label = aria-label / title / value (also counts as words a person sees)
  // info:  { title, headings, why, text } of the page.
  // Returns { own, strong, weak, locked, matches }: own = the page has its own request option.
  function classify(cands, info) {
    const strong = [];
    const weak = [];
    for (const c of cands || []) {
      if (!c || c.visible === false || c.disabled) continue;
      const seen = [c.text, c.label].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (EXCLUDE.test(seen)) continue;
      if (LOOKS_LIKE_URL.test(c.text || '') && !c.label) continue;
      if (means(seen)) { strong.push(seen.slice(0, 80)); continue; }
      const attrs = c.attrs || {};
      let hit = '';
      for (const a of WEAK_ATTRS) {
        const v = hintValue(a, attrs[a]);
        if (v && !EXCLUDE.test(v) && means(v)) { hit = a + '=' + String(attrs[a]).slice(0, 60); break; }
      }
      if (hit) weak.push(hit);
    }
    const locked = isLocked(info);
    // A visible "Request" button always counts. Hints only in ids/classes count unless the category is locked.
    const own = strong.length > 0 || (!locked && weak.length > 0);
    return { own, locked, strong, weak, matches: strong.concat(locked ? [] : weak) };
  }

  // settings: { blockPanel, blockPanelAuto }
  function shouldShow(settings, result) {
    const s = settings || {};
    if (s.blockPanel === false) return false;
    if (s.blockPanelAuto === false) return true;
    return !(result && result.own);
  }

  // Is this document a block page (and not some other page on the same site)?
  function looksLikeBlockPage(href, text) {
    let path = '';
    try { path = new URL(href).pathname; } catch (e) { /* ignore */ }
    if (/block[-_]?page/i.test(path)) return true;
    return /requested\s+url\s+(is\s+)?blocked|filter\s+action\s*:?\s*blocked|\bblocked\s+web\s+category|\blocked\s+web\s+category/i.test(String(text || ''));
  }

  const api = { classify, hintValue, shouldShow, isLocked, looksLikeBlockPage, means, words, EXCLUDE, WORDS };
  root.SRDetect = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
