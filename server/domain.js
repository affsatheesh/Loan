'use strict';
// Pure business rules. Money is integer paise everywhere. Ported from the tested Kotlin domain layer.

const ROLES = ['EMPLOYEE', 'ACCOUNTS', 'ADMIN', 'CUSTOMER'];

const FREQ = { WEEKLY: { n: 12, d: 52 }, FORTNIGHTLY: { n: 12, d: 26 }, MONTHLY: { n: 1, d: 1 } };

function rupees(p) {
  const neg = p < 0; p = Math.abs(p);
  const r = String(Math.floor(p / 100)); const ps = String(p % 100).padStart(2, '0');
  const g = r.length <= 3 ? r : r.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + r.slice(-3);
  return (neg ? '-' : '') + '₹' + g + '.' + ps;
}
function parseRupees(t) {
  const s = String(t ?? '').trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

// ---------- State machine ----------
const T = {
  DRAFT: { SUBMITTED_TO_ACCOUNTS: ['EMPLOYEE'], CANCELLED: ['EMPLOYEE', 'ADMIN'] },
  SUBMITTED_TO_ACCOUNTS: { ACCOUNTS_VERIFICATION: ['ACCOUNTS'], CANCELLED: ['EMPLOYEE', 'ADMIN'] },
  ACCOUNTS_VERIFICATION: {
    PENDING_ADMIN_REVIEW: ['ACCOUNTS'], REJECTED_BY_ACCOUNTS: ['ACCOUNTS'],
    ADDITIONAL_DOCUMENTS_REQUIRED: ['ACCOUNTS'], CANCELLED: ['ADMIN'],
  },
  ADDITIONAL_DOCUMENTS_REQUIRED: {
    ACCOUNTS_VERIFICATION: ['EMPLOYEE'], PENDING_ADMIN_REVIEW: ['EMPLOYEE'],
    PHYSICAL_VERIFICATION: ['EMPLOYEE'], FINAL_ADMIN_REVIEW: ['EMPLOYEE'], CANCELLED: ['EMPLOYEE', 'ADMIN'],
  },
  PENDING_ADMIN_REVIEW: {
    PHYSICAL_VERIFICATION: ['ADMIN'], REJECTED_BY_ADMIN: ['ADMIN'],
    ADDITIONAL_DOCUMENTS_REQUIRED: ['ADMIN'], CANCELLED: ['ADMIN'],
  },
  PHYSICAL_VERIFICATION: {
    SIGNED_DOCUMENT_PENDING: ['ADMIN'], REJECTED_BY_ADMIN: ['ADMIN'],
    ADDITIONAL_DOCUMENTS_REQUIRED: ['ADMIN'], CANCELLED: ['ADMIN'],
  },
  SIGNED_DOCUMENT_PENDING: { FINAL_ADMIN_REVIEW: ['EMPLOYEE'], CANCELLED: ['EMPLOYEE', 'ADMIN'] },
  FINAL_ADMIN_REVIEW: {
    APPROVED: ['ADMIN'], REJECTED_BY_ADMIN: ['ADMIN'], ADDITIONAL_DOCUMENTS_REQUIRED: ['ADMIN'],
    SIGNED_DOCUMENT_PENDING: ['ADMIN'], CANCELLED: ['ADMIN'],
  },
  APPROVED: { READY_FOR_DISBURSEMENT: ['ADMIN'], CANCELLED: ['ADMIN'] },
  READY_FOR_DISBURSEMENT: { DISBURSED: ['ADMIN'], CANCELLED: ['ADMIN'] },
};
function checkTransition(from, to, role) {
  const t = T[from];
  if (!t) return { ok: false, reason: `${from} is a final state; no further changes are allowed.` };
  if (!t[to]) return { ok: false, reason: `Cannot move from ${from} to ${to}.` };
  if (!t[to].includes(role)) return { ok: false, reason: `${role} may not move an application from ${from} to ${to}.` };
  return { ok: true };
}

// ---------- Loan maths ----------
function processingFee(principal, feeBps) { return Math.round(principal * feeBps / 10000); }
function addDays(iso, d) { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }
function addMonths(iso, m) {
  const [y, mo, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1 + m, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last)); return t.toISOString().slice(0, 10);
}
function dueDate(first, i, freq) {
  if (freq === 'WEEKLY') return addDays(first, 7 * i);
  if (freq === 'FORTNIGHTLY') return addDays(first, 14 * i);
  return addMonths(first, i);
}
function monthlyRate(rateBps, period) { const r = rateBps / 10000; return period === 'ANNUAL' ? r / 12 : r; }

function buildSchedule({ principal, rateBps, ratePeriod, method, term, frequency, firstDueDate }) {
  if (!(principal > 0)) throw new Error('Principal must be positive');
  if (!(term > 0) || !Number.isInteger(term)) throw new Error('Term must be at least 1 instalment');
  if (rateBps < 0) throw new Error('Rate cannot be negative');
  if (!FREQ[frequency]) throw new Error('Unknown frequency');
  if (!['ANNUAL', 'MONTHLY'].includes(ratePeriod)) throw new Error('Rate period must be set explicitly');
  if (!['FLAT', 'REDUCING_BALANCE'].includes(method)) throw new Error('Interest method must be set explicitly');
  const mpi = FREQ[frequency].n / FREQ[frequency].d;
  const lines = [];
  if (method === 'FLAT') {
    const totalInterest = Math.round(principal * monthlyRate(rateBps, ratePeriod) * mpi * term);
    const bp = Math.floor(principal / term), bi = Math.floor(totalInterest / term);
    let pl = principal, il = totalInterest;
    for (let k = 1; k <= term; k++) {
      const p = k === term ? pl : bp, i = k === term ? il : bi; pl -= p; il -= i;
      lines.push({ number: k, dueDate: dueDate(firstDueDate, k - 1, frequency), principal: p, interest: i });
    }
  } else {
    const i = monthlyRate(rateBps, ratePeriod) * mpi;
    const emi = i === 0 ? Math.round(principal / term)
      : Math.round(principal * i * Math.pow(1 + i, term) / (Math.pow(1 + i, term) - 1));
    let bal = principal;
    for (let k = 1; k <= term; k++) {
      const interest = Math.round(bal * i);
      const p = k === term ? bal : Math.min(Math.max(emi - interest, 0), bal);
      bal -= p;
      lines.push({ number: k, dueDate: dueDate(firstDueDate, k - 1, frequency), principal: p, interest });
    }
  }
  return lines;
}

