// 1.5.5: the formatted (HTML) version of an email. The plain text stays the fallback:
// it is what the Gmail compose link carries, and it is what is sent if the formatted one can't be put in.
import { cleanText, cleanDetails } from './reasons.js';

export const LOGO = 'https://raw.githubusercontent.com/YankyAppel/site-request/main/icons/icon48.png';
const FONT = "Lato,'Segoe UI',Roboto,Arial,sans-serif";
const BLUE = '#1a7db6', GRAY = '#9a9a9a', TEXT = '#333333';

export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function multi(s) { return esc(s).replace(/\n/g, '<br>'); }
function p(html, last) { return '<p style="margin:0 0 ' + (last ? 22 : 14) + 'px">' + html + '</p>'; }
function heading(t) {
  return '<div style="font-size:12px;color:' + GRAY + ';text-transform:uppercase;letter-spacing:.05em;margin:0 0 4px">' + esc(t) + '</div>';
}
function table(rows) {
  rows = rows.filter(r => String(r[1] || '').trim());
  if (!rows.length) return '';
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;margin:0 0 16px">' +
    rows.map(([k, v]) => '<tr><td style="padding:3px 16px 3px 0;color:' + GRAY + ';vertical-align:top;white-space:nowrap;width:96px">' + esc(k) +
      '</td><td style="padding:3px 0;color:' + TEXT + ';vertical-align:top">' + multi(String(v).trim()) + '</td></tr>').join('') + '</table>';
}
function section(title, rows) {
  const t = table(rows);
  return t ? heading(title) + t : '';
}

// "My account": name, phone, PIN and notes, each only when filled in.
export function accountSection(s) {
  return section('My account', [
    ['Name', s.name], ['Phone', s.phone], ['Account PIN', s.pin], ['Notes', s.notes]
  ]);
}

export function footer() {
  return '<div data-sr-footer="1" style="border-top:1px solid #e6eaed;padding-top:8px;font-size:12px;color:' + GRAY + '">' +
    '<img src="' + LOGO + '" width="14" height="14" alt="" style="vertical-align:-2px;margin-right:5px;border:0">Sent with Site Request</div>';
}

export function wrap(inner) {
  return '<div style="font-family:' + FONT + ';font-size:15px;line-height:1.5;color:' + TEXT + ';max-width:560px">' + inner + footer() + '</div>';
}

// Any plain message (your own message from Settings, the parts email, the reminder): its paragraphs, then My account.
// The plain account block ("--\nAccount details: ...") is replaced by the My account section.
export function htmlFromText(body, s) {
  let b = String(body || '');
  const cut = b.indexOf('\n\n--\nAccount details:');
  if (cut >= 0) b = b.slice(0, cut);
  const paras = b.replace(/\r/g, '').split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
  return wrap(paras.map((x, i) => p(multi(x), i === paras.length - 1)).join('') + accountSection(s));
}

// The request email in the default layout: a friendly opening, "The site", "My account".
// v: { domain, target, url, scope, why: { text, details } }
export function htmlRequest(v, s) {
  const site = v.scope === 'page'
    ? 'I would like to allow <b style="color:' + BLUE + '">this page</b> on ' + esc(v.domain) + ' for my account (just this page, not the whole site).'
    : 'I would like to allow <b style="color:' + BLUE + '">' + esc(v.domain) + '</b> for my account.';
  const text = cleanText(v.why && v.why.text);
  const details = cleanDetails(v.why && v.why.details);
  const target = String(v.target || '');
  return wrap(
    p('Hi,') +
    p(site + (text ? ' ' + esc(text) : '')) +
    section('The site', [
      ['Site', v.scope === 'page' ? '' : target.replace(/^\*\./, '') + ' (whole site)'],
      ['Page', v.url],
      ['Details', details]
    ]) +
    accountSection(s) +
    p('Thank you so much for your help!', true)
  );
}
