// An "online only" campaign is never sold in person: not on any Sell screen (Seller, Admin, SuperAdmin) and the sale itself is refused (2026-11-18).
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
const raffle = (name, extra = {}) => ({ name, kind: 'raffle', tiers: [{ name: 'Single', price: 2, tickets: 1 }], blocks: [{ type: 'digital', label: 'Online', number_prefix: 'O', range_start: 1, range_end: 20 }], age_restricted: false, public_page_enabled: true, keep_until: '2027-06-01', ...extra });

test('Online-only campaigns', async (t) => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-18T10:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London' });
  const SA = addUser('u-sa', 'superadmin', 'org-A'), AD = addUser('u-ad', 'admin', 'org-A'), SE = addUser('u-se', 'seller', 'org-A');
  const open = (await call('create_campaign', raffle('In Person Raffle'), { session: SA })).body.campaign;
  const online = (await call('create_campaign', raffle('Sunday Cafe', { public_only: true }), { session: SA })).body.campaign;
  assert.ok(open && online);

  await t.test('nobody sees it on the Sell screen, but the Campaigns list still shows it to admins', async () => {
    for (const s of [SE, AD, SA]) {
      const r = await call('list_campaigns', {}, { session: s });
      assert.deepEqual(r.body.campaigns.map(c => c.name), ['In Person Raffle']);
    }
    const all = await call('list_campaigns', { include_inactive: true }, { session: SA });
    assert.deepEqual(all.body.campaigns.map(c => c.name).sort(), ['In Person Raffle', 'Sunday Cafe']);
  });
  await t.test('an in-person sale of it is refused for every selling role, even straight at the server', async () => {
    for (const s of [SE, AD, SA]) {
      const r = await call('record_sale', { campaign_id: online.id, tier_counts: {}, auto_assign_block_id: 'x', method: 'cash', payer_name: 'Pat Buyer', build: '9999999' }, { session: s });
      assert.equal(r.status, 400, r.raw);
      assert.match(r.body.error, /online only/i);
    }
    assert.equal(T('payments').filter(p => p.campaign_id === online.id).length, 0);
  });
  await t.test('switching it back to "shown to Sellers" puts it on the Sell screen again', async () => {
    assert.equal((await call('set_campaign_visibility', { campaign_id: online.id, public_only: false }, { session: SA })).status, 200);
    const r = await call('list_campaigns', {}, { session: SE });
    assert.deepEqual(r.body.campaigns.map(c => c.name).sort(), ['In Person Raffle', 'Sunday Cafe']);
  });
});
