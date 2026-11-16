// A refund can never be more than what was actually paid, and only money actually received can be refunded (2026-11-16).
// The same rule is also enforced inside the database (migration 20261116010000_refund_cap.sql).
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);

test('Refund cap', async (t) => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-16T10:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London' });
  const FI = addUser('u-fi', 'finance', 'org-A'), SA = addUser('u-sa', 'superadmin', 'org-A');
  T('campaigns').push({ id: 'c1', org_id: 'org-A', name: 'Raffle', kind: 'raffle' });
  const pay = (id, status, method, amount = 10) => T('payments').push({ id, campaign_id: 'c1', status, method, amount, refund_amount: null });
  pay('paid-card', 'paid', 'link'); pay('paid-cash', 'paid', 'cash'); pay('pending-cash', 'pending', 'cash'); pay('pending-link', 'pending', 'link'); pay('void', 'void', 'cash');
  const refund = (payment_id, amount, s = FI) => call('record_refund', { payment_id, amount, note: 'refunded in SumUp' }, { session: s });
  const stored = (id) => T('payments').find(p => p.id === id).refund_amount;

  await t.test('more than was paid is refused, whoever asks', async () => {
    for (const s of [FI, SA]) { const r = await refund('paid-card', 10.01, s); assert.equal(r.status, 400, r.raw); }
    assert.equal(stored('paid-card'), null);
  });
  await t.test('zero, negative and nonsense amounts are refused', async () => {
    for (const a of [0, -5, 'abc', '1e9']) assert.equal((await refund('paid-card', a)).status, 400, String(a));
    assert.equal(stored('paid-card'), null);
  });
  await t.test('exactly the amount paid, or part of it, is fine; recording again replaces, never adds up', async () => {
    assert.equal((await refund('paid-card', 4)).status, 200);
    assert.equal(stored('paid-card'), 4);
    assert.equal((await refund('paid-card', 10)).status, 200);
    assert.equal(stored('paid-card'), 10, 'replaced, not 14');
    assert.equal((await refund('paid-card', 10.5)).status, 400);
    assert.equal(stored('paid-card'), 10);
  });
  await t.test('money not yet received cannot be refunded: cash still to reconcile, an unpaid link, a voided sale', async () => {
    for (const id of ['pending-cash', 'pending-link', 'void']) { const r = await refund(id, 5); assert.equal(r.status, 400, id + ' ' + r.raw); assert.equal(stored(id), null, id); }
  });
  await t.test('paid cash can be refunded up to what was paid', async () => {
    assert.equal((await refund('paid-cash', 10.01)).status, 400);
    assert.equal((await refund('paid-cash', 10)).status, 200);
  });
  await t.test('a Seller cannot record a refund at all', async () => {
    const SE = addUser('u-se', 'seller', 'org-A');
    assert.equal((await refund('paid-card', 1, SE)).status, 403);
  });
});
