// The Volunteer (added 2026-11-16): helps with the parish page, Repository orders, Listings approval and Light a Candle. Cannot create or change
// campaigns, cannot touch money, cannot see the Users, Bin or Privacy areas. Can be ticked "also sells tickets" to get the Seller selling screen too.
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
let S;
function reset() {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-16T10:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true });
  S = { sa: addUser('uA-sa', 'superadmin', 'org-A'), ad: addUser('uA-ad', 'admin', 'org-A'), vo: addUser('uA-vo', 'volunteer', 'org-A'), vs: addUser('uA-vs', 'volunteer', 'org-A'), se: addUser('uA-se', 'seller', 'org-A') };
  T('users').find(u => u.id === 'uA-vs').also_sells = true;
}
const raffle = (name) => ({ name, kind: 'raffle', tiers: [{ name: 'Single', price: 2, tickets: 1 }], blocks: [{ type: 'digital', label: 'Online', number_prefix: 'O', range_start: 1, range_end: 20 }], age_restricted: false, keep_until: '2027-06-01' });
const status = async (action, body, who) => (await call(action, body || {}, { session: S[who] })).status;

test('Volunteer: what they can do', async (t) => {
  await t.test('they can see the parish page editor, Repository orders, Listings and the candle list', async () => {
    reset();
    for (const a of ['gateway_get', 'shop_get', 'shop_orders', 'listings_get', 'candles_get', 'candles_week']) assert.equal(await status(a, a === 'candles_week' ? { monday: '2026-11-16' } : {}, 'vo'), 200, a);
  });
  await t.test('they can edit the parish page content', async () => {
    reset();
    assert.equal(await status('gateway_save_announcement', { message: 'Mass moved to 10am on Sunday' }, 'vo'), 200);
    assert.equal(await status('gateway_clear_announcement', {}, 'vo'), 200);
  });
  await t.test('they can mark an order prepared, approve or decline a listing, and tick a candle lit (authorised: only "not found" because none exist)', async () => {
    reset();
    assert.equal(await status('shop_order_mark', { order_id: 'nope', status: 'prepared' }, 'vo'), 404);
    assert.equal(await status('listings_review', { id: 'nope', decision: 'approve' }, 'vo'), 404);
    assert.equal(await status('candles_mark', { id: 'nope', lit: true }, 'vo'), 404);
  });
  await t.test('they see the ongoing campaigns only: no drafts, no registration forms, nothing switched off', async () => {
    reset();
    await call('create_campaign', raffle('Autumn Raffle'), { session: S.sa });
    await call('create_campaign', { ...raffle('Draft Raffle'), is_draft: true }, { session: S.sa });
    const off = (await call('create_campaign', raffle('Old Raffle'), { session: S.sa })).body.campaign;
    await call('set_campaign_active', { campaign_id: off.id, active: false }, { session: S.sa });
    const r = await call('list_campaigns', { include_inactive: true }, { session: S.vo });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.campaigns.map(c => c.name), ['Autumn Raffle']);
  });
  await t.test('what the week took and SumUp codes are not shown to them in the orders list; an admin still sees the total', async () => {
    reset();
    const o = (await call('shop_orders', {}, { session: S.vo })).body, a = (await call('shop_orders', {}, { session: S.ad })).body;
    assert.equal(o.totals.taken, null); assert.equal(typeof a.totals.taken, 'number');
  });
});

test('Volunteer: what they cannot do', async (t) => {
  await t.test('no creating, changing, binning or deleting campaigns', async () => {
    reset();
    assert.equal(await status('create_campaign', raffle('X'), 'vo'), 403);
    const c = (await call('create_campaign', raffle('Autumn Raffle'), { session: S.sa })).body.campaign;
    for (const [a, b] of [['set_campaign_details', { campaign_id: c.id, details_text: 'x' }], ['set_campaign_active', { campaign_id: c.id, active: false }], ['bin_campaign', { campaign_id: c.id }], ['delete_draft_campaign', { campaign_id: c.id }], ['create_campaign', { name: 'Form', kind: 'registration' }], ['export_campaign_report', { campaign_id: c.id }]]) assert.equal(await status(a, b, 'vo'), 403, a);
    assert.equal(T('campaigns').filter(x => x.org_id === 'org-A').length, 1);
  });
  await t.test('no money: refunds, voiding, cash, payments, dashboards, payment settings', async () => {
    reset();
    for (const a of ['dashboard_state', 'cash_recon', 'list_recent_payments', 'list_incomplete_payments', 'void_sale', 'record_refund', 'set_payment_options', 'get_org_settings', 'set_org_address', 'cash_pending']) assert.equal(await status(a, {}, 'vo'), 403, a);
  });
  await t.test('no Users, Recycle Bin, Privacy or Registrations', async () => {
    reset();
    for (const a of ['list_users', 'create_user', 'list_binned_campaigns', 'privacy_search', 'privacy_export', 'registration_forms']) assert.equal(await status(a, {}, 'vo'), 403, a);
  });
  await t.test('no changing Repository items or settings, cancelling orders, no Listings settings/take-down, no candle settings/cancel, no page address', async () => {
    reset();
    for (const [a, b] of [['shop_item_save', { name: 'Mug', price: 3 }], ['shop_item_delete', { id: 'x' }], ['shop_set_settings', { enabled: true }], ['shop_import', {}], ['shop_order_cancel', { order_id: 'x', reason: 'why' }],
      ['listings_takedown', { id: 'x', note: 'because' }], ['listings_set_featured', { id: 'x', featured: true }], ['listings_dismiss_reports', { id: 'x' }], ['listings_set_settings', { enabled: true }],
      ['candles_cancel', { id: 'x', reason: 'why' }], ['candles_set_settings', { enabled: true }], ['gateway_set_address', { slug: 'new-address' }], ['gateway_set_enabled', { enabled: true }]]) assert.equal(await status(a, b, 'vo'), 403, a);
  });
  await t.test('without "also sells" they cannot sell tickets', async () => {
    reset();
    for (const a of ['record_sale', 'seller_state', 'my_open_links']) assert.equal(await status(a, {}, 'vo'), 403, a);
  });
  await t.test('listings: a refund cannot ride along with a Volunteer declining a listing', async () => {
    reset();
    T('listings').push({ id: 'L1', org_id: 'org-A', status: 'pending_review', title: 'Bike', days: 7, fee: 5, payment_id: 'p1' });
    T('payments').push({ id: 'p1', status: 'paid', amount: 5 });
    const r = await call('listings_review', { id: 'L1', decision: 'reject', note: 'Not suitable', refund_amount: 5 }, { session: S.vo });
    assert.equal(r.status, 403, r.raw);
    assert.equal(T('listings').find(l => l.id === 'L1').status, 'pending_review', 'the listing was not changed by the refused refund');
  });
});

