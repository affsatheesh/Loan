import { h, GET, POST, rupees, parseRupees, rupeesInput, fmtDate, fmtDT, todayIso, pill, label, pct, table, kv, toast, run, field, loading, errorBox, uid, prepareFile, filePicker, uploadJson, confirmBox, askForm, viewDocument, addDaysIso } from './lib.js';
import { tile, pageHead, appList } from './views_common.js';

const reload = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

export async function accountsDashboard({ user }) {
  const m = (await GET('/api/dashboard')).metrics;
  return h('div', {}, pageHead(`Welcome, ${user.name}`, 'Accounts verification'), h('div', { class: 'grid g3 mb' }, tile('Awaiting verification', m.awaiting, '#/queue', m.awaiting ? 'warn' : ''), tile('In progress', m.inProgress, '#/queue'), tile('Completed by me', m.completedByMe, '#/applications')), h('a', { class: 'btn primary', href: '#/queue' }, 'Open verification queue'));
}
export async function queue({ user }) {
  const d = await GET('/api/applications', { queue: user.role === 'ACCOUNTS' ? 'accounts' : 'admin' }); const need = user.role === 'ACCOUNTS' ? 'Applications awaiting Accounts verification' : 'Applications awaiting Admin action';
  return h('div', {}, pageHead(user.role === 'ACCOUNTS' ? 'Verification queue' : 'Review queue', need), appList(d.applications, 'Nothing is waiting. You are all caught up.'));
}

