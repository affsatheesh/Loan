'use strict';
const crypto = require('node:crypto');
const D = require('./domain');
const H = require('./http'); const { route, bad, forbidden, notFound, conflict } = H;
const { q, tx, nextRef, audit, notify, notifyRole } = require('./db');
const S = require('./services'); const { enc, dec } = require('./secure'); const sms = require('./sms');

const ANY = ['EMPLOYEE', 'ACCOUNTS', 'ADMIN', 'CUSTOMER'], STAFF = ['EMPLOYEE', 'ACCOUNTS', 'ADMIN'];
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const int = v => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null));

// ================= Auth =================
route('GET', '/api/setup-status', { public: true }, () => ({ needsSetup: q.get('SELECT COUNT(*) c FROM users').c === 0, demoMode: sms.isDemo() }));

route('POST', '/api/setup', { public: true }, ({ body, res }) => {
  if (q.get('SELECT COUNT(*) c FROM users').c > 0) throw forbidden('Setup is already complete.');
  const name = str(body.name), username = str(body.username).toLowerCase(), pw = body.password;
  if (!name || !/^[a-z0-9._-]{3,30}$/.test(username)) throw bad('Enter a name and a username (3-30 letters/numbers).');
  const weak = H.checkPasswordStrength(pw); if (weak) throw bad(weak);
  const { salt, hash } = H.hashPassword(pw);
  const id = Number(q.run(`INSERT INTO users(code,username,name,role,mobile,email,pw_hash,pw_salt,created_at) VALUES('ADM001',?,?,'ADMIN',?,?,?,?,?)`,
    username, name, str(body.mobile, 15) || null, str(body.email, 100) || null, hash, salt, Date.now()).lastInsertRowid);
  audit(id, 'SETUP', 'user', id, 'First admin created');
  res.setCookie(H.createSession(id)); return { ok: true };
});

