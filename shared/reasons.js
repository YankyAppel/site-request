// Reason templates: a short label (shown as a button) and the text that goes in the email.

export const LABEL_MAX = 40;
export const TEXT_MAX = 300;
export const DETAILS_MAX = 500;
export const REASONS_MAX = 30;

// Shipped once; they can be edited or deleted like any other.
export const STARTER_REASONS = [
  { id: 'r-work', label: 'For work', text: 'I need this site for my work.' },
  { id: 'r-learning', label: 'For a shiur / learning', text: 'I need this site for a shiur / learning.' },
  { id: 'r-school', label: 'For school', text: 'I need this site for school.' },
  { id: 'r-shopping', label: 'For shopping / a purchase', text: 'I need this site for shopping / a purchase.' }
];

function oneLine(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanLabel(s) { return oneLine(s, LABEL_MAX); }
export function cleanText(s) { return oneLine(s, TEXT_MAX); }

// The free text: line breaks are kept (at most one empty line in a row), cut at DETAILS_MAX.
export function cleanDetails(s) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ')
    .split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, DETAILS_MAX).trim();
}

function newId(list) {
  let id;
  do { id = 'r-' + Math.random().toString(36).slice(2, 9); } while (list.some(r => r.id === id));
  return id;
}

// Whatever is stored is read safely: bad rows are dropped, a missing list means the starters.
export function normalizeReasons(raw) {
  if (!Array.isArray(raw)) return STARTER_REASONS.map(r => Object.assign({}, r));
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const label = cleanLabel(r.label);
    if (!label) continue;
    let id = String(r.id || '');
    if (!id || seen.has(id)) id = newId(out);
    seen.add(id);
    out.push({ id, label, text: cleanText(r.text) || label });
  }
  return out.slice(0, REASONS_MAX);
}

export function findReason(list, id) {
  if (!id) return null;
  return (list || []).find(r => r.id === id) || null;
}

// Each change returns { ok, list, item } or { ok: false, error } and never changes the list it was given.
export function addReason(list, label, text) {
  list = list || [];
  const l = cleanLabel(label);
  if (!l) return { ok: false, error: 'no_label' };
  if (list.length >= REASONS_MAX) return { ok: false, error: 'too_many' };
  if (list.some(r => r.label.toLowerCase() === l.toLowerCase())) return { ok: false, error: 'same_label' };
  const item = { id: newId(list), label: l, text: cleanText(text) || l };
  return { ok: true, list: list.concat([item]), item };
}

export function updateReason(list, id, label, text) {
  list = list || [];
  const i = list.findIndex(r => r.id === id);
  if (i < 0) return { ok: false, error: 'not_found' };
  const l = cleanLabel(label);
  if (!l) return { ok: false, error: 'no_label' };
  if (list.some(r => r.id !== id && r.label.toLowerCase() === l.toLowerCase())) return { ok: false, error: 'same_label' };
  const item = { id, label: l, text: cleanText(text) || l };
  const out = list.slice();
  out[i] = item;
  return { ok: true, list: out, item };
}

export function deleteReason(list, id) {
  list = list || [];
  if (!list.some(r => r.id === id)) return { ok: false, error: 'not_found' };
  return { ok: true, list: list.filter(r => r.id !== id) };
}

// dir -1 = up, +1 = down. Moving past either end changes nothing.
export function moveReason(list, id, dir) {
  list = list || [];
  const i = list.findIndex(r => r.id === id);
  if (i < 0) return { ok: false, error: 'not_found' };
  const j = i + (dir < 0 ? -1 : 1);
  const out = list.slice();
  if (j < 0 || j >= out.length) return { ok: true, list: out };
  [out[i], out[j]] = [out[j], out[i]];
  return { ok: true, list: out };
}

// The default reason must still exist; otherwise it is "none".
export function defaultReasonId(list, id) {
  return findReason(list, id) ? id : '';
}

// What a request carries: the chosen template (copied, so a later edit does not change old history) and the details.
export function chosenReason(list, id, details) {
  const r = findReason(list, id);
  const d = cleanDetails(details);
  if (!r && !d) return null;
  return { id: r ? r.id : '', label: r ? r.label : '', text: r ? r.text : '', details: d };
}

// The lines added to the email: "Reason: ..." and a "Details:" paragraph. '' when both are empty.
export function reasonBlock(choice) {
  if (!choice) return '';
  const parts = [];
  const text = cleanText(choice.text);
  const d = cleanDetails(choice.details);
  if (text) parts.push('Reason: ' + text);
  if (d) parts.push('Details:\n' + d);
  return parts.join('\n\n');
}

// Short words for the history row.
export function reasonSummary(choice) {
  if (!choice) return '';
  const d = cleanDetails(choice.details).replace(/\s+/g, ' ');
  if (choice.label && d) return choice.label + ' + details';
  if (choice.label) return choice.label;
  return d ? (d.length > 40 ? d.slice(0, 38).trim() + '\u2026' : d) : '';
}
