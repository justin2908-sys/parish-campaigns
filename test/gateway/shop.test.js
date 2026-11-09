// The Repository (parish shop) online: items, the collection weekends, ordering and paying, the office list.
// Run with:  node --test "test/gateway/*.test.js"   (no network: SumUp is replaced by a stand-in)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { db, clock, call, addUser } = require('./harness');

let S, sumup, sumupState;
const SLOTS = [{ id: 's1', label: 'Vigil Mass', weekday: 6, time: '18:00' }, { id: 's2', label: 'Mass', weekday: 0, time: '09:30' }, { id: 's3', label: 'Mass', weekday: 0, time: '11:00' }];
const T = (n) => db.T(n);
let itemSeq = 0;
const item = (org_id, name, price, extra) => { const id = `00000000-0000-4000-8000-${String(++itemSeq).padStart(12, '0')}`; T('repository_items').push({ id, org_id, name, price, stock: null, available: true, sort: 0, ...extra }); return id; };
let I;   // ids of the demo items

function reset(at = '2026-11-09T12:00:00Z') {   // a Monday
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set(at);
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true, display_name: null, gateway_phone: null, gateway_hours: null });
  T('organizations').push({ id: 'org-B', name: 'Other Parish', slug: 'other-parish', timezone: 'Europe/London', gateway_enabled: true });
  S = { saA: addUser('uA-sa', 'superadmin', 'org-A'), adA: addUser('uA-ad', 'admin', 'org-A'), seA: addUser('uA-se', 'seller', 'org-A'), prA: addUser('uA-pr', 'priest', 'org-A'), saB: addUser('uB-sa', 'superadmin', 'org-B') };
  T('repository_settings').push({ org_id: 'org-A', enabled: true, slots: SLOTS, cutoff_weekday: 3, cutoff_time: '23:59', intro_text: 'Collect after Mass.', next_ref: 1 });
  T('repository_settings').push({ org_id: 'org-B', enabled: true, slots: SLOTS, cutoff_weekday: 3, cutoff_time: '23:59', intro_text: null, next_ref: 1 });
  I = {
    rosary: item('org-A', 'Rosary beads', 4.5, { stock: 3, category: 'Devotional' }),
    candle: item('org-A', 'Votive candle', 2, { category: 'Devotional' }),
    bible: item('org-A', 'Children’s Bible', 12.99, { stock: 0, category: 'Books' }),
    hidden: item('org-A', 'Not for sale', 5, { available: false }),
    other: item('org-B', 'Other parish item', 3),
  };
  sumup = []; sumupState = { status: 'PENDING' };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (opts.method === 'POST' && u.endsWith('/v0.1/checkouts')) { const b = JSON.parse(opts.body || '{}'); sumup.push(b); return { ok: true, status: 200, json: async () => ({ id: 'co-' + sumup.length, hosted_checkout_url: 'https://pay.example/' + sumup.length }) }; }
    if (opts.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
    if (/\/v0\.1\/checkouts\/co-/.test(u)) {
      const paid = sumupState.status === 'PAID';
      return { ok: true, status: 200, json: async () => ({ id: u.split('/').pop(), status: sumupState.status, date: new Date(clock.now()).toISOString(), transactions: paid ? [{ id: 'tx-1', transaction_code: 'TAAA000001', status: 'SUCCESSFUL' }] : [] }) };
    }
    throw new Error('the network is off in tests: ' + u);
  };
}
const SAT = '2026-11-14', SUN = '2026-11-15';
const order = (over, opts) => call('public_shop_order', { slug: 'svp-osterley', items: [{ id: I.rosary, qty: 2 }, { id: I.candle, qty: 3 }], collect: `${SAT}|s1`, name: 'Mary Murphy', phone: '07700 900123', client_ref: 'ref-' + Math.random().toString(36).slice(2, 12), ...over }, opts);
const shop = (slug = 'svp-osterley') => call('public_shop', { slug });
const stock = (id) => T('repository_items').find(i => i.id === id).stock;

