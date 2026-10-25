// Parish Gateway — the server-side acceptance checks from section 11 of docs/parish-gateway-spec-v1.1.md.
// Run with:  node --test test/gateway/        (no network, nothing to install: the database is an in-memory stand-in)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const { db, clock, call, addUser } = require('./harness');

const day = (iso, n) => { const x = new Date(iso + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const TODAY = '2026-11-02';
let S = {};   // sessions by name
const reset = () => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set(TODAY + 'T12:00:00Z');
  const org = (o) => db.T('organizations').push({ gateway_enabled: false, timezone: 'Europe/London', display_name: null, gateway_phone: null, gateway_hours: null, address: null, contact_email: null, ...o });
  org({ id: 'org-A', name: 'St.Vincent De Paul Church, Osterley', slug: 'svp-osterley', gateway_enabled: true, address: '2 Witham Road, Osterley', contact_email: 'osterley@rcdow.org', gateway_phone: '020 8560 0000', gateway_hours: 'Tue to Fri, 10am to 1pm' });
  org({ id: 'org-B', name: 'Other Parish', slug: 'other-parish', gateway_enabled: true });
  org({ id: 'org-C', name: 'Auckland Parish', slug: 'auckland', gateway_enabled: true, timezone: 'Pacific/Auckland' });
  org({ id: 'org-D', name: 'Switched Off Parish', slug: 'switched-off', gateway_enabled: false });
  S = {
    saA: addUser('uA-sa', 'superadmin', 'org-A'), adA: addUser('uA-ad', 'admin', 'org-A'), fiA: addUser('uA-fi', 'finance', 'org-A'),
    prA: addUser('uA-pr', 'priest', 'org-A'), seA: addUser('uA-se', 'seller', 'org-A'),
    saB: addUser('uB-sa', 'superadmin', 'org-B'), saC: addUser('uC-sa', 'superadmin', 'org-C'),
  };
  const camp = (id, org_id, kind, extra) => db.T('campaigns').push({ id, org_id, name: id, kind, active: true, binned: false, is_draft: false, public_page_enabled: true, opens_on: day(TODAY, -5), closes_on: day(TODAY, 10), places: null, waiting_list: false, listed_on_gateway: true, gateway_cta: null, ...extra });
  const block = (id, campaign_id, type) => db.T('ticket_blocks').push({ id, campaign_id, type });
  const tickets = (campaign_id, block_id, unsold, paid) => { for (let i = 0; i < unsold + paid; i++) db.T('tickets').push({ id: `${campaign_id}-t${i}`, campaign_id, block_id, status: i < unsold ? 'unsold' : 'paid' }); };
  camp('Autumn Raffle', 'org-A', 'raffle', { closes_on: day(TODAY, 9) });          block('b1', 'Autumn Raffle', 'digital'); tickets('Autumn Raffle', 'b1', 10, 40);
  camp('Walsingham', 'org-A', 'event', { closes_on: day(TODAY, 21) });              block('b2', 'Walsingham', 'digital'); tickets('Walsingham', 'b2', 3, 2);
  camp('First Holy Communion', 'org-A', 'registration', { places: 40, closes_on: day(TODAY, 28) });
  camp('Youth Group', 'org-A', 'registration', { places: 30, waiting_list: true, closes_on: day(TODAY, 40) });
  for (let i = 0; i < 32; i++) db.T('registrations').push({ id: `r-fhc-${i}`, campaign_id: 'First Holy Communion', status: 'submitted', name: 'Secret Child Name', email: 'secret.parent@example.org' });
  for (let i = 0; i < 30; i++) db.T('registrations').push({ id: `r-yg-${i}`, campaign_id: 'Youth Group', status: 'accepted', name: 'Secret Teen Name' });
  db.T('registrations').push({ id: 'r-yg-x', campaign_id: 'Youth Group', status: 'cancelled', name: 'Cancelled Person' });
  db.T('waiting_list').push({ id: 'w1', campaign_id: 'Youth Group', email: 'waiter@example.org' });
  db.T('payments').push({ id: 'p1', campaign_id: 'Autumn Raffle', payer_name: 'Sold To Someone', contact_value: '07700900123' });
  // listed, but they must NOT appear on the page
  camp('Physical Raffle', 'org-A', 'raffle');                                       block('b3', 'Physical Raffle', 'physical'); tickets('Physical Raffle', 'b3', 5, 0);
  camp('Draft Reg', 'org-A', 'registration', { is_draft: true });
  camp('Binned Reg', 'org-A', 'registration', { binned: true });
  camp('Paused Reg', 'org-A', 'registration', { active: false });
  camp('Page Off Reg', 'org-A', 'registration', { public_page_enabled: false });
  camp('Closed Reg', 'org-A', 'registration', { opens_on: day(TODAY, -30), closes_on: day(TODAY, -1) });
  camp('Future Reg', 'org-A', 'registration', { opens_on: day(TODAY, 1), closes_on: day(TODAY, 30) });
  camp('Unlisted Reg', 'org-A', 'registration', { listed_on_gateway: false });
  camp('Closes Today Reg', 'org-A', 'registration', { closes_on: TODAY });
  // another organisation
  camp('B Secret Registration', 'org-B', 'registration');
  db.T('gateway_items').push({ id: 'b-item', org_id: 'org-B', section: 'involved', label: 'B Secret Item', url: 'https://b.example.org', cta: null, starts_on: day(TODAY, -1), ends_on: day(TODAY, 5), listed: true });
  db.T('gateway_links').push({ id: 'b-link', org_id: 'org-B', position: 1, label: 'B Secret Link', sub: '', url: 'https://b.example.org/x' });
  db.T('gateway_announcements').push({ id: 'b-ann', org_id: 'org-B', message: 'B Secret Notice', link_url: null, urgent: false, starts_at: '2026-11-01T00:00:00.000Z', ends_at: null, created_at: '2026-11-01T00:00:00.000Z' });
  // an organisation with its own calendar
  camp('Auckland Closes', 'org-C', 'registration', { opens_on: day(TODAY, -5), closes_on: TODAY });
  camp('Auckland Opens', 'org-C', 'registration', { opens_on: day(TODAY, 1), closes_on: day(TODAY, 20) });
};
const pub = (slug, opts) => call('public_gateway', { slug }, opts);
const names = (r, sec) => r.body.sections[sec].map(i => i.name);

// =====================================================================================================
test('Safety for existing parishes', async (t) => {
  await t.test('a switched-off page, an unknown address and a junk address are all a plain 404', async () => {
    reset();
    for (const slug of ['switched-off', 'no-such-page', '../etc', '', undefined, 42, 'A', 'x'.repeat(80)]) {
      const r = await pub(slug);
      assert.equal(r.status, 404, String(slug));
      assert.equal(r.body.error, 'This page is not available.');
    }
  });
  await t.test('the page is off by default: nothing is public until gateway_enabled is true, and switching it off takes it down at once', async () => {
    reset();
    assert.equal((await pub('svp-osterley')).status, 200);
    assert.equal((await call('gateway_set_enabled', { enabled: false }, { session: S.saA })).status, 200);
    assert.equal((await pub('svp-osterley')).status, 404);
    assert.equal((await call('gateway_set_enabled', { enabled: true }, { session: S.saA })).status, 200);
    assert.equal((await pub('svp-osterley')).status, 200);
  });
  await t.test('existing public look-ups still answer exactly as before', async () => {
    reset();
    const r = await call('public_campaign_info', {});
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'This campaign is not available for purchase right now.');
    assert.equal((await call('no_such_action', {})).status, 404);
  });
  await t.test('the migration only adds: every statement is create-if-not-exists, add-column-if-not-exists or an idempotent update, and it never drops, renames or deletes', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20261023000000_gateway.sql'), 'utf8').replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /\b(drop|truncate|rename|delete\s+from)\b/i);
    for (const m of sql.matchAll(/create\s+(table|unique index|index)\s+(?!if not exists)/gi)) assert.fail('not idempotent: ' + m[0]);
    for (const m of sql.matchAll(/add\s+column\s+(?!if not exists)/gi)) assert.fail('not idempotent: ' + m[0]);
    const cols = [...sql.matchAll(/add column if not exists (\w+) ([^,;]*)/gi)];
    assert.equal(cols.length, 8);   // 6 on organizations, 2 on campaigns
    for (const c of cols) assert.doesNotMatch(c[2], /not null(?!\s+default)/i, `${c[1]} must be nullable or have a default`);
  });
  await t.test('the shared service worker and theme are untouched (skipped when git or origin/main is unavailable)', (ctx) => {
    let out;
    try { out = execFileSync('git', ['diff', '--numstat', 'origin/main', '--', 'public/sw.js', 'public/theme.css'], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' }); } catch { return ctx.skip('git not available'); }
    assert.equal(out.trim(), '', 'public/sw.js and public/theme.css must not change');
  });
});

// =====================================================================================================
test('Tenant isolation', async (t) => {
  await t.test("organisation A's page never contains anything of B, and B's never contains A's", async () => {
    reset();
    const a = await pub('svp-osterley'), b = await pub('other-parish');
    for (const s of ['Other Parish', 'B Secret', 'b.example.org', 'org-B']) assert.ok(!a.raw.includes(s), 'A leaks ' + s);
    for (const s of ['St.Vincent', 'Autumn Raffle', 'Walsingham', 'Youth Group', 'osterley@rcdow.org', 'org-A']) assert.ok(!b.raw.includes(s), 'B leaks ' + s);
    assert.deepEqual(b.body.links, [{ label: 'B Secret Link', sub: '', url: 'https://b.example.org/x' }]);
  });
  await t.test("A's admin cannot read B's links, notices, items, order or campaigns through the admin screen", async () => {
    reset();
    const r = await call('gateway_get', {}, { session: S.adA });
    assert.equal(r.status, 200);
    for (const s of ['B Secret', 'org-B', 'other-parish', 'Other Parish']) assert.ok(!r.raw.includes(s), 'gateway_get leaks ' + s);
  });
  await t.test("A's admin cannot change B's items, order, campaigns or page", async () => {
    reset();
    let r = await call('gateway_item_delete', { id: 'b-item' }, { session: S.adA }); assert.equal(r.status, 404);
    r = await call('gateway_item_save', { id: 'b-item', section: 'involved', label: 'Hacked', url: 'https://x.example.org', starts_on: TODAY, ends_on: TODAY }, { session: S.adA }); assert.equal(r.status, 404);
    r = await call('gateway_item_set_listed', { id: 'b-item', listed: false }, { session: S.adA }); assert.equal(r.status, 404);
    r = await call('campaign_set_listed', { campaign_id: 'B Secret Registration', listed: false }, { session: S.adA }); assert.equal(r.status, 404);
    r = await call('gateway_set_order', { section: 'involved', ids: ['b-item', 'Autumn Raffle'] }, { session: S.adA }); assert.equal(r.status, 400);
    assert.equal(db.T('gateway_items').find(i => i.id === 'b-item').label, 'B Secret Item');
    assert.equal(db.T('campaigns').find(c => c.id === 'B Secret Registration').listed_on_gateway, true);
    assert.equal(db.T('gateway_order').length, 0);
    // saving links, a notice or details only ever touches the caller's own organisation
    await call('gateway_save_links', { links: [{ position: 1, label: 'A link', sub: '', url: 'https://a.example.org' }] }, { session: S.adA });
    await call('gateway_save_announcement', { message: 'A notice' }, { session: S.adA });
    await call('gateway_set_details', { phone: '1', hours: '2' }, { session: S.adA });
    assert.deepEqual(db.T('gateway_links').filter(l => l.org_id === 'org-B').map(l => l.label), ['B Secret Link']);
    assert.deepEqual(db.T('gateway_announcements').filter(a => a.org_id === 'org-B').map(a => a.message), ['B Secret Notice']);
    assert.equal(db.T('organizations').find(o => o.id === 'org-B').gateway_phone, null);
  });
  await t.test('an organisation id sent by the browser is ignored: the organisation always comes from the login', async () => {
    reset();
    await call('gateway_save_announcement', { message: 'Sneaky', org_id: 'org-B' }, { session: S.adA });
    await call('gateway_set_address', { slug: 'sneaky-slug', org_id: 'org-B', confirm: true }, { session: S.saA });
    assert.equal(db.T('gateway_announcements').filter(a => a.org_id === 'org-B').length, 1);
    assert.equal(db.T('organizations').find(o => o.id === 'org-B').slug, 'other-parish');
  });
  await t.test('the public page never carries an organisation id, a person, a payment, a ticket, a registration or any raffle figure', async () => {
    reset();
    const r = await pub('svp-osterley');
    assert.equal(r.status, 200);
    for (const s of ['org-A', 'org_id', 'Secret Child', 'Secret Teen', 'Cancelled Person', 'secret.parent', 'waiter@example.org', 'Sold To Someone', '07700900123', 'uA-sa', 'payer', 'password']) assert.ok(!r.raw.includes(s), 'public response contains ' + s);
    assert.deepEqual(Object.keys(r.body).sort(), ['announcement', 'links', 'org', 'sections']);
    assert.deepEqual(Object.keys(r.body.org).sort(), ['address', 'contact_email', 'hours', 'name', 'phone', 'timezone']);
    const raffle = r.body.sections.involved.find(i => i.name === 'Autumn Raffle');
    assert.equal(raffle.places_left, null); assert.equal(raffle.places_total, null); assert.equal(raffle.full, false); assert.equal(raffle.waiting_list, false);
    for (const item of [...r.body.sections.involved, ...r.body.sections.registration]) assert.deepEqual(Object.keys(item).sort(), ['closes_on', 'cta', 'full', 'href', 'id', 'name', 'opens_on', 'places_left', 'places_total', 'source', 'waiting_list']);
  });
});

// =====================================================================================================
test('What is listed, and when', async (t) => {
  await t.test('only listed, active, live, open campaigns with a working public page appear', async () => {
    reset();
    const r = await pub('svp-osterley');
    assert.deepEqual(names(r, 'involved'), ['Autumn Raffle', 'Walsingham']);
    assert.deepEqual(names(r, 'registration'), ['Closes Today Reg', 'First Holy Communion', 'Youth Group']);
    const all = r.raw;
    for (const hidden of ['Physical Raffle', 'Draft Reg', 'Binned Reg', 'Paused Reg', 'Page Off Reg', 'Closed Reg', 'Future Reg', 'Unlisted Reg']) assert.ok(!all.includes(hidden), hidden + ' should not be listed');
  });
  await t.test('nothing is listed by default: a campaign must be switched on first', async () => {
    reset();
    for (const c of db.T('campaigns')) c.listed_on_gateway = false;
    const r = await pub('svp-osterley');
    assert.deepEqual(r.body.sections, { involved: [], registration: [] });
  });
  await t.test('links go to the existing public pages', async () => {
    reset();
    const r = await pub('svp-osterley');
    assert.equal(r.body.sections.involved[0].href, '/buy.html?campaign_id=Autumn Raffle');
    assert.equal(r.body.sections.registration.find(i => i.name === 'First Holy Communion').href, '/register.html?campaign_id=First Holy Communion');
  });
  await t.test('a campaign disappears the day after it closes (organisation calendar, not the server\'s)', async () => {
    reset();
    clock.set(TODAY + 'T23:59:00Z'); assert.ok(names(await pub('svp-osterley'), 'registration').includes('Closes Today Reg'));
    clock.set(day(TODAY, 1) + 'T00:00:00Z'); assert.ok(!names(await pub('svp-osterley'), 'registration').includes('Closes Today Reg'));
    clock.set(day(TODAY, 1) + 'T00:00:00Z');
    reset(); clock.set(day(TODAY, 1) + 'T00:00:00Z');   // and it appears on its opening day
    const camp = db.T('campaigns').find(c => c.id === 'Future Reg');
    assert.ok(names(await pub('svp-osterley'), 'registration').includes('Future Reg'), 'opens_on ' + camp.opens_on);
  });
  await t.test('an organisation in another time zone uses its own date', async () => {
    reset();   // 12:00 UTC on 2 Nov is already 3 Nov in Auckland
    const r = await pub('auckland');
    assert.deepEqual(names(r, 'registration'), ['Auckland Opens'], 'Auckland: the one closing on the 2nd has closed, the one opening on the 3rd is open');
    assert.equal(r.body.org.timezone, 'Pacific/Auckland');
  });
  await t.test('places left, Full, and Join waiting list', async () => {
    reset();
    let r = await pub('svp-osterley');
    const walsingham = r.body.sections.involved.find(i => i.name === 'Walsingham');
    assert.equal(walsingham.places_left, 3); assert.equal(walsingham.places_total, 5); assert.equal(walsingham.full, false);
    assert.equal(r.body.sections.registration.find(i => i.name === 'First Holy Communion').places_left, 8);
    const youth = r.body.sections.registration.find(i => i.name === 'Youth Group');
    assert.equal(youth.places_left, 0); assert.equal(youth.full, true); assert.equal(youth.waiting_list, true);
    for (const tk of db.T('tickets').filter(x => x.campaign_id === 'Walsingham')) tk.status = 'paid';
    r = await pub('svp-osterley');
    const w2 = r.body.sections.involved.find(i => i.name === 'Walsingham');
    assert.equal(w2.full, true); assert.equal(w2.waiting_list, false);   // full with no waiting list: the button just says Full
    // a place frees up, but people are queuing: nobody jumps the queue
    db.T('registrations').find(x => x.id === 'r-yg-0').status = 'cancelled';
    r = await pub('svp-osterley');
    assert.equal(r.body.sections.registration.find(i => i.name === 'Youth Group').full, true);
    db.tables.waiting_list.length = 0;
    r = await pub('svp-osterley');
    assert.equal(r.body.sections.registration.find(i => i.name === 'Youth Group').full, false);
  });
  await t.test('organisation details come from the organisation record', async () => {
    reset();
    const r = await pub('svp-osterley');
    assert.deepEqual(r.body.org, { name: 'St.Vincent De Paul Church, Osterley', address: '2 Witham Road, Osterley', contact_email: 'osterley@rcdow.org', timezone: 'Europe/London', phone: '020 8560 0000', hours: 'Tue to Fri, 10am to 1pm' });
    await call('gateway_set_address', { display_name: "St Vincent's, Osterley" }, { session: S.saA });
    assert.equal((await pub('svp-osterley')).body.org.name, "St Vincent's, Osterley");
  });
  await t.test('the response says it may be reused for a minute (and an error does not)', async () => {
    reset();
    assert.equal((await pub('svp-osterley')).headers['Cache-Control'], 'public, max-age=60, stale-while-revalidate=300');
    assert.equal((await pub('nope')).headers['Cache-Control'], undefined);
    assert.equal(Object.keys((await pub('svp-osterley')).headers).some(h => /cookie/i.test(h)), false);
  });
});

// =====================================================================================================
test('Items added by hand', async (t) => {
  const item = (extra) => ({ section: 'involved', label: 'Coffee Morning', url: 'https://example.org/coffee', cta: '', starts_on: day(TODAY, 1), ends_on: day(TODAY, 5), ...extra });
  await t.test('appears from its start date and disappears after its end date', async () => {
    reset();
    assert.equal((await call('gateway_item_save', item(), { session: S.adA })).status, 200);
    assert.ok(!names(await pub('svp-osterley'), 'involved').includes('Coffee Morning'), 'not before its start');
    clock.set(day(TODAY, 1) + 'T09:00:00Z'); assert.ok(names(await pub('svp-osterley'), 'involved').includes('Coffee Morning'));
    clock.set(day(TODAY, 5) + 'T23:00:00Z'); assert.ok(names(await pub('svp-osterley'), 'involved').includes('Coffee Morning'), 'still there on its last day');
    clock.set(day(TODAY, 6) + 'T00:30:00Z'); assert.ok(!names(await pub('svp-osterley'), 'involved').includes('Coffee Morning'), 'gone the day after');
  });
  await t.test('saving without an end date fails, as does an end before the start, a missing name or a missing address', async () => {
    reset();
    for (const bad of [item({ ends_on: '' }), item({ ends_on: undefined }), item({ ends_on: day(TODAY, 0) }), item({ label: '  ' }), item({ url: '' }), item({ section: 'other' }), item({ starts_on: '2026-13-45' }), item({ label: 'x'.repeat(61) }), item({ cta: 'x'.repeat(25) })]) {
      const r = await call('gateway_item_save', bad, { session: S.adA });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(db.T('gateway_items').filter(i => i.org_id === 'org-A').length, 0);
  });
  await t.test('edit, switch off, and remove', async () => {
    reset();
    const id = (await call('gateway_item_save', item({ starts_on: TODAY }), { session: S.adA })).body.id;
    assert.ok(names(await pub('svp-osterley'), 'involved').includes('Coffee Morning'));
    await call('gateway_item_save', item({ id, label: 'Tea Morning', starts_on: TODAY }), { session: S.adA });
    assert.ok(names(await pub('svp-osterley'), 'involved').includes('Tea Morning'));
    await call('gateway_item_set_listed', { id, listed: false }, { session: S.adA });
    assert.ok(!names(await pub('svp-osterley'), 'involved').includes('Tea Morning'));
    await call('gateway_item_set_listed', { id, listed: true }, { session: S.adA });
    await call('gateway_item_delete', { id }, { session: S.adA });
    assert.ok(!(await pub('svp-osterley')).raw.includes('Tea Morning'));
  });
  await t.test('a manual item can sit in either section', async () => {
    reset();
    await call('gateway_item_save', item({ section: 'registration', label: 'Altar Servers', starts_on: TODAY }), { session: S.adA });
    assert.ok(names(await pub('svp-osterley'), 'registration').includes('Altar Servers'));
  });
});

// =====================================================================================================
test('The notice', async (t) => {
  const send = (extra, who) => call('gateway_save_announcement', { message: 'The parish office is closed on Friday.', ...extra }, { session: who || S.adA });
  const shown = async (slug = 'svp-osterley') => (await pub(slug)).body.announcement;
  await t.test('appears at its start time and disappears at its end time, with nobody saving anything', async () => {
    reset();
    assert.equal((await send({ starts_at: '2026-11-03T09:00', ends_at: '2026-11-03T17:00' })).status, 200);   // November: London is on GMT
    assert.equal(await shown(), null);
    clock.set('2026-11-03T08:59:59Z'); assert.equal(await shown(), null);
    clock.set('2026-11-03T09:00:00Z'); assert.equal((await shown()).message, 'The parish office is closed on Friday.');
    clock.set('2026-11-03T16:59:59Z'); assert.ok(await shown());
    clock.set('2026-11-03T17:00:00Z'); assert.equal(await shown(), null);
  });
  await t.test('times are read in the organisation\'s own zone (summer time, and another country)', async () => {
    reset(); clock.set('2026-06-01T12:00:00Z');
    await send({ starts_at: '2026-07-01T09:00', ends_at: '2026-07-01T18:00' });
    const row = db.T('gateway_announcements').find(a => a.org_id === 'org-A' && a.message.startsWith('The parish'));
    assert.equal(row.starts_at, '2026-07-01T08:00:00.000Z', 'BST is one hour ahead of UTC');
    const g = await call('gateway_get', {}, { session: S.adA });
    assert.equal(g.body.announcement.starts_at, '2026-07-01T09:00'); assert.equal(g.body.announcement.state, 'scheduled');
    await call('gateway_save_announcement', { message: 'Kia ora', starts_at: '2026-11-03T09:00' }, { session: S.saC });
    assert.equal(db.T('gateway_announcements').find(a => a.message === 'Kia ora').starts_at, '2026-11-02T20:00:00.000Z', 'Auckland is 13 hours ahead in November');
  });
  await t.test('an urgent notice says so, so the page can put its message in the bar', async () => {
    reset();
    await send({ urgent: true, message: 'Mass is cancelled this evening.' });
    const a = await shown(); assert.equal(a.urgent, true); assert.equal(a.message, 'Mass is cancelled this evening.');
  });
  await t.test('overlapping notices: the newest wins', async () => {
    reset();
    await send({ message: 'First notice' }); await send({ message: 'Second notice' });
    assert.equal((await shown()).message, 'Second notice');
    await send({ message: 'Third notice, not started yet', starts_at: '2026-11-05T09:00' });
    assert.equal((await shown()).message, 'Second notice', 'a notice that has not started does not win');
  });
  await t.test('an end before the start is refused, and so is an end already in the past, a bad date, text that is too long or an unsafe link', async () => {
    reset();
    for (const bad of [{ starts_at: '2026-11-03T10:00', ends_at: '2026-11-03T09:00' }, { starts_at: '2026-11-03T10:00', ends_at: '2026-11-03T10:00' }, { ends_at: '2026-11-01T10:00' }, { starts_at: 'tomorrow' }, { starts_at: '2026-13-01T10:00' }, { message: 'x'.repeat(201) }, { message: '   ' }, { link_url: 'javascript:alert(1)' }, { link_url: 'http://example.org' }]) {
      assert.equal((await send(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal(db.T('gateway_announcements').filter(a => a.org_id === 'org-A').length, 0);
  });
  await t.test('no end is allowed (it stays until taken down) and taking it down works for a live and for a waiting notice', async () => {
    reset();
    assert.equal((await send({})).status, 200);
    clock.set('2027-03-01T12:00:00Z'); assert.ok(await shown(), 'no end: still showing months later');
    assert.equal((await call('gateway_clear_announcement', {}, { session: S.adA })).status, 200);
    assert.equal(await shown(), null);
    await send({ message: 'Later', starts_at: '2027-04-01T09:00' });
    assert.equal((await call('gateway_clear_announcement', {}, { session: S.adA })).body.removed, 1);
    clock.set('2027-04-02T12:00:00Z'); assert.equal(await shown(), null);
  });
  await t.test('the admin screen reports Off / Scheduled / Live now / Ended', async () => {
    reset();
    const state = async () => ((await call('gateway_get', {}, { session: S.adA })).body.announcement || { state: 'off' }).state;
    assert.equal(await state(), 'off');
    await send({ starts_at: '2026-11-03T09:00', ends_at: '2026-11-03T17:00' }); assert.equal(await state(), 'scheduled');
    clock.set('2026-11-03T10:00:00Z'); assert.equal(await state(), 'live');
    clock.set('2026-11-03T18:00:00Z'); assert.equal(await state(), 'ended');
  });
});

// =====================================================================================================
test('Order', async (t) => {
  const reg = async () => names(await pub('svp-osterley'), 'registration');
  const mode = async (sec) => (await call('gateway_get', {}, { session: S.adA })).body.sections[sec].mode;
  await t.test('automatic order is closing soonest', async () => {
    reset();
    assert.deepEqual(await reg(), ['Closes Today Reg', 'First Holy Communion', 'Youth Group']);
    assert.equal(await mode('registration'), 'automatic');
  });
  await t.test('a custom order persists, per section, and one section does not touch the other', async () => {
    reset();
    assert.equal((await call('gateway_set_order', { section: 'registration', ids: ['Youth Group', 'Closes Today Reg', 'First Holy Communion'] }, { session: S.adA })).status, 200);
    assert.deepEqual(await reg(), ['Youth Group', 'Closes Today Reg', 'First Holy Communion']);
    assert.equal(await mode('registration'), 'custom'); assert.equal(await mode('involved'), 'automatic');
    assert.deepEqual(names(await pub('svp-osterley'), 'involved'), ['Autumn Raffle', 'Walsingham']);
  });
  await t.test('an item that has expired drops out and the rest keep their order', async () => {
    reset();
    await call('gateway_set_order', { section: 'registration', ids: ['Youth Group', 'Closes Today Reg', 'First Holy Communion'] }, { session: S.adA });
    clock.set(day(TODAY, 1) + 'T09:00:00Z');   // "Closes Today Reg" has closed
    assert.deepEqual(await reg(), ['Youth Group', 'First Holy Communion', 'Future Reg'], 'Future Reg opened today and is not in the stored order, so it goes last');
  });
  await t.test('Back to automatic restores closing-date order', async () => {
    reset();
    await call('gateway_set_order', { section: 'registration', ids: ['Youth Group', 'Closes Today Reg', 'First Holy Communion'] }, { session: S.adA });
    assert.equal((await call('gateway_set_order', { section: 'registration', ids: null }, { session: S.adA })).body.mode, 'automatic');
    assert.deepEqual(await reg(), ['Closes Today Reg', 'First Holy Communion', 'Youth Group']);
    assert.equal(await mode('registration'), 'automatic');
  });
  await t.test('a new manual item lands at the top of a custom order, and sorts by date in automatic order', async () => {
    reset();
    const add = (label) => call('gateway_item_save', { section: 'registration', label, url: 'https://example.org/x', starts_on: TODAY, ends_on: day(TODAY, 100) }, { session: S.adA });
    await add('Auto Item');
    assert.deepEqual((await reg()).slice(-1), ['Auto Item'], 'automatic: latest closing date is last');
    await call('gateway_set_order', { section: 'registration', ids: ['Youth Group', 'Closes Today Reg', 'First Holy Communion'] }, { session: S.adA });
    await add('Top Item');
    assert.equal((await reg())[0], 'Top Item');
  });
  await t.test('re-ordering never moves an item between sections, and unknown ids are refused', async () => {
    reset();
    for (const ids of [['Autumn Raffle', 'Youth Group'], ['Youth Group', 'nope'], ['Youth Group', 'Youth Group'], 'Youth Group', [7]]) {
      assert.equal((await call('gateway_set_order', { section: 'registration', ids }, { session: S.adA })).status, 400, JSON.stringify(ids));
    }
    assert.equal((await call('gateway_set_order', { section: 'nowhere', ids: [] }, { session: S.adA })).status, 400);
    assert.equal(db.T('gateway_order').length, 0);
  });
  await t.test('items not in the stored order go to the end', async () => {
    reset();
    await call('gateway_set_order', { section: 'registration', ids: ['Youth Group'] }, { session: S.adA });
    assert.deepEqual(await reg(), ['Youth Group', 'Closes Today Reg', 'First Holy Communion']);
  });
});

// =====================================================================================================
test('Who may do what', async (t) => {
  await t.test('superadmin, admin, finance and priest may edit the content; a seller and a logged-out visitor may not', async () => {
    reset();
    for (const who of ['saA', 'adA', 'fiA', 'prA']) {
      assert.equal((await call('gateway_get', {}, { session: S[who] })).status, 200, who + ' gateway_get');
      assert.equal((await call('gateway_save_links', { links: [{ position: 1, label: 'Hall', sub: '', url: 'https://example.org/hall' }] }, { session: S[who] })).status, 200, who + ' links');
      assert.equal((await call('gateway_save_announcement', { message: 'x' }, { session: S[who] })).status, 200, who + ' notice');
      assert.equal((await call('gateway_set_details', { phone: '1', hours: '2' }, { session: S[who] })).status, 200, who + ' details');
      assert.equal((await call('campaign_set_listed', { campaign_id: 'Youth Group', listed: true }, { session: S[who] })).status, 200, who + ' listing');
    }
    for (const action of ['gateway_get', 'gateway_save_links', 'gateway_save_announcement', 'gateway_clear_announcement', 'gateway_item_save', 'gateway_set_order', 'gateway_set_details', 'campaign_set_listed']) {
      assert.equal((await call(action, { links: [], section: 'involved' }, { session: S.seA })).status, 403, 'seller ' + action);
      assert.equal((await call(action, {})).status, 401, 'no login ' + action);
    }
  });
  await t.test('only the superadmin may change the page address, the name on it, or switch the page on and off', async () => {
    reset();
    for (const who of ['adA', 'fiA', 'prA', 'seA']) {
      assert.equal((await call('gateway_set_address', { slug: 'new-address' }, { session: S[who] })).status, 403, who);
      assert.equal((await call('gateway_set_enabled', { enabled: false }, { session: S[who] })).status, 403, who);
    }
    assert.equal(db.T('organizations').find(o => o.id === 'org-A').slug, 'svp-osterley');
    assert.equal(db.T('organizations').find(o => o.id === 'org-A').gateway_enabled, true);
  });
  await t.test('changing an address that is already in use needs a confirmation; reserved, malformed and taken addresses are refused', async () => {
    reset();
    let r = await call('gateway_set_address', { slug: 'new-address' }, { session: S.saA });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'confirm_slug_change');
    assert.equal(db.T('organizations').find(o => o.id === 'org-A').slug, 'svp-osterley');
    r = await call('gateway_set_address', { slug: 'new-address', confirm: true }, { session: S.saA });
    assert.equal(r.status, 200); assert.equal(r.body.page_path, '/go/new-address');
    assert.equal((await pub('svp-osterley')).status, 404); assert.equal((await pub('new-address')).status, 200);
    for (const slug of ['admin', 'api', 'go', 'fonts', 'assets', 'ab', 'has space', 'under_score', '-start', 'end-', 'x'.repeat(41)]) assert.equal((await call('gateway_set_address', { slug, confirm: true }, { session: S.saA })).status, 400, slug);
    assert.equal((await call('gateway_set_address', { slug: 'other-parish', confirm: true }, { session: S.saA })).status, 409, 'taken by another organisation');
    assert.equal((await call('gateway_set_address', { slug: 'MixedCase-Page', confirm: true }, { session: S.saA })).body.page_path, '/go/mixedcase-page', 'stored lowercase');
    assert.equal((await call('gateway_set_address', { timezone: 'Not/AZone' }, { session: S.saA })).status, 400);
  });
  await t.test('the page cannot be switched on until it has an address', async () => {
    reset();
    db.T('organizations').find(o => o.id === 'org-A').slug = null; db.T('organizations').find(o => o.id === 'org-A').gateway_enabled = false;
    assert.equal((await call('gateway_set_enabled', { enabled: true }, { session: S.saA })).status, 400);
    assert.equal((await call('gateway_set_address', { slug: 'svp-osterley' }, { session: S.saA })).status, 200, 'first address needs no confirmation');
    assert.equal((await call('gateway_set_enabled', { enabled: true }, { session: S.saA })).status, 200);
  });
  await t.test('a campaign can only be put on the page if it has a working public page', async () => {
    reset();
    for (const c of db.T('campaigns')) c.listed_on_gateway = false;
    const list = (id, listed = true) => call('campaign_set_listed', { campaign_id: id, listed }, { session: S.adA });
    assert.equal((await list('Physical Raffle')).status, 400, 'tickets only sold in person');
    assert.equal((await list('Page Off Reg')).status, 400, 'public page switched off');
    assert.equal((await list('Autumn Raffle')).status, 200);
    assert.equal((await list('Youth Group')).status, 200);
    assert.equal((await list('Page Off Reg', false)).status, 200, 'taking one off is always allowed');
    assert.equal((await call('campaign_set_listed', { campaign_id: 'Youth Group', listed: true, cta: 'Join up' }, { session: S.adA })).status, 200);
    assert.equal((await pub('svp-osterley')).body.sections.registration[0].cta, 'Join up');
    assert.deepEqual(names(await pub('svp-osterley'), 'involved'), ['Autumn Raffle']);
  });
  await t.test('the admin screen lists every campaign with whether it can be put on the page', async () => {
    reset();
    const g = (await call('gateway_get', {}, { session: S.adA })).body;
    const all = [...g.sections.involved.items, ...g.sections.registration.items];
    const row = (n) => all.find(i => i.name === n);
    assert.equal(row('Physical Raffle').eligible, false); assert.equal(row('Page Off Reg').eligible, false);
    assert.equal(row('Autumn Raffle').eligible, true); assert.equal(row('Binned Reg'), undefined, 'a binned campaign is not offered');
    assert.equal(row('Closed Reg').state, 'closed'); assert.equal(row('Draft Reg').state, 'draft');
    assert.equal(g.can_manage, false); assert.equal((await call('gateway_get', {}, { session: S.saA })).body.can_manage, true);
    assert.equal(g.org.page_path, '/go/svp-osterley'); assert.equal(g.links.length, 3);
  });
});

// =====================================================================================================
test('Security', async (t) => {
  await t.test('web addresses with javascript:, data:, mailto:, http: or spaces are refused server-side, in links, items and notices', async () => {
    reset();
    const bad = ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'mailto:someone@example.org', 'http://example.org', 'https://exa mple.org', 'ftp://example.org', 'https://nodot', 'https://localhost', '//example.org', 'example.org', 'https://user:pw@example.org', 'https://example.org/"onmouseover=x', 'https://' + 'a'.repeat(2000) + '.org'];
    for (const url of bad) {
      assert.equal((await call('gateway_save_links', { links: [{ position: 1, label: 'x', sub: '', url }] }, { session: S.adA })).status, 400, 'link ' + url);
      assert.equal((await call('gateway_item_save', { section: 'involved', label: 'x', url, starts_on: TODAY, ends_on: TODAY }, { session: S.adA })).status, 400, 'item ' + url);
      assert.equal((await call('gateway_save_announcement', { message: 'x', link_url: url }, { session: S.adA })).status, 400, 'notice ' + url);
    }
    assert.equal(db.T('gateway_links').filter(l => l.org_id === 'org-A').length, 0);
  });
  await t.test('a bad address is refused and the page keeps the last good one', async () => {
    reset();
    await call('gateway_save_links', { links: [{ position: 2, label: 'Mass', sub: 'For the living', url: 'https://example.org/mass' }] }, { session: S.adA });
    const r = await call('gateway_save_links', { links: [{ position: 2, label: 'Mass', sub: 'For the living', url: 'javascript:alert(1)' }] }, { session: S.adA });
    assert.equal(r.status, 400); assert.match(r.body.error, /Link 2/);
    assert.deepEqual((await pub('svp-osterley')).body.links, [{ label: 'Mass', sub: 'For the living', url: 'https://example.org/mass' }]);
  });
  await t.test('links: an empty row removes that link, the order is by position, and an https address is accepted', async () => {
    reset();
    await call('gateway_save_links', { links: [{ position: 3, label: 'News', sub: '', url: 'https://example.org/news' }, { position: 1, label: 'Hall', sub: 'Book', url: 'HTTPS://Example.org/hall' }] }, { session: S.adA });
    assert.deepEqual((await pub('svp-osterley')).body.links.map(l => l.label), ['Hall', 'News']);
    assert.equal((await pub('svp-osterley')).body.links[0].url, 'https://example.org/hall');
    await call('gateway_save_links', { links: [{ position: 3, label: '', sub: '', url: '' }] }, { session: S.adA });
    assert.deepEqual((await pub('svp-osterley')).body.links.map(l => l.label), ['Hall']);
    assert.equal((await call('gateway_save_links', { links: [{ position: 4, label: 'x', url: 'https://example.org' }] }, { session: S.adA })).status, 400);
    assert.equal((await call('gateway_save_links', { links: [{ position: 1, label: '', url: 'https://example.org' }] }, { session: S.adA })).status, 400, 'an address with no title');
  });
  await t.test('text is stored as plain text (control characters removed) and handed to the page unchanged, for the page to show with textContent', async () => {
    reset();
    await call('gateway_save_announcement', { message: 'Hello <script>alert(1)</script>\u0007 world' }, { session: S.adA });
    const a = (await pub('svp-osterley')).body.announcement;
    assert.equal(a.message, 'Hello <script>alert(1)</script> world');
  });
  await t.test('excess requests to public_gateway are rate limited', async () => {
    reset();
    let last;
    for (let i = 0; i < 245; i++) last = await pub('svp-osterley', { ip: '203.0.113.9' });
    assert.equal(last.status, 429);
    assert.equal((await pub('svp-osterley', { ip: '203.0.113.10' })).status, 200, 'another visitor is unaffected');
  });
});
