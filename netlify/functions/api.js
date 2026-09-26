// Campaigns — backend API (generalized from BBQ Ticketing v3.10)
// All requests: POST /api/:action  body: JSON { session?, ...payload }
//
// Role hierarchy: platform_owner (global, org_id null) creates Organizations and each
// one's first SuperAdmin. superadmin/admin/seller are scoped to exactly one Organization
// (session.org_id) — every query below that touches org-scoped data filters by it.

const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
// No insecure fallback: the original silently signed sessions with the literal string
// 'change-me' if this env var was ever left unset, which would let anyone forge a valid
// session (including Platform Owner) just by knowing that default. Fail loudly instead.
if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is not set — refusing to start with an insecure default.');
}
const SESSION_SECRET = process.env.SESSION_SECRET;
const SUMUP_API_KEY = process.env.SUMUP_API_KEY;
const SUMUP_MERCHANT_CODE = process.env.SUMUP_MERCHANT_CODE;

const MIN_PASSWORD_LENGTH = 8;
function assertPasswordStrength(password) {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw httpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

// ---------- session token helpers (lightweight signed token, no external deps) ----------
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifySession(token) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null; // constant-time compare
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}
function requireRole(session, roles) {
  if (!session) throw httpError(401, 'Not logged in');
  if (!roles.includes(session.role)) throw httpError(403, 'Not permitted for this action');
}
// Org-scoped roles must always act within their own org — this guards every handler
// that takes a campaign/user id against reaching across into another church's data.
function requireOrgRole(session, roles) {
  requireRole(session, roles);
  if (!session.org_id) throw httpError(403, 'This action requires an Organization-scoped account');
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// ---------- abuse limits ----------
// The caller's address as Netlify's edge reports it (the client can't set this header).
let clientIp = '';

// Attempt counters live in the database (rate_limits) because each request may run on a
// different server instance. If the counter itself is unreachable we let the request through
// rather than lock everyone out.
async function rateHit(key, windowSeconds) {
  const { data, error } = await supabase.rpc('rate_hit', { p_key: key, p_window_seconds: windowSeconds });
  return error ? 0 : Number(data);
}
async function ratePeek(key, windowSeconds) {
  const { data, error } = await supabase.rpc('rate_peek', { p_key: key, p_window_seconds: windowSeconds });
  return error ? 0 : Number(data);
}
async function rateReset(key) { await supabase.rpc('rate_reset', { p_key: key }); }

// The database returns at most 1,000 rows per request — silently. A campaign has thousands of ticket
// rows, so anything that reads tickets or payments in bulk pages through with fetchAll (build() must
// give a fresh, ordered query each time), or looks up only the rows it needs (ticketsForPayments).
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw httpError(500, error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function ticketsForPayments(paymentIds, columns) {
  const ids = [...new Set(paymentIds)]; if (!ids.length) return [];
  const chunks = []; for (let i = 0; i < ids.length; i += 40) chunks.push(ids.slice(i, i + 40));
  const parts = await Promise.all(chunks.map(chunk => fetchAll(() => supabase.from('tickets').select(columns).in('payment_id', chunk).order('id'))));
  return parts.flat();
}

// Runs the stale-hold sweep at most once a minute, whoever triggers it, so the public page can
// free abandoned holds itself without every visitor causing SumUp lookups.
async function sweepIfDue() {
  if ((await rateHit('sweep', 60)) === 1) {
    await releaseStalePendingLinkPayments();
    await supabase.rpc('rate_prune');
  }
}

// Free text from a person: control characters and line breaks flattened, length capped.
const MAX_NAME_LENGTH = 80, MAX_CONTACT_LENGTH = 254;
function cleanName(v, what) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > MAX_NAME_LENGTH) throw httpError(400, `${what || 'The name'} is too long (${MAX_NAME_LENGTH} characters at most).`);
  return s;
}
function cleanClientRef(v) {
  if (v == null || v === '') return null;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(v))) throw httpError(400, 'Invalid request reference.');
  return String(v);
}
// Fingerprint of a user's password hash, carried in their login token: resetting the password
// changes it, which ends every session issued before the reset.
const passwordFingerprint = (hash) => crypto.createHash('sha256').update(String(hash)).digest('base64url').slice(0, 16);
// Used to spend the same time on an unknown mobile number as on a real one.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------- Platform Owner / Organizations ----------

async function bootstrapPlatformOwner({ mobile, name, password }) {
  const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'platform_owner');
  if (count > 0) throw httpError(403, 'Setup already complete. Ask the existing Platform Owner to add you.');
  assertPasswordStrength(password);
  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('users')
    .insert({ mobile, name, role: 'platform_owner', org_id: null, password_hash: hash })
    .select().single();
  if (error) throw httpError(500, error.message);
  return { ok: true, user: safeUser(data) };
}

async function createOrganization(session, { name }) {
  requireRole(session, ['platform_owner']);
  if (!name || !name.trim()) throw httpError(400, 'Give the organization a name');
  const { data, error } = await supabase.from('organizations').insert({ name: name.trim() }).select().single();
  if (error) throw httpError(400, error.message);
  return { ok: true, organization: data };
}

async function listOrganizations(session) {
  requireRole(session, ['platform_owner']);
  const { data, error } = await supabase.from('organizations').select('*').order('created_at');
  if (error) throw httpError(500, error.message);
  return { organizations: data };
}

