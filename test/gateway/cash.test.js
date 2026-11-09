// Cash Recon: what a seller is holding (so the Admin can count it against the right figure), and the reconciliation itself.
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
let S, seq = 0;
const iso = (h) => `2026-11-08T${String(h).padStart(2, '0')}:00:00.000Z`;
function reset() {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-09T12:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'St Vincent' }, { id: 'org-B', name: 'Other' });
  S = { adA: addUser('uA-ad', 'admin', 'org-A'), fiA: addUser('uA-fi', 'finance', 'org-A'), seA: addUser('uA-se', 'seller', 'org-A'), saB: addUser('uB-sa', 'superadmin', 'org-B') };
  for (const [id, name, active] of [['sel-mary', 'Mary', true], ['sel-john', 'John', true], ['sel-old', 'Old Seller', false], ['sel-none', 'No Cash', true]]) T('users').push({ id, role: 'seller', org_id: 'org-A', active, name });
  T('users').find(u => u.id === 'uA-ad').name = 'Admin Anne';
  T('users').push({ id: 'sel-b', role: 'seller', org_id: 'org-B', active: true, name: 'B Seller' });
  T('campaigns').push({ id: 'c-raffle', org_id: 'org-A', name: 'Autumn Raffle', binned: false }, { id: 'c-bbq', org_id: 'org-A', name: 'Parish BBQ', binned: false }, { id: 'c-bin', org_id: 'org-A', name: 'Binned', binned: true }, { id: 'c-b', org_id: 'org-B', name: 'B campaign', binned: false });
  T('tiers').push({ id: 't-adult', campaign_id: 'c-bbq', name: 'Adult' }, { id: 't-child', campaign_id: 'c-bbq', name: 'Child' }, { id: 't-r', campaign_id: 'c-raffle', name: 'Ticket' });
  T('ticket_blocks').push({ id: 'b-bbq', campaign_id: 'c-bbq', number_prefix: 'B' }, { id: 'b-r', campaign_id: 'c-raffle', number_prefix: '' });
}
// a cash sale of tickets by a seller
const sale = (seller, campaign, amount, hour, tickets, over) => {
  const id = 'p' + (++seq);
  T('payments').push({ id, campaign_id: campaign, method: 'cash', amount, status: 'pending', seller_id: seller, payer_name: 'Buyer ' + seq, created_at: iso(hour), cash_recon_batch_id: null, ...over });
  (tickets || []).forEach(([tier, block, n]) => T('tickets').push({ id: `${id}-${n}`, campaign_id: campaign, block_id: block, tier_id: tier, ticket_number: n, status: 'cash_pending', payment_id: id }));
  return id;
};
const pend = (seller) => call('cash_pending', seller ? { seller_id: seller } : {}, { session: S.adA });
function stock() {
  sale('sel-mary', 'c-raffle', 5, 9, [['t-r', 'b-r', 11], ['t-r', 'b-r', 12]]);
  sale('sel-mary', 'c-raffle', 2.5, 10, [['t-r', 'b-r', 13]]);
  sale('sel-mary', 'c-bbq', 12, 8, [['t-adult', 'b-bbq', 5], ['t-child', 'b-bbq', 6]]);
  sale('sel-mary', 'c-bbq', 6, 11, [['t-adult', 'b-bbq', 7]]);
  sale('sel-john', 'c-raffle', 20, 9, [['t-r', 'b-r', 21]]);
  sale('sel-old', 'c-bbq', 7.5, 7, [['t-adult', 'b-bbq', 8]]);
  // not holdings: already reconciled, voided, a card sale, an online sale, a binned campaign, another parish
  sale('sel-mary', 'c-raffle', 100, 9, [], { status: 'paid' }); sale('sel-mary', 'c-raffle', 100, 9, [], { status: 'void' }); sale('sel-mary', 'c-raffle', 100, 9, [], { method: 'link' });
  sale(null, 'c-raffle', 100, 9, [], { method: 'link' }); sale('sel-mary', 'c-bin', 100, 9, []); sale('sel-b', 'c-b', 100, 9, []);
}

