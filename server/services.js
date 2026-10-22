'use strict';
const D = require('./domain');
const { q, tx, nextRef, audit, notify, notifyRole } = require('./db');
const { bad, forbidden, notFound, conflict } = require('./http');

const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // IST calendar date
const istDay = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);

// ---------- access control ----------
function canSeeApp(u, a) {
  if (!a) return false;
  if (u.role === 'ADMIN') return true;
  if (u.role === 'ACCOUNTS') return a.status !== 'DRAFT';
  if (u.role === 'EMPLOYEE') return a.employee_id === u.id;
  if (u.role === 'CUSTOMER') return a.status !== 'DRAFT' && !!u.customer_id && a.customer_id === u.customer_id;
  return false;
}
function getApp(u, id) {
  const a = q.get('SELECT * FROM applications WHERE id=?', Number(id));
  if (!a || !canSeeApp(u, a)) throw notFound('Application not found');
  return a;
}
function canSeeLoan(u, l) {
  if (!l) return false;
  if (u.role === 'ADMIN') return true;
  if (u.role === 'EMPLOYEE') return l.employee_id === u.id;
  if (u.role === 'CUSTOMER') return !!u.customer_id && l.customer_id === u.customer_id;
  return false;
}
function getLoan(u, id) {
  const l = q.get('SELECT * FROM loans WHERE id=?', Number(id));
  if (!l || !canSeeLoan(u, l)) throw notFound('Loan not found');
  return l;
}

// ---------- application status changes ----------
function transition(app, to, user, comment, ref) {
  const chk = D.checkTransition(app.status, to, user.role);
  if (!chk.ok) throw conflict(chk.reason);
  if (to === 'APPROVED' && user.id === app.employee_id) throw forbidden('You cannot approve your own application.');
  q.run('UPDATE applications SET status=?, updated_at=? WHERE id=?', to, Date.now(), app.id);
  q.run('INSERT INTO timeline(application_id,from_status,to_status,user_id,at,comment,ref) VALUES(?,?,?,?,?,?,?)',
    app.id, app.status, to, user.id, Date.now(), comment || null, ref || null);
  audit(user.id, 'APPLICATION_STATUS', 'application', app.id, `${app.status} -> ${to}${comment ? ': ' + comment : ''}`);
  app.status = to;
}

// ---------- eligibility ----------
function activeRules() {
  const r = q.get('SELECT * FROM eligibility_rules WHERE active=1 ORDER BY version DESC LIMIT 1');
  return r ? { version: r.version, minAge: r.min_age, maxAge: r.max_age, minIncome: r.min_income, maxActiveLoans: r.max_active_loans,
    allowedOccupations: r.occupations.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) } : null;
}
function activeLoanCountByMobile(mobile) {
  return q.get(`SELECT COUNT(*) c FROM loans l JOIN customers c ON c.id=l.customer_id WHERE c.mobile=? AND l.status IN ('ACTIVE','PENDING_DISBURSEMENT')`, mobile).c;
}
function runEligibility(f, product) {
  return D.evaluateEligibility(activeRules(), {
    dob: f.dob, income: f.income, occupation: f.occupation, amount: f.amount,
    activeLoans: activeLoanCountByMobile(f.mobile), productMin: product.min_amount, productMax: product.max_amount,
  }, today());
}
function productUsable(p) { return p.status === 'ACTIVE' && !!p.rate_period && !!p.method; }
function penaltyTermsFor(policyId) {
  const p = policyId ? q.get('SELECT * FROM penalty_policies WHERE id=?', policyId) : null;
  if (!p) return { enabled: false, graceDays: 0, type: 'FIXED', value: 0, capPaise: null };
  return { enabled: !!p.enabled, graceDays: p.grace_days, type: p.type, value: p.value, capPaise: p.cap_paise };
}