// ================= Application detail (all staff roles) =================
export async function application({ params, user }) {
  const id = params[0]; const d = await GET('/api/applications/' + id); const a = d.application, c = d.customer, docs = d.documents || []; const A = `/api/applications/${id}`; const isAdmin = user.role === 'ADMIN';
  const act = (btn, path, body, ok) => run(btn, () => POST(A + path, body || {}), ok).then(r => { if (r) reload(); return r; });
  const docRow = x => h('div', { class: 'docbox', style: x.status === 'SUPERSEDED' ? 'opacity:.55' : '' }, h('div', { class: 'thumb' }, x.mime.startsWith('image/') ? h('img', { src: `/api/documents/${x.id}/file`, alt: label(x.type), loading: 'lazy', style: 'width:64px;height:64px;object-fit:cover;border-radius:8px' }) : 'PDF'),
    h('div', { class: 'grow' }, h('strong', {}, label(x.type)), h('span', { class: 'muted small' }, ` v${x.version}`), h('div', { class: 'small muted' }, `${fmtDT(x.uploaded_at)} by ${x.uploaded_by_name || '-'}`), h('div', {}, pill(x.status)), x.comment && h('div', { class: 'small' }, 'Reviewer: ' + x.comment)),
    h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => viewDocument(x) }, 'View'),
      isAdmin && x.status !== 'SUPERSEDED' && ['PENDING_REVIEW', 'REJECTED', 'REPLACEMENT_REQUESTED', 'VERIFIED'].includes(x.status) && [
        x.status !== 'VERIFIED' && h('button', { class: 'sm', onclick: e => run(e.target, () => POST(`/api/documents/${x.id}/review`, { action: 'VERIFY' }), 'Document verified').then(reload) }, 'Verify'),
        h('button', { class: 'sm', onclick: async e => { const r = await askForm('Reject document', [{ name: 'comment', label: 'Reason', type: 'textarea', required: true }], 'Reject', true); if (r) run(e.target, () => POST(`/api/documents/${x.id}/review`, { action: 'REJECT', ...r }), 'Document rejected').then(reload); } }, 'Reject'),
        h('button', { class: 'sm', onclick: async e => { const r = await askForm('Request replacement', [{ name: 'comment', label: 'What is wrong / needed', type: 'textarea', required: true }], 'Request'); if (r) run(e.target, () => POST(`/api/documents/${x.id}/review`, { action: 'REQUEST_REPLACEMENT', ...r }), 'Replacement requested').then(reload); } }, 'Replace')]));

  // ----- action panels by role and status -----
  const panels = [];
  const upload = (type, title, hint) => { const st = h('div', { class: 'small muted' }, hint || ''); const picker = filePicker(async f => { try { const p = await prepareFile(f); st.textContent = 'Uploading… 0%'; await uploadJson(`${A}/documents`, { type, mime: p.mime, name: p.name, data: p.data, uploadKey: uid() }, pc => st.textContent = `Uploading… ${pc}%`); toast(title + ' uploaded', 'ok'); reload(); } catch (e) { st.textContent = e.message; toast(e.message, 'bad'); } });
    return h('div', { class: 'docbox' }, h('div', { class: 'grow' }, h('strong', {}, title), st), picker); };
  if (user.role === 'EMPLOYEE') {
    if (a.status === 'ADDITIONAL_DOCUMENTS_REQUIRED') panels.push(h('div', { class: 'card' }, h('h2', {}, 'Additional documents required'), h('div', { class: 'banner warn' }, d.timeline.filter(t => t.to_status === 'ADDITIONAL_DOCUMENTS_REQUIRED').slice(-1)[0]?.comment || 'See reviewer comments.'),
      upload('ADDITIONAL', 'Add a requested document', 'Photo or scan'), h('p', { class: 'small muted' }, 'To replace a rejected document, upload a new one of the same type below. The old version is kept in history.'),
      h('div', { class: 'row' }, ...[...new Set(docs.filter(x => ['REJECTED', 'REPLACEMENT_REQUESTED'].includes(x.status)).map(x => x.type))].map(t => upload(t, 'Replace ' + label(t)))),
      h('button', { class: 'primary mt', onclick: async e => { const r = await askForm('Send documents back for review', [{ name: 'comment', label: 'Note (optional)', type: 'textarea' }], 'Resubmit'); if (r) act(e.target, '/resubmit', r, 'Resubmitted for review'); } }, 'Resubmit for review')));
    if (a.status === 'SIGNED_DOCUMENT_PENDING') panels.push(h('div', { class: 'card' }, h('h2', {}, 'Signed agreement required'), h('p', {}, '1. Print the application package. 2. Customer signs. 3. Photograph or scan it and upload.'), h('a', { class: 'btn', href: `#/print/package/${id}` }, 'Print application package'),
      upload('SIGNED_AGREEMENT', 'Signed agreement (photo or scan)'), h('button', { class: 'primary', onclick: e => act(e.target, '/signed-submit', {}, 'Sent to Admin for final review') }, 'Send to Admin')));
    if (['SUBMITTED_TO_ACCOUNTS', 'ADDITIONAL_DOCUMENTS_REQUIRED'].includes(a.status)) panels.push(h('button', { class: 'danger sm', onclick: async e => { const r = await askForm('Cancel application', [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }], 'Cancel application', true); if (r) act(e.target, '/cancel', r, 'Application cancelled'); } }, 'Cancel application'));
  }
  if (user.role === 'ACCOUNTS') {
    if (a.status === 'SUBMITTED_TO_ACCOUNTS') panels.push(h('div', { class: 'card' }, h('button', { class: 'primary', onclick: e => act(e.target, '/accounts/start', {}, 'Verification started') }, 'Start verification')));
    if (a.status === 'ACCOUNTS_VERIFICATION') { const calls = d.verifications.filter(v => v.kind === 'CALL');
      panels.push(h('div', { class: 'card' }, h('h2', {}, 'Call verification'), calls.length ? calls.map(v => h('div', { class: 'small', style: 'margin-bottom:.4rem' }, pill(v.outcome), ` ${fmtDT(v.at)} by ${v.verifier_name}: ${v.comment}`)) : h('p', { class: 'muted' }, `No call recorded yet. Call the customer on ${c.mobile}.`),
        h('button', { onclick: async e => { const r = await askForm('Record call', [{ name: 'outcome', label: 'Result', type: 'select', options: [['CONFIRMED', 'Details confirmed'], ['NOT_REACHABLE', 'Not reachable'], ['MISMATCH', 'Details do not match']] }, { name: 'comment', label: 'Call notes', type: 'textarea', required: true }], 'Save call'); if (r) act(e.target, '/accounts/call', r, 'Call recorded'); } }, 'Record call')),
        h('div', { class: 'card' }, h('h2', {}, 'Decision'), h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: async e => { const r = await askForm('Approve Accounts stage', [{ name: 'comment', label: 'Comments (optional)', type: 'textarea' }], 'Approve and forward to Admin'); if (r) act(e.target, '/accounts/decision', { decision: 'APPROVE', ...r }, 'Forwarded to Admin'); } }, 'Approve and forward'),
          h('button', { onclick: async e => { const r = await askForm('Request additional information', [{ name: 'comment', label: 'What is needed?', type: 'textarea', required: true }], 'Request'); if (r) act(e.target, '/accounts/decision', { decision: 'REQUEST_INFO', ...r }, 'Employee notified'); } }, 'Request information'),
          h('button', { class: 'danger', onclick: async e => { const r = await askForm('Reject application', [{ name: 'comment', label: 'Reason', type: 'textarea', required: true }], 'Reject', true); if (r) act(e.target, '/accounts/decision', { decision: 'REJECT', ...r }, 'Application rejected'); } }, 'Reject')))); }
  }
  if (isAdmin) {
    const pend = docs.filter(x => ['PENDING_REVIEW', 'REJECTED', 'REPLACEMENT_REQUESTED'].includes(x.status)).length;
    if (a.status === 'PENDING_ADMIN_REVIEW') panels.push(h('div', { class: 'card' }, h('h2', {}, 'Stage A: Document review'), h('p', { class: 'muted' }, pend ? `${pend} document(s) still need your review (verify, reject or request replacement above).` : 'All documents are verified.'),
      h('div', { class: 'row' }, !a.docReviewDone ? h('button', { class: 'primary', disabled: !!pend, onclick: e => act(e.target, '/admin/doc-review', {}, 'Document review complete') }, 'Mark document review complete') : h('span', {}, pill('VERIFIED', 'Document review complete')),
        a.docReviewDone && h('button', { class: 'primary', onclick: e => act(e.target, '/admin/start-physical', {}, 'Physical verification started') }, 'Start physical verification'),
        h('button', { onclick: async e => { const r = await askForm('Request additional documents', [{ name: 'note', label: 'Documents required', type: 'textarea', required: true }], 'Request'); if (r) act(e.target, '/admin/request-documents', r, 'Employee notified'); } }, 'Request documents'),
        h('button', { class: 'danger', onclick: async e => { const r = await askForm('Reject application', [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }], 'Reject', true); if (r) act(e.target, '/admin/reject', r, 'Application rejected'); } }, 'Reject'))));
    if (a.status === 'PHYSICAL_VERIFICATION') panels.push(physicalPanel(a, d, upload, act));
    if (a.status === 'FINAL_ADMIN_REVIEW') panels.push(finalPanel(a, d, act));
    if (a.status === 'READY_FOR_DISBURSEMENT') panels.push(h('div', { class: 'card' }, h('h2', {}, 'Disburse loan'), d.loan && h('p', {}, `Loan ${d.loan.ref} is approved and all conditions are satisfied. Record the payout once the money has actually been paid.`),
      h('button', { class: 'primary', onclick: async e => { const r = await askForm('Record disbursement', [{ name: 'method', label: 'Paid out by', type: 'select', options: [['BANK_TRANSFER', 'Bank transfer'], ['CASH', 'Cash'], ['UPI', 'UPI'], ['OTHER', 'Other']] }, { name: 'reference', label: 'Transfer reference', hint: 'required unless cash' }], 'Mark as disbursed'); if (r) act(e.target, '/admin/disburse', r, 'Loan is now active'); } }, 'Record disbursement')));
    if (!['DRAFT', 'REJECTED_BY_ACCOUNTS', 'REJECTED_BY_ADMIN', 'CANCELLED', 'DISBURSED'].includes(a.status)) panels.push(h('div', {}, h('button', { class: 'danger sm', onclick: async e => { const r = await askForm('Cancel application', [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }], 'Cancel application', true); if (r) act(e.target, '/cancel', r, 'Application cancelled'); } }, 'Cancel application')));
  }
  const eligView = a.eligibility && h('div', { class: 'card' }, h('h2', {}, 'Preliminary eligibility ', a.eligibility.evaluated ? pill(a.eligibility.eligible ? 'PASSED' : 'FAILED', a.eligibility.eligible ? 'Passed' : 'Failed') : pill('NOT_REACHABLE', 'Not evaluated')), h('div', { class: 'small muted' }, `Preliminary until all approvals complete. Rule version used: ${a.ruleVersion ?? 'none'}`),
    h('ul', { class: 'small' }, a.eligibility.checks.map(x => h('li', {}, (x.passed ? '✓ ' : '✗ ') + x.name + ': ' + x.detail))));
  const phys = d.verifications.filter(v => v.kind === 'PHYSICAL');
  return h('div', {}, pageHead(`Application ${a.ref}`, `${c.name} · ${c.ref}`, h('a', { class: 'btn', href: `#/print/package/${id}` }, 'Print package'), d.loan && user.role !== 'ACCOUNTS' && h('a', { class: 'btn primary', href: `#/loan/${d.loan.id}` }, 'Open loan ' + d.loan.ref)),
    h('div', { class: 'row mb' }, pill(a.status), a.status === 'ADDITIONAL_DOCUMENTS_REQUIRED' && h('span', { class: 'muted small' }, 'Waiting for employee')), ...panels,
    h('div', { class: 'grid g2' }, h('div', { class: 'card' }, h('h2', {}, 'Customer'), kv([['Name', c.name], ['Date of birth', fmtDate(c.dob)], ['Mobile', h('span', {}, c.mobile, ' ', pill('VERIFIED', c.mobileVerifiedAt ? 'OTP verified' : 'Not verified'))], ['Address', c.address], ['Occupation', c.occupation], ['Monthly income', rupees(c.income)], ['Family', `${c.adults} adults, ${c.children} children`], ['Voter ID', c.voter], c.pan && ['PAN', c.pan], c.aadhaar && ['Aadhaar', c.aadhaar]])),
      h('div', { class: 'card' }, h('h2', {}, 'Loan request'), kv([['Employee', `${a.employeeName} (${a.employeeCode || ''})`], ['Product', d.product?.name], ['Requested', rupees(a.amount)], ['Instalments', `${a.term} ${label(a.frequency).toLowerCase()}`], d.product && ['Provisional terms', `${pct(d.product.rate_bps)} ${d.product.rate_period === 'ANNUAL' ? 'per year' : 'per month'}, ${label(d.product.method)}; fee ${pct(d.product.fee_bps)}`], ['Bank', `${a.bank.holder}, ${a.bank.bankName}`], ['Account', a.bank.account], ['IFSC', a.bank.ifsc], ['Account ownership', 'Not independently verified']])),
    ), eligView,
    h('div', { class: 'card' }, h('h2', {}, `Documents (${docs.filter(x => x.status !== 'SUPERSEDED').length})`), docs.length ? docs.map(docRow) : h('div', { class: 'muted' }, 'No documents.')),
    d.verifications.length > 0 && h('div', { class: 'card' }, h('h2', {}, 'Verifications'), d.verifications.map(v => h('div', { style: 'margin-bottom:.7rem' }, h('div', {}, pill(v.outcome), ` ${label(v.kind)} verification · ${fmtDT(v.at)} · ${v.verifier_name}`), h('div', { class: 'small' }, v.comment),
      v.kind === 'PHYSICAL' && h('div', { class: 'small muted' }, v.lat != null ? `Location captured: ${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}${v.accuracy ? ` (±${Math.round(v.accuracy)} m, device-reported, not independently verified)` : ''}` : `Location unavailable: ${v.location_note}`)))),
    h('div', { class: 'card' }, h('h2', {}, 'Timeline'), h('ul', { class: 'tl' }, d.timeline.map(t => h('li', {}, h('strong', {}, label(t.to_status)), h('span', { class: 'muted small' }, ` ${fmtDT(t.at)} · ${t.user_name || ''}`), t.comment && h('div', { class: 'small' }, t.comment))))));
}