test('What each seller is holding', async (t) => {
  await t.test('every seller who holds cash, with the total and how many sales, biggest first; a seller with nothing shows £0; a deactivated seller who still holds cash is not lost', async () => {
    reset(); stock();
    const r = await pend();
    assert.equal(r.status, 200, r.raw);
    const rows = r.body.sellers;
    assert.deepEqual(rows.slice(0, 3).map(s => [s.name, s.total, s.count, s.campaigns, s.active]), [['Mary', 25.5, 4, 2, true], ['John', 20, 1, 1, true], ['Old Seller', 7.5, 1, 1, false]]);
    assert.ok(rows.slice(3).every(s => s.total === 0 && s.count === 0) && rows.some(s => s.name === 'No Cash'), 'the rest hold nothing');
    assert.equal(rows.some(s => s.name === 'B Seller'), false);
  });
  await t.test('a seller\'s detail: the total, each campaign, and every sale oldest first with its tickets and a running total', async () => {
    reset(); stock();
    const r = await pend('sel-mary');
    const d = r.body.seller;
    assert.equal(d.name, 'Mary'); assert.equal(d.total, 25.5); assert.equal(d.count, 4);
    assert.deepEqual(d.campaigns.map(c => [c.name, c.total, c.count]), [['Parish BBQ', 18, 2], ['Autumn Raffle', 7.5, 2]]);   // the one with the oldest sale first
    const bbq = d.campaigns[0];
    assert.deepEqual(bbq.sales.map(s => [s.amount, s.running]), [[12, 12], [6, 18]]);
    assert.deepEqual(bbq.sales[0].what, ['Adult: B5', 'Child: B6']); assert.deepEqual(bbq.sales[1].what, ['Adult: B7']);
    const raf = d.campaigns[1];
    assert.deepEqual(raf.sales.map(s => [s.amount, s.running]), [[5, 5], [2.5, 7.5]]); assert.deepEqual(raf.sales[0].what, ['Ticket: 11, 12']);
    assert.ok(bbq.sales[0].created_at < bbq.sales[1].created_at);
  });
  await t.test('only unreconciled cash counts: not paid, voided, card, online, another parish or a binned campaign; and money adds up to the penny', async () => {
    reset();
    for (const a of [0.1, 0.2, 0.3, 1.1, 2.2]) sale('sel-mary', 'c-raffle', a, 9, []);
    sale('sel-mary', 'c-raffle', 5, 9, [], { status: 'paid' });
    assert.equal((await pend('sel-mary')).body.seller.total, 3.9);   // 0.1 + 0.2 + 0.3 + 1.1 + 2.2 without any floating point drift
  });
  await t.test('nothing held: an empty list, not an error', async () => {
    reset();
    const r = await pend('sel-none');
    assert.equal(r.status, 200); assert.deepEqual(r.body.seller.campaigns, []); assert.equal(r.body.seller.total, 0); assert.equal(r.body.seller.count, 0);
  });
  await t.test('what was reconciled with this seller lately, by whom, and how it came out', async () => {
    reset(); stock();
    const first = await call('cash_recon', { seller_id: 'sel-mary', campaign_id: 'c-raffle', amount_received: 7.5 }, { session: S.adA });
    assert.equal(first.status, 200, first.raw);
    const d = (await pend('sel-mary')).body.seller;
    assert.equal(d.total, 18); assert.equal(d.campaigns.length, 1);
    assert.equal(d.recent.length, 1);
    assert.deepEqual([d.recent[0].campaign, d.recent[0].received, d.recent[0].sales, d.recent[0].matched, d.recent[0].by, d.recent[0].surplus, d.recent[0].shortfall], ['Autumn Raffle', 7.5, 2, 7.5, 'Admin Anne', 0, 0]);
  });
  await t.test('who may look: Admin, Superadmin and Finance; not a seller; and only their own parish\'s sellers', async () => {
    reset(); stock();
    assert.equal((await call('cash_pending', {}, { session: S.seA })).status, 403);
    assert.ok((await call('cash_pending', {})).status >= 400);
    assert.equal((await call('cash_pending', {}, { session: S.fiA })).status, 200);
    assert.equal((await call('cash_pending', { seller_id: 'sel-mary' }, { session: S.saB })).status, 404);
    assert.equal((await call('cash_pending', { seller_id: 'sel-b' }, { session: S.adA })).status, 404);
    const b = await call('cash_pending', {}, { session: S.saB });
    assert.ok(b.body.sellers.some(s => s.name === 'B Seller') && b.body.sellers.every(s => s.total === 0 || s.name === 'B Seller'));
    assert.equal(JSON.stringify(b.body).includes('Mary'), false);
  });
});