// ---------- loans ----------
function loanCols(i) {
  const out = (i.principal - i.principal_paid) + (i.interest - i.interest_paid) + (i.fees - i.fees_paid) + (i.penalty - i.penalty_paid - i.penalty_waived);
  const paid = i.principal_paid + i.interest_paid + i.fees_paid + i.penalty_paid;
  return { ...i, outstanding: out, status: out <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'PENDING' };
}
function accruePenalties(loan, now = today()) {
  if (loan.status !== 'ACTIVE') return;
  const terms = JSON.parse(loan.penalty);
  for (const i of q.all('SELECT * FROM instalments WHERE loan_id=? AND due_date<? ORDER BY number', loan.id, now)) {
    if (i.waiver_reason) continue;
    const unpaidBase = (i.principal - i.principal_paid) + (i.interest - i.interest_paid) + (i.fees - i.fees_paid);
    const computed = D.penaltyFor(terms, i.due_date, now, unpaidBase);
    // Never lowers an already-charged penalty and never stacks, so repeated recalculation is idempotent.
    if (computed > i.penalty) q.run('UPDATE instalments SET penalty=? WHERE id=?', computed, i.id);
  }
}
function loanDetail(loan, now = today()) {
  accruePenalties(loan, now); loan = q.get('SELECT * FROM loans WHERE id=?', loan.id);
  const inst = q.all('SELECT * FROM instalments WHERE loan_id=? ORDER BY number', loan.id).map(loanCols);
  const outstandingPrincipal = inst.reduce((a, i) => a + i.principal - i.principal_paid, 0);
  const overdue = inst.filter(i => i.due_date < now && i.outstanding > 0);
  const nextDue = inst.find(i => i.outstanding > 0 && i.due_date >= now) || null;
  const terms = JSON.parse(loan.penalty);
  const last = q.get(`SELECT MAX(collected_at) t FROM payments WHERE loan_id=? AND status='POSTED'`, loan.id).t;
  return { loan: { ...loan, penaltyTerms: terms }, instalments: inst, summary: {
    outstandingPrincipal, outstandingTotal: inst.reduce((a, i) => a + i.outstanding, 0),
    overdueAmount: overdue.reduce((a, i) => a + i.outstanding, 0), overdueCount: overdue.length,
    maxDaysOverdue: overdue.length ? Math.max(...overdue.map(i => D.daysBetween(i.due_date, now))) : 0,
    nextDueDate: nextDue ? nextDue.due_date : null, nextDueAmount: nextDue ? nextDue.outstanding : 0,
    penaltyOutstanding: inst.reduce((a, i) => a + Math.max(0, i.penalty - i.penalty_paid - i.penalty_waived), 0),
    lastPaymentAt: last, totalPaid: inst.reduce((a, i) => a + i.principal_paid + i.interest_paid + i.fees_paid + i.penalty_paid, 0),
    overdueInstalments: overdue.map(i => ({ number: i.number, dueDate: i.due_date, daysOverdue: D.daysBetween(i.due_date, now), outstanding: i.outstanding,
      penalty: i.penalty - i.penalty_paid - i.penalty_waived, explain: explainPenalty(terms, i, now) })),
  } };
}
function explainPenalty(t, i, now) {
  if (!t.enabled) return 'No penalty policy enabled for this loan.';
  if (i.waiver_reason) return `Penalty waived: ${i.waiver_reason}`;
  const days = D.daysBetween(i.due_date, now);
  if (days <= t.graceDays) return `${days} day(s) overdue, within ${t.graceDays} grace day(s): no penalty.`;
  const base = t.type === 'FIXED' ? `fixed ${D.rupees(t.value)}` : `${t.value / 100}% of unpaid amount at the time`;
  return `${days} day(s) overdue (grace ${t.graceDays}): ${base}${t.capPaise != null ? `, capped at ${D.rupees(t.capPaise)}` : ''}; charged once per instalment.`;
}

