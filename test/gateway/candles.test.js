// Light a Candle: asking for candles to be lit, the offering by card, the office list, and the Thursday email.
// Run with:  node --test "test/gateway/*.test.js"   (no network: SumUp and the mail account are replaced by stand-ins)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { api, db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
let S, sumup, sumupStatus, mails, mailFails;
function reset(at = '2026-11-09T12:00:00Z') {   // a Monday
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set(at);
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true, display_name: null, contact_email: 'osterley@rcdow.org' });
  T('organizations').push({ id: 'org-B', name: 'Other Parish', slug: 'other-parish', timezone: 'Europe/London', gateway_enabled: true, contact_email: 'other@example.org' });
  S = { saA: addUser('uA-sa', 'superadmin', 'org-A'), adA: addUser('uA-ad', 'admin', 'org-A'), fiA: addUser('uA-fi', 'finance', 'org-A'), prA: addUser('uA-pr', 'priest', 'org-A'), seA: addUser('uA-se', 'seller', 'org-A'), saB: addUser('uB-sa', 'superadmin', 'org-B') };
  T('candle_settings').push({ org_id: 'org-A', enabled: true, altars: [{ id: 'mary', name: 'Altar of Our Lady', active: true }, { id: 'anthony', name: 'Altar of St Anthony of Padua', active: true }, { id: 'old', name: 'Old stand', active: false }], intro_text: 'Light a candle for someone you love.', cutoff_weekday: 3, cutoff_time: '23:59', next_ref: 1 });
  T('candle_settings').push({ org_id: 'org-B', enabled: true, altars: [{ id: 'b1', name: 'B altar', active: true }], intro_text: null, cutoff_weekday: 3, cutoff_time: '23:59', next_ref: 1 });
  sumup = []; sumupStatus = 'PENDING'; mails = []; mailFails = false;
  api.setMailer(async (m) => { if (mailFails) throw new Error('Gmail said no'); mails.push(m); });
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (opts.method === 'POST' && u.endsWith('/v0.1/checkouts')) { sumup.push(JSON.parse(opts.body || '{}')); return { ok: true, status: 200, json: async () => ({ id: 'co-' + sumup.length, hosted_checkout_url: 'https://pay.example/' + sumup.length }) }; }
    if (opts.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
    if (/\/v0\.1\/checkouts\/co-/.test(u)) { const paid = sumupStatus === 'PAID'; return { ok: true, status: 200, json: async () => ({ id: u.split('/').pop(), status: sumupStatus, date: new Date(clock.now()).toISOString(), transactions: paid ? [{ id: 'tx-1', transaction_code: 'TAAA000001', status: 'SUCCESSFUL' }] : [] }) }; }
    throw new Error('the network is off in tests: ' + u);
  };
}
const MON = '2026-11-16';
let seq = 0;
const ask = (over, opts) => call('public_candle_request', { slug: 'svp-osterley', light_date: '2026-11-17', altar_id: 'mary', candles: 2, per_candle: 2, name: 'Mary Murphy', phone: '07700 900123', intention: '', client_ref: 'ref-' + (++seq) + '-' + Math.random().toString(36).slice(2, 10), ...over }, opts);
const win = (slug = 'svp-osterley') => call('public_candles', { slug });
const week = (monday = MON, who = 'adA') => call('candles_week', { monday }, { session: S[who] });
// a paid request put straight into the tables (as if paid), with its payment
function paidRequest(over, who) {
  const n = ++seq, pid = 'pay-' + n;
  if (!T('campaigns').some(c => c.id === 'camp-x')) T('campaigns').push({ id: 'camp-x', org_id: 'org-A', name: 'Candles, test', binned: false });
  T('payments').push({ id: pid, campaign_id: 'camp-x', method: 'link', amount: 4, status: 'paid', payer_name: (who && who.name) || 'Pat Person', contact_value: '07700000000', created_at: '2026-11-01T10:00:00.000Z' });
  T('candle_requests').push({ id: 'cr-' + n, org_id: 'org-A', ref_no: n, payment_id: pid, status: 'paid', light_date: '2026-11-17', altar_id: 'mary', altar_name: 'Altar of Our Lady', candles: 2, per_candle: 2, total: 4, intention: null, created_at: '2026-11-01T10:00:00.000Z', ...over });
  return 'cr-' + n;
}

