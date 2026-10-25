// The books check, the check against SumUp, and the other gaps closed after the Walsingham W10/W11 double sale.
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = db.T;
const CAMP = 'camp-w', BLOCK = 'blk-w', PHYS = 'blk-p', ADULT = 'tier-adult', CHILD = 'tier-child';
let SA, AD, FI, SE, OTHER, sumup;
const reset = () => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  db.faults.length = 0;
  clock.set('2026-10-25T12:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'Test Parish' }, { id: 'org-B', name: 'Other Parish' });
  T('campaigns').push({ id: CAMP, org_id: 'org-A', name: 'Walsingham', kind: 'event', active: true, binned: false, is_draft: false, public_page_enabled: true });
  T('tiers').push({ id: ADULT, campaign_id: CAMP, name: 'Adult', price: 22 }, { id: CHILD, campaign_id: CAMP, name: 'Child', price: 10 });
  T('ticket_blocks').push({ id: BLOCK, campaign_id: CAMP, type: 'digital', number_prefix: 'W' }, { id: PHYS, campaign_id: CAMP, type: 'physical', number_prefix: '' });
  for (let n = 1; n <= 12; n++) T('tickets').push({ id: 't' + n, campaign_id: CAMP, block_id: BLOCK, ticket_number: n, status: 'unsold', payment_id: null, tier_id: null });
  for (let n = 101; n <= 106; n++) T('tickets').push({ id: 't' + n, campaign_id: CAMP, block_id: PHYS, ticket_number: n, status: 'unsold', payment_id: null, tier_id: null });
  SA = addUser('u-sa', 'superadmin', 'org-A'); AD = addUser('u-ad', 'admin', 'org-A'); FI = addUser('u-fi', 'finance', 'org-A'); SE = addUser('u-se', 'seller', 'org-A');
  OTHER = addUser('u-ob', 'superadmin', 'org-B');
  sumup = { checkouts: {}, calls: [], created: [] };
  global.fetch = async (url, opts = {}) => {
    const m = /checkouts\/([^/?]+)/.exec(String(url));
    if (opts.method === 'POST' && /\/checkouts$/.test(String(url))) {
      const body = JSON.parse(opts.body), id = 'co-new-' + (sumup.created.length + 1);
      sumup.created.push({ id, body, snapshotThen: JSON.stringify((T('payments').find(p => String(body.checkout_reference).includes(p.id.slice(0, 8).toUpperCase())) || {}).ticket_snapshot || null) });
      sumup.checkouts[id] = { status: 'PENDING', date: new Date().toISOString(), transactions: [] };
      return { ok: true, status: 201, json: async () => ({ id, hosted_checkout_url: 'https://pay.example/' + id }) };
    }
    sumup.calls.push((opts.method || 'GET') + ' ' + (m ? m[1] : url));
    const co = m && sumup.checkouts[m[1]];
    if (!co) return { ok: false, status: 404, json: async () => ({}) };
    if (opts.method === 'DELETE') return co.cancelRefused ? { ok: false, status: 409, json: async () => ({}) } : (co.status = 'EXPIRED', { ok: true, status: 200, json: async () => ({}) });
    return { ok: true, status: 200, json: async () => ({ id: m[1], status: co.status, date: co.date, transactions: co.transactions || [] }) };
  };
};
const pay = (id, o) => { const p = { id, campaign_id: CAMP, method: 'link', status: 'paid', amount: 44, created_at: '2026-10-25T10:00:00Z', sold_at: '2026-10-25T10:00:00Z', sumup_transaction_code: 'TAAA' + id.toUpperCase().padEnd(7, '0').slice(0, 7), sumup_checkout_id: 'co-' + id, ticket_snapshot: [], ...o }; T('payments').push(p); return p; };
const snapOf = (nums, tier = ADULT, block = BLOCK) => nums.map(n => ({ tier_id: tier, block_id: block, ticket_number: n }));
// a paid sale that holds its tickets, as a normal one does
const goodSale = (id, nums, extra) => { pay(id, { amount: nums.length * 22, ticket_snapshot: snapOf(nums), ...extra }); for (const n of nums) Object.assign(T('tickets').find(t => t.ticket_number === n), { status: 'paid', payment_id: id, tier_id: ADULT }); };
const check = (who = AD, body = {}) => call('ledger_check', body, { session: who });
const codes = (r) => r.body.problems.map(p => p.code).sort();

