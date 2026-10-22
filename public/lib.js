// Shared helpers: DOM builder, API client, formatting, modal, toasts. No dependencies.
// Make replaceChildren tolerant: flatten arrays and skip null/false so conditional UI never prints "false" or "[object ...]".
const _rc = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...k) { _rc.apply(this, k.flat(Infinity).filter(x => x != null && x !== false)); };
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v; else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') el[k] = !!v;
    else if (k === 'html') throw new Error('html prop is not allowed'); else el.setAttribute(k, v === true ? '' : v);
  }
  const add = k => { if (k == null || k === false) return; if (Array.isArray(k)) return k.forEach(add); el.append(k.nodeType ? k : document.createTextNode(String(k))); };
  kids.forEach(add); return el;
}
export const $ = (s, r = document) => r.querySelector(s);
export function mount(node, ...kids) { node.replaceChildren(...kids.flat().filter(Boolean)); }

// ---------- formatting ----------
export function rupees(p) {
  if (p == null) return '-'; const neg = p < 0; p = Math.abs(p); const r = String(Math.floor(p / 100)), ps = String(p % 100).padStart(2, '0');
  const g = r.length <= 3 ? r : r.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + r.slice(-3); return (neg ? '-' : '') + '₹' + g + '.' + ps;
}
export function parseRupees(t) { const s = String(t ?? '').trim().replace(/,/g, ''); return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(parseFloat(s) * 100) : null; }
export const rupeesInput = p => (p == null ? '' : (p / 100).toFixed(p % 100 ? 2 : 0));
export const pct = bps => (bps / 100).toString().replace(/\.0+$/, '') + '%';
const IST = { timeZone: 'Asia/Kolkata' };
export const fmtDate = d => { if (!d) return '-'; const x = typeof d === 'number' ? new Date(d) : new Date(d + 'T00:00:00+05:30'); return x.toLocaleDateString('en-IN', { ...IST, day: '2-digit', month: 'short', year: 'numeric' }); };
export const fmtDT = ms => ms ? new Date(ms).toLocaleString('en-IN', { ...IST, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : '-';
export const todayIso = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
export const label = s => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const TONE = { ACTIVE: 'ok', CLOSED: 'info', PAID: 'ok', PASSED: 'ok', VERIFIED: 'ok', CONFIRMED: 'ok', POSTED: 'ok', APPROVED: 'ok', READY_FOR_DISBURSEMENT: 'ok', DISBURSED: 'ok',
  REJECTED_BY_ACCOUNTS: 'bad', REJECTED_BY_ADMIN: 'bad', REJECTED: 'bad', FAILED: 'bad', CANCELLED: 'bad', REVERSED: 'bad', REVERSAL: 'warn', INACTIVE: 'bad', MISMATCH: 'bad',
  ADDITIONAL_DOCUMENTS_REQUIRED: 'warn', SIGNED_DOCUMENT_PENDING: 'warn', REPLACEMENT_REQUESTED: 'warn', PARTIAL: 'warn', PENDING_DISBURSEMENT: 'warn', NOT_REACHABLE: 'warn', DRAFT: '', SUPERSEDED: '' };
export const pill = (s, text) => h('span', { class: 'pill ' + (TONE[s] ?? 'info') }, text || label(s));

// ---------- toasts / modal ----------
export function toast(msg, kind = '') { const t = h('div', { class: 'toast ' + kind, role: 'status' }, msg); $('#toasts').append(t); setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500); }
export function modal(title, body, { wide = false, onClose } = {}) {
  const bg = h('div', { class: 'modal-bg', onclick: e => { if (e.target === bg) close(); } });
  const close = () => { bg.remove(); document.removeEventListener('keydown', esc); onClose && onClose(); };
  const esc = e => { if (e.key === 'Escape') close(); }; document.addEventListener('keydown', esc);
  bg.append(h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'row between mb' }, h('h2', { style: 'margin:0' }, title), h('button', { class: 'ghost sm', onclick: close, 'aria-label': 'Close' }, '✕')), body));
  document.body.append(bg); return { close, el: bg };
}
export function askForm(title, fields, submitLabel = 'Confirm', danger = false) { // fields: [{name,label,type,required,options,hint}]
  return new Promise(resolve => {
    const inputs = {}; const err = h('div', { class: 'banner bad', hidden: true });
    const form = h('form', {}, err, fields.map(f => {
      const inp = f.type === 'textarea' ? h('textarea', { id: 'af_' + f.name, rows: 3 }) : f.type === 'select' ? h('select', { id: 'af_' + f.name }, f.options.map(o => h('option', { value: o[0] }, o[1])))
        : f.type === 'checkbox' ? h('input', { type: 'checkbox', id: 'af_' + f.name }) : h('input', { id: 'af_' + f.name, type: f.type || 'text', inputmode: f.inputmode, value: f.value ?? '' });
      if (f.value != null && f.type !== 'checkbox') inp.value = f.value; inputs[f.name] = inp;
      return h('div', { class: 'field' }, h('label', { for: 'af_' + f.name }, f.label, f.hint && h('span', { class: 'hint' }, ' ' + f.hint)), inp);
    }), h('div', { class: 'row' }, h('button', { class: danger ? 'danger' : 'primary', type: 'submit' }, submitLabel), h('button', { type: 'button', onclick: () => { resolve(null); m.close(); } }, 'Cancel')));
    form.addEventListener('submit', e => { e.preventDefault(); const out = {};
      for (const f of fields) { const v = f.type === 'checkbox' ? inputs[f.name].checked : inputs[f.name].value.trim(); if (f.required && (v === '' || v == null)) { err.hidden = false; err.textContent = `${f.label} is required.`; inputs[f.name].focus(); return; } out[f.name] = v; }
      resolve(out); m.close(); });
    const m = modal(title, form, { onClose: () => resolve(null) }); setTimeout(() => form.querySelector('input,textarea,select')?.focus(), 30);
  });
}
export const confirmBox = (title, text, ok = 'Confirm', danger = false) => new Promise(res => {
  const body = h('div', {}, h('p', {}, text), h('div', { class: 'row' }, h('button', { class: danger ? 'danger' : 'primary', onclick: () => { res(true); m.close(); } }, ok), h('button', { onclick: () => { res(false); m.close(); } }, 'Cancel')));
  const m = modal(title, body, { onClose: () => res(false) });
});