test('The days on offer', async (t) => {
  await t.test('the next four weeks (Monday to Sunday) whose cut-off has not passed; the altars; the offering range; the cut-off said plainly', async () => {
    reset();
    const r = await win();
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.weeks.map(w => w.monday), ['2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07']);
    assert.equal(r.body.weeks[0].label, 'Week of Monday 16 November'); assert.equal(r.body.weeks[0].dates.length, 7);
    assert.deepEqual(r.body.weeks[0].dates.map(d => d.date), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
    assert.deepEqual(r.body.altars.map(a => a.name), ['Altar of Our Lady', 'Altar of St Anthony of Padua']);   // the switched-off one is not offered
    assert.deepEqual(r.body.offering, { min: 1.5, max: 5, suggested: [1.5, 2, 3, 5] }); assert.equal(r.body.max_candles, 10);
    assert.match(r.body.cutoff_text, /Wednesday midnight/);
    assert.equal(r.body.intro, 'Light a candle for someone you love.');
  });
  await t.test('a week closes on Wednesday midnight, in the parish\'s own time, summer time included', async () => {
    reset('2026-11-11T23:30:00Z'); assert.equal((await win()).body.weeks[0].monday, MON);
    reset('2026-11-12T00:05:00Z'); assert.equal((await win()).body.weeks[0].monday, '2026-11-23');
    reset('2026-06-10T23:30:00Z'); assert.equal((await win()).body.weeks[0].monday, '2026-06-22');   // 23:30 UTC is 00:30 on Thursday in London in June
    reset('2026-06-10T22:30:00Z'); assert.equal((await win()).body.weeks[0].monday, '2026-06-15');
  });
  await t.test('closed, no stand switched on, unknown and junk addresses are a plain 404', async () => {
    reset();
    T('candle_settings').find(s => s.org_id === 'org-A').enabled = false;
    assert.equal((await win()).status, 404); assert.equal((await ask()).status, 404);
    T('candle_settings').find(s => s.org_id === 'org-A').enabled = true; T('candle_settings').find(s => s.org_id === 'org-A').altars.forEach(a => { a.active = false; });
    assert.equal((await win()).status, 404);
    assert.equal((await win('nobody-here')).status, 404); assert.equal((await win('A')).status, 404);
  });
});

