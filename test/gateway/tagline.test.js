// The optional one-line tagline under a ticketed campaign's name on its public page (e.g. "Buffet Dinner & Family Entertainment").
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
let SA, AD;
function reset() {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-14T10:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true });
  T('organizations').push({ id: 'org-B', name: 'Other Parish', slug: 'other-parish', timezone: 'Europe/London', gateway_enabled: true });
  SA = addUser('uA-sa', 'superadmin', 'org-A'); AD = addUser('uA-ad', 'admin', 'org-A');
}
const make = (extra, session = SA) => call('create_campaign', {
  name: 'Christmas Dinner', kind: 'event', age_restricted: false, public_page_enabled: true, public_only: true, keep_until: '2027-03-01', details_text: 'Bring a chair.',
  tiers: [{ name: 'Adult', price: 15 }], blocks: [{ type: 'digital', label: 'Online', number_prefix: 'O', range_start: 1, range_end: 20 }], ...extra,
}, { session });
const publicInfo = (id) => call('public_campaign_info', { campaign_id: id });

test('Campaign tagline', async (t) => {
  await t.test('a tagline is optional: no tagline is fine, and the public page just has none', async () => {
    reset();
    const r = await make({}); assert.equal(r.status, 200, r.raw);
    const p = await publicInfo(r.body.campaign.id); assert.equal(p.status, 200, p.raw);
    assert.equal(p.body.campaign.tagline, '');
    const blank = await make({ name: 'Another', tagline: '   ' }); assert.equal(blank.status, 200); assert.equal((await publicInfo(blank.body.campaign.id)).body.campaign.tagline, '');
  });
  await t.test('a tagline is saved and shown on the public page', async () => {
    reset();
    const r = await make({ tagline: 'Buffet Dinner & Family Entertainment' }); assert.equal(r.status, 200, r.raw);
    const p = await publicInfo(r.body.campaign.id);
    assert.equal(p.body.campaign.tagline, 'Buffet Dinner & Family Entertainment');
    assert.equal(p.body.campaign.details_text, 'Bring a chair.', 'the details are separate');
  });
  await t.test('it must stay short and on one line: 50 characters, line breaks and stray spaces tidied', async () => {
    reset();
    const fifty = 'x'.repeat(50);
    assert.equal((await make({ tagline: fifty })).status, 200);
    const long = await make({ tagline: fifty + 'y' }); assert.equal(long.status, 400); assert.match(long.body.error, /50 characters/);
    assert.equal(T('campaigns').filter(c => c.tagline === fifty + 'y').length, 0);
    const r = await make({ tagline: '  Buffet\n  and   dancing ' }); assert.equal(r.status, 200);
    assert.equal(T('campaigns').find(c => c.id === r.body.campaign.id).tagline, 'Buffet and dancing');
  });
  await t.test('it can be added, changed and cleared later, and saving it does not disturb the details (nor the reverse)', async () => {
    reset();
    const id = (await make({})).body.campaign.id;
    assert.equal((await call('set_campaign_details', { campaign_id: id, tagline: 'Turkey and all the trimmings' }, { session: SA })).status, 200);
    let c = T('campaigns').find(x => x.id === id); assert.equal(c.tagline, 'Turkey and all the trimmings'); assert.equal(c.details_text, 'Bring a chair.');
    assert.equal((await call('set_campaign_details', { campaign_id: id, details_text: 'Bring two chairs.' }, { session: SA })).status, 200);
    c = T('campaigns').find(x => x.id === id); assert.equal(c.tagline, 'Turkey and all the trimmings', 'saving the details leaves the tagline'); assert.equal(c.details_text, 'Bring two chairs.');
    assert.equal((await call('set_campaign_details', { campaign_id: id, tagline: '' }, { session: SA })).status, 200);
    assert.equal(T('campaigns').find(x => x.id === id).tagline, null, 'an empty tagline clears it');
    assert.equal((await call('set_campaign_details', { campaign_id: id, tagline: 'z'.repeat(51) }, { session: SA })).status, 400);
  });
  await t.test('only a superadmin or priest can set it, and only within their own parish', async () => {
    reset();
    const id = (await make({})).body.campaign.id;
    assert.equal((await call('set_campaign_details', { campaign_id: id, tagline: 'Nope' }, { session: AD })).status, 403);
    const other = addUser('uB-sa', 'superadmin', 'org-B');
    assert.notEqual((await call('set_campaign_details', { campaign_id: id, tagline: 'Nope' }, { session: other })).status, 200);
    assert.equal(T('campaigns').find(x => x.id === id).tagline == null, true);
  });
  await t.test('the campaign list (for the office) carries the tagline', async () => {
    reset();
    const id = (await make({ tagline: 'Buffet Dinner' })).body.campaign.id;
    const l = await call('list_campaigns', { include_inactive: true }, { session: SA });
    assert.equal(l.body.campaigns.find(c => c.id === id).tagline, 'Buffet Dinner');
  });
});