test('Reconciling', async (t) => {
  await t.test('the amount handed over must be a real amount more than £0', async () => {
    reset(); stock();
    for (const a of ['', null, undefined, 0, -5, 'abc', NaN]) assert.equal((await call('cash_recon', { seller_id: 'sel-mary', campaign_id: 'c-raffle', amount_received: a }, { session: S.adA })).status, 400, String(a));
    assert.equal(T('cash_recon').length, 0);
  });
  await t.test('exactly the expected amount reconciles every sale; a part-payment covers the oldest sales first and says what is short', async () => {
    reset(); stock();
    const ok = await call('cash_recon', { seller_id: 'sel-mary', campaign_id: 'c-bbq', amount_received: 18, expected_pending: 18 }, { session: S.adA });
    assert.equal(ok.status, 200, ok.raw); assert.equal(ok.body.matched_count, 2); assert.equal(ok.body.matched_amount, 18); assert.equal(ok.body.surplus, 0); assert.equal(ok.body.shortfall, 0);
    assert.equal(T('payments').filter(p => p.seller_id === 'sel-mary' && p.campaign_id === 'c-bbq' && p.status === 'paid' && p.cash_recon_batch_id).length, 2);
    reset(); stock();
    const part = await call('cash_recon', { seller_id: 'sel-mary', campaign_id: 'c-bbq', amount_received: 14, expected_pending: 18 }, { session: S.adA });
    assert.equal(part.body.matched_count, 1); assert.equal(part.body.matched_amount, 12); assert.equal(part.body.shortfall, 2); assert.equal(part.body.still_pending.length, 1);
    reset(); stock();
    const over = await call('cash_recon', { seller_id: 'sel-mary', campaign_id: 'c-bbq', amount_received: 20, expected_pending: 18 }, { session: S.adA });
    assert.equal(over.body.matched_count, 2); assert.equal(over.body.surplus, 2); assert.equal(over.body.shortfall, 0);
  });
  await t.test('if the cash held has changed since the screen was opened (another sale, a void), reconciling stops and says what it is now', async () => {
    reset(); stock();
    sale('sel-mary', 'c-bbq', 3, 12, []);   // sold after the Admin opened the screen
    const r = await call('cash_recon', { seller_id: 'sel-mary', campaign_id: 'c-bbq', amount_received: 18, expected_pending: 18 }, { session: S.adA });
    assert.equal(r.status, 409); assert.match(r.body.error, /changed since you opened this screen \(it is now £21\.00\)/);
    assert.equal(T('cash_recon').length, 0); assert.equal(T('payments').filter(p => p.status === 'paid' && p.cash_recon_batch_id).length, 0);
  });
  await t.test('without an expected figure it still works as before; sellers and strangers still cannot; and another parish\'s campaign is refused', async () => {
    reset(); stock();
    assert.equal((await call('cash_recon', { seller_id: 'sel-john', campaign_id: 'c-raffle', amount_received: 20 }, { session: S.adA })).body.matched_count, 1);
    assert.equal((await call('cash_recon', { seller_id: 'sel-mary', campaign_id: 'c-raffle', amount_received: 5 }, { session: S.seA })).status, 403);
    assert.equal((await call('cash_recon', { seller_id: 'sel-mary', campaign_id: 'c-b', amount_received: 5 }, { session: S.adA })).status, 403);
    assert.equal((await call('cash_recon', { seller_id: 'sel-mary', campaign_id: '', amount_received: 5 }, { session: S.adA })).status, 400);
  });
});