// ---------- API ----------
export class ApiErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
let onAuthLost = () => {}; export const setAuthLost = f => onAuthLost = f;
export async function api(method, path, body, headers = {}) {
  let r; try { r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hsfinance', ...headers }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
  catch { throw new ApiErr(0, 'Cannot reach the server. Check the connection and try again. Nothing was saved.'); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') onAuthLost();
  if (!r.ok) throw new ApiErr(r.status, data.error || 'Request failed.'); return data;
}
export const GET = (p, params) => api('GET', p + (params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')) : ''));
export const POST = (p, b) => api('POST', p, b || {}); export const PUT = (p, b) => api('PUT', p, b || {}); export const DEL = p => api('DELETE', p);
export async function run(btn, fn, okMsg) { // disables the button while working, shows errors as toasts, prevents double-clicks
  if (btn) btn.disabled = true; try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; } catch (e) { toast(e.message, 'bad'); return undefined; } finally { if (btn) btn.disabled = false; }
}

// ---------- files / camera ----------
export function readAsDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read the file.')); r.readAsDataURL(file); }); }
export async function prepareFile(file) { // downsizes phone photos; leaves PDFs alone; returns {mime,data,name,preview}
  if (!file) throw new Error('No file chosen.');
  if (file.type === 'application/pdf') { if (file.size > 8 * 1024 * 1024) throw new Error('PDF is larger than 8 MB.'); return { mime: file.type, data: await readAsDataUrl(file), name: file.name, preview: null }; }
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Use a JPG, PNG, WEBP image or a PDF.');
  const url = await readAsDataUrl(file); const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('This image cannot be read. Try retaking it.')); i.src = url; });
  const max = 1600, sc = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); const out = c.toDataURL('image/jpeg', 0.85); return { mime: 'image/jpeg', data: out, name: file.name || 'photo.jpg', preview: out };
}
export function filePicker(onFile, { camera = true, accept = 'image/*,application/pdf' } = {}) { // returns {buttons}
  const up = h('input', { type: 'file', accept, onchange: e => { const f = e.target.files[0]; e.target.value = ''; f && onFile(f); } });
  const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', onchange: e => { const f = e.target.files[0]; e.target.value = ''; f && onFile(f); } });
  return h('span', { class: 'row' }, up, cam, camera && h('button', { type: 'button', class: 'sm', onclick: () => cam.click() }, '📷 Take photo'), h('button', { type: 'button', class: 'sm', onclick: () => up.click() }, '⬆ Upload'));
}
export function viewDocument(doc) { // preview with zoom for images, embedded viewer for PDFs
  const src = `/api/documents/${doc.id}/file`; let body;
  if (doc.mime === 'application/pdf') body = h('iframe', { src, style: 'width:100%;height:70vh;border:0', title: doc.type });
  else { const img = h('img', { src, alt: doc.type, style: 'max-width:100%;transition:width .1s' }); let z = 1;
    const zoom = d => { z = Math.max(.5, Math.min(4, z + d)); img.style.maxWidth = 'none'; img.style.width = (z * 100) + '%'; };
    body = h('div', {}, h('div', { class: 'row mb' }, h('button', { class: 'sm', onclick: () => zoom(-.25) }, '− Zoom out'), h('button', { class: 'sm', onclick: () => zoom(.25) }, '+ Zoom in'), h('a', { class: 'btn sm', href: src, target: '_blank', rel: 'noopener' }, 'Open full size')), h('div', { class: 'viewer' }, img)); }
  modal(`${label(doc.type)} (v${doc.version})`, body, { wide: true });
}

