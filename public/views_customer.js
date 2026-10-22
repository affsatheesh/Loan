import { h, GET, rupees, fmtDate, fmtDT, pill, label, pct, table, kv, loading } from './lib.js';
import { tile, pageHead } from './views_common.js';

export async function home({ user }) {
  const [ls, as] = await Promise.all([GET('/api/loans'), GET('/api/applications')]);
  return h('div', {}, pageHead(`Hello, ${user.name}`, 'Your loan and application status'),
    ls.loans.length ? ls.loans.map(l => h('a', { class: 'rowcard', href: `#/loan/${l.id}` }, h('div', { class: 'row between' }, h('strong', {}, `Loan ${l.ref}`), pill(l.status)), h('div', { class: 'row small muted', style: 'gap:1rem' }, h('span', {}, 'Principal ' + rupees(l.principal)), l.outstandingTotal != null && h('span', {}, 'Outstanding ' + rupees(l.outstandingTotal)), l.nextDueDate && h('span', {}, `Next due ${fmtDate(l.nextDueDate)} (${rupees(l.nextDueAmount)})`), l.overdueAmount > 0 && h('span', { style: 'color:var(--bad);font-weight:600' }, 'Overdue ' + rupees(l.overdueAmount))))) : h('div', { class: 'card empty' }, 'You have no loans yet.'),
    as.applications.length > 0 && h('div', {}, h('h2', { class: 'mt' }, 'Applications'), as.applications.map(a => h('a', { class: 'rowcard', href: `#/application/${a.id}` }, h('div', { class: 'row between' }, h('strong', {}, a.ref), pill(a.status)), h('div', { class: 'muted small' }, `${rupees(a.amount)} · updated ${fmtDT(a.updatedAt)}`)))));
}
const FRIENDLY = { SUBMITTED_TO_ACCOUNTS: 'Application received', ACCOUNTS_VERIFICATION: 'Being verified', PENDING_ADMIN_REVIEW: 'Under review', ADDITIONAL_DOCUMENTS_REQUIRED: 'More documents needed', PHYSICAL_VERIFICATION: 'Verification visit', SIGNED_DOCUMENT_PENDING: 'Awaiting signed agreement', FINAL_ADMIN_REVIEW: 'Final review', APPROVED: 'Approved', READY_FOR_DISBURSEMENT: 'Approved, awaiting payout', DISBURSED: 'Loan paid out', REJECTED_BY_ACCOUNTS: 'Not approved', REJECTED_BY_ADMIN: 'Not approved', CANCELLED: 'Cancelled' };
export async function application({ params }) {
  const d = await GET('/api/applications/' + params[0]); const a = d.application;
  return h('div', {}, pageHead(`Application ${a.ref}`, `Requested ${rupees(a.amount)}`), h('div', { class: 'row mb' }, pill(a.status, FRIENDLY[a.status] || label(a.status))), d.loan && h('a', { class: 'btn primary mb', href: `#/loan/${d.loan.id}` }, 'View my loan'),
    h('div', { class: 'card' }, h('h2', {}, 'Progress'), h('ul', { class: 'tl' }, d.timeline.map(t => h('li', {}, h('strong', {}, FRIENDLY[t.to_status] || label(t.to_status)), h('span', { class: 'muted small' }, ' ' + fmtDT(t.at)))))));
}
