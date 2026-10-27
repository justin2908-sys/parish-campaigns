// Customer separation, tested across EVERY logged-in action.
// Two organisations (A and B) are filled with data. Then, signed in as each kind of staff member of A, every action is called with
// organisation B's ids in every place an id can go. Each call must neither change anything of B's nor return anything of B's.
// Run with:  node --test "test/gateway/*.test.js"      (RAISE_SWEEP_REPORT=1 prints how each action answered)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { db, clock, call, addUser } = require('./harness');

const T = db.T;
const ROLES = ['superadmin', 'admin', 'finance', 'priest', 'seller'];
const sessions = {};      // sessions['A'].superadmin ...
const ids = { A: {}, B: {} };

function seedOrg(P, orgId) {
  const p = P.toLowerCase();
  const id = (s) => `${p}-${s}`;
  ids[P] = { org: orgId };
  T('organizations').push({ id: orgId, name: `${P} Church ZZ${P}`, slug: `${p}-church`, gateway_enabled: true, timezone: 'Europe/London', address: `${P} Street ZZ${P}`, contact_email: `${p}-contact@example.org`, thank_you_text: `Thanks ZZ${P}`, privacy_url: 'https://example.org/privacy', gateway_phone: `0${P}`, gateway_hours: `hours ZZ${P}` });
  for (const role of ROLES) {
    sessions[P] = sessions[P] || {};
    sessions[P][role] = addUser(id('u-' + role), role, orgId);
    Object.assign(T('users').find(u => u.id === id('u-' + role)), { mobile: `0770${p === 'a' ? 1 : 2}${ROLES.indexOf(role)}`, name: `${P} ${role} ZZ${P}`, consent_version: 1, confidentiality_version: 99, created_by: null });
    ids[P]['user_' + role] = id('u-' + role);
  }
  const camp = (key, kind, extra = {}) => { const cid = id('c-' + key); T('campaigns').push({ id: cid, org_id: orgId, name: `${P} ${key} ZZ${P}`, kind, active: true, binned: false, is_draft: false, public_page_enabled: true, public_only: false, age_restricted: kind === 'raffle', details_text: `details ZZ${P}`, opens_on: '2026-10-01', closes_on: '2026-12-31', keep_until: '2027-03-31', listed_on_gateway: true, waiting_list: false, places: null, default_ticket_qty: 0, created_by: id('u-superadmin'), physical_payment_methods: ['cash', 'machine', 'link'], online_payment_methods: ['cash', 'machine', 'link'], ...extra }); ids[P]['camp_' + key] = cid; return cid; };
  const raffle = camp('raffle', 'raffle'), event = camp('event', 'event', { waiting_list: true }), reg = camp('reg', 'registration', { places: 5, form_def: { fields: [{ type: 'text', label: 'Child name', required: true }], agreements: [], contact_mode: 'either' } });
  for (const [key, cid] of [['raffle', raffle], ['event', event]]) {
    T('tiers').push({ id: id('tier-' + key), campaign_id: cid, name: `Tier ZZ${P}`, price: 2, sort_order: 0 }); ids[P]['tier_' + key] = id('tier-' + key);
    T('ticket_blocks').push({ id: id('bd-' + key), campaign_id: cid, type: 'digital', label: 'Online', number_prefix: 'O', range_start: 1, range_end: 6 }, { id: id('bp-' + key), campaign_id: cid, type: 'physical', label: 'Book', number_prefix: '', range_start: 101, range_end: 106 });
    ids[P]['block_digital_' + key] = id('bd-' + key); ids[P]['block_physical_' + key] = id('bp-' + key);
    for (let n = 1; n <= 6; n++) T('tickets').push({ id: id(`t-${key}-d${n}`), campaign_id: cid, block_id: id('bd-' + key), ticket_number: n, status: 'unsold', payment_id: null, tier_id: null, attendee_name: n === 5 ? `Holder ZZ${P}` : null });
    for (let n = 101; n <= 106; n++) T('tickets').push({ id: id(`t-${key}-p${n}`), campaign_id: cid, block_id: id('bp-' + key), ticket_number: n, status: 'unsold', payment_id: null, tier_id: null });
    const sell = (pid, nums, status, pay) => { T('payments').push({ id: pid, campaign_id: cid, seller_id: id('u-seller'), payer_name: `Buyer ${pid} ZZ${P}`, contact_value: `${pid}-ZZ${P}@example.org`, amount: 2 * nums.length, created_at: '2026-11-01T10:00:00Z', sold_at: '2026-11-01T10:00:00Z', ticket_snapshot: nums.map(n => ({ tier_id: id('tier-' + key), block_id: id('bp-' + key), ticket_number: n })), client_ip: 'h:abc', ...pay }); for (const n of nums) Object.assign(T('tickets').find(t => t.campaign_id === cid && t.ticket_number === n), { status, payment_id: pid, tier_id: id('tier-' + key), sold_by: id('u-seller'), sold_at: '2026-11-01T10:00:00Z' }); };
    sell(id('pay-cash-' + key), [101], 'cash_pending', { method: 'cash', status: 'pending' });
    sell(id('pay-link-' + key), [102], 'held', { method: 'link', status: 'pending', sumup_checkout_id: id('co-' + key), sumup_checkout_ref: 'REF-' + key, link_url: 'https://pay.example/' + key, created_at: new Date().toISOString() });
    sell(id('pay-paid-' + key), [103], 'paid', { method: 'link', status: 'paid', sumup_checkout_id: id('co2-' + key), sumup_transaction_code: `T${P}${key.toUpperCase()}12345`.slice(0, 11) });
    sell(id('pay-machine-' + key), [104], 'paid', { method: 'machine', status: 'paid' });
    T('payments').push({ id: id('pay-failed-' + key), campaign_id: cid, method: 'link', status: 'failed', amount: 2, payer_name: `Failed ZZ${P}`, contact_value: `f-ZZ${P}@example.org`, seller_id: id('u-seller'), sumup_checkout_id: id('co3-' + key), ticket_snapshot: [] });
    T('payments').push({ id: id('pay-void-' + key), campaign_id: cid, method: 'cash', status: 'void', voided: true, void_reason: `reason ZZ${P}`, amount: 2, payer_name: `Void ZZ${P}`, seller_id: id('u-seller'), ticket_snapshot: [] });
    ids[P]['pay_cash_' + key] = id('pay-cash-' + key); ids[P]['pay_link_' + key] = id('pay-link-' + key); ids[P]['pay_paid_' + key] = id('pay-paid-' + key);
  }
  for (const n of [1, 2]) T('registrations').push({ id: id('r' + n), campaign_id: reg, reg_number: n, name: `Registrant ${n} ZZ${P}`, email: `reg${n}-ZZ${P}@example.org`, phone: `0777${n}`, status: 'submitted', answers: [{ label: 'Child name', value: `Child ZZ${P}` }], agreements: [], created_at: '2026-11-01T10:00:00Z', client_ip: 'h:abc' });
  T('registration_files').push({ id: id('file1'), registration_id: id('r1'), file_name: `cert-ZZ${P}.jpg`, mime: 'image/jpeg', size: 10, data: 'ZZ' });
  T('waiting_list').push({ id: id('w1'), campaign_id: event, email: `wait-ZZ${P}@example.org`, created_at: '2026-11-01T10:00:00Z' });
  T('user_campaigns').push({ user_id: id('u-seller'), campaign_id: raffle });
  T('privacy_requests').push({ id: id('pr1'), org_id: orgId, user_id: id('u-superadmin'), kind: 'search', subject_masked: `s***ZZ${P}`, found_payments: 1, found_tickets: 1, created_at: '2026-11-01T10:00:00Z' });
  T('gateway_links').push({ id: id('gl1'), org_id: orgId, position: 1, label: `Link ZZ${P}`, sub: '', url: 'https://example.org/l' });
  T('gateway_items').push({ id: id('gi1'), org_id: orgId, section: 'involved', label: `Item ZZ${P}`, url: 'https://example.org/i', cta: null, starts_on: '2026-10-01', ends_on: '2026-12-31', listed: true });
  T('gateway_announcements').push({ id: id('ga1'), org_id: orgId, message: `Notice ZZ${P}`, link_url: null, urgent: false, starts_at: '2026-10-01T00:00:00.000Z', ends_at: null, created_at: '2026-10-01T00:00:00.000Z' });
  T('gateway_order').push({ org_id: orgId, section: 'involved', item_ids: [id('gi1')] });
  ids[P].reg = id('r1'); ids[P].file = id('file1'); ids[P].gitem = id('gi1');
}
const reset = () => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  db.faults.length = 0; clock.set('2026-11-02T12:00:00Z');
  seedOrg('A', 'org-A'); seedOrg('B', 'org-B');
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });   // SumUp is never reached for real
};

