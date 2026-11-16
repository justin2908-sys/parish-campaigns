// The most tickets one online purchase can take is 50 (it was 20): a buyer of a raffle can take 50 in one go, 51 is refused in plain words,
// and the safeguard on unpaid tickets per connection still holds.
// Run with:  node --test "test/gateway/*.test.js"   (no network: SumUp is replaced by a stand-in)
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
let SA, sumup;
function reset() {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-16T10:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true });
  SA = addUser('uA-sa', 'superadmin', 'org-A');
  sumup = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (opts.method === 'POST' && u.endsWith('/v0.1/checkouts')) { sumup.push(JSON.parse(opts.body || '{}')); return { ok: true, status: 200, json: async () => ({ id: 'co-' + sumup.length, hosted_checkout_url: 'https://pay.example/' + sumup.length }) }; }
    throw new Error('the network is off in tests: ' + u);
  };
}
async function raffle() {
  const r = await call('create_campaign', { name: 'Big Raffle', kind: 'raffle', age_restricted: true, public_page_enabled: true, public_only: true, keep_until: '2026-12-30',
    tiers: [{ name: 'Ticket', price: 2 }], blocks: [{ type: 'digital', label: 'Online', number_prefix: 'O', range_start: 1, range_end: 200 }] }, { session: SA });
  assert.equal(r.status, 200, r.raw);
  T('tickets').forEach(t => { t.status = 'unsold'; });
  return { id: r.body.campaign.id, tier: r.body.tiers[0].id, block: r.body.blocks[0].id };
}
const buy = (c, n, ip) => call('public_purchase', { campaign_id: c.id, block_id: c.block, tier_counts: { [c.tier]: n }, buyer_name: 'Mary Murphy', contact_value: '07700900123', client_ref: 'ref-' + Math.random().toString(36).slice(2, 12) }, { ip });

test('Tickets in one online purchase', async (t) => {
  await t.test('50 in one purchase is fine, and the buyer is charged for all 50', async () => {
    reset();
    const c = await raffle();
    const r = await buy(c, 50, '10.0.0.1'); assert.equal(r.status, 200, r.raw);
    assert.equal(T('tickets').filter(x => x.status !== 'unsold').length, 50);
    assert.equal(sumup.length, 1); assert.equal(sumup[0].amount, 100);
  });
  await t.test('51 is refused in plain words, and nothing is taken', async () => {
    reset();
    const c = await raffle();
    const r = await buy(c, 51, '10.0.0.2'); assert.equal(r.status, 400); assert.match(r.body.error, /at most 50 tickets in one purchase/);
    assert.equal(T('tickets').filter(x => x.status !== 'unsold').length, 0); assert.equal(sumup.length, 0);
  });
  await t.test('the safeguard on unpaid tickets from one connection (200) still holds: four unpaid baskets of 50, and the fifth is stopped', async () => {
    reset();
    const c = await raffle();
    for (let i = 0; i < 4; i++) assert.equal((await buy(c, 50, '10.0.0.3')).status, 200, 'basket ' + (i + 1));
    const fifth = await buy(c, 1, '10.0.0.3');
    assert.notEqual(fifth.status, 200, 'a fifth would be over 200 unpaid tickets');
    assert.equal(T('tickets').filter(x => x.status !== 'unsold').length, 200);
  });
});
