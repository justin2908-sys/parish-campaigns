// How long after "keep the details until" the names and contact details are removed is chosen per campaign: 30 to 90 days, 30 by default (2026-11-18).
// The nightly removal itself runs inside the database (migration 20261118000000_retention_days.sql); here we test what the server accepts, stores and tells people.
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
const raffle = (name, extra = {}) => ({ name, kind: 'raffle', tiers: [{ name: 'Single', price: 2, tickets: 1 }], blocks: [{ type: 'digital', label: 'Online', number_prefix: 'O', range_start: 1, range_end: 20 }], age_restricted: false, public_page_enabled: true, keep_until: '2027-06-01', ...extra });

test('Removal days after "keep until"', async (t) => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-18T10:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London' });
  const SA = addUser('u-sa', 'superadmin', 'org-A');
  const stored = (id) => T('campaigns').find(c => c.id === id).retention_days;

  await t.test('a new campaign that does not say gets 30 days', async () => {
    const r = await call('create_campaign', raffle('Default Raffle'), { session: SA });
    assert.equal(r.status, 200, r.raw);
    assert.equal(stored(r.body.campaign.id), 30);
  });
  await t.test('30, 45 and 90 are accepted and stored', async () => {
    for (const n of [30, 45, 90, '60']) {
      const r = await call('create_campaign', raffle('Raffle ' + n, { retention_days: n }), { session: SA });
      assert.equal(r.status, 200, n + ' ' + r.raw);
      assert.equal(stored(r.body.campaign.id), Number(n));
    }
  });
  await t.test('under 30, over 90, fractions and nonsense are refused, and nothing is created', async () => {
    const before = T('campaigns').length;
    for (const n of [29, 0, -30, 91, 365, 45.5, 'abc']) {
      const r = await call('create_campaign', raffle('Bad ' + n, { retention_days: n }), { session: SA });
      assert.equal(r.status, 400, n + ' ' + r.raw);
      assert.match(r.body.error, /between 30 and 90/);
    }
    assert.equal(T('campaigns').length, before);
  });
  await t.test('a registration form gets the same rule', async () => {
    const mk = (extra) => call('create_campaign', { name: 'Form ' + JSON.stringify(extra), kind: 'registration', keep_until: '2027-06-01', ...extra }, { session: SA });
    const ok = await mk({ retention_days: 40 });
    assert.equal(ok.status, 200, ok.raw); assert.equal(stored(ok.body.campaign.id), 40);
    const def = await mk({});
    assert.equal(def.status, 200, def.raw); assert.equal(stored(def.body.campaign.id), 30);
    assert.equal((await mk({ retention_days: 10 })).status, 400);
    assert.equal((await mk({ retention_days: 120 })).status, 400);
  });
  await t.test('changing it later: the new day is reported, bad values are refused, and leaving it out changes nothing', async () => {
    const c = (await call('create_campaign', raffle('Change Me', { retention_days: 30, keep_until: '2027-06-01' }), { session: SA })).body.campaign;
    const base = { campaign_id: c.id, keep_until: '2027-06-01' };
    let r = await call('set_campaign_dates', { ...base, retention_days: 60 }, { session: SA });
    assert.equal(r.status, 200, r.raw); assert.equal(r.body.delete_on, '2027-07-31'); assert.equal(stored(c.id), 60);
    r = await call('set_campaign_dates', { ...base, retention_days: 29 }, { session: SA });
    assert.equal(r.status, 400, r.raw); assert.equal(stored(c.id), 60);
    r = await call('set_campaign_dates', { ...base, retention_days: 91 }, { session: SA });
    assert.equal(r.status, 400, r.raw);
    r = await call('set_campaign_dates', { ...base }, { session: SA });   // an older screen that does not send it
    assert.equal(r.status, 200, r.raw); assert.equal(r.body.delete_on, '2027-07-31'); assert.equal(stored(c.id), 60);
  });
  await t.test('moving the date so the removal day is already past asks for confirmation, using that campaign\'s own days', async () => {
    const c = (await call('create_campaign', raffle('Old One', { retention_days: 30 }), { session: SA })).body.campaign;
    T('payments').push({ id: 'p1', campaign_id: c.id, status: 'paid', method: 'cash', amount: 2, payer_name: 'Pat Buyer', contact_value: '07700900123' });
    // 30 days after 15 Oct is 14 Nov: already gone by 18 Nov. With 90 days it would be 13 Jan, still to come.
    const warn = await call('set_campaign_dates', { campaign_id: c.id, keep_until: '2026-10-15', retention_days: 30 }, { session: SA });
    assert.equal(warn.status, 409, warn.raw); assert.match(warn.body.error, /more than 30 days ago/);
    const fine = await call('set_campaign_dates', { campaign_id: c.id, keep_until: '2026-10-15', retention_days: 90 }, { session: SA });
    assert.equal(fine.status, 200, fine.raw); assert.equal(fine.body.delete_on, '2027-01-13');
  });
  await t.test('the public buy page is told how many days, so it never promises the wrong number', async () => {
    const c = (await call('create_campaign', raffle('Public One', { retention_days: 45 }), { session: SA })).body.campaign;
    const r = await call('public_campaign_info', { campaign_id: c.id }, {});
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.campaign.retention_days, 45);
  });
});
