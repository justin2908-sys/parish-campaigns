// The Repository: reading SumUp's real export, the weekly sync, small product pictures, and what the shop shows first.
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'sumup-items-export-sample.csv'), 'utf8');
let S;
function reset(at = '2026-11-09T12:00:00Z') {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  db.uploads.length = 0;
  clock.set(at);
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true });
  T('organizations').push({ id: 'org-B', name: 'Other', slug: 'other-parish', timezone: 'Europe/London', gateway_enabled: true });
  S = { adA: addUser('uA-ad', 'admin', 'org-A'), seA: addUser('uA-se', 'seller', 'org-A'), saB: addUser('uB-sa', 'superadmin', 'org-B') };
  T('repository_settings').push({ org_id: 'org-A', enabled: true, slots: [{ id: 's1', label: 'Vigil Mass', weekday: 6, time: '18:00' }], cutoff_weekday: 3, cutoff_time: '23:59', intro_text: null, next_ref: 1 });
}
const imp = (text, over, who = 'adA') => call('shop_import', { text, ...(over || {}) }, { session: S[who] });
const mine = () => T('repository_items').filter(i => i.org_id === 'org-A');
const byName = (n) => mine().find(i => i.name === n);
// a copy of the sample with some cells changed, the way next week's export would differ
const edit = (fn) => { const lines = FIXTURE.trimEnd().split('\n'); return fn(lines).join('\n') + '\n'; };
// a tiny valid WebP (RIFF....WEBP) and JPEG header, enough for the server's checks
const webp = (n = 2000) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(n, 7)]).toString('base64');
const jpeg = (n = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 1)]).toString('base64');
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100, 1)]).toString('base64');

