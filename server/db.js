'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.HS_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });
const db = new DatabaseSync(process.env.HS_DB === ':memory:' ? ':memory:' : path.join(DATA_DIR, 'hsfinance.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL, mobile TEXT, email TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE',
  pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 0,
  customer_id INTEGER, failed_logins INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, min_amount INTEGER NOT NULL, max_amount INTEGER NOT NULL,
  rate_bps INTEGER NOT NULL, rate_period TEXT, method TEXT, term INTEGER NOT NULL, frequency TEXT NOT NULL,
  fee_bps INTEGER NOT NULL, penalty_policy_id INTEGER, status TEXT NOT NULL DEFAULT 'INACTIVE',
  effective_from TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS penalty_policies(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, grace_days INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'FIXED', value INTEGER NOT NULL DEFAULT 0, cap_paise INTEGER, effective_from TEXT,
  notes TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS eligibility_rules(
  id INTEGER PRIMARY KEY, version INTEGER NOT NULL, min_age INTEGER NOT NULL, max_age INTEGER NOT NULL,
  min_income INTEGER NOT NULL, occupations TEXT NOT NULL DEFAULT '', max_active_loans INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS customers(
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE, name TEXT NOT NULL, dob TEXT NOT NULL, mobile TEXT NOT NULL, address TEXT NOT NULL,
  pan TEXT, voter TEXT, aadhaar TEXT, occupation TEXT NOT NULL, adults INTEGER, children INTEGER, income INTEGER NOT NULL,
  assigned_to INTEGER, mobile_verified_at INTEGER, otp_ref TEXT, created_by INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS applications(
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE, customer_id INTEGER, product_id INTEGER, employee_id INTEGER NOT NULL,
  status TEXT NOT NULL, amount INTEGER, term INTEGER, frequency TEXT,
  bank_holder TEXT, bank_name TEXT, bank_account TEXT, bank_ifsc TEXT,
  eligibility TEXT, rule_version INTEGER, draft TEXT, return_to TEXT, doc_review_done INTEGER NOT NULL DEFAULT 0,
  submitted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS otps(
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL, mobile TEXT NOT NULL, code_hash TEXT NOT NULL, ref TEXT NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, verified_at INTEGER, created_at INTEGER NOT NULL, demo INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS documents(
  id INTEGER PRIMARY KEY, application_id INTEGER, customer_id INTEGER, type TEXT NOT NULL, file_id TEXT NOT NULL,
  original_name TEXT, mime TEXT, size INTEGER, uploaded_by INTEGER, uploaded_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW', comment TEXT, reviewed_by INTEGER, reviewed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1, upload_key TEXT UNIQUE, requested_note TEXT);
CREATE TABLE IF NOT EXISTS timeline(
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL, from_status TEXT, to_status TEXT, user_id INTEGER,
  at INTEGER NOT NULL, comment TEXT, ref TEXT);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS verifications(
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL, kind TEXT NOT NULL, verifier_id INTEGER, outcome TEXT NOT NULL,
  comment TEXT, checklist TEXT, lat REAL, lng REAL, accuracy REAL, location_note TEXT, photo_doc_id INTEGER, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS loans(
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE, application_id INTEGER UNIQUE, customer_id INTEGER NOT NULL, product_id INTEGER,
  employee_id INTEGER, principal INTEGER NOT NULL, rate_bps INTEGER NOT NULL, rate_period TEXT NOT NULL, method TEXT NOT NULL,
  term INTEGER NOT NULL, frequency TEXT NOT NULL, fee_bps INTEGER NOT NULL, fee_amount INTEGER NOT NULL, penalty TEXT NOT NULL,
  status TEXT NOT NULL, approved_by INTEGER, approved_at INTEGER, disbursed_at INTEGER, disbursed_by INTEGER,
  disbursed_method TEXT, disbursed_ref TEXT, closed_at INTEGER, closed_by TEXT, first_due_date TEXT NOT NULL,
  followup_status TEXT NOT NULL DEFAULT 'NONE', followup_note TEXT);
CREATE TABLE IF NOT EXISTS instalments(
  id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL, number INTEGER NOT NULL, due_date TEXT NOT NULL,
  principal INTEGER NOT NULL, interest INTEGER NOT NULL, fees INTEGER NOT NULL DEFAULT 0, penalty INTEGER NOT NULL DEFAULT 0,
  principal_paid INTEGER NOT NULL DEFAULT 0, interest_paid INTEGER NOT NULL DEFAULT 0, fees_paid INTEGER NOT NULL DEFAULT 0,
  penalty_paid INTEGER NOT NULL DEFAULT 0, penalty_waived INTEGER NOT NULL DEFAULT 0, waiver_reason TEXT,
  UNIQUE(loan_id, number));
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY, receipt_no TEXT UNIQUE, loan_id INTEGER NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL,
  reference TEXT, remarks TEXT, collected_by INTEGER, collected_at INTEGER NOT NULL, device_time TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED', reverses_id INTEGER, reason TEXT, idem_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS payment_allocations(
  id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL, instalment_id INTEGER NOT NULL,
  principal INTEGER NOT NULL, interest INTEGER NOT NULL, fees INTEGER NOT NULL, penalty INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
  entity TEXT, entity_id INTEGER, read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS expenses(
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, category TEXT NOT NULL, amount INTEGER NOT NULL, note TEXT, created_by INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_app_status ON applications(status);
CREATE INDEX IF NOT EXISTS ix_app_emp ON applications(employee_id);
CREATE INDEX IF NOT EXISTS ix_inst_loan ON instalments(loan_id);
CREATE INDEX IF NOT EXISTS ix_pay_loan ON payments(loan_id);
CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(user_id, read);
`);

const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}
function nextRef(prefix, name = prefix) {
  q.run('INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1', name);
  const v = q.get('SELECT value FROM counters WHERE name=?', name).value;
  return `${prefix}-${new Date().getFullYear()}-${String(v).padStart(5, '0')}`;
}
function audit(userId, action, entity, entityId, detail) {
  q.run('INSERT INTO audit(user_id,action,entity,entity_id,detail,at) VALUES(?,?,?,?,?,?)',
    userId ?? null, action, entity ?? null, entityId == null ? null : String(entityId), detail ? String(detail).slice(0, 2000) : null, Date.now());
}
function notify(userIds, type, title, body, entity, entityId) {
  for (const uid of [...new Set([].concat(userIds).filter(Boolean))])
    q.run('INSERT INTO notifications(user_id,type,title,body,entity,entity_id,created_at) VALUES(?,?,?,?,?,?,?)',
      uid, type, title, body ?? null, entity ?? null, entityId ?? null, Date.now());
}
function notifyRole(role, type, title, body, entity, entityId) {
  notify(q.all("SELECT id FROM users WHERE role=? AND status='ACTIVE'", role).map(u => u.id), type, title, body, entity, entityId);
}
module.exports = { db, q, tx, nextRef, audit, notify, notifyRole, DATA_DIR };
