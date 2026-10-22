'use strict';
const D = require('./domain');
const H = require('./http'); const { route, bad, forbidden, notFound, conflict } = H;
const { q, tx, audit, notify } = require('./db');
const S = require('./services'); const { maskCustomer } = require('./routes_core');
const ANY = ['EMPLOYEE', 'ACCOUNTS', 'ADMIN', 'CUSTOMER'], STAFF = ['EMPLOYEE', 'ACCOUNTS', 'ADMIN'];
const str = (v, m = 300) => String(v ?? '').trim().slice(0, m);
const istStart = d => Date.parse(d + 'T00:00:00+05:30'), istEnd = d => Date.parse(d + 'T23:59:59.999+05:30');
const TERMINAL_APP = ['REJECTED_BY_ACCOUNTS', 'REJECTED_BY_ADMIN', 'CANCELLED', 'DISBURSED', 'DRAFT'];

// ================= Customer / case list (counts and rows share this one function) =================
function cases(user) {
  const apps = q.all(`SELECT a.*, c.name cname, c.ref cref, c.mobile cmobile FROM applications a JOIN customers c ON c.id=a.customer_id WHERE a.status<>'DRAFT' ORDER BY a.updated_at DESC`)
    .filter(a => S.canSeeApp(user, a));
  return apps.map(a => {
    const loan = q.get('SELECT * FROM loans WHERE application_id=?', a.id);
    let sum = null; if (loan && loan.status !== 'PENDING_DISBURSEMENT') sum = S.loanDetail(loan).summary;
    const pending = !TERMINAL_APP.includes(a.status);
    const active = loan?.status === 'ACTIVE', closed = loan?.status === 'CLOSED', overdue = active && sum.overdueAmount > 0;
    return { customerId: a.customer_id, customerName: a.cname, customerRef: a.cref, mobile: user.role === 'ACCOUNTS' || user.role === 'ADMIN' || user.role === 'EMPLOYEE' ? a.cmobile : null,
      applicationId: a.id, applicationRef: a.ref, applicationStatus: a.status, loanId: loan?.id ?? null, loanRef: loan?.ref ?? null, loanStatus: loan?.status ?? null,
      amount: loan ? loan.principal : a.amount, outstanding: sum ? sum.outstandingTotal : null, nextDueDate: sum?.nextDueDate ?? null, overdueAmount: sum ? sum.overdueAmount : 0,
      flags: { pending, active, closed, overdue } };
  });
}
route('GET', '/api/cases', { roles: ['EMPLOYEE', 'ADMIN', 'ACCOUNTS'] }, ({ user, query }) => {
  const all = cases(user); const f = query.filter || 'all'; const s = str(query.search).toLowerCase();
  const counts = { all: all.length, pending: all.filter(c => c.flags.pending).length, active: all.filter(c => c.flags.active).length, closed: all.filter(c => c.flags.closed).length, overdue: all.filter(c => c.flags.overdue).length };
  let rows = f === 'all' ? all : all.filter(c => c.flags[f]);
  if (s) rows = rows.filter(c => [c.customerName, c.customerRef, c.mobile, c.loanRef, c.applicationRef].some(v => v && String(v).toLowerCase().includes(s)));
  return { counts, rows };
});
route('GET', '/api/customers', { roles: ['ADMIN'] }, ({ query }) => ({ customers: q.all(`SELECT id,ref,name,mobile FROM customers ${query.search ? 'WHERE name LIKE ? OR mobile LIKE ? OR ref LIKE ?' : ''} ORDER BY name LIMIT 200`,
  ...(query.search ? Array(3).fill('%' + query.search + '%') : [])) }));
route('GET', '/api/customers/:id', { roles: STAFF }, ({ user, params }) => {
  const c = q.get('SELECT * FROM customers WHERE id=?', Number(params.id)); if (!c) throw notFound();
  const mine = cases(user).filter(x => x.customerId === c.id); if (!mine.length && user.role !== 'ADMIN') throw notFound();
  return { customer: maskCustomer(c, user.role), cases: mine };
});