test('Asking for candles', async (t) => {
  await t.test('priced by the number of candles and the offering for each, paid by card on the page; the intention is kept privately; the ref is CAN-001', async () => {
    reset();
    const r = await ask({ candles: 3, per_candle: 1.5, intention: 'For my mother, who is unwell' });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ref, 'CAN-001'); assert.equal(r.body.total, 4.5); assert.equal(r.body.status, 'awaiting_payment'); assert.match(r.body.pay_url, /^https:\/\/pay\.example\//);
    assert.equal(sumup[0].amount, 4.5); assert.match(sumup[0].description, /Candles CAN-001, Altar of Our Lady/); assert.match(sumup[0].redirect_url, /\/candles\.html\?request=/); assert.match(sumup[0].return_url, /\/api\/sumup_webhook$/);
    const row = T('candle_requests')[0];
    assert.deepEqual([row.light_date, row.altar_id, row.altar_name, row.candles, row.per_candle, row.total, row.intention, row.status], ['2026-11-17', 'mary', 'Altar of Our Lady', 3, 1.5, 4.5, 'For my mother, who is unwell', 'awaiting_payment']);
    for (const k of Object.keys(row)) assert.ok(!/phone|email|contact|payer|name$/.test(k.replace('altar_name', '')), 'the request holds ' + k);
    const pay = T('payments')[0], camp = T('campaigns').find(c => c.id === pay.campaign_id);
    assert.equal(pay.payer_name, 'Mary Murphy'); assert.equal(pay.contact_value, '07700900123'); assert.equal(pay.amount, 4.5);
    assert.equal(camp.name, 'Candles, November 2026'); assert.equal(camp.form_def.candles, true); assert.equal(camp.public_page_enabled, false); assert.equal(camp.keep_until, '2027-02-13');
  });
  await t.test('the total is exact to the penny: 7 candles at £2.33 is £16.31', async () => {
    reset(); const r = await ask({ candles: 7, per_candle: 2.33 });
    assert.equal(r.status, 200, r.raw); assert.equal(r.body.total, 16.31); assert.equal(sumup[0].amount, 16.31);
  });
  await t.test('references count up and the next day, altar and week can all be asked for', async () => {
    reset();
    await ask({}); await ask({ altar_id: 'anthony', light_date: '2026-11-24' }); const c = await ask({ light_date: '2026-12-13' });
    assert.deepEqual(T('candle_requests').map(r => r.ref_no), [1, 2, 3]); assert.equal(c.body.ref, 'CAN-003');
    assert.equal(T('campaigns').length, 1, 'one hidden campaign for the month');
  });
  await t.test('paid brings it onto the list; never paid cancels it; paid late brings it back', async () => {
    reset();
    const r = await ask({}); const row = T('candle_requests')[0], pay = T('payments')[0];
    let s = await call('public_candle_status', { request_id: row.id });
    assert.equal(s.body.status, 'awaiting_payment'); assert.ok(s.body.pay_url); assert.equal(s.body.ref, 'CAN-001'); assert.equal(s.body.date_label, 'Tuesday 17 November'); assert.equal(s.body.altar, 'Altar of Our Lady');
    assert.equal(JSON.stringify(s.body).includes('Mary'), false); assert.equal(JSON.stringify(s.body).includes('0770'), false);
    sumupStatus = 'EXPIRED'; s = await call('public_candle_status', { request_id: row.id }); assert.equal(s.body.status, 'cancelled');
    sumupStatus = 'PAID'; await call('sumup_webhook', { id: pay.sumup_checkout_id });
    assert.equal(T('candle_requests')[0].status, 'paid'); assert.ok(T('candle_requests')[0].paid_at); assert.equal(T('payments')[0].status, 'paid'); assert.ok(r);
    assert.equal((await call('public_candle_status', { request_id: 'x' })).status, 400); assert.equal((await call('public_candle_status', { request_id: '11111111-1111-4111-8111-111111111111' })).status, 404);
  });
  await t.test('refused, in plain words: a day not on offer, no stand, too many or too few candles, an offering out of range, no name or contact, a bad email', async () => {
    reset();
    const bad = async (over, status, re) => { const r = await ask(over); assert.equal(r.status, status, JSON.stringify(over) + ' ' + r.raw); if (re) assert.match(r.body.error, re); };
    for (const d of ['2026-11-15', '2026-11-09', '2026-12-14', '2027-01-04', '2026-11-17T10:00', 'x', undefined]) await bad({ light_date: d }, 409, /no longer open/);
    await bad({ altar_id: 'old' }, 400, /where the candle/); await bad({ altar_id: 'b1' }, 400, /where the candle/); await bad({ altar_id: undefined }, 400);
    for (const n of [0, 11, 1.5, 'x', undefined, -1]) await bad({ candles: n }, 400, /1 to 10 candles/);
    for (const p of [1.49, 5.01, 0, -2, 'x', undefined, NaN]) await bad({ per_candle: p }, 400, /£1\.50 to £5\.00/);
    await bad({ name: '' }, 400, /your name/); await bad({ phone: '', email: '' }, 400, /mobile number or an email/); await bad({ phone: '', email: 'nope' }, 400, /email address/); await bad({ phone: '123' }, 400);
    assert.equal(T('candle_requests').length, 0); assert.equal(T('payments').length, 0);
    assert.equal((await ask({ per_candle: 1.5 })).status, 200); assert.equal((await ask({ per_candle: 5, candles: 10 })).body.total, 50);
  });
  await t.test('a second tap with the same reference does not light twice; the spam trap stores nothing; 30 an hour per connection', async () => {
    reset();
    const a = await ask({ client_ref: 'same-ref-12345' }), b = await ask({ client_ref: 'same-ref-12345' });
    assert.equal(a.body.request_id, b.body.request_id); assert.equal(b.body.replay, true); assert.equal(T('candle_requests').length, 1); assert.equal(T('payments').length, 1);
    assert.equal((await ask({ website: 'http://spam.example' })).status, 200); assert.equal(T('candle_requests').length, 1);
    reset();
    for (let i = 0; i < 30; i++) assert.equal((await ask({ client_ref: 'r' + i + '-xxxxxxxx', phone: '', email: 'p' + i + '@example.org' }, { ip: '10.4.4.4' })).status, 200);
    assert.equal((await ask({}, { ip: '10.4.4.4' })).status, 429);
  });
  await t.test('if SumUp cannot make the payment link the request is cancelled and the payment voided', async () => {
    reset();
    const keep = global.fetch; global.fetch = async (url, opts = {}) => (opts.method === 'POST' ? { ok: false, status: 500, json: async () => ({ message: 'down' }) } : keep(url, opts));
    const r = await ask({});
    assert.equal(r.status, 502); assert.equal(T('candle_requests')[0].status, 'cancelled'); assert.equal(T('payments')[0].status, 'void');
  });
  await t.test('nothing is disturbed: the hidden campaign is never listed, the books check is not confused, and the parish page gets a candle shortcut only while it is open', async () => {
    reset(); await ask({}); sumupStatus = 'PAID'; await call('sumup_webhook', { id: T('payments')[0].sumup_checkout_id });
    const lc = await call('list_campaigns', { include_inactive: true }, { session: S.saA }); if (lc.status === 200) assert.equal((lc.body.campaigns || []).length, 0);
    const lg = await call('ledger_check', {}, { session: S.saA }); if (lg.status === 200) assert.deepEqual(lg.body.problems, [], JSON.stringify(lg.body.problems));
    assert.deepEqual((await call('public_gateway', { slug: 'svp-osterley' })).body.candles, { path: '/candles/svp-osterley' });
    T('candle_settings').find(s => s.org_id === 'org-A').enabled = false;
    assert.equal((await call('public_gateway', { slug: 'svp-osterley' })).body.candles, null);
  });
});

