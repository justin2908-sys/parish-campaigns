// The money statement: every payment received and every refund recorded, across all campaigns, for any dates (2026-11-27).
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
let S;
function reset() {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-27T12:00:00Z');   // a Friday
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true, display_name: 'St Vincent De Paul' });
  T('organizations').push({ id: 'org-B', name: 'Other', slug: 'other-parish', timezone: 'Europe/London', gateway_enabled: true });
  S = { sa: addUser('u-sa', 'superadmin', 'org-A'), ad: addUser('u-ad', 'admin', 'org-A'), fi: addUser('u-fi', 'finance', 'org-A'), pr: addUser('u-pr', 'priest', 'org-A'), se: addUser('u-se', 'seller', 'org-A'), vo: addUser('u-vo', 'volunteer', 'org-A'), saB: addUser('uB', 'superadmin', 'org-B') };
  T('users').find(u => u.id === 'u-fi').name = 'Frances Finance'; T('users').find(u => u.id === 'u-se').name = 'Sam Seller'; T('users').find(u => u.id === 'u-ad').name = 'Ann Admin';
  T('campaigns').push({ id: 'c-raffle', org_id: 'org-A', name: 'Christmas Raffle', kind: 'raffle', binned: false });
  T('campaigns').push({ id: 'c-reg', org_id: 'org-A', name: 'First Communion', kind: 'registration', binned: false, form_def: {} });
  T('campaigns').push({ id: 'c-don', org_id: 'org-A', name: 'Donations, November 2026', kind: 'registration', binned: false, form_def: { donations: true } });
  T('campaigns').push({ id: 'c-B', org_id: 'org-B', name: 'Other parish raffle', kind: 'raffle', binned: false });
  T('ticket_blocks').push({ id: 'b1', campaign_id: 'c-raffle', number_prefix: 'A' });
}
const pay = (id, o) => T('payments').push({ id, campaign_id: 'c-raffle', method: 'link', amount: 10, status: 'paid', seller_id: null, ...o });
const get = (b, session = S.fi) => call('statement_get', b, { session });

