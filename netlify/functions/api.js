// Parish Campaigns — backend API (generalized from BBQ Ticketing v3.10)
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
  if (sig !== expected) return null;
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
// that takes a campaign/user id against reaching across into another parish's data.
function requireOrgRole(session, roles) {
  requireRole(session, roles);
  if (!session.org_id) throw httpError(403, 'This action requires an Organization-scoped account');
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

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

// ---------- Auth & Users ----------

async function login({ mobile, password }) {
  const { data: user } = await supabase.from('users').select('*').eq('mobile', mobile).eq('active', true).maybeSingle();
  if (!user) throw httpError(401, 'Unknown mobile number or account disabled');
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw httpError(401, 'Incorrect password');
  const session = signSession({ uid: user.id, role: user.role, org_id: user.org_id, name: user.name, exp: Date.now() + 1000 * 60 * 60 * 2 });
  return { session, user: safeUser(user) };
}

function safeUser(u) { return { id: u.id, mobile: u.mobile, name: u.name, role: u.role, org_id: u.org_id }; }

async function createUser(session, { org_id, mobile, name, role, password, disabled_campaign_ids }) {
  // Platform Owner creates a new Organization's first SuperAdmin (org_id required, explicit).
  // A SuperAdmin creates Admins/Sellers/other SuperAdmins within their own org only —
  // org_id is never taken from the caller here, always the session's own, so a SuperAdmin
  // can never plant a user into a different parish.
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
  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('users')
    .insert({ mobile, name, role, org_id: targetOrgId, password_hash: hash, created_by: session.uid })
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

// ---------- Campaigns, Tiers, Ticket Blocks ----------

// tiers: [{ name, price }]  blocks: [{ type: 'physical'|'digital', label?, range_start?, range_end? }]
async function createCampaign(session, { name, tiers, blocks }) {
  requireOrgRole(session, ['superadmin']);
  if (!name || !name.trim()) throw httpError(400, 'Give the campaign a name');
  if (!tiers || !tiers.length) throw httpError(400, 'Add at least one price tier');
  if (!blocks || !blocks.length) throw httpError(400, 'Add at least one ticket block');
  for (const b of blocks) {
    if (b.type === 'physical') {
      if (b.range_start == null || b.range_end == null || b.range_end < b.range_start) {
        throw httpError(400, "A physical block's end must be after its start");
      }
    } else if (b.type !== 'digital') {
      throw httpError(400, `Unknown block type: ${b.type}`);
    }
  }

  const { data: campaign, error: campErr } = await supabase.from('campaigns')
    .insert({ org_id: session.org_id, name: name.trim(), created_by: session.uid })
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
      ? ((++digitalCount) === 1 ? 'Online' : `Online ${digitalCount}`)
      : (b.label && b.label.trim()) || 'Main';
    const { data: block, error: blockErr } = await supabase.from('ticket_blocks')
      .insert({
        campaign_id: campaign.id, type: b.type, label,
        range_start: isDigital ? null : b.range_start,
        range_end: isDigital ? null : b.range_end,
      })
      .select().single();
    if (blockErr) throw httpError(500, 'Campaign created but a ticket block failed: ' + blockErr.message);
    blockRows.push(block);

    // Physical blocks pre-populate every ticket number as 'unsold', same as the live BBQ build.
    // Digital blocks pre-populate nothing — numbers are minted at the moment of sale.
    if (!isDigital) {
      const rows = [];
      for (let n = b.range_start; n <= b.range_end; n++) rows.push({ campaign_id: campaign.id, block_id: block.id, ticket_number: n });
      for (let i = 0; i < rows.length; i += 500) {
        const { error: e2 } = await supabase.from('tickets').insert(rows.slice(i, i + 500));
        if (e2) throw httpError(500, 'Campaign created but ticket generation failed: ' + e2.message);
      }
    }
  }

  return { ok: true, campaign, tiers: tierRows, blocks: blockRows };
}

const STALE_MINUTES = 35; // SumUp hosted checkouts are valid ~30 min; give a small buffer

async function releaseStalePendingCardPayments() {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
  const { data: stale } = await supabase.from('payments')
    .select('*').eq('method', 'card').eq('status', 'pending').lt('created_at', cutoff);
  for (const p of stale || []) {
    if (!p.sumup_checkout_id) continue;
    try {
      const resp = await fetch(`https://api.sumup.com/v0.1/checkouts/${p.sumup_checkout_id}`, {
        headers: { 'Authorization': `Bearer ${SUMUP_API_KEY}` },
      });
      const data = await resp.json();
      if (data.status === 'PAID') {
        const tx = (data.transactions || [])[0] || {};
        await supabase.from('payments').update({ status: 'paid', sumup_transaction_code: tx.transaction_code || null, sumup_transaction_id: tx.id || null }).eq('id', p.id);
        await supabase.from('tickets').update({ status: 'paid' }).eq('payment_id', p.id);
      } else {
        // FAILED or EXPIRED: mark the payment failed so it surfaces in "Needs Attention" for a
        // resend, but the ticket itself stays 'held' — the physical ticket is already with someone,
        // so it must never quietly become resellable again. Only an explicit Admin Void does that.
        await supabase.from('payments').update({ status: 'failed' }).eq('id', p.id);
      }
    } catch { /* leave it for the next sweep rather than guessing */ }
  }
}

async function listCampaigns(session, { include_inactive } = {}) {
  requireOrgRole(session, ['seller', 'admin', 'superadmin']);
  await releaseStalePendingCardPayments();
  let q = supabase.from('campaigns').select('*').eq('org_id', session.org_id).eq('binned', false).order('created_at');
  if (!(include_inactive && session.role !== 'seller')) q = q.eq('active', true);
  const { data: campaigns } = await q;

  const campaignIds = campaigns.map(c => c.id);
  const { data: tiers } = campaignIds.length ? await supabase.from('tiers').select('*').in('campaign_id', campaignIds).order('sort_order') : { data: [] };
  const { data: blocks } = campaignIds.length ? await supabase.from('ticket_blocks').select('*').in('campaign_id', campaignIds) : { data: [] };

  let visible = campaigns;
  if (session.role === 'seller') {
    // A row here means this specific campaign is explicitly DISABLED for this user —
    // default is full access to every active campaign, unless a SuperAdmin switched one off.
    const { data: disabled } = await supabase.from('user_campaigns').select('campaign_id').eq('user_id', session.uid);
    const disabledIds = new Set((disabled || []).map(a => a.campaign_id));
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
  const s = String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCampaignReport(session, { campaign_id }) {
  requireOrgRole(session, ['superadmin']);
  await requireCampaignsInOwnOrg(session, [campaign_id]);
  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaign_id).single();
  if (!campaign) throw httpError(404, 'Campaign not found');

  const { data: tiers } = await supabase.from('tiers').select('*').eq('campaign_id', campaign_id);
  const { data: blocks } = await supabase.from('ticket_blocks').select('*').eq('campaign_id', campaign_id);
  const { data: tickets } = await supabase.from('tickets').select('*').eq('campaign_id', campaign_id).order('ticket_number');
  const { data: payments } = await supabase.from('payments').select('*').eq('campaign_id', campaign_id);
  const { data: users } = await supabase.from('users').select('id,name');
  const userName = (id) => (users.find(u => u.id === id) || {}).name || '';
  const tierName = (id) => (tiers.find(t => t.id === id) || {}).name || '';
  const blockLabel = (id) => (blocks.find(b => b.id === id) || {}).label || '';
  const paymentById = {};
  for (const p of payments) paymentById[p.id] = p;

  const headers = [
    'Ticket Number', 'Block', 'Tier', 'Ticket Status', 'Buyer Name', 'Method', 'Payment Amount',
    'Payment Status', 'Seller', 'Sold At', 'Cash Confirmed By', 'Cash Confirmed At',
    'Voided', 'Void Reason', 'SumUp Transaction Code', 'Has Photo Evidence',
  ];
  const rows = tickets.map(t => {
    const p = t.payment_id ? paymentById[t.payment_id] : null;
    return [
      t.ticket_number,
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
      p ? p.sumup_transaction_code || '' : '',
      p && p.photo_path ? 'Yes' : '',
    ];
  });

  const csv = [headers, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
  const filename = `${campaign.name.replace(/[^a-z0-9-]/gi, '_')}-report-${new Date().toISOString().slice(0, 10)}.csv`;
  return { csv, filename };
}

// ---------- Selling ----------

// Seller: fetch a physical ticket to check it's unsold & find it, without locking it yet.
// Digital tickets are never pre-populated, so there's nothing to check — they're always
// available by construction, minted fresh at sale time.
async function checkTicket({ campaign_id, ticket_number }) {
  const { data } = await supabase.from('tickets').select('*, ticket_blocks!inner(type)')
    .eq('campaign_id', campaign_id).eq('ticket_number', ticket_number).eq('ticket_blocks.type', 'physical').maybeSingle();
  if (!data) throw httpError(404, `Ticket ${ticket_number} doesn't exist in this campaign`);
  if (data.status !== 'unsold') throw httpError(409, `Ticket ${ticket_number} is already ${data.status}`);
  return { ok: true };
}

// tier_counts: { [tier_id]: count }. ticket_numbers required only for a physical block —
// digital numbers are assigned server-side from the block's own counter. One buyer name
// covers the whole transaction.
async function recordSale(session, { campaign_id, block_id, tier_counts, ticket_numbers, method, payer_name }) {
  requireOrgRole(session, ['seller', 'admin', 'superadmin']);
  await requireCampaignsInOwnOrg(session, [campaign_id]);

  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaign_id).single();
  if (!campaign) throw httpError(404, 'Campaign not found');
  const { data: tiers } = await supabase.from('tiers').select('*').eq('campaign_id', campaign_id);
  const { data: block } = await supabase.from('ticket_blocks').select('*').eq('id', block_id).eq('campaign_id', campaign_id).maybeSingle();
  if (!block) throw httpError(404, 'Ticket block not found in this campaign');

  const counts = tiers.map(t => ({ tier: t, count: Number(tier_counts[t.id]) || 0 }));
  const totalCount = counts.reduce((s, c) => s + c.count, 0);
  if (totalCount <= 0) throw httpError(400, 'Enter at least one ticket count');
  if (!Number.isInteger(totalCount) || counts.some(c => !Number.isInteger(c.count) || c.count < 0)) {
    throw httpError(400, 'Ticket counts must be whole numbers, zero or more.');
  }
  if (!payer_name || !payer_name.trim()) throw httpError(400, 'Buyer name is required for every sale.');

  const tierIdSequence = [];
  counts.forEach(c => { for (let i = 0; i < c.count; i++) tierIdSequence.push(c.tier.id); });
  const amount = counts.reduce((s, c) => s + c.count * Number(c.tier.price), 0);

  const initialStatus = method === 'cash' ? 'cash_pending' : (method === 'card_manual' ? 'paid' : 'held');

  const { data: payment, error: payErr } = await supabase.from('payments')
    .insert({ campaign_id, method, amount, status: 'pending', seller_id: session.uid, payer_name: payer_name.trim() })
    .select().single();
  if (payErr) throw httpError(500, payErr.message);

  if (block.type === 'digital') {
    // Atomically reserve the next N numbers off this block's own counter — avoids two
    // concurrent digital sales handing out the same number.
    const { data: reserved, error: resErr } = await supabase
      .rpc('reserve_digital_tickets', { p_block_id: block_id, p_count: totalCount });
    if (resErr) {
      await supabase.from('payments').update({ status: 'void', voided: true, void_reason: 'digital ticket reservation failed' }).eq('id', payment.id);
      throw httpError(500, 'Could not assign digital ticket numbers: ' + resErr.message);
    }
    const startNumber = reserved; // first number in the reserved run
    const rows = tierIdSequence.map((tierId, i) => ({
      campaign_id, block_id, ticket_number: startNumber + i, tier_id: tierId,
      status: initialStatus, payment_id: payment.id, sold_by: session.uid, sold_at: new Date().toISOString(),
    }));
    const { error: insErr } = await supabase.from('tickets').insert(rows);
    if (insErr) throw httpError(500, 'Payment recorded but digital tickets failed: ' + insErr.message);
  } else {
    if (!ticket_numbers || ticket_numbers.length !== totalCount) {
      throw httpError(400, `Entered ${ticket_numbers ? ticket_numbers.length : 0} ticket number(s) but ${totalCount} were specified — these must match.`);
    }
    // Atomic, all-or-nothing claim: the DB function itself rolls back every update if even
    // one requested ticket isn't currently 'unsold', so there's no window where a crash or
    // network blip could leave a sale half-claimed (see claim_physical_tickets migration).
    const items = ticket_numbers.map((num, i) => ({ ticket_number: Number(num), tier_id: tierIdSequence[i] }));
    const { error: claimErr } = await supabase.rpc('claim_physical_tickets', {
      p_block_id: block_id, p_items: items, p_status: initialStatus, p_payment_id: payment.id, p_sold_by: session.uid,
    });
    if (claimErr) {
      await supabase.from('payments').update({ status: 'void', voided: true, void_reason: 'ticket unavailable at claim time' }).eq('id', payment.id);
      // Figure out WHY the claim failed, so the message is accurate rather than assuming a
      // race — the far more common cause is a typo or wrong campaign/block selected. Nothing
      // was actually claimed (the function rolled itself back), so this reads fresh state.
      for (const num of ticket_numbers.map(Number)) {
        const { data: existing } = await supabase.from('tickets').select('status').eq('block_id', block_id).eq('ticket_number', num).maybeSingle();
        if (!existing) throw httpError(404, `Ticket ${num} doesn't exist in ${campaign.name} — check the campaign selected and the number entered.`);
        if (existing.status !== 'unsold') throw httpError(409, `Ticket ${num} is already ${existing.status} — sale cancelled, please recheck.`);
      }
      throw httpError(409, 'One or more tickets became unavailable — sale cancelled, please recheck.');
    }
  }

  if (method === 'cash') {
    await supabase.from('payments').update({ status: 'pending' }).eq('id', payment.id);
    return { ok: true, payment_id: payment.id, amount, method: 'cash' };
  }
  if (method === 'card_manual') {
    // Payment already taken and confirmed on the seller's physical reader — we're just logging it.
    await supabase.from('payments').update({ status: 'paid' }).eq('id', payment.id);
    return { ok: true, payment_id: payment.id, amount, method: 'card_manual' };
  }

  // card: create SumUp hosted checkout
  const { data: tickets } = await supabase.from('tickets').select('ticket_number').eq('payment_id', payment.id);
  const ref = `PC-${payment.id.slice(0, 8)}`;
  const ticketList = tickets.map(t => t.ticket_number).join(',');
  const resp = await fetch('https://api.sumup.com/v0.1/checkouts', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUMUP_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      checkout_reference: ref, amount, currency: 'GBP', merchant_code: SUMUP_MERCHANT_CODE,
      description: `${campaign.name} tickets ${ticketList}`,
      hosted_checkout: { enabled: true },
    }),
  });
  const sumupData = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    await supabase.from('tickets').update({ status: 'unsold', tier_id: null, payment_id: null, sold_by: null, sold_at: null, attendee_name: null }).eq('payment_id', payment.id);
    await supabase.from('payments').update({ status: 'failed' }).eq('id', payment.id);
    throw httpError(502, `SumUp checkout creation failed (HTTP ${resp.status}): ${sumupData.message || sumupData.error_message || sumupData.error || JSON.stringify(sumupData) || resp.statusText}`);
  }
  await supabase.from('payments').update({ sumup_checkout_id: sumupData.id, sumup_checkout_ref: ref }).eq('id', payment.id);
  return { ok: true, payment_id: payment.id, amount, method: 'card', checkout_id: sumupData.id, pay_url: sumupData.hosted_checkout_url };
}