// ---------- Allocation: oldest instalment first; penalty, fees, interest, principal ----------
function allocate(amount, balances) {
  if (!(amount > 0)) throw new Error('Amount must be positive');
  let left = amount; const out = [];
  for (const b of [...balances].sort((a, c) => a.number - c.number)) {
    if (left <= 0) break;
    const pen = Math.min(left, b.penalty); left -= pen;
    const fee = Math.min(left, b.fees); left -= fee;
    const int = Math.min(left, b.interest); left -= int;
    const pri = Math.min(left, b.principal); left -= pri;
    if (pen + fee + int + pri > 0) out.push({ instalmentId: b.id, penalty: pen, fees: fee, interest: int, principal: pri });
  }
  return { allocations: out, unallocated: left };
}

// ---------- Penalty: once per overdue instalment, idempotent ----------
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function penaltyFor(terms, due, today, unpaid) {
  if (!terms || !terms.enabled) return 0;
  const days = Math.max(0, daysBetween(due, today));
  if (days <= terms.graceDays || unpaid <= 0) return 0;
  const raw = terms.type === 'FIXED' ? terms.value : Math.round(unpaid * terms.value / 10000);
  return terms.capPaise != null ? Math.min(raw, terms.capPaise) : raw;
}

// ---------- Eligibility ----------
function ageOn(dob, today) {
  const [y, m, d] = dob.split('-').map(Number); const [ty, tm, td] = today.split('-').map(Number);
  let a = ty - y; if (tm < m || (tm === m && td < d)) a--; return a;
}
function evaluateEligibility(rules, inp, today) {
  const checks = [];
  checks.push({ name: 'Loan amount', passed: inp.amount >= inp.productMin && inp.amount <= inp.productMax,
    detail: `Requested ${rupees(inp.amount)}; product allows ${rupees(inp.productMin)} to ${rupees(inp.productMax)}.` });
  if (!rules) {
    checks.push({ name: 'Eligibility rules', passed: false, detail: 'No active eligibility rules configured; result not evaluated.' });
    return { evaluated: false, eligible: false, ruleVersion: null, checks };
  }
  const age = ageOn(inp.dob, today);
  checks.push({ name: 'Age', passed: age >= rules.minAge && age <= rules.maxAge, detail: `Age ${age}; allowed ${rules.minAge} to ${rules.maxAge}.` });
  checks.push({ name: 'Monthly income', passed: inp.income >= rules.minIncome, detail: `Income ${rupees(inp.income)}; minimum ${rupees(rules.minIncome)}.` });
  if (rules.allowedOccupations.length) {
    const ok = rules.allowedOccupations.includes(String(inp.occupation).trim().toLowerCase());
    checks.push({ name: 'Occupation', passed: ok, detail: `Occupation '${inp.occupation}'; allowed: ${rules.allowedOccupations.join(', ')}.` });
  }
  checks.push({ name: 'Existing loans', passed: inp.activeLoans < rules.maxActiveLoans, detail: `${inp.activeLoans} active loan(s); maximum ${rules.maxActiveLoans}.` });
  return { evaluated: true, eligible: checks.every(c => c.passed), ruleVersion: rules.version, checks };
}
function validateRules(r) {
  const p = [];
  if (r.minAge < 18) p.push('Minimum age cannot be below 18.');
  if (r.maxAge < r.minAge) p.push('Maximum age must be at least the minimum age.');
  if (r.minIncome < 0) p.push('Minimum income cannot be negative.');
  if (r.maxActiveLoans < 0) p.push('Maximum active loans cannot be negative.');
  return p;
}

// ---------- Validators ----------
const V = {
  mobile: s => /^[6-9]\d{9}$/.test(String(s || '').trim()),
  ifsc: s => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(s || '').trim().toUpperCase()),
  pan: s => /^[A-Z]{5}\d{4}[A-Z]$/.test(String(s || '').trim().toUpperCase()),
  account: s => /^\d{9,18}$/.test(String(s || '').trim()),
  aadhaar: s => /^[2-9]\d{11}$/.test(String(s || '').replace(/\s/g, '')),
  voter: s => /^[A-Z]{3}\d{7}$/.test(String(s || '').trim().toUpperCase()),
  mask(v, n = 4) { v = String(v || ''); return !v ? '-' : v.length <= n ? v : 'X'.repeat(v.length - n) + v.slice(-n); },
};

module.exports = { ROLES, FREQ, rupees, parseRupees, checkTransition, T, processingFee, buildSchedule, addDays, addMonths,
  allocate, penaltyFor, daysBetween, evaluateEligibility, validateRules, ageOn, V };