// ================= Loans =================
route('GET', '/api/loans', { roles: ['EMPLOYEE', 'ADMIN', 'CUSTOMER'] }, ({ user, query }) => {
  let loans = q.all('SELECT l.*, c.name cname, c.ref cref FROM loans l JOIN customers c ON c.id=l.customer_id ORDER BY l.id DESC').filter(l => S.canSeeLoan(user, l));
  if (query.status) loans = loans.filter(l => l.status === query.status);
  const s = str(query.search).toLowerCase(); if (s) loans = loans.filter(l => [l.cname, l.cref, l.ref].some(v => String(v).toLowerCase().includes(s)));
  return { loans: loans.slice(0, 300).map(l => { const d = l.status === 'PENDING_DISBURSEMENT' ? null : S.loanDetail(l);
    return { id: l.id, ref: l.ref, status: l.status, customerName: l.cname, customerRef: l.cref, principal: l.principal, ...(d ? d.summary : {}), overdueInstalments: undefined }; }) };
});
route('GET', '/api/loans/:id', { roles: ['EMPLOYEE', 'ADMIN', 'CUSTOMER'] }, ({ user, params }) => {
  const l = S.getLoan(user, params.id); const d = S.loanDetail(l); const c = q.get('SELECT * FROM customers WHERE id=?', l.customer_id);
  const payments = q.all(`SELECT p.*, u.name by_name FROM payments p LEFT JOIN users u ON u.id=p.collected_by WHERE loan_id=? ORDER BY p.id DESC`, l.id);
  const out = { ...d, customer: { id: c.id, name: c.name, ref: c.ref, mobile: user.role === 'CUSTOMER' ? c.mobile : c.mobile }, payments };
  if (user.role === 'CUSTOMER') { delete out.loan.approved_by; delete out.loan.disbursed_by; delete out.loan.employee_id; }
  return out;
});
route('POST', '/api/loans/:id/followup', { roles: ['EMPLOYEE', 'ADMIN'] }, ({ user, params, body }) => {
  const l = S.getLoan(user, params.id); if (!['NONE', 'CALLED', 'PROMISED', 'VISITED', 'ESCALATED', 'RESOLVED'].includes(body.status)) throw bad('Invalid follow-up status.');
  q.run('UPDATE loans SET followup_status=?, followup_note=? WHERE id=?', body.status, str(body.note, 300) || null, l.id); audit(user.id, 'FOLLOWUP', 'loan', l.id, `${body.status} ${str(body.note, 100)}`); return { ok: true };
});
route('POST', '/api/instalments/:id/waive-penalty', { roles: ['ADMIN'] }, ({ user, params, body }) => {
  const i = q.get('SELECT * FROM instalments WHERE id=?', Number(params.id)); if (!i) throw notFound();
  if (!str(body.reason)) throw bad('A reason is required to waive a penalty.');
  const open = i.penalty - i.penalty_paid - i.penalty_waived; if (open <= 0 && i.waiver_reason) throw conflict('Already waived.');
  q.run('UPDATE instalments SET penalty_waived=penalty_waived+?, waiver_reason=? WHERE id=?', Math.max(open, 0), str(body.reason, 300), i.id);
  audit(user.id, 'PENALTY_WAIVED', 'instalment', i.id, `${D.rupees(Math.max(open, 0))}: ${str(body.reason, 300)}`);
  const loan = q.get('SELECT * FROM loans WHERE id=?', i.loan_id);
  // If the waiver settles the last obligation, record closure.
  const left = q.all('SELECT * FROM instalments WHERE loan_id=?', loan.id).map(S.loanCols).reduce((a, x) => a + x.outstanding, 0);
  if (left === 0 && loan.status === 'ACTIVE') { q.run(`UPDATE loans SET status='CLOSED', closed_at=?, closed_by=? WHERE id=?`, Date.now(), 'penalty waiver', loan.id); audit(user.id, 'LOAN_CLOSED', 'loan', loan.id, 'Settled via penalty waiver'); }
  return { ok: true };
});

// ================= Payments =================
route('POST', '/api/loans/:id/payments', { roles: ['EMPLOYEE', 'ADMIN'] }, ({ user, params, body, req }) => {
  const r = S.recordPayment(user, params.id, { amount: body.amount, method: body.method, reference: str(body.reference, 100), remarks: str(body.remarks, 300), deviceTime: str(body.deviceTime, 40), idemKey: str(req.headers['idempotency-key'], 80) });
  return { receiptNo: r.payment.receipt_no, paymentId: r.payment.id, duplicate: r.duplicate, loanClosed: !!r.closed };
});
function paymentScope(user) {
  if (user.role === 'ADMIN') return { sql: '1=1', args: [] };
  if (user.role === 'EMPLOYEE') return { sql: 'l.employee_id=?', args: [user.id] };
  if (user.role === 'CUSTOMER') return { sql: 'l.customer_id=?', args: [user.customer_id || -1] };
  return { sql: '0=1', args: [] };
}
route('GET', '/api/payments', { roles: ['EMPLOYEE', 'ADMIN', 'CUSTOMER'] }, ({ user, query }) => {
  const sc = paymentScope(user); const w = [sc.sql], a = [...sc.args];
  if (query.loanId) { w.push('p.loan_id=?'); a.push(Number(query.loanId)); }
  if (query.from) { w.push('p.collected_at>=?'); a.push(istStart(query.from)); } if (query.to) { w.push('p.collected_at<=?'); a.push(istEnd(query.to)); }
  if (query.mine === '1') { w.push('p.collected_by=?'); a.push(user.id); }
  const rows = q.all(`SELECT p.id,p.receipt_no,p.amount,p.method,p.status,p.collected_at,p.reference,p.reverses_id,p.reason,l.ref loan_ref,c.name customer_name,c.ref customer_ref,u.name by_name
    FROM payments p JOIN loans l ON l.id=p.loan_id JOIN customers c ON c.id=l.customer_id LEFT JOIN users u ON u.id=p.collected_by WHERE ${w.join(' AND ')} ORDER BY p.id DESC LIMIT 500`, ...a);
  return { payments: user.role === 'CUSTOMER' ? rows.map(({ by_name, ...r }) => r) : rows };
});
route('GET', '/api/payments/:id', { roles: ['EMPLOYEE', 'ADMIN', 'CUSTOMER'] }, ({ user, params }) => {
  const p = q.get('SELECT * FROM payments WHERE id=?', Number(params.id)); if (!p) throw notFound();
  const l = S.getLoan(user, p.loan_id); const c = q.get('SELECT name,ref FROM customers WHERE id=?', l.customer_id);
  const allocs = q.all('SELECT a.*, i.number FROM payment_allocations a JOIN instalments i ON i.id=a.instalment_id WHERE payment_id=? ORDER BY i.number', p.id);
  const by = q.get('SELECT name,code FROM users WHERE id=?', p.collected_by);
  const sum = S.loanDetail(l).summary;
  return { business: 'HS Small Finance', payment: p, loan: { id: l.id, ref: l.ref }, customer: c, recordedBy: user.role === 'CUSTOMER' ? null : by, allocations: allocs,
    totals: allocs.reduce((t, x) => ({ principal: t.principal + x.principal, interest: t.interest + x.interest, fees: t.fees + x.fees, penalty: t.penalty + x.penalty }), { principal: 0, interest: 0, fees: 0, penalty: 0 }),
    balanceAfter: sum.outstandingTotal, note: p.method === 'CASH' ? 'Cash collected by the field employee. This receipt does not confirm bank deposit.' : null };
});
route('POST', '/api/payments/:id/reverse', { roles: ['ADMIN'] }, ({ user, params, body }) => ({ reversal: S.reversePayment(user, params.id, body.reason).receipt_no }));