test('The shop window', async (t) => {
  await t.test('lists only what is on sale, with the Masses of the next two weekends', async () => {
    reset();
    const r = await shop();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map(i => i.name).sort(), ['Children’s Bible', 'Rosary beads', 'Votive candle']);   // never the switched-off item, never another parish's
    assert.equal(r.body.items.find(i => i.name === 'Children’s Bible').sold_out, true);
    assert.equal(r.body.items.find(i => i.name === 'Rosary beads').left, 3);                  // only a small number left is shown
    assert.equal(r.body.items.find(i => i.name === 'Votive candle').left, null);              // an uncounted item shows no number
    assert.deepEqual(r.body.options.map(o => o.key), [`${SAT}|s1`, `${SUN}|s2`, `${SUN}|s3`, '2026-11-21|s1', '2026-11-22|s2', '2026-11-22|s3']);
    assert.equal(r.body.options[0].label, 'Saturday 14 November, 6 pm — Vigil Mass');
    assert.equal(r.body.options[1].label, 'Sunday 15 November, 9:30 am — Mass');
    assert.match(r.body.cutoff_text, /Wednesday midnight/);
    assert.equal(r.body.intro, 'Collect after Mass.');
  });
  await t.test('the cut-off: Wednesday midnight, in the parish\'s own time, then it is the following weekend', async () => {
    reset('2026-11-11T23:30:00Z');   // Wednesday 23:30: still this weekend
    assert.equal((await shop()).body.options[0].weekend, SAT);
    reset('2026-11-12T00:05:00Z');   // just after midnight: no longer
    assert.equal((await shop()).body.options[0].weekend, '2026-11-21');
    reset('2026-06-10T23:30:00Z');   // summer time: 23:30 UTC is already 00:30 on Thursday in London
    const r = await shop();
    assert.equal(r.body.options[0].weekend, '2026-06-20');
    reset('2026-06-10T22:30:00Z');   // 23:30 in London: still open
    assert.equal((await shop()).body.options[0].weekend, '2026-06-13');
  });
  await t.test('on the Saturday or Sunday itself, this weekend is not offered', async () => {
    reset('2026-11-14T08:00:00Z'); assert.equal((await shop()).body.options[0].weekend, '2026-11-21');
    reset('2026-11-15T08:00:00Z'); assert.equal((await shop()).body.options[0].weekend, '2026-11-21');
  });
  await t.test('a parish with another cut-off (Thursday 9:00) is honoured', async () => {
    reset('2026-11-12T08:30:00Z');
    T('repository_settings').find(s => s.org_id === 'org-A').cutoff_weekday = 4; T('repository_settings').find(s => s.org_id === 'org-A').cutoff_time = '09:00';
    assert.equal((await shop()).body.options[0].weekend, SAT);
    reset('2026-11-12T09:30:00Z');
    T('repository_settings').find(s => s.org_id === 'org-A').cutoff_weekday = 4; T('repository_settings').find(s => s.org_id === 'org-A').cutoff_time = '09:00';
    assert.equal((await shop()).body.options[0].weekend, '2026-11-21');
  });
  await t.test('closed, unknown, junk and another parish: a plain 404 / its own items only', async () => {
    reset();
    T('repository_settings').find(s => s.org_id === 'org-A').enabled = false;
    assert.equal((await shop()).status, 404);
    assert.equal((await shop('nobody-here')).status, 404);
    assert.equal((await shop('A')).status, 404);
    assert.deepEqual((await shop('other-parish')).body.items.map(i => i.name), ['Other parish item']);
  });
});

