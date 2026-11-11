// Hearts: a visitor can heart a listing or a Repository item (no sign-in), once each, and take it back; the count shows on the page, feeds a small,
// capped part of the ordering, and never buys position for money.
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
let S;
const webp = (n = 1500) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(n, 7)]).toString('base64');
let itemSeq = 0;
const item = (org_id, name, price, extra) => { const id = `00000000-0000-4000-8000-${String(++itemSeq).padStart(12, '0')}`; T('repository_items').push({ id, org_id, name, price, stock: null, available: true, sort: 0, hearts: 0, ...extra }); return id; };
let I;

function reset(at = '2026-11-10T10:00:00Z') {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set(at);
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true, display_name: null });
  T('organizations').push({ id: 'org-B', name: 'Other Parish', slug: 'other-parish', timezone: 'Europe/London', gateway_enabled: true });
  S = { adA: addUser('uA-ad', 'admin', 'org-A'), adB: addUser('uB-ad', 'admin', 'org-B') };
  T('listings_settings').push({ org_id: 'org-A', enabled: true, intro_text: null, price_base: 3, price_per_extra_week: 1.5, price_per_image: 0.5 });
  T('listings_settings').push({ org_id: 'org-B', enabled: true, intro_text: null, price_base: 3, price_per_extra_week: 1.5, price_per_image: 0.5 });
  T('repository_settings').push({ org_id: 'org-A', enabled: true, slots: [], cutoff_weekday: 3, cutoff_time: '23:59', intro_text: null, next_ref: 1 });
  I = {
    a: item('org-A', 'Rosary beads', 4.5, { category: 'Devotional' }),
    b: item('org-A', 'Votive candle', 2, { category: 'Devotional' }),
    c: item('org-A', 'Prayer book', 6, { category: 'Books' }),
    hidden: item('org-A', 'Not for sale', 5, { available: false }),
    other: item('org-B', 'Other parish item', 3),
  };
}
let seq = 0;
const make = (over) => call('public_listing_create', {
  slug: 'svp-osterley', title: 'Garden chairs, set of four', description: 'Four sturdy wooden garden chairs, a few years old but in good condition. Collect from Osterley.', category: 'Furniture & home', kind: 'sell',
  price_text: '£40 the set', display_name: 'Mary', email: 'mary@example.org', email_confirm: 'mary@example.org', days: 14, images: [{ t: webp(1500), f: webp(20000) }], amount: 0, agree: true, client_ref: 'ref-' + (++seq) + '-' + Math.random().toString(36).slice(2, 10), ...over,
});
const goLive = async (over) => { const r = await make(over); assert.equal(r.status, 200, r.raw); const l = T('listings').find(x => x.token === r.body.token); const a = await call('listings_review', { id: l.id, decision: 'approve' }, { session: S.adA }); assert.equal(a.status, 200, a.raw); return l; };
const heart = (kind, id, on, ip, slug = 'svp-osterley') => call('public_heart', { slug, kind, id, on }, { ip });
const list = () => call('public_listings', { slug: 'svp-osterley' });
const shop = () => call('public_shop', { slug: 'svp-osterley' });
const hearts = (arr, id) => arr.find(x => x.id === id).hearts;

