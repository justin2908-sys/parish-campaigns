// Who may download a campaign's sales report: the SuperAdmin and the Priest only. Finance no longer can (decided 2026-11-16).
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);

test('Campaign report download', async () => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-16T10:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London' });
  const SA = addUser('u-sa', 'superadmin', 'org-A'), PR = addUser('u-pr', 'priest', 'org-A');
  const FI = addUser('u-fi', 'finance', 'org-A'), AD = addUser('u-ad', 'admin', 'org-A'), SE = addUser('u-se', 'seller', 'org-A');
  const made = await call('create_campaign', { name: 'Raffle', kind: 'raffle', age_restricted: true, public_page_enabled: true, public_only: true, keep_until: '2026-12-30', tiers: [{ name: 'Ticket', price: 2 }], blocks: [{ type: 'digital', label: 'Online', number_prefix: 'O', range_start: 1, range_end: 10 }] }, { session: SA });
  assert.equal(made.status, 200, made.raw);
  const id = made.body.campaign.id;
  assert.equal((await call('export_campaign_report', { campaign_id: id }, { session: SA })).status, 200);
  assert.equal((await call('export_campaign_report', { campaign_id: id }, { session: PR })).status, 200);
  for (const [who, s] of [['finance', FI], ['admin', AD], ['seller', SE]]) assert.equal((await call('export_campaign_report', { campaign_id: id }, { session: s })).status, 403, who);
});