// ---------- Platform Owner: narrow SuperAdmin account recovery ----------
// Deliberately narrow: Platform Owner can find and recover a locked-out SuperAdmin (by
// mobile number, since that's all a Platform Owner has to identify them with) — nothing
// more. No visibility into any church's campaigns, sales, or other users; a locked-out
// Admin/Seller is recovered by their own church's SuperAdmin, not escalated here.
async function platformFindUser(session, { mobile }) {
  requireRole(session, ['platform_owner']);
  if (!mobile || !mobile.trim()) throw httpError(400, 'Enter a mobile number');
  const { data: user } = await supabase.from('users').select('id, name, mobile, role, active, org_id').eq('mobile', mobile.trim()).eq('role', 'superadmin').maybeSingle();
  if (!user) throw httpError(404, 'No SuperAdmin found with that mobile number');
  const { data: org } = await supabase.from('organizations').select('name').eq('id', user.org_id).single();
  return { user: { id: user.id, name: user.name, mobile: user.mobile, active: user.active, org_name: org ? org.name : '' } };
}
async function platformResetSuperadminPassword(session, { user_id, new_password }) {
  requireRole(session, ['platform_owner']);
  assertPasswordStrength(new_password);
  const { data: user } = await supabase.from('users').select('id, role').eq('id', user_id).maybeSingle();
  if (!user || user.role !== 'superadmin') throw httpError(404, 'SuperAdmin not found');
  const hash = await bcrypt.hash(new_password, 10);
  const { error } = await supabase.from('users').update({ password_hash: hash }).eq('id', user_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}
async function platformSetSuperadminActive(session, { user_id, active }) {
  requireRole(session, ['platform_owner']);
  const { data: user } = await supabase.from('users').select('id, role').eq('id', user_id).maybeSingle();
  if (!user || user.role !== 'superadmin') throw httpError(404, 'SuperAdmin not found');
  const { error } = await supabase.from('users').update({ active }).eq('id', user_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}

// ---------- Auth & Users ----------

const PUBLIC_REQ_MAX = 1500, PUBLIC_REQ_WINDOW_SECONDS = 300;
const LOGIN_MAX_FAILS = 5, LOGIN_IP_MAX_FAILS = 30, LOGIN_WINDOW_SECONDS = 15 * 60;
async function login({ mobile, password }) {
  const m = String(mobile == null ? '' : mobile).trim().slice(0, 32);
  // Counted per mobile number TYPED (whether or not it exists, so an attacker learns nothing from
  // who gets locked) and per address. Only wrong attempts count; a good login clears the count.
  const keyMobile = 'login:m:' + m.replace(/[^\d+]/g, ''), keyIp = 'login:ip:' + clientIp;
  const [fm, fi] = await Promise.all([ratePeek(keyMobile, LOGIN_WINDOW_SECONDS), ratePeek(keyIp, LOGIN_WINDOW_SECONDS)]);
  if (fm >= LOGIN_MAX_FAILS || fi >= LOGIN_IP_MAX_FAILS) {
    throw httpError(429, 'Too many failed attempts. Please wait 15 minutes and try again — or ask your SuperAdmin to reset your password.');
  }
  const { data: user } = await supabase.from('users').select('*').eq('mobile', m).eq('active', true).maybeSingle();
  const ok = await bcrypt.compare(String(password == null ? '' : password), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    await Promise.all([rateHit(keyMobile, LOGIN_WINDOW_SECONDS), rateHit(keyIp, LOGIN_WINDOW_SECONDS)]);
    // One message for unknown number, wrong password and disabled account alike.
    throw httpError(401, 'Incorrect mobile number or password.');
  }
  await rateReset(keyMobile);
  const session = signSession({ uid: user.id, role: user.role, org_id: user.org_id, name: user.name, pf: passwordFingerprint(user.password_hash), exp: Date.now() + 1000 * 60 * 60 * 2 });
  return { session, user: safeUser(user) };
}

// Every authenticated request re-checks that the account still exists, is still active, and
// still has the password the token was issued for — so disabling someone or resetting their
// password ends their session immediately instead of at the 2-hour expiry.
async function assertSessionLive(session) {
  const { data: u } = await supabase.from('users').select('active, password_hash, role').eq('id', session.uid).maybeSingle();
  // A role change (e.g. SuperAdmin -> Seller) ends the old session at once rather than lingering up to 2 hours.
  if (!u || !u.active || u.role !== session.role || !session.pf || session.pf !== passwordFingerprint(u.password_hash)) {
    throw httpError(401, 'Your session has ended — please log in again.');
  }
}

function safeUser(u) { return { id: u.id, mobile: u.mobile, name: u.name, role: u.role, org_id: u.org_id }; }

async function createUser(session, { org_id, mobile, name, role, password, disabled_campaign_ids }) {
  // Platform Owner creates a new Organization's first SuperAdmin (org_id required, explicit).
  // A SuperAdmin creates Admins/Sellers/other SuperAdmins within their own org only —
  // org_id is never taken from the caller here, always the session's own, so a SuperAdmin
  // can never plant a user into a different church.
  let targetOrgId;
  if (session && session.role === 'platform_owner') {
    if (role !== 'superadmin') throw httpError(400, 'Platform Owner can only create a SuperAdmin for a new Organization');
    if (!org_id) throw httpError(400, 'org_id is required');
    targetOrgId = org_id;
  } else {
    requireOrgRole(session, ['superadmin']);
    if (!['seller', 'admin', 'superadmin'].includes(role)) throw httpError(400, 'Invalid role');
    targetOrgId = session.org_id;
  }
  assertPasswordStrength(password);
  const cleanedName = cleanName(name, 'The name');
  const cleanedMobile = String(mobile == null ? '' : mobile).trim();
  if (!cleanedName || !cleanedMobile) throw httpError(400, 'A name and a mobile number are required.');
  if (cleanedMobile.length > 32) throw httpError(400, 'That mobile number is too long.');
  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('users')
    .insert({ mobile: cleanedMobile, name: cleanedName, role, org_id: targetOrgId, password_hash: hash, created_by: session.uid })
    .select().single();
  if (error) throw httpError(400, error.message);
  if (disabled_campaign_ids && disabled_campaign_ids.length) {
    await supabase.from('user_campaigns').insert(disabled_campaign_ids.map(campaign_id => ({ user_id: data.id, campaign_id, assigned_by: session.uid })));
  }
  return { ok: true, user: safeUser(data) };
}

// Default is full access to every active campaign. A row in user_campaigns means this
// specific campaign is explicitly DISABLED for this user — the table is an exclusion list,
// not an allow-list. Open to Admins as well as SuperAdmins: this is day-to-day rostering,
// not account creation/deletion, which stays SuperAdmin-only.
async function setDisabledCampaigns(session, { user_id, disabled_campaign_ids }) {
  requireOrgRole(session, ['admin', 'superadmin']);
  await requireCampaignsInOwnOrg(session, disabled_campaign_ids || []);
  await supabase.from('user_campaigns').delete().eq('user_id', user_id);
  if (disabled_campaign_ids && disabled_campaign_ids.length) {
    const { error } = await supabase.from('user_campaigns').insert(disabled_campaign_ids.map(campaign_id => ({ user_id, campaign_id, assigned_by: session.uid })));
    if (error) throw httpError(400, error.message);
  }
  return { ok: true };
}

async function setUserActive(session, { user_id, active }) {
  requireOrgRole(session, ['superadmin']);
  await requireUserInOwnOrg(session, user_id);
  const { error } = await supabase.from('users').update({ active }).eq('id', user_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}

async function resetPassword(session, { user_id, new_password }) {
  requireOrgRole(session, ['superadmin']);
  await requireUserInOwnOrg(session, user_id);
  assertPasswordStrength(new_password);
  const hash = await bcrypt.hash(new_password, 10);
  const { error } = await supabase.from('users').update({ password_hash: hash }).eq('id', user_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}

async function requireUserInOwnOrg(session, user_id) {
  const { data } = await supabase.from('users').select('org_id').eq('id', user_id).maybeSingle();
  if (!data || data.org_id !== session.org_id) throw httpError(404, 'User not found');
}
async function requireCampaignsInOwnOrg(session, campaignIds) {
  if (!campaignIds.length) return;
  const { data } = await supabase.from('campaigns').select('id, org_id').in('id', campaignIds);
  if ((data || []).some(c => c.org_id !== session.org_id)) throw httpError(403, 'Campaign not found in your Organization');
}

async function listUsers(session) {
  requireOrgRole(session, ['admin', 'superadmin']);
  const { data: users } = await supabase.from('users').select('id,mobile,name,role,active,created_at').eq('org_id', session.org_id).order('created_at');
  const { data: disabled } = await supabase.from('user_campaigns').select('user_id, campaign_id');
  const { data: campaigns } = await supabase.from('campaigns').select('id, name').eq('org_id', session.org_id);
  const out = users.map(u => ({
    ...u,
    disabled_campaign_ids: disabled.filter(a => a.user_id === u.id).map(a => a.campaign_id),
    disabled_campaign_names: disabled.filter(a => a.user_id === u.id).map(a => (campaigns.find(c => c.id === a.campaign_id) || {}).name).filter(Boolean),
  }));
  return { users: out };
}

// ---------- Organization settings, Campaigns, Tiers, Ticket Blocks ----------

// The church's name, address and thank-you line, shown on every ticket message from any of its
// campaigns. Read by any org-scoped role (a seller needs them to build a message), set by SuperAdmin.
async function getOrgSettings(session) {
  requireOrgRole(session, ['seller', 'admin', 'superadmin']);
  const { data, error } = await supabase.from('organizations').select('id, name, address, thank_you_text').eq('id', session.org_id).single();
  if (error) throw httpError(500, error.message);
  return { organization: data };
}
// The thank-you line added to the public page and to every payment-link / ticket message.
const MAX_THANK_YOU_LENGTH = 400;
async function setOrgThankYou(session, { thank_you_text }) {
  requireOrgRole(session, ['superadmin']);
  const text = String(thank_you_text == null ? '' : thank_you_text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > MAX_THANK_YOU_LENGTH) throw httpError(400, `Keep the thank-you message under ${MAX_THANK_YOU_LENGTH} characters.`);
  const { error } = await supabase.from('organizations').update({ thank_you_text: text || null }).eq('id', session.org_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}
async function setOrgAddress(session, { address }) {
  requireOrgRole(session, ['superadmin']);
  const { error } = await supabase.from('organizations').update({ address: (address || '').trim() || null }).eq('id', session.org_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}

// Free-text, deliberately unstructured rather than rigid fields like "prizes" or
// "draw_date": every campaign type needs different things on its ticket (a raffle has
// prizes and a draw date, a dinner has neither) — a SuperAdmin writes whatever's relevant
// once, and it's reused verbatim in every ticket message for that campaign.
async function setCampaignDetails(session, { campaign_id, details_text }) {
  requireOrgRole(session, ['superadmin']);
  await requireCampaignsInOwnOrg(session, [campaign_id]);
  const { error } = await supabase.from('campaigns').update({ details_text: (details_text || '').trim() || null }).eq('id', campaign_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}

// tiers: [{ name, price }]
// blocks: [{ type: 'physical'|'digital', label?, range_start, range_end, number_prefix? }]
// Physical and digital blocks are structurally identical now — both declare a real numbered
// range and pre-populate every number as 'unsold'. number_prefix (e.g. "O") is display-only,
// and only meaningful for digital: a physical ticket must show exactly the number printed on
// it (non-negotiable #8), so a physical block's prefix is always forced blank here.
async function createCampaign(session, { name, tiers, blocks, details_text }) {
  requireOrgRole(session, ['superadmin']);
  if (!name || !name.trim()) throw httpError(400, 'Give the campaign a name');
  if (!tiers || !tiers.length) throw httpError(400, 'Add at least one price tier');
  if (!blocks || !blocks.length) throw httpError(400, 'Add at least one ticket block');
  // Checked BEFORE anything is created, so a mistake leaves nothing half-built behind.
  const ranges = blocks.map((b, i) => {
    if (!['physical', 'digital'].includes(b.type)) throw httpError(400, `Unknown block type: ${b.type}`);
    const s = Number(b.range_start), e = Number(b.range_end);
    if (b.range_start === '' || b.range_end === '' || !Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s) {
      throw httpError(400, `Series ${i + 1}: enter a first and last number (whole numbers, from 1 up), with the last at or after the first.`);
    }
    if (e - s + 1 > MAX_SERIES_SIZE) throw httpError(400, `Series ${i + 1}: a series can hold at most ${MAX_SERIES_SIZE.toLocaleString()} tickets.`);
    const label = (b.label && b.label.trim()) || `Series ${i + 1}`;
    return { s, e, label: `${label} (${b.type === 'digital' ? 'online' : 'physical'})` };
  });
  // Every ticket number must belong to exactly ONE series in the campaign — physical or online.
  // The same number in a physical and an online series makes no sense: which ticket is it?
  const bySize = ranges.slice().sort((a, b) => a.s - b.s);
  let widest = bySize[0];
  for (const cur of bySize.slice(1)) {
    if (cur.s <= widest.e) {
      const from = cur.s, to = Math.min(cur.e, widest.e);
      throw httpError(400, `${widest.label} ${widest.s}–${widest.e} and ${cur.label} ${cur.s}–${cur.e} both include ${from === to ? `number ${from}` : `numbers ${from}–${to}`}. Every ticket number must belong to exactly one series, so give each series its own range.`);
    }
    if (cur.e > widest.e) widest = cur;
  }

  const { data: campaign, error: campErr } = await supabase.from('campaigns')
    .insert({ org_id: session.org_id, name: name.trim(), created_by: session.uid, details_text: (details_text || '').trim() || null })
    .select().single();
  if (campErr) throw httpError(400, campErr.message);

  const { data: tierRows, error: tierErr } = await supabase.from('tiers')
    .insert(tiers.map((t, i) => ({ campaign_id: campaign.id, name: t.name.trim(), price: Number(t.price), sort_order: i })))
    .select();
  if (tierErr) throw httpError(400, 'Campaign created but tiers failed: ' + tierErr.message);

  const blockRows = [];
  let digitalCount = 0;
  for (const b of blocks) {
    const isDigital = b.type === 'digital';
    const label = isDigital
      ? (b.label && b.label.trim()) || ((++digitalCount) === 1 ? 'Online' : `Online ${digitalCount}`)
      : (b.label && b.label.trim()) || 'Main';
    blockRows.push(await insertBlockWithTickets(campaign.id, b, label));
  }

  return { ok: true, campaign, tiers: tierRows, blocks: blockRows };
}

// Inserts one ticket block and pre-populates every ticket number in its range as 'unsold' —
// physical and digital alike. Shared by createCampaign and addBlockToCampaign.
async function insertBlockWithTickets(campaign_id, b, label) {
  const isDigital = b.type === 'digital';
  const range_start = Number(b.range_start), range_end = Number(b.range_end);
  const { data: block, error: blockErr } = await supabase.from('ticket_blocks')
    .insert({
      campaign_id, type: b.type, label, range_start, range_end,
      number_prefix: isDigital ? (b.number_prefix || '').trim() : '',
    })
    .select().single();
  if (blockErr) throw httpError(500, 'A ticket block failed: ' + blockErr.message);

  const rows = [];
  for (let n = range_start; n <= range_end; n++) rows.push({ campaign_id, block_id: block.id, ticket_number: n });
  for (let i = 0; i < rows.length; i += 500) {
    const { error: e2 } = await supabase.from('tickets').insert(rows.slice(i, i + 500));
    if (e2) {
      // Don't leave a half-populated series behind: remove what was inserted, then the block.
      await supabase.from('tickets').delete().eq('block_id', block.id);
      await supabase.from('ticket_blocks').delete().eq('id', block.id);
      throw httpError(500, 'Ticket generation failed, nothing was added: ' + e2.message);
    }
  }
  return block;
}

const MAX_SERIES_SIZE = 50000; // sanity cap on one series, not a business rule

// Adds another series (a physical top-up, or a second online series) to an existing campaign.
// The new range may not overlap ANY ticket number already in the campaign: physical sales
// look tickets up by campaign + number, so two tickets sharing a number would be ambiguous.
async function addBlockToCampaign(session, { campaign_id, type, label, range_start, range_end, number_prefix }) {
  requireOrgRole(session, ['superadmin']);
  await requireCampaignsInOwnOrg(session, [campaign_id]);
  if (!['physical', 'digital'].includes(type)) throw httpError(400, 'Choose physical or online');
  const start = Number(range_start), end = Number(range_end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw httpError(400, 'Enter a start and end number, with end at or after start');
  }
  if (end - start + 1 > MAX_SERIES_SIZE) throw httpError(400, `A series can hold at most ${MAX_SERIES_SIZE.toLocaleString()} tickets`);

  const { data: campaign } = await supabase.from('campaigns').select('id, binned').eq('id', campaign_id).maybeSingle();
  if (!campaign) throw httpError(404, 'Campaign not found');
  if (campaign.binned) throw httpError(400, 'This campaign is in the Recycle Bin — restore it first');

  const { data: clash } = await supabase.from('tickets').select('ticket_number')
    .eq('campaign_id', campaign_id).gte('ticket_number', start).lte('ticket_number', end).order('ticket_number');
  if (clash && clash.length) {
    const first = clash[0].ticket_number, last = clash[clash.length - 1].ticket_number;
    throw httpError(400, `${first === last ? `Number ${first} is` : `Numbers ${first}–${last} (${clash.length} in your range) are`} already used in this campaign — pick a range that doesn't overlap an existing series.`);
  }

  const { data: existing } = await supabase.from('ticket_blocks').select('type, label').eq('campaign_id', campaign_id);
  const sameType = (existing || []).filter(b => b.type === type).length;
  let finalLabel = (label || '').trim();
  if (!finalLabel) finalLabel = type === 'digital' ? `Online ${sameType + 1}` : `Series ${sameType + 1}`;
  if ((existing || []).some(b => b.label.toLowerCase() === finalLabel.toLowerCase())) {
    throw httpError(400, `This campaign already has a series called "${finalLabel}" — use a different name so sellers can tell them apart.`);
  }

  const block = await insertBlockWithTickets(campaign_id, { type, range_start: start, range_end: end, number_prefix }, finalLabel);
  return { ok: true, block };
}

const STALE_MINUTES = 35; // SumUp hosted checkouts are valid ~30 min; give a small buffer

// Base URL of this deployment, used to tell SumUp where to send payment notifications.
let baseUrl = process.env.URL || '';

// The single place that asks SumUp what actually happened to a checkout and updates our
// records to match. Used by the SumUp notification, the manual status check, the stale
// sweep and resend — so a payment is never marked paid (or failed) by two different rules.
// We never trust a notification's own content: it only tells us WHICH checkout to re-check,
// and the answer always comes from SumUp's API using our key.
async function syncCheckout(payment) {
  if (!payment.sumup_checkout_id) return payment.status;
  const resp = await fetch(`https://api.sumup.com/v0.1/checkouts/${payment.sumup_checkout_id}`, {
    headers: { 'Authorization': `Bearer ${SUMUP_API_KEY}` },
  });
  let data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw httpError(502, `SumUp status check failed (HTTP ${resp.status})`);

  // SumUp never flips an unpaid hosted checkout to "expired" in its API: a link nobody paid stays
  // PENDING forever, even though its payment page stops accepting payment after ~30 minutes
  // (seen: still PENDING, no transactions, no expiry field, 87 minutes on). So an unpaid checkout
  // older than STALE_MINUTES counts as expired — and is CANCELLED at SumUp first, so it can
  // never be paid afterwards. If SumUp refuses to cancel (it may have been paid a moment ago) we
  // look again before deciding anything.
  const checkoutAgeMin = (Date.now() - Date.parse(data.date || payment.created_at)) / 60000;
  if (data.status === 'PENDING' && payment.status === 'pending' && !(data.transactions || []).length && checkoutAgeMin > STALE_MINUTES) {
    const cancelled = await cancelSumupCheckout(payment.sumup_checkout_id);
    if (cancelled.ok) data = { ...data, status: 'EXPIRED' };
    else {
      const again = await fetch(`https://api.sumup.com/v0.1/checkouts/${payment.sumup_checkout_id}`, { headers: { 'Authorization': `Bearer ${SUMUP_API_KEY}` } });
      const d2 = await again.json().catch(() => ({}));
      if (again.ok) data = d2;
    }
  }

  if (data.status === 'PAID') {
    const tx = (data.transactions || [])[0] || {};
    if (payment.status === 'paid') return 'paid';
    if (payment.status === 'void') {
      // Paid after an Admin voided the sale — money has actually moved, so make that loud.
      await supabase.from('payments').update({
        sumup_transaction_code: tx.transaction_code || null, sumup_transaction_id: tx.id || null,
        void_reason: `${payment.void_reason || ''} — WARNING: SumUp shows this checkout WAS PAID (${tx.transaction_code || 'no code'}). Refund needed.`,
      }).eq('id', payment.id);
      return 'void';
    }
    await supabase.from('payments').update({ status: 'paid', sumup_transaction_code: tx.transaction_code || null, sumup_transaction_id: tx.id || null }).eq('id', payment.id);
    await supabase.from('tickets').update({ status: 'paid' }).eq('payment_id', payment.id);
    return 'paid';
  }
  if ((data.status === 'FAILED' || data.status === 'EXPIRED') && payment.status === 'pending') {
    await supabase.from('payments').update({ status: 'failed' }).eq('id', payment.id);
    // A PHYSICAL ticket stays 'held' — it's already in someone's hand, so it must never
    // quietly become resellable; only an explicit Admin Void does that. An ONLINE ticket was
    // never physically handed to anyone, so an unpaid one is simply released back to its series.
    const { data: rows } = await supabase.from('tickets').select('id, ticket_blocks!inner(type)').eq('payment_id', payment.id);
    const onlineIds = (rows || []).filter(t => t.ticket_blocks.type === 'digital').map(t => t.id);
    if (onlineIds.length) await supabase.from('tickets').update({ status: 'unsold', tier_id: null, payment_id: null, sold_by: null, sold_at: null }).in('id', onlineIds);
    return 'failed';
  }
  return payment.status;
}

async function releaseStalePendingLinkPayments() {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
  const { data: stale } = await supabase.from('payments')
    .select('*').eq('method', 'link').eq('status', 'pending').lt('created_at', cutoff);
  for (const p of stale || []) {
    try { await syncCheckout(p); } catch { /* leave it for the next sweep rather than guessing */ }
  }
}

async function listCampaigns(session, { include_inactive } = {}) {
  requireOrgRole(session, ['seller', 'admin', 'superadmin']);
  // The database is an ocean away from the server, so every round trip counts: independent
  // queries run side by side rather than one after another. The expired-link sweep doesn't change
  // what this returns (campaigns, prices, series), so it overlaps the first query, and only runs
  // at most once a minute (sweepIfDue) instead of on every screen load.
  let q = supabase.from('campaigns').select('*').eq('org_id', session.org_id).eq('binned', false).order('created_at');
  if (!(include_inactive && session.role !== 'seller')) q = q.eq('active', true);
  const [{ data: campaigns }] = await Promise.all([q, sweepIfDue().catch(() => { /* housekeeping only */ })]);

  const campaignIds = campaigns.map(c => c.id);
  const [{ data: tiers }, { data: blocks }, disabledRes] = await Promise.all([
    campaignIds.length ? supabase.from('tiers').select('*').in('campaign_id', campaignIds).order('sort_order') : { data: [] },
    campaignIds.length ? supabase.from('ticket_blocks').select('*').in('campaign_id', campaignIds) : { data: [] },
    // A row here means this specific campaign is explicitly DISABLED for this user —
    // default is full access to every active campaign, unless a SuperAdmin switched one off.
    session.role === 'seller' ? supabase.from('user_campaigns').select('campaign_id').eq('user_id', session.uid) : { data: [] },
  ]);

  let visible = campaigns;
  if (session.role === 'seller') {
    const disabledIds = new Set(((disabledRes && disabledRes.data) || []).map(a => a.campaign_id));
    visible = campaigns.filter(c => !disabledIds.has(c.id));
  }

  return {
    campaigns: visible.map(c => ({
      ...c,
      tiers: tiers.filter(t => t.campaign_id === c.id),
      blocks: blocks.filter(b => b.campaign_id === c.id),
    })),
  };
}

async function setCampaignActive(session, { campaign_id, active }) {
  requireOrgRole(session, ['superadmin']);
  await requireCampaignsInOwnOrg(session, [campaign_id]);
  const { error } = await supabase.from('campaigns').update({ active }).eq('id', campaign_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}

// Binning is deliberately different from Inactive: Inactive campaigns still count in "All
// Campaigns" totals (their history really happened). Binned campaigns are excluded entirely
// from every dashboard and every seller's stats, as if they never existed for reporting
// purposes — while the underlying tickets/payments are kept, not wiped, so a mistaken bin
// can be undone and reports can still be pulled if needed.
async function binCampaign(session, { campaign_id }) {
  requireOrgRole(session, ['superadmin']);
  await requireCampaignsInOwnOrg(session, [campaign_id]);
  const { error } = await supabase.from('campaigns').update({ binned: true }).eq('id', campaign_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}
async function restoreCampaign(session, { campaign_id }) {
  requireOrgRole(session, ['superadmin']);
  await requireCampaignsInOwnOrg(session, [campaign_id]);
  // Force Inactive on restore — reactivating (making it sellable again) is a separate,
  // deliberate step, not an automatic side-effect of un-binning.
  const { error } = await supabase.from('campaigns').update({ binned: false, active: false }).eq('id', campaign_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}
async function listBinnedCampaigns(session) {
  requireOrgRole(session, ['superadmin']);
  const { data } = await supabase.from('campaigns').select('*').eq('org_id', session.org_id).eq('binned', true).order('created_at');
  return { campaigns: data };
}

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  let s = String(val);
  // A buyer's name comes from a public form. Spreadsheets treat a leading = + - @ as a formula,
  // so defuse those (leaving ordinary phone numbers and amounts alone).
  if (typeof val === 'string' && /^[=+\-@\t\r]/.test(s) && !/^[+-]?[0-9][0-9 ()-]*$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCampaignReport(session, { campaign_id }) {
  requireOrgRole(session, ['superadmin']);
  await requireCampaignsInOwnOrg(session, [campaign_id]);
  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaign_id).single();
  if (!campaign) throw httpError(404, 'Campaign not found');

  const { data: tiers } = await supabase.from('tiers').select('*').eq('campaign_id', campaign_id);
  const { data: blocks } = await supabase.from('ticket_blocks').select('*').eq('campaign_id', campaign_id);
  const tickets = await fetchAll(() => supabase.from('tickets').select('*').eq('campaign_id', campaign_id).order('ticket_number'));
  const payments = await fetchAll(() => supabase.from('payments').select('*').eq('campaign_id', campaign_id).order('id'));
  const { data: users } = await supabase.from('users').select('id,name');
  const userName = (id) => (users.find(u => u.id === id) || {}).name || '';
  const tierName = (id) => (tiers.find(t => t.id === id) || {}).name || '';
  const blockLabel = (id) => (blocks.find(b => b.id === id) || {}).label || '';
  const displayNumber = (t) => `${(blocks.find(b => b.id === t.block_id) || {}).number_prefix || ''}${t.ticket_number}`;
  const paymentById = {};
  for (const p of payments) paymentById[p.id] = p;

  const headers = [
    'Ticket Number', 'Display Number', 'Block', 'Tier', 'Ticket Status', 'Buyer Name', 'Method', 'Payment Amount',
    'Payment Status', 'Seller', 'Sold At', 'Cash Confirmed By', 'Cash Confirmed At',
    'Voided', 'Void Reason', 'SumUp Reference', 'SumUp Transaction Code', 'Link Sent To', 'Link Sent Via', 'Link Sent At',
  ];
  const rows = tickets.map(t => {
    const p = t.payment_id ? paymentById[t.payment_id] : null;
    return [
      t.ticket_number,
      displayNumber(t),
      blockLabel(t.block_id),
      tierName(t.tier_id),
      t.status,
      p ? p.payer_name || '' : '',
      p ? p.method : '',
      p ? Number(p.amount).toFixed(2) : '',
      p ? p.status : '',
      userName(t.sold_by),
      t.sold_at || '',
      p && p.cash_confirmed_by ? userName(p.cash_confirmed_by) : '',
      p && p.cash_confirmed_at ? p.cash_confirmed_at : '',
      p && p.voided ? 'Yes' : '',
      p ? p.void_reason || '' : '',
      p ? p.sumup_checkout_ref || '' : '',
      p ? p.sumup_transaction_code || '' : '',
      p ? p.contact_value || '' : '',
      p ? p.contact_channel || '' : '',
      p ? p.link_shared_at || '' : '',
    ];
  });

  const csv = [headers, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
  const filename = `${campaign.name.replace(/[^a-z0-9-]/gi, '_')}-report-${new Date().toISOString().slice(0, 10)}.csv`;
  return { csv, filename };
}

// ---------- Selling ----------

// A payment's seller_id is null exactly when a buyer purchased directly with no seller
// involved (see publicPurchase below) — a real, intentional case, distinct from "we have an
// id but can't find that user" (which would be a genuine data problem).
function sellerLabel(sellerId, users) {
  if (!sellerId) return 'Online (self-service)';
  const u = users.find(x => x.id === sellerId);
  return u ? u.name : 'Unknown';
}

// Fetch a ticket to check it's unsold & find it, without locking it yet. Works the same for
// a physical or online series now — both pre-populate real rows across a declared range.
async function checkTicket(session, { campaign_id, ticket_number }) {
  requireOrgRole(session, ['seller', 'admin', 'superadmin']);
  await requireCampaignsInOwnOrg(session, [campaign_id]);
  const { data } = await supabase.from('tickets').select('*')
    .eq('campaign_id', campaign_id).eq('ticket_number', ticket_number).maybeSingle();
  if (!data) throw httpError(404, `Ticket ${ticket_number} doesn't exist in this campaign`);
  if (data.status !== 'unsold') throw httpError(409, `Ticket ${ticket_number} is already ${data.status}`);
  return { ok: true };
}

// The same check for a whole run of numbers in ONE request (a seller selling 20 tickets used to
// send 20). Returns one result per number, in the order asked: { ticket_number, ok } or
// { ticket_number, ok: false, error } with the exact wording the single check uses.
const MAX_BATCH_CHECK = 200;
async function checkTickets(session, { campaign_id, ticket_numbers }) {
  requireOrgRole(session, ['seller', 'admin', 'superadmin']);
  await requireCampaignsInOwnOrg(session, [campaign_id]);
  if (!Array.isArray(ticket_numbers) || !ticket_numbers.length) throw httpError(400, 'No ticket numbers to check');
  if (ticket_numbers.length > MAX_BATCH_CHECK) throw httpError(400, `Check at most ${MAX_BATCH_CHECK} numbers at a time`);
  const nums = ticket_numbers.map(Number);
  if (nums.some(n => !Number.isInteger(n))) throw httpError(400, 'Ticket numbers must be whole numbers');
  const { data: rows } = await supabase.from('tickets').select('ticket_number, status').eq('campaign_id', campaign_id).in('ticket_number', nums);
  const statusByNum = Object.fromEntries((rows || []).map(r => [r.ticket_number, r.status]));
  const results = nums.map(n => {
    if (!(n in statusByNum)) return { ticket_number: n, ok: false, error: `Ticket ${n} doesn't exist in this campaign` };
    if (statusByNum[n] !== 'unsold') return { ticket_number: n, ok: false, error: `Ticket ${n} is already ${statusByNum[n]}` };
    return { ticket_number: n, ok: true };
  });
  return { results };
}

// tier_counts: { [tier_id]: count }. Exactly one of:
//   ticket_numbers   — specific numbers wanted (a "lucky number" pick, or physical's usual
//                      sequential entry). Resolved by campaign + number, not a pre-chosen
//                      block — a campaign can have more than one block of a type (e.g. a
//                      physical top-up, or a second online series).
//   auto_assign_block_id — "any available", claims the lowest-numbered unsold tickets in
//                      that one specific block (needed here since a campaign could have more
//                      than one pool to choose from).
// One buyer name covers the whole transaction.
// client_ref: a random reference the phone generates per sale attempt. If the reply is lost
// on a weak signal and the seller retries, the same reference makes this return the ORIGINAL
// sale rather than creating a second one (see replaySale).
async function recordSale(session, { campaign_id, tier_counts, ticket_numbers, auto_assign_block_id, method, payer_name, contact_value, client_ref }) {
  requireOrgRole(session, ['seller', 'admin', 'superadmin']);
  await requireCampaignsInOwnOrg(session, [campaign_id]);
  client_ref = cleanClientRef(client_ref);
  if (client_ref) {
    const replay = await replaySale(client_ref, session.uid);
    if (replay) return replay;
  }
  if (!['cash', 'machine', 'link'].includes(method)) throw httpError(400, 'Payment method must be cash, machine or link');
  if (!!ticket_numbers === !!auto_assign_block_id) {
    throw httpError(400, 'Specify either exact ticket numbers or a block to auto-assign from, not both or neither.');
  }

  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaign_id).single();
  if (!campaign) throw httpError(404, 'Campaign not found');
  const { data: tiers } = await supabase.from('tiers').select('*').eq('campaign_id', campaign_id);
  const { data: blocks } = await supabase.from('ticket_blocks').select('*').eq('campaign_id', campaign_id);

  const counts = tiers.map(t => ({ tier: t, count: Number(tier_counts[t.id]) || 0 }));
  const totalCount = counts.reduce((s, c) => s + c.count, 0);
  if (totalCount <= 0) throw httpError(400, 'Enter at least one ticket count');
  if (!Number.isInteger(totalCount) || counts.some(c => !Number.isInteger(c.count) || c.count < 0)) {
    throw httpError(400, 'Ticket counts must be whole numbers, zero or more.');
  }
  const buyerName = cleanName(payer_name, 'The buyer name');

  const tierIdSequence = [];
  counts.forEach(c => { for (let i = 0; i < c.count; i++) tierIdSequence.push(c.tier.id); });
  const amount = counts.reduce((s, c) => s + c.count * Number(c.tier.price), 0);

  // Cash/Machine/Link are all available for online tickets too, same as physical — the
  // trust model is identical whether a seller is standing there taking cash for a physical
  // ticket or an online lucky number, since it's the same seller vouching for it in person
  // either way. Link-only is a rule for an *unattended* sale (no seller present, e.g. a
  // future public buyer-direct page), not a rule about the ticket's type as such — this
  // action is only ever reachable by an authenticated seller/admin/superadmin, so that
  // restriction doesn't apply here.
  let autoAssignBlock = null;
  if (auto_assign_block_id) {
    autoAssignBlock = blocks.find(b => b.id === auto_assign_block_id);
    if (!autoAssignBlock) throw httpError(404, 'Ticket block not found in this campaign');
  } else if (!ticket_numbers.length || ticket_numbers.length !== totalCount) {
    throw httpError(400, `Entered ${ticket_numbers ? ticket_numbers.length : 0} ticket number(s) but ${totalCount} were specified — these must match.`);
  } else {
    // Picking a specific "lucky number" for an online ticket is reserved for the public
    // buyer page (/buy.html, via public_purchase) — this action is only ever reachable by an
    // authenticated seller/admin/superadmin, who always get the next available number(s)
    // instead, same as a physical seller working through their stack.
    const nums = ticket_numbers.map(Number);
    const { data: existingRows } = await supabase.from('tickets').select('block_id').eq('campaign_id', campaign_id).in('ticket_number', nums);
    const touchedBlockIds = new Set((existingRows || []).map(r => r.block_id));
    if (blocks.some(b => touchedBlockIds.has(b.id) && b.type === 'digital')) {
      throw httpError(400, 'Choosing a specific online ticket number is only available to buyers on the public purchase page — use "Any available" here instead.');
    }
  }
  // Who must be named. A PHYSICAL ticket handed over for cash or the card machine is already in the
  // buyer's hand, so name and contact are optional. A payment LINK needs both (that is who it goes to),
  // and an ONLINE ticket needs both whatever the payment method — it exists only on the buyer's phone,
  // so we must be able to send it to them and find them again.
  const isOnlineSale = !!(autoAssignBlock && autoAssignBlock.type === 'digital');
  const needsDetails = method === 'link' || isOnlineSale;
  if (needsDetails && !buyerName) {
    throw httpError(400, isOnlineSale ? "An online ticket needs the buyer's name — the ticket lives on their phone." : "Enter the buyer's name — the payment link is sent to them.");
  }
  if (needsDetails && !String(contact_value || '').trim() && method !== 'link') {
    throw httpError(400, "An online ticket needs the buyer's mobile number or email — that is where their ticket is sent.");
  }
  const contact = needsDetails ? parseContact(contact_value) : null;

  const initialStatus = method === 'cash' ? 'cash_pending' : (method === 'machine' ? 'paid' : 'held');

  const { data: payment, error: payErr } = await supabase.from('payments')
    .insert({ campaign_id, method, amount, status: 'pending', seller_id: session.uid, payer_name: buyerName || null, contact_value: contact ? contact.value : null, client_ref: client_ref || null })
    .select().single();
  if (payErr) {
    // Two copies of the same attempt raced each other: the unique client_ref let only one in.
    if (payErr.code === '23505' && client_ref) {
      const replay = await replaySale(client_ref, session.uid);
      if (replay) return replay;
    }
    throw httpError(500, payErr.message);
  }

  if (auto_assign_block_id) {
    const { error: claimErr } = await supabase.rpc('claim_lowest_available_tickets', {
      p_block_id: auto_assign_block_id, p_tier_ids: tierIdSequence, p_status: initialStatus, p_payment_id: payment.id, p_sold_by: session.uid,
    });
    if (claimErr) {
      await supabase.from('payments').update({ status: 'void', voided: true, void_reason: 'not enough tickets available' }).eq('id', payment.id);
      throw httpError(409, `Not enough tickets are available in "${autoAssignBlock.label}" right now — try a smaller quantity.`);
    }
  } else {
    // Atomic, all-or-nothing claim, resolved by campaign + ticket number rather than a
    // pre-chosen block. The DB function rolls back every update if even one requested ticket
    // isn't currently 'unsold', so there's no window where a crash or network blip could
    // leave a sale half-claimed.
    const items = ticket_numbers.map((num, i) => ({ ticket_number: Number(num), tier_id: tierIdSequence[i] }));
    const { error: claimErr } = await supabase.rpc('claim_specific_tickets', {
      p_campaign_id: campaign_id, p_items: items, p_status: initialStatus, p_payment_id: payment.id, p_sold_by: session.uid,
    });
    if (claimErr) {
      await supabase.from('payments').update({ status: 'void', voided: true, void_reason: 'ticket unavailable at claim time' }).eq('id', payment.id);
      // Figure out WHY the claim failed, so the message is accurate rather than assuming a
      // race — the far more common cause is a typo or wrong campaign selected. Nothing was
      // actually claimed (the function rolled itself back), so this reads fresh state.
      for (const num of ticket_numbers.map(Number)) {
        const { data: existing } = await supabase.from('tickets').select('status').eq('campaign_id', campaign_id).eq('ticket_number', num).maybeSingle();
        if (!existing) throw httpError(404, `Ticket ${num} doesn't exist in ${campaign.name} — check the campaign selected and the number entered.`);
        if (existing.status !== 'unsold') throw httpError(409, `Ticket ${num} is already ${existing.status} — sale cancelled, please recheck.`);
      }
      throw httpError(409, 'One or more tickets became unavailable — sale cancelled, please recheck.');
    }
  }

  // Read back exactly what was claimed — the caller (esp. an auto-assigned sale, whose
  // numbers it couldn't have known in advance) needs the real tickets, both to display them
  // and to restore an accurate Undo if the payment method was mis-tapped.
  const { data: soldTicketRows } = await supabase.from('tickets').select('ticket_number, tier_id, block_id').eq('payment_id', payment.id).order('ticket_number');
  const tierNameById = Object.fromEntries(tiers.map(t => [t.id, t.name]));
  const blockById = Object.fromEntries(blocks.map(b => [b.id, b]));
  const soldTickets = soldTicketRows.map(t => ({
    ticket_number: t.ticket_number, tier_id: t.tier_id, tier_name: tierNameById[t.tier_id],
    display_number: `${(blockById[t.block_id] || {}).number_prefix || ''}${t.ticket_number}`,
  }));

  if (method === 'cash') {
    await supabase.from('payments').update({ status: 'pending' }).eq('id', payment.id);
    return { ok: true, payment_id: payment.id, amount, method: 'cash', contact_value: contact ? contact.value : undefined, tickets: soldTickets };
  }
  if (method === 'machine') {
    // Tapped on the POS machine outside the church and already confirmed there — we're just logging it.
    await supabase.from('payments').update({ status: 'paid' }).eq('id', payment.id);
    return { ok: true, payment_id: payment.id, amount, method: 'machine', contact_value: contact ? contact.value : undefined, tickets: soldTickets };
  }

  // link: a fresh SumUp checkout for THIS sale. Its reference is this sale's own id, so every
  // payment SumUp reports can be matched back to exactly these tickets and this buyer.
  const created = await createSumupCheckout({ payment_id: payment.id, refSuffix: '', amount, campaignName: campaign.name, ticketNumbers: soldTickets.map(t => t.display_number) });
  if (!created.ok) {
    await releaseSaleTickets(payment.id);
    await supabase.from('payments').update({ status: 'void', voided: true, void_reason: 'could not create SumUp payment link' }).eq('id', payment.id);
    throw httpError(502, created.message);
  }
  await supabase.from('payments').update({ sumup_checkout_id: created.checkout_id, sumup_checkout_ref: created.ref, link_url: created.pay_url }).eq('id', payment.id);
  return { ok: true, payment_id: payment.id, amount, method: 'link', pay_url: created.pay_url, contact_value: contact.value, contact_kind: contact.kind, tickets: soldTickets };
}

// Returns the response an earlier attempt with this client_ref produced, or null if there was
// no such attempt. This is what makes a retry safe after a dropped connection: the sale either
// already happened (we hand back the same result) or it didn't (null, so the caller proceeds).
async function replaySale(client_ref, expectedSellerId) {
  const { data: p } = await supabase.from('payments').select('*').eq('client_ref', client_ref).maybeSingle();
  if (!p) return null;
  if ((p.seller_id || null) !== (expectedSellerId || null)) throw httpError(409, 'That reference has already been used.');
  if (p.status === 'void') {
    throw httpError(409, `That earlier attempt didn't go through${p.void_reason ? ` (${p.void_reason})` : ''} — please try again.`);
  }
  const { data: rows } = await supabase.from('tickets').select('ticket_number, tier_id, block_id').eq('payment_id', p.id).order('ticket_number');
  if (!rows || !rows.length || (p.method === 'link' && !p.link_url)) {
    throw httpError(409, 'This sale is still being processed — give it a few seconds, then check Recent sales before trying again.');
  }
  const { data: tiers } = await supabase.from('tiers').select('id, name').eq('campaign_id', p.campaign_id);
  const { data: blocks } = await supabase.from('ticket_blocks').select('id, number_prefix').eq('campaign_id', p.campaign_id);
  const tierNameById = Object.fromEntries((tiers || []).map(t => [t.id, t.name]));
  const prefixByBlock = Object.fromEntries((blocks || []).map(b => [b.id, b.number_prefix || '']));
  const tickets = rows.map(t => ({
    ticket_number: t.ticket_number, tier_id: t.tier_id, tier_name: tierNameById[t.tier_id],
    display_number: `${prefixByBlock[t.block_id] || ''}${t.ticket_number}`,
  }));
  const base = { ok: true, replayed: true, payment_id: p.id, amount: Number(p.amount), method: p.method, tickets };
  if (p.method !== 'link') return base;
  const contact = parseContact(p.contact_value);
  return { ...base, pay_url: p.link_url, contact_value: contact.value, contact_kind: contact.kind };
}

// ---------- Public buyer-direct purchase (no session, no seller) ----------
// Everything below is deliberately narrow: reachable only for a campaign that is active and
// not binned, only against its DIGITAL blocks (a physical ticket needs an in-person handover
// that doesn't exist in this flow), and always Pay by Link — there's no seller here to vouch
// for cash. Unlike the seller-attended recordSale above, a buyer here MAY pick a specific
// "lucky number" (see docs/scope-v1.0.md §13) — that restriction was about sellers, not
// online tickets as such.
const MAX_PUBLIC_PURCHASE_QTY = 20; // a sane per-transaction cap, not a business rule — guards
                                     // against a single automated request grabbing a whole series

// What a buyer sees before paying: campaign name/details, church name/address, tiers, and
// which online block(s) exist (with their range, so a lucky-number field can say what's valid).
async function publicCampaignInfo({ campaign_id }) {
  // This is the first thing every visitor waits for, so the three lookups run side by side (the
  // church details ride along with the campaign row) — one round trip to the database, not five.
  // It lists series and prices, not which numbers are free, so it has no need for the stale-hold sweep.
  const [{ data: campaign }, { data: tiers }, { data: blocks }] = await Promise.all([
    supabase.from('campaigns').select('id, name, details_text, org_id, organizations(name, address, thank_you_text)').eq('id', campaign_id).eq('active', true).eq('binned', false).maybeSingle(),
    supabase.from('tiers').select('id, name, price').eq('campaign_id', campaign_id).order('sort_order'),
    supabase.from('ticket_blocks').select('id, label, number_prefix, range_start, range_end').eq('campaign_id', campaign_id).eq('type', 'digital'),
  ]);
  if (!campaign) throw httpError(404, 'This campaign is not available for purchase right now.');
  if (!blocks || !blocks.length) throw httpError(400, 'This campaign has no online tickets available.');
  const org = campaign.organizations;
  return {
    campaign: { id: campaign.id, name: campaign.name, details_text: campaign.details_text },
    org: { name: org ? org.name : '', address: org ? org.address : '', thank_you: org ? org.thank_you_text : null },
    tiers, blocks,
  };
}

// Live "is this lucky number free" check for the public page — online tickets only.
async function publicCheckTicket({ campaign_id, ticket_number }) {
  const { data: campaign } = await supabase.from('campaigns').select('id').eq('id', campaign_id).eq('active', true).eq('binned', false).maybeSingle();
  if (!campaign) throw httpError(404, 'This campaign is not available for purchase right now.');
  const { data } = await supabase.from('tickets').select('status, ticket_blocks!inner(type)')
    .eq('campaign_id', campaign_id).eq('ticket_number', ticket_number).eq('ticket_blocks.type', 'digital').maybeSingle();
  if (!data) throw httpError(404, `Ticket ${ticket_number} doesn't exist in this campaign`);
  if (data.status !== 'unsold') throw httpError(409, `Ticket ${ticket_number} is already ${data.status}`);
  return { ok: true };
}

// The same check for several numbers in one request (the buy page's basket, max 20 — the
// per-purchase cap). Online tickets only. One result per number, in the order asked.
async function publicCheckTickets({ campaign_id, ticket_numbers }) {
  const { data: campaign } = await supabase.from('campaigns').select('id').eq('id', campaign_id).eq('active', true).eq('binned', false).maybeSingle();
  if (!campaign) throw httpError(404, 'This campaign is not available for purchase right now.');
  if (!Array.isArray(ticket_numbers) || !ticket_numbers.length) throw httpError(400, 'No ticket numbers to check');
  if (ticket_numbers.length > MAX_PUBLIC_PURCHASE_QTY) throw httpError(400, `Check at most ${MAX_PUBLIC_PURCHASE_QTY} numbers at a time`);
  const nums = ticket_numbers.map(Number);
  if (nums.some(n => !Number.isInteger(n))) throw httpError(400, 'Ticket numbers must be whole numbers');
  const { data: rows } = await supabase.from('tickets').select('ticket_number, status, ticket_blocks!inner(type)')
    .eq('campaign_id', campaign_id).eq('ticket_blocks.type', 'digital').in('ticket_number', nums);
  const statusByNum = Object.fromEntries((rows || []).map(r => [r.ticket_number, r.status]));
  return {
    results: nums.map(n => {
      if (!(n in statusByNum)) return { ticket_number: n, ok: false, error: `Ticket ${n} doesn't exist in this campaign` };
      if (statusByNum[n] !== 'unsold') return { ticket_number: n, ok: false, error: `Ticket ${n} is already taken` };
      return { ticket_number: n, ok: true };
    }),
  };
}

// The "shuffle" button: up to `count` random online numbers that are still free, skipping any
// the buyer already holds in their basket. These are suggestions only — nothing is reserved
// until they pay, and the purchase itself re-checks every number atomically.
async function publicRandomNumbers({ campaign_id, block_id, count, exclude }) {
  const [{ data: campaign }] = await Promise.all([
    supabase.from('campaigns').select('id').eq('id', campaign_id).eq('active', true).eq('binned', false).maybeSingle(),
    sweepIfDue().catch(() => { /* housekeeping only */ }),
  ]);
  if (!campaign) throw httpError(404, 'This campaign is not available for purchase right now.');
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PUBLIC_PURCHASE_QTY) throw httpError(400, `Ask for between 1 and ${MAX_PUBLIC_PURCHASE_QTY} numbers`);
  const skip = (Array.isArray(exclude) ? exclude : []).map(Number).filter(Number.isInteger).slice(0, 100);
  const { data, error } = await supabase.rpc('random_unsold_numbers', { p_campaign_id: campaign_id, p_block_id: block_id || null, p_count: n, p_exclude: skip });
  if (error) throw httpError(500, 'Could not pick numbers right now — please try again.');
  return { numbers: (data || []).map(Number) };
}

// Stops one visitor from tying up a whole series with unpaid purchases (each holds its numbers
// until the 30-minute payment link lapses). The ceilings are set so that a whole congregation
// sharing the church wifi is fine; they only bite on a flood.
const PUBLIC_MAX_HELD_PER_IP = 200, PUBLIC_MAX_PURCHASES_PER_IP_HOUR = 60, PUBLIC_MAX_OPEN_PER_CONTACT = 5;
async function enforcePublicPurchaseLimits(contactValue, qty) {
  if (clientIp) {
    const { data: open } = await supabase.from('payments').select('id').eq('client_ip', clientIp).eq('status', 'pending').is('seller_id', null);
    const ids = (open || []).map(p => p.id);
    if (ids.length) {
      const { count } = await supabase.from('tickets').select('id', { count: 'exact', head: true }).in('payment_id', ids);
      if ((count || 0) + qty > PUBLIC_MAX_HELD_PER_IP) {
        throw httpError(429, 'You already have several unpaid payments open. Please complete them, or wait for them to expire (30 minutes), before starting another.');
      }
    }
    if ((await rateHit(`pub:buy:${clientIp}`, 3600)) > PUBLIC_MAX_PURCHASES_PER_IP_HOUR) {
      throw httpError(429, 'Too many purchases from your connection just now — please wait a while and try again.');
    }
  }
  const { count: openForContact } = await supabase.from('payments').select('id', { count: 'exact', head: true }).eq('contact_value', contactValue).eq('status', 'pending').is('seller_id', null);
  if ((openForContact || 0) >= PUBLIC_MAX_OPEN_PER_CONTACT) {
    throw httpError(429, 'This mobile number or email already has several unpaid payments open — please complete them, or wait for them to expire (30 minutes).');
  }
}

// The purchase itself. block_id picks which online pool for "any available"; ticket_numbers
// is a buyer's own lucky-number pick — exactly one of the two, same contract as recordSale.
async function publicPurchase({ campaign_id, block_id, tier_counts, ticket_numbers, buyer_name, contact_value, client_ref }) {
  client_ref = cleanClientRef(client_ref);
  if (client_ref) {
    const replay = await replaySale(client_ref, null);
    if (replay) return replay;
  }
  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaign_id).eq('active', true).eq('binned', false).maybeSingle();
  if (!campaign) throw httpError(404, 'This campaign is not available for purchase right now.');
  const { data: tiers } = await supabase.from('tiers').select('*').eq('campaign_id', campaign_id);
  const { data: onlineBlocks } = await supabase.from('ticket_blocks').select('*').eq('campaign_id', campaign_id).eq('type', 'digital');
  if (!onlineBlocks || !onlineBlocks.length) throw httpError(400, 'This campaign has no online tickets available.');

  const counts = tiers.map(t => ({ tier: t, count: Number((tier_counts || {})[t.id]) || 0 }));
  const totalCount = counts.reduce((s, c) => s + c.count, 0);
  if (totalCount <= 0) throw httpError(400, 'Choose at least one ticket.');
  if (totalCount > MAX_PUBLIC_PURCHASE_QTY) throw httpError(400, `You can buy at most ${MAX_PUBLIC_PURCHASE_QTY} tickets in one purchase — please make a separate purchase for more.`);
  if (!Number.isInteger(totalCount) || counts.some(c => !Number.isInteger(c.count) || c.count < 0)) {
    throw httpError(400, 'Ticket counts must be whole numbers, zero or more.');
  }
  const buyerName = cleanName(buyer_name, 'Your name');
  if (!buyerName) throw httpError(400, 'Please enter your name.');
  const contact = parseContact(contact_value);
  await sweepIfDue();
  await enforcePublicPurchaseLimits(contact.value, totalCount);

  const tierIdSequence = [];
  counts.forEach(c => { for (let i = 0; i < c.count; i++) tierIdSequence.push(c.tier.id); });
  const amount = counts.reduce((s, c) => s + c.count * Number(c.tier.price), 0);

  const usingLuckyNumbers = !!(ticket_numbers && ticket_numbers.length);
  let targetBlock = null;
  if (!usingLuckyNumbers) {
    targetBlock = block_id ? onlineBlocks.find(b => b.id === block_id) : (onlineBlocks.length === 1 ? onlineBlocks[0] : null);
    if (!targetBlock) throw httpError(400, onlineBlocks.length > 1 ? 'Choose which ticket pool to buy from.' : 'That ticket pool is not available for this campaign.');
  } else if (ticket_numbers.length !== totalCount) {
    throw httpError(400, `Entered ${ticket_numbers.length} ticket number(s) but ${totalCount} were specified — these must match.`);
  }

  const { data: payment, error: payErr } = await supabase.from('payments')
    .insert({ campaign_id, method: 'link', amount, status: 'pending', seller_id: null, payer_name: buyerName, contact_value: contact.value, client_ref: client_ref || null, client_ip: clientIp || null })
    .select().single();
  if (payErr) {
    if (payErr.code === '23505' && client_ref) {
      const replay = await replaySale(client_ref, null);
      if (replay) return replay;
    }
    throw httpError(500, payErr.message);
  }

  if (usingLuckyNumbers) {
    const nums = ticket_numbers.map(Number);
    const onlineBlockIds = new Set(onlineBlocks.map(b => b.id));
    const { data: existingRows } = await supabase.from('tickets').select('ticket_number, block_id').eq('campaign_id', campaign_id).in('ticket_number', nums);
    const allOnline = existingRows.length === nums.length && existingRows.every(r => onlineBlockIds.has(r.block_id));
    if (!allOnline) {
      await supabase.from('payments').update({ status: 'void', voided: true, void_reason: 'requested number not a valid online ticket' }).eq('id', payment.id);
      throw httpError(400, 'One or more of those numbers are not valid online tickets for this campaign — please recheck.');
    }
    const items = ticket_numbers.map((num, i) => ({ ticket_number: Number(num), tier_id: tierIdSequence[i] }));
    const { error: claimErr } = await supabase.rpc('claim_specific_tickets', {
      p_campaign_id: campaign_id, p_items: items, p_status: 'held', p_payment_id: payment.id, p_sold_by: null,
    });
    if (claimErr) {
      await supabase.from('payments').update({ status: 'void', voided: true, void_reason: 'ticket unavailable at claim time' }).eq('id', payment.id);
      for (const num of nums) {
        const { data: existing } = await supabase.from('tickets').select('status').eq('campaign_id', campaign_id).eq('ticket_number', num).maybeSingle();
        if (!existing) throw httpError(404, `Ticket ${num} doesn't exist in this campaign.`);
        if (existing.status !== 'unsold') throw httpError(409, `Ticket ${num} is already ${existing.status} — please choose another.`);
      }
      throw httpError(409, 'One or more of those numbers became unavailable — please recheck.');
    }
  } else {
    const { error: claimErr } = await supabase.rpc('claim_lowest_available_tickets', {
      p_block_id: targetBlock.id, p_tier_ids: tierIdSequence, p_status: 'held', p_payment_id: payment.id, p_sold_by: null,
    });
    if (claimErr) {
      await supabase.from('payments').update({ status: 'void', voided: true, void_reason: 'not enough tickets available' }).eq('id', payment.id);
      throw httpError(409, `Not enough tickets are available right now — try a smaller quantity.`);
    }
  }

  const { data: soldTicketRows } = await supabase.from('tickets').select('ticket_number, tier_id, block_id').eq('payment_id', payment.id).order('ticket_number');
  const tierNameById = Object.fromEntries(tiers.map(t => [t.id, t.name]));
  const blockById = Object.fromEntries(onlineBlocks.map(b => [b.id, b]));
  const soldTickets = soldTicketRows.map(t => ({
    ticket_number: t.ticket_number, tier_name: tierNameById[t.tier_id],
    display_number: `${(blockById[t.block_id] || {}).number_prefix || ''}${t.ticket_number}`,
  }));

  const created = await createSumupCheckout({ payment_id: payment.id, refSuffix: '', amount, campaignName: campaign.name, ticketNumbers: soldTickets.map(t => t.display_number) });
  if (!created.ok) {
    await releaseSaleTickets(payment.id);
    await supabase.from('payments').update({ status: 'void', voided: true, void_reason: 'could not create SumUp payment link' }).eq('id', payment.id);
    throw httpError(502, created.message);
  }
  await supabase.from('payments').update({ sumup_checkout_id: created.checkout_id, sumup_checkout_ref: created.ref, link_url: created.pay_url }).eq('id', payment.id);
  return { ok: true, payment_id: payment.id, pay_url: created.pay_url, amount, tickets: soldTickets };
}

// Creates the SumUp hosted checkout for one sale. checkout_reference = this sale's id (plus a
// resend suffix), and return_url is where SumUp notifies us when the status changes.
//
// The reference is cosmetic, not load-bearing: reconciliation matches on SumUp's own
// checkout id (sumup_checkout_id), never on this string. So it's built purely to be
// readable on SumUp's own side — CAMPAIGN-SHORTID — so scanning the SumUp dashboard or
// export shows at a glance which campaign a payment belongs to, e.g. "RAFFLE2026-A1B2C3D4".
function campaignSlug(name) {
  return (name || 'CAMPAIGN').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 20) || 'CAMPAIGN';
}
// The church's name, so SumUp's payment page (and the receipt) says who is being paid.
async function orgNameForPayment(payment_id) {
  const { data: p } = await supabase.from('payments').select('campaign_id').eq('id', payment_id).maybeSingle();
  if (!p) return '';
  const { data: c } = await supabase.from('campaigns').select('org_id').eq('id', p.campaign_id).maybeSingle();
  if (!c) return '';
  const { data: o } = await supabase.from('organizations').select('name').eq('id', c.org_id).maybeSingle();
  return o ? o.name : '';
}
async function createSumupCheckout({ payment_id, refSuffix, amount, campaignName, ticketNumbers }) {
  const ref = `${campaignSlug(campaignName)}-${payment_id.slice(0, 8).toUpperCase()}${refSuffix}`;
  const orgName = await orgNameForPayment(payment_id);
  const resp = await fetch('https://api.sumup.com/v0.1/checkouts', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUMUP_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      checkout_reference: ref, amount: Number(amount), currency: 'GBP', merchant_code: SUMUP_MERCHANT_CODE,
      description: `${campaignName} — ticket${ticketNumbers.length > 1 ? 's' : ''} ${ticketNumbers.join(', ')}${orgName ? ` · ${orgName}` : ''}`,
      // SumUp has TWO different addresses and they must not be mixed up:
      //  - redirect_url: where the BUYER'S BROWSER is sent back to (SumUp's success page shows a
      //    button to it). Our ticket page — carries this sale's own unguessable id, and the page
      //    discloses nothing sensitive.
      //  - return_url: a BACKEND callback; SumUp POSTs here when the payment's status changes.
      // (Both were once wrongly the ticket page, so buyers ended on SumUp's page with no way back
      // and SumUp's notifications went to a page that cannot receive them.)
      redirect_url: `${baseUrl}/ticket.html?payment_id=${payment_id}`,
      return_url: `${baseUrl}/api/sumup_webhook`,
      hosted_checkout: { enabled: true },
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { ok: false, message: `SumUp checkout creation failed (HTTP ${resp.status}): ${data.message || data.error_message || data.error || JSON.stringify(data) || resp.statusText}` };
  }
  if (!data.hosted_checkout_url) return { ok: false, message: 'SumUp created the checkout but returned no payment link — check the SumUp account has hosted checkout enabled.' };
  return { ok: true, checkout_id: data.id, ref, pay_url: data.hosted_checkout_url };
}

// Public — deliberately no session required. This is what ticket.html calls after a buyer
// pays a link, to show them their own confirmation. Safe to expose without login because:
// (a) it's addressed only by the payment's own id, a random UUID that isn't guessable or
// enumerable; (b) it discloses nothing sensitive — no seller identity, no other buyers, no
// internal ids; (c) the paid/unpaid status always comes fresh from syncCheckout (SumUp
// itself), never from anything the caller claims.
async function publicPaymentStatus({ payment_id }) {
  if (!payment_id) throw httpError(400, 'payment_id is required');
  const { data: payment } = await supabase.from('payments').select('*, campaigns!inner(name, details_text, org_id)').eq('id', payment_id).maybeSingle();
  if (!payment) throw httpError(404, 'Sale not found');

  // Fetched BEFORE syncCheckout deliberately: an expired/failed ONLINE sale gets its ticket
  // rows released (cleared) by syncCheckout, so reading them first captures what the buyer
  // was actually assigned — needed both to know physical-vs-online, and to still show them
  // which number they had even if it's since been let go.
  const { data: ticketRows } = await supabase.from('tickets').select('ticket_number, tier_id, block_id').eq('payment_id', payment_id);
  const { data: tiers } = await supabase.from('tiers').select('id, name').eq('campaign_id', payment.campaign_id);
  const { data: blocks } = await supabase.from('ticket_blocks').select('id, type, number_prefix').eq('campaign_id', payment.campaign_id);
  const blockById = Object.fromEntries((blocks || []).map(b => [b.id, b]));
  const tierNameById = Object.fromEntries((tiers || []).map(t => [t.id, t.name]));
  const tickets = (ticketRows || []).map(t => ({
    display_number: `${(blockById[t.block_id] || {}).number_prefix || ''}${t.ticket_number}`,
    tier_name: tierNameById[t.tier_id] || 'Ticket',
  }));
  const isPhysical = ticketRows && ticketRows.length ? blockById[ticketRows[0].block_id].type === 'physical' : true;

  // A link sale is only paid once SumUp says so. A seller-attended sale (cash / machine) has no
  // link to check: the seller took the money in person, so its ticket page shows as issued
  // unless the sale was voided — this is what lets an online ticket bought in person be kept too.
  let status;
  if (payment.method === 'link') status = payment.status === 'paid' ? 'paid' : await syncCheckout(payment);
  else status = payment.status === 'void' ? 'void' : 'paid';
  const { data: org } = await supabase.from('organizations').select('name, address, thank_you_text').eq('id', payment.campaigns.org_id).single();

  return {
    status, // 'paid' | 'pending' | 'failed' | 'void'
    is_physical: isPhysical,
    amount: Number(payment.amount),
    buyer_name: payment.payer_name,
    campaign_name: payment.campaigns.name,
    campaign_details: payment.campaigns.details_text,
    org_name: org ? org.name : '',
    org_address: org ? org.address : '',
    thank_you: org ? org.thank_you_text : null,
    tickets,
    sold_at: payment.created_at,
  };
}

// "Find my ticket": a buyer who paid but closed SumUp's page before coming back can look their
// ticket up again from the name and mobile/email they bought with. BOTH must match, it is limited
// to the one campaign whose page they are on, only link purchases are searched, and it is
// rate-limited per visitor and per contact — so it can't be used to browse other people's tickets.
const FIND_MAX_PER_HOUR = 10;
const sameName = (a, b) => String(a || '').trim().replace(/\s+/g, ' ').toLowerCase() === String(b || '').trim().replace(/\s+/g, ' ').toLowerCase();
async function publicFindTickets({ campaign_id, buyer_name, contact_value }) {
  if (clientIp && (await rateHit(`find:${clientIp}`, 3600)) > FIND_MAX_PER_HOUR) {
    throw httpError(429, 'Too many searches from your connection — please wait a while and try again.');
  }
  const name = cleanName(buyer_name, 'Your name');
  if (!name) throw httpError(400, 'Please enter your name.');
  const contact = parseContact(contact_value);
  if ((await rateHit(`find:c:${contact.value}`, 3600)) > FIND_MAX_PER_HOUR) {
    throw httpError(429, 'Too many searches for those details — please wait a while and try again.');
  }
  const { data: campaign } = await supabase.from('campaigns').select('id').eq('id', campaign_id).eq('binned', false).maybeSingle();
  if (!campaign) throw httpError(404, 'This campaign is not available.');

  const { data: rows } = await supabase.from('payments').select('id, amount, created_at, payer_name, status, method, sumup_checkout_id, campaign_id')
    .eq('campaign_id', campaign_id).eq('method', 'link').eq('contact_value', contact.value).in('status', ['paid', 'pending'])
    .order('created_at', { ascending: false }).limit(10);
  const mine = (rows || []).filter(p => sameName(p.payer_name, name));
  const purchases = [];
  let checked = 0;
  for (const p of mine) {
    let status = p.status;
    // Paid a moment ago and our records haven't caught up yet? Ask SumUp (a few at most).
    if (status === 'pending' && checked < 3) { checked++; try { status = await syncCheckout(p); } catch { /* leave it out this time */ } }
    if (status !== 'paid') continue;
    const { data: tix } = await supabase.from('tickets').select('ticket_number, block_id').eq('payment_id', p.id).order('ticket_number');
    const { data: blocks } = await supabase.from('ticket_blocks').select('id, number_prefix').eq('campaign_id', campaign_id);
    const prefix = Object.fromEntries((blocks || []).map(b => [b.id, b.number_prefix || '']));
    purchases.push({ payment_id: p.id, amount: Number(p.amount), sold_at: p.created_at, tickets: (tix || []).map(t => `${prefix[t.block_id] || ''}${t.ticket_number}`) });
  }
  return { purchases };
}

// Puts a sale's tickets back to unsold — physical and online alike, both are real
// pre-populated rows now, so releasing one is always a reset, never a delete.
async function releaseSaleTickets(payment_id) {
  await supabase.from('tickets').update({ status: 'unsold', tier_id: null, payment_id: null, sold_by: null, sold_at: null, attendee_name: null }).eq('payment_id', payment_id);
}

// A Pay-by-Link sale must record where the link went, so a physical ticket handed to someone
// can be tied to their mobile/email and its paid status pinpointed.
function parseContact(raw) {
  const v = String(raw || '').trim();
  if (v.length > MAX_CONTACT_LENGTH) throw httpError(400, 'That mobile number or email is too long.');
  if (!v) throw httpError(400, "Enter the buyer's mobile number or email — that's how we know who the payment link was sent to.");
  if (v.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw httpError(400, "That email address doesn't look right.");
    return { value: v.toLowerCase(), kind: 'email' };
  }
  const digits = v.replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 10) throw httpError(400, "That mobile number looks too short.");
  return { value: digits, kind: 'phone' };
}

// Self-service, no-reason-needed correction for a mis-tapped payment method (Cash vs Card) —
// distinct from voidSale below, which is the admin-only, reason-required audit-trail path for
// anything after this short window closes or once cash has been reconciled. Enforced
// server-side (not just a client-side timer) so the window can't be bypassed: only the
// selling seller, only within UNDO_WINDOW_SECONDS, only before reconciliation touches it.
const UNDO_WINDOW_SECONDS = 15; // a little more than the 8s countdown the UI shows, for network latency
async function undoSale(session, { payment_id }) {
  requireRole(session, ['seller', 'admin', 'superadmin']);
  const { data: payment } = await supabase.from('payments').select('*').eq('id', payment_id).single();
  if (!payment) throw httpError(404, 'Payment not found');
  if (payment.seller_id !== session.uid) throw httpError(403, 'You can only undo a sale you made yourself');
  if (payment.method === 'link') throw httpError(400, "A pay-by-link sale can't be undone — the link has already been created. Ask an Admin to Void it.");
  if (payment.status === 'void') throw httpError(400, 'Already voided');
  if (payment.cash_recon_batch_id) throw httpError(400, 'This sale has already been reconciled — ask an Admin to Void it instead.');
  const ageSeconds = (Date.now() - new Date(payment.created_at).getTime()) / 1000;
  if (ageSeconds > UNDO_WINDOW_SECONDS) throw httpError(400, 'The Undo window has passed — ask an Admin to Void it instead.');

  // Every block now pre-populates real rows, physical or online, so undoing a sale is always
  // just releasing those rows back to unsold — same numbers, ready to reclaim on resubmission.
  // (In practice this only ever runs for Cash/Machine: online tickets are link-only, and a
  // link sale can't reach here at all — see the check above.)
  await releaseSaleTickets(payment_id);
  await supabase.from('payments').delete().eq('id', payment_id);
  return { ok: true };
}

// Status of a Pay-by-Link sale. The SumUp notification normally updates it first; this asks
// SumUp directly as a fallback, so the seller's screen is right even if a notification is late.
async function checkoutStatus(session, { payment_id }) {
  requireOrgRole(session, ['seller', 'admin', 'superadmin']);
  const { data: payment } = await supabase.from('payments').select('*, campaigns!inner(org_id)').eq('id', payment_id).single();
  if (!payment || payment.campaigns.org_id !== session.org_id) throw httpError(404, 'Payment not found');
  if (payment.status === 'paid' || payment.status === 'failed' || payment.status === 'void') return { status: payment.status };
  return { status: await syncCheckout(payment) };
}

// SumUp calls this when a checkout's status changes. It is deliberately open (SumUp has no
// session), so it trusts nothing in the request: it only reads WHICH checkout changed, then
// re-fetches that checkout from SumUp with our own key and updates our records from that.
async function sumupWebhook(body) {
  // SumUp's notification shapes differ between products; the checkout id may sit under any of
  // these. Try each against OUR records — an id that isn't one of our checkouts simply matches
  // nothing, so a wrong guess is harmless.
  const candidates = [body.checkout_id, body.payload && body.payload.checkout_id, body.id, body.payload && body.payload.id]
    .filter(v => typeof v === 'string' && v.length > 0 && v.length < 100);
  if (!candidates.length) return { ok: true, ignored: 'no checkout id' };
  const { data: payment } = await supabase.from('payments').select('*').in('sumup_checkout_id', candidates).limit(1).maybeSingle();
  if (!payment) return { ok: true, ignored: 'unknown checkout' };
  const status = await syncCheckout(payment);
  return { ok: true, status };
}

// Diagnostic for SuperAdmins: proves the SumUp key can actually create payment links, so a
// permissions problem shows up here, on purpose, rather than in the middle of a real sale.
// Creates a £0.01 test checkout and immediately cancels it — no money moves.
async function sumupCheck(session) {
  requireOrgRole(session, ['superadmin']);
  const steps = [];
  if (!SUMUP_API_KEY) return { ok: false, steps: [{ step: 'API key', ok: false, detail: 'SUMUP_API_KEY is not set on the site.' }] };
  if (!SUMUP_MERCHANT_CODE) return { ok: false, steps: [{ step: 'Merchant code', ok: false, detail: 'SUMUP_MERCHANT_CODE is not set on the site.' }] };

  const me = await fetch('https://api.sumup.com/v0.1/me', { headers: { Authorization: `Bearer ${SUMUP_API_KEY}` } });
  const meData = await me.json().catch(() => ({}));
  steps.push({ step: 'API key accepted by SumUp', ok: me.ok, detail: me.ok ? `Account: ${(meData.merchant_profile && meData.merchant_profile.merchant_code) || 'ok'}` : `HTTP ${me.status} — ${meData.message || meData.error_message || 'rejected'}` });
  if (!me.ok) return { ok: false, steps };

  const ref = `PC-TEST-${Date.now()}`;
  const co = await fetch('https://api.sumup.com/v0.1/checkouts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUMUP_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkout_reference: ref, amount: 0.01, currency: 'GBP', merchant_code: SUMUP_MERCHANT_CODE, description: 'Connection test', redirect_url: `${baseUrl}/ticket.html`, return_url: `${baseUrl}/api/sumup_webhook`, hosted_checkout: { enabled: true } }),
  });
  const coData = await co.json().catch(() => ({}));
  steps.push({ step: 'Can create a payment link', ok: co.ok, detail: co.ok ? 'Yes' : `HTTP ${co.status} — ${coData.message || coData.error_message || JSON.stringify(coData)}` });
  steps.push({ step: 'Link is a shareable payment page', ok: !!coData.hosted_checkout_url, detail: coData.hosted_checkout_url ? 'Yes' : 'No hosted link returned — hosted checkout may not be enabled on the account.' });
  if (co.ok && coData.id) {
    // Buyers only get back to our ticket page if SumUp holds our redirect address. Read the
    // checkout back to see whether it does (SumUp may not repeat it, in which case only a real
    // payment can prove it — say so rather than claim a certainty we don't have).
    const back = await fetch(`https://api.sumup.com/v0.1/checkouts/${coData.id}`, { headers: { Authorization: `Bearer ${SUMUP_API_KEY}` } });
    const backData = await back.json().catch(() => ({}));
    const echoed = coData.redirect_url || backData.redirect_url;
    steps.push({ step: 'Buyers are sent back to our ticket page after paying', ok: !echoed || String(echoed).includes('/ticket.html'), detail: echoed ? `Yes — SumUp holds ${echoed}` : 'Sent to SumUp (it does not repeat this back, so a real payment is the only proof)' });
    const del = await fetch(`https://api.sumup.com/v0.1/checkouts/${coData.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${SUMUP_API_KEY}` } });
    steps.push({ step: 'Test checkout cancelled', ok: del.ok, detail: del.ok ? 'Yes — nothing left behind' : `HTTP ${del.status} (harmless — it will simply expire)` });
  }
  return { ok: steps.every(s => s.ok || s.step === 'Test checkout cancelled'), steps };
}

// Records HOW the payment link was sent (SMS / WhatsApp / Email) and when, alongside the
// contact it was addressed to, so a handed-over ticket can be pinned to a person and channel.
async function logLinkShared(session, { payment_id, channel }) {
  requireOrgRole(session, ['seller', 'admin', 'superadmin']);
  if (!['sms', 'whatsapp', 'email'].includes(channel)) throw httpError(400, 'channel must be sms, whatsapp or email');
  const { data: payment } = await supabase.from('payments').select('*, campaigns!inner(org_id)').eq('id', payment_id).single();
  if (!payment || payment.campaigns.org_id !== session.org_id) throw httpError(404, 'Payment not found');
  if (payment.method !== 'link') throw httpError(400, 'Only pay-by-link sales have a link to share');
  if (session.role === 'seller' && payment.seller_id !== session.uid) throw httpError(403, 'Not your sale');
  const isEmail = (payment.contact_value || '').includes('@');
  if (channel === 'email' && !isEmail) throw httpError(400, 'That contact is a mobile number, not an email.');
  if (channel !== 'email' && isEmail) throw httpError(400, 'That contact is an email, not a mobile number.');
  await supabase.from('payments').update({ contact_channel: channel, link_shared_at: new Date().toISOString() }).eq('id', payment_id);
  return { ok: true };
}

// Void is for correcting a sale where no money has actually moved yet: a mistaken Cash or
// Pay at Machine log (nothing electronic to unwind — any real refund happens by hand), or a
// Pay by Link sale that hasn't been paid. Once SumUp confirms a link was PAID, the buyer's
// money has genuinely moved, and voiding would silently return the ticket to the pool while
// they'd already paid for it — that must never be allowed from here; a real refund happens
// in SumUp directly. Re-checks with SumUp rather than trusting a possibly-stale DB status,
// in case a notification was delayed.
async function voidSale(session, { payment_id, reason }) {
  requireOrgRole(session, ['admin', 'superadmin']);
  if (!reason || !reason.trim()) throw httpError(400, 'A void reason is required');
  const { data: payment } = await supabase.from('payments').select('*, campaigns!inner(org_id)').eq('id', payment_id).single();
  if (!payment || payment.campaigns.org_id !== session.org_id) throw httpError(404, 'Payment not found');
  if (payment.status === 'void') throw httpError(400, 'Already voided');
  if (payment.method === 'link') {
    const status = await syncCheckout(payment);
    const paidMsg = "This has been paid via SumUp — a paid Pay by Link sale can't be voided here. Refund it directly in SumUp if needed.";
    if (status === 'paid') throw httpError(400, paidMsg);
    if (status === 'pending' && payment.sumup_checkout_id) {
      // Still-open link: close it so the buyer can't pay for a sale that's being voided. If
      // SumUp refuses because it was paid a moment ago, the re-check catches that; any other
      // failure doesn't block the void (a late payment is flagged loudly by syncCheckout).
      const cancelled = await cancelSumupCheckout(payment.sumup_checkout_id);
      if (!cancelled.ok && (await syncCheckout(payment)) === 'paid') throw httpError(400, paidMsg);
    }
  }
  await supabase.from('tickets').update({ status: 'unsold', tier_id: null, payment_id: null, sold_by: null, sold_at: null, attendee_name: null }).eq('payment_id', payment_id);
  await supabase.from('payments').update({ status: 'void', voided: true, voided_by: session.uid, voided_at: new Date().toISOString(), void_reason: reason }).eq('id', payment_id);
  return { ok: true };
}

// Lump-sum cash reconciliation: oldest-first greedy match against a seller's pending cash payments
async function cashRecon(session, { seller_id, campaign_id, amount_received }) {
  requireOrgRole(session, ['admin', 'superadmin']);
  if (!campaign_id) throw httpError(400, 'A campaign must be selected — cash is reconciled per campaign, not lumped together');
  await requireCampaignsInOwnOrg(session, [campaign_id]);
  const { data: pending } = await supabase.from('payments')
    .select('*').eq('seller_id', seller_id).eq('campaign_id', campaign_id).eq('method', 'cash').eq('status', 'pending')
    .order('created_at', { ascending: true });

  let remaining = Number(amount_received);
  const matched = [];
  for (const p of pending || []) {
    if (remaining + 1e-9 >= Number(p.amount)) {
      matched.push(p);
      remaining = Math.round((remaining - Number(p.amount)) * 100) / 100;
    } else break;
  }

  const stillPendingRows = (pending || []).slice(matched.length);
  // A leftover amount only means genuine surplus if there's nothing left to apply it to.
  // If sales are still pending, that leftover is a partial/insufficient payment toward the
  // *next* one, not "extra money" — mislabeling this as surplus was actively misleading.
  const isSurplus = remaining > 0 && stillPendingRows.length === 0;
  const isShortfall = remaining > 0 && stillPendingRows.length > 0;

  const { data: reconRow, error } = await supabase.from('cash_recon').insert({
    seller_id, campaign_id, amount_received, confirmed_by: session.uid,
    fully_matched: remaining === 0,
    surplus_amount: isSurplus ? remaining : 0,
    shortfall_amount: isShortfall ? remaining : 0,
  }).select().single();
  if (error) throw httpError(500, error.message);

  for (const p of matched) {
    await supabase.from('payments').update({ status: 'paid', cash_confirmed_by: session.uid, cash_confirmed_at: new Date().toISOString(), cash_recon_batch_id: reconRow.id }).eq('id', p.id);
    await supabase.from('tickets').update({ status: 'paid' }).eq('payment_id', p.id);
  }

  return {
    ok: true,
    matched_count: matched.length,
    matched_amount: matched.reduce((s, p) => s + Number(p.amount), 0),
    surplus: isSurplus ? remaining : 0,
    shortfall: isShortfall ? remaining : 0,
    still_pending: stillPendingRows.map(p => ({ id: p.id, amount: p.amount, created_at: p.created_at })),
  };
}

// Any Pay-by-Link payment still marked pending is asked about at SumUp before a list or total is
// built, so money that has actually arrived never keeps showing as "Pending" (SumUp's notification
// can be late, or missed). Bounded — newest 15, and paid/failed ones are never re-asked — so
// opening a screen can't fan out into a flood of SumUp calls.
async function syncOpenLinkPayments(campaignIds) {
  if (!campaignIds || !campaignIds.length) return;
  const { data: open } = await supabase.from('payments').select('*').in('campaign_id', campaignIds)
    .eq('method', 'link').eq('status', 'pending').not('sumup_checkout_id', 'is', null)
    .order('created_at', { ascending: false }).limit(15);
  await Promise.all((open || []).map(p => syncCheckout(p).catch(() => { /* leave it pending; the next look will try again */ })));
}

async function dashboardState(session, { campaign_id } = {}) {
  requireOrgRole(session, ['admin', 'superadmin']);
  await releaseStalePendingLinkPayments();

  const { data: orgCampaigns } = await supabase.from('campaigns').select('id').eq('org_id', session.org_id).eq('binned', false);
  const orgCampaignIds = orgCampaigns.map(c => c.id);
  await syncOpenLinkPayments(campaign_id ? [campaign_id].filter(id => orgCampaignIds.includes(id)) : orgCampaignIds);
  const scopedIds = campaign_id ? [campaign_id] : orgCampaignIds;
  if (campaign_id && !orgCampaignIds.includes(campaign_id)) throw httpError(404, 'Campaign not found');

  // Ticket totals are counted by the database (grouped by status and tier) — a campaign has far more
  // than the 1,000 rows one request can return.
  const [{ data: rollup, error: rollupError }, payments, { data: users }, { data: tiers }] = await Promise.all([
    supabase.rpc('ticket_rollup', { p_campaign_ids: scopedIds }),
    fetchAll(() => supabase.from('payments').select('*').in('campaign_id', scopedIds).neq('status', 'void').order('id')),
    supabase.from('users').select('id,name,role').eq('org_id', session.org_id),
    supabase.from('tiers').select('id, name, price, campaign_id').in('campaign_id', scopedIds),
  ]);
  if (rollupError) throw httpError(500, rollupError.message);
  const countWhere = (pred) => (rollup || []).filter(pred).reduce((s, r) => s + Number(r.n), 0);

  const soldStatuses = ['paid', 'cash_pending', 'held'];
  const sold = countWhere(r => soldStatuses.includes(r.status));
  const unsold = countWhere(r => r.status === 'unsold');

  // Roll up by tier NAME (not id) so "All Campaigns" sensibly combines e.g. every
  // campaign's own "Adult" tier into one line, even though each has a distinct tier row.
  const tierById = {};
  for (const t of tiers) tierById[t.id] = t;
  const tierBreakdown = {};
  for (const r of (rollup || []).filter(r => soldStatuses.includes(r.status))) {
    const tier = tierById[r.tier_id];
    const name = tier ? tier.name : 'Unknown';
    tierBreakdown[name] = tierBreakdown[name] || { name, soldCount: 0, amount: 0 };
    tierBreakdown[name].soldCount += Number(r.n);
    tierBreakdown[name].amount += (tier ? Number(tier.price) : 0) * Number(r.n);
  }

  const cardTotal = payments.filter(p => (p.method === 'link' && p.status === 'paid') || p.method === 'machine').reduce((s, p) => s + Number(p.amount), 0);
  const cashConfirmed = payments.filter(p => p.method === 'cash' && p.status === 'paid').reduce((s, p) => s + Number(p.amount), 0);
  const cashPending = payments.filter(p => p.method === 'cash' && p.status === 'pending').reduce((s, p) => s + Number(p.amount), 0);
  const cashTotal = cashConfirmed + cashPending;
  const totalCollected = cardTotal + cashTotal;

  const sellerMap = {};
  for (const p of payments) {
    if (p.status === 'failed' || p.status === 'void') continue;
    const key = sellerLabel(p.seller_id, users);
    sellerMap[key] = sellerMap[key] || { card: 0, cash_confirmed: 0, cash_pending: 0 };
    if ((p.method === 'link' && p.status === 'paid') || p.method === 'machine') sellerMap[key].card += Number(p.amount);
    if (p.method === 'cash' && p.status === 'paid') sellerMap[key].cash_confirmed += Number(p.amount);
    if (p.method === 'cash' && p.status === 'pending') sellerMap[key].cash_pending += Number(p.amount);
  }

  // integrity check
  const total = countWhere(() => true);
  const paidCount = countWhere(r => r.status === 'paid');
  const cashPendingCount = countWhere(r => r.status === 'cash_pending');
  const heldCount = countWhere(r => r.status === 'held');
  const integrityOk = (unsold + paidCount + cashPendingCount + heldCount) === total;

  return {
    sold, unsold, total, heldCount,
    tierBreakdown: Object.values(tierBreakdown),
    totalCollected, cardTotal, cashTotal, cashConfirmed, cashPending,
    linkPending: payments.filter(p => p.method === 'link' && p.status === 'pending').reduce((s, p) => s + Number(p.amount), 0),
    sellerBreakdown: sellerMap,
    integrityOk,
  };
}

// Shows tickets grouped by tier ("Adult: 1, 2 · Child: 3, 4") rather than concatenating a
// letter onto each number by default — the number shown is exactly the block's own display
// number (raw for physical, prefixed for an online series, e.g. "O15221"), never invented.
function groupTicketsForDisplay(payment, allTickets, tiers, blocks) {
  const mine = allTickets.filter(t => t.payment_id === payment.id);
  const byTier = {};
  for (const t of mine) {
    const tier = tiers.find(x => x.id === t.tier_id);
    const block = blocks.find(x => x.id === t.block_id);
    const name = tier ? tier.name : 'Unknown';
    const num = `${(block && block.number_prefix) || ''}${t.ticket_number}`;
    (byTier[name] = byTier[name] || []).push(num);
  }
  return Object.entries(byTier).map(([name, nums]) => `${name}: ${nums.join(', ')}`);
}

async function listRecentPayments(session, { campaign_id } = {}) {
  requireOrgRole(session, ['admin', 'superadmin']);
  const { data: orgCampaigns } = await supabase.from('campaigns').select('id').eq('org_id', session.org_id).eq('binned', false);
  const orgCampaignIds = orgCampaigns.map(c => c.id);
  await syncOpenLinkPayments(campaign_id ? [campaign_id].filter(id => orgCampaignIds.includes(id)) : orgCampaignIds);
  let q = supabase.from('payments').select('*').order('created_at', { ascending: false }).limit(75);
  q = campaign_id ? q.eq('campaign_id', campaign_id) : q.in('campaign_id', orgCampaignIds);
  const { data: payments } = await q;
  const { data: users } = await supabase.from('users').select('id,name');
  const tickets = await ticketsForPayments(payments.map(p => p.id), 'payment_id, ticket_number, tier_id, block_id, attendee_name');
  const { data: tiers } = await supabase.from('tiers').select('id, name');
  const { data: blocks } = await supabase.from('ticket_blocks').select('id, number_prefix');
  const out = payments.map(p => ({
    id: p.id,
    seller: sellerLabel(p.seller_id, users),
    method: p.method, amount: p.amount, status: p.status,
    payer_name: p.payer_name, contact_value: p.contact_value, contact_channel: p.contact_channel,
    created_at: p.created_at,
    tickets: groupTicketsForDisplay(p, tickets, tiers, blocks),
  }));
  return { payments: out };
}

async function listIncompletePayments(session, { campaign_id } = {}) {
  requireOrgRole(session, ['admin', 'superadmin']);
  await releaseStalePendingLinkPayments();
  const { data: orgCampaigns } = await supabase.from('campaigns').select('id').eq('org_id', session.org_id).eq('binned', false);
  const orgCampaignIds = orgCampaigns.map(c => c.id);
  await syncOpenLinkPayments(campaign_id ? [campaign_id].filter(id => orgCampaignIds.includes(id)) : orgCampaignIds);
  let q = supabase.from('payments').select('*').eq('method', 'link').in('status', ['pending', 'failed']).order('created_at', { ascending: false });
  q = campaign_id ? q.eq('campaign_id', campaign_id) : q.in('campaign_id', orgCampaignIds);
  const { data: payments } = await q;
  const { data: users } = await supabase.from('users').select('id,name');
  const tickets = await ticketsForPayments((payments || []).map(p => p.id), 'payment_id, ticket_number, tier_id, block_id');
  const { data: tiers } = await supabase.from('tiers').select('id, name');
  const { data: blocks } = await supabase.from('ticket_blocks').select('id, number_prefix');
  const out = (payments || []).map(p => ({
    id: p.id,
    seller: sellerLabel(p.seller_id, users),
    payer_name: p.payer_name,
    contact_value: p.contact_value, contact_channel: p.contact_channel, link_url: p.link_url, link_shared_at: p.link_shared_at,
    amount: p.amount,
    status: p.status, // 'pending' = link issued, not yet paid. 'failed' = expired/declined, needs resend.
    created_at: p.created_at,
    resend_count: p.resend_count,
    tickets: groupTicketsForDisplay(p, tickets, tiers, blocks),
  }));
  return { payments: out };
}

// A wrong mobile/email typed at the sale: fix it (the link itself is unchanged and, if still live,
// can simply be sent again to the right person). A seller can only touch their own sale; nothing
// that is already paid or voided.
async function updateLinkContact(session, { payment_id, contact_value }) {
  requireOrgRole(session, ['seller', 'admin', 'superadmin']);
  const { data: payment } = await supabase.from('payments').select('*, campaigns!inner(org_id)').eq('id', payment_id).single();
  if (!payment || payment.campaigns.org_id !== session.org_id) throw httpError(404, 'Payment not found');
  if (session.role === 'seller' && payment.seller_id !== session.uid) throw httpError(403, 'You can only change the details on your own sale.');
  if (payment.method !== 'link') throw httpError(400, 'Only pay-by-link sales have a contact to change');
  if (payment.status === 'paid' || payment.status === 'void') throw httpError(400, `This payment is already ${payment.status} — there is nothing left to send.`);
  const contact = parseContact(contact_value);
  await supabase.from('payments').update({ contact_value: contact.value, contact_channel: null, link_shared_at: null }).eq('id', payment_id);
  return { ok: true, contact_value: contact.value, contact_kind: contact.kind, pay_url: payment.link_url, status: payment.status };
}

// The signed-in person's OWN pay-by-link sales that are still unpaid, however long ago — so a buyer
// who comes back a week later ("here's my ticket, I still need to pay") can be given a fresh link.
// A physical ticket stays held for its buyer, so an expired link only needs a fresh one; an online
// ticket whose link expired has been released and is not listed.
async function myOpenLinks(session) {
  requireOrgRole(session, ['seller', 'admin', 'superadmin']);
  const { data: orgCampaigns } = await supabase.from('campaigns').select('id, name').eq('org_id', session.org_id).eq('binned', false);
  const campaignName = Object.fromEntries((orgCampaigns || []).map(c => [c.id, c.name]));
  await syncOpenLinkPayments(Object.keys(campaignName));
  const { data: payments } = await supabase.from('payments').select('*').eq('seller_id', session.uid).eq('method', 'link')
    .in('status', ['pending', 'failed']).in('campaign_id', Object.keys(campaignName)).order('created_at', { ascending: false }).limit(60);
  const list = payments || [];
  const [tickets, { data: blocks }] = await Promise.all([
    ticketsForPayments(list.map(p => p.id), 'payment_id, ticket_number, block_id'),
    supabase.from('ticket_blocks').select('id, number_prefix, type'),
  ]);
  const typeByBlock = Object.fromEntries((blocks || []).map(b => [b.id, b.type]));
  const out = list.map(p => {
    const mine = tickets.filter(t => t.payment_id === p.id);
    return {
      id: p.id, campaign_id: p.campaign_id, campaign_name: campaignName[p.campaign_id],
      payer_name: p.payer_name, contact_value: p.contact_value, link_url: p.link_url,
      amount: p.amount, status: p.status, created_at: p.created_at,
      link_shared_at: p.link_shared_at, contact_channel: p.contact_channel, resend_count: p.resend_count,
      is_online: mine.some(t => typeByBlock[t.block_id] === 'digital'),
      numbers: mine.sort((a, b) => a.ticket_number - b.ticket_number).map(t => {
        const b = (blocks || []).find(x => x.id === t.block_id); return `${(b && b.number_prefix) || ''}${t.ticket_number}`;
      }),
      tickets_held: mine.length,
    };
  }).filter(p => p.tickets_held > 0);   // an expired online sale (tickets already released) has nothing left to pay for
  return { links: out };
}

// Cancels a still-open SumUp checkout so its link can no longer be paid. SumUp refuses (non-2xx)
// if the checkout has already been paid, which is exactly the signal callers need.
async function cancelSumupCheckout(checkoutId) {
  try {
    const r = await fetch(`https://api.sumup.com/v0.1/checkouts/${checkoutId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${SUMUP_API_KEY}` } });
    return { ok: r.ok, status: r.status };
  } catch { return { ok: false, status: 0 }; }
}

// Who may resend: an Admin/SuperAdmin any link sale in their church; a Seller only their OWN
// sale of PHYSICAL tickets whose link is dead (expired/failed). Either way a new link is only
// ever issued when the old one can no longer be paid — never two live links for one sale.
async function resendPayment(session, { payment_id }) {
  requireOrgRole(session, ['seller', 'admin', 'superadmin']);
  const isSeller = session.role === 'seller';
  const { data: payment } = await supabase.from('payments').select('*, campaigns!inner(org_id, name)').eq('id', payment_id).single();
  if (!payment || payment.campaigns.org_id !== session.org_id) throw httpError(404, 'Payment not found');
  if (isSeller && payment.seller_id !== session.uid) throw httpError(403, 'You can only resend a link for your own sale.');
  if (payment.method !== 'link') throw httpError(400, 'Only pay-by-link sales can have their link resent');
  if (payment.status === 'paid' || payment.status === 'void') throw httpError(400, `Cannot resend — this payment is already ${payment.status}`);

  // If the old checkout was actually paid (e.g. the notification was late), don't issue a
  // second link. Note: this may also release online tickets back to unsold right here if
  // SumUp now reports them failed/expired (see syncCheckout) — checked next.
  const current = await syncCheckout(payment);
  if (current === 'paid') throw httpError(400, 'That payment has just come through — no need to resend.');

  // A physical ticket stays 'held' on failure/expiry (still tied to this payment, ready to
  // reclaim for a fresh link). An online ticket is released immediately instead — nobody's
  // physically holding it — so by the time an Admin resends, those numbers may already be
  // gone to someone else. Detect that rather than silently reissuing numbers that moved on.
  const { data: currentTickets } = await supabase.from('tickets').select('*').eq('payment_id', payment.id);
  if (!currentTickets || !currentTickets.length) {
    throw httpError(400, "These tickets have already been released back to the series (an unpaid online ticket frees up once its link expires) — start a new sale for this buyer instead.");
  }

  if (isSeller) {
    const { data: blocksForType } = await supabase.from('ticket_blocks').select('id, type').eq('campaign_id', payment.campaign_id);
    const typeById = Object.fromEntries((blocksForType || []).map(b => [b.id, b.type]));
    if (currentTickets.some(t => typeById[t.block_id] === 'digital')) throw httpError(400, 'An online ticket can’t be resent — start a new sale for this buyer instead.');
  }

  // The old link is still open (unpaid, not yet expired). Issuing a second link now would leave
  // two payable links for one sale. A seller just re-shares the existing link; an Admin
  // deliberately replacing it has the old one cancelled first (SumUp refuses if it was just paid).
  if (current === 'pending') {
    if (isSeller) throw httpError(400, 'That link is still live — just send the same link again. A fresh one can be made once it expires.');
    const cancelled = await cancelSumupCheckout(payment.sumup_checkout_id);
    if (!cancelled.ok) {
      const again = await syncCheckout(payment);
      if (again === 'paid') throw httpError(400, 'That payment has just come through — no need to resend.');
      throw httpError(502, `Couldn't cancel the old link at SumUp (HTTP ${cancelled.status}), so no new link was issued — try again in a moment.`);
    }
  }

  for (const t of currentTickets) {
    await supabase.from('tickets').update({ status: 'held', payment_id: payment.id, sold_by: session.uid, sold_at: new Date().toISOString() }).eq('id', t.id);
  }

  const { data: blocks } = await supabase.from('ticket_blocks').select('id, number_prefix').eq('campaign_id', payment.campaign_id);
  const prefixByBlock = Object.fromEntries((blocks || []).map(b => [b.id, b.number_prefix || '']));
  const created = await createSumupCheckout({
    payment_id: payment.id, refSuffix: `-R${payment.resend_count + 1}`, amount: payment.amount,
    campaignName: payment.campaigns.name,
    ticketNumbers: currentTickets.sort((a, b) => a.ticket_number - b.ticket_number).map(t => `${prefixByBlock[t.block_id] || ''}${t.ticket_number}`),
  });
  if (!created.ok) throw httpError(502, created.message);

  await supabase.from('payments').update({
    status: 'pending', sumup_checkout_id: created.checkout_id, sumup_checkout_ref: created.ref, link_url: created.pay_url,
    resend_count: payment.resend_count + 1, link_shared_at: null, contact_channel: null,
  }).eq('id', payment.id);

  return { ok: true, pay_url: created.pay_url, amount: payment.amount };
}

const RETENTION_DAYS = 90;

async function retentionFlags(session) {
  requireOrgRole(session, ['superadmin']);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: orgCampaigns } = await supabase.from('campaigns').select('id').eq('org_id', session.org_id);
  const orgCampaignIds = orgCampaigns.map(c => c.id);
  const { data: oldPayments } = await supabase.from('payments')
    .select('id, payer_name, contact_value, created_at').in('campaign_id', orgCampaignIds).or('payer_name.not.is.null,contact_value.not.is.null').lt('created_at', cutoff);
  const { data: oldTickets } = await supabase.from('tickets')
    .select('id, attendee_name, sold_at').in('campaign_id', orgCampaignIds).not('attendee_name', 'is', null).lt('sold_at', cutoff);
  return {
    count: (oldPayments || []).length + (oldTickets || []).length,
    payments: oldPayments || [],
    tickets: oldTickets || [],
  };
}

