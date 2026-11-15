// A campaign cannot be made twice: a double tap (or a retry) makes ONE, and a name the church already uses is refused.
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
let SA, PR, SB;
function reset() {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-15T10:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true });
  T('organizations').push({ id: 'org-B', name: 'Other Parish', slug: 'other-parish', timezone: 'Europe/London', gateway_enabled: true });
  SA = addUser('uA-sa', 'superadmin', 'org-A'); PR = addUser('uA-pr', 'priest', 'org-A'); SB = addUser('uB-sa', 'superadmin', 'org-B');
}
const event = (extra, session = SA) => call('create_campaign', {
  name: 'Sunday Cafe Fundraiser', kind: 'event', age_restricted: false, public_page_enabled: true, public_only: true, keep_until: '2026-11-30',
  tiers: [{ name: 'Takeaway', price: 8 }], blocks: [{ type: 'digital', label: 'Online', number_prefix: 'O', range_start: 1, range_end: 100 }], ...extra,
}, { session });
const form = (extra, session = SA) => call('create_campaign', { kind: 'registration', name: 'Film Night', keep_until: '2027-06-01', form_def: { fields: [] }, ...extra }, { session });
const campaigns = (org = 'org-A') => T('campaigns').filter(c => c.org_id === org);

test('The same press, sent twice, makes one campaign', async (t) => {
  await t.test('two requests with the same reference, one after the other: one campaign, the second gets it back', async () => {
    reset();
    const a = await event({ client_ref: 'wiz-abc12345' }); assert.equal(a.status, 200, a.raw);
    const b = await event({ client_ref: 'wiz-abc12345' }); assert.equal(b.status, 200, b.raw);
    assert.equal(b.body.campaign.id, a.body.campaign.id); assert.equal(b.body.replay, true);
    assert.equal(campaigns().length, 1); assert.equal(T('tiers').length, 1); assert.equal(T('tickets').length, 100, 'no second set of tickets');
  });
  await t.test('two requests at the same moment (a real double tap): still one', async () => {
    reset();
    const [a, b] = await Promise.all([event({ client_ref: 'wiz-race1234' }), event({ client_ref: 'wiz-race1234' })]);
    assert.equal(a.status, 200, a.raw); assert.equal(b.status, 200, b.raw);
    assert.equal(a.body.campaign.id, b.body.campaign.id);
    assert.equal(campaigns().length, 1); assert.equal(T('tickets').length, 100);
  });
  await t.test('the same for a registration form', async () => {
    reset();
    const [a, b] = await Promise.all([form({ client_ref: 'form-race1234' }), form({ client_ref: 'form-race1234' })]);
    assert.equal(a.status, 200, a.raw); assert.equal(b.status, 200, b.raw);
    assert.equal(a.body.campaign.id, b.body.campaign.id); assert.equal(campaigns().length, 1);
  });
  await t.test('different references are different campaigns (given different names)', async () => {
    reset();
    assert.equal((await event({ client_ref: 'wiz-one12345', name: 'Dinner One' })).status, 200);
    assert.equal((await event({ client_ref: 'wiz-two12345', name: 'Dinner Two' })).status, 200);
    assert.equal(campaigns().length, 2);
  });
  await t.test('another parish using the same reference gets its own campaign, never ours', async () => {
    reset();
    const a = await event({ client_ref: 'wiz-same1234' });
    const b = await event({ client_ref: 'wiz-same1234' }, SB);
    assert.equal(b.status, 200, b.raw); assert.notEqual(b.body.campaign.id, a.body.campaign.id);
    assert.equal(campaigns('org-A').length, 1); assert.equal(campaigns('org-B').length, 1);
  });
  await t.test('a malformed reference is refused', async () => {
    reset();
    assert.equal((await event({ client_ref: 'x' })).status, 400);
  });
});

test('A name the church already uses is refused', async (t) => {
  await t.test('the same name twice (even with different capitals or spacing) is refused, with a plain reason, and nothing is created', async () => {
    reset();
    assert.equal((await event({})).status, 200);
    const dup = await event({ name: '  sunday   CAFE fundraiser ' });
    assert.equal(dup.status, 400); assert.match(dup.body.error, /already have a campaign called “Sunday Cafe Fundraiser”/);
    assert.equal(campaigns().length, 1); assert.equal(T('tickets').length, 100);
  });
  await t.test('a raffle and a ticket event share one family; a registration form is separate', async () => {
    reset();
    assert.equal((await event({})).status, 200);
    assert.equal((await event({ kind: 'raffle', age_restricted: true })).status, 400, 'a raffle cannot reuse an event\'s name');
    assert.equal((await form({ name: 'Sunday Cafe Fundraiser' })).status, 200, 'but a registration form may');
    const dupForm = await form({ name: 'Sunday Cafe Fundraiser' }); assert.equal(dupForm.status, 400); assert.match(dupForm.body.error, /already have a form called/);
  });
  await t.test('a campaign in the Recycle Bin does not count, so its name can be used again', async () => {
    reset();
    const a = await event({});
    T('campaigns').find(c => c.id === a.body.campaign.id).binned = true;
    assert.equal((await event({})).status, 200);
  });
  await t.test('another parish may use the same name', async () => {
    reset();
    assert.equal((await event({})).status, 200);
    assert.equal((await event({}, SB)).status, 200);
  });
  await t.test('a priest is held to the same rule', async () => {
    reset();
    assert.equal((await event({}, PR)).status, 200);
    assert.equal((await event({}, SA)).status, 400);
  });
});