test('The books check', async (t) => {
  await t.test('clean books: nothing wrong, and it says what it looked at', async () => {
    reset(); goodSale('a1', [1, 2]); goodSale('a2', [3]);
    const r = await check();
    assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.deepEqual(r.body.problems, []);
    assert.deepEqual(r.body.checked, { payments: 2, tickets: 3 });
  });
  await t.test('W10/W11 exactly: paid without tickets AND two payments for the same tickets; marking it Sorted clears both', async () => {
    reset();
    goodSale('b2', [10, 11]);   // M, who holds W10 and W11
    pay('a1', { amount: 44, ticket_snapshot: snapOf([10, 11]) });   // J, paid, but holds nothing
    const r = await check();
    assert.equal(r.body.ok, false);
    assert.deepEqual(codes(r), ['paid_without_tickets', 'ticket_sold_twice']);
    assert.match(r.body.problems.find(p => p.code === 'paid_without_tickets').message, /W10, W11/);
    assert.match(r.body.problems.find(p => p.code === 'ticket_sold_twice').message, /W10, W11 are recorded as paid for by 2 different payments/);
    assert.equal((await call('payment_attention_done', { payment_id: 'a1' }, { session: AD })).status, 200);
    const after = await check();
    assert.equal(after.body.ok, true, JSON.stringify(after.body.problems));
  });
  await t.test('a ticket and its payment disagreeing, in each direction', async () => {
    reset();
    goodSale('c1', [1]); T('payments').find(p => p.id === 'c1').status = 'pending';          // ticket paid, payment pending
    goodSale('c2', [2]); T('tickets').find(x => x.ticket_number === 2).status = 'held';       // payment paid, ticket still held
    Object.assign(T('tickets').find(x => x.ticket_number === 3), { status: 'paid', payment_id: null });   // sold with no payment
    Object.assign(T('tickets').find(x => x.ticket_number === 4), { status: 'unsold', payment_id: 'c1' }); // unsold but pointing at a payment
    const r = await check();
    assert.deepEqual(codes(r), ['payment_paid_ticket_not', 'ticket_paid_payment_not', 'ticket_without_payment', 'unsold_with_payment']);
  });
  await t.test('a card payment with no SumUp code, one waiting for hours, and an amount that does not match the tickets', async () => {
    reset();
    goodSale('d1', [1], { sumup_transaction_code: null });
    pay('d2', { status: 'pending', amount: 22, created_at: '2026-10-25T08:00:00Z', ticket_snapshot: snapOf([2]) }); Object.assign(T('tickets').find(x => x.ticket_number === 2), { status: 'held', payment_id: 'd2', tier_id: ADULT });
    goodSale('d3', [3], { amount: 50 });
    assert.deepEqual(codes(await check()), ['amount_mismatch', 'paid_without_code', 'pending_too_long']);
  });
  await t.test('a registration payment, a failed one and a voided one are not mistaken for problems', async () => {
    reset();
    pay('e1', { amount: 15, ticket_snapshot: [] }); T('registrations').push({ id: 'r1', campaign_id: CAMP, payment_id: 'e1', status: 'submitted' });
    pay('e2', { status: 'failed', amount: 44, ticket_snapshot: snapOf([5, 6]), sumup_transaction_code: null });
    pay('e3', { status: 'void', amount: 44, ticket_snapshot: snapOf([7, 8]), sumup_transaction_code: null });
    assert.equal((await check()).body.ok, true);
  });
  await t.test('only Admin, SuperAdmin and Finance; only your own organisation; and a campaign filter', async () => {
    reset(); pay('f1', { ticket_snapshot: snapOf([10, 11]) });
    assert.equal((await check(SE)).status, 403);
    assert.equal((await call('ledger_check', {})).status, 401);
    assert.equal((await check(FI)).body.ok, false); assert.equal((await check(SA)).body.ok, false);
    const other = await check(OTHER); assert.equal(other.status, 200); assert.equal(other.body.ok, true); assert.deepEqual(other.body.checked, { payments: 0, tickets: 0 });
    assert.equal((await check(AD, { campaign_id: 'some-other-campaign' })).status, 404);
    assert.equal((await check(AD, { campaign_id: CAMP })).body.ok, false);
  });
});