const attempts = new Map(); // ip -> {n, until}
route('POST', '/api/login', { public: true }, ({ body, res, req }) => {
  const username = str(body.username).toLowerCase(); const ip = req.socket.remoteAddress;
  const a = attempts.get(ip); if (a && a.until > Date.now()) throw new H.ApiError(429, 'Too many attempts. Try again in a few minutes.');
  const u = q.get('SELECT * FROM users WHERE username=?', username);
  const fail = (m) => { const x = attempts.get(ip) || { n: 0 }; x.n++; if (x.n >= 20) { x.until = Date.now() + 5 * 60e3; x.n = 0; } attempts.set(ip, x);
    if (u) { const n = u.failed_logins + 1; q.run('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?', n >= 5 ? 0 : n, n >= 5 ? Date.now() + 15 * 60e3 : u.locked_until, u.id); }
    throw new H.ApiError(401, m); };
  if (!u) { H.hashPassword('x'); return fail('Incorrect username or password.'); }
  if (u.locked_until && u.locked_until > Date.now()) throw new H.ApiError(423, 'Account temporarily locked after repeated failures. Try again in 15 minutes.');
  if (!H.verifyPassword(str(body.password, 200), u.pw_salt, u.pw_hash)) return fail('Incorrect username or password.');
  if (u.status !== 'ACTIVE') throw new H.ApiError(403, 'This account is inactive. Contact your Admin.');
  q.run('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?', u.id);
  attempts.delete(ip); audit(u.id, 'LOGIN', 'user', u.id);
  res.setCookie(H.createSession(u.id)); return { user: H.publicUser(u) };
});
route('POST', '/api/logout', { roles: ANY }, ({ req, res, user }) => { audit(user.id, 'LOGOUT', 'user', user.id); H.destroySession(req); res.clearCookie(); return { ok: true }; });
route('GET', '/api/me', { public: true }, ({ req }) => { // 200 with user:null when logged out, so the login screen causes no failed requests
  const user = H.userFromReq(req); if (!user) return { user: null, demoMode: sms.isDemo() };
  return { user: H.publicUser(user), demoMode: sms.isDemo(), unread: q.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', user.id).c }; });
route('POST', '/api/change-password', { roles: ANY, allowMustChange: true }, ({ user, body }) => {
  if (!H.verifyPassword(str(body.current, 200), user.pw_salt, user.pw_hash)) throw bad('Current password is incorrect.');
  const weak = H.checkPasswordStrength(body.password); if (weak) throw bad(weak);
  const { salt, hash } = H.hashPassword(body.password);
  q.run('UPDATE users SET pw_hash=?, pw_salt=?, must_change=0 WHERE id=?', hash, salt, user.id);
  q.run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', user.id, '');
  audit(user.id, 'PASSWORD_CHANGED', 'user', user.id); return { ok: true, relogin: true };
});
route('PUT', '/api/me', { roles: ANY }, ({ user, body }) => { // customers may update permitted profile info
  const mobile = body.mobile ? str(body.mobile, 15) : user.mobile;
  if (mobile && !D.V.mobile(mobile)) throw bad('Enter a valid 10-digit mobile number.');
  q.run('UPDATE users SET email=?, mobile=? WHERE id=?', str(body.email, 100) || null, mobile || null, user.id);
  if (user.role === 'CUSTOMER' && user.customer_id && str(body.address, 400)) q.run('UPDATE customers SET address=? WHERE id=?', str(body.address, 400), user.customer_id);
  audit(user.id, 'PROFILE_UPDATED', 'user', user.id); return { ok: true };
});

// ================= Users (Admin) =================
route('GET', '/api/users', { roles: ['ADMIN'] }, ({ query }) => ({ users: q.all(
  `SELECT id,code,username,name,role,mobile,email,status,customer_id,created_at,
    (SELECT COUNT(*) FROM applications WHERE employee_id=users.id AND status<>'DRAFT') applications,
    (SELECT COALESCE(SUM(amount),0) FROM payments WHERE collected_by=users.id AND status='POSTED') collected
   FROM users ${query.role ? 'WHERE role=?' : ''} ORDER BY role,name`, ...(query.role ? [query.role] : [])) }));
route('POST', '/api/users', { roles: ['ADMIN'] }, ({ user, body }) => {
  const role = str(body.role); if (!['EMPLOYEE', 'ACCOUNTS', 'ADMIN', 'CUSTOMER'].includes(role)) throw bad('Choose a role.');
  const name = str(body.name), username = str(body.username).toLowerCase();
  if (!name) throw bad('Name is required.'); if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw bad('Username must be 3-30 letters, numbers, dot, dash or underscore.');
  if (body.mobile && !D.V.mobile(body.mobile)) throw bad('Enter a valid 10-digit mobile number.');
  if (q.get('SELECT 1 x FROM users WHERE username=?', username)) throw conflict('That username is already taken.');
  let customerId = null;
  if (role === 'CUSTOMER') { customerId = int(body.customerId); if (!customerId || !q.get('SELECT 1 x FROM customers WHERE id=?', customerId)) throw bad('Select the customer record for this login.'); }
  const temp = crypto.randomBytes(5).toString('hex') + 'A1'; const { salt, hash } = H.hashPassword(temp);
  const prefix = { EMPLOYEE: 'EMP', ACCOUNTS: 'ACC', ADMIN: 'ADM', CUSTOMER: 'CUS' }[role];
  const id = Number(q.run(`INSERT INTO users(username,name,role,mobile,email,pw_hash,pw_salt,must_change,customer_id,created_at) VALUES(?,?,?,?,?,?,?,1,?,?)`,
    username, name, role, str(body.mobile, 15) || null, str(body.email, 100) || null, hash, salt, customerId, Date.now()).lastInsertRowid);
  q.run('UPDATE users SET code=? WHERE id=?', `${prefix}${String(id).padStart(3, '0')}`, id);
  audit(user.id, 'USER_CREATED', 'user', id, `${role} ${username}`);
  return { id, temporaryPassword: temp, note: 'Shown once. The user must change it at first login.' };
});
route('PUT', '/api/users/:id', { roles: ['ADMIN'] }, ({ user, params, body }) => {
  const t = q.get('SELECT * FROM users WHERE id=?', Number(params.id)); if (!t) throw notFound();
  if (t.id === user.id && (body.status === 'INACTIVE' || (body.role && body.role !== t.role))) throw bad('You cannot deactivate or change the role of your own account.');
  if (body.role && !['EMPLOYEE', 'ACCOUNTS', 'ADMIN'].includes(body.role) && t.role !== 'CUSTOMER') throw bad('Invalid role.');
  const status = body.status === 'INACTIVE' ? 'INACTIVE' : body.status === 'ACTIVE' ? 'ACTIVE' : t.status;
  const role = t.role === 'CUSTOMER' ? 'CUSTOMER' : (body.role || t.role);
  if (body.mobile && !D.V.mobile(body.mobile)) throw bad('Enter a valid 10-digit mobile number.');
  tx(() => {
    q.run('UPDATE users SET name=?, mobile=?, email=?, status=?, role=? WHERE id=?', str(body.name) || t.name, body.mobile ? str(body.mobile, 15) : t.mobile,
      body.email !== undefined ? str(body.email, 100) || null : t.email, status, role, t.id);
    if (status === 'INACTIVE') q.run('DELETE FROM sessions WHERE user_id=?', t.id);
    if (status !== t.status) audit(user.id, status === 'ACTIVE' ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', 'user', t.id);
    if (role !== t.role) audit(user.id, 'ROLE_CHANGED', 'user', t.id, `${t.role} -> ${role}`);
    if (status === 'INACTIVE' && t.role === 'EMPLOYEE' && int(body.reassignTo)) { // hand pending work to another active employee
      const to = q.get(`SELECT id FROM users WHERE id=? AND role='EMPLOYEE' AND status='ACTIVE'`, body.reassignTo); if (!to) throw bad('Reassignment target must be an active employee.');
      q.run(`UPDATE applications SET employee_id=? WHERE employee_id=? AND status NOT IN ('REJECTED_BY_ACCOUNTS','REJECTED_BY_ADMIN','CANCELLED')`, to.id, t.id);
      q.run(`UPDATE loans SET employee_id=? WHERE employee_id=? AND status<>'CLOSED'`, to.id, t.id);
      audit(user.id, 'WORK_REASSIGNED', 'user', t.id, `to user ${to.id}`);
    }
  });
  return { ok: true };
});
route('POST', '/api/users/:id/reset-password', { roles: ['ADMIN'] }, ({ user, params }) => {
  const t = q.get('SELECT * FROM users WHERE id=?', Number(params.id)); if (!t) throw notFound();
  const temp = crypto.randomBytes(5).toString('hex') + 'A1'; const { salt, hash } = H.hashPassword(temp);
  q.run('UPDATE users SET pw_hash=?, pw_salt=?, must_change=1, failed_logins=0, locked_until=NULL WHERE id=?', hash, salt, t.id);
  q.run('DELETE FROM sessions WHERE user_id=?', t.id); audit(user.id, 'PASSWORD_RESET', 'user', t.id);
  return { temporaryPassword: temp, note: 'Shown once. The user must change it at next login.' };
});
route('GET', '/api/audit', { roles: ['ADMIN'] }, ({ query }) => ({ rows: q.all(
  `SELECT a.*, u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT ?`, Math.min(Number(query.limit) || 200, 1000)) }));

// ================= Configuration (Admin) =================
const prodOut = p => ({ ...p, usable: S.productUsable(p) });
route('GET', '/api/products', { roles: STAFF }, ({ user }) => {
  const rows = q.all('SELECT * FROM products ORDER BY id').map(prodOut);
  return { products: user.role === 'ADMIN' ? rows : rows.filter(p => p.usable) };
});
function productFromBody(b, existing) {
  const min = int(b.minAmount), max = int(b.maxAmount), rate = int(b.rateBps), fee = int(b.feeBps), term = int(b.term);
  if (!str(b.name)) throw bad('Product name is required.');
  if (!(min > 0) || !(max >= min)) throw bad('Enter a valid minimum and maximum loan amount.');
  if (rate == null || rate < 0 || rate > 10000) throw bad('Interest rate must be between 0% and 100%.');
  if (fee == null || fee < 0 || fee > 3000) throw bad('Processing fee must be between 0% and 30%.');
  if (!(term > 0)) throw bad('Term must be at least 1 instalment.');
  if (!D.FREQ[b.frequency]) throw bad('Choose a repayment frequency.');
  const ratePeriod = b.ratePeriod || null, method = b.method || null;
  if (ratePeriod && !['ANNUAL', 'MONTHLY'].includes(ratePeriod)) throw bad('Invalid rate period.');
  if (method && !['FLAT', 'REDUCING_BALANCE'].includes(method)) throw bad('Invalid interest method.');
  const status = b.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
  if (status === 'ACTIVE' && (!ratePeriod || !method)) throw bad('Set the rate period (monthly/annual) and interest method (flat/reducing) before activating a product. They are never assumed.');
  const pp = int(b.penaltyPolicyId); if (pp && !q.get('SELECT 1 x FROM penalty_policies WHERE id=?', pp)) throw bad('Unknown penalty policy.');
  return [str(b.name, 100), str(b.description, 500), min, max, rate, ratePeriod, method, term, b.frequency, fee, pp || null, status, str(b.effectiveFrom, 10) || null];
}
route('POST', '/api/products', { roles: ['ADMIN'] }, ({ user, body }) => {
  const v = productFromBody(body);
  const id = Number(q.run(`INSERT INTO products(name,description,min_amount,max_amount,rate_bps,rate_period,method,term,frequency,fee_bps,penalty_policy_id,status,effective_from,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...v, Date.now()).lastInsertRowid);
  audit(user.id, 'PRODUCT_CREATED', 'product', id, v[0]); return { id };
});
route('PUT', '/api/products/:id', { roles: ['ADMIN'] }, ({ user, params, body }) => {
  const p = q.get('SELECT * FROM products WHERE id=?', Number(params.id)); if (!p) throw notFound();
  const v = productFromBody(body);
  q.run(`UPDATE products SET name=?,description=?,min_amount=?,max_amount=?,rate_bps=?,rate_period=?,method=?,term=?,frequency=?,fee_bps=?,penalty_policy_id=?,status=?,effective_from=? WHERE id=?`, ...v, p.id);
  audit(user.id, 'PRODUCT_UPDATED', 'product', p.id, `Existing loans keep their approved terms. before: rate ${p.rate_bps}bps fee ${p.fee_bps}bps; after: rate ${v[4]}bps fee ${v[9]}bps`);
  return { ok: true, note: 'Existing loans are unaffected: each keeps the terms snapshot taken at approval.' };
});
route('GET', '/api/penalty-policies', { roles: ['ADMIN'] }, () => ({ policies: q.all('SELECT * FROM penalty_policies ORDER BY id') }));
route('POST', '/api/penalty-policies', { roles: ['ADMIN'] }, ({ user, body }) => {
  const type = body.type === 'PERCENT' ? 'PERCENT' : 'FIXED', value = int(body.value), grace = int(body.graceDays) ?? 0;
  if (!str(body.name)) throw bad('Policy name is required.'); if (value == null || value < 0) throw bad('Enter a valid penalty value.');
  if (type === 'PERCENT' && value > 10000) throw bad('Percentage cannot exceed 100%.'); if (grace < 0) throw bad('Grace days cannot be negative.');
  const cap = body.capPaise == null || body.capPaise === '' ? null : int(body.capPaise);
  const id = Number(q.run('INSERT INTO penalty_policies(name,enabled,grace_days,type,value,cap_paise,effective_from,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    str(body.name, 100), body.enabled ? 1 : 0, grace, type, value, cap, str(body.effectiveFrom, 10) || null, str(body.notes, 500) || null, Date.now()).lastInsertRowid);
  audit(user.id, 'PENALTY_POLICY_CREATED', 'penalty_policy', id, `${type} ${value} enabled=${!!body.enabled}`); return { id };
});
route('GET', '/api/eligibility-rules', { roles: ['ADMIN'] }, () => ({ rules: q.all('SELECT * FROM eligibility_rules ORDER BY version DESC') }));
route('POST', '/api/eligibility-rules', { roles: ['ADMIN'] }, ({ user, body }) => {
  const r = { minAge: int(body.minAge), maxAge: int(body.maxAge), minIncome: int(body.minIncome), maxActiveLoans: int(body.maxActiveLoans) };
  if (Object.values(r).some(v => v == null)) throw bad('Fill in all numeric rule fields.');
  const problems = D.validateRules(r); if (problems.length) throw bad(problems.join(' '));
  const occ = str(body.occupations, 500).split(',').map(s => s.trim().toLowerCase()).filter(Boolean).join(',');
  const result = tx(() => { // every edit creates a new version, so past decisions keep the version they used
    const version = (q.get('SELECT COALESCE(MAX(version),0) v FROM eligibility_rules').v) + 1;
    if (body.active !== false) q.run('UPDATE eligibility_rules SET active=0');
    const id = Number(q.run('INSERT INTO eligibility_rules(version,min_age,max_age,min_income,occupations,max_active_loans,active,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      version, r.minAge, r.maxAge, r.minIncome, occ, r.maxActiveLoans, body.active === false ? 0 : 1, user.id, Date.now()).lastInsertRowid);
    audit(user.id, 'ELIGIBILITY_RULES_VERSION', 'eligibility_rule', id, `v${version}`); return { id, version };
  }); return result;
});
route('POST', '/api/eligibility-rules/:id/active', { roles: ['ADMIN'] }, ({ user, params, body }) => {
  const r = q.get('SELECT * FROM eligibility_rules WHERE id=?', Number(params.id)); if (!r) throw notFound();
  tx(() => { if (body.active) q.run('UPDATE eligibility_rules SET active=0'); q.run('UPDATE eligibility_rules SET active=? WHERE id=?', body.active ? 1 : 0, r.id); });
  audit(user.id, body.active ? 'RULES_ACTIVATED' : 'RULES_DEACTIVATED', 'eligibility_rule', r.id); return { ok: true };
});

// ================= Applications =================
function maskCustomer(c, role) {
  if (!c) return null; const full = role === 'ADMIN' || role === 'ACCOUNTS';
  const f = v => { const d = dec(v); return d ? (full ? d : D.V.mask(d)) : null; };
  return { id: c.id, ref: c.ref, name: c.name, dob: c.dob, mobile: c.mobile, address: c.address, pan: f(c.pan), voter: f(c.voter), aadhaar: f(c.aadhaar),
    occupation: c.occupation, adults: c.adults, children: c.children, income: c.income, mobileVerifiedAt: c.mobile_verified_at, otpRef: c.otp_ref, createdAt: c.created_at };
}
function appRow(a) {
  const c = a.customer_id ? q.get('SELECT name,ref,mobile FROM customers WHERE id=?', a.customer_id) : null;
  const d = a.draft ? JSON.parse(a.draft) : {};
  const e = q.get('SELECT name,code FROM users WHERE id=?', a.employee_id);
  return { id: a.id, ref: a.ref, status: a.status, amount: a.amount ?? d.amount ?? null, customerName: c?.name ?? d.name ?? null, customerRef: c?.ref ?? null,
    employeeName: e?.name, employeeCode: e?.code, submittedAt: a.submitted_at, updatedAt: a.updated_at, createdAt: a.created_at, productId: a.product_id,
    docs: q.get(`SELECT COUNT(*) c FROM documents WHERE application_id=? AND status<>'SUPERSEDED'`, a.id).c,
    pendingDocs: q.get(`SELECT COUNT(*) c FROM documents WHERE application_id=? AND status IN ('PENDING_REVIEW','REPLACEMENT_REQUESTED')`, a.id).c };
}
route('POST', '/api/applications', { roles: ['EMPLOYEE'] }, ({ user }) => {
  const now = Date.now(); const id = Number(q.run(`INSERT INTO applications(employee_id,status,draft,created_at,updated_at) VALUES(?,'DRAFT','{}',?,?)`, user.id, now, now).lastInsertRowid);
  audit(user.id, 'DRAFT_CREATED', 'application', id); return { id };
});
route('PUT', '/api/applications/:id/draft', { roles: ['EMPLOYEE'] }, ({ user, params, body }) => {
  const a = S.getApp(user, params.id); if (a.status !== 'DRAFT') throw conflict('Only a draft can be edited this way.');
  const old = JSON.parse(a.draft || '{}'); const next = body.form || {};
  if (old.mobile && next.mobile && old.mobile !== next.mobile) q.run('DELETE FROM otps WHERE application_id=?', a.id); // changed number must be re-verified
  q.run('UPDATE applications SET draft=?, updated_at=? WHERE id=?', JSON.stringify(next).slice(0, 20000), Date.now(), a.id);
  return { ok: true };
});
route('DELETE', '/api/applications/:id', { roles: ['EMPLOYEE'] }, ({ user, params }) => {
  const a = S.getApp(user, params.id); if (a.status !== 'DRAFT') throw conflict('Only drafts can be discarded.');
  S.transition(a, 'CANCELLED', user, 'Draft discarded'); return { ok: true };
});
route('GET', '/api/applications', { roles: ANY }, ({ user, query }) => {
  let rows = q.all('SELECT * FROM applications ORDER BY updated_at DESC').filter(a => S.canSeeApp(user, a));
  if (query.status) rows = rows.filter(a => a.status === query.status);
  if (query.draft === '1') rows = rows.filter(a => a.status === 'DRAFT'); else if (query.draft !== 'all') rows = rows.filter(a => a.status !== 'DRAFT');
  if (query.queue === 'accounts') rows = rows.filter(a => ['SUBMITTED_TO_ACCOUNTS', 'ACCOUNTS_VERIFICATION'].includes(a.status));
  if (query.queue === 'admin') rows = rows.filter(a => ['PENDING_ADMIN_REVIEW', 'PHYSICAL_VERIFICATION', 'FINAL_ADMIN_REVIEW', 'APPROVED', 'READY_FOR_DISBURSEMENT'].includes(a.status));
  return { applications: rows.map(appRow) };
});
function appDetail(user, a) {
  const c = a.customer_id ? q.get('SELECT * FROM customers WHERE id=?', a.customer_id) : null;
  const draft = JSON.parse(a.draft || '{}'); const product = a.product_id ? q.get('SELECT * FROM products WHERE id=?', a.product_id) : null;
  const detail = { application: { ...appRow(a), term: a.term, frequency: a.frequency, returnTo: a.return_to, docReviewDone: !!a.doc_review_done, ruleVersion: a.rule_version,
      bank: a.customer_id ? { holder: a.bank_holder, bankName: a.bank_name, account: user.role === 'EMPLOYEE' || user.role === 'CUSTOMER' ? D.V.mask(dec(a.bank_account)) : dec(a.bank_account), ifsc: a.bank_ifsc } : null,
      eligibility: a.eligibility ? JSON.parse(a.eligibility) : null, draft: a.status === 'DRAFT' ? draft : undefined },
    customer: maskCustomer(c, user.role), product: product ? prodOut(product) : null };
  if (user.role === 'CUSTOMER') { // customers see status, loan terms and a plain-language timeline only
    detail.timeline = q.all('SELECT to_status,at FROM timeline WHERE application_id=? ORDER BY id', a.id); delete detail.application.employeeName; delete detail.application.employeeCode; delete detail.application.eligibility; delete detail.application.bank; return detail; }
  detail.timeline = q.all(`SELECT t.*, u.name user_name, u.role user_role FROM timeline t LEFT JOIN users u ON u.id=t.user_id WHERE application_id=? ORDER BY t.id`, a.id);
  detail.documents = q.all(`SELECT d.id,d.type,d.original_name,d.mime,d.size,d.uploaded_at,d.status,d.comment,d.version,d.requested_note,u.name uploaded_by_name,r.name reviewed_by_name,d.reviewed_at
    FROM documents d LEFT JOIN users u ON u.id=d.uploaded_by LEFT JOIN users r ON r.id=d.reviewed_by WHERE d.application_id=? ORDER BY d.type, d.version DESC`, a.id);
  detail.verifications = q.all(`SELECT v.*, u.name verifier_name FROM verifications v LEFT JOIN users u ON u.id=v.verifier_id WHERE application_id=? ORDER BY v.id`, a.id)
    .map(v => ({ ...v, checklist: v.checklist ? JSON.parse(v.checklist) : null }));
  detail.loan = q.get('SELECT id,ref,status FROM loans WHERE application_id=?', a.id) || null;
  detail.allowedActions = [...Object.keys(D.T[a.status] || {})].filter(to => D.checkTransition(a.status, to, user.role).ok);
  return detail;
}
route('GET', '/api/applications/:id', { roles: ANY }, ({ user, params }) => appDetail(user, S.getApp(user, params.id)));

route('POST', '/api/estimate', { roles: ['EMPLOYEE', 'ADMIN', 'ACCOUNTS'] }, ({ body }) => {
  const p = q.get('SELECT * FROM products WHERE id=?', int(body.productId)); if (!p || !S.productUsable(p)) throw bad('Choose an available loan product.');
  const amount = int(body.amount); if (!amount || amount <= 0) throw bad('Enter the requested amount.');
  const term = int(body.term) || p.term; if (term > p.term) throw bad(`Term cannot exceed ${p.term} instalments for this product.`);
  const freq = p.frequency; const sched = D.buildSchedule({ principal: amount, rateBps: p.rate_bps, ratePeriod: p.rate_period, method: p.method, term, frequency: freq, firstDueDate: S.today() });
  const interest = sched.reduce((a, l) => a + l.interest, 0);
  return { provisional: true, note: 'Provisional estimate. Final terms apply only after Admin approval.', min: p.min_amount, max: p.max_amount, processingFee: D.processingFee(amount, p.fee_bps),
    totalInterest: interest, totalRepayment: amount + interest, instalment: sched[0].principal + sched[0].interest, instalments: term, frequency: freq,
    rateBps: p.rate_bps, ratePeriod: p.rate_period, method: p.method, feeBps: p.fee_bps };
});
route('POST', '/api/applications/:id/eligibility', { roles: ['EMPLOYEE'] }, ({ user, params, body }) => {
  const a = S.getApp(user, params.id); const f = body.form || {}; const p = q.get('SELECT * FROM products WHERE id=?', int(f.productId));
  if (!p) throw bad('Choose a loan product first.');
  if (!f.dob || !int(f.income) || !int(f.amount)) throw bad('Date of birth, income and amount are needed to check eligibility.');
  return { ...S.runEligibility({ ...f, mobile: f.mobile || '' }, p), preliminary: true };
});

// ---- OTP ----
route('POST', '/api/applications/:id/otp/send', { roles: ['EMPLOYEE'] }, async ({ user, params, body }) => {
  const a = S.getApp(user, params.id); if (a.status !== 'DRAFT') throw conflict('OTP is only needed while the application is a draft.');
  const mobile = str(body.mobile, 15); if (!D.V.mobile(mobile)) throw bad('Enter a valid 10-digit Indian mobile number.');
  const recent = q.all('SELECT * FROM otps WHERE application_id=? AND created_at>? ORDER BY id DESC', a.id, Date.now() - 3600e3);
  if (recent.length >= 5) throw new H.ApiError(429, 'Resend limit reached (5 per hour). Try again later.');
  if (recent[0] && Date.now() - recent[0].created_at < 30e3) throw new H.ApiError(429, 'Please wait 30 seconds before requesting another code.');
  const code = String(crypto.randomInt(100000, 1000000)); const ref = 'OTP' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const result = await sms.sendOtp(mobile, code);
  q.run('INSERT INTO otps(application_id,mobile,code_hash,ref,expires_at,created_at,demo) VALUES(?,?,?,?,?,?,?)', a.id, mobile, crypto.createHash('sha256').update(code + ref).digest('hex'), ref, Date.now() + 5 * 60e3, Date.now(), result.demo ? 1 : 0);
  audit(user.id, 'OTP_SENT', 'application', a.id, `ref ${ref} provider ${result.provider}`);
  return { ref, expiresInSeconds: 300, ...(result.demo ? { demo: true, demoCode: code, label: 'DEMO MODE: this code is shown only because demo mode is on. Real SMS is not sent.' } : {}) };
});
route('POST', '/api/applications/:id/otp/verify', { roles: ['EMPLOYEE'] }, ({ user, params, body }) => {
  const a = S.getApp(user, params.id); const mobile = str(body.mobile, 15);
  const o = q.get('SELECT * FROM otps WHERE application_id=? AND mobile=? AND verified_at IS NULL ORDER BY id DESC LIMIT 1', a.id, mobile);
  if (!o) throw bad('No code has been sent to this number. Request a new code.');
  if (o.expires_at < Date.now()) throw bad('This code has expired. Request a new one.');
  if (o.attempts >= 5) throw bad('Too many wrong attempts. Request a new code.');
  if (crypto.createHash('sha256').update(str(body.code, 10) + o.ref).digest('hex') !== o.code_hash) {
    q.run('UPDATE otps SET attempts=attempts+1 WHERE id=?', o.id); throw bad('Incorrect code.'); }
  q.run('UPDATE otps SET verified_at=? WHERE id=?', Date.now(), o.id); audit(user.id, 'OTP_VERIFIED', 'application', a.id, `ref ${o.ref}`);
  return { verified: true, ref: o.ref, demo: !!o.demo };
});

// ---- Documents ----
const EMP_UPLOAD = ['DRAFT', 'ADDITIONAL_DOCUMENTS_REQUIRED', 'SIGNED_DOCUMENT_PENDING'];
route('POST', '/api/applications/:id/documents', { roles: ['EMPLOYEE', 'ADMIN'] }, ({ user, params, body }) => {
  const a = S.getApp(user, params.id);
  const type = str(body.type); if (!['PROFILE_PHOTO', 'VOTER_ID', 'PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'ADDRESS_PROOF', 'INCOME_PROOF', 'BANK_PROOF', 'SIGNED_AGREEMENT', 'FIELD_VERIFICATION_PHOTO', 'ADDITIONAL', 'OTHER'].includes(type)) throw bad('Unknown document type.');
  if (user.role === 'EMPLOYEE' && !EMP_UPLOAD.includes(a.status)) throw conflict('Documents cannot be added at this stage.');
  if (user.role === 'EMPLOYEE' && type === 'FIELD_VERIFICATION_PHOTO' && a.status !== 'PHYSICAL_VERIFICATION') throw forbidden();
  if (user.role === 'ADMIN' && !(a.status === 'PHYSICAL_VERIFICATION' && type === 'FIELD_VERIFICATION_PHOTO')) throw forbidden('Admins can only add field photographs during physical verification.');
  if (type === 'SIGNED_AGREEMENT' && a.status !== 'SIGNED_DOCUMENT_PENDING' && a.status !== 'ADDITIONAL_DOCUMENTS_REQUIRED') throw conflict('Signed documents are uploaded after Admin asks for them.');
  const key = str(body.uploadKey, 80); if (key) { const dup = q.get('SELECT id FROM documents WHERE upload_key=?', key); if (dup) return { id: dup.id, duplicate: true }; }
  const f = H.saveFile(body.data, str(body.mime, 50));
  return tx(() => {
    const prev = q.get(`SELECT * FROM documents WHERE application_id=? AND type=? AND status<>'SUPERSEDED' ORDER BY version DESC LIMIT 1`, a.id, type);
    if (prev && type !== 'ADDITIONAL' && type !== 'OTHER') q.run(`UPDATE documents SET status='SUPERSEDED' WHERE id=?`, prev.id); // history is kept
    const id = Number(q.run(`INSERT INTO documents(application_id,customer_id,type,file_id,original_name,mime,size,uploaded_by,uploaded_at,version,upload_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      a.id, a.customer_id, type, f.id, str(body.name, 120) || null, body.mime, f.size, user.id, Date.now(), prev && type !== 'ADDITIONAL' && type !== 'OTHER' ? prev.version + 1 : 1, key || null).lastInsertRowid);
    if (user.role === 'ADMIN') q.run(`UPDATE documents SET status='VERIFIED', reviewed_by=?, reviewed_at=? WHERE id=?`, user.id, Date.now(), id); // captured by the verifier themselves
    audit(user.id, prev ? 'DOCUMENT_REPLACED' : 'DOCUMENT_UPLOADED', 'document', id, `${type} for application ${a.id}`);
    return { id, duplicate: false };
  });
});
route('GET', '/api/documents/:id/file', { roles: STAFF }, ({ user, params, res }) => {
  const d = q.get('SELECT * FROM documents WHERE id=?', Number(params.id)); if (!d) throw notFound();
  S.getApp(user, d.application_id); audit(user.id, 'DOCUMENT_VIEWED', 'document', d.id);
  res.sendRaw(200, H.readFile(d.file_id), d.mime, { 'cache-control': 'private, no-store', 'content-disposition': 'inline', 'x-content-type-options': 'nosniff' });
});
route('POST', '/api/documents/:id/review', { roles: ['ADMIN'] }, ({ user, params, body }) => {
  const d = q.get('SELECT * FROM documents WHERE id=?', Number(params.id)); if (!d) throw notFound();
  const s = { VERIFY: 'VERIFIED', REJECT: 'REJECTED', REQUEST_REPLACEMENT: 'REPLACEMENT_REQUESTED' }[body.action]; if (!s) throw bad('Invalid action.');
  if (s !== 'VERIFIED' && !str(body.comment)) throw bad('Enter a reason.');
  if (d.status === 'SUPERSEDED') throw conflict('This version has been replaced.');
  q.run('UPDATE documents SET status=?, comment=?, reviewed_by=?, reviewed_at=? WHERE id=?', s, str(body.comment, 500) || null, user.id, Date.now(), d.id);
  audit(user.id, 'DOCUMENT_' + s, 'document', d.id, str(body.comment)); return { ok: true };
});

// ---- Submit (employee) ----
route('POST', '/api/applications/:id/submit', { roles: ['EMPLOYEE'] }, ({ user, params }) => {
  return tx(() => {
    const a = S.getApp(user, params.id); if (a.status !== 'DRAFT') throw conflict('This application has already been submitted.');
    const f = JSON.parse(a.draft || '{}'); const errs = [];
    const need = (k, label) => { if (!str(f[k])) errs.push(`${label} is required.`); };
    need('name', 'Customer name'); need('dob', 'Date of birth'); need('address', 'Address'); need('occupation', 'Occupation');
    if (!D.V.mobile(f.mobile)) errs.push('A valid mobile number is required.');
    if (!str(f.dob) || D.ageOn(f.dob, S.today()) < 18) errs.push('Customer must be at least 18 years old.');
    if (!int(f.income) || f.income <= 0) errs.push('Monthly income is required.');
    if (!Number.isInteger(f.adults) || f.adults < 0) errs.push('Number of adult family members is required.');
    if (!Number.isInteger(f.children) || f.children < 0) errs.push('Number of children is required.');
    if (!D.V.voter(f.voter)) errs.push('A valid Voter ID number is required (3 letters + 7 digits).');
    if (f.pan && !D.V.pan(f.pan)) errs.push('PAN format is invalid.');
    if (f.aadhaar && !D.V.aadhaar(f.aadhaar)) errs.push('Aadhaar number format is invalid.');
    const bank = f.bank || {};
    if (!str(bank.holder) || !str(bank.bankName)) errs.push('Bank account holder and bank name are required.');
    if (!D.V.account(bank.account)) errs.push('Bank account number must be 9-18 digits.');
    if (bank.account !== bank.confirmAccount) errs.push('Bank account numbers do not match.');
    if (!D.V.ifsc(bank.ifsc)) errs.push('IFSC code is invalid.');
    const p = q.get('SELECT * FROM products WHERE id=?', int(f.productId));
    if (!p || !S.productUsable(p)) errs.push('Select an available loan product.');
    else if (!int(f.amount) || f.amount < p.min_amount || f.amount > p.max_amount) errs.push(`Loan amount must be between ${D.rupees(p.min_amount)} and ${D.rupees(p.max_amount)}.`);
    const docs = q.all(`SELECT type FROM documents WHERE application_id=? AND status NOT IN ('SUPERSEDED','REJECTED')`, a.id).map(d => d.type);
    for (const [t, l] of [['PROFILE_PHOTO', 'Customer photograph'], ['VOTER_ID', 'Voter ID document']]) if (!docs.includes(t)) errs.push(`${l} is required.`);
    if (f.aadhaar) for (const [t, l] of [['AADHAAR_FRONT', 'Aadhaar front'], ['AADHAAR_BACK', 'Aadhaar back']]) if (!docs.includes(t)) errs.push(`${l} is required when an Aadhaar number is given.`);
    const otp = q.get('SELECT * FROM otps WHERE application_id=? AND mobile=? AND verified_at IS NOT NULL ORDER BY id DESC LIMIT 1', a.id, f.mobile);
    if (!otp) errs.push('Mobile number has not been verified by OTP.');
    else if (Date.now() - otp.verified_at > 24 * 3600e3) errs.push('OTP verification has expired. Verify the mobile number again.');
    if (errs.length) throw new H.ApiError(422, 'Please fix the following before submitting:\n- ' + errs.join('\n- '));
    const elig = S.runEligibility(f, p);
    let c = q.get('SELECT * FROM customers WHERE mobile=?', f.mobile);
    if (c && (c.dob !== f.dob || c.name.toLowerCase() !== str(f.name).toLowerCase())) throw conflict('This mobile number is already registered to a different customer.');
    if (!c) {
      const ref = nextRef('CU');
      const cid = Number(q.run(`INSERT INTO customers(ref,name,dob,mobile,address,pan,voter,aadhaar,occupation,adults,children,income,assigned_to,mobile_verified_at,otp_ref,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ref, str(f.name), f.dob, f.mobile, str(f.address, 500), enc(f.pan?.toUpperCase()), enc(f.voter.toUpperCase()), enc(f.aadhaar?.replace(/\s/g, '')),
        str(f.occupation), f.adults, f.children, f.income, user.id, otp.verified_at, otp.ref, user.id, Date.now()).lastInsertRowid);
      c = q.get('SELECT * FROM customers WHERE id=?', cid);
    } else q.run('UPDATE customers SET address=?, occupation=?, income=?, adults=?, children=?, mobile_verified_at=?, otp_ref=? WHERE id=?', str(f.address, 500), str(f.occupation), f.income, f.adults, f.children, otp.verified_at, otp.ref, c.id);
    const ref = nextRef('AP'); const term = Math.min(int(f.term) || p.term, p.term);
    q.run(`UPDATE applications SET ref=?, customer_id=?, product_id=?, amount=?, term=?, frequency=?, bank_holder=?, bank_name=?, bank_account=?, bank_ifsc=?, eligibility=?, rule_version=?, submitted_at=?, draft=NULL WHERE id=?`,
      ref, c.id, p.id, f.amount, term, p.frequency, str(bank.holder), str(bank.bankName), enc(bank.account), bank.ifsc.toUpperCase(), JSON.stringify(elig), elig.ruleVersion, Date.now(), a.id);
    q.run('UPDATE documents SET customer_id=? WHERE application_id=?', c.id, a.id);
    a.ref = ref; S.transition(a, 'SUBMITTED_TO_ACCOUNTS', user, 'Application submitted', ref);
    notifyRole('ACCOUNTS', 'APPLICATION', 'New application awaiting verification', `${ref} for ${c.name}, ${D.rupees(f.amount)}`, 'application', a.id);
    return { id: a.id, ref, eligibility: elig };
  });
});

// ---- Employee: resubmit / signed upload / cancel ----
route('POST', '/api/applications/:id/resubmit', { roles: ['EMPLOYEE'] }, ({ user, params, body }) => {
  const a = S.getApp(user, params.id); if (a.status !== 'ADDITIONAL_DOCUMENTS_REQUIRED') throw conflict('Nothing is waiting on additional documents.');
  const pend = q.get(`SELECT COUNT(*) c FROM documents WHERE application_id=? AND status IN ('REPLACEMENT_REQUESTED','REJECTED')`, a.id).c;
  if (pend) throw bad('Upload replacements for every rejected or replacement-requested document first.');
  const to = a.return_to || 'ACCOUNTS_VERIFICATION'; S.transition(a, to, user, str(body.comment) || 'Requested documents provided');
  notifyRole(to === 'ACCOUNTS_VERIFICATION' ? 'ACCOUNTS' : 'ADMIN', 'DOCUMENT', 'Additional documents received', `${a.ref}: documents uploaded by the employee.`, 'application', a.id); return { ok: true, status: to };
});
route('POST', '/api/applications/:id/signed-submit', { roles: ['EMPLOYEE'] }, ({ user, params }) => {
  const a = S.getApp(user, params.id); if (a.status !== 'SIGNED_DOCUMENT_PENDING') throw conflict('Signed documents are not being requested for this application.');
  if (!q.get(`SELECT 1 x FROM documents WHERE application_id=? AND type='SIGNED_AGREEMENT' AND status NOT IN ('SUPERSEDED','REJECTED')`, a.id)) throw bad('Upload the signed agreement first.');
  S.transition(a, 'FINAL_ADMIN_REVIEW', user, 'Signed document uploaded'); notifyRole('ADMIN', 'DOCUMENT', 'Signed document uploaded', `${a.ref} is ready for final review.`, 'application', a.id); return { ok: true };
});
route('POST', '/api/applications/:id/cancel', { roles: ['EMPLOYEE', 'ADMIN'] }, ({ user, params, body }) => {
  const a = S.getApp(user, params.id); if (!str(body.reason)) throw bad('Enter a reason for cancelling.');
  S.transition(a, 'CANCELLED', user, str(body.reason)); notify(a.employee_id, 'APPLICATION', 'Application cancelled', `${a.ref || 'Draft'} was cancelled.`, 'application', a.id); return { ok: true };
});

// ---- Accounts ----
route('POST', '/api/applications/:id/accounts/start', { roles: ['ACCOUNTS'] }, ({ user, params }) => {
  const a = S.getApp(user, params.id); if (a.status === 'ACCOUNTS_VERIFICATION') return { ok: true }; S.transition(a, 'ACCOUNTS_VERIFICATION', user, 'Verification started'); return { ok: true };
});
route('POST', '/api/applications/:id/accounts/call', { roles: ['ACCOUNTS'] }, ({ user, params, body }) => {
  const a = S.getApp(user, params.id); if (a.status !== 'ACCOUNTS_VERIFICATION') throw conflict('Start verification first.');
  if (!['CONFIRMED', 'NOT_REACHABLE', 'MISMATCH'].includes(body.outcome)) throw bad('Choose the call result.'); if (!str(body.comment)) throw bad('Enter call notes.');
  q.run('INSERT INTO verifications(application_id,kind,verifier_id,outcome,comment,at) VALUES(?,?,?,?,?,?)', a.id, 'CALL', user.id, body.outcome, str(body.comment, 1000), Date.now());
  audit(user.id, 'CALL_VERIFICATION', 'application', a.id, body.outcome); return { ok: true };
});
route('POST', '/api/applications/:id/accounts/decision', { roles: ['ACCOUNTS'] }, ({ user, params, body }) => {
  return tx(() => {
    const a = S.getApp(user, params.id); if (a.status !== 'ACCOUNTS_VERIFICATION') throw conflict('Start verification first.');
    const comment = str(body.comment, 1000);
    if (body.decision === 'APPROVE') {
      if (!q.get(`SELECT 1 x FROM verifications WHERE application_id=? AND kind='CALL' AND outcome='CONFIRMED'`, a.id)) throw bad('Record a confirmed call verification before approving.');
      S.transition(a, 'PENDING_ADMIN_REVIEW', user, comment || 'Accounts verification approved');
      notifyRole('ADMIN', 'APPLICATION', 'Application awaiting review', `${a.ref} passed Accounts verification.`, 'application', a.id);
      notify(a.employee_id, 'VERIFICATION', 'Accounts verification completed', `${a.ref} moved to Admin review.`, 'application', a.id);
    } else if (body.decision === 'REJECT') {
      if (!comment) throw bad('Enter a reason for rejection.'); S.transition(a, 'REJECTED_BY_ACCOUNTS', user, comment);
      notify(a.employee_id, 'APPLICATION', 'Application rejected', `${a.ref} was rejected by Accounts: ${comment}`, 'application', a.id);
    } else if (body.decision === 'REQUEST_INFO') {
      if (!comment) throw bad('Describe the information required.'); q.run('UPDATE applications SET return_to=? WHERE id=?', 'ACCOUNTS_VERIFICATION', a.id);
      S.transition(a, 'ADDITIONAL_DOCUMENTS_REQUIRED', user, comment);
      notify(a.employee_id, 'DOCUMENT', 'Additional documents required', `${a.ref}: ${comment}`, 'application', a.id);
    } else throw bad('Choose a decision.');
    return { ok: true, status: a.status };
  });
});

// ---- Admin stages ----
route('POST', '/api/applications/:id/admin/doc-review', { roles: ['ADMIN'] }, ({ user, params }) => {
  const a = S.getApp(user, params.id); if (a.status !== 'PENDING_ADMIN_REVIEW') throw conflict('Document review applies to applications pending Admin review.');
  const open = q.get(`SELECT COUNT(*) c FROM documents WHERE application_id=? AND status IN ('PENDING_REVIEW','REJECTED','REPLACEMENT_REQUESTED')`, a.id).c;
  if (open) throw bad(`${open} document(s) are not yet verified. Verify them, or request replacements.`);
  q.run('UPDATE applications SET doc_review_done=1 WHERE id=?', a.id); audit(user.id, 'DOC_REVIEW_COMPLETE', 'application', a.id); return { ok: true };
});
route('POST', '/api/applications/:id/admin/start-physical', { roles: ['ADMIN'] }, ({ user, params }) => {
  const a = S.getApp(user, params.id); if (!a.doc_review_done) throw bad('Complete document review first.');
  S.transition(a, 'PHYSICAL_VERIFICATION', user, 'Document review complete; physical verification started');
  notify(a.employee_id, 'VERIFICATION', 'Physical verification status updated', `${a.ref}: document review complete, physical verification in progress.`, 'application', a.id); return { ok: true };
});
route('POST', '/api/applications/:id/admin/physical', { roles: ['ADMIN'] }, ({ user, params, body }) => {
  return tx(() => {
    const a = S.getApp(user, params.id); if (a.status !== 'PHYSICAL_VERIFICATION') throw conflict('Start physical verification first.');
    const c = body.checklist || {}; const keys = ['identity', 'details', 'address', 'documents', 'photo'];
    if (!['PASSED', 'FAILED'].includes(body.outcome)) throw bad('Choose the verification outcome.');
    if (body.outcome === 'PASSED' && !keys.every(k => c[k] === true)) throw bad('Every checklist item must be confirmed before a pass can be recorded.');
    if (!str(body.comment)) throw bad('Enter verification comments.');
    const hasGeo = typeof body.lat === 'number' && typeof body.lng === 'number' && Math.abs(body.lat) <= 90 && Math.abs(body.lng) <= 180;
    if (!hasGeo && !str(body.locationNote)) throw bad('Location is unavailable: record the reason instead. Coordinates are never invented.');
    const photo = q.get(`SELECT id FROM documents WHERE application_id=? AND type='FIELD_VERIFICATION_PHOTO' AND status<>'SUPERSEDED' ORDER BY id DESC LIMIT 1`, a.id);
    if (body.outcome === 'PASSED' && !photo) throw bad('Capture or upload the field verification photograph first.');
    q.run('INSERT INTO verifications(application_id,kind,verifier_id,outcome,comment,checklist,lat,lng,accuracy,location_note,photo_doc_id,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      a.id, 'PHYSICAL', user.id, body.outcome, str(body.comment, 1000), JSON.stringify(c), hasGeo ? body.lat : null, hasGeo ? body.lng : null, hasGeo && typeof body.accuracy === 'number' ? body.accuracy : null,
      hasGeo ? null : str(body.locationNote, 300), photo?.id ?? null, Date.now());
    if (body.outcome === 'PASSED') { S.transition(a, 'SIGNED_DOCUMENT_PENDING', user, 'Physical verification passed');
      notify(a.employee_id, 'DOCUMENT', 'Signed document required', `${a.ref}: print the agreement, get it signed and upload it.`, 'application', a.id); }
    else { S.transition(a, 'REJECTED_BY_ADMIN', user, 'Physical verification failed: ' + str(body.comment));
      notify(a.employee_id, 'APPLICATION', 'Application rejected', `${a.ref} failed physical verification.`, 'application', a.id); }
    return { ok: true, status: a.status };
  });
});
route('POST', '/api/applications/:id/admin/request-documents', { roles: ['ADMIN'] }, ({ user, params, body }) => {
  const a = S.getApp(user, params.id); if (!str(body.note)) throw bad('Describe the documents required.');
  q.run('UPDATE applications SET return_to=? WHERE id=?', a.status, a.id); S.transition(a, 'ADDITIONAL_DOCUMENTS_REQUIRED', user, str(body.note, 500));
  notify(a.employee_id, 'DOCUMENT', 'Additional documents requested', `${a.ref}: ${str(body.note, 200)}`, 'application', a.id); return { ok: true };
});
route('POST', '/api/applications/:id/admin/reject', { roles: ['ADMIN'] }, ({ user, params, body }) => {
  const a = S.getApp(user, params.id); if (!str(body.reason)) throw bad('Enter a reason for rejection.');
  S.transition(a, 'REJECTED_BY_ADMIN', user, str(body.reason, 500)); notify(a.employee_id, 'APPLICATION', 'Application rejected', `${a.ref}: ${str(body.reason, 200)}`, 'application', a.id); return { ok: true };
});
route('POST', '/api/applications/:id/admin/return-signed', { roles: ['ADMIN'] }, ({ user, params, body }) => {
  const a = S.getApp(user, params.id); if (!str(body.reason)) throw bad('Enter a reason.');
  tx(() => { q.run(`UPDATE documents SET status='REJECTED', comment=?, reviewed_by=?, reviewed_at=? WHERE application_id=? AND type='SIGNED_AGREEMENT' AND status NOT IN ('SUPERSEDED')`, str(body.reason, 500), user.id, Date.now(), a.id);
    S.transition(a, 'SIGNED_DOCUMENT_PENDING', user, 'Signed document rejected: ' + str(body.reason, 500)); });
  notify(a.employee_id, 'DOCUMENT', 'Signed document rejected', `${a.ref}: ${str(body.reason, 200)}`, 'application', a.id); return { ok: true };
});
route('POST', '/api/applications/:id/admin/approve', { roles: ['ADMIN'] }, ({ user, params, body }) => {
  return tx(() => {
    const a = S.getApp(user, params.id); if (a.status !== 'FINAL_ADMIN_REVIEW') throw conflict('Final approval applies only at final Admin review.');
    const signed = q.get(`SELECT * FROM documents WHERE application_id=? AND type='SIGNED_AGREEMENT' AND status NOT IN ('SUPERSEDED') ORDER BY id DESC LIMIT 1`, a.id);
    if (!signed) throw bad('No signed agreement has been uploaded.');
    q.run(`UPDATE documents SET status='VERIFIED', reviewed_by=?, reviewed_at=? WHERE id=? AND status='PENDING_REVIEW'`, user.id, Date.now(), signed.id);
    if (q.get(`SELECT 1 x FROM documents WHERE id=? AND status<>'VERIFIED'`, signed.id)) throw bad('The signed agreement was rejected; request a replacement.');
    if (!q.get(`SELECT 1 x FROM verifications WHERE application_id=? AND kind='PHYSICAL' AND outcome='PASSED'`, a.id)) throw bad('Physical verification has not passed.');
    if (q.get(`SELECT COUNT(*) c FROM documents WHERE application_id=? AND status IN ('PENDING_REVIEW','REJECTED','REPLACEMENT_REQUESTED')`, a.id).c) throw bad('Some documents are still unverified.');
    const elig = a.eligibility ? JSON.parse(a.eligibility) : null;
    if (!elig || !elig.eligible) { if (!str(body.overrideReason)) throw bad('Preliminary eligibility is not satisfied. Enter an override reason to approve anyway.'); audit(user.id, 'ELIGIBILITY_OVERRIDE', 'application', a.id, str(body.overrideReason, 500)); }
    const p = q.get('SELECT * FROM products WHERE id=?', a.product_id);
    if (!p.rate_period || !p.method) throw bad('The product has no explicit rate period / interest method configured.');
    const principal = int(body.principal) ?? a.amount; if (!(principal > 0) || principal > a.amount || principal > p.max_amount || principal < Math.min(p.min_amount, a.amount)) throw bad('Approved principal must be positive and not above the requested amount or the product maximum.');
    const fd = str(body.firstDueDate, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(fd) || fd <= S.today()) throw bad('Choose a first instalment date after today.');
    const loan = S.createLoanFromApproval(a, p, user, { principal, firstDueDate: fd });
    S.transition(a, 'APPROVED', user, `Approved ${D.rupees(principal)} (${loan.ref})`, loan.ref);
    S.transition(a, 'READY_FOR_DISBURSEMENT', user, 'All disbursement conditions satisfied', loan.ref);
    audit(user.id, 'LOAN_APPROVED', 'loan', loan.id, `${D.rupees(principal)} ${p.method} ${p.rate_bps}bps/${p.rate_period} fee ${p.fee_bps}bps term ${a.term} ${a.frequency}`);
    const cust = q.get('SELECT name FROM customers WHERE id=?', a.customer_id);
    notify(a.employee_id, 'APPROVAL', 'Final loan approved', `${a.ref} for ${cust.name} approved (${D.rupees(principal)}).`, 'loan', loan.id);
    notify(q.all('SELECT id FROM users WHERE customer_id=?', a.customer_id).map(u => u.id), 'APPROVAL', 'Loan approved', `Your loan of ${D.rupees(principal)} has been approved.`, 'loan', loan.id);
    return { ok: true, loanId: loan.id, loanRef: loan.ref };
  });
});
route('POST', '/api/applications/:id/admin/disburse', { roles: ['ADMIN'] }, ({ user, params, body }) => {
  return tx(() => {
    const a = S.getApp(user, params.id); if (a.status !== 'READY_FOR_DISBURSEMENT') throw conflict('Application is not ready for disbursement.');
    if (!['CASH', 'BANK_TRANSFER', 'UPI', 'OTHER'].includes(body.method)) throw bad('Choose how the money was paid out.');
    if (body.method !== 'CASH' && !str(body.reference)) throw bad('Enter the transfer reference.');
    const loan = q.get('SELECT * FROM loans WHERE application_id=?', a.id);
    q.run(`UPDATE loans SET status='ACTIVE', disbursed_at=?, disbursed_by=?, disbursed_method=?, disbursed_ref=? WHERE id=?`, Date.now(), user.id, body.method, str(body.reference, 100) || null, loan.id);
    S.transition(a, 'DISBURSED', user, `Disbursed via ${body.method}`, loan.ref);
    audit(user.id, 'LOAN_DISBURSED', 'loan', loan.id, `${D.rupees(loan.principal)} via ${body.method}; processing fee ${D.rupees(loan.fee_amount)} deducted at source`);
    notify(a.employee_id, 'APPROVAL', 'Loan disbursed', `${loan.ref} is now active.`, 'loan', loan.id);
    notify(q.all('SELECT id FROM users WHERE customer_id=?', a.customer_id).map(u => u.id), 'APPROVAL', 'Loan active', `Your loan ${loan.ref} is now active.`, 'loan', loan.id);
    return { ok: true, loanId: loan.id };
  });
});
route('GET', '/api/applications/:id/package', { roles: ['EMPLOYEE', 'ACCOUNTS', 'ADMIN'] }, ({ user, params }) => {
  const a = S.getApp(user, params.id); if (a.status === 'DRAFT') throw conflict('Submit the application first.');
  const d = appDetail(user, a); const loan = q.get('SELECT * FROM loans WHERE application_id=?', a.id);
  return { business: 'HS Small Finance', generatedAt: Date.now(), generatedBy: user.name, application: d.application, customer: d.customer, product: d.product,
    terms: loan ? { provisional: false, principal: loan.principal, rateBps: loan.rate_bps, ratePeriod: loan.rate_period, method: loan.method, term: loan.term, frequency: loan.frequency, feeBps: loan.fee_bps, feeAmount: loan.fee_amount, penalty: JSON.parse(loan.penalty) }
      : d.product ? { provisional: true, principal: a.amount, rateBps: d.product.rate_bps, ratePeriod: d.product.rate_period, method: d.product.method, term: a.term, frequency: a.frequency, feeBps: d.product.fee_bps, feeAmount: D.processingFee(a.amount, d.product.fee_bps) } : null,
    checklist: [['Customer photograph', 'PROFILE_PHOTO'], ['Voter ID', 'VOTER_ID'], ['PAN card', 'PAN'], ['Aadhaar front', 'AADHAAR_FRONT'], ['Aadhaar back', 'AADHAAR_BACK'], ['Address proof', 'ADDRESS_PROOF'], ['Income proof', 'INCOME_PROOF'], ['Bank proof', 'BANK_PROOF']]
      .map(([label, t]) => ({ label, present: !!q.get(`SELECT 1 x FROM documents WHERE application_id=? AND type=? AND status NOT IN ('SUPERSEDED','REJECTED')`, a.id, t) })) };
});

// ---- Notifications ----
route('GET', '/api/notifications', { roles: ANY }, ({ user }) => ({ notifications: q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100', user.id),
  unread: q.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', user.id).c }));
route('POST', '/api/notifications/read', { roles: ANY }, ({ user, body }) => { if (body.id) q.run('UPDATE notifications SET read=1 WHERE id=? AND user_id=?', Number(body.id), user.id); else q.run('UPDATE notifications SET read=1 WHERE user_id=?', user.id); return { ok: true }; });

module.exports = { maskCustomer, appRow };