function createLoanFromApproval(app, product, admin, { principal, firstDueDate }) {
  const sched = D.buildSchedule({ principal, rateBps: product.rate_bps, ratePeriod: product.rate_period, method: product.method,
    term: app.term, frequency: app.frequency, firstDueDate });
  const terms = penaltyTermsFor(product.penalty_policy_id);
  const ref = nextRef('LN');
  const r = q.run(`INSERT INTO loans(ref,application_id,customer_id,product_id,employee_id,principal,rate_bps,rate_period,method,term,frequency,
      fee_bps,fee_amount,penalty,status,approved_by,approved_at,first_due_date) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ref, app.id, app.customer_id, product.id, app.employee_id, principal, product.rate_bps, product.rate_period, product.method, app.term,
    app.frequency, product.fee_bps, D.processingFee(principal, product.fee_bps), JSON.stringify(terms), 'PENDING_DISBURSEMENT',
    admin.id, Date.now(), firstDueDate);
  const id = Number(r.lastInsertRowid);
  for (const l of sched) q.run('INSERT INTO instalments(loan_id,number,due_date,principal,interest) VALUES(?,?,?,?,?)', id, l.number, l.dueDate, l.principal, l.interest);
  return q.get('SELECT * FROM loans WHERE id=?', id);
}

// ---------- payments ----------
function recordPayment(user, loanId, { amount, method, reference, remarks, deviceTime, idemKey }) {
  if (!Number.isInteger(amount) || amount <= 0) throw bad('Enter a valid collection amount.');
  if (!['CASH', 'BANK_TRANSFER', 'UPI', 'OTHER'].includes(method)) throw bad('Choose a payment method.');
  if (['BANK_TRANSFER', 'UPI'].includes(method) && !String(reference || '').trim()) throw bad('A reference number is required for this payment method.');
  if (!idemKey) throw bad('Missing idempotency key.');
  return tx(() => {
    const dup = q.get('SELECT * FROM payments WHERE idem_key=?', idemKey);
    if (dup) return { payment: dup, duplicate: true };
    const loan = q.get('SELECT * FROM loans WHERE id=?', Number(loanId));
    if (!loan || !(user.role === 'ADMIN' || (user.role === 'EMPLOYEE' && loan.employee_id === user.id))) throw notFound('Loan not found');
    if (loan.status !== 'ACTIVE') throw conflict('Payments can only be recorded against an active loan.');
    accruePenalties(loan);
    const open = q.all('SELECT * FROM instalments WHERE loan_id=? ORDER BY number', loan.id).map(loanCols).filter(i => i.outstanding > 0);
    const total = open.reduce((a, i) => a + i.outstanding, 0);
    if (amount > total) throw bad(`Amount exceeds the total outstanding of ${D.rupees(total)}.`);
    const { allocations } = D.allocate(amount, open.map(i => ({ id: i.id, number: i.number,
      penalty: i.penalty - i.penalty_paid - i.penalty_waived, fees: i.fees - i.fees_paid, interest: i.interest - i.interest_paid, principal: i.principal - i.principal_paid })));
    const receipt = nextRef('RC');
    const pr = q.run(`INSERT INTO payments(receipt_no,loan_id,amount,method,reference,remarks,collected_by,collected_at,device_time,status,idem_key)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, receipt, loan.id, amount, method, reference || null, remarks || null, user.id, Date.now(), deviceTime || null, 'POSTED', idemKey);
    const pid = Number(pr.lastInsertRowid);
    for (const a of allocations) {
      q.run('INSERT INTO payment_allocations(payment_id,instalment_id,principal,interest,fees,penalty) VALUES(?,?,?,?,?,?)', pid, a.instalmentId, a.principal, a.interest, a.fees, a.penalty);
      q.run('UPDATE instalments SET principal_paid=principal_paid+?, interest_paid=interest_paid+?, fees_paid=fees_paid+?, penalty_paid=penalty_paid+? WHERE id=?',
        a.principal, a.interest, a.fees, a.penalty, a.instalmentId);
    }
    let closed = false;
    if (total - amount === 0) {
      q.run(`UPDATE loans SET status='CLOSED', closed_at=?, closed_by=? WHERE id=?`, Date.now(), `payment ${receipt}`, loan.id);
      closed = true; audit(user.id, 'LOAN_CLOSED', 'loan', loan.id, `All obligations settled by ${receipt}`);
    }
    audit(user.id, 'PAYMENT', 'payment', pid, `${receipt} ${D.rupees(amount)} ${method} loan ${loan.ref}`);
    const cust = q.get('SELECT * FROM customers WHERE id=?', loan.customer_id);
    notify(q.all('SELECT id FROM users WHERE customer_id=?', loan.customer_id).map(u => u.id), 'PAYMENT', 'Payment received',
      `${D.rupees(amount)} received for ${loan.ref}. Receipt ${receipt}.`, 'payment', pid);
    notify(loan.employee_id, 'PAYMENT', 'Payment recorded', `${D.rupees(amount)} from ${cust.name} (${receipt}).`, 'payment', pid);
    if (closed) notifyRole('ADMIN', 'PAYMENT', 'Loan closed', `${loan.ref} for ${cust.name} is fully settled.`, 'loan', loan.id);
    return { payment: q.get('SELECT * FROM payments WHERE id=?', pid), duplicate: false, closed };
  });
}
function reversePayment(user, paymentId, reason) {
  if (!String(reason || '').trim()) throw bad('A reason is required to reverse a payment.');
  return tx(() => {
    const p = q.get('SELECT * FROM payments WHERE id=?', Number(paymentId));
    if (!p) throw notFound('Payment not found');
    if (p.status !== 'POSTED') throw conflict('Only a posted payment can be reversed, and only once.');
    const allocs = q.all('SELECT * FROM payment_allocations WHERE payment_id=?', p.id);
    for (const a of allocs) q.run('UPDATE instalments SET principal_paid=principal_paid-?, interest_paid=interest_paid-?, fees_paid=fees_paid-?, penalty_paid=penalty_paid-? WHERE id=?',
      a.principal, a.interest, a.fees, a.penalty, a.instalment_id);
    const receipt = nextRef('RV');
    const r = q.run(`INSERT INTO payments(receipt_no,loan_id,amount,method,reference,remarks,collected_by,collected_at,status,reverses_id,reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, receipt, p.loan_id, -p.amount, p.method, p.receipt_no, null, user.id, Date.now(), 'REVERSAL', p.id, reason);
    for (const a of allocs) q.run('INSERT INTO payment_allocations(payment_id,instalment_id,principal,interest,fees,penalty) VALUES(?,?,?,?,?,?)',
      Number(r.lastInsertRowid), a.instalment_id, -a.principal, -a.interest, -a.fees, -a.penalty);
    q.run(`UPDATE payments SET status='REVERSED' WHERE id=?`, p.id);
    q.run(`UPDATE loans SET status='ACTIVE', closed_at=NULL, closed_by=NULL WHERE id=? AND status='CLOSED'`, p.loan_id);
    audit(user.id, 'PAYMENT_REVERSED', 'payment', p.id, `${p.receipt_no}: ${reason}`);
    const loan = q.get('SELECT * FROM loans WHERE id=?', p.loan_id);
    notify(loan.employee_id, 'PAYMENT', 'Payment reversed', `${p.receipt_no} was reversed: ${reason}`, 'payment', p.id);
    return q.get('SELECT * FROM payments WHERE id=?', Number(r.lastInsertRowid));
  });
}

module.exports = { today, istDay, canSeeApp, getApp, canSeeLoan, getLoan, transition, activeRules, runEligibility, productUsable,
  penaltyTermsFor, loanCols, accruePenalties, loanDetail, createLoanFromApproval, recordPayment, reversePayment, activeLoanCountByMobile };