test('Money statement', async (t) => {
  await t.test('every received payment and every refund in the dates is a line, with the booking reference, the payment reference and who refunded', async () => {
    reset();
    pay('p1', { amount: 20, paid_at: '2026-11-24T10:00:00Z', sumup_transaction_code: 'TAAA111', seller_id: 'u-se', method: 'machine', ticket_snapshot: [{ ticket_number: 5, block_id: 'b1' }, { ticket_number: 6, block_id: 'b1' }, { ticket_number: 7, block_id: 'b1' }, { ticket_number: 9, block_id: 'b1' }] });
    pay('p2', { campaign_id: 'c-reg', amount: 15, paid_at: '2026-11-25T09:30:00Z', sumup_checkout_ref: 'CHK-77' });
    T('registrations').push({ id: 'r1', campaign_id: 'c-reg', reg_number: 7, payment_id: 'p2', status: 'accepted' });
    pay('p3', { campaign_id: 'c-don', amount: 25, paid_at: '2026-11-26T14:00:00Z', sumup_transaction_code: 'TAAA333', refund_amount: 5, refunded_at: '2026-11-26T16:00:00Z', refunded_by: 'u-fi', refund_note: 'Gave twice by mistake' });
    T('donations').push({ id: 'd1', org_id: 'org-A', ref_no: 12, payment_id: 'p3', amount: 25, status: 'paid', purpose: 'Altar Flowers' });
    pay('p4', { method: 'cash', amount: 30, paid_at: '2026-11-26T18:00:00Z', seller_id: 'u-se', cash_confirmed_by: 'u-ad', ticket_snapshot: [{ ticket_number: 1, block_id: 'b1' }] });
    const r = await get({ from: '2026-11-20', to: '2026-11-27' });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.lines.length, 5, 'four payments received and one refund');
    const L = (k) => r.body.lines.filter(l => l.payment_id === k);
    const p1 = L('p1')[0];
    assert.equal(p1.kind, 'in'); assert.equal(p1.amount, 20); assert.equal(p1.booking_ref, 'A5–A7, A9'); assert.equal(p1.type, 'Tickets'); assert.equal(p1.payment_ref, 'TAAA111'); assert.equal(p1.taken_by, 'Sam Seller'); assert.equal(p1.campaign, 'Christmas Raffle');
    const p2 = L('p2')[0];
    assert.equal(p2.booking_ref, 'R7'); assert.equal(p2.payment_ref, 'CHK-77'); assert.equal(p2.taken_by, 'Online');
    const p3in = L('p3').find(l => l.kind === 'in'), p3out = L('p3').find(l => l.kind === 'refund');
    assert.equal(p3in.booking_ref, 'DON-012'); assert.equal(p3in.campaign, 'Donations'); assert.equal(p3in.detail, 'Altar Flowers');
    assert.equal(p3out.amount, 5); assert.equal(p3out.refunded_by, 'Frances Finance'); assert.equal(p3out.note, 'Gave twice by mistake'); assert.equal(p3out.booking_ref, 'DON-012'); assert.equal(p3out.payment_ref, 'TAAA333');
    const p4 = L('p4')[0];
    assert.equal(p4.payment_ref, 'Cash'); assert.equal(p4.confirmed_by, 'Ann Admin'); assert.equal(p4.taken_by, 'Sam Seller');
    assert.deepEqual(r.body.totals, { in: 90, in_count: 4, refunds: 5, refund_count: 1, net: 85 });
    assert.deepEqual(r.body.lines.map(l => l.at), [...r.body.lines.map(l => l.at)].sort(), 'oldest first');
  });

  await t.test('only received money: cash still held by a seller, unpaid links, voided sales, and other parishes are left out', async () => {
    reset();
    pay('ok', { paid_at: '2026-11-26T10:00:00Z' });
    pay('cash-held', { method: 'cash', status: 'pending', seller_id: 'u-se', amount: 50 });
    pay('unpaid', { status: 'pending', amount: 12 });
    pay('failed', { status: 'failed', amount: 13 });
    pay('void', { status: 'void', amount: 14 });
    pay('other', { campaign_id: 'c-B', amount: 99, paid_at: '2026-11-26T10:00:00Z' });
    const r = await get({ from: '2026-11-01', to: '2026-11-30' });
    assert.deepEqual(r.body.lines.map(l => l.payment_id), ['ok']);
    assert.equal(r.body.totals.net, 10);
  });

  await t.test('the dates are the parish\'s own days, and a payment is dated when it was received, not when its link was made', async () => {
    reset();
    pay('late-link', { created_at: '2026-10-01T10:00:00Z', paid_at: '2026-11-26T08:00:00Z' });
    pay('midnight-in', { paid_at: '2026-11-25T23:30:00Z' });   // 25 Nov in London (winter, same as UTC)
    pay('edge-end', { paid_at: '2026-11-26T23:59:00Z' });
    pay('next-day', { paid_at: '2026-11-27T00:00:00Z' });
    const r = await get({ from: '2026-11-26', to: '2026-11-26' });
    assert.deepEqual(r.body.lines.map(l => l.payment_id).sort(), ['edge-end', 'late-link']);
    T('organizations')[0].timezone = 'Pacific/Auckland';   // +13 in November: 26 Nov there starts at 25 Nov 11:00 UTC
    const nz = await get({ from: '2026-11-26', to: '2026-11-26' });
    assert.deepEqual(nz.body.lines.map(l => l.payment_id).sort(), ['late-link', 'midnight-in']);   // 23:59 UTC on the 26th is already the 27th there
    assert.ok(nz.body.lines.every(l => l.date === '2026-11-26'));
    // a payment received in a past month, refunded this month: the sale is in the old month, the refund in this one
    reset();
    pay('old', { amount: 40, paid_at: '2026-10-15T10:00:00Z', refund_amount: 40, refunded_at: '2026-11-20T10:00:00Z', refunded_by: 'u-ad', refund_note: 'Cancelled' });
    const oct = await get({ from: '2026-10-01', to: '2026-10-31' }), nov = await get({ from: '2026-11-01', to: '2026-11-30' });
    assert.deepEqual(oct.body.lines.map(l => l.kind), ['in']); assert.equal(oct.body.totals.net, 40);
    assert.deepEqual(nov.body.lines.map(l => l.kind), ['refund']); assert.equal(nov.body.totals.net, -40);
  });

  await t.test('the quick dates are worked out in the parish\'s own time: Monday to Sunday weeks, whole months', async () => {
    reset();   // Friday 27 Nov 2026
    const range = async (preset) => { const r = await get({ preset }); assert.equal(r.status, 200, r.raw); return [r.body.from, r.body.to]; };
    assert.deepEqual(await range('today'), ['2026-11-27', '2026-11-27']);
    assert.deepEqual(await range('yesterday'), ['2026-11-26', '2026-11-26']);
    assert.deepEqual(await range('this_week'), ['2026-11-23', '2026-11-29']);
    assert.deepEqual(await range('last_week'), ['2026-11-16', '2026-11-22']);
    assert.deepEqual(await range('this_month'), ['2026-11-01', '2026-11-30']);
    assert.deepEqual(await range('last_month'), ['2026-10-01', '2026-10-31']);
    assert.deepEqual(await range('last_30'), ['2026-10-29', '2026-11-27']);
    assert.deepEqual(await range('this_year'), ['2026-01-01', '2026-12-31']);
    assert.deepEqual(await range('last_year'), ['2025-01-01', '2025-12-31']);
    clock.set('2027-01-03T12:00:00Z');   // a Sunday, in the new year: last month is December
    assert.deepEqual(await range('last_month'), ['2026-12-01', '2026-12-31']);
    assert.deepEqual(await range('this_week'), ['2026-12-28', '2027-01-03']);
    assert.equal((await get({ preset: 'next_decade' })).status, 400);
  });

  await t.test('bad dates are refused plainly', async () => {
    reset();
    for (const b of [{}, { from: '2026-11-01' }, { from: 'yesterday', to: 'today' }, { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-11-10', to: '2026-11-01' }, { from: '2024-01-01', to: '2026-11-01' }]) {
      const r = await get(b); assert.equal(r.status, 400, JSON.stringify(b));
      assert.ok(r.body.error && r.body.error.length > 10);
    }
  });

  await t.test('totals and the by-campaign breakdown add up; a refund on a voided sale still shows', async () => {
    reset();
    pay('a', { amount: 10, paid_at: '2026-11-24T10:00:00Z' });
    pay('b', { amount: 10, paid_at: '2026-11-24T11:00:00Z' });
    pay('c', { campaign_id: 'c-reg', amount: 7.5, paid_at: '2026-11-24T12:00:00Z', refund_amount: 2.5, refunded_at: '2026-11-25T12:00:00Z', refunded_by: 'u-ad', refund_note: 'Part refund' });
    pay('d', { amount: 8, status: 'void', refund_amount: 8, refunded_at: '2026-11-25T13:00:00Z', refunded_by: 'u-ad', refund_note: 'Refunded then voided' });
    const r = await get({ from: '2026-11-01', to: '2026-11-30' });
    assert.deepEqual(r.body.totals, { in: 27.5, in_count: 3, refunds: 10.5, refund_count: 2, net: 17 });
    const g = Object.fromEntries(r.body.by_campaign.map(x => [x.campaign, x]));
    assert.deepEqual([g['Christmas Raffle'].in, g['Christmas Raffle'].refunds, g['Christmas Raffle'].net], [20, 8, 12]);
    assert.deepEqual([g['First Communion'].in, g['First Communion'].refunds, g['First Communion'].net], [7.5, 2.5, 5]);
    assert.ok(!JSON.stringify(r.body).includes('payer_name'), 'no buyer names or contact details in a statement');
  });

  await t.test('no buyer names or contact details are ever included', async () => {
    reset();
    pay('x', { paid_at: '2026-11-24T10:00:00Z', payer_name: 'Mary Murphy', contact_value: 'mary@example.com' });
    const r = await get({ from: '2026-11-01', to: '2026-11-30' });
    assert.ok(!/Mary|mary@example/.test(r.raw), r.raw);
  });

  await t.test('office roles only; a seller, a volunteer and another parish see nothing of this parish', async () => {
    reset();
    pay('a', { paid_at: '2026-11-24T10:00:00Z' });
    for (const k of ['sa', 'ad', 'fi', 'pr']) assert.equal((await get({ preset: 'this_month' }, S[k])).status, 200, k);
    for (const k of ['se', 'vo']) assert.equal((await get({ preset: 'this_month' }, S[k])).status, 403, k);
    assert.equal((await call('statement_get', { preset: 'this_month' })).status, 401);
    const b = await get({ preset: 'this_month' }, S.saB);
    assert.equal(b.status, 200); assert.equal(b.body.lines.length, 0);
  });

  await t.test('a payment that turns paid is stamped with that moment (the database does this itself)', async () => {
    reset();
    pay('later', { status: 'pending', created_at: '2026-11-01T10:00:00Z' });
    assert.ok(!T('payments')[0].paid_at);
    clock.set('2026-11-27T09:00:00Z');
    const { data } = await db.client.from('payments').update({ status: 'paid' }).eq('id', 'later').select().single();
    assert.equal(data.paid_at, '2026-11-27T09:00:00.000Z');
  });
  await t.test('"All dates" returns everything ever received or refunded, and says the real first and last dates', async () => {
    reset();
    pay('y1', { amount: 5, paid_at: '2024-03-02T10:00:00Z' });
    pay('y2', { amount: 7, paid_at: '2025-08-20T10:00:00Z', refund_amount: 2, refunded_at: '2026-11-20T10:00:00Z', refunded_by: 'u-ad', refund_note: 'Part' });
    pay('y3', { amount: 9, paid_at: '2026-11-26T10:00:00Z' });
    pay('held', { method: 'cash', status: 'pending', amount: 99 });
    const r = await get({ preset: 'all' });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.lines.map(l => l.payment_id), ['y1', 'y2', 'y2', 'y3']);   // three received, one refund, oldest first
    assert.equal(r.body.from, '2024-03-02'); assert.equal(r.body.to, '2026-11-26'); assert.equal(r.body.preset, 'all');
    assert.deepEqual(r.body.totals, { in: 21, in_count: 3, refunds: 2, refund_count: 1, net: 19 });
    reset();
    const none = await get({ preset: 'all' });
    assert.equal(none.status, 200); assert.deepEqual(none.body.lines, []); assert.equal(none.body.from, '2026-11-27');
  });

  await t.test('a great many payments (read in bulk) still get their booking references, from the same tables', async () => {
    reset();
    for (let i = 1; i <= 205; i++) {
      pay('bp' + i, { campaign_id: 'c-don', amount: 10, paid_at: '2026-11-2' + (i % 7) + 'T10:00:00Z', sumup_transaction_code: 'TBULK' + String(i).padStart(3, '0') });
      T('donations').push({ id: 'bd' + i, org_id: 'org-A', ref_no: i, payment_id: 'bp' + i, amount: 10, status: 'paid', purpose: i === 7 ? 'Roof' : null });
    }
    pay('bt', { amount: 20, paid_at: '2026-11-25T10:00:00Z', sumup_transaction_code: 'TBULKTIX', ticket_snapshot: [{ ticket_number: 11, block_id: 'b1' }, { ticket_number: 12, block_id: 'b1' }] });
    pay('br', { campaign_id: 'c-reg', amount: 15, paid_at: '2026-11-25T11:00:00Z' });
    T('registrations').push({ id: 'br1', campaign_id: 'c-reg', reg_number: 42, payment_id: 'br', status: 'accepted' });
    T('registrations').push({ id: 'other', campaign_id: 'c-reg', reg_number: 99, payment_id: 'not-in-range', status: 'accepted' });
    const r = await get({ from: '2026-11-01', to: '2026-11-30' });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.lines.length, 207);
    const L = (id) => r.body.lines.find(l => l.payment_id === id);
    assert.equal(L('bp7').booking_ref, 'DON-007'); assert.equal(L('bp7').detail, 'Roof'); assert.equal(L('bp205').booking_ref, 'DON-205');
    assert.equal(L('br').booking_ref, 'R42'); assert.equal(L('bt').booking_ref, 'A11–A12', 'ticket numbers come from the payment\'s own record');
    assert.equal(L('bp1').payment_ref, 'TBULK001');
  });

});