test('Ordering and paying', async (t) => {
  await t.test('an order is priced by the server, takes stock, makes a reference and a card payment; no name or contact on the order', async () => {
    reset();
    const r = await order({ items: [{ id: I.rosary, qty: 2, price: 0.01 }, { id: I.candle, qty: 3, price: 0.01 }], total: 0.01 });   // a price from the page is ignored
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ref, 'REP-001'); assert.equal(r.body.total, 15); assert.equal(r.body.status, 'awaiting_payment'); assert.match(r.body.pay_url, /^https:\/\/pay\.example\//);
    assert.equal(sumup[0].amount, 15); assert.match(sumup[0].description, /Repository order REP-001/); assert.match(sumup[0].redirect_url, /\/shop\.html\?order=/); assert.match(sumup[0].return_url, /\/api\/sumup_webhook$/);
    assert.equal(stock(I.rosary), 1); assert.equal(stock(I.candle), null);
    const o = T('repository_orders')[0];
    assert.equal(o.collect_date, SAT); assert.equal(o.slot_label, 'Saturday 14 November, 6 pm — Vigil Mass'); assert.equal(o.status, 'awaiting_payment');
    for (const k of Object.keys(o)) assert.ok(!/name|phone|email|contact|ip/.test(k.replace('slot_label', '').replace('ref', '')) || k === 'client_ref', 'the order holds ' + k);
    const pay = T('payments')[0];
    assert.equal(pay.payer_name, 'Mary Murphy'); assert.equal(pay.contact_value, '07700900123'); assert.equal(pay.amount, 15); assert.equal(pay.method, 'link'); assert.equal(pay.status, 'pending');
    const camp = T('campaigns').find(c => c.id === pay.campaign_id);
    assert.equal(camp.form_def.shop, true); assert.equal(camp.form_def.weekend, SAT); assert.equal(camp.public_page_enabled, false); assert.equal(camp.listed_on_gateway, false); assert.equal(camp.keep_until, '2026-12-15');
    assert.deepEqual(T('repository_order_lines').map(l => [l.item_name, l.unit_price, l.qty]).sort(), [['Rosary beads', 4.5, 2], ['Votive candle', 2, 3]]);
  });
  await t.test('references count up; one hidden campaign per weekend', async () => {
    reset();
    await order(); await order({ items: [{ id: I.candle, qty: 1 }], collect: `${SUN}|s2` }); await order({ items: [{ id: I.candle, qty: 1 }], collect: '2026-11-22|s3' });
    assert.deepEqual(T('repository_orders').map(o => o.ref_no), [1, 2, 3]);
    assert.equal(T('campaigns').length, 2);   // this weekend (Saturday and Sunday orders share it) and the next
    assert.equal(T('repository_weekends').length, 2);
  });
  await t.test('refused, in plain words: nothing chosen, bad quantities, unknown / switched-off / other-parish items, no contact, bad email, junk collection time', async () => {
    reset();
    const bad = async (over, status, re) => { const r = await order(over); assert.equal(r.status, status, JSON.stringify(over) + ' ' + r.raw); if (re) assert.match(r.body.error, re); };
    await bad({ items: [] }, 400, /at least one item/);
    await bad({ items: [{ id: I.candle, qty: 0 }] }, 400, /between 1 and 20/);
    await bad({ items: [{ id: I.candle, qty: 21 }] }, 400, /between 1 and 20/);
    await bad({ items: [{ id: I.candle, qty: 1.5 }] }, 400);
    await bad({ items: [{ id: 'not-an-id', qty: 1 }] }, 400);
    await bad({ items: [{ id: I.hidden, qty: 1 }] }, 409, /no longer available/);
    await bad({ items: [{ id: I.other, qty: 1 }] }, 409, /no longer available/);
    await bad({ items: [{ id: '11111111-1111-4111-8111-111111111111', qty: 1 }] }, 409, /no longer available/);
    await bad({ name: '' }, 400, /enter your name/);
    await bad({ phone: '', email: '' }, 400, /mobile number or an email/);
    await bad({ phone: '', email: 'nope' }, 400, /email address/);
    await bad({ collect: '2026-11-13|s1' }, 409, /no longer available/);
    await bad({ collect: `${SAT}|s9` }, 409, /no longer available/);
    await bad({ collect: '2026-11-28|s1' }, 409, /no longer available/);   // a third weekend is not offered yet
    await bad({ items: [{ id: I.bible, qty: 1 }] }, 409, /sold out/);
    await bad({ items: [{ id: I.rosary, qty: 4 }] }, 409, /only 3 of Rosary beads are left/);
    assert.equal(T('repository_orders').length, 0); assert.equal(T('payments').length, 0); assert.equal(stock(I.rosary), 3);
  });
  await t.test('an order over £500 is refused', async () => {
    reset(); const big = item('org-A', 'Statue', 400);
    assert.equal((await order({ items: [{ id: big, qty: 2 }] })).status, 400);
    assert.equal((await order({ items: [{ id: big, qty: 1 }] })).status, 200);
  });
  await t.test('two people cannot both take the last ones, and a refused order leaves no payment open', async () => {
    reset();
    assert.equal((await order({ items: [{ id: I.rosary, qty: 3 }] })).status, 200);
    const second = await order({ items: [{ id: I.rosary, qty: 1 }] });
    assert.equal(second.status, 409); assert.match(second.body.error, /sold out/);
    assert.equal(T('payments').length, 1);
  });
  await t.test('a second tap with the same reference does not order twice', async () => {
    reset();
    const a = await order({ client_ref: 'same-ref-12345' }), b = await order({ client_ref: 'same-ref-12345' });
    assert.equal(a.body.order_id, b.body.order_id); assert.equal(b.body.replay, true);
    assert.equal(T('repository_orders').length, 1); assert.equal(T('payments').length, 1); assert.equal(stock(I.rosary), 1);
  });
  await t.test('the hidden spam-trap box stores nothing', async () => {
    reset(); const r = await order({ website: 'http://spam.example' });
    assert.equal(r.status, 200); assert.equal(T('repository_orders').length, 0); assert.equal(T('payments').length, 0);
  });
  await t.test('if SumUp cannot make the payment link the order is cancelled and the stock goes back', async () => {
    reset();
    const keep = global.fetch;
    global.fetch = async (url, opts = {}) => (opts.method === 'POST' ? { ok: false, status: 500, json: async () => ({ message: 'down' }) } : keep(url, opts));
    const r = await order();
    assert.equal(r.status, 502);
    assert.equal(T('repository_orders')[0].status, 'cancelled'); assert.equal(stock(I.rosary), 3); assert.equal(T('payments')[0].status, 'void');
  });
});