function physicalPanel(a, d, upload, act) {
  const items = [['identity', 'Customer identity checked'], ['details', 'Name and basic details matched'], ['address', 'Address checked'], ['documents', 'Required documents inspected'], ['photo', 'Customer / employee photograph captured']];
  const chk = {}; const geo = { lat: null, lng: null, accuracy: null }; const geoMsg = h('div', { class: 'small muted' }, 'Location not captured yet.'); const note = h('input', { id: 'locnote', placeholder: 'Reason location is unavailable' });
  const comment = h('textarea', { id: 'physc' }); const outcome = h('select', { id: 'physo' }, h('option', { value: 'PASSED' }, 'Passed'), h('option', { value: 'FAILED' }, 'Failed'));
  const getLoc = () => { if (!navigator.geolocation) { geoMsg.textContent = 'This device cannot provide location. Record the reason below.'; return; } geoMsg.textContent = 'Requesting location…';
    navigator.geolocation.getCurrentPosition(p => { geo.lat = p.coords.latitude; geo.lng = p.coords.longitude; geo.accuracy = p.coords.accuracy; geoMsg.textContent = `Captured ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)} (±${Math.round(geo.accuracy)} m). Reported by the device; not independently verified.`; }, e => { geoMsg.textContent = 'Location unavailable (' + e.message + '). Record the reason below; coordinates are never invented.'; }, { enableHighAccuracy: true, timeout: 15000 }); };
  return h('div', { class: 'card' }, h('h2', {}, 'Stage B: Physical verification'), h('div', { class: 'banner info' }, 'Get the customer’s consent before photographing them or capturing location.'),
    items.map(([k, t]) => h('label', { style: 'display:flex;gap:.5rem;font-weight:400;margin-bottom:.35rem' }, h('input', { type: 'checkbox', onchange: e => { chk[k] = e.target.checked; } }), t)),
    upload('FIELD_VERIFICATION_PHOTO', 'Field verification photograph', 'Take a photo with the customer present'), h('div', { class: 'row mb' }, h('button', { type: 'button', onclick: getLoc }, '📍 Capture location'), geoMsg),
    field('If location is unavailable, reason', note), field('Outcome', outcome), field('Comments *', comment),
    h('button', { class: 'primary', onclick: e => act(e.target, '/admin/physical', { outcome: outcome.value, checklist: chk, comment: comment.value, lat: geo.lat ?? undefined, lng: geo.lng ?? undefined, accuracy: geo.accuracy ?? undefined, locationNote: note.value }, 'Verification recorded') }, 'Record verification'));
}

