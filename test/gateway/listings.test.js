// Listings (the parish classifieds): making a listing, the suggested fee (and paying £0), the office approving it, what the public sees, privacy of the
// email address, counting views and contacts, ranking, ending and clearing out.
// Run with:  node --test "test/gateway/*.test.js"   (no network: SumUp is replaced by a stand-in)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { db, clock, call, addUser } = require('./harness');

const T = (n) => db.T(n);
let S, sumup, sumupStatus;
const webp = (n = 1500) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(n, 7)]).toString('base64');
const pic = () => ({ t: webp(1500), f: webp(20000) });

function reset(at = '2026-11-10T10:00:00Z') {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  db.uploads.length = 0; db.removed.length = 0;
  clock.set(at);
  T('organizations').push({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley', timezone: 'Europe/London', gateway_enabled: true, display_name: null });
  T('organizations').push({ id: 'org-B', name: 'Other Parish', slug: 'other-parish', timezone: 'Europe/London', gateway_enabled: true });
  S = { saA: addUser('uA-sa', 'superadmin', 'org-A'), adA: addUser('uA-ad', 'admin', 'org-A'), fiA: addUser('uA-fi', 'finance', 'org-A'), prA: addUser('uA-pr', 'priest', 'org-A'), seA: addUser('uA-se', 'seller', 'org-A'), saB: addUser('uB-sa', 'superadmin', 'org-B') };
  T('listings_settings').push({ org_id: 'org-A', enabled: true, intro_text: 'Welcome to our parish noticeboard.', price_base: 3, price_per_extra_week: 1.5, price_per_image: 0.5 });
  T('listings_settings').push({ org_id: 'org-B', enabled: true, intro_text: null, price_base: 3, price_per_extra_week: 1.5, price_per_image: 0.5 });
  sumup = []; sumupStatus = 'PENDING';
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (opts.method === 'POST' && u.endsWith('/v0.1/checkouts')) { sumup.push(JSON.parse(opts.body || '{}')); return { ok: true, status: 200, json: async () => ({ id: 'co-' + sumup.length, hosted_checkout_url: 'https://pay.example/' + sumup.length }) }; }
    if (opts.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
    if (/\/v0\.1\/checkouts\/co-/.test(u)) { const paid = sumupStatus === 'PAID'; return { ok: true, status: 200, json: async () => ({ id: u.split('/').pop(), status: sumupStatus, date: new Date(clock.now()).toISOString(), transactions: paid ? [{ id: 'tx-1', transaction_code: 'TAAA000001', status: 'SUCCESSFUL' }] : [] }) }; }
    throw new Error('the network is off in tests: ' + u);
  };
}
let seq = 0;
const make = (over, opts) => call('public_listing_create', {
  slug: 'svp-osterley', title: 'Garden chairs, set of four', description: 'Four sturdy wooden garden chairs, a few years old but in good condition. Collect from Osterley.', category: 'Furniture & home', kind: 'sell',
  price_text: '£40 the set', display_name: 'Mary', email: 'mary@example.org', days: 14, images: [pic()], amount: 0, agree: true, client_ref: 'ref-' + (++seq) + '-' + Math.random().toString(36).slice(2, 10), ...over,
}, opts);
const approve = (id, who = 'adA') => call('listings_review', { id, decision: 'approve' }, { session: S[who] });
const list = (slug = 'svp-osterley') => call('public_listings', { slug });
const row = (id) => T('listings').find(l => l.id === id);
const goLive = async (over) => { const r = await make(over); assert.equal(r.status, 200, r.raw); const l = T('listings').find(x => x.token === r.body.token); const a = await approve(l.id); assert.equal(a.status, 200, a.raw); return l; };

test('The suggested fee', async (t) => {
  await t.test('two suggestions from the length and the pictures, in half pounds, from a table the page reads', async () => {
    reset();
    const q = (await list()).body.new_listing.quotes;
    const at = (days, images) => q.find(x => x.days === days && x.images === images);
    assert.deepEqual(at(7, 0), { days: 7, images: 0, suggested: 3, supporter: 4.5 });
    assert.deepEqual(at(7, 2), { days: 7, images: 2, suggested: 4, supporter: 6 });
    assert.deepEqual(at(14, 2), { days: 14, images: 2, suggested: 5.5, supporter: 8.5 });
    assert.deepEqual(at(30, 4), { days: 30, images: 4, suggested: 9.5, supporter: 14.5 });
    for (const x of q) { assert.ok(x.supporter >= x.suggested + 1 && x.suggested * 2 % 1 === 0 && x.supporter * 2 % 1 === 0); }
    assert.ok(at(14, 1).suggested > at(14, 0).suggested && at(21, 1).suggested > at(14, 1).suggested, 'more time and more pictures cost more');
    assert.equal(q.length, 20);
  });
  await t.test('the office can change the three numbers, and the suggestions follow', async () => {
    reset();
    assert.equal((await call('listings_set_settings', { price_base: 5, price_per_extra_week: 2, price_per_image: 1 }, { session: S.adA })).status, 200);
    assert.deepEqual((await list()).body.new_listing.quotes.find(x => x.days === 14 && x.images === 2), { days: 14, images: 2, suggested: 9, supporter: 13.5 });
    await call('listings_set_settings', { price_base: 0, price_per_extra_week: 0, price_per_image: 0 }, { session: S.adA });
    const free = (await list()).body.new_listing.quotes[0];
    assert.deepEqual([free.suggested, free.supporter], [0, 1]);   // nothing suggested: the supporter amount is £1
    for (const bad of [{ price_base: -1 }, { price_base: 51 }, { price_per_image: 21 }, { price_per_extra_week: 'x' }]) assert.equal((await call('listings_set_settings', bad, { session: S.adA })).status, 400, JSON.stringify(bad));
  });
});

test('Making a listing', async (t) => {
  await t.test('£0 is fine: no payment, it goes to the office, its pictures are stored, and the lister gets a private link', async () => {
    reset();
    const r = await make({ images: [pic(), pic()], amount: 0 });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.status, 'pending_review'); assert.equal(r.body.fee, 0); assert.match(r.body.token, /^[0-9a-f]{32}$/); assert.equal(r.body.pay_url, undefined);
    assert.equal(T('payments').length, 0); assert.equal(sumup.length, 0);
    const l = T('listings')[0];
    assert.equal(l.status, 'pending_review'); assert.equal(l.email, 'mary@example.org'); assert.equal(l.agreed_version, 1); assert.ok(l.agreed_at);
    assert.equal(l.images.length, 2); assert.equal(db.uploads.length, 4);
    assert.ok(db.uploads.every(u => u.bucket === 'listings' && u.opts.cacheControl === '31536000' && u.path.startsWith('org-A/' + l.id + '/')));
    assert.equal((await list()).body.listings.length, 0, 'nothing is public until the office approves it');
  });
  await t.test('a fee is an ordinary card payment: priced by the lister\'s choice, held in a hidden monthly campaign, and the listing waits until it is paid', async () => {
    reset();
    const r = await make({ amount: 5.5 });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.status, 'awaiting_payment'); assert.equal(r.body.fee, 5.5); assert.match(r.body.pay_url, /^https:\/\/pay\.example\//);
    assert.equal(sumup[0].amount, 5.5); assert.match(sumup[0].redirect_url, /\/listings\.html\?manage=[0-9a-f]{32}$/); assert.match(sumup[0].return_url, /\/api\/sumup_webhook$/); assert.match(sumup[0].description, /Listing: Garden chairs/);
    const pay = T('payments')[0], camp = T('campaigns').find(c => c.id === pay.campaign_id);
    assert.equal(pay.amount, 5.5); assert.equal(pay.contact_value, 'mary@example.org'); assert.equal(pay.payer_name, 'Mary'); assert.equal(pay.status, 'pending');
    assert.equal(camp.name, 'Listings, November 2026'); assert.equal(camp.form_def.listings, true); assert.equal(camp.public_page_enabled, false); assert.equal(camp.keep_until, '2027-02-13');
    assert.equal(T('listings')[0].payment_id, pay.id);
    sumupStatus = 'PAID';
    await call('sumup_webhook', { id: pay.sumup_checkout_id });
    assert.equal(T('listings')[0].status, 'pending_review'); assert.equal(T('payments')[0].status, 'paid');
  });
  await t.test('a payment that never completes cancels the listing; one that arrives late brings it back', async () => {
    reset();
    await make({ amount: 3 }); const l = T('listings')[0], pay = T('payments')[0];
    sumupStatus = 'EXPIRED';
    const m = await call('public_listing_manage', { token: l.token });
    assert.equal(m.body.status, 'cancelled'); assert.equal(m.body.review_note, 'Payment not completed');
    sumupStatus = 'PAID'; await call('sumup_webhook', { id: pay.sumup_checkout_id });
    assert.equal(T('listings')[0].status, 'pending_review'); assert.equal(T('listings')[0].review_note, null);
  });
  await t.test('every month has one hidden campaign, and it is never listed as a campaign or form; the books check is not confused', async () => {
    reset();
    await make({ amount: 3 }); await make({ amount: 2 });
    assert.equal(T('campaigns').length, 1);
    const lc = await call('list_campaigns', { include_inactive: true }, { session: S.saA });
    if (lc.status === 200) assert.equal((lc.body.campaigns || []).length, 0);
    sumupStatus = 'PAID'; for (const p of T('payments')) await call('sumup_webhook', { id: p.sumup_checkout_id });
    const lg = await call('ledger_check', {}, { session: S.saA });
    if (lg.status === 200) assert.deepEqual(lg.body.problems, [], JSON.stringify(lg.body.problems));
    clock.set('2026-12-02T10:00:00Z'); await make({ amount: 3 });
    assert.equal(T('campaigns').length, 2, 'a new month, a new campaign');
  });
  await t.test('refused in plain words: nothing ticked, short or long text, a phone number, an email address or a web link anywhere, bad choices, bad email, too many pictures', async () => {
    reset();
    const bad = async (over, re, status = 400) => { const r = await make(over); assert.equal(r.status, status, JSON.stringify(over).slice(0, 80) + ' ' + r.raw); if (re) assert.match(r.body.error, re); };
    await bad({ agree: false }, /tick the box/); await bad({ agree: undefined }, /tick the box/);
    await bad({ title: 'abc' }, /title is too short/); await bad({ title: 'x'.repeat(71) }, /title is too long/);
    await bad({ description: 'too short' }, /description is too short/); await bad({ description: 'x'.repeat(1201) }, /too long/);
    await bad({ description: 'Please call me on 07700 900123 about the chairs, any time after six.' }, /phone numbers, email addresses or web links in the description/);
    await bad({ description: 'Ring +44 20 8560 0000 for the chairs, they are lovely and in good order.' }, /phone numbers/);
    await bad({ description: 'Email me at mary@example.org about these lovely garden chairs please.' }, /email addresses/);
    await bad({ description: 'See more photos at www.example.org/chairs and let me know what you think.' }, /web links/);
    await bad({ description: 'See more photos at https://example.org/chairs and let me know what you think.' }, /web links/);
    await bad({ title: 'Chairs, ring 07700900123 now' }, /in the title/); await bad({ price_text: 'call 07700 900123' }, /in the price/); await bad({ display_name: 'Mary 07700900123' }, /in your name/);
    await bad({ category: 'Weapons' }, /choose a category/); await bad({ kind: 'swap' }, /for sale, free, or a service/);
    for (const d of [6, 31, 14.5, 'x', undefined]) await bad({ days: d }, /1 to 4 weeks/);
    await bad({ email: '' }, /give your email/); await bad({ email: undefined }, /give your email/); await bad({ email: 'not an email' }, /email address/);
    await bad({ images: [pic(), pic(), pic(), pic(), pic()] }, /Up to 4 pictures/);
    await bad({ images: [{ t: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]).toString('base64'), f: webp() }] }, /WebP or JPEG/);
    await bad({ images: [{ t: webp(50000), f: webp() }] }, /too large/); await bad({ images: [{ t: webp(), f: webp(160000) }] }, /too large/);
    for (const a of [undefined, '', -1, 201, 'abc', NaN]) await bad({ amount: a }, /£0 is fine/);
    assert.equal(T('listings').length, 0); assert.equal(T('payments').length, 0); assert.equal(db.uploads.length, 0);
  });
  await t.test('a plain price like £1,500 or a street number is fine, and so is a JPEG', async () => {
    reset();
    assert.equal((await make({ price_text: '£1,500 or nearest offer', description: 'A wardrobe, solid oak, from a house at 24 Witham Road. Buyer collects, can be taken apart.', images: [{ t: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500)]).toString('base64'), f: webp() }] })).status, 200);
  });
  await t.test('the title and the words are tidied; pictures are optional and so is a name', async () => {
    reset();
    const r = await make({ title: '   Garden   chairs  ', description: 'Line one of the description here.\n\n\n\nLine two of it, after a gap.   ', images: [], display_name: '', price_text: '' });
    assert.equal(r.status, 200, r.raw);
    const l = T('listings')[0]; assert.equal(l.title, 'Garden chairs'); assert.equal(l.description, 'Line one of the description here.\n\nLine two of it, after a gap.'); assert.equal(l.display_name, null); assert.equal(l.price_text, null); assert.deepEqual(l.images, []);
  });
  await t.test('a second tap with the same reference does not list twice; the spam trap stores nothing; three open listings per email at most; eight a day per connection', async () => {
    reset();
    const a = await make({ client_ref: 'same-ref-12345' }), b = await make({ client_ref: 'same-ref-12345' });
    assert.equal(a.body.token, b.body.token); assert.equal(b.body.replay, true); assert.equal(T('listings').length, 1);
    assert.equal((await make({ website: 'http://spam.example' })).status, 200); assert.equal(T('listings').length, 1);
    await make({}); await make({});
    const four = await make({}); assert.equal(four.status, 409); assert.match(four.body.error, /three listings open/);
    assert.equal((await make({ email: 'other@example.org' })).status, 200);
    reset();
    for (let i = 0; i < 8; i++) assert.equal((await make({ email: `p${i}@example.org` }, { ip: '10.9.9.9' })).status, 200);
    assert.equal((await make({ email: 'p9@example.org' }, { ip: '10.9.9.9' })).status, 429);
  });
  await t.test('closed, unknown and junk addresses are a plain 404', async () => {
    reset();
    T('listings_settings').find(s => s.org_id === 'org-A').enabled = false;
    assert.equal((await make()).status, 404); assert.equal((await list()).status, 404); assert.equal((await list('nobody-here')).status, 404); assert.equal((await list('A')).status, 404);
  });
  await t.test('if the card payment cannot be started the listing and its pictures are taken back out', async () => {
    reset();
    const keep = global.fetch;
    global.fetch = async (url, opts = {}) => (opts.method === 'POST' ? { ok: false, status: 500, json: async () => ({ message: 'down' }) } : keep(url, opts));
    const r = await make({ amount: 4, images: [pic()] });
    assert.equal(r.status, 502); assert.equal(T('listings').length, 0); assert.equal(T('payments')[0].status, 'void'); assert.equal(db.removed.length, 2);
  });
});