test('Reading SumUp\'s own export', async (t) => {
  await t.test('only the repository (R-) items, options split out, names tidied, prices, stock and pictures read', async () => {
    reset();
    const r = await imp(FIXTURE);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.format, 'sumup'); assert.equal(r.body.committed, false);
    assert.equal(T('repository_items').length, 0, 'a preview saves nothing');
    assert.ok(r.body.not_repository >= 3, 'BBQ, Bingo and Sunday Cafe are other campaigns: ' + r.body.not_repository);
    const c = await imp(FIXTURE, { commit: true });
    assert.equal(c.status, 200, c.raw);
    const names = mine().map(i => i.name).sort();
    assert.ok(names.includes("Wall Sign 'Lord Please Correct Me When Wrong"), 'the stray leading tab is gone');
    assert.ok(names.includes('Communion - candle and rosary (Standard)') && names.includes('Communion - candle and rosary (Blue)'), 'options are separate items: ' + names.join(' | '));
    assert.ok(names.includes('Communion - picture frames (boy)') && names.includes('Communion - picture frames (Girl)'));
    assert.ok(names.includes('Statues (Mary)'));
    assert.ok(!names.some(n => /BBQ|Bingo|Sunday Cafe|Donation/.test(n)));
    assert.equal(mine().some(i => i.name === 'Communion - candle and rosary'), false, 'the parent line of an item with options is not itself an item');
    assert.deepEqual(r.body.skipped.map(s => s.reason), ['no price']);   // Donation
  });
  await t.test('categories lose their "R-", a shared category picks the repository one, prices and stock are right, minus numbers become 0', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    assert.equal(byName('Star- Ornament').category, 'Christmas');
    assert.equal(byName('Acrylic Fridge Magnet').category, 'General');
    assert.equal(byName("Wall Sign 'Lord Please Correct Me When Wrong").category, 'Prayer gifts');
    assert.equal(byName("Wall Sign 'Lord Please Correct Me When Wrong").price, 7); assert.equal(byName("Wall Sign 'Lord Please Correct Me When Wrong").stock, 10);
    assert.equal(byName('Communion - rosary with prayer').stock, 0);   // SumUp had -1
    assert.equal(byName('Communion - candle and rosary (Standard)').stock, 3); assert.equal(byName('Communion - candle and rosary (Blue)').stock, 1);
    assert.equal(byName('Communion - candle and rosary (Standard)').price, 6);
  });
  await t.test('permanent SumUp ids, the barcode and the first picture are kept; options share their parent\'s picture and category', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    const a = byName('Communion - candle and rosary (Standard)'), b = byName('Communion - candle and rosary (Blue)');
    assert.ok(a.sumup_variant_id && b.sumup_variant_id && a.sumup_variant_id !== b.sumup_variant_id);
    assert.equal(a.sumup_item_id, b.sumup_item_id); assert.ok(a.barcode);
    assert.match(a.image_src, /^https:\/\/images\.sumup\.com\/img_/); assert.equal(a.image_src, b.image_src); assert.equal(a.category, 'Communion');
    assert.match(byName('Advent calendars').image_src, /^https:\/\/images\.sumup\.com\//);   // a 7-picture item uses its first
    assert.equal(mine().every(i => i.available === true), true);
  });
  await t.test('a file with no R- categories at all is imported whole', async () => {
    reset();
    const plain = edit(lines => lines.filter(l => !/R-|R- /.test(l)));
    const r = await imp(plain, { commit: true });
    assert.equal(r.status, 200, r.raw);
    assert.ok(mine().some(i => /BBQ/.test(i.name)));
  });
  await t.test('only the office may; a seller may not; another parish never sees the items', async () => {
    reset();
    assert.equal((await imp(FIXTURE, {}, 'seA')).status, 403);
    await imp(FIXTURE, { commit: true });
    assert.deepEqual(T('repository_items').filter(i => i.org_id === 'org-B'), []);
    assert.equal((await call('shop_get', {}, { session: S.saB })).body.items.length, 0);
  });
  await t.test('the real SumUp file (if it is on this machine) reads cleanly: about 200 repository items, none over £500', async (ctx) => {
    const real = 'C:/Users/justi/Downloads/2026-11-09_13-17-42_items-export_MLASU9VK.csv';
    if (!fs.existsSync(real)) return ctx.skip('the real export is not on this machine');
    reset();
    const r = await imp(fs.readFileSync(real, 'utf8'), { commit: true });
    assert.equal(r.status, 200, r.raw);
    assert.ok(r.body.found >= 190 && r.body.found <= 230, 'found ' + r.body.found);
    assert.ok(mine().every(i => i.price > 0 && i.price <= 500 && i.name.length <= 120));
    assert.equal(new Set(mine().map(i => i.sumup_variant_id)).size, mine().filter(i => i.sumup_variant_id).length);
    assert.ok(mine().filter(i => i.image_src).length > 150);
    assert.ok(mine().every(i => !/^R\s*-/.test(i.category || '')));
  });
});