test('The office list', async (t) => {
  await t.test('the week, by request: who, which stand, which day, how many candles, the private intention, and what has to be lit; unpaid shown but not counted', async () => {
    reset();
    await ask({ candles: 3, per_candle: 2, intention: 'For my mother' }); sumupStatus = 'PAID'; await call('sumup_webhook', { id: T('payments')[0].sumup_checkout_id }); sumupStatus = 'PENDING';
    await ask({ altar_id: 'anthony', light_date: '2026-11-18', name: 'John Byrne', email: 'john@example.org', phone: '' });
    const r = await week();
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.label, 'Week of Monday 16 November');
    const by = Object.fromEntries(r.body.requests.map(x => [x.ref, x]));
    assert.deepEqual([by['CAN-001'].name, by['CAN-001'].altar, by['CAN-001'].date_label, by['CAN-001'].candles, by['CAN-001'].intention, by['CAN-001'].status, by['CAN-001'].total], ['Mary Murphy', 'Altar of Our Lady', 'Tuesday 17 November', 3, 'For my mother', 'paid', 6]);
    assert.equal(by['CAN-002'].status, 'awaiting_payment'); assert.equal(by['CAN-002'].contact, 'john@example.org');
    assert.deepEqual(r.body.totals, { requests: 1, candles: 3, to_light: 3, offered: 6 });
    assert.equal((await week('2026-11-23')).body.requests.length, 0);
    assert.equal((await week('2026-11-17')).status, 400, 'only a Monday'); assert.equal((await week('nope')).status, 400);
  });
  await t.test('tick lit, and put back; an unpaid or cancelled request cannot be ticked', async () => {
    reset(); const id = paidRequest({}); const un = paidRequest({ status: 'awaiting_payment' }); const cx = paidRequest({ status: 'cancelled' });
    const mark = (i, lit, who = 'adA') => call('candles_mark', { id: i, lit }, { session: S[who] });
    assert.equal((await mark(id, true)).status, 200); assert.equal(T('candle_requests').find(r => r.id === id).status, 'lit'); assert.ok(T('candle_requests').find(r => r.id === id).lit_at);
    assert.deepEqual((await week()).body.totals, { requests: 1, candles: 2, to_light: 0, offered: 4 });
    assert.equal((await mark(id, false)).status, 200); assert.equal(T('candle_requests').find(r => r.id === id).status, 'paid'); assert.equal(T('candle_requests').find(r => r.id === id).lit_at, null);
    assert.equal((await mark(un, true)).status, 400); assert.equal((await mark(cx, true)).status, 400);
    assert.equal((await mark(id, true, 'seA')).status, 403); assert.equal((await mark(id, true, 'saB')).status, 404);
  });
  await t.test('cancel: needs a reason; a refund of a paid one is noted on the payment (Admin, Superadmin, Finance only)', async () => {
    reset(); const id = paidRequest({}), id2 = paidRequest({}), un = paidRequest({ status: 'awaiting_payment' });
    const cancel = (i, b, who = 'adA') => call('candles_cancel', { id: i, ...b }, { session: S[who] });
    assert.equal((await cancel(id, { reason: '' })).status, 400);
    const ok = await cancel(id, { reason: 'Asked to cancel', refund_amount: 4 });
    assert.equal(ok.status, 200, ok.raw); assert.equal(ok.body.refunded, 4);
    assert.equal(T('payments').find(p => p.id === T('candle_requests').find(r => r.id === id).payment_id).refund_amount, 4);
    assert.equal(T('candle_requests').find(r => r.id === id).status, 'cancelled'); assert.equal((await cancel(id, { reason: 'again' })).status, 400);
    assert.equal((await cancel(un, { reason: 'x', refund_amount: 1 })).status, 400, 'an unpaid request has nothing to refund');
    assert.equal((await cancel(id2, { reason: 'Moved away', refund_amount: 4 }, 'prA')).status, 200, 'a priest can do everything a superadmin can, including a refund'); assert.equal(T('candle_requests').find(r => r.id === id2).status, 'cancelled');
  });
  await t.test('only the office, and only their own parish', async () => {
    reset(); paidRequest({});
    for (const who of ['saA', 'adA', 'fiA', 'prA']) assert.equal((await call('candles_get', {}, { session: S[who] })).status, 200, who);
    assert.equal((await call('candles_get', {}, { session: S.seA })).status, 403); assert.ok((await call('candles_get', {})).status >= 400);
    assert.equal((await week(MON, 'seA')).status, 403);
    assert.deepEqual((await week(MON, 'saB')).body.requests, []);
  });
  await t.test('the stands, the welcome line and the cut-off are editable; opening needs a page address and a stand switched on', async () => {
    reset();
    const set = (b) => call('candles_set_settings', b, { session: S.adA });
    assert.equal((await set({ altars: [] })).status, 400); assert.equal((await set({ altars: [1, 2, 3, 4, 5].map(i => ({ name: 'S' + i })) })).status, 400); assert.equal((await set({ altars: [{ name: '' }] })).status, 400);
    const ok = await set({ altars: [{ id: 'mary', name: 'Altar of Our Lady', active: true }, { name: 'Sacred Heart altar', active: true }], intro_text: 'Hello', cutoff_weekday: 2, cutoff_time: '18:00' });
    assert.equal(ok.status, 200, ok.raw);
    const st = T('candle_settings').find(s => s.org_id === 'org-A');
    assert.equal(st.altars.length, 2); assert.ok(/^[a-z0-9]{2,12}$/.test(st.altars[1].id)); assert.deepEqual([st.intro_text, st.cutoff_weekday, st.cutoff_time], ['Hello', 2, '18:00']);
    assert.equal((await set({ cutoff_weekday: 9 })).status, 400); assert.equal((await set({ cutoff_time: '6pm' })).status, 400);
    assert.equal((await set({ altars: [{ name: 'Only', active: false }], enabled: true })).status, 400);
    T('organizations').find(o => o.id === 'org-A').slug = null; assert.equal((await set({ enabled: true })).status, 400);
    T('organizations').find(o => o.id === 'org-A').slug = 'svp-osterley'; assert.equal((await set({ enabled: false })).status, 200);
  });
  await t.test('an intention is cleared a month after its day', async () => {
    reset(); const id = paidRequest({ intention: 'For Dad', light_date: '2026-10-01' }), recent = paidRequest({ intention: 'For Mum', light_date: '2026-11-17' });
    await call('candles_get', {}, { session: S.adA });
    assert.equal(T('candle_requests').find(r => r.id === id).intention, null); assert.equal(T('candle_requests').find(r => r.id === recent).intention, 'For Mum');
  });
});

