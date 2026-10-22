const test = require('node:test'); const assert = require('node:assert/strict');
const d = require('../server/domain');
const base = { principal: 10000000, ratePeriod: 'ANNUAL', frequency: 'MONTHLY', firstDueDate: '2026-11-01' };

test('flat annual: 26% p.a. on 1,00,000 for 10 months = 21,666.67', () => {
  const s = d.buildSchedule({ ...base, rateBps: 2600, method: 'FLAT', term: 10 });
  assert.equal(s.reduce((a, l) => a + l.principal, 0), 10000000);
  assert.equal(s.reduce((a, l) => a + l.interest, 0), 2166667);
});
test('flat monthly interpretation differs (26% per month)', () => {
  const s = d.buildSchedule({ ...base, ratePeriod: 'MONTHLY', rateBps: 2600, method: 'FLAT', term: 10 });
  assert.equal(s.reduce((a, l) => a + l.interest, 0), 26000000);
});
test('reducing: principal sums exactly, interest falls', () => {
  const s = d.buildSchedule({ ...base, principal: 5000000, rateBps: 2600, method: 'REDUCING_BALANCE', term: 12 });
  assert.equal(s.reduce((a, l) => a + l.principal, 0), 5000000);
  assert.ok(s[0].interest > s[11].interest);
});
test('rate period and method must be explicit', () => {
  assert.throws(() => d.buildSchedule({ ...base, ratePeriod: null, rateBps: 2600, method: 'FLAT', term: 3 }));
  assert.throws(() => d.buildSchedule({ ...base, rateBps: 2600, method: null, term: 3 }));
});
test('fee 8%', () => assert.equal(d.processingFee(10000000, 800), 800000));
test('month-end due dates clamp', () => assert.equal(d.addMonths('2026-01-31', 1), '2026-02-28'));
test('allocation order and overpayment', () => {
  const r = d.allocate(1500, [{ id: 'b', number: 2, penalty: 0, fees: 0, interest: 100, principal: 900 },
    { id: 'a', number: 1, penalty: 50, fees: 0, interest: 100, principal: 900 }]);
  assert.equal(r.unallocated, 0);
  assert.deepEqual(r.allocations[0], { instalmentId: 'a', penalty: 50, fees: 0, interest: 100, principal: 900 });
  assert.equal(r.allocations[1].principal, 350);
  assert.equal(d.allocate(5000, [{ id: 'a', number: 1, penalty: 0, fees: 0, interest: 100, principal: 900 }]).unallocated, 4000);
});
test('penalty policy', () => {
  const fx = { enabled: true, graceDays: 3, type: 'FIXED', value: 20000, capPaise: null };
  assert.equal(d.penaltyFor(null, '2026-10-01', '2026-11-01', 1000), 0);
  assert.equal(d.penaltyFor({ ...fx, enabled: false }, '2026-10-01', '2026-11-01', 1000), 0);
  assert.equal(d.penaltyFor(fx, '2026-10-01', '2026-10-04', 1000), 0);
  assert.equal(d.penaltyFor(fx, '2026-10-01', '2026-10-05', 1000), 20000);
  assert.equal(d.penaltyFor(fx, '2026-10-01', '2026-12-05', 1000), 20000);
  const pc = { enabled: true, graceDays: 0, type: 'PERCENT', value: 500, capPaise: 5000 };
  assert.equal(d.penaltyFor(pc, '2026-10-01', '2026-10-05', 1000000), 5000);
  assert.equal(d.penaltyFor(pc, '2026-10-01', '2026-10-05', 50000), 2500);
});
test('state machine', () => {
  assert.equal(d.checkTransition('FINAL_ADMIN_REVIEW', 'APPROVED', 'EMPLOYEE').ok, false);
  assert.equal(d.checkTransition('FINAL_ADMIN_REVIEW', 'APPROVED', 'ACCOUNTS').ok, false);
  assert.equal(d.checkTransition('FINAL_ADMIN_REVIEW', 'APPROVED', 'ADMIN').ok, true);
  assert.equal(d.checkTransition('REJECTED_BY_ADMIN', 'APPROVED', 'ADMIN').ok, false);
  assert.equal(d.checkTransition('DRAFT', 'PENDING_ADMIN_REVIEW', 'EMPLOYEE').ok, false);
  assert.equal(d.checkTransition('ACCOUNTS_VERIFICATION', 'PENDING_ADMIN_REVIEW', 'ACCOUNTS').ok, true);
});
test('eligibility', () => {
  const rules = { version: 1, minAge: 21, maxAge: 60, minIncome: 1000000, allowedOccupations: [], maxActiveLoans: 1 };
  const inp = { dob: '1990-01-01', income: 2000000, occupation: 'tailor', amount: 2000000, activeLoans: 0, productMin: 500000, productMax: 5000000 };
  assert.equal(d.evaluateEligibility(rules, inp, '2026-10-21').eligible, true);
  assert.equal(d.evaluateEligibility(rules, { ...inp, dob: '2020-01-01' }, '2026-10-21').eligible, false);
  assert.equal(d.evaluateEligibility(rules, { ...inp, activeLoans: 1 }, '2026-10-21').eligible, false);
  const none = d.evaluateEligibility(null, inp, '2026-10-21'); assert.equal(none.evaluated, false); assert.equal(none.eligible, false);
});
test('money + validators', () => {
  assert.equal(d.rupees(12345650), '₹1,23,456.50');
  assert.equal(d.parseRupees('123.45'), 12345); assert.equal(d.parseRupees('12.345'), null); assert.equal(d.parseRupees('-5'), null);
  assert.ok(d.V.mobile('9876543210')); assert.ok(!d.V.mobile('1234567890'));
  assert.ok(d.V.ifsc('sbin0001234')); assert.ok(d.V.pan('ABCDE1234F'));
});