test('The weekly sync', async (t) => {
  await t.test('importing the same file again changes nothing', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    const before = JSON.stringify(mine());
    const r = await imp(FIXTURE, { commit: true });
    assert.equal(r.body.new_items, 0); assert.equal(r.body.stock_changed, 0); assert.equal(r.body.price_changed, 0); assert.equal(r.body.missing, 0);
    assert.equal(mine().length, JSON.parse(before).length);
    assert.equal(JSON.stringify(mine().map(i => [i.id, i.name, i.price, i.stock])), JSON.stringify(JSON.parse(before).map(i => [i.id, i.name, i.price, i.stock])));
  });
  await t.test('next week\'s file updates stock and prices on the same items (found by SumUp\'s own id), adds new items and takes away missing ones', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    const idBefore = byName('Acrylic Fridge Magnet').id;
    T('repository_items').find(i => i.id === idBefore).available = false;   // the office switched it off
    T('repository_items').find(i => i.id === idBefore).featured = true;
    const week2 = edit(lines => lines.map(l => {
      if (l.startsWith('Acrylic Fridge Magnet,')) return l.replace(',2.50,', ',2.75,').replace(/,Yes,3,0,/, ',Yes,9,0,');   // price and stock moved
      return l;
    }).filter(l => !l.startsWith('Christmas- pop up creche,')));   // gone from SumUp
    const pre = await imp(week2);
    assert.equal(pre.body.price_changed, 1); assert.equal(pre.body.stock_changed, 1); assert.equal(pre.body.missing, 1);
    assert.deepEqual(pre.body.price_changes, [{ name: 'Acrylic Fridge Magnet', from: 2.5, to: 2.75 }]);
    assert.deepEqual(pre.body.stock_changes, [{ name: 'Acrylic Fridge Magnet', from: 3, to: 9 }]);
    assert.deepEqual(pre.body.missing_names, ['Christmas- pop up creche']);
    assert.equal(byName('Acrylic Fridge Magnet').price, 2.5, 'a preview saves nothing');
    const done = await imp(week2, { commit: true });
    assert.equal(done.body.committed, true); assert.equal(done.body.switched_off, 1);
    const m = byName('Acrylic Fridge Magnet');
    assert.equal(m.id, idBefore); assert.equal(m.price, 2.75); assert.equal(m.stock, 9);
    assert.equal(m.available, false); assert.equal(m.featured, true);   // what the office decided stays
    assert.equal(byName('Christmas- pop up creche').available, false);   // taken off sale, not deleted
    assert.equal(mine().length, T('repository_items').filter(i => i.org_id === 'org-A').length);
    const st = T('repository_settings').find(s => s.org_id === 'org-A');
    assert.ok(st.last_sync_at); assert.match(st.last_sync_note, /1 stock changes, 1 price changes, 1 taken off sale/);
  });
  await t.test('what is promised in orders not yet made up is taken off SumUp\'s count; made-up and collected orders are not (they have left the shelf)', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    const it = byName("Wall Sign 'Lord Please Correct Me When Wrong");   // SumUp says 10
    const mk = (status, qty) => { const id = 'o' + Math.random().toString(36).slice(2, 8); T('repository_orders').push({ id, org_id: 'org-A', ref_no: Math.floor(Math.random() * 1e6), status, collect_date: '2026-11-14', slot_id: 's1', slot_label: 'x', total: 7 * qty, created_at: '2026-11-08T10:00:00.000Z' }); T('repository_order_lines').push({ id: 'l' + id, order_id: id, item_id: it.id, item_name: it.name, unit_price: 7, qty }); };
    mk('paid', 2); mk('awaiting_payment', 1); mk('prepared', 3); mk('collected', 4); mk('cancelled', 5);
    const pre = await imp(FIXTURE);
    assert.equal(pre.body.stock_changed, 1); assert.deepEqual(pre.body.stock_changes[0], { name: it.name, from: 10, to: 7 });   // 10 - 2 paid - 1 being paid
    await imp(FIXTURE, { commit: true });
    assert.equal(it.stock, 7);
  });
  await t.test('an item made by hand is adopted (not copied) when SumUp has the same name or barcode', async () => {
    reset();
    T('repository_items').push({ id: 'manual-1', org_id: 'org-A', name: 'Acrylic Fridge Magnet', price: 2, stock: null, available: true, sort: 0, featured: false });
    const r = await imp(FIXTURE, { commit: true });
    assert.equal(r.status, 200, r.raw);
    assert.equal(mine().filter(i => i.name === 'Acrylic Fridge Magnet').length, 1);
    const m = byName('Acrylic Fridge Magnet'); assert.equal(m.id, 'manual-1'); assert.ok(m.sumup_variant_id); assert.equal(m.price, 2.5); assert.equal(m.stock, 3);
  });
  await t.test('items made by hand are left alone by the "no longer in SumUp" step', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    T('repository_items').push({ id: 'hand-1', org_id: 'org-A', name: 'Locally made card', price: 1, stock: 5, available: true, sort: 0, featured: false });
    const week2 = edit(lines => lines.slice(0, 6));
    const done = await imp(week2, { commit: true });
    assert.ok(done.body.missing > 0);
    assert.equal(T('repository_items').find(i => i.id === 'hand-1').available, true);
    assert.equal(T('repository_items').find(i => i.id === 'hand-1').stock, 5);
  });
  await t.test('"keep missing items on sale" is honoured', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    const week2 = edit(lines => lines.filter(l => !l.startsWith('Christmas- pop up creche,')));
    await imp(week2, { commit: true, switch_off_missing: false });
    assert.equal(byName('Christmas- pop up creche').available, true);
  });
});