// ---------- form helpers ----------
export function field(lbl, input, { hint, error, id } = {}) { return h('div', { class: 'field' }, h('label', { for: input.id || id }, lbl, hint && h('span', { class: 'hint' }, ' ' + hint)), input, error && h('div', { class: 'err' }, error)); }
export function table(cols, rows, { onRow, empty = 'Nothing to show.', foot } = {}) {
  if (!rows.length) return h('div', { class: 'empty card' }, empty);
  return h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: c.num ? 'num' : '' }, c.h)))),
    h('tbody', {}, rows.map(r => h('tr', { class: onRow ? 'click' : '', tabindex: onRow ? 0 : null, onclick: onRow && (() => onRow(r)), onkeydown: onRow && (e => { if (e.key === 'Enter') onRow(r); }) },
      cols.map(c => h('td', { class: c.num ? 'num' : '' }, c.f(r)))))), foot && h('tfoot', {}, foot)));
}
export const loading = () => h('div', { class: 'loading' }, h('span', { class: 'spinner' }), h('div', { class: 'muted small' }, 'Loading…'));
export const errorBox = e => h('div', { class: 'banner bad' }, e.message || String(e));
export function kv(pairs) { return h('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '-')])); }

// XHR upload so the screen can show real progress (fetch cannot report upload progress)
export function uploadJson(path, obj, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open('POST', path); x.setRequestHeader('content-type', 'application/json'); x.setRequestHeader('x-requested-with', 'hsfinance');
    x.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(Math.round(e.loaded / e.total * 100)); };
    x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch {} x.status >= 200 && x.status < 300 ? resolve(d) : reject(new ApiErr(x.status, d.error || 'Upload failed.')); };
    x.onerror = () => reject(new ApiErr(0, 'Upload failed: cannot reach the server. You can retry.')); x.send(JSON.stringify(obj));
  });
}
export function addDaysIso(iso, n) { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