// Clears personal identifiers only (payer_name, contact_value, attendee_name). Amounts, ticket numbers,
// dates and totals are deliberately kept — churches typically need financial records
// retained for several years for accounting/Charity Commission purposes, even though
// GDPR says the personal data attached to them shouldn't linger past its purpose.
async function anonymizeOldData(session) {
  requireOrgRole(session, ['superadmin']);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: orgCampaigns } = await supabase.from('campaigns').select('id').eq('org_id', session.org_id);
  const orgCampaignIds = orgCampaigns.map(c => c.id);
  const { data: payments, error: e1 } = await supabase.from('payments')
    .update({ payer_name: null, contact_value: null }).in('campaign_id', orgCampaignIds).or('payer_name.not.is.null,contact_value.not.is.null').lt('created_at', cutoff).select();
  const { data: tickets, error: e2 } = await supabase.from('tickets')
    .update({ attendee_name: null }).in('campaign_id', orgCampaignIds).not('attendee_name', 'is', null).lt('sold_at', cutoff).select();
  if (e1 || e2) throw httpError(500, (e1 || e2).message);
  return { ok: true, payments_cleared: (payments || []).length, tickets_cleared: (tickets || []).length };
}

async function sellerState(session, { campaign_id } = {}) {
  requireRole(session, ['seller', 'admin', 'superadmin']);
  const payQ = () => { let q = supabase.from('payments').select('*').eq('seller_id', session.uid).neq('status', 'void').neq('status', 'failed').order('id'); if (campaign_id) q = q.eq('campaign_id', campaign_id); return q; };
  // The ticket total is a COUNT (the database only returns 1,000 rows at a time, so counting rows
  // would under-report a seller who has sold more than that). Both queries run side by side.
  let tixQ = supabase.from('tickets').select('id', { count: 'exact', head: true }).eq('sold_by', session.uid).neq('status', 'unsold');
  if (campaign_id) tixQ = tixQ.eq('campaign_id', campaign_id);
  const [payments, { count: ticketCount }] = await Promise.all([fetchAll(payQ), tixQ]);

  const ticketsSoldCount = ticketCount || 0;
  const cashConfirmed = payments.filter(p => p.method === 'cash' && p.status === 'paid').reduce((s, p) => s + Number(p.amount), 0);
  const cashPending = payments.filter(p => p.method === 'cash' && p.status === 'pending').reduce((s, p) => s + Number(p.amount), 0);
  const cashCollected = cashConfirmed + cashPending; // all cash sold, reconciled or not
  const cardTotal = payments.filter(p => (p.method === 'link' && p.status === 'paid') || p.method === 'machine').reduce((s, p) => s + Number(p.amount), 0);

  const linkPending = payments.filter(p => p.method === 'link' && p.status === 'pending').reduce((s, p) => s + Number(p.amount), 0);

  return { ticketsSoldCount, cashCollected, cashReconciled: cashConfirmed, cardTotal, linkPending };
}