// Poll SumUp for a card payment's status; update DB when resolved
async function checkoutStatus(session, { payment_id }) {
  const { data: payment } = await supabase.from('payments').select('*').eq('id', payment_id).single();
  if (!payment) throw httpError(404, 'Payment not found');
  if (payment.status === 'paid' || payment.status === 'failed' || payment.status === 'void') return { status: payment.status };
  const resp = await fetch(`https://api.sumup.com/v0.1/checkouts/${payment.sumup_checkout_id}`, {
    headers: { 'Authorization': `Bearer ${SUMUP_API_KEY}` },
  });
  const data = await resp.json();
  if (data.status === 'PAID') {
    const tx = (data.transactions || [])[0] || {};
    await supabase.from('payments').update({ status: 'paid', sumup_transaction_code: tx.transaction_code || null, sumup_transaction_id: tx.id || null }).eq('id', payment.id);
    await supabase.from('tickets').update({ status: 'paid' }).eq('payment_id', payment.id);
    return { status: 'paid' };
  }
  if (data.status === 'FAILED' || data.status === 'EXPIRED') {
    await supabase.from('payments').update({ status: 'failed' }).eq('id', payment.id);
    // Ticket stays 'held' deliberately — physical ticket is already with the buyer.
    return { status: 'failed' };
  }
  return { status: 'pending' };
}