function finalPanel(a, d, act) {
  const signed = (d.documents || []).find(x => x.type === 'SIGNED_AGREEMENT' && x.status !== 'SUPERSEDED'); const p = d.product;
  const principal = h('input', { id: 'ap_p', value: rupeesInput(a.amount), inputmode: 'decimal' }); const due = h('input', { id: 'ap_d', type: 'date', value: addDaysIso(todayIso(), 30), min: addDaysIso(todayIso(), 1) }); const over = h('textarea', { id: 'ap_o', rows: 2 });
  const needsOverride = !a.eligibility || !a.eligibility.eligible;
  return h('div', { class: 'card' }, h('h2', {}, 'Stage E: Final decision'), signed ? h('div', { class: 'row mb' }, pill(signed.status), h('button', { class: 'sm', onclick: () => viewDocument(signed) }, 'Inspect signed agreement')) : h('div', { class: 'banner warn' }, 'No signed agreement.'),
    p && h('div', { class: 'banner info' }, `Terms to be fixed on approval: ${pct(p.rate_bps)} ${p.rate_period === 'ANNUAL' ? 'per year' : 'per month'}, ${label(p.method)}, ${a.term} ${label(a.frequency).toLowerCase()} instalments, processing fee ${pct(p.fee_bps)} (deducted at disbursement). Later product changes will not alter this loan.`),
    h('div', { class: 'grid g2' }, field('Approved principal (₹)', principal, { hint: `requested ${rupees(a.amount)}; cannot be higher` }), field('First instalment date', due)), needsOverride && field('Eligibility override reason (required: preliminary eligibility not satisfied)', over),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async e => { const pr = parseRupees(principal.value); if (!pr) return toast('Enter a valid principal.', 'bad'); if (await confirmBox('Approve loan', `Approve ${rupees(pr)} with first instalment on ${fmtDate(due.value)}? Terms will be locked.`, 'Approve')) act(e.target, '/admin/approve', { principal: pr, firstDueDate: due.value, overrideReason: over.value }, 'Loan approved'); } }, 'Approve loan'),
      h('button', { onclick: async e => { const r = await askForm('Return signed document', [{ name: 'reason', label: 'Reason (e.g. unclear, unsigned)', type: 'textarea', required: true }], 'Return'); if (r) act(e.target, '/admin/return-signed', r, 'Employee asked to re-upload'); } }, 'Reject signed document'),
      h('button', { class: 'danger', onclick: async e => { const r = await askForm('Reject application', [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }], 'Reject', true); if (r) act(e.target, '/admin/reject', r, 'Application rejected'); } }, 'Reject application')));
}
