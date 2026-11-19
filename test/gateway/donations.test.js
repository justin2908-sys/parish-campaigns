// Make a Donation: any amount from £1 to £5,000 by card, name and contact optional, the office list, and the parish page door.
// Run with:  node --test "test/gateway/*.test.js"   (no network: SumUp is replaced by a stand-in)
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
let S, sumup, sumupStatus, seq = 0;
function reset() {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-19T12:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true, display_name: 'St Vincent De Paul', contact_email: 'a@example.org' });
  T('organizations').push({ id: 'org-B', name: 'Other', slug: 'other-parish', timezone: 'Europe/London', gateway_enabled: true });
  S = { sa: addUser('u-sa', 'superadmin', 'org-A'), fi: addUser('u-fi', 'finance', 'org-A'), se: addUser('u-se', 'seller', 'org-A'), vo: addUser('u-vo', 'volunteer', 'org-A'), saB: addUser('uB', 'superadmin', 'org-B') };
  T('donation_settings').push({ org_id: 'org-A', enabled: true, intro_text: 'Thank you for your generosity.', next_ref: 1 });
  sumup = []; sumupStatus = 'PENDING';
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (opts.method === 'POST' && u.endsWith('/v0.1/checkouts')) { sumup.push(JSON.parse(opts.body || '{}')); return { ok: true, status: 200, json: async () => ({ id: 'co-' + sumup.length, hosted_checkout_url: 'https://pay.example/' + sumup.length }) }; }
    if (opts.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
    if (/\/v0\.1\/checkouts\/co-/.test(u)) { const paid = sumupStatus === 'PAID'; return { ok: true, status: 200, json: async () => ({ id: u.split('/').pop(), status: sumupStatus, date: new Date(clock.now()).toISOString(), transactions: paid ? [{ id: 'tx-1', transaction_code: 'TAAA000001', status: 'SUCCESSFUL' }] : [] }) }; }
    throw new Error('the network is off in tests: ' + u);
  };
}
const give = (over, opts) => call('public_donation_create', { slug: 'svp-osterley', amount: 10, client_ref: 'ref-' + (++seq) + '-' + Math.random().toString(36).slice(2, 10), ...over }, opts);

