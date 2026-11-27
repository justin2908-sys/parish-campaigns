// The parish page keeps its answer for a short while (30 seconds) so most visitors do not wait on the database;
// a change made through the app shows at once (2026-11-27).
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
let S;
function reset() {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-27T12:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true, display_name: 'St Vincent De Paul', gateway_daily: false });
  S = { sa: addUser('u-sa', 'superadmin', 'org-A') };
}
const page = () => call('public_gateway', { slug: 'svp-osterley' });
const name = (r) => r.body.org.name;

test('Parish page short memory', async (t) => {
  const saved = process.env.GATEWAY_CACHE_SECONDS;
  t.after(() => { process.env.GATEWAY_CACHE_SECONDS = saved; });

  await t.test('switched off (0), every visit is built fresh', async () => {
    process.env.GATEWAY_CACHE_SECONDS = '0'; reset();
    assert.equal(name(await page()), 'St Vincent De Paul');
    T('organizations')[0].display_name = 'Renamed';
    assert.equal(name(await page()), 'Renamed');
  });

  await t.test('on: a second visit within 30 seconds is answered from memory, and after 30 seconds it is built fresh', async () => {
    process.env.GATEWAY_CACHE_SECONDS = '30'; reset();
    assert.equal(name(await page()), 'St Vincent De Paul');
    T('organizations')[0].display_name = 'Changed behind the scenes';   // not through the app
    clock.set('2026-11-27T12:00:20Z');
    assert.equal(name(await page()), 'St Vincent De Paul', 'still the remembered page');
    clock.set('2026-11-27T12:00:31Z');
    assert.equal(name(await page()), 'Changed behind the scenes', 'remembered for 30 seconds only');
  });

  await t.test('on: a change made through the app shows on the very next visit', async () => {
    process.env.GATEWAY_CACHE_SECONDS = '30'; reset();
    const before = await page();
    assert.equal(before.body.announcement, null);
    const saved = await call('gateway_save_announcement', { message: 'Mass times change this week', urgent: false }, { session: S.sa });
    assert.equal(saved.status, 200, saved.raw);
    const after = await page();
    assert.equal(after.body.announcement && after.body.announcement.message, 'Mass times change this week');
    await call('gateway_clear_announcement', {}, { session: S.sa });
    assert.equal((await page()).body.announcement, null);
  });

  await t.test('on: pages that are not available are never remembered, and each parish has its own', async () => {
    process.env.GATEWAY_CACHE_SECONDS = '30'; reset();
    T('organizations').push({ id: 'org-B', name: 'Other', slug: 'other-parish', timezone: 'Europe/London', gateway_enabled: false, gateway_daily: false });
    assert.equal((await call('public_gateway', { slug: 'other-parish' })).status, 404);
    T('organizations')[1].gateway_enabled = true;
    assert.equal((await call('public_gateway', { slug: 'other-parish' })).status, 200, 'a refusal is not kept');
    assert.equal((await call('public_gateway', { slug: 'nobody-here' })).status, 404);
    assert.equal(name(await page()), 'St Vincent De Paul'); assert.equal((await call('public_gateway', { slug: 'other-parish' })).body.org.name, 'Other');
  });
});