async function voidSale(session, { payment_id, reason }) {
  requireOrgRole(session, ['admin', 'superadmin']);
  if (!reason || !reason.trim()) throw httpError(400, 'A void reason is required');
  const { data: payment } = await supabase.from('payments').select('*, campaigns!inner(org_id)').eq('id', payment_id).single();
  if (!payment || payment.campaigns.org_id !== session.org_id) throw httpError(404, 'Payment not found');
  if (payment.status === 'void') throw httpError(400, 'Already voided');
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

async function dashboardState(session, { campaign_id } = {}) {
  requireOrgRole(session, ['admin', 'superadmin']);
  await releaseStalePendingCardPayments();

  const { data: orgCampaigns } = await supabase.from('campaigns').select('id').eq('org_id', session.org_id).eq('binned', false);
  const orgCampaignIds = orgCampaigns.map(c => c.id);
  const scopedIds = campaign_id ? [campaign_id] : orgCampaignIds;
  if (campaign_id && !orgCampaignIds.includes(campaign_id)) throw httpError(404, 'Campaign not found');

  const { data: tickets } = await supabase.from('tickets').select('status, tier_id, campaign_id').in('campaign_id', scopedIds);
  const { data: payments } = await supabase.from('payments').select('*').in('campaign_id', scopedIds).neq('status', 'void');
  const { data: users } = await supabase.from('users').select('id,name,role').eq('org_id', session.org_id);
  const { data: tiers } = await supabase.from('tiers').select('id, name, price, campaign_id').in('campaign_id', scopedIds);

  const soldStatuses = ['paid', 'cash_pending', 'held'];
  const soldTickets = tickets.filter(t => soldStatuses.includes(t.status));
  const sold = soldTickets.length;
  const unsold = tickets.filter(t => t.status === 'unsold').length;

  // Roll up by tier NAME (not id) so "All Campaigns" sensibly combines e.g. every
  // campaign's own "Adult" tier into one line, even though each has a distinct tier row.
  const tierById = {};
  for (const t of tiers) tierById[t.id] = t;
  const tierBreakdown = {};
  for (const t of soldTickets) {
    const tier = tierById[t.tier_id];
    const name = tier ? tier.name : 'Unknown';
    tierBreakdown[name] = tierBreakdown[name] || { name, soldCount: 0, amount: 0 };
    tierBreakdown[name].soldCount += 1;
    tierBreakdown[name].amount += tier ? Number(tier.price) : 0;
  }

  const cardTotal = payments.filter(p => (p.method === 'card' && p.status === 'paid') || p.method === 'card_manual').reduce((s, p) => s + Number(p.amount), 0);
  const cashConfirmed = payments.filter(p => p.method === 'cash' && p.status === 'paid').reduce((s, p) => s + Number(p.amount), 0);
  const cashPending = payments.filter(p => p.method === 'cash' && p.status === 'pending').reduce((s, p) => s + Number(p.amount), 0);
  const cashTotal = cashConfirmed + cashPending;
  const totalCollected = cardTotal + cashTotal;

  const sellerMap = {};
  for (const p of payments) {
    if (p.status === 'failed' || p.status === 'void') continue;
    const seller = users.find(u => u.id === p.seller_id);
    const key = seller ? seller.name : 'Unknown';
    sellerMap[key] = sellerMap[key] || { card: 0, cash_confirmed: 0, cash_pending: 0 };
    if ((p.method === 'card' && p.status === 'paid') || p.method === 'card_manual') sellerMap[key].card += Number(p.amount);
    if (p.method === 'cash' && p.status === 'paid') sellerMap[key].cash_confirmed += Number(p.amount);
    if (p.method === 'cash' && p.status === 'pending') sellerMap[key].cash_pending += Number(p.amount);
  }

  // integrity check
  const total = tickets.length;
  const paidCount = tickets.filter(t => t.status === 'paid').length;
  const cashPendingCount = tickets.filter(t => t.status === 'cash_pending').length;
  const heldCount = tickets.filter(t => t.status === 'held').length;
  const integrityOk = (unsold + paidCount + cashPendingCount + heldCount) === total;

  return {
    sold, unsold, total, heldCount,
    tierBreakdown: Object.values(tierBreakdown),
    totalCollected, cardTotal, cashTotal, cashConfirmed, cashPending,
    sellerBreakdown: sellerMap,
    integrityOk,
  };
}

// Shows tickets grouped by tier ("Adult: 1, 2 · Child: 3, 4") rather than concatenating a
// letter onto each number — the physical ticket only ever has the plain number printed on
// it, so a prefix in the app that isn't on what anyone's holding just adds confusion.
function groupTicketsForDisplay(payment, allTickets, tiers) {
  const mine = allTickets.filter(t => t.payment_id === payment.id);
  const byTier = {};
  for (const t of mine) {
    const tier = tiers.find(x => x.id === t.tier_id);
    const name = tier ? tier.name : 'Unknown';
    (byTier[name] = byTier[name] || []).push(t.ticket_number);
  }
  return Object.entries(byTier).map(([name, nums]) => `${name}: ${nums.join(', ')}`);
}

async function listRecentPayments(session, { campaign_id } = {}) {
  requireOrgRole(session, ['admin', 'superadmin']);
  const { data: orgCampaigns } = await supabase.from('campaigns').select('id').eq('org_id', session.org_id).eq('binned', false);
  const orgCampaignIds = orgCampaigns.map(c => c.id);
  let q = supabase.from('payments').select('*').order('created_at', { ascending: false }).limit(75);
  q = campaign_id ? q.eq('campaign_id', campaign_id) : q.in('campaign_id', orgCampaignIds);
  const { data: payments } = await q;
  const { data: users } = await supabase.from('users').select('id,name');
  const { data: tickets } = await supabase.from('tickets').select('payment_id, ticket_number, tier_id, attendee_name');
  const { data: tiers } = await supabase.from('tiers').select('id, name');
  const out = payments.map(p => ({
    id: p.id,
    seller: (users.find(u => u.id === p.seller_id) || {}).name || 'Unknown',
    method: p.method, amount: p.amount, status: p.status,
    created_at: p.created_at,
    has_photo: !!p.photo_path,
    tickets: groupTicketsForDisplay(p, tickets, tiers),
  }));
  return { payments: out };
}

async function listIncompletePayments(session, { campaign_id } = {}) {
  requireOrgRole(session, ['admin', 'superadmin']);
  await releaseStalePendingCardPayments();
  const { data: orgCampaigns } = await supabase.from('campaigns').select('id').eq('org_id', session.org_id).eq('binned', false);
  const orgCampaignIds = orgCampaigns.map(c => c.id);
  let q = supabase.from('payments').select('*').eq('method', 'card').in('status', ['pending', 'failed']).order('created_at', { ascending: false });
  q = campaign_id ? q.eq('campaign_id', campaign_id) : q.in('campaign_id', orgCampaignIds);
  const { data: payments } = await q;
  const { data: users } = await supabase.from('users').select('id,name');
  const { data: tickets } = await supabase.from('tickets').select('payment_id, ticket_number, tier_id');
  const { data: tiers } = await supabase.from('tiers').select('id, name');
  const out = (payments || []).map(p => ({
    id: p.id,
    seller: (users.find(u => u.id === p.seller_id) || {}).name || 'Unknown',
    payer_name: p.payer_name,
    amount: p.amount,
    status: p.status, // 'pending' = QR/link issued, not yet paid. 'failed' = expired/declined, needs resend.
    created_at: p.created_at,
    resend_count: p.resend_count,
    tickets: groupTicketsForDisplay(p, tickets, tiers),
  }));
  return { payments: out };
}

async function resendPayment(session, { payment_id }) {
  requireOrgRole(session, ['admin', 'superadmin']);
  const { data: payment } = await supabase.from('payments').select('*, campaigns!inner(org_id, name)').eq('id', payment_id).single();
  if (!payment || payment.campaigns.org_id !== session.org_id) throw httpError(404, 'Payment not found');
  if (payment.method !== 'card') throw httpError(400, 'Only card payments can be resent');
  if (payment.status === 'paid' || payment.status === 'void') throw httpError(400, `Cannot resend — this payment is already ${payment.status}`);

  const { data: currentTickets } = await supabase.from('tickets').select('*').eq('payment_id', payment.id);
  if (!currentTickets || !currentTickets.length) throw httpError(400, 'No tickets recorded against this payment');

  // Re-claim (covers the case where the stale-payment sweep already released them to unsold)
  for (const t of currentTickets) {
    await supabase.from('tickets').update({ status: 'held', payment_id: payment.id, sold_by: session.uid, sold_at: new Date().toISOString() }).eq('id', t.id);
  }

  const ref = `PC-${payment.id.slice(0, 8)}-R${payment.resend_count + 1}`;
  const ticketList = currentTickets.map(t => t.ticket_number).join(',');
  const resp = await fetch('https://api.sumup.com/v0.1/checkouts', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUMUP_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      checkout_reference: ref, amount: payment.amount, currency: 'GBP', merchant_code: SUMUP_MERCHANT_CODE,
      description: `${payment.campaigns.name} tickets ${ticketList} (resend)`,
      hosted_checkout: { enabled: true },
    }),
  });
  const sumupData = await resp.json().catch(() => ({}));
  if (!resp.ok) throw httpError(502, `SumUp checkout creation failed (HTTP ${resp.status}): ${sumupData.message || sumupData.error_message || sumupData.error || JSON.stringify(sumupData) || resp.statusText}`);

  await supabase.from('payments').update({
    status: 'pending', sumup_checkout_id: sumupData.id, sumup_checkout_ref: ref, resend_count: payment.resend_count + 1,
  }).eq('id', payment.id);

  return { ok: true, pay_url: sumupData.hosted_checkout_url, amount: payment.amount };
}