test('Small product pictures', async (t) => {
  await t.test('the office\'s browser is told which pictures to make: each distinct SumUp picture once', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    const g = await call('shop_get', {}, { session: S.adA });
    const withPic = mine().filter(i => i.image_src);
    assert.equal(g.body.pictures_todo.length, new Set(withPic.map(i => i.image_src)).size);
    assert.ok(g.body.pictures_todo.every(u => /^https:\/\/images\.sumup\.com\//.test(u)));
    assert.ok(g.body.pictures_todo.length < withPic.length, 'options share one picture');
  });
  await t.test('a small picture is checked, stored once for every item that uses it, and then no longer to-do', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    const src = byName('Communion - candle and rosary (Standard)').image_src;
    const r = await call('shop_image_save', { src, data: webp() }, { session: S.adA });
    assert.equal(r.status, 200, r.raw); assert.equal(r.body.items, 2);
    assert.equal(db.uploads.length, 1); assert.equal(db.uploads[0].bucket, 'repository'); assert.match(db.uploads[0].path, /^org-A\/[0-9a-f]{24}\.webp$/);
    assert.equal(db.uploads[0].opts.cacheControl, '31536000'); assert.equal(db.uploads[0].opts.contentType, 'image/webp');
    const a = byName('Communion - candle and rosary (Standard)'), b = byName('Communion - candle and rosary (Blue)');
    assert.equal(a.image_path, db.uploads[0].path); assert.equal(b.image_path, a.image_path); assert.equal(a.image_done_src, src);
    const g = await call('shop_get', {}, { session: S.adA });
    assert.equal(g.body.pictures_todo.includes(src), false);
    assert.match(g.body.items.find(i => i.name === a.name).image, /\/storage\/v1\/object\/public\/repository\/org-A\/[0-9a-f]{24}\.webp$/);
    assert.equal((await call('shop_image_save', { src, data: jpeg() }, { session: S.adA })).status, 200);   // a JPEG is fine too
  });
  await t.test('refused: a PNG, something too big, something that is not a picture, a picture no item uses, a seller, another parish', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    const src = byName('Advent calendars').image_src;
    const save = (data, s = src, who = 'adA') => call('shop_image_save', { src: s, data }, { session: S[who] });
    assert.equal((await save(png())).status, 400);
    assert.equal((await save(webp(120000))).status, 400);
    assert.equal((await save(Buffer.from('hello world, not a picture').toString('base64'))).status, 400);
    assert.equal((await save('')).status, 400);
    assert.equal((await save(webp(), 'https://images.sumup.com/img_NOTMINE')).status, 404);
    assert.equal((await save(webp(), 'javascript:alert(1)')).status, 400);
    assert.equal((await save(webp(), src, 'seA')).status, 403);
    assert.equal((await save(webp(), src, 'saB')).status, 404);
    assert.equal(db.uploads.length, 0); assert.equal(byName('Advent calendars').image_path, undefined);
  });
  await t.test('a changed picture in SumUp puts it back on the to-do list', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    const it = byName('Acrylic Fridge Magnet'), old = it.image_src;
    await call('shop_image_save', { src: old, data: webp() }, { session: S.adA });
    assert.equal((await call('shop_get', {}, { session: S.adA })).body.pictures_todo.includes(old), false);
    const next = edit(lines => lines.map(l => (l.startsWith('Acrylic Fridge Magnet,') ? l.replace(old, 'https://images.sumup.com/img_NEWPICTURE000001') : l)));
    const pre = await imp(next); assert.ok(pre.body.pictures_to_prepare >= 1);
    await imp(next, { commit: true });
    const g = await call('shop_get', {}, { session: S.adA });
    assert.ok(g.body.pictures_todo.includes('https://images.sumup.com/img_NEWPICTURE000001'));
    assert.equal(byName('Acrylic Fridge Magnet').image_path.length > 0, true, 'the old small picture shows until the new one is made');
  });
});

