// A draft (a campaign or form that was started and never opened) can be deleted for good; anything else cannot.
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
let SA, AD, PR, FI, SB;
function reset() {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-15T10:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true });
  T('organizations').push({ id: 'org-B', name: 'Other Parish', slug: 'other-parish', timezone: 'Europe/London', gateway_enabled: true });
  SA = addUser('uA-sa', 'superadmin', 'org-A'); AD = addUser('uA-ad', 'admin', 'org-A'); PR = addUser('uA-pr', 'priest', 'org-A'); FI = addUser('uA-fi', 'finance', 'org-A'); SB = addUser('uB-sa', 'superadmin', 'org-B');
}
const event = (extra, session = SA) => call('create_campaign', { name: 'Draft Dinner', kind: 'event', age_restricted: false, public_page_enabled: true, public_only: true, keep_until: '2026-12-30', is_draft: true,
  tiers: [{ name: 'Adult', price: 10 }], blocks: [{ type: 'digital', label: 'Online', number_prefix: 'O', range_start: 1, range_end: 20 }], ...extra }, { session });
const form = (extra, session = SA) => call('create_campaign', { kind: 'registration', name: 'Draft Form', keep_until: '2027-06-01', is_draft: true, form_def: { fields: [] }, ...extra }, { session });
const del = (id, session = SA) => call('delete_draft_campaign', { campaign_id: id }, { session });
const unsoldTickets = () => T('tickets').forEach(t => { t.status = 'unsold'; });   // (the stand-in database does not fill in the default)

test('Deleting a draft', async (t) => {
  await t.test('a draft ticketed campaign is deleted completely: the campaign, its prices, series and tickets', async () => {
    reset();
    const c = (await event({})).body.campaign;
    assert.equal(T('tickets').length, 20); unsoldTickets();
    const r = await del(c.id); assert.equal(r.status, 200, r.raw);
    assert.equal(T('campaigns').length, 0); assert.equal(T('tiers').length, 0); assert.equal(T('ticket_blocks').length, 0); assert.equal(T('tickets').length, 0);
  });
  await t.test('a draft registration form is deleted too', async () => {
    reset();
    const f = (await form({})).body.campaign;
    assert.equal((await del(f.id)).status, 200); assert.equal(T('campaigns').length, 0);
  });
  await t.test('only the draft goes: other campaigns are untouched', async () => {
    reset();
    const keep = (await event({ name: 'Kept Dinner', is_draft: false })).body.campaign, drop = (await event({})).body.campaign;
    unsoldTickets();
    assert.equal((await del(drop.id)).status, 200);
    assert.deepEqual(T('campaigns').map(c => c.id), [keep.id]); assert.equal(T('tickets').length, 20); assert.equal(T('tiers').length, 1);
  });
  await t.test('a campaign that has been opened cannot be deleted (it can be moved to the Recycle Bin)', async () => {
    reset();
    const c = (await event({ is_draft: false })).body.campaign;
    const r = await del(c.id); assert.equal(r.status, 400); assert.match(r.body.error, /Only a draft/);
    assert.equal(T('campaigns').length, 1);
  });
  await t.test('a draft with any sale, payment, registration or waiting-list entry is kept', async () => {
    reset();
    const c = (await event({})).body.campaign; unsoldTickets();
    T('payments').push({ id: 'p1', campaign_id: c.id });
    assert.equal((await del(c.id)).status, 400); assert.equal(T('campaigns').length, 1);
    T('payments').length = 0; T('tickets')[0].status = 'paid';
    assert.equal((await del(c.id)).status, 400);
    T('tickets')[0].status = 'unsold'; T('registrations').push({ id: 'r1', campaign_id: c.id });
    assert.equal((await del(c.id)).status, 400);
    T('registrations').length = 0; assert.equal((await del(c.id)).status, 200, 'once nothing is on it, it can go');
  });
  await t.test('who may delete: SuperAdmin and Priest; not Admin or a Seller; Finance only for a form they made; never across parishes', async () => {
    reset();
    const c = (await event({})).body.campaign; unsoldTickets();
    assert.equal((await del(c.id, AD)).status, 403);
    assert.equal((await del(c.id, FI)).status, 403, 'finance cannot delete a ticketed draft');
    assert.notEqual((await del(c.id, SB)).status, 200, 'another parish cannot');
    assert.equal(T('campaigns').length, 1);
    const mine = (await form({}, FI)).body.campaign, notMine = (await form({ name: 'Other Draft Form' }, SA)).body.campaign;
    assert.equal((await del(notMine.id, FI)).status, 403, 'finance cannot delete a form somebody else made');
    assert.equal((await del(mine.id, FI)).status, 200, 'but can delete a draft form they made');
    assert.equal((await del(c.id, PR)).status, 200, 'a priest can');
  });
  await t.test('the Repository, Listings and Candles hidden campaigns cannot be deleted this way', async () => {
    reset();
    T('campaigns').push({ id: 'hid-1', org_id: 'org-A', name: 'Listings, November 2026', kind: 'registration', is_draft: true, binned: false, form_def: { listings: true } });
    const r = await del('hid-1'); assert.notEqual(r.status, 200); assert.equal(T('campaigns').length, 1);
  });
});