// Everything the Sell screen needs in ONE round trip (it used to be three in a row), which
// matters on a weak signal. campaign_id is the seller's last-used campaign; if it's no longer
// available the first one is used, and the chosen id is returned so the phone stays in step.
async function sellScreen(session, { campaign_id } = {}) {
  // Campaigns, church details and this seller's stats don't depend on each other, so they load
  // side by side. The stats are fetched for the campaign the phone asked for; only if that
  // campaign is no longer available (so a different one is chosen) do they need fetching again.
  const [{ campaigns }, { organization }, guessedStats] = await Promise.all([
    listCampaigns(session),
    getOrgSettings(session),
    campaign_id ? sellerState(session, { campaign_id }) : Promise.resolve(null),
  ]);
  const chosen = campaigns.find(c => c.id === campaign_id) || campaigns[0] || null;
  let stats = null;
  if (chosen) stats = (chosen.id === campaign_id && guessedStats) ? guessedStats : await sellerState(session, { campaign_id: chosen.id });
  return { campaigns, organization, campaign_id: chosen ? chosen.id : null, stats };
}

// ---------- router ----------
const actions = {
  bootstrap_platform_owner: (s, b) => bootstrapPlatformOwner(b),
  create_organization: (s, b) => createOrganization(s, b),
  list_organizations: (s) => listOrganizations(s),
  platform_find_user: (s, b) => platformFindUser(s, b),
  platform_reset_superadmin_password: (s, b) => platformResetSuperadminPassword(s, b),
  platform_set_superadmin_active: (s, b) => platformSetSuperadminActive(s, b),

  login: (s, b) => login(b),
  create_user: (s, b) => createUser(s, b),
  set_user_active: (s, b) => setUserActive(s, b),
  reset_password: (s, b) => resetPassword(s, b),
  list_users: (s) => listUsers(s),

  get_org_settings: (s) => getOrgSettings(s),
  set_org_address: (s, b) => setOrgAddress(s, b),
  set_org_thank_you: (s, b) => setOrgThankYou(s, b),
  create_campaign: (s, b) => createCampaign(s, b),
  set_campaign_details: (s, b) => setCampaignDetails(s, b),
  list_campaigns: (s, b) => listCampaigns(s, b),
  set_disabled_campaigns: (s, b) => setDisabledCampaigns(s, b),
  set_campaign_active: (s, b) => setCampaignActive(s, b),
  sell_screen: (s, b) => sellScreen(s, b),
  add_block_to_campaign: (s, b) => addBlockToCampaign(s, b),
  bin_campaign: (s, b) => binCampaign(s, b),
  restore_campaign: (s, b) => restoreCampaign(s, b),
  list_binned_campaigns: (s) => listBinnedCampaigns(s),
  export_campaign_report: (s, b) => exportCampaignReport(s, b),

  check_ticket: (s, b) => checkTicket(s, b),
  check_tickets: (s, b) => checkTickets(s, b),
  record_sale: (s, b) => recordSale(s, b),
  checkout_status: (s, b) => checkoutStatus(s, b),
  public_payment_status: (s, b) => publicPaymentStatus(b),
  public_campaign_info: (s, b) => publicCampaignInfo(b),
  public_check_ticket: (s, b) => publicCheckTicket(b),
  public_check_tickets: (s, b) => publicCheckTickets(b),
  public_random_numbers: (s, b) => publicRandomNumbers(b),
  public_find_tickets: (s, b) => publicFindTickets(b),
  public_purchase: (s, b) => publicPurchase(b),
  log_link_shared: (s, b) => logLinkShared(s, b),
  sumup_check: (s) => sumupCheck(s),  sumup_webhook: (s, b) => sumupWebhook(b),
  undo_sale: (s, b) => undoSale(s, b),
  void_sale: (s, b) => voidSale(s, b),
  cash_recon: (s, b) => cashRecon(s, b),
  dashboard_state: (s, b) => dashboardState(s, b),
  list_recent_payments: (s, b) => listRecentPayments(s, b),
  list_incomplete_payments: (s, b) => listIncompletePayments(s, b),
  resend_payment: (s, b) => resendPayment(s, b),
  update_link_contact: (s, b) => updateLinkContact(s, b),
  my_open_links: (s) => myOpenLinks(s),
  retention_flags: (s) => retentionFlags(s),
  anonymize_old_data: (s) => anonymizeOldData(s),
  seller_state: (s, b) => sellerState(s, b),
};