test('The Thursday email', async (t) => {
  const thursday = '2026-11-12T08:30:00Z';
  await t.test('names, stands, days and candle counts for the coming week, then the paid Repository orders for the coming weekend with the items to get out; never an intention, a phone number or an email address', async () => {
    reset(thursday);
    paidRequest({ light_date: '2026-11-16', candles: 2, intention: 'PRIVATE INTENTION' }, { name: 'Mary Murphy' });
    paidRequest({ light_date: '2026-11-16', altar_id: 'anthony', altar_name: 'Altar of St Anthony of Padua', candles: 1 }, { name: 'John Byrne' });
    paidRequest({ light_date: '2026-11-18', candles: 3, status: 'lit' }, { name: 'Sue Smith' });
    paidRequest({ light_date: '2026-11-16', candles: 9, status: 'awaiting_payment' }, { name: 'Not Paid' }); paidRequest({ light_date: '2026-11-17', candles: 9, status: 'cancelled' }, { name: 'Cancelled Person' });
    paidRequest({ light_date: '2026-11-23', candles: 9 }, { name: 'Next Week Person' }); paidRequest({ light_date: '2026-11-15', candles: 9 }, { name: 'Last Week Person' });
    const order = (n, status, date, slot, name, lines) => { const pid = 'op' + n; T('payments').push({ id: pid, campaign_id: 'camp-x', payer_name: name, status: 'paid' }); T('repository_orders').push({ id: 'ro' + n, org_id: 'org-A', ref_no: n, payment_id: pid, status, collect_date: date, slot_id: 's', slot_label: slot, total: 5 }); lines.forEach(([item, q], i) => T('repository_order_lines').push({ id: `rl${n}-${i}`, order_id: 'ro' + n, item_name: item, qty: q })); };
    order(1, 'paid', '2026-11-21', 'Saturday 21 November, 6 pm — Vigil Mass', 'Ann Archer', [['Rosary beads', 2], ['Votive candle', 3]]);
    order(2, 'prepared', '2026-11-22', 'Sunday 22 November, 9:30 am — Mass', 'Ben Brown', [['Rosary beads', 1]]);
    order(3, 'awaiting_payment', '2026-11-21', 'Saturday 21 November, 6 pm — Vigil Mass', 'Unpaid Orderer', [['Bible', 1]]); order(4, 'cancelled', '2026-11-21', 'x', 'Cancelled Orderer', [['Bible', 1]]); order(5, 'paid', '2026-11-28', 'Saturday 28 November', 'Later Orderer', [['Bible', 1]]);
    const r = await call('digest_preview', {}, { session: S.adA });
    assert.equal(r.status, 200, r.raw);
    const text = r.body.text;
    assert.equal(r.body.subject, 'Thursday list: Week of Monday 16 November');
    assert.match(text, /LIGHT A CANDLE: 3 requests, 6 candles/);
    assert.match(text, /Monday 16 November\n  Altar of Our Lady \(2 candles\): Mary Murphy x2\n  Altar of St Anthony of Padua \(1 candle\): John Byrne x1/);
    assert.match(text, /Wednesday 18 November\n  Altar of Our Lady \(3 candles\): Sue Smith x3 \(lit\)/);
    assert.match(text, /REPOSITORY ORDERS FOR THE WEEKEND \(Saturday 21 November and Sunday 22 November\): 2 paid orders/);
    assert.match(text, /Saturday 21 November, 6 pm — Vigil Mass\n  REP-001  Ann Archer: 2 x Rosary beads, 3 x Votive candle/); assert.match(text, /REP-002  Ben Brown: 1 x Rosary beads/);
    assert.match(text, /All the items to get out: Rosary beads x3; Votive candle x3/);
    for (const bad of ['PRIVATE INTENTION', 'Not Paid', 'Cancelled Person', 'Next Week Person', 'Last Week Person', 'Unpaid Orderer', 'Cancelled Orderer', 'Later Orderer', '0770', '@']) assert.equal(text.includes(bad), false, 'the email must not hold ' + bad);
    assert.deepEqual(r.body.counts, { requests: 3, candles: 6, orders: 2 });
  });
  await t.test('a quiet week still says so (so no email never means "nothing to do" by mistake); another parish\'s names never appear', async () => {
    reset(thursday);
    T('payments').push({ id: 'bp', payer_name: 'B Person', status: 'paid' }); T('candle_requests').push({ id: 'bcr', org_id: 'org-B', ref_no: 1, payment_id: 'bp', status: 'paid', light_date: '2026-11-17', altar_id: 'b1', altar_name: 'B altar', candles: 2, per_candle: 2, total: 4 });
    const r = await call('digest_preview', {}, { session: S.adA });
    assert.match(r.body.text, /No candle requests for this week\./); assert.match(r.body.text, /No paid orders yet for this weekend\./); assert.equal(r.body.text.includes('B Person'), false);
  });
  await t.test('Send now: refused in plain words until email sending is set up; then sent to the parish address, in text and HTML, and the result is written down', async () => {
    reset(thursday); api.setMailer(null); const keepUser = process.env.MAIL_USER, keepPass = process.env.MAIL_APP_PASSWORD; delete process.env.MAIL_USER; delete process.env.MAIL_APP_PASSWORD;
    const no = await call('digest_send_now', {}, { session: S.adA });
    assert.equal(no.status, 400); assert.match(no.body.error, /has not been set up/);
    api.setMailer(async (m) => { mails.push(m); if (keepUser) process.env.MAIL_USER = keepUser; });
    paidRequest({ light_date: '2026-11-17' }, { name: 'Mary Murphy' });
    const ok = await call('digest_send_now', {}, { session: S.adA });
    assert.equal(ok.status, 200, ok.raw); assert.equal(ok.body.to, 'osterley@rcdow.org');
    assert.equal(mails.length, 1); assert.equal(mails[0].to, 'osterley@rcdow.org'); assert.match(mails[0].subject, /^Thursday list: Week of Monday 16 November/); assert.match(mails[0].text, /Mary Murphy x2/); assert.match(mails[0].html, /<b>Tuesday 17 November<\/b>/); assert.match(mails[0].html, /Mary Murphy &times;2/);
    const d = T('weekly_digest').find(x => x.org_id === 'org-A');
    assert.equal(d.last_status, 'sent'); assert.equal(d.last_week_start, '2026-11-16'); assert.ok(d.last_sent_at); assert.match(d.last_note, /Sent to osterley@rcdow\.org: 1 candle request, 0 repository orders/);
    assert.equal((await call('digest_send_now', {}, { session: S.seA })).status, 403);
    if (keepPass) process.env.MAIL_APP_PASSWORD = keepPass;
  });
  await t.test('the HTML is safe: names with markup are shown as text', async () => {
    reset(thursday); paidRequest({ light_date: '2026-11-17' }, { name: '<script>alert(1)</script> & Co' });
    const r = await call('digest_send_now', {}, { session: S.adA }); assert.equal(r.status, 200);
    assert.equal(mails[0].html.includes('<script>'), false); assert.match(mails[0].html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; Co/);
  });
  await t.test('a failed send is written down with the reason and reported; the next run tries again', async () => {
    reset(thursday); mailFails = true;
    const bad = await call('digest_send_now', {}, { session: S.adA });
    assert.equal(bad.status, 502); assert.match(bad.body.error, /Gmail said no/);
    assert.equal(T('weekly_digest')[0].last_status, 'failed'); assert.match(T('weekly_digest')[0].last_note, /Gmail said no/); assert.equal(T('weekly_digest')[0].last_week_start, null);
    mailFails = false; assert.equal((await call('digest_send_now', {}, { session: S.adA })).status, 200); assert.equal(T('weekly_digest')[0].last_status, 'sent');
  });
  await t.test('the schedule: only when switched on, only on a Thursday from 8 o\'clock in the parish\'s time, once a week; a failed attempt is tried again; summer time works', async () => {
    reset();
    T('weekly_digest').push({ org_id: 'org-A', enabled: false, to_email: null });
    const run = (iso) => api.runWeeklyDigests(new Date(iso));
    assert.deepEqual(await run('2026-11-12T08:30:00Z'), [], 'nothing is even looked at while it is switched off');
    T('weekly_digest')[0].enabled = true;
    assert.deepEqual((await run('2026-11-11T08:30:00Z')).map(r => r.skipped), ['not Thursday morning yet']);   // Wednesday
    assert.deepEqual((await run('2026-11-12T07:00:00Z')).map(r => r.skipped), ['not Thursday morning yet']);   // 7 o'clock in winter
    assert.equal(mails.length, 0);
    mailFails = true; const failed = await run('2026-11-12T08:00:00Z'); assert.equal(failed[0].ok, false); assert.equal(mails.length, 0);
    mailFails = false; const second = await run('2026-11-12T09:00:00Z'); assert.equal(second[0].ok, true); assert.equal(mails.length, 1);   // the retry an hour later
    assert.deepEqual((await run('2026-11-12T10:00:00Z')).map(r => r.skipped), ['already sent this week']); assert.equal(mails.length, 1);
    const next = await run('2026-11-19T08:00:00Z'); assert.equal(next[0].ok, true); assert.equal(mails.length, 2); assert.match(mails[1].subject, /Week of Monday 23 November/);
    reset(); T('weekly_digest').push({ org_id: 'org-A', enabled: true });
    assert.equal((await run('2026-06-11T06:59:00Z')).map(r => r.skipped)[0], 'not Thursday morning yet');   // 07:59 in London
    assert.equal((await run('2026-06-11T07:00:00Z'))[0].ok, true);   // 08:00 in London in summer is 07:00 UTC
  });
  await t.test('the address: the parish\'s own by default, or another typed in the screen (checked); none at all is a plain failure; other parishes are only sent theirs', async () => {
    reset(thursday);
    assert.equal((await call('digest_set', { to_email: 'not an email' }, { session: S.adA })).status, 400);
    assert.equal((await call('digest_set', { to_email: 'office@example.org', enabled: true }, { session: S.adA })).status, 200);
    await call('digest_send_now', {}, { session: S.adA }); assert.equal(mails[0].to, 'office@example.org');
    assert.equal((await call('digest_set', { to_email: '' }, { session: S.adA })).status, 200); await call('digest_send_now', {}, { session: S.adA }); assert.equal(mails[1].to, 'osterley@rcdow.org');
    T('organizations').find(o => o.id === 'org-A').contact_email = null;
    const none = await call('digest_send_now', {}, { session: S.adA }); assert.equal(none.status, 502); assert.match(none.body.error, /no email address/);
    T('weekly_digest').push({ org_id: 'org-B', enabled: true });
    const out = await api.runWeeklyDigests(new Date(thursday)); assert.ok(out.every(r => r.org !== 'org-A' || r.ok === false || r.skipped));
    const bMail = mails.filter(m => m.to === 'other@example.org'); assert.equal(bMail.length, 1); assert.equal(bMail[0].text.includes('Mary'), false);
  });
  await t.test('the screen knows whether sending is set up, and when the last one went', async () => {
    reset(thursday);
    const g = (await call('candles_get', {}, { session: S.adA })).body;
    assert.equal(g.digest.mail_ready, true); assert.equal(g.digest.sends_to, 'osterley@rcdow.org'); assert.equal(g.digest.last_status, null); assert.equal(g.next_monday, '2026-11-16'); assert.equal(g.digest.enabled, false);
    await call('digest_send_now', {}, { session: S.adA });
    const g2 = (await call('candles_get', {}, { session: S.adA })).body; assert.equal(g2.digest.last_status, 'sent'); assert.ok(g2.digest.last_sent_at);
  });
  await t.test('the scheduled function and its schedule exist; the migration only adds', () => {
    const fn = fs.readFileSync(path.join(__dirname, '..', '..', 'netlify', 'functions', 'thursday-digest.js'), 'utf8');
    assert.match(fn, /runWeeklyDigests/);
    const toml = fs.readFileSync(path.join(__dirname, '..', '..', 'netlify.toml'), 'utf8');
    assert.match(toml, /\[functions\."thursday-digest"\]\s+schedule = "0 7,8,9 \* \* 4"/); assert.match(toml, /from = "\/candles\/\*"/);
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')); assert.ok(pkg.dependencies.nodemailer);
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20261111000000_candles_digest.sql'), 'utf8');
    const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    assert.ok(!/\bdrop\s+(table|column|function|index|constraint)\b|\bdelete\s+from\b|\btruncate\b|\brename\b/i.test(code));
    for (const tbl of ['candle_settings', 'candle_requests', 'candle_months', 'weekly_digest']) assert.match(code, new RegExp(`alter table ${tbl} enable row level security`));
    assert.match(code, /revoke all on function public\.candle_next_ref[^;]*from public, anon, authenticated/); assert.match(code, /grant execute on function public\.candle_next_ref[^;]*to service_role/);
  });
});