test('Make a Donation', async (t) => {
  await t.test('the page is told the limits and the suggested amount; it is closed when switched off or unknown', async () => {
    reset();
    const r = await call('public_donation_info', { slug: 'svp-osterley' });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.amount, { min: 1, max: 5000, suggested: 10, quick: [10, 20, 50, 100] });
    assert.equal(r.body.org.name, 'St Vincent De Paul'); assert.equal(r.body.intro, 'Thank you for your generosity.');
    assert.equal((await call('public_donation_info', { slug: 'other-parish' })).status, 404);
    assert.equal((await call('public_donation_info', { slug: 'nobody-here' })).status, 404);
    T('donation_settings')[0].enabled = false;
    assert.equal((await call('public_donation_info', { slug: 'svp-osterley' })).status, 404);
    assert.equal((await give()).status, 404);
  });
  await t.test('a donation with no name and no contact is accepted: a card payment for exactly that amount, held in a hidden monthly campaign', async () => {
    reset();
    const r = await give({ amount: '25.50' });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ref, 'DON-001'); assert.equal(r.body.amount, 25.5); assert.match(r.body.pay_url, /^https:\/\/pay\.example\//);
    assert.equal(sumup.length, 1); assert.equal(sumup[0].amount, 25.5); assert.equal(sumup[0].currency, 'GBP');
    const pay = T('payments')[0];
    assert.equal(pay.amount, 25.5); assert.equal(pay.status, 'pending'); assert.equal(pay.payer_name, null); assert.equal(pay.contact_value, null);
    const camp = T('campaigns').find(c => c.id === pay.campaign_id);
    assert.equal(camp.name, 'Donations, November 2026'); assert.equal(camp.form_def.donations, true); assert.equal(camp.listed_on_gateway, false);
    const again = await give({ amount: 5 });
    assert.equal(again.body.ref, 'DON-002'); assert.equal(T('campaigns').length, 1);   // same month, same hidden campaign
  });
  await t.test('name and an email or a mobile number are kept on the payment only', async () => {
    reset();
    const a = await give({ name: '  Mary   Murphy ', contact: 'mary@example.com' });
    assert.equal(a.status, 200, a.raw);
    const b = await give({ name: 'Joe', contact: '07700 900123' });
    assert.equal(b.status, 200, b.raw);
    assert.equal(T('payments')[0].payer_name, 'Mary Murphy'); assert.equal(T('payments')[0].contact_value, 'mary@example.com');
    assert.ok(T('payments')[1].contact_value);
    for (const row of T('donations')) assert.deepEqual(Object.keys(row).filter(k => /name|contact|email|phone/.test(k)), []);
    assert.equal((await give({ contact: 'not an email@' })).status, 400);
    assert.equal((await give({ contact: '12' })).status, 400);
  });
  await t.test('amounts: £1 to £5,000 only, pounds and pence, nothing else', async () => {
    reset();
    for (const ok of [1, '1', '£10', '4,999.99', 5000, 0.999 + 0.01]) assert.equal((await give({ amount: ok })).status, 200, String(ok));
    const before = T('donations').length, pays = T('payments').length;
    for (const bad of [0, 0.99, -5, 5000.01, 100000, 'abc', '', null, undefined, 'NaN', 'Infinity']) {
      const r = await give({ amount: bad });
      assert.equal(r.status, 400, String(bad) + ' ' + r.raw);
    }
    assert.equal(T('donations').length, before); assert.equal(T('payments').length, pays);   // refused: nothing created, nothing sent to SumUp
    assert.equal(sumup.length, before);
    assert.equal((await give({ amount: 10.456 })).body.amount, 10.46);
  });
  await t.test('a second tap with the same reference gives once; the hidden spam-trap box stores nothing', async () => {
    reset();
    const a = await give({ client_ref: 'same-ref-12345' }), b = await give({ client_ref: 'same-ref-12345' });
    assert.equal(a.body.donation_id, b.body.donation_id); assert.equal(b.body.replay, true);
    assert.equal(T('donations').length, 1); assert.equal(sumup.length, 1);
    const bot = await give({ website: 'http://spam.example' });
    assert.equal(bot.status, 200); assert.equal(T('donations').length, 1);
  });
  await t.test('paid at SumUp: the donation becomes paid; abandoned: cancelled, and a late payment still counts', async () => {
    reset();
    const r = await give({ amount: 40 });
    sumupStatus = 'PENDING';
    let s = await call('public_donation_status', { donation_id: r.body.donation_id });
    assert.equal(s.body.status, 'awaiting_payment'); assert.equal(s.body.ref, 'DON-001'); assert.match(s.body.pay_url, /^https:/);
    sumupStatus = 'PAID';
    s = await call('public_donation_status', { donation_id: r.body.donation_id });
    assert.equal(s.body.status, 'paid'); assert.equal(s.body.amount, 40); assert.equal(s.body.pay_url, null);
    assert.equal(T('payments')[0].status, 'paid'); assert.equal(T('donations')[0].status, 'paid'); assert.ok(T('donations')[0].paid_at);
    reset();
    const f = await give({ amount: 15 });
    sumupStatus = 'EXPIRED';
    assert.equal((await call('public_donation_status', { donation_id: f.body.donation_id })).body.status, 'cancelled');
    sumupStatus = 'PAID';
    T('donations')[0].status = 'cancelled'; T('payments')[0].status = 'failed';
    const sync = await call('public_donation_status', { donation_id: f.body.donation_id });
    assert.equal(sync.status, 200);
    assert.equal((await call('public_donation_status', { donation_id: 'not-an-id' })).status, 400);
    assert.equal((await call('public_donation_status', { donation_id: '11111111-1111-1111-1111-111111111111' })).status, 404);
  });
  await t.test('the office sees the list and totals, with refunds taken off; volunteers and sellers cannot', async () => {
    reset();
    const a = await give({ amount: 20, name: 'Ann' }), b = await give({ amount: 30 }); await give({ amount: 99 });
    sumupStatus = 'PAID';
    await call('public_donation_status', { donation_id: a.body.donation_id }); await call('public_donation_status', { donation_id: b.body.donation_id });
    T('payments')[0].refund_amount = 5;
    const r = await call('donations_get', {}, { session: S.fi });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.totals.this_month, 45); assert.equal(r.body.totals.this_month_count, 2);   // 20 - 5 refunded + 30; the unpaid one is not counted
    assert.equal(r.body.donations.length, 3);
    assert.equal(r.body.donations.find(d => d.ref === 'DON-001').name, 'Ann');
    assert.equal(r.body.donations.find(d => d.ref === 'DON-003').status, 'awaiting_payment');
    assert.equal(r.body.org.page_path, '/donate/svp-osterley');
    assert.equal((await call('donations_get', {}, { session: S.vo })).status, 403);
    assert.equal((await call('donations_get', {}, { session: S.se })).status, 403);
    assert.equal((await call('donations_get', {})).status, 401);
    assert.equal((await call('donations_get', {}, { session: S.saB })).body.donations.length, 0);   // another parish sees none of it
  });
  await t.test('settings: open and close, the welcome line, and no opening without a page address', async () => {
    reset();
    T('donation_settings')[0].enabled = false;
    let r = await call('donations_set_settings', { enabled: true, intro_text: 'God bless you' }, { session: S.sa });
    assert.equal(r.status, 200, r.raw); assert.equal(T('donation_settings')[0].enabled, true); assert.equal(T('donation_settings')[0].intro_text, 'God bless you');
    r = await call('donations_set_settings', { enabled: false }, { session: S.fi });
    assert.equal(r.status, 200, r.raw); assert.equal(T('donation_settings')[0].enabled, false);
    assert.equal((await call('donations_set_settings', { enabled: true }, { session: S.vo })).status, 403);
    assert.equal((await call('donations_set_settings', { intro_text: 'x'.repeat(301) }, { session: S.sa })).status, 400);
    T('organizations')[0].slug = null;
    assert.equal((await call('donations_set_settings', { enabled: true }, { session: S.sa })).status, 400);
  });
  await t.test('the parish page shows the donate door only while donations are open', async () => {
    reset();
    let r = await call('public_gateway', { slug: 'svp-osterley' });
    assert.equal(r.status, 200, r.raw); assert.deepEqual(r.body.donate, { path: '/donate/svp-osterley' });
    T('donation_settings')[0].enabled = false;
    r = await call('public_gateway', { slug: 'svp-osterley' });
    assert.equal(r.body.donate, null);
  });
  await t.test('a paid donation is not flagged by the books check as a sale with no tickets', async () => {
    reset();
    const r = await give({ amount: 12 });
    sumupStatus = 'PAID';
    await call('public_donation_status', { donation_id: r.body.donation_id });
    const lg = await call('ledger_check', {}, { session: S.sa });
    assert.equal(lg.status, 200, lg.raw); assert.deepEqual(lg.body.problems, [], JSON.stringify(lg.body.problems));
    assert.ok(lg.body.checked.payments >= 1);
  });
  await t.test('the hidden monthly campaign is never a public campaign', async () => {
    reset();
    await give({ amount: 12 });
    const camp = T('campaigns')[0];
    const pub = await call('public_campaign_info', { campaign_id: camp.id });
    assert.equal(pub.status, 404);
  });
});