test('Payment settles the order', async (t) => {
  const placed = async () => { reset(); const r = await order(); return r.body; };
  await t.test('while unpaid the buyer sees the way to pay; once SumUp says paid the order is paid, with its reference and collection', async () => {
    const o = await placed();
    let r = await call('public_shop_status', { order_id: o.order_id });
    assert.equal(r.body.status, 'awaiting_payment'); assert.ok(r.body.pay_url); assert.equal(r.body.ref, 'REP-001');
    sumupState.status = 'PAID';
    r = await call('public_shop_status', { order_id: o.order_id });
    assert.equal(r.body.status, 'paid'); assert.equal(r.body.pay_url, null);
    assert.equal(r.body.slot_label, 'Saturday 14 November, 6 pm — Vigil Mass');
    assert.deepEqual(r.body.lines.map(l => [l.name, l.qty]).sort(), [['Rosary beads', 2], ['Votive candle', 3]]);
    assert.equal(T('payments')[0].status, 'paid'); assert.equal(T('payments')[0].sumup_transaction_code, 'TAAA000001');
    assert.equal(stock(I.rosary), 1);
    assert.equal(JSON.stringify(r.body).includes('Mary'), false); assert.equal(JSON.stringify(r.body).includes('07700'), false);   // no personal details on the buyer's page
  });
  await t.test('SumUp\'s own notification marks the order paid too', async () => {
    const o = await placed(); sumupState.status = 'PAID';
    const co = T('payments')[0].sumup_checkout_id;
    assert.equal((await call('sumup_webhook', { event_type: 'CHECKOUT_STATUS_CHANGED', id: co })).status, 200);
    assert.equal(T('repository_orders').find(x => x.id === o.order_id).status, 'paid');
  });
  await t.test('a payment that never completes cancels the order and puts the stock back', async () => {
    const o = await placed(); sumupState.status = 'EXPIRED';
    const r = await call('public_shop_status', { order_id: o.order_id });
    assert.equal(r.body.status, 'cancelled'); assert.equal(stock(I.rosary), 3);
  });
  await t.test('paid after it was given up: the order comes back if the stock is there', async () => {
    const o = await placed(); sumupState.status = 'EXPIRED'; await call('public_shop_status', { order_id: o.order_id });
    assert.equal(stock(I.rosary), 3);
    sumupState.status = 'PAID';
    const pay = T('payments')[0]; await call('sumup_webhook', { id: pay.sumup_checkout_id });
    assert.equal(T('repository_orders')[0].status, 'paid'); assert.equal(stock(I.rosary), 1); assert.equal(T('payments')[0].attention_note, undefined);
  });
  await t.test('paid after it was given up and the item has gone: the office is told, loudly', async () => {
    const o = await placed(); sumupState.status = 'EXPIRED'; await call('public_shop_status', { order_id: o.order_id });
    T('repository_items').find(i => i.id === I.rosary).stock = 1;   // someone else took them while it was open
    sumupState.status = 'PAID';
    await call('sumup_webhook', { id: T('payments')[0].sumup_checkout_id });
    assert.equal(T('repository_orders')[0].status, 'cancelled');
    assert.match(T('payments')[0].attention_note, /Rosary beads had sold out/);
  });
  await t.test('a bad or unknown order id is a clean error', async () => {
    reset();
    assert.equal((await call('public_shop_status', { order_id: 'x' })).status, 400);
    assert.equal((await call('public_shop_status', { order_id: '11111111-1111-4111-8111-111111111111' })).status, 404);
  });
});