test('What the shop shows first', async (t) => {
  const shop = async () => (await call('public_shop', { slug: 'svp-osterley' })).body;
  await t.test('the window carries the picture address, the categories (in-season first) and "shelves"; every item still appears in its category', async () => {
    reset('2026-11-09T12:00:00Z'); await imp(FIXTURE, { commit: true });
    const d = await shop();
    assert.match(d.img_base, /\/storage\/v1\/object\/public\/repository\/$/);
    assert.equal(d.categories[0].name, 'Christmas'); assert.equal(d.categories[0].season, true);
    assert.deepEqual(d.items.map(i => i.id).sort(), mine().filter(i => i.available).map(i => i.id).sort());
    const season = d.shelves.find(s => s.key === 'season');
    assert.equal(season.title, 'In season: Christmas');
    assert.ok(season.ids.every(id => /Christmas|Advent|Ornament/i.test(d.items.find(i => i.id === id).name) || d.items.find(i => i.id === id).category === 'Christmas'));
    assert.equal(d.shelves.some(s => s.key === 'popular'), false, 'no sales yet, so no "popular" shelf');
    assert.equal(d.shelves.some(s => s.key === 'new'), false, 'the first import is not "new"');
  });
  await t.test('the season follows the calendar: in July Communion is in season and Christmas is not', async () => {
    reset('2026-07-01T12:00:00Z'); await imp(FIXTURE, { commit: true });
    const d = await shop();
    assert.equal(d.categories[0].name, 'Communion');
    assert.equal(d.shelves.find(s => s.key === 'season').title, 'In season: First Communion');
    assert.equal(d.categories.find(c => c.name === 'Christmas').season, false);
    reset('2026-01-03T12:00:00Z'); await imp(FIXTURE, { commit: true });
    assert.equal((await shop()).categories[0].name, 'Christmas');   // Christmas season runs to 6 January
    reset('2026-01-10T12:00:00Z'); await imp(FIXTURE, { commit: true });
    assert.equal((await shop()).categories.find(c => c.name === 'Christmas').season, false);
  });
  await t.test('what has really been selling comes first: a "Popular right now" shelf, and the best seller leads its category', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    const sell = (name, qty, status = 'paid', created = '2026-11-01T10:00:00.000Z') => { const it = byName(name), id = 'o' + Math.random().toString(36).slice(2, 8); T('repository_orders').push({ id, org_id: 'org-A', ref_no: Math.floor(Math.random() * 1e6), status, collect_date: '2026-11-07', slot_id: 's1', slot_label: 'x', total: 1, created_at: created }); T('repository_order_lines').push({ id: 'l' + id, order_id: id, item_id: it.id, item_name: name, unit_price: it.price, qty }); };
    sell('Acrylic Fridge Magnet', 6); sell('Acrylic Fridge Magnet', 2, 'collected'); sell("Wall Sign 'Lord Please Correct Me When Wrong", 3);
    sell('Statues (Mary)', 50, 'cancelled'); sell('Statues (Mary)', 40, 'awaiting_payment'); sell('Advent calendars', 90, 'paid', '2026-05-01T10:00:00.000Z');   // none of these count
    const d = await shop();
    const pop = d.shelves.find(s => s.key === 'popular');
    assert.ok(pop, 'a popular shelf'); assert.deepEqual(pop.ids.map(id => d.items.find(i => i.id === id).name), ['Acrylic Fridge Magnet', "Wall Sign 'Lord Please Correct Me When Wrong"]);
    const general = d.items.filter(i => i.category === 'General');
    assert.equal(general[0].name, 'Acrylic Fridge Magnet');
  });
  await t.test('items that are sold out go last in their category and never on a shelf; picks (featured) come first', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    const rosary = byName('Communion - rosary with prayer'); assert.equal(rosary.stock, 0);
    byName('Acrylic Fridge Magnet').featured = true; byName('Communion - picture frames (Girl)').featured = true;
    const d = await shop();
    const comm = d.items.filter(i => i.category === 'Communion');
    assert.equal(comm[comm.length - 1].name, 'Communion - rosary with prayer'); assert.equal(comm[comm.length - 1].sold_out, true);
    assert.equal(d.shelves[0].key, 'picks'); assert.equal(d.shelves[0].ids.length, 2);
    assert.equal(d.shelves.flatMap(s => s.ids).includes(rosary.id), false);
  });
  await t.test('items that arrive in a later sync are "New in" for two weeks', async () => {
    reset('2026-10-01T12:00:00Z'); await imp(FIXTURE, { commit: true });
    clock.set('2026-10-25T12:00:00Z');
    const week = edit(lines => [...lines, 'Brand new rosary,,,,,,,,,,Yes,3.50,,No,,No,,No,,,each.each,Yes,5,0,,999000111222,,,R-General,Yes,,https://images.sumup.com/img_BRANDNEW00000000000001,,,,,,,Yes,,,,,,,NEWITEM-0001,NEWVAR-0001']);
    const r = await imp(week, { commit: true }); assert.equal(r.body.new_items, 1, r.raw);
    clock.set('2026-10-30T12:00:00Z');
    let d = await shop(); const nw = d.shelves.find(s => s.key === 'new');
    assert.equal(nw, undefined, 'one new item is not a shelf');   // a shelf needs at least two
    const week2 = edit(lines => [...lines, 'Brand new rosary,,,,,,,,,,Yes,3.50,,No,,No,,No,,,each.each,Yes,5,0,,999000111222,,,R-General,Yes,,https://images.sumup.com/img_BRANDNEW00000000000001,,,,,,,Yes,,,,,,,NEWITEM-0001,NEWVAR-0001', 'Brand new candle,,,,,,,,,,Yes,1.50,,No,,No,,No,,,each.each,Yes,5,0,,999000111333,,,R-General,Yes,,,,,,,,,Yes,,,,,,,NEWITEM-0002,NEWVAR-0002']);
    await imp(week2, { commit: true });
    d = await shop();
    const nw2 = d.shelves.find(s => s.key === 'new'); assert.ok(nw2);
    assert.deepEqual(nw2.ids.map(id => d.items.find(i => i.id === id).name).sort(), ['Brand new candle', 'Brand new rosary']);
    clock.set('2026-11-20T12:00:00Z');   // three weeks on
    assert.equal((await shop()).shelves.some(s => s.key === 'new'), false);
  });
  await t.test('the shop window is cached for half a minute, no more', async () => {
    reset(); await imp(FIXTURE, { commit: true });
    const r = await call('public_shop', { slug: 'svp-osterley' });
    assert.match(r.headers['Cache-Control'], /max-age=30/);
  });
  await t.test('a bigger shop stays small: 250 items, each with a picture address, is a few tens of kilobytes', async () => {
    reset();
    for (let i = 0; i < 250; i++) T('repository_items').push({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, org_id: 'org-A', name: `Item number ${i} with a fairly long name`, price: 3.5, stock: 4, available: true, sort: i, category: ['General', 'Christmas', 'Communion', 'Baptism'][i % 4], image_path: `org-A/${'a'.repeat(24)}.webp`, featured: false, added_at: '2026-01-01T00:00:00.000Z' });
    const r = await call('public_shop', { slug: 'svp-osterley' });
    assert.ok(r.raw.length < 70000, 'the window is ' + r.raw.length + ' bytes');
  });
});