test('Volunteer who also sells', async (t) => {
  await t.test('the tickbox lets them through where a Seller goes, and nowhere else new', async () => {
    reset();
    assert.notEqual(await status('seller_state', {}, 'vs'), 403);
    assert.notEqual(await status('record_sale', {}, 'vs'), 403);
    assert.equal(await status('cash_recon', {}, 'vs'), 403, 'still no money screens');
    assert.equal(await status('create_campaign', raffle('X'), 'vs'), 403);
  });
  await t.test('their Sell screen lists sellable campaigns the way a Seller sees them (switched-off ones excluded)', async () => {
    reset();
    const a = (await call('create_campaign', raffle('Autumn Raffle'), { session: S.sa })).body.campaign;
    const off = (await call('create_campaign', raffle('Hidden For Them'), { session: S.sa })).body.campaign;
    await call('set_disabled_campaigns', { user_id: 'uA-vs', disabled_campaign_ids: [off.id] }, { session: S.sa });
    const r = await call('list_campaigns', {}, { session: S.vs });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.campaigns.map(c => c.name), ['Autumn Raffle']);
    assert.ok(a.id);
  });
  await t.test('a seller-volunteer must accept the seller terms; a plain volunteer need not', async () => {
    reset();
    T('users').find(u => u.id === 'uA-vs').consent_version = 0;
    assert.equal(await status('gateway_get', {}, 'vs'), 401);
    T('users').find(u => u.id === 'uA-vo').consent_version = 0;
    assert.equal(await status('gateway_get', {}, 'vo'), 200);
  });
  await t.test('only a SuperAdmin (or Priest) can tick it, only on a Volunteer, and it bites at once', async () => {
    reset();
    assert.equal(await status('set_user_also_sells', { user_id: 'uA-vo', also_sells: true }, 'ad'), 403);
    assert.equal(await status('set_user_also_sells', { user_id: 'uA-se', also_sells: true }, 'sa'), 400, 'a Seller is not a Volunteer');
    assert.equal(await status('seller_state', {}, 'vo'), 403);
    assert.equal(await status('set_user_also_sells', { user_id: 'uA-vo', also_sells: true }, 'sa'), 200);
    assert.notEqual(await status('seller_state', {}, 'vo'), 403);
    assert.equal(await status('set_user_also_sells', { user_id: 'uA-vo', also_sells: false }, 'sa'), 200);
    assert.equal(await status('seller_state', {}, 'vo'), 403);
  });
  await t.test('a SuperAdmin can create a Volunteer, with or without selling', async () => {
    reset();
    const pw = 'Correct-Horse-9!';
    const a = await call('create_user', { name: 'Vera Volunteer', mobile: '07700900111', role: 'volunteer', password: pw, also_sells: true }, { session: S.sa });
    assert.equal(a.status, 200, a.raw); assert.equal(a.body.user.role, 'volunteer'); assert.equal(a.body.user.also_sells, true);
    const b = await call('create_user', { name: 'Vic Volunteer', mobile: '07700900112', role: 'volunteer', password: pw }, { session: S.sa });
    assert.equal(b.body.user.also_sells, false);
    const s = await call('create_user', { name: 'Sam Seller', mobile: '07700900113', role: 'seller', password: pw, also_sells: true }, { session: S.sa });
    assert.equal(s.body.user.also_sells, false, 'the tickbox means nothing for other roles');
    assert.equal((await call('create_user', { name: 'Nope', mobile: '07700900114', role: 'volunteer', password: pw }, { session: S.ad })).status, 403);
  });
});