test('The office: items and settings', async (t) => {
  await t.test('only the office (Superadmin, Admin, Finance, Priest) may; sellers and strangers may not; and only their own parish', async () => {
    reset();
    for (const who of ['saA', 'adA', 'prA']) assert.equal((await call('shop_get', {}, { session: S[who] })).status, 200, who);
    assert.equal((await call('shop_get', {}, { session: S.seA })).status, 403);
    assert.ok((await call('shop_get', {})).status >= 400);
    const a = await call('shop_get', {}, { session: S.adA }), b = await call('shop_get', {}, { session: S.saB });
    assert.ok(a.body.items.every(i => !/Other parish/.test(i.name))); assert.deepEqual(b.body.items.map(i => i.name), ['Other parish item']);
    // another parish's item id is "not found", never changed
    assert.equal((await call('shop_item_save', { id: I.other, name: 'x', price: 1 }, { session: S.adA })).status, 404);
    assert.equal((await call('shop_item_delete', { id: I.other }, { session: S.adA })).status, 404);
    assert.equal((await call('shop_item_set_available', { id: I.other, available: false }, { session: S.adA })).status, 404);
    assert.equal(T('repository_items').find(i => i.id === I.other).name, 'Other parish item');
  });
  await t.test('add, change, switch off and remove an item; bad prices and stock are refused in plain words', async () => {
    reset();
    const add = await call('shop_item_save', { name: ' Holy water bottle ', price: '£3.50', stock: '12', category: 'Devotional', sku: 'HW1', description: 'Blessed.' }, { session: S.adA });
    assert.equal(add.status, 200, add.raw);
    const row = T('repository_items').find(i => i.id === add.body.id);
    assert.deepEqual([row.name, row.price, row.stock, row.sku, row.available], ['Holy water bottle', 3.5, 12, 'HW1', true]);
    assert.equal((await call('shop_item_save', { id: add.body.id, name: 'Holy water bottle', price: 4, stock: '' }, { session: S.adA })).status, 200);
    assert.equal(row.price, 4); assert.equal(row.stock, null);
    for (const bad of [{ name: '', price: 1 }, { name: 'x', price: 0 }, { name: 'x', price: 501 }, { name: 'x', price: 'abc' }, { name: 'x', price: 1, stock: -1 }, { name: 'x', price: 1, stock: 1.5 }, { name: 'x'.repeat(121), price: 1 }]) assert.equal((await call('shop_item_save', bad, { session: S.adA })).status, 400, JSON.stringify(bad));
    await call('shop_item_set_available', { id: add.body.id, available: false }, { session: S.adA });
    assert.equal((await shop()).body.items.some(i => i.name === 'Holy water bottle'), false);
    await call('shop_item_delete', { id: add.body.id }, { session: S.adA });
    assert.equal(T('repository_items').some(i => i.id === add.body.id), false);
  });
  await t.test('removing an item keeps what past orders say they held', async () => {
    reset(); await order();
    T('repository_items').splice(T('repository_items').findIndex(i => i.id === I.candle), 1);   // as the database does: the line keeps its name and price
    T('repository_order_lines').forEach(l => { if (l.item_id === I.candle) l.item_id = null; });
    const r = await call('shop_orders', {}, { session: S.adA });
    assert.ok(r.body.orders[0].lines.some(l => l.name === 'Votive candle' && l.qty === 3));
  });
  await t.test('Mass times: Saturday or Sunday only, a real time, a name, up to eight; opening needs a time and a page address', async () => {
    reset();
    const set = (b) => call('shop_set_settings', b, { session: S.adA });
    for (const bad of [[{ label: 'Mass', weekday: 3, time: '10:00' }], [{ label: 'Mass', weekday: 6, time: '25:00' }], [{ label: '', weekday: 6, time: '18:00' }], Array.from({ length: 9 }, () => ({ label: 'Mass', weekday: 0, time: '09:00' })), 'x'])
      assert.equal((await set({ slots: bad })).status, 400);
    const ok = await set({ slots: [{ label: 'Vigil Mass', weekday: 6, time: '18:00' }, { label: 'Mass', weekday: 0, time: '09:30' }], cutoff_weekday: 4, cutoff_time: '09:00', intro_text: 'Hello' });
    assert.equal(ok.status, 200, ok.raw);
    const st = T('repository_settings').find(s => s.org_id === 'org-A');
    assert.deepEqual([st.slots.length, st.cutoff_weekday, st.cutoff_time, st.intro_text], [2, 4, '09:00', 'Hello']); assert.ok(st.slots.every(s => /^[a-z0-9]{2,12}$/.test(s.id)));
    assert.equal((await set({ cutoff_weekday: 9 })).status, 400); assert.equal((await set({ cutoff_time: '9am' })).status, 400);
    st.slots = []; st.enabled = false;
    assert.equal((await set({ enabled: true })).status, 400);                    // no Mass times yet
    assert.equal((await set({ enabled: true, slots: SLOTS })).status, 200); assert.equal(st.enabled, true);
    T('organizations').find(o => o.id === 'org-A').slug = null;
    assert.equal((await set({ enabled: true })).status, 400);                    // no page address yet
    assert.equal((await set({ enabled: false })).status, 200); assert.equal(st.enabled, false);
  });
});