// everything that belongs to organisation B, as one comparable string
function snapshotB() {
  const campIds = T('campaigns').filter(c => c.org_id === 'org-B').map(c => c.id), campSet = new Set(campIds);
  const payIds = new Set(T('payments').filter(p => campSet.has(p.campaign_id)).map(p => p.id)), regIds = new Set(T('registrations').filter(r => campSet.has(r.campaign_id)).map(r => r.id));
  const userIds = new Set(T('users').filter(u => u.org_id === 'org-B').map(u => u.id));
  const out = {
    organizations: T('organizations').filter(o => o.id === 'org-B'), users: T('users').filter(u => userIds.has(u.id)), campaigns: T('campaigns').filter(c => campSet.has(c.id)),
    tiers: T('tiers').filter(x => campSet.has(x.campaign_id)), ticket_blocks: T('ticket_blocks').filter(x => campSet.has(x.campaign_id)), tickets: T('tickets').filter(x => campSet.has(x.campaign_id)),
    payments: T('payments').filter(x => payIds.has(x.id)), registrations: T('registrations').filter(x => regIds.has(x.id)), registration_files: T('registration_files').filter(x => regIds.has(x.registration_id)),
    waiting_list: T('waiting_list').filter(x => campSet.has(x.campaign_id)), user_campaigns: T('user_campaigns').filter(x => userIds.has(x.user_id)), privacy_requests: T('privacy_requests').filter(x => x.org_id === 'org-B'),
    cash_recon: T('cash_recon').filter(x => campSet.has(x.campaign_id)),
    gateway_links: T('gateway_links').filter(x => x.org_id === 'org-B'), gateway_items: T('gateway_items').filter(x => x.org_id === 'org-B'), gateway_announcements: T('gateway_announcements').filter(x => x.org_id === 'org-B'), gateway_order: T('gateway_order').filter(x => x.org_id === 'org-B'),
  };
  return JSON.stringify(out);
}

