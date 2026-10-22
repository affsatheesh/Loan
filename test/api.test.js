process.env.HS_DB = ':memory:'; process.env.HS_DATA_DIR = require('node:os').tmpdir() + '/hs-test-' + process.pid; process.env.DEMO_MODE = '1';
const test = require('node:test'); const assert = require('node:assert/strict');
const { server } = require('../server/server'); const { q } = require('../server/db'); const D = require('../server/domain');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let base; const jars = {};
async function api(who, method, path, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hsfinance', cookie: jars[who] || '', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const ct = r.headers.get('content-type') || ''; const data = ct.includes('json') ? await r.json() : await r.text(); return { status: r.status, data };
}
const ok = async (...a) => { const r = await api(...a); assert.equal(r.status, 200, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
async function makeUser(role, username, extra = {}) {
  const u = await ok('admin', 'POST', '/api/users', { role, name: username.toUpperCase(), username, mobile: '9000000000', ...extra });
  jars[username] = ''; let r = await api(username, 'POST', '/api/login', { username, password: u.temporaryPassword }); assert.equal(r.status, 200);
  assert.equal((await api(username, 'GET', '/api/applications')).status, 403, 'must change password first');
  await ok(username, 'POST', '/api/change-password', { current: u.temporaryPassword, password: 'Passw0rd!' + username });
  await ok(username, 'POST', '/api/login', { username, password: 'Passw0rd!' + username }); return u;
}
test.before(async () => { await new Promise(r => server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port; });
test.after(() => server.close());

const form = { name: 'Lakshmi Devi', dob: '1990-05-12', mobile: '9876543210', address: '12 Gandhi Street, Madurai, Tamil Nadu', voter: 'ABC1234567', occupation: 'Tailor', adults: 2, children: 2, income: 2500000, amount: 2000000,
  bank: { holder: 'Lakshmi Devi', bankName: 'SBI', account: '123456789012', confirmAccount: '123456789012', ifsc: 'SBIN0001234' } };
let appId, loanId, productId;

test('setup, login, role protection, config', async () => {
  assert.equal((await api('x', 'GET', '/api/setup-status')).data.needsSetup, true);
  assert.equal((await api('x', 'GET', '/api/applications')).status, 401);
  process.env.NODE_ENV = 'production'; process.env.HS_SETUP_TOKEN = 'deployment-test-token';
  assert.equal((await api('x', 'GET', '/api/setup-status')).data.setupTokenRequired, true);
  assert.equal((await api('admin', 'POST', '/api/setup', { name: 'Owner', username: 'owner', password: 'Owner12345' })).status, 403, 'production setup requires token');
  assert.equal((await api('admin', 'POST', '/api/setup', { name: 'Owner', username: 'owner', password: 'Owner12345', setupToken: 'wrong' })).status, 403, 'wrong setup token refused');
  assert.equal((await api('admin', 'POST', '/api/setup', { name: 'Owner', username: 'owner', password: 'short', setupToken: 'deployment-test-token' })).status, 400);
  await ok('admin', 'POST', '/api/setup', { name: 'Owner', username: 'owner', password: 'Owner12345', setupToken: 'deployment-test-token' });
  delete process.env.NODE_ENV; delete process.env.HS_SETUP_TOKEN;
  assert.equal((await api('x', 'POST', '/api/setup', { name: 'B', username: 'bad', password: 'Owner12345' })).status, 403, 'setup only once');
  assert.equal((await api('admin', 'POST', '/api/logout', {}, { 'x-requested-with': '' })).status, 403, 'CSRF header required');
  await makeUser('EMPLOYEE', 'emp1'); await makeUser('EMPLOYEE', 'emp2'); await makeUser('ACCOUNTS', 'acc1');
  const pol = await ok('admin', 'POST', '/api/penalty-policies', { name: 'Std', enabled: true, graceDays: 3, type: 'FIXED', value: 20000 });
  await ok('admin', 'POST', '/api/eligibility-rules', { minAge: 21, maxAge: 60, minIncome: 1000000, maxActiveLoans: 1, occupations: '' });
  const prodBody = { name: 'Small loan', minAmount: 500000, maxAmount: 5000000, rateBps: 2600, term: 10, frequency: 'MONTHLY', feeBps: 800, penaltyPolicyId: pol.id, status: 'ACTIVE' };
  const noPeriod = await api('admin', 'POST', '/api/products', prodBody);
  assert.equal(noPeriod.status, 400); assert.match(noPeriod.data.error, /never assumed/);
  productId = (await ok('admin', 'POST', '/api/products', { ...prodBody, ratePeriod: 'ANNUAL', method: 'FLAT' })).id;
  assert.equal((await api('emp1', 'POST', '/api/products', prodBody)).status, 403);
  assert.equal((await ok('emp1', 'GET', '/api/products')).products.length, 1);
});

test('application: validation, OTP, documents, submit', async () => {
  appId = (await ok('emp1', 'POST', '/api/applications')).id;
  const est = await ok('emp1', 'POST', '/api/estimate', { productId, amount: 2000000 }); assert.equal(est.provisional, true); assert.equal(est.processingFee, 160000);
  await ok('emp1', 'PUT', `/api/applications/${appId}/draft`, { form: { ...form, productId } });
  let r = await api('emp1', 'POST', `/api/applications/${appId}/submit`); assert.equal(r.status, 422); assert.match(r.data.error, /OTP/); assert.match(r.data.error, /photograph/);
  assert.equal((await api('emp1', 'POST', `/api/applications/${appId}/otp/verify`, { mobile: form.mobile, code: '000000' })).status, 400);
  const o = await ok('emp1', 'POST', `/api/applications/${appId}/otp/send`, { mobile: form.mobile }); assert.ok(o.demo && /DEMO/.test(o.label));
  assert.equal((await api('emp1', 'POST', `/api/applications/${appId}/otp/send`, { mobile: form.mobile })).status, 429, 'resend throttled');
  const wrong = await api('emp1', 'POST', `/api/applications/${appId}/otp/verify`, { mobile: form.mobile, code: o.demoCode === '123456' ? '654321' : '123456' }); assert.equal(wrong.status, 400);
  await ok('emp1', 'POST', `/api/applications/${appId}/otp/verify`, { mobile: form.mobile, code: o.demoCode });
  assert.equal((await api('emp1', 'POST', `/api/applications/${appId}/documents`, { type: 'PROFILE_PHOTO', mime: 'application/pdf', data: PNG })).status, 400, 'content must match type');
  assert.equal((await api('emp1', 'POST', `/api/applications/${appId}/documents`, { type: 'PROFILE_PHOTO', mime: 'image/gif', data: PNG })).status, 400);
  const d1 = await ok('emp1', 'POST', `/api/applications/${appId}/documents`, { type: 'PROFILE_PHOTO', mime: 'image/png', data: PNG, uploadKey: 'k1' });
  const d1b = await ok('emp1', 'POST', `/api/applications/${appId}/documents`, { type: 'PROFILE_PHOTO', mime: 'image/png', data: PNG, uploadKey: 'k1' }); assert.equal(d1b.id, d1.id); assert.ok(d1b.duplicate);
  await ok('emp1', 'POST', `/api/applications/${appId}/documents`, { type: 'VOTER_ID', mime: 'image/png', data: PNG });
  assert.equal((await api('emp2', 'GET', `/api/applications/${appId}`)).status, 404, 'other employee cannot see it');
  const s = await ok('emp1', 'POST', `/api/applications/${appId}/submit`); assert.match(s.ref, /^AP-/); assert.equal(s.eligibility.eligible, true);
  assert.equal((await api('emp1', 'POST', `/api/applications/${appId}/submit`)).status, 409, 'no duplicate submit');
  const det = await ok('emp1', 'GET', `/api/applications/${appId}`); assert.equal(det.application.status, 'SUBMITTED_TO_ACCOUNTS'); assert.equal(det.customer.voter, 'XXXXXX4567', 'masked for employee');
  assert.equal((await ok('admin', 'GET', `/api/applications/${appId}`)).customer.voter, 'ABC1234567');
  assert.match(q.get('SELECT voter FROM customers').voter, /^enc1:/, 'encrypted at rest');
  assert.equal((await ok('acc1', 'GET', '/api/notifications')).notifications.length, 1);
});

test('accounts and admin workflow to disbursement; role enforcement', async () => {
  const A = `/api/applications/${appId}`;
  assert.equal((await api('emp1', 'POST', `${A}/accounts/decision`, { decision: 'APPROVE' })).status, 403);
  await ok('acc1', 'POST', `${A}/accounts/start`);
  assert.equal((await api('acc1', 'POST', `${A}/accounts/decision`, { decision: 'APPROVE' })).status, 400, 'call verification required');
  await ok('acc1', 'POST', `${A}/accounts/call`, { outcome: 'CONFIRMED', comment: 'Spoke to customer' });
  await ok('acc1', 'POST', `${A}/accounts/decision`, { decision: 'APPROVE', comment: 'ok' });
  assert.equal((await api('acc1', 'POST', `${A}/admin/approve`, { firstDueDate: '2999-01-01' })).status, 403, 'accounts cannot final-approve');
  assert.equal((await api('admin', 'POST', `${A}/admin/start-physical`)).status, 400, 'doc review first');
  assert.equal((await api('admin', 'POST', `${A}/admin/doc-review`)).status, 400, 'unverified docs');
  for (const d of (await ok('admin', 'GET', A)).documents) await ok('admin', 'POST', `/api/documents/${d.id}/review`, { action: 'VERIFY' });
  await ok('admin', 'POST', `${A}/admin/doc-review`); await ok('admin', 'POST', `${A}/admin/start-physical`);
  const chk = { identity: true, details: true, address: true, documents: true, photo: true };
  assert.equal((await api('admin', 'POST', `${A}/admin/physical`, { outcome: 'PASSED', checklist: chk, comment: 'ok', lat: 9.9, lng: 78.1 })).status, 400, 'field photo needed');
  await ok('admin', 'POST', `${A}/documents`, { type: 'FIELD_VERIFICATION_PHOTO', mime: 'image/png', data: PNG });
  assert.equal((await api('admin', 'POST', `${A}/admin/physical`, { outcome: 'PASSED', checklist: chk, comment: 'ok' })).status, 400, 'no fabricated location');
  await ok('admin', 'POST', `${A}/admin/physical`, { outcome: 'PASSED', checklist: chk, comment: 'ok', locationNote: 'GPS denied by device' });
  assert.equal((await api('emp1', 'POST', `${A}/signed-submit`)).status, 400, 'signed doc needed');
  await ok('emp1', 'POST', `${A}/documents`, { type: 'SIGNED_AGREEMENT', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') });
  await ok('emp1', 'POST', `${A}/signed-submit`);
  assert.equal((await api('emp1', 'POST', `${A}/admin/approve`, { firstDueDate: '2999-01-01' })).status, 403);
  assert.equal((await api('admin', 'POST', `${A}/admin/approve`, { firstDueDate: '2000-01-01' })).status, 400);
  const ap = await ok('admin', 'POST', `${A}/admin/approve`, { firstDueDate: D.addDays(new Date().toISOString().slice(0, 10), 30) }); loanId = ap.loanId;
  assert.equal((await ok('admin', 'GET', A)).application.status, 'READY_FOR_DISBURSEMENT');
  assert.equal((await api('admin', 'POST', `/api/loans/${loanId}/payments`, { amount: 100, method: 'CASH' }, { 'idempotency-key': 'z' })).status, 409, 'inactive loan');
  await ok('admin', 'POST', `${A}/admin/disburse`, { method: 'CASH' });
  const l = await ok('emp1', 'GET', `/api/loans/${loanId}`); assert.equal(l.loan.status, 'ACTIVE'); assert.equal(l.instalments.length, 10);
  assert.equal(l.instalments.reduce((a, i) => a + i.principal, 0), 2000000); assert.equal(l.loan.fee_amount, 160000);
  assert.equal((await api('emp2', 'GET', `/api/loans/${loanId}`)).status, 404);
  const tl = (await ok('admin', 'GET', A)).timeline.map(t => t.to_status); assert.ok(tl.includes('APPROVED') && tl.includes('DISBURSED'));
});

test('payments: idempotency, allocation, overpay, reversal, closure', async () => {
  const pay = (amount, key, extra = {}) => api('emp1', 'POST', `/api/loans/${loanId}/payments`, { amount, method: 'CASH', ...extra }, { 'idempotency-key': key });
  assert.equal((await pay(-5, 'a')).status, 400); assert.equal((await pay(100, 'b', { method: 'UPI' })).status, 400, 'UPI needs reference');
  const first = await pay(300000, 'k-1'); assert.equal(first.status, 200);
  const again = await pay(300000, 'k-1'); assert.equal(again.data.duplicate, true); assert.equal(again.data.receiptNo, first.data.receiptNo);
  assert.equal((await ok('emp1', 'GET', `/api/loans/${loanId}`)).summary.totalPaid, 300000, 'duplicate not double counted');
  assert.equal((await pay(999999999, 'k-2')).status, 400, 'overpayment refused');
  const rc = await ok('emp1', 'GET', `/api/payments/${first.data.paymentId}`); assert.equal(rc.totals.interest + rc.totals.principal, 300000);
  assert.equal((await api('emp1', 'POST', `/api/payments/${first.data.paymentId}/reverse`, { reason: 'x' })).status, 403);
  assert.equal((await api('admin', 'POST', `/api/payments/${first.data.paymentId}/reverse`, {})).status, 400);
  await ok('admin', 'POST', `/api/payments/${first.data.paymentId}/reverse`, { reason: 'Entered wrong amount' });
  assert.equal((await api('admin', 'POST', `/api/payments/${first.data.paymentId}/reverse`, { reason: 'again' })).status, 409);
  assert.equal((await ok('emp1', 'GET', `/api/loans/${loanId}`)).summary.totalPaid, 0);
  const d = await ok('emp1', 'GET', `/api/loans/${loanId}`); const total = d.summary.outstandingTotal;
  const closing = await pay(total, 'k-3'); assert.equal(closing.data.loanClosed, true);
  assert.equal((await ok('emp1', 'GET', `/api/loans/${loanId}`)).loan.status, 'CLOSED');
  const cs = await ok('emp1', 'GET', '/api/cases?filter=closed'); assert.equal(cs.counts.closed, 1); assert.equal(cs.rows.length, 1, 'closed count matches closed list');
  assert.equal((await pay(100, 'k-4')).status, 409);
  await ok('admin', 'POST', `/api/payments/${closing.data.paymentId}/reverse`, { reason: 'test reopen' });
  assert.equal((await ok('emp1', 'GET', `/api/loans/${loanId}`)).loan.status, 'ACTIVE', 'reversal reopens loan');
});

test('overdue penalties: once only, waiver, ageing, dashboard, reports', async () => {
  q.run('UPDATE instalments SET due_date=? WHERE loan_id=? AND number=1', D.addDays(new Date().toISOString().slice(0, 10), -10), loanId);
  const a = await ok('emp1', 'GET', '/api/overdue'); assert.equal(a.rows.length, 1); assert.equal(a.rows[0].penaltyOutstanding, 20000);
  const b = await ok('emp1', 'GET', '/api/overdue'); assert.equal(b.rows[0].penaltyOutstanding, 20000, 'recalculation is idempotent');
  q.run('UPDATE instalments SET due_date=? WHERE loan_id=? AND number=1', D.addDays(new Date().toISOString().slice(0, 10), -2), loanId);
  const dash = await ok('emp1', 'GET', '/api/dashboard'); assert.equal(dash.metrics.overdueCustomers, 1);
  const inst = (await ok('admin', 'GET', `/api/loans/${loanId}`)).instalments[0];
  assert.equal((await api('emp1', 'POST', `/api/instalments/${inst.id}/waive-penalty`, { reason: 'x' })).status, 403);
  await ok('admin', 'POST', `/api/instalments/${inst.id}/waive-penalty`, { reason: 'Hardship' });
  assert.equal((await ok('admin', 'GET', `/api/loans/${loanId}`)).summary.penaltyOutstanding, 0);
  const m = (await ok('admin', 'GET', '/api/dashboard')).metrics; assert.equal(m.activeLoans, 1); assert.equal(m.principalDisbursed, 2000000); assert.equal(m.totalCustomers, 1);
  assert.equal(m.realizedIncome, m.interestCollected + m.processingFees + m.otherFees + m.penaltiesCollected); assert.equal(m.realizedIncome - m.expenses, m.realizedProfit);
  await ok('admin', 'POST', '/api/expenses', { date: new Date().toISOString().slice(0, 10), category: 'Rent', amount: 100000 });
  for (const n of (await ok('admin', 'GET', '/api/reports')).reports) { const r = await api('admin', 'GET', `/api/reports/${n}`); assert.equal(r.status, 200, `report ${n}: ${JSON.stringify(r.data)}`); const c = await api('admin', 'GET', `/api/reports/${n}?format=csv&from=2026-01-01`); assert.equal(c.status, 200, `csv ${n}`); }
  assert.equal((await api('emp1', 'GET', '/api/reports/collections')).status, 403);
  const csv = await api('admin', 'GET', '/api/reports/disbursements?format=csv'); assert.match(csv.data, /Generated/);
  assert.ok((await ok('admin', 'GET', '/api/audit')).rows.some(r => r.action === 'LOAN_APPROVED'));
});

test('rejections are final; deactivated users lose access; customer isolation', async () => {
  const id2 = (await ok('emp2', 'POST', '/api/applications')).id; await ok('emp2', 'DELETE', `/api/applications/${id2}`);
  assert.equal((await api('emp2', 'POST', `/api/applications/${id2}/cancel`, { reason: 'x' })).status, 409);
  const custId = q.get('SELECT id FROM customers').id; await makeUser('CUSTOMER', 'cust1', { customerId: custId });
  const cl = await ok('cust1', 'GET', '/api/loans'); assert.equal(cl.loans.length, 1);
  assert.equal((await api('cust1', 'GET', '/api/users')).status, 403); assert.equal((await api('cust1', 'GET', `/api/customers/${custId}`)).status, 403);
  const cd = await ok('cust1', 'GET', `/api/applications/${appId}`); assert.equal(cd.documents, undefined); assert.equal(cd.application.employeeName, undefined);
  const emp2 = q.get(`SELECT id FROM users WHERE username='emp2'`).id; await ok('admin', 'PUT', `/api/users/${emp2}`, { status: 'INACTIVE' });
  assert.equal((await api('emp2', 'GET', '/api/me')).data.user, null, 'deactivated session ends immediately');
  assert.equal((await api('x2', 'POST', '/api/login', { username: 'emp2', password: 'Passw0rd!emp2' })).status, 403);
  await ok('cust1', 'POST', '/api/logout'); assert.equal((await api('cust1', 'GET', '/api/me')).data.user, null); assert.equal((await api('cust1', 'GET', '/api/loans')).status, 401);
});