const RETENTION_DAYS = 90;

async function retentionFlags(session) {
  requireOrgRole(session, ['superadmin']);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: orgCampaigns } = await supabase.from('campaigns').select('id').eq('org_id', session.org_id);
  const orgCampaignIds = orgCampaigns.map(c => c.id);
  const { data: oldPayments } = await supabase.from('payments')
    .select('id, payer_name, created_at').in('campaign_id', orgCampaignIds).not('payer_name', 'is', null).lt('created_at', cutoff);
  const { data: oldTickets } = await supabase.from('tickets')
    .select('id, attendee_name, sold_at').in('campaign_id', orgCampaignIds).not('attendee_name', 'is', null).lt('sold_at', cutoff);
  return {
    count: (oldPayments || []).length + (oldTickets || []).length,
    payments: oldPayments || [],
    tickets: oldTickets || [],
  };
}

// Clears personal identifiers only (payer_name, attendee_name). Amounts, ticket numbers,
// dates and totals are deliberately kept — churches typically need financial records
// retained for several years for accounting/Charity Commission purposes, even though
// GDPR says the personal data attached to them shouldn't linger past its purpose.
async function anonymizeOldData(session) {
  requireOrgRole(session, ['superadmin']);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: orgCampaigns } = await supabase.from('campaigns').select('id').eq('org_id', session.org_id);
  const orgCampaignIds = orgCampaigns.map(c => c.id);
  const { data: payments, error: e1 } = await supabase.from('payments')
    .update({ payer_name: null }).in('campaign_id', orgCampaignIds).not('payer_name', 'is', null).lt('created_at', cutoff).select();
  const { data: tickets, error: e2 } = await supabase.from('tickets')
    .update({ attendee_name: null }).in('campaign_id', orgCampaignIds).not('attendee_name', 'is', null).lt('sold_at', cutoff).select();
  if (e1 || e2) throw httpError(500, (e1 || e2).message);
  return { ok: true, payments_cleared: (payments || []).length, tickets_cleared: (tickets || []).length };
}