// ---- the actions, read from the server's own action table
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'netlify', 'functions', 'api.js'), 'utf8');
const PUBLIC = new Set(['login', 'bootstrap_platform_owner', 'sumup_webhook', 'public_gateway']);
const actionNames = [...new Set([...SRC.matchAll(/\b([a-z][a-z_]+): \(s(?:, b)?\) =>/g)].map(m => m[1]))].filter(n => !n.startsWith('public_') && !PUBLIC.has(n));
const PLATFORM_ONLY = new Set(['create_organization', 'list_organizations', 'platform_find_user', 'platform_reset_superadmin_password', 'platform_set_superadmin_active']);

// What to send for each name an action asks for. Every id is organisation B's.
function bodyFor(P, variant) {
  const v = ids[P], k = variant;   // k: 'raffle' | 'event' | 'reg'
  const camp = v['camp_' + k], pay = v['pay_' + (k === 'reg' ? 'link_raffle' : (k === 'raffle' ? 'link_raffle' : 'cash_event'))], user = v[{ raffle: 'user_seller', event: 'user_admin', reg: 'user_superadmin' }[k]];
  const tier = v['tier_' + (k === 'reg' ? 'raffle' : k)], block = v['block_digital_' + (k === 'reg' ? 'raffle' : k)];
  return {
    campaign_id: camp, campaign_ids: [camp], disabled_campaign_ids: [camp], payment_id: pay, registration_id: v.reg, file_id: v.file, block_id: block, auto_assign_block_id: block, user_id: user, seller_id: v.user_seller, id: v.gitem,
    org_id: v.org, query: `${P.toLowerCase()}-contact@example.org`, contact_value: `${P}-x@example.org`, mobile: '07702' + 0, tier_counts: { [tier]: 1 }, ticket_numbers: [1], ticket_number: 1,
    confirm: true, enabled: true, active: true, listed: true, reason: 'x', note: 'x', decision: 'accepted', amount: 1, amount_received: 1, quantity: 3, opens_on: '2026-10-01', closes_on: '2026-12-31', keep_until: '2027-06-30',
    range_end: 4, range_start: 301, type: 'physical', label: 'x', number_prefix: '', physical: ['cash'], online: ['cash'], details_text: 'hijacked', form_def: { fields: [{ type: 'text', label: 'x', required: true }], agreements: [], contact_mode: 'either' }, places: 9,
    text: `Id,Desc\nTAAAZZ00001,hijack`, from: '2026-10-01', links: [{ position: 1, label: 'hijacked', sub: '', url: 'https://hijack.example.org' }], section: 'involved', ids: [v.gitem], phone: 'hijacked', hours: 'hijacked', address: 'hijacked', thank_you_text: 'hijacked',
    contact_email: 'hijack@example.org', privacy_url: 'https://hijack.example.org', lottery_reg_number: 'HIJACK', lottery_authority: 'x', lottery_valid_until: '2027-01-01', method: 'cash', payer_name: 'x', client_ref: 'sweep-' + Math.random().toString(36).slice(2, 12), build: '2026-10-20',
    role: 'seller', password: 'Password123!', new_password: 'Password123!', name: 'hijacked', channel: 'sms', include_inactive: true, public_only: false, public_page_enabled: true, slug: 'hijacked-slug', message: 'hijacked', link_url: 'https://hijack.example.org', urgent: false,
    cta: 'x', starts_on: '2026-10-01', ends_on: '2026-12-31', url: 'https://hijack.example.org', starts_at: '2026-10-01T10:00', ends_at: '2026-12-01T10:00', kind: 'event', display_name: 'hijacked', timezone: 'Europe/London', public: true, files: [], answers: {}, agreements: {},
  };
}