test('Paid after the sale was voided', async (t) => {
  await t.test('it is put in Needs Attention (not only a text note); Sorted takes it off but keeps the note', async () => {
    reset();
    pay('v1', { status: 'void', voided: true, void_reason: 'wrong buyer', ticket_snapshot: snapOf([10, 11]), sumup_transaction_code: null });
    sumup.checkouts['co-v1'] = { status: 'PAID', date: '2026-10-25T10:00:00Z', transactions: [{ transaction_code: 'TAAAVOID001', status: 'SUCCESSFUL' }] };
    await call('sumup_webhook', { checkout_id: 'co-v1' });
    const p = T('payments').find(x => x.id === 'v1');
    assert.equal(p.status, 'void'); assert.match(p.void_reason, /WARNING/); assert.match(p.attention_note, /after this sale was voided/); assert.match(p.attention_note, /TAAAVOID001/);
    let r = await call('list_incomplete_payments', {}, { session: AD });
    assert.equal(r.body.paid_without_tickets.length, 1); assert.equal(r.body.paid_without_tickets[0].status, 'void');
    await call('payment_attention_done', { payment_id: 'v1' }, { session: AD });
    r = await call('list_incomplete_payments', {}, { session: AD });
    assert.equal(r.body.paid_without_tickets.length, 0); assert.ok(T('payments').find(x => x.id === 'v1').attention_note);
  });
});

test('A registration whose payment was written off and then paid', async (t) => {
  const setup = (places) => {
    reset(); T('campaigns').find(c => c.id === CAMP).kind = 'registration'; T('campaigns').find(c => c.id === CAMP).places = places;
    pay('g1', { status: 'failed', amount: 15, ticket_snapshot: [], sumup_transaction_code: null });
    T('registrations').push({ id: 'rg1', campaign_id: CAMP, reg_number: 7, payment_id: 'g1', status: 'cancelled', decision_note: 'Payment not completed' });
    sumup.checkouts['co-g1'] = { status: 'PAID', date: '2026-10-25T10:00:00Z', transactions: [{ transaction_code: 'TAAAREG0001', status: 'SUCCESSFUL' }] };
  };
  await t.test('the place is still free: the registration is brought back and is in', async () => {
    setup(5);
    await call('sumup_webhook', { checkout_id: 'co-g1' });
    assert.equal(T('registrations').find(r => r.id === 'rg1').status, 'submitted'); assert.equal(T('registrations').find(r => r.id === 'rg1').decision_note, null);
    assert.equal(T('payments').find(p => p.id === 'g1').attention_note, undefined);
  });
  await t.test('the place has gone to someone else: the payment is paid, the other person is not disturbed, and an Admin is told', async () => {
    setup(1); T('registrations').push({ id: 'rg2', campaign_id: CAMP, reg_number: 8, payment_id: null, status: 'submitted' });
    await call('sumup_webhook', { checkout_id: 'co-g1' });
    assert.equal(T('registrations').find(r => r.id === 'rg1').status, 'cancelled'); assert.equal(T('registrations').find(r => r.id === 'rg2').status, 'submitted');
    assert.match(T('payments').find(p => p.id === 'g1').attention_note, /registration R7/);
  });
});