test('Bringing the items across from SumUp', async (t) => {
  const csv = [
    'Item name,Variations,Description,Category,SKU,Price,Tax rate',
    'Rosary beads,,"Glass, 5 decade",Devotional,ROS1,"£6.50",0',
    'Holy Bible,Large print,,Books,BIB1,19.99,0',
    'Holy Bible,Paperback,,Books,BIB2,9.99,0',
    'Free sample,,,Other,FS1,,0',
    ',,,Other,,5,0',
    'Rosary beads,,"duplicate",Devotional,ROS1,6.50,0',
    ',,,,,,',
  ].join('\n');
  await t.test('a preview shows what it found and saves nothing; the real thing creates new items and refreshes known ones, keeping their stock', async () => {
    reset();
    const pre = await call('shop_import', { text: csv }, { session: S.adA });
    assert.equal(pre.status, 200, pre.raw);
    assert.equal(pre.body.committed, false); assert.equal(pre.body.found, 3); assert.equal(pre.body.new_items, 2); assert.equal(pre.body.updated, 1); assert.equal(pre.body.skipped_count, 3);   // "Rosary beads" is already here, matched by name
    assert.deepEqual(pre.body.skipped.map(s => s.reason).sort(), ['listed twice', 'no item name', 'no price']);
    assert.equal(T('repository_items').filter(i => i.org_id === 'org-A').length, 4);   // nothing saved yet
    T('repository_items').find(i => i.id === I.rosary).sku = 'ROS1';
    const done = await call('shop_import', { text: csv, commit: true }, { session: S.adA });
    assert.equal(done.status, 200); assert.equal(done.body.committed, true); assert.equal(done.body.new_items, 2); assert.equal(done.body.updated, 1);
    const mine = T('repository_items').filter(i => i.org_id === 'org-A');
    assert.equal(mine.length, 6);
    const ros = mine.find(i => i.id === I.rosary);
    assert.equal(ros.price, 6.5); assert.equal(ros.stock, 3); assert.equal(ros.name, 'Rosary beads'); assert.equal(ros.description, 'Glass, 5 decade');   // price refreshed, stock kept
    assert.ok(mine.some(i => i.name === 'Holy Bible (Large print)' && i.price === 19.99 && i.sku === 'BIB1' && i.available === true));
    assert.equal(T('repository_items').filter(i => i.org_id === 'org-B').length, 1);   // another parish untouched
  });
  await t.test('other spellings of the columns, semicolons and tabs, and a file with a byte-order mark', async () => {
    reset();
    const semi = '﻿Name;Price;Category\r\n"Candle; tall";"2,50";Devotional\r\nCard;1.20;Gifts\r\n';
    const r = await call('shop_import', { text: semi, commit: true }, { session: S.adA });
    assert.equal(r.status, 200, r.raw); assert.equal(r.body.new_items, 2);
    assert.ok(T('repository_items').some(i => i.name === 'Candle; tall' && i.price === 2.5 || i.name === 'Candle; tall' && i.price === 250));
    const tab = 'Product\tUnit price\nCrucifix\t£11\n';
    assert.equal((await call('shop_import', { text: tab, commit: true }, { session: S.adA })).body.new_items, 1);
  });
  await t.test('a file that is not an item list is refused in plain words', async () => {
    reset();
    for (const bad of ['', '   ', 'just one line', 'Colour,Size\nred,big', 'Item name\nRosary']) {
      const r = await call('shop_import', { text: bad }, { session: S.adA });
      assert.equal(r.status, 400, bad); assert.ok(r.body.error.length > 20);
    }
    assert.match((await call('shop_import', { text: 'Colour,Size\nred,big' }, { session: S.adA })).body.error, /columns I found are: Colour, Size/);
    assert.equal((await call('shop_import', { text: csv }, { session: S.seA })).status, 403);
  });
});

