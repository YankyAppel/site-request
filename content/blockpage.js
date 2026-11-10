// Answers the popup with the blocked address shown on the block page, when the page address does not carry it.
(function () {
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
    return '';
  }
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg && msg.type === 'find_url') reply({ url: findUrl(), reason: findReason(), href: location.href });
  });
})();