test('Resending a link', async (t) => {
  const physicalFailed = () => {
    reset();
    pay('h1', { status: 'failed', amount: 22, method: 'link', ticket_snapshot: snapOf([101], ADULT, PHYS), sumup_transaction_code: null, payer_name: 'Buyer', contact_value: 'x@example.org', resend_count: 0 });
    Object.assign(T('tickets').find(x => x.ticket_number === 101), { status: 'held', payment_id: 'h1', tier_id: ADULT });
    sumup.checkouts['co-h1'] = { status: 'FAILED', date: '2026-10-25T08:00:00Z', transactions: [] };
  };
  await t.test('the old link is closed at SumUp before a new one is made, even though it had already been written off', async () => {
    physicalFailed();
    const r = await call('resend_payment', { payment_id: 'h1' }, { session: AD });
    assert.equal(r.status, 200, r.raw);
    const del = sumup.calls.indexOf('DELETE co-h1');
    assert.ok(del >= 0, 'the old checkout was cancelled'); assert.equal(sumup.created.length, 1, 'and one new link was made');
    assert.equal(T('payments').find(p => p.id === 'h1').status, 'pending'); assert.equal(T('payments').find(p => p.id === 'h1').sumup_checkout_id, 'co-new-1');
  });
  await t.test('if the old link turns out to have been paid, no second link is made', async () => {
    physicalFailed();
    const co = sumup.checkouts['co-h1']; co.cancelRefused = true; co.status = 'PAID'; co.transactions = [{ transaction_code: 'TAAAHAD0001', status: 'SUCCESSFUL' }];
    const r = await call('resend_payment', { payment_id: 'h1' }, { session: AD });
    assert.equal(r.status, 400); assert.match(r.body.error, /just come through/);
    assert.equal(sumup.created.length, 0);
  });
});

test('A sale is never left half-saved', async (t) => {
  const sale = (method, who = AD) => call('record_sale', { campaign_id: CAMP, tier_counts: { [ADULT]: 1 }, auto_assign_block_id: PHYS, method, payer_name: 'Yvonne', contact_value: '07726952743', client_ref: 'cr-' + Math.random().toString(36).slice(2, 12), build: '2026-10-20' }, { session: who });
  const freeCount = () => T('tickets').filter(x => x.block_id === PHYS && x.status === 'unsold').length;
  await t.test('a normal link sale: what it is for is written down BEFORE the SumUp link exists', async () => {
    reset();
    const r = await sale('link');
    assert.equal(r.status, 200, r.raw);
    assert.equal(sumup.created.length, 1);
    assert.match(sumup.created[0].snapshotThen, /101/, 'the snapshot was already saved when the link was made');
    assert.equal(T('payments').find(p => p.sumup_checkout_id === 'co-new-1').status, 'pending');
  });
  await t.test('the database refuses the write after the link was made: the link is closed, the tickets freed, the sale voided, nothing charged', async () => {
    reset(); db.faults.push({ table: 'payments', op: 'update', when: (patch) => patch && patch.sumup_checkout_id });
    const r = await sale('link');
    assert.equal(r.status, 500); assert.match(r.body.error, /Nothing has been charged/);
    assert.ok(sumup.calls.includes('DELETE co-new-1'), 'the SumUp link was cancelled so nobody can pay for a sale we have no record of');
    assert.equal(freeCount(), 6, 'tickets freed');
    const p = T('payments')[0]; assert.equal(p.status, 'void'); assert.match(p.void_reason, /could not save the payment link/);
  });
  await t.test('the database refuses to save what the sale was for (before any link exists): no link is made at all', async () => {
    reset(); db.faults.push({ table: 'payments', op: 'update', when: (patch) => patch && patch.ticket_snapshot && !patch.sumup_checkout_id });
    const r = await sale('link');
    assert.equal(r.status, 500); assert.equal(sumup.created.length, 0); assert.equal(freeCount(), 6); assert.equal(T('payments')[0].status, 'void');
  });
  await t.test('a cash sale and a machine sale that cannot be saved are undone too', async () => {
    for (const method of ['cash', 'machine']) {
      reset(); db.faults.push({ table: 'payments', op: 'update' });
      const r = await sale(method);
      assert.equal(r.status, 500, method); assert.equal(freeCount(), 6, method); assert.equal(T('payments')[0].status, 'void', method);
    }
  });
  await t.test('and when nothing fails, cash and machine sales are unchanged', async () => {
    for (const method of ['cash', 'machine']) { reset(); const r = await sale(method); assert.equal(r.status, 200, method); assert.equal(freeCount(), 5, method); }
  });
});