test('The office approves', async (t) => {
  await t.test('approval starts the days: live from now for the length chosen; a listing that is not yet paid cannot be approved', async () => {
    reset();
    const l = await goLive({ days: 14 });
    assert.equal(row(l.id).status, 'live'); assert.equal(row(l.id).starts_at, '2026-11-10T10:00:00.000Z'); assert.equal(row(l.id).ends_at, '2026-11-24T10:00:00.000Z');
    const paid = await make({ amount: 3 }); const pl = T('listings').find(x => x.token === paid.body.token);
    const r = await approve(pl.id); assert.equal(r.status, 400); assert.match(r.body.error, /not been paid/);
    assert.equal((await approve(l.id)).status, 400, 'already dealt with');
  });
  await t.test('refusing needs a reason, shows it to the lister, and a fee can be noted as refunded', async () => {
    reset();
    const r1 = await make({ amount: 4 }); const l = T('listings').find(x => x.token === r1.body.token);
    sumupStatus = 'PAID'; await call('sumup_webhook', { id: T('payments')[0].sumup_checkout_id });
    assert.equal((await call('listings_review', { id: l.id, decision: 'reject', note: '' }, { session: S.adA })).status, 400);
    const rej = await call('listings_review', { id: l.id, decision: 'reject', note: 'Not suitable for the parish noticeboard', refund_amount: 4 }, { session: S.adA });
    assert.equal(rej.status, 200, rej.raw); assert.equal(rej.body.refunded, 4);
    assert.equal(T('payments')[0].refund_amount, 4); assert.match(T('payments')[0].refund_note, /not accepted/);
    const m = await call('public_listing_manage', { token: l.token });
    assert.equal(m.body.status, 'rejected'); assert.equal(m.body.review_note, 'Not suitable for the parish noticeboard');
    assert.equal((await list()).body.listings.length, 0);
    const free = await make({}); const fl = T('listings').find(x => x.token === free.body.token);
    assert.equal((await call('listings_review', { id: fl.id, decision: 'reject', note: 'No', refund_amount: 1 }, { session: S.adA })).status, 400, 'a £0 listing has nothing to refund');
    assert.equal((await call('listings_review', { id: fl.id, decision: 'maybe' }, { session: S.adA })).status, 400);
  });
  await t.test('only the office; a seller and another parish cannot; a priest may approve but not record a refund', async () => {
    reset();
    const r = await make({}); const l = T('listings')[0];
    assert.equal((await call('listings_get', {}, { session: S.seA })).status, 403);
    assert.ok((await call('listings_get', {})).status >= 400);
    assert.equal((await call('listings_review', { id: l.id, decision: 'approve' }, { session: S.seA })).status, 403);
    assert.equal((await call('listings_review', { id: l.id, decision: 'approve' }, { session: S.saB })).status, 404);
    for (const who of ['saA', 'adA', 'fiA', 'prA']) assert.equal((await call('listings_get', {}, { session: S[who] })).status, 200, who);
    assert.equal((await approve(l.id, 'prA')).status, 200); assert.ok(r);
    const r2 = await make({ amount: 2 }); const l2 = T('listings').find(x => x.token === r2.body.token);
    sumupStatus = 'PAID'; await call('sumup_webhook', { id: T('payments')[0].sumup_checkout_id });
    assert.equal((await call('listings_review', { id: l2.id, decision: 'reject', note: 'Not suitable here', refund_amount: 2 }, { session: S.prA })).status, 403);
    assert.equal(T('listings').find(x => x.id === l2.id).status, 'pending_review');
  });
  await t.test('the office sees what is waiting (with the email, to be able to write to the lister), what is live with its numbers, and recent endings', async () => {
    reset();
    const live = await goLive({ title: 'Live listing one here' }); await make({ title: 'Waiting listing here' });
    const g = (await call('listings_get', {}, { session: S.adA })).body;
    assert.deepEqual(g.counts, { waiting: 1, live: 1, reported: 0 });
    assert.equal(g.waiting[0].title, 'Waiting listing here'); assert.equal(g.waiting[0].email, 'mary@example.org'); assert.match(g.waiting[0].images[0], /\/storage\/v1\/object\/public\/listings\/org-A\//);
    assert.equal(g.live[0].id, live.id); assert.equal(g.live[0].views, 0); assert.equal(g.live[0].days_left, 14);
    assert.ok(g.disclaimer.includes('does not check')); assert.equal(g.quotes.length, 20);
  });
  await t.test('taking a live listing down needs a reason, and it vanishes at once', async () => {
    reset();
    const l = await goLive({});
    assert.equal((await call('listings_takedown', { id: l.id, note: '' }, { session: S.adA })).status, 400);
    assert.equal((await call('listings_takedown', { id: l.id, note: 'Reported as unsuitable' }, { session: S.adA })).status, 200);
    assert.equal(row(l.id).status, 'removed'); assert.equal((await list()).body.listings.length, 0);
    assert.equal((await call('listings_takedown', { id: l.id, note: 'again' }, { session: S.adA })).status, 400);
  });
});

test('What the public sees, and the email address', async (t) => {
  await t.test('only live, unexpired listings of this parish; the email address is nowhere in anything sent to a visitor', async () => {
    reset();
    const mine = await goLive({ title: 'Mine is live here', email: 'secretlister@example.org' });
    await make({ title: 'Mine is waiting here' });
    T('listings').push({ id: 'b-l', org_id: 'org-B', token: 'b'.repeat(32), title: 'B parish listing here', description: 'x'.repeat(30), category: 'Other', kind: 'sell', email: 'b@example.org', days: 7, status: 'live', images: [], starts_at: '2026-11-09T00:00:00.000Z', ends_at: '2026-11-30T00:00:00.000Z', views: 0, contacts: 0, reports: 0, featured: false, created_at: '2026-11-09T00:00:00.000Z' });
    const r = await list();
    assert.deepEqual(r.body.listings.map(l => l.title), ['Mine is live here']);
    assert.equal(r.raw.includes('secretlister'), false); assert.equal(r.raw.includes('@'), false); assert.equal(r.raw.includes('b@example'), false); assert.equal(r.raw.includes('token'), false);
    const d = await call('public_listing_view', { slug: 'svp-osterley', id: mine.id });
    assert.equal(d.status, 200); assert.equal(d.raw.includes('secretlister'), false); assert.equal(d.body.description.startsWith('Four sturdy'), true); assert.ok(d.body.disclaimer);
    assert.equal(d.body.ends_label, '24 November');
    assert.equal((await call('public_listing_view', { slug: 'svp-osterley', id: 'b-l' })).status, 404);
    assert.equal((await call('public_listing_view', { slug: 'other-parish', id: mine.id })).status, 404);
    assert.equal((await call('public_listing_view', { slug: 'svp-osterley', id: 'nonsense' })).status, 404);
    assert.equal(r.body.disclaimer.includes('does not check'), true); assert.match(r.body.agreement, /not put a phone number or email/);
  });
  await t.test('"Copy email address": the address is handed over only on that call, counted once a day per visitor, and limited per visitor', async () => {
    reset();
    const l = await goLive({ email: 'secretlister@example.org' });
    const c1 = await call('public_listing_contact', { slug: 'svp-osterley', id: l.id }, { ip: '10.1.1.1' });
    assert.equal(c1.status, 200); assert.equal(c1.body.email, 'secretlister@example.org'); assert.match(c1.body.subject, /Garden chairs/);
    await call('public_listing_contact', { slug: 'svp-osterley', id: l.id }, { ip: '10.1.1.1' });
    assert.equal(row(l.id).contacts, 1, 'the same visitor the same day counts once');
    await call('public_listing_contact', { slug: 'svp-osterley', id: l.id }, { ip: '10.1.1.2' });
    assert.equal(row(l.id).contacts, 2);
    clock.set('2026-11-11T10:00:00Z');
    await call('public_listing_contact', { slug: 'svp-osterley', id: l.id }, { ip: '10.1.1.1' });
    assert.equal(row(l.id).contacts, 3, 'the next day counts again');
    for (let i = 0; i < 40; i++) await call('public_listing_contact', { slug: 'svp-osterley', id: l.id }, { ip: '10.7.7.7' });
    assert.equal((await call('public_listing_contact', { slug: 'svp-osterley', id: l.id }, { ip: '10.7.7.7' })).status, 429);
    T('listings').find(x => x.id === l.id).status = 'removed';
    assert.equal((await call('public_listing_contact', { slug: 'svp-osterley', id: l.id }, { ip: '10.1.1.9' })).status, 404, 'a taken-down listing gives nobody its address');
  });
  await t.test('views are counted once a day per visitor, and the stored visitor is never an IP address', async () => {
    reset();
    const l = await goLive({});
    for (const ip of ['10.2.2.2', '10.2.2.2', '10.2.2.3']) await call('public_listing_view', { slug: 'svp-osterley', id: l.id }, { ip });
    assert.equal(row(l.id).views, 2);
    assert.ok(T('listing_events').every(e => !/10\.2\.2\./.test(e.ip_hash)), 'a scrambled value, not the address');
  });
  await t.test('a report is counted once a day per visitor, the reason is kept for the office, and the office can dismiss it', async () => {
    reset();
    const l = await goLive({});
    assert.equal((await call('public_listing_report', { slug: 'svp-osterley', id: l.id, reason: 'x' }, { ip: '10.3.3.3' })).status, 400);
    assert.equal((await call('public_listing_report', { slug: 'svp-osterley', id: l.id, reason: 'This looks like a scam to me' }, { ip: '10.3.3.3' })).status, 200);
    await call('public_listing_report', { slug: 'svp-osterley', id: l.id, reason: 'Same person again' }, { ip: '10.3.3.3' });
    assert.equal(row(l.id).reports, 1); assert.equal(T('listing_reports').length, 1);
    const g = (await call('listings_get', {}, { session: S.adA })).body;
    assert.equal(g.counts.reported, 1); assert.deepEqual(g.live[0].reasons, ['This looks like a scam to me']);
    await call('listings_dismiss_reports', { id: l.id }, { session: S.adA });
    assert.equal(row(l.id).reports, 0); assert.equal(T('listing_reports').length, 0);
  });
});

test('Ending, and what is shown first', async (t) => {
  await t.test('a listing ends by itself when its days are up, and is cleared out two weeks later (email, text and pictures)', async () => {
    reset();
    const l = await goLive({ days: 7, images: [pic()] });
    clock.set('2026-11-16T10:00:00Z'); assert.equal((await list()).body.listings.length, 1);
    clock.set('2026-11-17T10:00:01Z');
    assert.equal((await list()).body.listings.length, 0); assert.equal((await call('public_listing_view', { slug: 'svp-osterley', id: l.id })).status, 404);
    assert.equal(row(l.id).status, 'expired'); assert.equal(row(l.id).email, 'mary@example.org', 'not yet cleared');
    clock.set('2026-12-02T10:00:00Z'); await list(); clock.set('2026-12-02T11:00:00Z'); await list();
    assert.equal(row(l.id).email, null); assert.equal(row(l.id).description, ''); assert.deepEqual(row(l.id).images, []); assert.ok(row(l.id).purged_at);
    assert.equal(db.removed.length, 2); assert.equal(row(l.id).title, 'Garden chairs, set of four', 'the title stays for the office\'s history');
  });
  await t.test('the lister\'s own page shows where it stands, how it has done, and never the email; they can withdraw it', async () => {
    reset();
    const r = await make({}); const l = T('listings')[0];
    let m = (await call('public_listing_manage', { token: r.body.token })).body;
    assert.equal(m.status, 'pending_review'); assert.equal(m.can_withdraw, true); assert.equal(m.title, 'Garden chairs, set of four');
    await approve(l.id); await call('public_listing_view', { slug: 'svp-osterley', id: l.id }, { ip: '10.4.4.4' }); await call('public_listing_contact', { slug: 'svp-osterley', id: l.id }, { ip: '10.4.4.4' });
    const raw = await call('public_listing_manage', { token: r.body.token }); m = raw.body;
    assert.equal(m.status, 'live'); assert.equal(m.views, 1); assert.equal(m.contacts, 1); assert.equal(m.days_left, 14); assert.equal(m.ends, '24 November'); assert.equal(raw.raw.includes('mary@example.org'), false);
    assert.equal((await call('public_listing_withdraw', { token: r.body.token })).status, 200);
    assert.equal(row(l.id).status, 'withdrawn'); assert.equal((await list()).body.listings.length, 0);
    assert.equal((await call('public_listing_withdraw', { token: r.body.token })).status, 400);
    assert.equal((await call('public_listing_manage', { token: 'nope' })).status, 404); assert.equal((await call('public_listing_manage', { token: 'f'.repeat(32) })).status, 404);
  });
  await t.test('new listings, the office\'s picks, and the most viewed and asked about come first; shelves appear only with something to show', async () => {
    reset('2026-11-01T10:00:00Z');
    const old = await goLive({ title: 'An older listing here' });
    clock.set('2026-11-09T10:00:00Z');
    const fresh = await goLive({ title: 'A fresh listing here' });
    const pop = await goLive({ title: 'A popular listing here' });
    for (let i = 0; i < 6; i++) await call('public_listing_view', { slug: 'svp-osterley', id: pop.id }, { ip: '10.5.5.' + i });
    for (let i = 0; i < 3; i++) await call('public_listing_view', { slug: 'svp-osterley', id: old.id }, { ip: '10.6.6.' + i });
    for (let i = 0; i < 3; i++) await call('public_listing_contact', { slug: 'svp-osterley', id: pop.id }, { ip: '10.5.5.' + i });
    clock.set('2026-11-10T10:00:00Z');
    let r = (await list()).body;
    assert.deepEqual(r.listings.map(l => l.title), ['A popular listing here', 'A fresh listing here', 'An older listing here']);
    assert.deepEqual(r.shelves.find(s => s.key === 'new').ids.slice().sort(), [fresh.id, pop.id].sort());   // the two added this week (not the older one)
    assert.equal(r.shelves.find(s => s.key === 'viewed').ids[0], pop.id); assert.equal(r.shelves.some(s => s.key === 'contacted'), false, 'only one is asked about: that is not a shelf');
  });
  await t.test('(one listing asked about is not a shelf; two are)', async () => {
    reset();
    const a = await goLive({ title: 'First popular one here' }), b = await goLive({ title: 'Second popular one' });
    await call('public_listing_contact', { slug: 'svp-osterley', id: a.id }, { ip: '10.8.8.1' });
    assert.equal((await list()).body.shelves.some(s => s.key === 'contacted'), false);
    await call('public_listing_contact', { slug: 'svp-osterley', id: b.id }, { ip: '10.8.8.1' });
    assert.equal((await list()).body.shelves.some(s => s.key === 'contacted'), true);
  });
  await t.test('what is paid does not buy a place: a £0 listing ranks like a £10 one; only the office can pick one', async () => {
    reset();
    const free = await goLive({ title: 'A free listing here', amount: 0 });
    const r = await make({ title: 'A paid listing here', amount: 10 }); const pl = T('listings').find(x => x.token === r.body.token);
    sumupStatus = 'PAID'; await call('sumup_webhook', { id: T('payments')[0].sumup_checkout_id }); await approve(pl.id);
    let order = (await list()).body.listings.map(l => l.title);
    assert.equal(order.length, 2);
    row(free.id).starts_at = row(pl.id).starts_at;   // the same age: nothing separates them but their numbers
    assert.equal((await list()).body.listings.length, 2);
    assert.equal((await call('listings_set_featured', { id: free.id, featured: true }, { session: S.adA })).status, 200);
    order = (await list()).body.listings.map(l => l.title); assert.equal(order[0], 'A free listing here');
    assert.equal((await list()).body.shelves[0].key, 'picks');
    assert.equal((await call('listings_set_featured', { id: free.id, featured: true }, { session: S.seA })).status, 403);
  });
  await t.test('the window is small and cached for half a minute; the card has what a card needs and no more', async () => {
    reset();
    for (let i = 0; i < 6; i++) await goLive({ title: 'A listing number ' + i + ' here', email: `x${i}@example.org` });
    const r = await list();
    assert.match(r.headers['Cache-Control'], /max-age=30/);
    assert.ok(r.raw.length < 20000, 'the window is ' + r.raw.length + ' bytes');
    assert.deepEqual(Object.keys(r.body.listings[0]).sort(), ['category', 'days_left', 'id', 'is_new', 'kind', 'name', 'pick', 'pictures', 'price', 'snippet', 'thumb', 'title']);
  });
});

test('The rest of the app is not disturbed', async (t) => {
  await t.test('the parish page gets a Listings shortcut only while Listings is open', async () => {
    reset();
    assert.deepEqual((await call('public_gateway', { slug: 'svp-osterley' })).body.listings, { path: '/listings/svp-osterley' });
    T('listings_settings').find(s => s.org_id === 'org-A').enabled = false;
    assert.equal((await call('public_gateway', { slug: 'svp-osterley' })).body.listings, null);
  });
  await t.test('opening needs the parish page to have an address; the welcome line is kept; other parishes untouched', async () => {
    reset();
    T('organizations').find(o => o.id === 'org-A').slug = null;
    assert.equal((await call('listings_set_settings', { enabled: true }, { session: S.adA })).status, 400);
    T('organizations').find(o => o.id === 'org-A').slug = 'svp-osterley';
    assert.equal((await call('listings_set_settings', { enabled: false, intro_text: 'Hello neighbours' }, { session: S.adA })).status, 200);
    assert.equal(T('listings_settings').find(s => s.org_id === 'org-A').intro_text, 'Hello neighbours'); assert.equal(T('listings_settings').find(s => s.org_id === 'org-A').enabled, false);
    assert.equal(T('listings_settings').find(s => s.org_id === 'org-B').enabled, true);
  });
  await t.test('the migration only adds: no drops, deletes or renames; row security and grants on every table; the function is for the server alone', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20261110000000_listings.sql'), 'utf8');
    const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    assert.ok(!/\bdrop\s+(table|column|function|index|constraint)\b|\bdelete\s+from\b|\btruncate\b|\brename\b/i.test(code));
    for (const tbl of ['listings_settings', 'listings', 'listing_events', 'listing_reports', 'listing_months']) assert.match(code, new RegExp(`alter table ${tbl} enable row level security`));
    assert.match(code, /grant select, insert, update, delete on table listings_settings, listings[^;]*to service_role/);
    assert.match(code, /revoke all on function public\.listing_event[^;]*from public, anon, authenticated/); assert.match(code, /grant execute on function public\.listing_event[^;]*to service_role/);
    assert.match(code, /'listings', 'listings', true, 153600, array\['image\/webp', 'image\/jpeg'\]/);
  });
});