test('Hearts on listings', async (t) => {
  await t.test('one heart per visitor, it can be taken back, and the count shows on the page', async () => {
    reset();
    const l = await goLive();
    assert.equal(hearts((await list()).body.listings, l.id), 0);
    let r = await heart('listing', l.id, true, '10.0.0.1');
    assert.equal(r.status, 200, r.raw); assert.equal(r.body.hearts, 1); assert.equal(r.body.on, true);
    assert.equal((await heart('listing', l.id, true, '10.0.0.1')).body.hearts, 1, 'the same visitor pressing twice is still one');
    assert.equal((await heart('listing', l.id, true, '10.0.0.2')).body.hearts, 2);
    assert.equal(hearts((await list()).body.listings, l.id), 2);
    r = await heart('listing', l.id, false, '10.0.0.1');
    assert.equal(r.body.hearts, 1); assert.equal(r.body.on, false);
    assert.equal((await heart('listing', l.id, false, '10.0.0.1')).body.hearts, 1, 'taking back twice does not go lower');
    assert.equal(hearts((await list()).body.listings, l.id), 1);
  });
  await t.test('a stored heart is a scrambled address, never an IP address', async () => {
    reset();
    const l = await goLive();
    await heart('listing', l.id, true, '203.0.113.77');
    assert.equal(T('hearts').length, 1);
    assert.equal(JSON.stringify(T('hearts')).includes('203.0.113.77'), false);
    assert.match(T('hearts')[0].ip_hash, /^h:[0-9a-f]{24}$/);
  });
  await t.test('only a live listing in your own parish can be hearted', async () => {
    reset();
    const l = await goLive();
    T('listings').push({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', org_id: 'org-B', token: 'b'.repeat(32), title: 'B parish listing here', description: 'x'.repeat(30), category: 'Other', kind: 'sell', email: 'b@example.org', days: 7, status: 'live', images: [], starts_at: '2026-11-09T00:00:00.000Z', ends_at: '2026-11-30T00:00:00.000Z', views: 0, contacts: 0, reports: 0, hearts: 0, featured: false, created_at: '2026-11-09T00:00:00.000Z' });
    assert.equal((await heart('listing', '11111111-1111-4111-8111-111111111111', true, '10.0.0.1')).status, 404);
    assert.equal((await heart('listing', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true, '10.0.0.1')).status, 404, 'another parish\'s listing is not reachable from this parish');
    T('listings').find(x => x.id === l.id).status = 'withdrawn';
    assert.equal((await heart('listing', l.id, true, '10.0.0.1')).status, 404, 'a taken-down listing cannot be hearted');
    assert.equal(T('hearts').length, 0);
  });
  await t.test('a bad request is refused plainly, and a flood is stopped', async () => {
    reset();
    const l = await goLive();
    assert.equal((await heart('rubbish', l.id, true, '10.0.0.1')).status, 400);
    assert.equal((await heart('listing', 'not-an-id', true, '10.0.0.1')).status, 404);
    for (let i = 0; i < 120; i++) await heart('listing', l.id, i % 2 === 0, '10.7.7.7');
    assert.equal((await heart('listing', l.id, true, '10.7.7.7')).status, 429);
  });
  await t.test('hearts lift a listing a little, but never above what the office picked, and a loved shelf appears at three', async () => {
    reset();
    const a = await goLive({ title: 'The first listing here' }), b = await goLive({ title: 'The second listing here' }), c = await goLive({ title: 'The third listing here' });
    T('listings').find(x => x.id === a.id).starts_at = T('listings').find(x => x.id === b.id).starts_at = T('listings').find(x => x.id === c.id).starts_at = '2026-10-20T00:00:00.000Z';   // all the same age
    for (let i = 0; i < 2; i++) await heart('listing', b.id, true, '10.1.1.' + i);
    let r = (await list()).body;
    assert.equal(r.listings[0].id, b.id, 'hearts break a tie');
    assert.equal(r.shelves.some(s => s.key === 'loved'), false, 'two hearts is not yet a shelf');
    for (let i = 0; i < 60; i++) await heart('listing', c.id, true, '10.2.2.' + i);
    for (let i = 2; i < 5; i++) await heart('listing', b.id, true, '10.1.1.' + i);
    T('listings').find(x => x.id === a.id).featured = true;   // the office picks the one nobody has hearted
    r = (await list()).body;
    assert.equal(r.listings[0].id, a.id, 'an office pick stays above even a very hearted one');
    const loved = r.shelves.find(s => s.key === 'loved');
    assert.deepEqual(loved.ids, [c.id, b.id], 'most hearts first');
  });
  await t.test('the office sees the count on each listing', async () => {
    reset();
    const l = await goLive();
    await heart('listing', l.id, true, '10.0.0.1'); await heart('listing', l.id, true, '10.0.0.2');
    const g = await call('listings_get', {}, { session: S.adA });
    assert.equal(g.body.live.find(x => x.id === l.id).hearts, 2);
  });
  await t.test('old who-hearted-what records are cleared after 180 days, and the count stays', async () => {
    reset('2026-01-01T10:00:00Z');
    const l = await goLive();
    await heart('listing', l.id, true, '10.0.0.1');
    clock.set('2026-11-10T16:00:00Z');   // (a later hour than the other tests, so the half-hourly housekeeping is due)
    T('listings').find(x => x.id === l.id).ends_at = '2026-12-30T00:00:00.000Z';
    await list();   // the half-hourly housekeeping runs
    assert.equal(T('hearts').length, 0);
    assert.equal(T('listings').find(x => x.id === l.id).hearts, 1);
  });
});

test('Hearts on Repository items', async (t) => {
  await t.test('hearting an item counts once per visitor and shows in the shop window', async () => {
    reset();
    assert.equal(hearts((await shop()).body.items, I.a), 0);
    assert.equal((await heart('item', I.a, true, '10.0.0.1')).body.hearts, 1);
    assert.equal((await heart('item', I.a, true, '10.0.0.1')).body.hearts, 1);
    assert.equal((await heart('item', I.a, true, '10.0.0.2')).body.hearts, 2);
    assert.equal(hearts((await shop()).body.items, I.a), 2);
    assert.equal((await heart('item', I.a, false, '10.0.0.2')).body.hearts, 1);
    assert.equal(hearts((await shop()).body.items, I.a), 1);
  });
  await t.test('only an item on sale in this parish can be hearted', async () => {
    reset();
    assert.equal((await heart('item', I.hidden, true, '10.0.0.1')).status, 404);
    assert.equal((await heart('item', I.other, true, '10.0.0.1')).status, 404, 'another parish\'s item is not reachable from this parish');
    assert.equal((await heart('item', I.a, true, '10.0.0.1', 'other-parish')).status, 404, 'and this parish\'s item is not reachable from theirs');
    assert.equal(T('hearts').length, 0);
  });
  await t.test('hearts lift an item within its category, and "Parish favourites" appears at three; real sales and picks still count for more', async () => {
    reset();
    for (let i = 0; i < 3; i++) await heart('item', I.b, true, '10.1.1.' + i);
    let r = (await shop()).body;
    const devo = r.items.filter(x => x.category === 'Devotional').map(x => x.id);
    assert.deepEqual(devo, [I.b, I.a], 'the hearted candle is ahead of the rosary beads');
    assert.equal(r.shelves.some(s => s.key === 'loved'), false, 'one hearted item alone makes no shelf');
  });
  await t.test('two or more hearted items make a shelf, with the most hearts first', async () => {
    reset();
    for (let i = 0; i < 3; i++) await heart('item', I.a, true, '10.1.1.' + i);
    for (let i = 0; i < 5; i++) await heart('item', I.b, true, '10.2.2.' + i);
    const r = (await shop()).body;
    const s = r.shelves.find(x => x.key === 'loved');
    assert.equal(s.title, 'Parish favourites'); assert.deepEqual(s.ids, [I.b, I.a]);
    T('repository_items').find(x => x.id === I.c).featured = true; T('repository_items').find(x => x.id === I.c).category = 'Devotional';
    const r2 = (await shop()).body;
    assert.equal(r2.items.filter(x => x.category === 'Devotional')[0].id, I.c, 'an office pick stays above a hearted item');
  });
  await t.test('the office sees the count, and deleting an item removes its hearts', async () => {
    reset();
    await heart('item', I.a, true, '10.0.0.1'); await heart('item', I.a, true, '10.0.0.2');
    const g = await call('shop_get', {}, { session: S.adA });
    assert.equal(g.body.items.find(x => x.id === I.a).hearts, 2);
    assert.equal((await call('shop_item_delete', { id: I.a }, { session: S.adA })).status, 200);
    assert.equal(T('hearts').filter(h => h.kind === 'item').length, 0);
  });
  await t.test('an edit by the office keeps the hearts', async () => {
    reset();
    await heart('item', I.b, true, '10.0.0.1');
    assert.equal(T('repository_items').find(x => x.id === I.b).hearts, 1);
    const g = await call('shop_item_set_featured', { id: I.b, featured: true }, { session: S.adA });
    assert.equal(g.status, 200);
    assert.equal(T('repository_items').find(x => x.id === I.b).hearts, 1, 'an edit by the office does not reset the count');
  });
});