// Optional supporting evidence for manual card sales (e.g. a photo of the reader showing
// "Approved"). Never blocks the sale itself — this is attached after the fact, whenever
// convenient. Stored in a PRIVATE bucket; viewing always goes through a short-lived signed URL,
// never a public link, since this is financial evidence and should stay access-controlled.
async function uploadPaymentPhoto(session, { payment_id, image_base64 }) {
  requireRole(session, ['seller', 'admin', 'superadmin']);
  if (!image_base64) throw httpError(400, 'No image provided');
  const { data: payment } = await supabase.from('payments').select('id').eq('id', payment_id).single();
  if (!payment) throw httpError(404, 'Payment not found');

  const buffer = Buffer.from(image_base64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (buffer.length > 4 * 1024 * 1024) throw httpError(400, 'Image too large — please use a smaller photo');
  const path = `${payment_id}-${Date.now()}.jpg`;
  const { error } = await supabase.storage.from('payment-evidence').upload(path, buffer, { contentType: 'image/jpeg' });
  if (error) throw httpError(500, 'Photo upload failed: ' + error.message);

  await supabase.from('payments').update({ photo_path: path }).eq('id', payment_id);
  return { ok: true };
}

async function getPaymentPhotoUrl(session, { payment_id }) {
  requireOrgRole(session, ['admin', 'superadmin']);
  const { data: payment } = await supabase.from('payments').select('photo_path').eq('id', payment_id).single();
  if (!payment || !payment.photo_path) throw httpError(404, 'No photo attached to this payment');
  const { data, error } = await supabase.storage.from('payment-evidence').createSignedUrl(payment.photo_path, 300); // 5 min
  if (error) throw httpError(500, error.message);
  return { url: data.signedUrl };
}

async function sellerState(session, { campaign_id } = {}) {
  requireRole(session, ['seller', 'admin', 'superadmin']);
  let payQ = supabase.from('payments').select('*').eq('seller_id', session.uid).neq('status', 'void').neq('status', 'failed');
  let tixQ = supabase.from('tickets').select('status').eq('sold_by', session.uid).neq('status', 'unsold');
  if (campaign_id) { payQ = payQ.eq('campaign_id', campaign_id); tixQ = tixQ.eq('campaign_id', campaign_id); }
  const { data: payments } = await payQ;
  const { data: tickets } = await tixQ;

  const ticketsSoldCount = tickets.length;
  const cashConfirmed = payments.filter(p => p.method === 'cash' && p.status === 'paid').reduce((s, p) => s + Number(p.amount), 0);
  const cashPending = payments.filter(p => p.method === 'cash' && p.status === 'pending').reduce((s, p) => s + Number(p.amount), 0);
  const cashCollected = cashConfirmed + cashPending; // all cash sold, reconciled or not
  const cardTotal = payments.filter(p => (p.method === 'card' && p.status === 'paid') || p.method === 'card_manual').reduce((s, p) => s + Number(p.amount), 0);

  return { ticketsSoldCount, cashCollected, cashReconciled: cashConfirmed, cardTotal };
}

// ---------- router ----------
const actions = {
  bootstrap_platform_owner: (s, b) => bootstrapPlatformOwner(b),
  create_organization: (s, b) => createOrganization(s, b),
  list_organizations: (s) => listOrganizations(s),

  login: (s, b) => login(b),
  create_user: (s, b) => createUser(s, b),
  set_user_active: (s, b) => setUserActive(s, b),
  reset_password: (s, b) => resetPassword(s, b),
  list_users: (s) => listUsers(s),

  create_campaign: (s, b) => createCampaign(s, b),
  list_campaigns: (s, b) => listCampaigns(s, b),
  set_disabled_campaigns: (s, b) => setDisabledCampaigns(s, b),
  set_campaign_active: (s, b) => setCampaignActive(s, b),
  bin_campaign: (s, b) => binCampaign(s, b),
  restore_campaign: (s, b) => restoreCampaign(s, b),
  list_binned_campaigns: (s) => listBinnedCampaigns(s),
  export_campaign_report: (s, b) => exportCampaignReport(s, b),

  check_ticket: (s, b) => checkTicket(b),
  record_sale: (s, b) => recordSale(s, b),
  checkout_status: (s, b) => checkoutStatus(s, b),
  void_sale: (s, b) => voidSale(s, b),
  cash_recon: (s, b) => cashRecon(s, b),
  dashboard_state: (s, b) => dashboardState(s, b),
  list_recent_payments: (s, b) => listRecentPayments(s, b),
  list_incomplete_payments: (s, b) => listIncompletePayments(s, b),
  resend_payment: (s, b) => resendPayment(s, b),
  retention_flags: (s) => retentionFlags(s),
  anonymize_old_data: (s) => anonymizeOldData(s),
  seller_state: (s, b) => sellerState(s, b),
  upload_payment_photo: (s, b) => uploadPaymentPhoto(s, b),
  get_payment_photo_url: (s, b) => getPaymentPhotoUrl(s, b),
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const action = event.path.split('/').pop();
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const session = body.session ? verifySession(body.session) : null;
  if (body.session && !session) return json(401, { error: 'Session expired, please log in again' });

  const fn = actions[action];
  if (!fn) return json(404, { error: `Unknown action: ${action}` });

  try {
    const result = await fn(session, body);
    return json(200, result);
  } catch (e) {
    return json(e.status || 500, { error: e.message || 'Server error' });
  }
};