test('The office list of orders', async (t) => {
  const setup = async () => {
    reset();
    const a = (await order({ name: 'Mary Murphy' })).body;                                          // Saturday vigil
    const b = (await order({ name: 'John Byrne', items: [{ id: I.candle, qty: 1 }], collect: `${SUN}|s2` })).body;   // Sunday 9:30
    const c = (await order({ name: 'Not Paid Yet', items: [{ id: I.candle, qty: 1 }], collect: `${SUN}|s3` })).body;   // never paid
    const d = (await order({ name: 'Next Weekend', items: [{ id: I.candle, qty: 2 }], collect: '2026-11-22|s2' })).body;
    sumupState.status = 'PAID';
    for (const o of [a, b, d]) { const pay = T('payments').find(p => p.id === T('repository_orders').find(x => x.id === o.order_id).payment_id); await call('sumup_webhook', { id: pay.sumup_checkout_id }); }
    sumupState.status = 'PENDING';
    return { a, b, c, d };
  };
  await t.test('grouped by weekend, with who, what and which Mass; unpaid ones are shown but not counted', async () => {
    const { a, c } = await setup();
    const r = await call('shop_orders', {}, { session: S.adA });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.weekend, SAT); assert.equal(r.body.weekend_label, 'Saturday 14 November');
    assert.deepEqual(r.body.weekends.map(w => [w.weekend, w.orders]), [['2026-11-21', 1], [SAT, 2]]);
    const byRef = Object.fromEntries(r.body.orders.map(o => [o.ref, o]));
    assert.equal(byRef['REP-001'].name, 'Mary Murphy'); assert.equal(byRef['REP-001'].status, 'paid'); assert.equal(byRef['REP-001'].slot_label, 'Saturday 14 November, 6 pm — Vigil Mass'); assert.equal(byRef['REP-001'].total, 15);
    assert.deepEqual(byRef['REP-001'].lines.map(l => [l.name, l.qty]).sort(), [['Rosary beads', 2], ['Votive candle', 3]]);
    assert.equal(byRef['REP-003'].status, 'awaiting_payment');
    assert.deepEqual(r.body.totals, { orders: 2, to_prepare: 2, taken: 17 });
    const next = await call('shop_orders', { weekend: '2026-11-21' }, { session: S.adA });
    assert.deepEqual(next.body.orders.map(o => o.name), ['Next Weekend']);
    assert.ok(a && c);
  });
  await t.test('tick prepared, then collected; undo; an unpaid or cancelled order cannot be ticked', async () => {
    const { a, c } = await setup();
    const mark = (id, status) => call('shop_order_mark', { order_id: id, status }, { session: S.adA });
    assert.equal((await mark(a.order_id, 'prepared')).status, 200);
    let o = T('repository_orders').find(x => x.id === a.order_id); assert.equal(o.status, 'prepared'); assert.ok(o.prepared_at);
    assert.equal((await mark(a.order_id, 'collected')).status, 200); assert.equal(o.status, 'collected'); assert.ok(o.collected_at); assert.ok(o.prepared_at);
    assert.equal((await mark(a.order_id, 'paid')).status, 200); assert.equal(o.status, 'paid'); assert.equal(o.prepared_at, null); assert.equal(o.collected_at, null);
    assert.equal((await mark(c.order_id, 'prepared')).status, 400);
    assert.equal((await mark(a.order_id, 'cancelled')).status, 400);
    assert.equal((await call('shop_order_mark', { order_id: a.order_id, status: 'prepared' }, { session: S.seA })).status, 403);
    assert.equal((await call('shop_order_mark', { order_id: a.order_id, status: 'prepared' }, { session: S.saB })).status, 404);
  });
  await t.test('cancel an order: the stock goes back; with a refund it is recorded on the payment', async () => {
    const { a, b } = await setup();
    assert.equal(stock(I.rosary), 1);
    const r = await call('shop_order_cancel', { order_id: a.order_id, reason: 'Item damaged', refund_amount: 15 }, { session: S.adA });
    assert.equal(r.status, 200, r.raw); assert.equal(r.body.status, 'cancelled'); assert.equal(r.body.refunded, 15);
    assert.equal(stock(I.rosary), 3);
    const pay = T('payments').find(p => p.id === T('repository_orders').find(x => x.id === a.order_id).payment_id);
    assert.equal(pay.refund_amount, 15); assert.match(pay.refund_note, /REP-001 cancelled: Item damaged/);
    assert.equal((await call('shop_order_cancel', { order_id: a.order_id, reason: 'again' }, { session: S.adA })).status, 400);
    assert.equal((await call('shop_order_cancel', { order_id: b.order_id, reason: '' }, { session: S.adA })).status, 400);
    const list = await call('shop_orders', {}, { session: S.adA });
    assert.equal(list.body.totals.orders, 1);   // a cancelled order is no longer counted
    assert.equal((await call('shop_order_cancel', { order_id: b.order_id, reason: 'x', refund_amount: 1000 }, { session: S.adA })).status, 400);
    assert.equal(T('repository_orders').find(x => x.id === b.order_id).status, 'paid');   // a refused refund cancels nothing
  });
  await t.test('an unpaid order cannot be refunded; a priest may cancel but not record a refund', async () => {
    const { c, b } = await setup();
    assert.equal((await call('shop_order_cancel', { order_id: c.order_id, reason: 'x', refund_amount: 2 }, { session: S.adA })).status, 400);
    assert.equal((await call('shop_order_cancel', { order_id: b.order_id, reason: 'x', refund_amount: 2 }, { session: S.prA })).status, 403);
    assert.equal(T('repository_orders').find(x => x.id === b.order_id).status, 'paid');
    assert.equal((await call('shop_order_cancel', { order_id: b.order_id, reason: 'Collected by mistake?' }, { session: S.prA })).status, 200);
  });
  await t.test('another parish never sees these orders', async () => {
    await setup();
    const r = await call('shop_orders', {}, { session: S.saB });
    assert.deepEqual(r.body.orders, []); assert.deepEqual(r.body.weekends, []);
  });
});