const READ_ONLY_PUBLIC = new Set(['public_campaign_info', 'public_check_ticket', 'public_check_tickets']);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  // Where SumUp should send payment notifications — this deployment's own address.
  // Use the address the request actually came to, so a draft preview sends buyers back to the
  // preview and the live site to the live site. Only our own Netlify addresses (or the site's
  // configured address) are trusted; anything else falls back to the configured address.
  const reqHost = String(event.headers['x-forwarded-host'] || event.headers.host || '').split(',')[0].trim().toLowerCase();
  const configuredHost = process.env.URL ? new URL(process.env.URL).host.toLowerCase() : '';
  baseUrl = (/^[a-z0-9.-]+$/.test(reqHost) && (reqHost.endsWith('.netlify.app') || reqHost === configuredHost))
    ? `https://${reqHost}` : (process.env.URL || `https://${reqHost}`);
  clientIp = String(event.headers['x-nf-client-connection-ip'] || String(event.headers['x-forwarded-for'] || '').split(',')[0] || '').trim().slice(0, 64);
  const action = event.path.split('/').pop();
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const session = body.session ? verifySession(body.session) : null;
  if (body.session && !session) return json(401, { error: 'Session expired, please log in again' });

  const fn = actions[action];
  if (!fn) return json(404, { error: `Unknown action: ${action}` });

  try {
    const isPublic = action.startsWith('public_');
    // Public pages: a generous per-visitor ceiling on requests (a whole church on one wifi
    // still fits), there to stop scraping and floods rather than real buyers.
    const limited = () => httpError(429, 'Too many requests from your connection — please wait a few minutes and try again.');
    // A logged-in request must still belong to an active account with the password the token was made for.
    if (session && !isPublic && action !== 'sumup_webhook') await assertSessionLive(session);
    let result;
    if (isPublic && READ_ONLY_PUBLIC.has(action)) {
      // Pure look-ups change nothing, so the flood check and the look-up run at the same time
      // (a flooder simply gets the 429 and the answer is thrown away) — saves a database round trip.
      const [hits, r] = await Promise.all([rateHit(`pub:req:${clientIp}`, PUBLIC_REQ_WINDOW_SECONDS), fn(session, body).then(v => ({ v }), e => ({ e }))]);
      if (hits > PUBLIC_REQ_MAX) throw limited();
      if (r.e) throw r.e;
      result = r.v;
    } else {
      if (isPublic && (await rateHit(`pub:req:${clientIp}`, PUBLIC_REQ_WINDOW_SECONDS)) > PUBLIC_REQ_MAX) throw limited();
      result = await fn(session, body);
    }
    return json(200, result);
  } catch (e) {
    return json(e.status || 500, { error: e.message || 'Server error' });
  }
};
