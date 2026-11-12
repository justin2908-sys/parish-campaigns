// The Priest can do everything a SuperAdmin can (decided 2026-11-12), with one safeguard: only a SuperAdmin can create, disable or reset the password of
// a SuperAdmin account, so the church's owner login cannot be taken over or locked out.
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
let S;
function reset() {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-12T10:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true });
  T('organizations').push({ id: 'org-B', name: 'Other Parish', slug: 'other-parish', timezone: 'Europe/London', gateway_enabled: true });
  S = { sa: addUser('uA-sa', 'superadmin', 'org-A'), ad: addUser('uA-ad', 'admin', 'org-A'), pr: addUser('uA-pr', 'priest', 'org-A'), se: addUser('uA-se', 'seller', 'org-A'), saB: addUser('uB-sa', 'superadmin', 'org-B') };
}
const raffle = (name) => ({ name, kind: 'raffle', tiers: [{ name: 'Single', price: 2, tickets: 1 }], blocks: [{ type: 'digital', label: 'Online', number_prefix: 'O', range_start: 1, range_end: 20 }], age_restricted: false, keep_until: '2027-06-01' });

test('A priest can create and manage a ticketed event', async (t) => {
  await t.test('a priest creates a ticketed event, the same as a superadmin', async () => {
    reset();
    const byPriest = await call('create_campaign', raffle('Autumn Raffle'), { session: S.pr });
    assert.equal(byPriest.status, 200, byPriest.raw);
    const bySuper = await call('create_campaign', raffle('Spring Raffle'), { session: S.sa });
    assert.equal(bySuper.status, 200, bySuper.raw);
    assert.equal((await call('create_campaign', raffle('Admin Raffle'), { session: S.ad })).status, 403, 'an admin still cannot');
    assert.equal((await call('create_campaign', raffle('Seller Raffle'), { session: S.se })).status, 403, 'nor a seller');
    assert.equal(T('campaigns').filter(c => c.org_id === 'org-A').length, 2);
  });
  await t.test('and manages it: details, the bin, and the lists a superadmin sees', async () => {
    reset();
    const c = (await call('create_campaign', raffle('Autumn Raffle'), { session: S.pr })).body.campaign;
    assert.equal((await call('set_campaign_details', { campaign_id: c.id, details_text: 'Draw after Mass' }, { session: S.pr })).status, 200);
    assert.equal((await call('list_campaigns', { include_inactive: true }, { session: S.pr })).status, 200);
    assert.equal((await call('list_binned_campaigns', {}, { session: S.pr })).status, 200);
    assert.equal((await call('privacy_search', { query: 'nobody@example.org' }, { session: S.pr })).status, 403, 'private records still need the confidentiality statement accepted first');
    T('users').find(u => u.id === 'uA-pr').confidentiality_version = 99;
    assert.equal((await call('privacy_search', { query: 'nobody@example.org' }, { session: S.pr })).status, 200);
  });
  await t.test('a priest cannot reach another parish', async () => {
    reset();
    const other = (await call('create_campaign', raffle('Other Raffle'), { session: S.saB })).body.campaign;
    assert.equal((await call('set_campaign_details', { campaign_id: other.id, details_text: 'x' }, { session: S.pr })).status === 200, false, 'someone else\'s campaign is out of reach');
  });
});

test('A priest can manage people, except a SuperAdmin’s account', async (t) => {
  const mk = (who, over) => call('create_user', { name: 'New Person', mobile: '07700900111', role: 'seller', password: 'Str0ng!Passw0rd', ...over }, { session: S[who] });
  await t.test('a priest lists, adds, disables and resets the password of sellers, admins, finance and other priests', async () => {
    reset();
    assert.equal((await call('list_users', {}, { session: S.pr })).status, 200);
    for (const [role, mobile] of [['seller', '07700900111'], ['admin', '07700900112'], ['finance', '07700900113'], ['priest', '07700900114']]) {
      const r = await mk('pr', { role, mobile }); assert.equal(r.status, 200, role + ' ' + r.raw);
    }
    const seller = T('users').find(u => u.role === 'seller' && u.mobile === '07700900111');
    assert.equal((await call('set_user_active', { user_id: seller.id, active: false }, { session: S.pr })).status, 200);
    assert.equal(T('users').find(u => u.id === seller.id).active, false);
    assert.equal((await call('reset_password', { user_id: seller.id, new_password: 'An0ther!Passw0rd' }, { session: S.pr })).status, 200);
  });
  await t.test('but not a SuperAdmin: no creating one, no disabling one, no resetting its password', async () => {
    reset();
    assert.equal((await mk('pr', { role: 'superadmin', mobile: '07700900115' })).status, 403);
    assert.equal(T('users').filter(u => u.role === 'superadmin').length, 2, 'no new superadmin was made');
    const before = JSON.stringify(T('users').find(u => u.id === 'uA-sa'));
    assert.equal((await call('set_user_active', { user_id: 'uA-sa', active: false }, { session: S.pr })).status, 403);
    assert.equal((await call('reset_password', { user_id: 'uA-sa', new_password: 'Hijack!Passw0rd1' }, { session: S.pr })).status, 403);
    assert.equal(JSON.stringify(T('users').find(u => u.id === 'uA-sa')), before, 'the superadmin\'s account is untouched');
    assert.equal((await mk('sa', { role: 'superadmin', mobile: '07700900116' })).status, 200, 'a superadmin still can');
  });
  await t.test('an admin, finance and a seller still cannot manage people', async () => {
    reset();
    assert.equal((await mk('ad', { mobile: '07700900117' })).status, 403);
    assert.equal((await mk('se', { mobile: '07700900118' })).status, 403);
  });
});
