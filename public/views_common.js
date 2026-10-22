import { h, GET, POST, PUT, rupees, fmtDate, fmtDT, pill, label, table, kv, toast, run, field, askForm, confirmBox, pct, loading, errorBox, todayIso, rupeesInput, parseRupees } from './lib.js';

export const tile = (l, v, href, tone = '') => h(href ? 'a' : 'div', { class: 'tile ' + tone, href }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
export const pageHead = (title, sub, ...actions) => h('div', { class: 'row between mb' }, h('div', {}, h('h1', {}, title), sub && h('div', { class: 'muted' }, sub)), h('div', { class: 'row noprint' }, actions));

export function appList(apps, empty = 'No applications.') {
  return table([{ h: 'Application', f: a => h('div', {}, h('strong', {}, a.ref || 'Draft'), h('div', { class: 'muted small' }, a.customerName || '-')) }, { h: 'Amount', num: true, f: a => rupees(a.amount) },
    { h: 'Status', f: a => pill(a.status) }, { h: 'Employee', f: a => a.employeeName || '-' }, { h: 'Docs', f: a => a.pendingDocs ? `${a.pendingDocs} to review` : a.docs }, { h: 'Updated', f: a => fmtDT(a.updatedAt) }],
    apps, { onRow: a => { location.hash = a.status === 'DRAFT' ? `#/add/${a.id}` : `#/application/${a.id}`; }, empty });
}
export async function applications({ user, query }) {
  const status = query.status || ''; const d = await GET('/api/applications', { status, draft: user.role === 'EMPLOYEE' ? 'all' : undefined });
  const statuses = [...new Set(d.applications.map(a => a.status))];
  const sel = h('select', { 'aria-label': 'Filter by status', onchange: e => { location.hash = '#/applications' + (e.target.value ? '?status=' + e.target.value : ''); } }, h('option', { value: '' }, 'All statuses'),
    ['DRAFT', 'SUBMITTED_TO_ACCOUNTS', 'ACCOUNTS_VERIFICATION', 'ADDITIONAL_DOCUMENTS_REQUIRED', 'PENDING_ADMIN_REVIEW', 'PHYSICAL_VERIFICATION', 'SIGNED_DOCUMENT_PENDING', 'FINAL_ADMIN_REVIEW', 'READY_FOR_DISBURSEMENT', 'DISBURSED', 'REJECTED_BY_ACCOUNTS', 'REJECTED_BY_ADMIN', 'CANCELLED'].map(s => h('option', { value: s, selected: s === status }, label(s))));
  return h('div', {}, pageHead('Applications', `${d.applications.length} shown`, user.role === 'EMPLOYEE' && h('a', { class: 'btn primary', href: '#/add' }, '+ Add customer')), h('div', { class: 'mb', style: 'max-width:300px' }, sel), appList(d.applications));
}

// ---------- loan detail ----------
export async function loan({ params, user }) {
  const d = await GET('/api/loans/' + params[0]); const L = d.loan, s = d.summary, staff = user.role !== 'CUSTOMER';
  const rate = `${pct(L.rate_bps)} ${L.rate_period === 'ANNUAL' ? 'per year' : 'per month'}, ${L.method === 'FLAT' ? 'flat' : 'reducing balance'}`;
  const reload = () => { location.hash = location.hash; window.dispatchEvent(new HashChangeEvent('hashchange')); };
  const actions = [];
  if (L.status === 'ACTIVE' && staff && user.role !== 'CUSTOMER') actions.push(h('a', { class: 'btn primary', href: `#/collect/${L.id}` }, 'Collect payment'));
  const od = s.overdueInstalments?.length ? h('div', { class: 'banner warn' }, h('strong', {}, `${rupees(s.overdueAmount)} overdue`), s.overdueInstalments.map(o => h('div', { class: 'small' }, `Instalment ${o.number} (due ${fmtDate(o.dueDate)}): ${o.daysOverdue} days late, ${rupees(o.outstanding)} due. ${o.explain}`))) : null;
  return h('div', {}, pageHead(`Loan ${L.ref}`, d.customer.name + (staff ? ` · ${d.customer.ref}` : ''), ...actions), od,
    h('div', { class: 'grid g4 mb' }, tile('Status', pill(L.status)), tile('Principal', rupees(L.principal)), tile('Outstanding principal', rupees(s.outstandingPrincipal)), tile('Total outstanding', rupees(s.outstandingTotal)),
      tile('Next due', s.nextDueDate ? `${fmtDate(s.nextDueDate)}` : '-'), tile('Next amount', rupees(s.nextDueAmount)), tile('Overdue', rupees(s.overdueAmount), null, s.overdueAmount ? 'bad' : ''), tile('Total paid', rupees(s.totalPaid))),
    h('div', { class: 'card' }, h('h2', {}, 'Approved terms (fixed at approval)'), kv([['Interest', rate], ['Term', `${L.term} ${label(L.frequency).toLowerCase()} instalments`], ['Processing fee', `${pct(L.fee_bps)} = ${rupees(L.fee_amount)} (deducted at disbursement)`],
      ['Penalty policy', L.penaltyTerms.enabled ? `${L.penaltyTerms.type === 'FIXED' ? rupees(L.penaltyTerms.value) + ' fixed' : pct(L.penaltyTerms.value) + ' of unpaid'}, grace ${L.penaltyTerms.graceDays} days${L.penaltyTerms.capPaise != null ? ', cap ' + rupees(L.penaltyTerms.capPaise) : ''}` : 'None'],
      ['Approved on', fmtDT(L.approved_at)], ['Disbursed', L.disbursed_at ? `${fmtDT(L.disbursed_at)} via ${label(L.disbursed_method)}` : 'Not yet'], L.closed_at && ['Closed', `${fmtDT(L.closed_at)} (${L.closed_by})`], staff && L.followup_status !== 'NONE' && ['Follow-up', `${label(L.followup_status)}${L.followup_note ? ': ' + L.followup_note : ''}`]])),
    L.status !== 'PENDING_DISBURSEMENT' && h('div', {}, h('h2', {}, 'Repayment schedule'), table([{ h: '#', f: i => i.number }, { h: 'Due', f: i => fmtDate(i.due_date) }, { h: 'Principal', num: true, f: i => rupees(i.principal) }, { h: 'Interest', num: true, f: i => rupees(i.interest) },
      { h: 'Penalty', num: true, f: i => rupees(i.penalty - i.penalty_waived) }, { h: 'Paid', num: true, f: i => rupees(i.principal_paid + i.interest_paid + i.fees_paid + i.penalty_paid) }, { h: 'Remaining', num: true, f: i => rupees(i.outstanding) },
      { h: 'Status', f: i => pill(i.status) }, user.role === 'ADMIN' && { h: '', f: i => i.penalty - i.penalty_paid - i.penalty_waived > 0 ? h('button', { class: 'sm', onclick: async e => { const r = await askForm('Waive penalty', [{ name: 'reason', label: 'Reason for waiver', type: 'textarea', required: true }], 'Waive penalty', true); if (r && await run(e.target, () => POST(`/api/instalments/${i.id}/waive-penalty`, r), 'Penalty waived')) reload(); } }, 'Waive penalty') : '' }].filter(Boolean), d.instalments)),
    staff && L.status === 'ACTIVE' && s.overdueAmount > 0 && h('div', { class: 'card mt' }, h('button', { onclick: async () => { const r = await askForm('Follow-up', [{ name: 'status', label: 'Status', type: 'select', options: ['CALLED', 'PROMISED', 'VISITED', 'ESCALATED', 'RESOLVED', 'NONE'].map(x => [x, label(x)]) }, { name: 'note', label: 'Note' }], 'Save'); if (r && await run(null, () => POST(`/api/loans/${L.id}/followup`, r), 'Follow-up saved')) reload(); } }, 'Update follow-up status')),
    h('h2', { class: 'mt' }, 'Payments'), paymentsTable(d.payments.map(p => ({ ...p, loan_ref: L.ref, customer_name: d.customer.name, by_name: p.by_name })), user, reload));
}
function paymentsTable(rows, user, reload) {
  const cols = [{ h: 'Receipt', f: p => h('a', { href: `#/receipt/${p.id}` }, p.receipt_no) }, { h: 'Date', f: p => fmtDT(p.collected_at) }, { h: 'Customer', f: p => h('div', {}, p.customer_name, h('div', { class: 'muted small' }, p.loan_ref)) },
    { h: 'Amount', num: true, f: p => rupees(p.amount) }, { h: 'Method', f: p => label(p.method) }, user.role !== 'CUSTOMER' && { h: 'Recorded by', f: p => p.by_name || '-' }, { h: 'Status', f: p => pill(p.status) }].filter(Boolean);
  if (user.role === 'ADMIN') cols.push({ h: '', f: p => p.status === 'POSTED' ? h('button', { class: 'sm', onclick: async e => { const r = await askForm('Reverse payment ' + p.receipt_no, [{ name: 'reason', label: 'Reason (kept in the audit trail)', type: 'textarea', required: true }], 'Reverse payment', true); if (r && await run(e.target, () => POST(`/api/payments/${p.id}/reverse`, r), 'Payment reversed')) { reload ? reload() : window.dispatchEvent(new HashChangeEvent('hashchange')); } } }, 'Reverse') : (p.reason ? h('span', { class: 'muted small' }, p.reason) : '') });
  return table(cols, rows, { empty: 'No payments recorded yet.' });
}
export async function payments({ user }) {
  const from = h('input', { type: 'date', 'aria-label': 'From' }), to = h('input', { type: 'date', 'aria-label': 'To' }); const out = h('div', {});
  const load = async () => { out.replaceChildren(loading()); try { const d = await GET('/api/payments', { from: from.value, to: to.value }); const net = d.payments.filter(p => p.status === 'POSTED').reduce((a, p) => a + p.amount, 0);
    out.replaceChildren(h('div', { class: 'muted mb' }, `${d.payments.length} entries · posted total ${rupees(net)} (reversed payments excluded)`), paymentsTable(d.payments, user, load)); } catch (e) { out.replaceChildren(errorBox(e)); } };
  from.onchange = to.onchange = load; load();
  return h('div', {}, pageHead(user.role === 'CUSTOMER' ? 'My payments' : 'Payment history'), h('div', { class: 'row mb' }, h('label', { style: 'margin:0' }, 'From'), from, h('label', { style: 'margin:0' }, 'To'), to), out);
}
export async function receipt({ params }) {
  const r = await GET('/api/payments/' + params[0]); const p = r.payment, rev = p.status === 'REVERSAL';
  return h('div', {}, pageHead('Receipt', null, h('button', { class: 'primary', onclick: () => window.print() }, 'Print / save as PDF'), h('button', { onclick: () => history.back() }, 'Back')),
    h('div', { class: 'receipt' }, h('h2', { style: 'text-align:center;margin:0' }, r.business), h('div', { style: 'text-align:center;color:#555;font-size:.85rem' }, rev ? 'PAYMENT REVERSAL' : 'PAYMENT RECEIPT'), h('hr'),
      kv([['Receipt no.', p.receipt_no], ['Date & time', fmtDT(p.collected_at)], ['Customer', `${r.customer.name} (${r.customer.ref})`], ['Loan', r.loan.ref], ['Amount', h('strong', {}, rupees(p.amount))], ['Method', label(p.method)], p.reference && ['Reference', p.reference],
        ['Status', label(p.status)], r.recordedBy && ['Recorded by', `${r.recordedBy.name} (${r.recordedBy.code || ''})`], p.reason && ['Reason', p.reason], p.remarks && ['Remarks', p.remarks]]),
      h('h3', { class: 'mt' }, 'Allocation'), h('table', {}, h('tbody', {}, ['principal', 'interest', 'fees', 'penalty'].map(k => h('tr', {}, h('td', {}, label(k)), h('td', { class: 'num' }, rupees(r.totals[k])))))),
      h('p', { style: 'font-weight:600' }, `Balance outstanding after this entry: ${rupees(r.balanceAfter)}`), r.note && h('p', { class: 'small', style: 'color:#555' }, r.note), h('p', { class: 'small', style: 'color:#555' }, 'Computer generated receipt.')));
}

// ---------- printable application package ----------
export async function printPackage({ params }) {
  const p = await GET(`/api/applications/${params[0]}/package`); const a = p.application, c = p.customer, t = p.terms;
  return h('div', {}, h('div', { class: 'row mb noprint' }, h('button', { class: 'primary', onclick: () => window.print() }, 'Print / save as PDF'), h('button', { onclick: () => history.back() }, 'Back'),
    h('span', { class: 'muted small' }, 'Use your browser print dialog; choose "Save as PDF" to share a file.')),
    h('div', { class: 'paper' }, h('div', { class: 'row between' }, h('h1', { style: 'margin:0' }, p.business), h('div', { class: 'small' }, 'Loan application package')),
      h('p', { class: 'small' }, `Application ${a.ref} · generated ${fmtDT(p.generatedAt)} by ${p.generatedBy} · Status: ${label(a.status)}`),
      h('div', { class: 'banner', style: 'border:1px solid #999;color:#000;background:#fff' }, 'This is an application document, not a signed agreement. It becomes binding only after the customer signs and the loan is approved.'),
      h('h2', {}, 'Customer'), kv([['Name', c.name], ['Customer ref', c.ref], ['Date of birth', fmtDate(c.dob)], ['Mobile', `${c.mobile} (OTP verified ${fmtDT(c.mobileVerifiedAt)})`], ['Address', c.address], ['Occupation', c.occupation], ['Monthly income', rupees(c.income)], ['Family', `${c.adults} adults, ${c.children} children`], ['Voter ID', c.voter], c.pan && ['PAN', c.pan], c.aadhaar && ['Aadhaar', c.aadhaar]]),
      h('h2', { class: 'mt' }, 'Bank details'), kv([['Account holder', a.bank?.holder], ['Bank', a.bank?.bankName], ['Account number', a.bank?.account], ['IFSC', a.bank?.ifsc]]),
      h('h2', { class: 'mt' }, t?.provisional ? 'Loan request (provisional terms)' : 'Approved loan terms'),
      t && kv([[t.provisional ? 'Requested amount' : 'Approved principal', rupees(t.principal)], ['Interest', t.ratePeriod ? `${pct(t.rateBps)} ${t.ratePeriod === 'ANNUAL' ? 'per year' : 'per month'}, ${t.method === 'FLAT' ? 'flat' : 'reducing balance'}` : 'To be set by Admin'], ['Term', `${t.term} ${label(t.frequency).toLowerCase()} instalments`], ['Processing fee', `${pct(t.feeBps)} = ${rupees(t.feeAmount)}`],
        t.provisional && ['Note', 'Provisional until Admin approval']]),
      h('h2', { class: 'mt' }, 'Document checklist'), h('table', {}, h('tbody', {}, p.checklist.map(x => h('tr', {}, h('td', {}, x.label), h('td', {}, x.present ? '☑ Received' : '☐ Not received'))))),
      h('div', { class: 'sig' }, h('div', {}, 'Customer signature / thumb impression', h('br'), 'Date: ____ / ____ / ________'), h('div', {}, 'Authorised signatory, HS Small Finance', h('br'), 'Date: ____ / ____ / ________')),
      h('div', { class: 'small', style: 'text-align:center;margin-top:1.5rem' }, `${a.ref} · Page 1 of 1`)));
}

// ---------- notifications & profile ----------
export async function notifications({ state, go }) {
  const d = await GET('/api/notifications'); const link = n => n.entity === 'application' ? `#/application/${n.entity_id}` : n.entity === 'loan' ? `#/loan/${n.entity_id}` : n.entity === 'payment' ? `#/receipt/${n.entity_id}` : null;
  return h('div', {}, pageHead('Notifications', `${d.unread} unread`, d.unread > 0 && h('button', { onclick: async () => { await POST('/api/notifications/read', {}); state.unread = 0; window.dispatchEvent(new HashChangeEvent('hashchange')); } }, 'Mark all read')),
    d.notifications.length ? d.notifications.map(n => { const href = link(n); return h(href ? 'a' : 'div', { class: 'rowcard', href, style: n.read ? 'opacity:.7' : 'border-left:4px solid var(--brand)', onclick: async () => { if (!n.read) { await POST('/api/notifications/read', { id: n.id }); state.unread = Math.max(0, state.unread - 1); } } },
      h('div', { class: 'row between' }, h('strong', {}, n.title), h('span', { class: 'muted small' }, fmtDT(n.created_at))), h('div', { class: 'muted' }, n.body)); }) : h('div', { class: 'card empty' }, 'No notifications yet.'));
}
export async function profile({ user, logout }) {
  const me = (await GET('/api/me')).user; const email = h('input', { value: me.email || '', type: 'email', id: 'pe' }), mobile = h('input', { value: me.mobile || '', inputmode: 'numeric', id: 'pm' });
  const pw = async () => { const r = await askForm('Change password', [{ name: 'current', label: 'Current password', type: 'password', required: true }, { name: 'password', label: 'New password', type: 'password', required: true, hint: '8+ characters, letters and numbers' }], 'Change password'); if (r) { try { await POST('/api/change-password', r); toast('Password changed. Please log in again.', 'ok'); await logout(); } catch (e) { toast(e.message, 'bad'); } } };
  return h('div', {}, pageHead('My profile'), h('div', { class: 'card' }, kv([['Name', me.name], [me.role === 'ADMIN' ? 'Admin ID' : me.role === 'EMPLOYEE' ? 'Employee ID' : 'ID', me.code], ['Username', me.username], ['Role', label(me.role)], ['Account status', pill(me.status)]])),
    h('div', { class: 'card' }, h('h2', {}, 'Contact details'), field('Mobile number', mobile), field('Email (optional)', email), h('button', { class: 'primary', onclick: e => run(e.target, () => PUT('/api/me', { mobile: mobile.value, email: email.value }), 'Profile updated') }, 'Save')),
    h('div', { class: 'row' }, h('button', { onclick: pw }, 'Change password'), h('button', { class: 'danger', onclick: logout }, 'Log out')));
}
