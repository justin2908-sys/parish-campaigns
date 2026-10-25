// What happens when SumUp's answer about a payment link changes: the W10/W11 incident, replayed with SumUp's replies stood in.
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = db.T;
const CAMP = 'camp-w', BLOCK = 'blk-w', ADULT = 'tier-adult', CHILD = 'tier-child';
let sumup, SA, AD, SE;
const reset = () => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-10-05T05:49:00Z');
  T('organizations').push({ id: 'org-A', name: 'Test Parish', gateway_enabled: false, timezone: 'Europe/London' });
  T('campaigns').push({ id: CAMP, org_id: 'org-A', name: 'Walsingham', kind: 'event', active: true, binned: false, is_draft: false, public_page_enabled: true });
  T('ticket_blocks').push({ id: BLOCK, campaign_id: CAMP, type: 'digital', number_prefix: 'W' });
  for (let n = 1; n <= 12; n++) T('tickets').push({ id: 't' + n, campaign_id: CAMP, block_id: BLOCK, ticket_number: n, status: 'unsold', payment_id: null, tier_id: null });
  SA = addUser('u-sa', 'superadmin', 'org-A'); AD = addUser('u-ad', 'admin', 'org-A'); SE = addUser('u-se', 'seller', 'org-A');
  // what SumUp will say about each checkout, and every call made to it
  sumup = { checkouts: {}, calls: [] };
  global.fetch = async (url, opts = {}) => {
    const m = /checkouts\/([^/?]+)/.exec(String(url));
    sumup.calls.push((opts.method || 'GET') + ' ' + (m ? m[1] : url));
    const co = m && sumup.checkouts[m[1]];
    if (!co) return { ok: false, status: 404, json: async () => ({}) };
    if (opts.method === 'DELETE') return co.cancelRefused ? { ok: false, status: 409, json: async () => ({}) } : (co.status = 'EXPIRED', { ok: true, status: 200, json: async () => ({}) });
    return { ok: true, status: 200, json: async () => ({ id: m[1], status: co.status, date: co.date, transactions: co.transactions || [] }) };
  };
};
// a link payment holding the given numbers, created `ageMin` minutes ago
function linkPayment(id, numbers, ageMin) {
  const created = new Date(Date.now() - ageMin * 60000).toISOString();
  T('payments').push({ id, campaign_id: CAMP, method: 'link', status: 'pending', amount: numbers.length * 22, sumup_checkout_id: 'co-' + id, sumup_checkout_ref: 'REF-' + id, created_at: created, sold_at: created,
    ticket_snapshot: numbers.map(n => ({ tier_id: ADULT, block_id: BLOCK, ticket_number: n })), payer_name: 'Buyer ' + id, contact_value: 'x@example.org', seller_id: null });
  for (const n of numbers) Object.assign(T('tickets').find(t => t.ticket_number === n), { status: 'held', payment_id: id, tier_id: ADULT, sold_at: created });
  sumup.checkouts['co-' + id] = { status: 'PENDING', date: created, transactions: [] };
}
const webhook = (id) => call('sumup_webhook', { checkout_id: 'co-' + id });
const payment = (id) => T('payments').find(p => p.id === id);
const ticket = (n) => T('tickets').find(t => t.ticket_number === n);
const SUCCESS = [{ transaction_code: 'TAAA6RM3KPB', id: 'tx1', status: 'SUCCESSFUL' }];