test('Checking against SumUp', async (t) => {
  const csv = [
    'Date,Transaction ID,Description,Amount,Status,Email',
    '5 Oct 2026,TAAA6RM3KPB,Walsingham2026 — tickets W10 W11 · Test Parish,44.00,Successful,j@example.org',
    '5 Oct 2026,TAAA6RRECK6,Walsingham2026 — tickets W10 W11 · Test Parish,32.00,Successful,m@example.org',
    '6 Oct 2026,TAAANEW0001,Walsingham2026 — tickets W20 · Test Parish,22.00,Successful,x@example.org',
    '6 Oct 2026,TAAAMACH002,Card machine sale,5.00,Successful,',
    '7 Oct 2026,TAAAFAIL003,Raffle2026 — tickets O15,2.00,Successful,y@example.org',
  ].join('\n');
  const setup = () => {
    reset();
    goodSale('s1', [10, 11], { sumup_transaction_code: 'TAAA6RRECK6' });
    pay('s2', { amount: 44, ticket_snapshot: snapOf([12]), sumup_transaction_code: 'TAAA6RM3KPB', created_at: '2026-10-05T05:49:00Z' });
    pay('s3', { status: 'failed', amount: 2, sumup_transaction_code: 'TAAAFAIL003' });   // we have it as failed but SumUp took the money
    pay('s4', { amount: 22, sumup_transaction_code: 'TAAAOURS004', created_at: '2026-10-06T09:00:00Z' });   // paid here, absent from SumUp's list
  };
  await t.test('it sorts every SumUp code: matched, taken by SumUp but not recorded, recorded as not paid, and ours that SumUp lacks', async () => {
    setup();
    const r = await call('sumup_reconcile', { text: csv, from: '2026-10-01' }, { session: AD });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.sumup_codes, 5); assert.equal(r.body.matched, 2);
    assert.deepEqual(r.body.not_recorded.map(x => x.code), ['TAAANEW0001']);
    assert.deepEqual(r.body.recorded_as_not_paid.map(x => [x.code, x.status]), [['TAAAFAIL003', 'failed']]);
    assert.deepEqual(r.body.not_in_sumup.map(x => x.code), ['TAAAOURS004']);
    assert.equal(r.body.other_takings, 1, 'the card-machine sale is not one of ours, so it is only counted'); assert.equal(r.body.ok, false);
  });
  await t.test('personal details in the file are masked in what comes back, and nothing is kept', async () => {
    setup();
    const r = await call('sumup_reconcile', { text: csv }, { session: AD });
    assert.doesNotMatch(r.raw, /@example\.org/);
    assert.ok(!JSON.stringify(db.tables).includes('TAAANEW0001'), 'nothing from the file is stored');
  });
  await t.test('everything agrees: ok', async () => {
    reset(); goodSale('z1', [1], { sumup_transaction_code: 'TAAAZ000001', created_at: '2026-10-05T10:00:00Z' });
    const r = await call('sumup_reconcile', { text: 'Id,Desc\nTAAAZ000001,Walsingham2026 — tickets W1' }, { session: FI });
    assert.equal(r.body.ok, true); assert.equal(r.body.matched, 1);
  });
  await t.test('the start date limits which of ours are expected in the list', async () => {
    setup();
    const late = await call('sumup_reconcile', { text: csv, from: '2026-10-07' }, { session: AD });
    assert.deepEqual(late.body.not_in_sumup, []);
  });
  await t.test('an empty file, a file with no codes, a huge one, a bad date, a seller, no login and another organisation', async () => {
    setup();
    assert.equal((await call('sumup_reconcile', { text: '  ' }, { session: AD })).status, 400);
    assert.equal((await call('sumup_reconcile', { text: 'nothing useful here\nat all' }, { session: AD })).status, 400);
    assert.equal((await call('sumup_reconcile', { text: 'x'.repeat(3000001) }, { session: AD })).status, 400);
    assert.equal((await call('sumup_reconcile', { text: csv, from: '2026-13-45' }, { session: AD })).status, 400);
    assert.equal((await call('sumup_reconcile', { text: csv }, { session: SE })).status, 403);
    assert.equal((await call('sumup_reconcile', { text: csv })).status, 401);
    const other = await call('sumup_reconcile', { text: csv }, { session: OTHER });
    assert.equal(other.body.matched, 0, "another organisation's payments are never matched");
  });
  await t.test('headers and long words that merely start with T are not mistaken for codes', async () => {
    setup();
    const r = await call('sumup_reconcile', { text: 'TRANSACTION,TOTAL,TAAA6RM3KPB,TRANSACTIONS\nTAAAFAIL003' }, { session: AD });
    assert.equal(r.body.sumup_codes, 2);
  });
});