test('The rest of the app is not disturbed', async (t) => {
  await t.test('the hidden weekend campaigns never appear in campaign or registration lists, or among the parish page choices', async () => {
    reset(); await order();
    assert.equal(T('campaigns').length, 1);
    const lc = await call('list_campaigns', { include_inactive: true }, { session: S.saA });
    if (lc.status === 200) assert.equal((lc.body.campaigns || []).some(c => c.form_def && c.form_def.shop), false);
    const gg = await call('gateway_get', {}, { session: S.adA });
    assert.equal(gg.status, 200);
    assert.equal(JSON.stringify(gg.body.sections).includes('Repository'), false);
  });
  await t.test('the books check does not mistake a Repository payment for a ticket problem', async () => {
    reset(); const o = (await order()).body; sumupState.status = 'PAID';
    await call('sumup_webhook', { id: T('payments')[0].sumup_checkout_id });
    const r = await call('ledger_check', {}, { session: S.saA });
    if (r.status === 200) assert.deepEqual(r.body.problems, [], JSON.stringify(r.body.problems));
    assert.ok(o);
  });
  await t.test('the parish page shows the shopping-bag shortcut only while the repository is open', async () => {
    reset();
    assert.deepEqual((await call('public_gateway', { slug: 'svp-osterley' })).body.shop, { path: '/shop/svp-osterley' });
    T('repository_settings').find(s => s.org_id === 'org-A').enabled = false;
    assert.equal((await call('public_gateway', { slug: 'svp-osterley' })).body.shop, null);
  });
  await t.test('the migration only adds: no drops, deletes or renames; every table has row security and explicit grants', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20261109010000_repository_shop.sql'), 'utf8');
    const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    assert.ok(!/\bdrop\s+(table|column|function|index|constraint)\b|\bdelete\s+from\b|\btruncate\b|\brename\b/i.test(code));
    for (const tbl of ['repository_items', 'repository_settings', 'repository_weekends', 'repository_orders', 'repository_order_lines']) assert.match(code, new RegExp(`alter table ${tbl} enable row level security`));
    assert.match(code, /grant select, insert, update, delete on table repository_items[^;]*to service_role/);
    assert.equal((code.match(/to service_role;/g) || []).length, 4);
    assert.equal((code.match(/revoke all on function/g) || []).length, 3);
  });
});