test('a declined first attempt no longer gives the tickets away', async (t) => {
  await t.test('SumUp says FAILED two minutes in: the payment stays pending and W10, W11 stay held', async () => {
    reset(); linkPayment('A', [10, 11], 1);
    sumup.checkouts['co-A'].status = 'FAILED'; clock.set('2026-10-05T05:51:00Z');
    const r = await webhook('A');
    assert.equal(r.body.status, 'pending');
    assert.equal(payment('A').status, 'pending');
    assert.deepEqual([ticket(10).status, ticket(11).status, ticket(10).payment_id], ['held', 'held', 'A']);
    assert.ok(!sumup.calls.some(c => c.startsWith('DELETE')), 'the link is left alone so it can be retried');
  });
  await t.test('…the buyer retries and pays at 05:54: paid, tickets paid, nothing else disturbed (the W10/W11 story, fixed)', async () => {
    reset(); linkPayment('A', [10, 11], 1);
    sumup.checkouts['co-A'].status = 'FAILED'; clock.set('2026-10-05T05:51:00Z'); await webhook('A');
    sumup.checkouts['co-A'].status = 'PAID'; sumup.checkouts['co-A'].transactions = SUCCESS; clock.set('2026-10-05T05:54:00Z');
    await webhook('A');
    assert.equal(payment('A').status, 'paid'); assert.equal(payment('A').sumup_transaction_code, 'TAAA6RM3KPB');
    assert.deepEqual([ticket(10).status, ticket(11).status], ['paid', 'paid']);
    assert.equal(payment('A').attention_note, undefined);
    // and nobody else can now buy them
    assert.equal(T('tickets').filter(x => x.status === 'unsold' && [10, 11].includes(x.ticket_number)).length, 0);
  });
  await t.test('a link still FAILED after its 35 minutes is cancelled at SumUp first, then written off and its online tickets released', async () => {
    reset(); linkPayment('A', [10, 11], 40);
    sumup.checkouts['co-A'].status = 'FAILED';
    const r = await webhook('A');
    assert.equal(r.body.status, 'failed');
    assert.ok(sumup.calls.includes('DELETE co-A'), 'cancelled at SumUp so it can never be paid afterwards');
    assert.deepEqual([ticket(10).status, ticket(11).status, ticket(10).payment_id], ['unsold', 'unsold', null]);
  });
  await t.test('…but if SumUp refuses to cancel because it has just been paid, the payment is recorded as paid and keeps its tickets', async () => {
    reset(); linkPayment('A', [10, 11], 40);
    const co = sumup.checkouts['co-A']; co.status = 'FAILED'; co.cancelRefused = true;
    // the second look at SumUp (after the refused cancel) shows the payment
    let looks = 0; const base = global.fetch;
    global.fetch = async (url, opts = {}) => { const r = await base(url, opts); if (!opts.method) { looks++; if (looks === 2) { co.status = 'PAID'; co.transactions = SUCCESS; } } return r; };
    await webhook('A');
    assert.equal(payment('A').status, 'paid');
    assert.deepEqual([ticket(10).status, ticket(11).status], ['paid', 'paid']);
  });
  await t.test('an EXPIRED report (SumUp itself says the link is dead) still releases online tickets at once, as before', async () => {
    reset(); linkPayment('A', [10, 11], 5);
    sumup.checkouts['co-A'].status = 'EXPIRED';
    assert.equal((await webhook('A')).body.status, 'failed');
    assert.deepEqual([ticket(10).status, ticket(11).status], ['unsold', 'unsold']);
  });
  await t.test('an unpaid PENDING link past 35 minutes is still cancelled and released (unchanged)', async () => {
    reset(); linkPayment('A', [10, 11], 40);
    assert.equal((await webhook('A')).body.status, 'failed');
    assert.ok(sumup.calls.includes('DELETE co-A'));
  });
  await t.test('a normal payment still turns paid and holds its tickets', async () => {
    reset(); linkPayment('A', [10, 11], 2);
    sumup.checkouts['co-A'].status = 'PAID'; sumup.checkouts['co-A'].transactions = SUCCESS;
    assert.equal((await webhook('A')).body.status, 'paid');
    assert.deepEqual([ticket(10).status, ticket(11).status], ['paid', 'paid']);
    assert.equal(payment('A').attention_note, undefined);
  });
});