// ================= Overdue =================
route('GET', '/api/overdue', { roles: ['EMPLOYEE', 'ADMIN'] }, ({ user }) => {
  const rows = q.all(`SELECT l.*, c.name cname, c.ref cref, c.mobile cmobile FROM loans l JOIN customers c ON c.id=l.customer_id WHERE l.status='ACTIVE'`).filter(l => S.canSeeLoan(user, l))
    .map(l => { const d = S.loanDetail(l); return { loanId: l.id, loanRef: l.ref, customerName: l.cname, customerRef: l.cref, mobile: l.cmobile, followupStatus: l.followup_status, followupNote: l.followup_note, ...d.summary }; })
    .filter(r => r.overdueAmount > 0).sort((a, b) => b.maxDaysOverdue - a.maxDaysOverdue);
  return { rows, totalOverdue: rows.reduce((a, r) => a + r.overdueAmount, 0) };
});

// ================= Dashboards =================
route('GET', '/api/dashboard', { roles: ['EMPLOYEE', 'ACCOUNTS', 'ADMIN'] }, ({ user, query }) => {
  const todayIst = S.today(); const monthStart = todayIst.slice(0, 7) + '-01';
  if (user.role === 'EMPLOYEE') {
    const cs = cases(user); const mine = q.get(`SELECT COALESCE(SUM(amount),0) t FROM payments WHERE collected_by=? AND status='POSTED' AND collected_at BETWEEN ? AND ?`, user.id, istStart(todayIst), istEnd(todayIst)).t;
    const mtd = q.get(`SELECT COALESCE(SUM(amount),0) t FROM payments WHERE collected_by=? AND status='POSTED' AND collected_at BETWEEN ? AND ?`, user.id, istStart(monthStart), istEnd(todayIst)).t;
    const od = cs.filter(c => c.flags.overdue);
    const awaiting = q.all(`SELECT status FROM applications WHERE employee_id=? AND status IN ('ADDITIONAL_DOCUMENTS_REQUIRED','SIGNED_DOCUMENT_PENDING','DRAFT')`, user.id);
    return { role: 'EMPLOYEE', metrics: {
      assignedCustomers: new Set(cs.map(c => c.customerId)).size, activeLoans: cs.filter(c => c.flags.active).length, closedLoans: cs.filter(c => c.flags.closed).length,
      pendingApplications: cs.filter(c => c.flags.pending).length, awaitingAction: awaiting.length, docsRequired: awaiting.filter(a => a.status === 'ADDITIONAL_DOCUMENTS_REQUIRED').length,
      todayCollections: mine, monthCollections: mtd, overdueCustomers: od.length, overdueAmount: od.reduce((a, c) => a + c.overdueAmount, 0) } };
  }
  if (user.role === 'ACCOUNTS') {
    const c = s => q.get('SELECT COUNT(*) c FROM applications WHERE status=?', s).c;
    return { role: 'ACCOUNTS', metrics: { awaiting: c('SUBMITTED_TO_ACCOUNTS'), inProgress: c('ACCOUNTS_VERIFICATION'),
      completedByMe: q.get(`SELECT COUNT(DISTINCT application_id) c FROM timeline WHERE user_id=? AND to_status IN ('PENDING_ADMIN_REVIEW','REJECTED_BY_ACCOUNTS','ADDITIONAL_DOCUMENTS_REQUIRED')`, user.id).c } };
  }
  return { role: 'ADMIN', metrics: adminMetrics(query) };
});
function adminMetrics(f) {
  const from = f.from || '1970-01-01', to = f.to || '2999-12-31'; const fm = istStart(from), tm = istEnd(to);
  const emp = f.employeeId ? Number(f.employeeId) : null, prod = f.productId ? Number(f.productId) : null;
  const lw = [], la = []; if (emp) { lw.push('l.employee_id=?'); la.push(emp); } if (prod) { lw.push('l.product_id=?'); la.push(prod); }
  const LW = lw.length ? ' AND ' + lw.join(' AND ') : '';
  const cnt = (s) => q.get(`SELECT COUNT(*) c FROM applications a WHERE a.status IN (${s.map(() => '?').join(',')})${emp ? ' AND a.employee_id=?' : ''}${prod ? ' AND a.product_id=?' : ''}`, ...s, ...(emp ? [emp] : []), ...(prod ? [prod] : [])).c;
  const sumAlloc = col => q.get(`SELECT COALESCE(SUM(pa.${col}),0) t FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id JOIN loans l ON l.id=p.loan_id WHERE p.status='POSTED' AND p.collected_at BETWEEN ? AND ?${LW}`, fm, tm, ...la).t;
  const principalDisbursed = q.get(`SELECT COALESCE(SUM(principal),0) t FROM loans l WHERE disbursed_at BETWEEN ? AND ?${LW}`, fm, tm).t;
  const procFees = q.get(`SELECT COALESCE(SUM(fee_amount),0) t FROM loans l WHERE disbursed_at BETWEEN ? AND ?${LW}`, fm, tm).t;
  const collections = q.get(`SELECT COALESCE(SUM(p.amount),0) t FROM payments p JOIN loans l ON l.id=p.loan_id WHERE p.status='POSTED' AND p.collected_at BETWEEN ? AND ?${LW}`, fm, tm).t;
  const principalRepaid = sumAlloc('principal'), interest = sumAlloc('interest'), otherFees = sumAlloc('fees'), penalties = sumAlloc('penalty');
  const actives = q.all(`SELECT l.* FROM loans l WHERE status='ACTIVE'${LW}`, ...la).map(l => S.loanDetail(l));
  const today = S.today(); const upcoming = actives.flatMap(d => d.instalments).filter(i => i.outstanding > 0 && i.due_date >= today && i.due_date <= D.addDays(today, 7)).reduce((a, i) => a + i.outstanding, 0);
  const withDue = actives.filter(d => d.instalments.some(i => i.due_date <= today && i.outstanding > 0)); const overdue = actives.filter(d => d.summary.overdueAmount > 0);
  const expenses = q.get(`SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE date BETWEEN ? AND ?`, from, to).t;
  const income = interest + procFees + otherFees + penalties;
  const outstandingPrincipal = q.all(`SELECT l.* FROM loans l WHERE status='ACTIVE'${LW}`, ...la).reduce((a, l) => a + q.get('SELECT SUM(principal-principal_paid) t FROM instalments WHERE loan_id=?', l.id).t, 0);
  const expected = actives.reduce((a, d) => a + d.instalments.reduce((s, i) => s + (i.interest - i.interest_paid), 0), 0);
  return { totalCustomers: q.get('SELECT COUNT(*) c FROM customers').c,
    awaitingAccounts: cnt(['SUBMITTED_TO_ACCOUNTS', 'ACCOUNTS_VERIFICATION']), awaitingAdminReview: cnt(['PENDING_ADMIN_REVIEW']), awaitingPhysical: cnt(['PHYSICAL_VERIFICATION']),
    awaitingSigned: cnt(['SIGNED_DOCUMENT_PENDING', 'FINAL_ADMIN_REVIEW']), docsRequired: cnt(['ADDITIONAL_DOCUMENTS_REQUIRED']),
    approvedLoans: q.get(`SELECT COUNT(*) c FROM loans l WHERE 1=1${LW}`, ...la).c, activeLoans: actives.length,
    closedLoans: q.get(`SELECT COUNT(*) c FROM loans l WHERE status='CLOSED'${LW}`, ...la).c, rejected: cnt(['REJECTED_BY_ACCOUNTS', 'REJECTED_BY_ADMIN']),
    principalDisbursed, principalRepaid, outstandingPrincipal, collections, interestCollected: interest, processingFees: procFees, otherFees, penaltiesCollected: penalties,
    upcomingInstalments7d: upcoming, overdueAmount: overdue.reduce((a, d) => a + d.summary.overdueAmount, 0), overdueLoans: overdue.length,
    customersCurrentDuesUnpaid: withDue.length, customersCurrentDuesPaid: actives.length - withDue.length, expenses, realizedIncome: income, realizedProfit: income - expenses,
    expectedFutureInterest: expected,
    _definitions: { collections: 'Payments posted in the period (reversed payments excluded).', interestCollected: 'Interest actually received.',
      realizedIncome: 'Interest + processing fees (at disbursement) + other fees + penalties actually received. Excludes principal and expected future interest.',
      realizedProfit: 'Realized income minus recorded expenses. Write-offs are not tracked yet.', outstandingPrincipal: 'Principal not yet repaid on active loans (as of today).' } };
}
route('POST', '/api/expenses', { roles: ['ADMIN'] }, ({ user, body }) => {
  const amount = Number.isInteger(body.amount) ? body.amount : null; if (!(amount > 0)) throw bad('Enter a valid amount.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str(body.date))) throw bad('Choose a date.'); if (!str(body.category)) throw bad('Enter a category.');
  const id = Number(q.run('INSERT INTO expenses(date,category,amount,note,created_by,created_at) VALUES(?,?,?,?,?,?)', body.date, str(body.category, 60), amount, str(body.note, 200) || null, user.id, Date.now()).lastInsertRowid);
  audit(user.id, 'EXPENSE_ADDED', 'expense', id, `${D.rupees(amount)} ${str(body.category, 60)}`); return { id };
});
route('GET', '/api/expenses', { roles: ['ADMIN'] }, () => ({ expenses: q.all('SELECT * FROM expenses ORDER BY date DESC, id DESC LIMIT 300') }));

// ================= Reports =================
const C = (key, label, type = 'text') => ({ key, label, type });
function runReport(name, f) {
  const from = f.from || '1970-01-01', to = f.to || '2999-12-31'; const fm = istStart(from), tm = istEnd(to);
  const emp = f.employeeId ? Number(f.employeeId) : null, prod = f.productId ? Number(f.productId) : null, cust = f.customerId ? Number(f.customerId) : null;
  const L = []; const A = [];
  const add = (cond, v) => { if (v != null && v !== '') { L.push(cond); A.push(v); } }; const W = () => (L.length ? ' AND ' + L.join(' AND ') : '');
  const R = {};
  R.customers = () => { add('c.assigned_to=?', emp); add('c.id=?', cust); return { title: 'Customer register', columns: [C('ref', 'Customer ref'), C('name', 'Name'), C('mobile', 'Mobile'), C('occupation', 'Occupation'), C('income', 'Monthly income', 'money'), C('employee', 'Employee'), C('created', 'Registered', 'datetime')],
    rows: q.all(`SELECT c.ref,c.name,c.mobile,c.occupation,c.income,u.name employee,c.created_at created FROM customers c LEFT JOIN users u ON u.id=c.assigned_to WHERE c.created_at BETWEEN ? AND ?${W()} ORDER BY c.id`, fm, tm, ...A) }; };
  R.applications = () => { add('a.employee_id=?', emp); add('a.product_id=?', prod); add('a.customer_id=?', cust); add('a.status=?', f.status); return { title: 'Application register',
    columns: [C('ref', 'Application'), C('customer', 'Customer'), C('product', 'Product'), C('amount', 'Requested', 'money'), C('status', 'Status'), C('employee', 'Employee'), C('submitted', 'Submitted', 'datetime')],
    rows: q.all(`SELECT a.ref,c.name customer,p.name product,a.amount,a.status,u.name employee,a.submitted_at submitted FROM applications a JOIN customers c ON c.id=a.customer_id LEFT JOIN products p ON p.id=a.product_id LEFT JOIN users u ON u.id=a.employee_id WHERE a.submitted_at BETWEEN ? AND ?${W()} ORDER BY a.id`, fm, tm, ...A) }; };
  R.decisions = () => { add('a.employee_id=?', emp); add('a.product_id=?', prod); add('a.customer_id=?', cust); return { title: 'Approval and rejection report',
    columns: [C('ref', 'Application'), C('customer', 'Customer'), C('decision', 'Decision'), C('by', 'Decided by'), C('at', 'Date', 'datetime'), C('comment', 'Reason / comment')],
    rows: q.all(`SELECT a.ref,c.name customer,t.to_status decision,u.name \`by\`,t.at,t.comment FROM timeline t JOIN applications a ON a.id=t.application_id JOIN customers c ON c.id=a.customer_id LEFT JOIN users u ON u.id=t.user_id
      WHERE t.to_status IN ('APPROVED','REJECTED_BY_ACCOUNTS','REJECTED_BY_ADMIN') AND t.at BETWEEN ? AND ?${W()} ORDER BY t.id`, fm, tm, ...A) }; };
  R.disbursements = () => { add('l.employee_id=?', emp); add('l.product_id=?', prod); add('l.customer_id=?', cust); return { title: 'Loan disbursement report',
    columns: [C('ref', 'Loan'), C('customer', 'Customer'), C('principal', 'Principal', 'money'), C('fee', 'Processing fee', 'money'), C('net', 'Net paid out', 'money'), C('method', 'Method'), C('at', 'Disbursed', 'datetime')],
    rows: q.all(`SELECT l.ref,c.name customer,l.principal,l.fee_amount fee,l.principal-l.fee_amount net,l.disbursed_method method,l.disbursed_at at FROM loans l JOIN customers c ON c.id=l.customer_id WHERE l.disbursed_at BETWEEN ? AND ?${W()} ORDER BY l.id`, fm, tm, ...A),
    totals: ['principal', 'fee', 'net'], note: 'Processing fee is deducted from the amount paid out.' }; };
  R.outstanding = () => { add('l.employee_id=?', emp); add('l.product_id=?', prod); add('l.customer_id=?', cust); const rows = q.all(`SELECT l.*, c.name customer FROM loans l JOIN customers c ON c.id=l.customer_id WHERE l.status='ACTIVE'${W()} ORDER BY l.id`, ...A)
    .map(l => { const s = S.loanDetail(l).summary; return { ref: l.ref, customer: l.customer, principal: l.principal, outPrincipal: s.outstandingPrincipal, outTotal: s.outstandingTotal, nextDue: s.nextDueDate, overdue: s.overdueAmount }; });
    return { title: 'Outstanding loan report (as of today)', columns: [C('ref', 'Loan'), C('customer', 'Customer'), C('principal', 'Principal', 'money'), C('outPrincipal', 'Outstanding principal', 'money'), C('outTotal', 'Total outstanding', 'money'), C('nextDue', 'Next due', 'date'), C('overdue', 'Overdue', 'money')], rows, totals: ['principal', 'outPrincipal', 'outTotal', 'overdue'] }; };
  R.schedule = () => { add('l.employee_id=?', emp); add('l.product_id=?', prod); add('l.customer_id=?', cust); return { title: 'Repayment schedule report', columns: [C('loan', 'Loan'), C('customer', 'Customer'), C('no', 'No.', 'int'), C('due', 'Due date', 'date'), C('principal', 'Principal', 'money'), C('interest', 'Interest', 'money'), C('penalty', 'Penalty', 'money'), C('total', 'Instalment', 'money'), C('paid', 'Paid', 'money'), C('remaining', 'Remaining', 'money')],
    rows: q.all(`SELECT l.ref loan,c.name customer,i.number no,i.due_date due,i.principal,i.interest,i.penalty,i.principal+i.interest+i.fees+i.penalty-i.penalty_waived total,
      i.principal_paid+i.interest_paid+i.fees_paid+i.penalty_paid paid, (i.principal-i.principal_paid)+(i.interest-i.interest_paid)+(i.fees-i.fees_paid)+(i.penalty-i.penalty_paid-i.penalty_waived) remaining
      FROM instalments i JOIN loans l ON l.id=i.loan_id JOIN customers c ON c.id=l.customer_id WHERE l.status IN ('ACTIVE','CLOSED','PENDING_DISBURSEMENT') AND i.due_date BETWEEN ? AND ?${W()} ORDER BY l.id,i.number`, from, to, ...A), totals: ['principal', 'interest', 'total', 'paid', 'remaining'] }; };
  const payRows = (extra = '') => { add('l.employee_id=?', emp); add('l.product_id=?', prod); add('l.customer_id=?', cust); add('p.method=?', f.method); add('p.collected_by=?', f.collectorId ? Number(f.collectorId) : null);
    return q.all(`SELECT p.receipt_no receipt,c.name customer,l.ref loan,p.amount,p.method,p.status,u.name collector,p.collected_at at,
      COALESCE((SELECT SUM(principal) FROM payment_allocations WHERE payment_id=p.id),0) principal,COALESCE((SELECT SUM(interest) FROM payment_allocations WHERE payment_id=p.id),0) interest,
      COALESCE((SELECT SUM(fees) FROM payment_allocations WHERE payment_id=p.id),0) fees,COALESCE((SELECT SUM(penalty) FROM payment_allocations WHERE payment_id=p.id),0) penalty
      FROM payments p JOIN loans l ON l.id=p.loan_id JOIN customers c ON c.id=l.customer_id LEFT JOIN users u ON u.id=p.collected_by WHERE p.collected_at BETWEEN ? AND ?${extra}${W()} ORDER BY p.id`, fm, tm, ...A); };
  R.collections = () => ({ title: 'Collection report', columns: [C('receipt', 'Receipt'), C('customer', 'Customer'), C('loan', 'Loan'), C('amount', 'Amount', 'money'), C('method', 'Method'), C('status', 'Status'), C('collector', 'Recorded by'), C('at', 'Date', 'datetime')],
    rows: payRows(), totals: ['amount'], totalWhere: r => r.status === 'POSTED', note: 'Totals count posted payments only; reversed payments and their reversal entries are shown but excluded.' });
  R.employeewise = () => { const rows = payRows(` AND p.status='POSTED'`); const m = new Map(); for (const r of rows) { const k = r.collector || '-'; const o = m.get(k) || { employee: k, count: 0, amount: 0, cash: 0 }; o.count++; o.amount += r.amount; if (r.method === 'CASH') o.cash += r.amount; m.set(k, o); }
    return { title: 'Employee-wise collection report', columns: [C('employee', 'Employee'), C('count', 'Receipts', 'int'), C('amount', 'Collected', 'money'), C('cash', 'of which cash', 'money')], rows: [...m.values()], totals: ['count', 'amount', 'cash'] }; };
  R.ageing = () => { add('l.employee_id=?', emp); add('l.product_id=?', prod); add('l.customer_id=?', cust); const bucket = d => d <= 7 ? '1-7 days' : d <= 30 ? '8-30 days' : d <= 60 ? '31-60 days' : d <= 90 ? '61-90 days' : '90+ days';
    const rows = q.all(`SELECT l.*, c.name customer FROM loans l JOIN customers c ON c.id=l.customer_id WHERE l.status='ACTIVE'${W()}`, ...A).map(l => ({ l, s: S.loanDetail(l).summary })).filter(x => x.s.overdueAmount > 0)
      .map(x => ({ ref: x.l.ref, customer: x.l.customer, days: x.s.maxDaysOverdue, bucket: bucket(x.s.maxDaysOverdue), overdue: x.s.overdueAmount, penalty: x.s.penaltyOutstanding })).sort((a, b) => b.days - a.days);
    return { title: 'Overdue and ageing report (as of today)', columns: [C('ref', 'Loan'), C('customer', 'Customer'), C('days', 'Days overdue', 'int'), C('bucket', 'Ageing bucket'), C('overdue', 'Overdue amount', 'money'), C('penalty', 'Penalty included', 'money')], rows, totals: ['overdue', 'penalty'] }; };
  const comp = (title, col, label) => () => { const rows = payRows(` AND p.status='POSTED'`).filter(r => r[col] > 0); return { title, columns: [C('receipt', 'Receipt'), C('customer', 'Customer'), C('loan', 'Loan'), C(col, label, 'money'), C('at', 'Date', 'datetime')], rows, totals: [col] }; };
  R.interest = comp('Interest collection report', 'interest', 'Interest received'); R.penalties = comp('Penalty collection report', 'penalty', 'Penalty received');
  R.fees = () => { add('l.employee_id=?', emp); add('l.product_id=?', prod); add('l.customer_id=?', cust);
    const a = q.all(`SELECT l.ref loan,c.name customer,'Processing fee (deducted at disbursement)' kind,l.fee_amount amount,l.disbursed_at at FROM loans l JOIN customers c ON c.id=l.customer_id WHERE l.disbursed_at BETWEEN ? AND ?${W()}`, fm, tm, ...A);
    return { title: 'Processing fee and other fee report', columns: [C('loan', 'Loan'), C('customer', 'Customer'), C('kind', 'Fee type'), C('amount', 'Amount', 'money'), C('at', 'Date', 'datetime')], rows: a, totals: ['amount'] }; };
  R.closed = () => { add('l.employee_id=?', emp); add('l.product_id=?', prod); add('l.customer_id=?', cust); return { title: 'Closed loan report', columns: [C('ref', 'Loan'), C('customer', 'Customer'), C('principal', 'Principal', 'money'), C('disbursed', 'Disbursed', 'datetime'), C('closed', 'Closed', 'datetime'), C('by', 'Closed by')],
    rows: q.all(`SELECT l.ref,c.name customer,l.principal,l.disbursed_at disbursed,l.closed_at closed,l.closed_by \`by\` FROM loans l JOIN customers c ON c.id=l.customer_id WHERE l.status='CLOSED' AND l.closed_at BETWEEN ? AND ?${W()}`, fm, tm, ...A), totals: ['principal'] }; };
  R.additionalDocs = () => { add('a.employee_id=?', emp); add('a.customer_id=?', cust); return { title: 'Additional document report', columns: [C('ref', 'Application'), C('customer', 'Customer'), C('requested', 'Requested', 'datetime'), C('by', 'Requested by'), C('note', 'What was requested'), C('current', 'Application status')],
    rows: q.all(`SELECT a.ref,c.name customer,t.at requested,u.name \`by\`,t.comment note,a.status current FROM timeline t JOIN applications a ON a.id=t.application_id JOIN customers c ON c.id=a.customer_id LEFT JOIN users u ON u.id=t.user_id WHERE t.to_status='ADDITIONAL_DOCUMENTS_REQUIRED' AND t.at BETWEEN ? AND ?${W()} ORDER BY t.id`, fm, tm, ...A) }; };
  R.verification = () => { add('a.employee_id=?', emp); add('a.product_id=?', prod); add('a.customer_id=?', cust); add('a.status=?', f.status); return { title: 'Verification status report', columns: [C('ref', 'Application'), C('customer', 'Customer'), C('status', 'Status'), C('call', 'Call verification'), C('physical', 'Physical verification'), C('docs', 'Docs pending', 'int')],
    rows: q.all(`SELECT a.ref,c.name customer,a.status,(SELECT outcome FROM verifications WHERE application_id=a.id AND kind='CALL' ORDER BY id DESC LIMIT 1) call,
      (SELECT outcome FROM verifications WHERE application_id=a.id AND kind='PHYSICAL' ORDER BY id DESC LIMIT 1) physical,(SELECT COUNT(*) FROM documents WHERE application_id=a.id AND status IN ('PENDING_REVIEW','REJECTED','REPLACEMENT_REQUESTED')) docs
      FROM applications a JOIN customers c ON c.id=a.customer_id WHERE a.submitted_at BETWEEN ? AND ?${W()} ORDER BY a.id`, fm, tm, ...A) }; };
  R.expenses = () => ({ title: 'Expense report', columns: [C('date', 'Date', 'date'), C('category', 'Category'), C('amount', 'Amount', 'money'), C('note', 'Note')], rows: q.all('SELECT date,category,amount,note FROM expenses WHERE date BETWEEN ? AND ? ORDER BY date', from, to), totals: ['amount'] });
  R.profitloss = () => { const m = adminMetrics({ from: f.from, to: f.to, employeeId: f.employeeId, productId: f.productId });
    return { title: 'Profit / loss report (cash basis)', columns: [C('item', 'Item'), C('amount', 'Amount', 'money')], rows: [
      { item: 'Interest collected', amount: m.interestCollected }, { item: 'Processing fees (at disbursement)', amount: m.processingFees }, { item: 'Other fees collected', amount: m.otherFees }, { item: 'Penalties collected', amount: m.penaltiesCollected },
      { item: 'Realized income', amount: m.realizedIncome }, { item: 'Less: expenses', amount: -m.expenses }, { item: 'Realized profit / (loss)', amount: m.realizedProfit }],
      note: 'Cash basis. Principal repaid and outstanding principal are not income. Write-offs and bad-debt provisions are not tracked yet. Expenses are not filtered by employee or product.' }; };
  R.cash = () => { const rows = payRows(` AND p.method='CASH' AND p.status='POSTED'`); const m = new Map(); for (const r of rows) { const day = new Date(r.at + 5.5 * 3600e3).toISOString().slice(0, 10); const k = day + '|' + (r.collector || '-'); const o = m.get(k) || { day, collector: r.collector || '-', count: 0, amount: 0 }; o.count++; o.amount += r.amount; m.set(k, o); }
    return { title: 'Cash collection report', columns: [C('day', 'Date', 'date'), C('collector', 'Collected by'), C('count', 'Receipts', 'int'), C('amount', 'Cash recorded', 'money')], rows: [...m.values()], totals: ['count', 'amount'],
      note: 'Shows cash recorded as collected by employees. A cash-deposit reconciliation workflow is not implemented, so this does not prove deposit to a bank.' }; };
  if (!R[name]) throw notFound('Unknown report');
  const r = R[name](); r.name = name;
  if (r.totals) { const tot = {}; for (const k of r.totals) tot[k] = r.rows.filter(x => !r.totalWhere || r.totalWhere(x)).reduce((a, x) => a + (x[k] || 0), 0); r.totalsRow = tot; }
  return r;
}
const REPORT_NAMES = ['customers', 'applications', 'decisions', 'disbursements', 'outstanding', 'schedule', 'collections', 'employeewise', 'ageing', 'interest', 'fees', 'penalties', 'closed', 'additionalDocs', 'verification', 'expenses', 'profitloss', 'cash'];
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
route('GET', '/api/reports', { roles: ['ADMIN'] }, () => ({ reports: REPORT_NAMES }));
route('GET', '/api/reports/:name', { roles: ['ADMIN'] }, ({ user, params, query, res }) => {
  const r = runReport(params.name, query); audit(user.id, 'REPORT_RUN', 'report', params.name, JSON.stringify({ ...query, format: undefined }));
  const meta = { generatedAt: Date.now(), generatedBy: user.name, filters: { from: query.from || null, to: query.to || null } };
  if (query.format === 'csv') {
    const fmt = (c, v) => c.type === 'money' ? (v == null ? '' : (v / 100).toFixed(2)) : c.type === 'datetime' ? (v ? new Date(v + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) : '') : v;
    const lines = [`# HS Small Finance - ${r.title}`, `# Generated ${new Date(meta.generatedAt + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19)} IST by ${user.name}`, `# Period ${query.from || 'start'} to ${query.to || 'today'}`,
      r.columns.map(c => csvCell(c.label)).join(','), ...r.rows.map(row => r.columns.map(c => csvCell(fmt(c, row[c.key]))).join(','))];
    if (r.totalsRow) lines.push(r.columns.map((c, i) => csvCell(i === 0 ? 'TOTAL' : r.totalsRow[c.key] != null ? fmt(c, r.totalsRow[c.key]) : '')).join(','));
    const ym = (query.from || S.today()).slice(0, 7);
    return res.sendRaw(200, Buffer.from('﻿' + lines.join('\r\n')), 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="HS-Small-Finance-${params.name}-${ym}.csv"`, 'cache-control': 'no-store' });
  }
  return { ...r, ...meta };
});
module.exports = { runReport, adminMetrics, cases };