const results = [];   // { action, role, variant, status }
const violations = [];
test('every logged-in action, called as organisation A with organisation B\'s ids, neither changes nor reveals anything of B\'s', async (t) => {
  assert.ok(actionNames.length > 80, `read ${actionNames.length} actions from the server`);
  for (const action of actionNames) {
    for (const variant of ['raffle', 'event', 'reg']) {
      reset();
      const before = snapshotB();
      for (const role of ROLES) {
        const body = bodyFor('B', variant);
        let r;
        try { r = await call(action, body, { session: sessions.A[role] }); } catch (e) { r = { status: 599, raw: String(e && e.message), body: {} }; }
        results.push({ action, role, variant, status: r.status });
        const after = snapshotB();
        const leaked = /ZZB/.test(r.raw || '');
        if (after !== before) { violations.push(`${action} as A's ${role} (${variant}) CHANGED organisation B's data`); }
        else if (leaked) violations.push(`${action} as A's ${role} (${variant}) RETURNED organisation B's data: ${(r.raw || '').match(/.{0,40}ZZB.{0,30}/)[0]}`);
        if (after !== before) { reset(); }   // carry on from clean data
      }
    }
  }
  const byAction = {};
  for (const r of results) { (byAction[r.action] = byAction[r.action] || {})[r.status] = ((byAction[r.action] || {})[r.status] || 0) + 1; }
  if (process.env.RAISE_SWEEP_REPORT) for (const [a, s] of Object.entries(byAction)) console.log(a.padEnd(34), JSON.stringify(s));
  const unique = [...new Set(violations)];
  assert.deepEqual(unique, [], `\n${unique.join('\n')}`);
});

test('the sweep means something: the same calls DO work for the organisation that owns the data', async () => {
  reset();
  const own = async (action, role, variant) => (await call(action, bodyFor('A', variant), { session: sessions.A[role] })).status;
  assert.equal(await own('list_campaigns', 'superadmin', 'raffle'), 200);
  assert.equal(await own('set_org_address', 'superadmin', 'raffle'), 200);
  assert.equal(await own('set_campaign_active', 'superadmin', 'raffle'), 200);
  assert.equal(await own('registration_get', 'superadmin', 'reg'), 200);
  assert.equal(await own('void_sale', 'superadmin', 'event'), 200);
  assert.equal(await own('gateway_item_delete', 'admin', 'raffle'), 200);
  assert.equal(await own('waiting_list_get', 'superadmin', 'event'), 200);
  assert.equal(await own('dashboard_state', 'admin', 'raffle'), 200);
});

test('how many calls actually reached the organisation check (rather than failing earlier for another reason)', async () => {
  const reached = results.filter(r => [200, 403, 404].includes(r.status)).length, total = results.length;
  const refused = results.filter(r => r.status === 403 || r.status === 404).length;
  console.log(`# sweep: ${actionNames.length} actions x ${ROLES.length} roles x 3 variants = ${total} calls; ${reached} (${Math.round(100 * reached / total)}%) reached a decision (${refused} refused, ${reached - refused} answered); the rest stopped on a missing or invalid detail`);
  assert.ok(total > 1000);
});