test('a payment that arrives after its tickets were released', async (t) => {
  // the state the live database was in: payment A written off and its tickets released
  const writtenOff = () => { reset(); linkPayment('A', [10, 11], 5); payment('A').status = 'failed'; for (const n of [10, 11]) Object.assign(ticket(n), { status: 'unsold', payment_id: null, tier_id: null, sold_at: null }); sumup.checkouts['co-A'].status = 'PAID'; sumup.checkouts['co-A'].transactions = SUCCESS; };
  await t.test('nobody else has taken the numbers: the same numbers are put back and the payment is paid', async () => {
    writtenOff();
    await webhook('A');
    assert.equal(payment('A').status, 'paid');
    assert.deepEqual([ticket(10).status, ticket(10).payment_id, ticket(11).status, ticket(11).payment_id, ticket(10).tier_id], ['paid', 'A', 'paid', 'A', ADULT]);
    assert.equal(payment('A').attention_note, undefined);
  });
  await t.test('somebody else has bought them (W10/W11 exactly): the payment is paid, the other buyer keeps the tickets, and it is flagged loudly with the numbers and the SumUp code', async () => {
    writtenOff();
    linkPayment('B', [10, 11], 1); sumup.checkouts['co-B'].status = 'PAID'; sumup.checkouts['co-B'].transactions = [{ transaction_code: 'TAAA6RRECK6', status: 'SUCCESSFUL' }];
    for (const n of [10, 11]) Object.assign(ticket(n), { status: 'paid', payment_id: 'B' });
    await webhook('A');
    assert.equal(payment('A').status, 'paid');
    assert.deepEqual([ticket(10).payment_id, ticket(11).payment_id], ['B', 'B'], 'the second buyer is not disturbed');
    assert.match(payment('A').attention_note, /W10, W11/); assert.match(payment('A').attention_note, /TAAA6RM3KPB/);
    // …and an Admin sees it in Needs Attention
    const r = await call('list_incomplete_payments', {}, { session: AD });
    assert.equal(r.status, 200); assert.equal(r.body.paid_without_tickets.length, 1);
    assert.equal(r.body.paid_without_tickets[0].id, 'A'); assert.deepEqual(r.body.paid_without_tickets[0].tickets, ['Unknown: W10, W11']);
    assert.match(r.body.paid_without_tickets[0].note, /Refund this payment/);
  });
  await t.test('only part of it is gone: the free number is put back, the taken one is flagged', async () => {
    writtenOff();
    Object.assign(ticket(11), { status: 'paid', payment_id: 'someone-else', tier_id: ADULT });
    await webhook('A');
    assert.deepEqual([ticket(10).payment_id, ticket(11).payment_id], ['A', 'someone-else']);
    assert.match(payment('A').attention_note, /W11/); assert.doesNotMatch(payment('A').attention_note, /W10/);
  });
  await t.test('Admin / SuperAdmin / Finance can mark it sorted; a seller cannot; another organisation cannot', async () => {
    writtenOff(); linkPayment('B', [10, 11], 1); for (const n of [10, 11]) Object.assign(ticket(n), { status: 'paid', payment_id: 'B' });
    await webhook('A');
    assert.equal((await call('payment_attention_done', { payment_id: 'A' }, { session: SE })).status, 403);
    T('organizations').push({ id: 'org-B', name: 'Other' }); const other = addUser('u-ob', 'superadmin', 'org-B');
    assert.equal((await call('payment_attention_done', { payment_id: 'A' }, { session: other })).status, 404);
    assert.ok(payment('A').attention_note);
    assert.equal((await call('payment_attention_done', { payment_id: 'A' }, { session: AD })).status, 200);
    assert.ok(payment('A').attention_note, 'the note stays, as the record of what happened');
    assert.ok(payment('A').attention_done_at && payment('A').attention_done_by);
    const after = await call('list_incomplete_payments', {}, { session: AD });
    assert.equal(after.status, 200, after.raw);
    assert.equal(after.body.paid_without_tickets.length, 0);
  });
  await t.test('a payment that was already paid is left alone (the webhook can arrive twice)', async () => {
    reset(); linkPayment('A', [10, 11], 2);
    sumup.checkouts['co-A'].status = 'PAID'; sumup.checkouts['co-A'].transactions = SUCCESS;
    await webhook('A'); const before = JSON.stringify([payment('A'), ticket(10), ticket(11)]);
    await webhook('A');
    assert.equal(JSON.stringify([payment('A'), ticket(10), ticket(11)]), before);
  });
});
