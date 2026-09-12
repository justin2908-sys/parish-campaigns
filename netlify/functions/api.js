// BBQ Ticketing System v1.0 - backend API
// All requests: POST /api/:action  body: JSON { session?, ...payload }

const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me';
const SUMUP_API_KEY = process.env.SUMUP_API_KEY;
const SUMUP_MERCHANT_CODE = process.env.SUMUP_MERCHANT_CODE;

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
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------- action handlers ----------

async function bootstrapSuperadmin({ mobile, name, password }) {
  const { count } = await supabase.from('bbq_users').select('*', { count: 'exact', head: true });
  if (count > 0) throw httpError(403, 'Setup already complete. Ask an existing SuperAdmin to add you.');
  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('bbq_users')
    .insert({ mobile, name, role: 'superadmin', password_hash: hash })
    .select().single();
  if (error) throw httpError(500, error.message);
  return { ok: true, user: safeUser(data) };
}

async function login({ mobile, password }) {
  const { data: user } = await supabase.from('bbq_users').select('*').eq('mobile', mobile).eq('active', true).maybeSingle();
  if (!user) throw httpError(401, 'Unknown mobile number or account disabled');
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw httpError(401, 'Incorrect password');
  const session = signSession({ uid: user.id, role: user.role, name: user.name, exp: Date.now() + 1000 * 60 * 60 * 2 });
  return { session, user: safeUser(user) };
}

function safeUser(u) { return { id: u.id, mobile: u.mobile, name: u.name, role: u.role }; }

async function createUser(session, { mobile, name, role, password, disabled_campaign_ids }) {
  requireRole(session, ['superadmin']);
  if (!['seller', 'admin', 'superadmin'].includes(role)) throw httpError(400, 'Invalid role');
  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('bbq_users')
    .insert({ mobile, name, role, password_hash: hash, created_by: session.uid })
    .select().single();
  if (error) throw httpError(400, error.message);
  if (disabled_campaign_ids && disabled_campaign_ids.length) {
    await supabase.from('bbq_user_campaigns').insert(disabled_campaign_ids.map(series_id => ({ user_id: data.id, series_id, assigned_by: session.uid })));
  }
  return { ok: true, user: safeUser(data) };
}

// Default is full access to every active campaign. A row in bbq_user_campaigns means this
// specific campaign is explicitly DISABLED for this user — the table is an exclusion list,
// not an allow-list. Open to Admins as well as SuperAdmins: this is day-to-day rostering,
// not account creation/deletion, which stays SuperAdmin-only.
async function setDisabledCampaigns(session, { user_id, disabled_campaign_ids }) {
  requireRole(session, ['admin', 'superadmin']);
  await supabase.from('bbq_user_campaigns').delete().eq('user_id', user_id);
  if (disabled_campaign_ids && disabled_campaign_ids.length) {
    const { error } = await supabase.from('bbq_user_campaigns').insert(disabled_campaign_ids.map(series_id => ({ user_id, series_id, assigned_by: session.uid })));
    if (error) throw httpError(400, error.message);
  }
  return { ok: true };
}

async function setUserActive(session, { user_id, active }) {
  requireRole(session, ['superadmin']);
  const { error } = await supabase.from('bbq_users').update({ active }).eq('id', user_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}

async function resetPassword(session, { user_id, new_password }) {
  requireRole(session, ['superadmin']);
  if (!new_password || new_password.length < 4) throw httpError(400, 'Password must be at least 4 characters');
  const hash = await bcrypt.hash(new_password, 10);
  const { error } = await supabase.from('bbq_users').update({ password_hash: hash }).eq('id', user_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}

async function listUsers(session) {
  requireRole(session, ['admin', 'superadmin']);
  const { data: users } = await supabase.from('bbq_users').select('id,mobile,name,role,active,created_at').order('created_at');
  const { data: disabled } = await supabase.from('bbq_user_campaigns').select('user_id, series_id');
  const { data: series } = await supabase.from('bbq_series').select('id, name');
  const out = users.map(u => ({
    ...u,
    disabled_campaign_ids: disabled.filter(a => a.user_id === u.id).map(a => a.series_id),
    disabled_campaign_names: disabled.filter(a => a.user_id === u.id).map(a => (series.find(s => s.id === a.series_id) || {}).name).filter(Boolean),
  }));
  return { users: out };
}

async function createSeries(session, { name, range_start, range_end, adult_price, child_price }) {
  requireRole(session, ['superadmin']);
  if (range_end < range_start) throw httpError(400, 'range_end must be >= range_start');
  const { data: series, error } = await supabase.from('bbq_series')
    .insert({ name, range_start, range_end, adult_price, child_price, created_by: session.uid })
    .select().single();
  if (error) throw httpError(400, error.message);

  // pre-populate every ticket number in the range as 'unsold'
  const rows = [];
  for (let n = range_start; n <= range_end; n++) rows.push({ series_id: series.id, ticket_number: n });
  // batch insert in chunks of 500
  for (let i = 0; i < rows.length; i += 500) {
    const { error: e2 } = await supabase.from('bbq_tickets').insert(rows.slice(i, i + 500));
    if (e2) throw httpError(500, 'Series created but ticket generation failed: ' + e2.message);
  }
  return { ok: true, series };
}

const STALE_MINUTES = 35; // SumUp hosted checkouts are valid ~30 min; give a small buffer

async function releaseStalePendingCardPayments() {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
  const { data: stale } = await supabase.from('bbq_payments')
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
        await supabase.from('bbq_payments').update({ status: 'paid', sumup_transaction_code: tx.transaction_code || null, sumup_transaction_id: tx.id || null }).eq('id', p.id);
        await supabase.from('bbq_tickets').update({ status: 'paid' }).eq('payment_id', p.id);
      } else {
        // FAILED or EXPIRED: mark the payment failed so it surfaces in "Needs Attention" for a
        // resend, but the ticket itself stays 'held' — the physical ticket is already with someone,
        // so it must never quietly become resellable again. Only an explicit Admin Void does that.
        await supabase.from('bbq_payments').update({ status: 'failed' }).eq('id', p.id);
      }
    } catch { /* leave it for the next sweep rather than guessing */ }
  }
}

async function listSeries(session, { include_inactive } = {}) {
  await releaseStalePendingCardPayments();
  let q = supabase.from('bbq_series').select('*').eq('binned', false).order('created_at');
  if (!(include_inactive && session && session.role !== 'seller')) q = q.eq('active', true);
  const { data: allSeries } = await q;
  if (!session || session.role !== 'seller') return { series: allSeries };
  // A row here means this specific campaign is explicitly DISABLED for this user —
  // default is full access to every active campaign, unless a SuperAdmin has switched one off for them.
  const { data: disabled } = await supabase.from('bbq_user_campaigns').select('series_id').eq('user_id', session.uid);
  const disabledIds = new Set((disabled || []).map(a => a.series_id));
  return { series: allSeries.filter(s => !disabledIds.has(s.id)) };
}

async function setCampaignActive(session, { series_id, active }) {
  requireRole(session, ['superadmin']);
  const { error } = await supabase.from('bbq_series').update({ active }).eq('id', series_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}

// Binning is deliberately different from Inactive: Inactive campaigns still count in "All
// Campaigns" totals (their history really happened — e.g. BBQ26 after the event). Binned
// campaigns are excluded entirely from every dashboard and every seller's stats, as if they
// never existed for reporting purposes — while the underlying tickets/payments are kept, not
// wiped, so a mistaken bin can be undone and reports can still be pulled if needed.
async function binCampaign(session, { series_id }) {
  requireRole(session, ['superadmin']);
  const { error } = await supabase.from('bbq_series').update({ binned: true }).eq('id', series_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}
async function restoreCampaign(session, { series_id }) {
  requireRole(session, ['superadmin']);
  // Force Inactive on restore — reactivating (making it sellable again) is a separate,
  // deliberate step, not an automatic side-effect of un-binning.
  const { error } = await supabase.from('bbq_series').update({ binned: false, active: false }).eq('id', series_id);
  if (error) throw httpError(400, error.message);
  return { ok: true };
}
async function listBinnedCampaigns(session) {
  requireRole(session, ['superadmin']);
  const { data } = await supabase.from('bbq_series').select('*').eq('binned', true).order('created_at');
  return { series: data };
}

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCampaignReport(session, { series_id }) {
  requireRole(session, ['superadmin']);
  const { data: series } = await supabase.from('bbq_series').select('*').eq('id', series_id).single();
  if (!series) throw httpError(404, 'Campaign not found');

  const { data: tickets } = await supabase.from('bbq_tickets').select('*').eq('series_id', series_id).order('ticket_number');
  const { data: payments } = await supabase.from('bbq_payments').select('*').eq('series_id', series_id);
  const { data: users } = await supabase.from('bbq_users').select('id,name');
  const userName = (id) => (users.find(u => u.id === id) || {}).name || '';
  const paymentById = {};
  for (const p of payments) paymentById[p.id] = p;

  const headers = [
    'Ticket Number', 'Type', 'Ticket Status', 'Buyer Name', 'Method', 'Payment Amount',
    'Payment Status', 'Seller', 'Sold At', 'Cash Confirmed By', 'Cash Confirmed At',
    'Voided', 'Void Reason', 'SumUp Transaction Code', 'Has Photo Evidence',
  ];
  const rows = tickets.map(t => {
    const p = t.payment_id ? paymentById[t.payment_id] : null;
    return [
      t.ticket_number,
      t.ticket_type === 'A' ? 'Adult' : (t.ticket_type === 'C' ? 'Child' : ''),
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
  const filename = `${series.name.replace(/[^a-z0-9-]/gi, '_')}-report-${new Date().toISOString().slice(0, 10)}.csv`;
  return { csv, filename };
}

// Seller: fetch a ticket to check it's unsold & get its price, without locking it yet
async function checkTicket({ series_id, ticket_number }) {
  const { data } = await supabase.from('bbq_tickets').select('*').eq('series_id', series_id).eq('ticket_number', ticket_number).maybeSingle();
  if (!data) throw httpError(404, `Ticket ${ticket_number} not found in this series`);
  if (data.status !== 'unsold') throw httpError(409, `Ticket ${ticket_number} is already ${data.status}`);
  return { ok: true };
}

// Simplified entry model: seller enters how many Adult/Child tickets, plus the specific
// ticket numbers being handed over (Adult numbers first, then Child — order matters, since
// there's no longer a per-ticket type toggle). One buyer name covers the whole transaction.
async function recordSale(session, { series_id, adult_count, child_count, ticket_numbers, method, payer_name }) {
  requireRole(session, ['seller', 'admin', 'superadmin']);
  adult_count = Number(adult_count) || 0;
  child_count = Number(child_count) || 0;
  if (!Number.isInteger(adult_count) || !Number.isInteger(child_count) || adult_count < 0 || child_count < 0) {
    throw httpError(400, 'Ticket counts must be whole numbers, zero or more.');
  }
  const totalCount = adult_count + child_count;
  if (totalCount <= 0) throw httpError(400, 'Enter at least one adult or child ticket');
  if (!ticket_numbers || ticket_numbers.length !== totalCount) {
    throw httpError(400, `Entered ${ticket_numbers ? ticket_numbers.length : 0} ticket number(s) but ${totalCount} adult+child were specified — these must match.`);
  }
  if (!payer_name || !payer_name.trim()) {
    throw httpError(400, 'Buyer name is required for every sale.');
  }
  const { data: series } = await supabase.from('bbq_series').select('*').eq('id', series_id).single();
  if (!series) throw httpError(404, 'Series not found');

  const tickets = ticket_numbers.map((num, i) => ({ ticket_number: Number(num), ticket_type: i < adult_count ? 'A' : 'C' }));
  const amount = adult_count * Number(series.adult_price) + child_count * Number(series.child_price);

  const { data: payment, error: payErr } = await supabase.from('bbq_payments')
    .insert({
      method, amount, status: 'pending', seller_id: session.uid,
      payer_name: payer_name.trim(),
      series_id, ticket_numbers: tickets.map(t => t.ticket_number),
    })
    .select().single();
  if (payErr) throw httpError(500, payErr.message);

  // atomically claim tickets: only succeeds if currently unsold (guards against races)
  for (const t of tickets) {
    const { data: claimed, error: claimErr } = await supabase.from('bbq_tickets')
      .update({
        ticket_type: t.ticket_type,
        status: method === 'cash' ? 'cash_pending' : (method === 'card_manual' ? 'paid' : 'held'),
        payment_id: payment.id,
        sold_by: session.uid,
        sold_at: new Date().toISOString(),
      })
      .eq('series_id', series_id).eq('ticket_number', t.ticket_number).eq('status', 'unsold')
      .select();
    if (claimErr || !claimed || claimed.length === 0) {
      // roll back: void the payment we just created, release any tickets already claimed under it
      await supabase.from('bbq_tickets').update({ status: 'unsold', payment_id: null, sold_by: null, sold_at: null }).eq('payment_id', payment.id);
      await supabase.from('bbq_payments').update({ status: 'void', voided: true, void_reason: 'ticket unavailable at claim time' }).eq('id', payment.id);
      // Figure out WHY the claim failed, so the message is actually accurate rather than
      // assuming a race — the far more common cause is a typo or wrong campaign selected.
      const { data: existing } = await supabase.from('bbq_tickets').select('status').eq('series_id', series_id).eq('ticket_number', t.ticket_number).maybeSingle();
      if (!existing) {
        throw httpError(404, `Ticket ${t.ticket_number} doesn't exist in ${series.name} — check the campaign selected and the number entered.`);
      }
      throw httpError(409, `Ticket ${t.ticket_number} is already ${existing.status} — sale cancelled, please recheck.`);
    }
  }

  if (method === 'cash') {
    await supabase.from('bbq_payments').update({ status: 'pending' }).eq('id', payment.id);
    return { ok: true, payment_id: payment.id, amount, method: 'cash' };
  }
  if (method === 'card_manual') {
    // Payment already taken and confirmed on Father's physical reader — we're just logging it.
    await supabase.from('bbq_payments').update({ status: 'paid' }).eq('id', payment.id);
    return { ok: true, payment_id: payment.id, amount, method: 'card_manual' };
  }

  // card: create SumUp hosted checkout
  const ref = `BBQ-${payment.id.slice(0, 8)}`;
  const ticketList = tickets.map(t => t.ticket_number).join(',');
  console.log('[SumUp diag] key present:', !!SUMUP_API_KEY, '| prefix:', SUMUP_API_KEY ? SUMUP_API_KEY.slice(0, 8) : 'MISSING', '| length:', SUMUP_API_KEY ? SUMUP_API_KEY.length : 0, '| merchant_code:', SUMUP_MERCHANT_CODE);
  const resp = await fetch('https://api.sumup.com/v0.1/checkouts', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUMUP_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      checkout_reference: ref,
      amount,
      currency: 'GBP',
      merchant_code: SUMUP_MERCHANT_CODE,
      description: `${series.name} tickets ${ticketList}`,
      hosted_checkout: { enabled: true },
    }),
  });
  const sumupData = await resp.json().catch(() => ({}));
  console.log('[SumUp diag] response status:', resp.status, '| body:', JSON.stringify(sumupData));
  if (!resp.ok) {
    await supabase.from('bbq_tickets').update({ status: 'unsold', payment_id: null, sold_by: null, sold_at: null, attendee_name: null }).eq('payment_id', payment.id);
    await supabase.from('bbq_payments').update({ status: 'failed' }).eq('id', payment.id);
    throw httpError(502, `SumUp checkout creation failed (HTTP ${resp.status}): ${sumupData.message || sumupData.error_message || sumupData.error || JSON.stringify(sumupData) || resp.statusText}`);
  }
  await supabase.from('bbq_payments').update({ sumup_checkout_id: sumupData.id, sumup_checkout_ref: ref }).eq('id', payment.id);
  return { ok: true, payment_id: payment.id, amount, method: 'card', checkout_id: sumupData.id, pay_url: sumupData.hosted_checkout_url };
}

// Poll SumUp for a card payment's status; update DB when resolved
async function checkoutStatus(session, { payment_id }) {
  const { data: payment } = await supabase.from('bbq_payments').select('*').eq('id', payment_id).single();
  if (!payment) throw httpError(404, 'Payment not found');
  if (payment.status === 'paid' || payment.status === 'failed' || payment.status === 'void') {
    return { status: payment.status };
  }
  const resp = await fetch(`https://api.sumup.com/v0.1/checkouts/${payment.sumup_checkout_id}`, {
    headers: { 'Authorization': `Bearer ${SUMUP_API_KEY}` },
  });
  const data = await resp.json();
  if (data.status === 'PAID') {
    const tx = (data.transactions || [])[0] || {};
    await supabase.from('bbq_payments').update({ status: 'paid', sumup_transaction_code: tx.transaction_code || null, sumup_transaction_id: tx.id || null }).eq('id', payment.id);
    await supabase.from('bbq_tickets').update({ status: 'paid' }).eq('payment_id', payment.id);
    return { status: 'paid' };
  }
  if (data.status === 'FAILED' || data.status === 'EXPIRED') {
    await supabase.from('bbq_payments').update({ status: 'failed' }).eq('id', payment.id);
    // Ticket stays 'held' deliberately — physical ticket is already with the buyer.
    // An Admin resends a fresh link or explicitly voids; nothing here makes it resellable again.
    return { status: 'failed' };
  }
  return { status: 'pending' };
}

async function voidSale(session, { payment_id, reason }) {
  requireRole(session, ['admin', 'superadmin']);
  if (!reason || !reason.trim()) throw httpError(400, 'A void reason is required');
  const { data: payment } = await supabase.from('bbq_payments').select('*').eq('id', payment_id).single();
  if (!payment) throw httpError(404, 'Payment not found');
  if (payment.status === 'void') throw httpError(400, 'Already voided');
  await supabase.from('bbq_tickets').update({ status: 'unsold', payment_id: null, sold_by: null, sold_at: null, attendee_name: null }).eq('payment_id', payment_id);
  await supabase.from('bbq_payments').update({ status: 'void', voided: true, voided_by: session.uid, voided_at: new Date().toISOString(), void_reason: reason }).eq('id', payment_id);
  return { ok: true };
}

// Lump-sum cash reconciliation: oldest-first greedy match against a seller's pending cash payments
async function cashRecon(session, { seller_id, series_id, amount_received }) {
  requireRole(session, ['admin', 'superadmin']);
  if (!series_id) throw httpError(400, 'A campaign must be selected — cash is reconciled per campaign, not lumped together');
  const { data: pending } = await supabase.from('bbq_payments')
    .select('*').eq('seller_id', seller_id).eq('series_id', series_id).eq('method', 'cash').eq('status', 'pending')
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

  const { data: reconRow, error } = await supabase.from('bbq_cash_recon').insert({
    seller_id, series_id, amount_received, confirmed_by: session.uid,
    fully_matched: remaining === 0,
    surplus_amount: isSurplus ? remaining : 0,
    shortfall_amount: isShortfall ? remaining : 0,
  }).select().single();
  if (error) throw httpError(500, error.message);

  for (const p of matched) {
    await supabase.from('bbq_payments').update({ status: 'paid', cash_confirmed_by: session.uid, cash_confirmed_at: new Date().toISOString(), cash_recon_batch_id: reconRow.id }).eq('id', p.id);
    await supabase.from('bbq_tickets').update({ status: 'paid' }).eq('payment_id', p.id);
  }

  const stillPending = stillPendingRows;
  return {
    ok: true,
    matched_count: matched.length,
    matched_amount: matched.reduce((s, p) => s + Number(p.amount), 0),
    surplus: isSurplus ? remaining : 0,
    shortfall: isShortfall ? remaining : 0,
    still_pending: stillPending.map(p => ({ id: p.id, amount: p.amount, created_at: p.created_at })),
  };
}

async function dashboardState(session, { series_id } = {}) {
  requireRole(session, ['admin', 'superadmin']);
  await releaseStalePendingCardPayments();
  let ticketQuery = supabase.from('bbq_tickets').select('status, ticket_type, series_id');
  let paymentQuery = supabase.from('bbq_payments').select('*').neq('status', 'void');
  if (series_id) {
    ticketQuery = ticketQuery.eq('series_id', series_id); paymentQuery = paymentQuery.eq('series_id', series_id);
  } else {
    // "All Campaigns" rollup — binned campaigns must never silently count here.
    const { data: nonBinned } = await supabase.from('bbq_series').select('id').eq('binned', false);
    const nonBinnedIds = nonBinned.map(s => s.id);
    ticketQuery = ticketQuery.in('series_id', nonBinnedIds); paymentQuery = paymentQuery.in('series_id', nonBinnedIds);
  }
  const { data: tickets } = await ticketQuery;
  const { data: payments } = await paymentQuery;
  const { data: users } = await supabase.from('bbq_users').select('id,name,role');
  const { data: seriesList } = await supabase.from('bbq_series').select('id, adult_price, child_price');
  const priceMap = {};
  for (const s of seriesList) priceMap[s.id] = s;

  const soldStatuses = ['paid', 'cash_pending', 'held'];
  const sold = tickets.filter(t => soldStatuses.includes(t.status)).length;
  const unsold = tickets.filter(t => t.status === 'unsold').length;

  const adultSoldTickets = tickets.filter(t => t.ticket_type === 'A' && soldStatuses.includes(t.status));
  const childSoldTickets = tickets.filter(t => t.ticket_type === 'C' && soldStatuses.includes(t.status));
  const adultSoldCount = adultSoldTickets.length;
  const childSoldCount = childSoldTickets.length;
  const adultAmount = adultSoldTickets.reduce((s, t) => s + Number((priceMap[t.series_id] || {}).adult_price || 0), 0);
  const childAmount = childSoldTickets.reduce((s, t) => s + Number((priceMap[t.series_id] || {}).child_price || 0), 0);

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
    adultSoldCount, childSoldCount, adultAmount, childAmount,
    totalCollected, cardTotal, cashTotal, cashConfirmed, cashPending,
    sellerBreakdown: sellerMap,
    integrityOk,
  };
}

// Shows tickets grouped by type ("Adults: 1, 2 · Children: 3, 4") rather than concatenating
// a letter onto each number — the physical ticket only ever has the plain number printed on
// it, the seller marks A/C by hand separately, so a letter prefix in the app doesn't match
// what anyone's actually holding and just adds confusion.
function groupTicketsForDisplay(payment, allTickets) {
  const nums = payment.ticket_numbers || [];
  const adults = [], children = [];
  for (const num of nums) {
    const t = allTickets.find(t2 => t2.payment_id === payment.id && t2.ticket_number === num);
    (t && t.ticket_type === 'C' ? children : adults).push(num);
  }
  const out = [];
  if (adults.length) out.push(`Adults: ${adults.join(', ')}`);
  if (children.length) out.push(`Children: ${children.join(', ')}`);
  return out;
}

async function getNonBinnedSeriesIds() {
  const { data } = await supabase.from('bbq_series').select('id').eq('binned', false);
  return data.map(s => s.id);
}

async function listRecentPayments(session, { series_id } = {}) {
  requireRole(session, ['admin', 'superadmin']);
  let q = supabase.from('bbq_payments').select('*').order('created_at', { ascending: false }).limit(75);
  if (series_id) q = q.eq('series_id', series_id);
  else q = q.in('series_id', await getNonBinnedSeriesIds());
  const { data: payments } = await q;
  const { data: users } = await supabase.from('bbq_users').select('id,name');
  const { data: tickets } = await supabase.from('bbq_tickets').select('payment_id, ticket_number, ticket_type, attendee_name');
  const out = payments.map(p => ({
    id: p.id,
    seller: (users.find(u => u.id === p.seller_id) || {}).name || 'Unknown',
    method: p.method, amount: p.amount, status: p.status,
    created_at: p.created_at,
    has_photo: !!p.photo_path,
    tickets: groupTicketsForDisplay(p, tickets),
  }));
  return { payments: out };
}

async function listIncompletePayments(session, { series_id } = {}) {
  requireRole(session, ['admin', 'superadmin']);
  await releaseStalePendingCardPayments();
  let q = supabase.from('bbq_payments').select('*').eq('method', 'card').in('status', ['pending', 'failed']).order('created_at', { ascending: false });
  if (series_id) q = q.eq('series_id', series_id);
  else q = q.in('series_id', await getNonBinnedSeriesIds());
  const { data: payments } = await q;
  const { data: users } = await supabase.from('bbq_users').select('id,name');
  const { data: tickets } = await supabase.from('bbq_tickets').select('payment_id, ticket_number, ticket_type, series_id');
  const out = (payments || []).map(p => ({
    id: p.id,
    seller: (users.find(u => u.id === p.seller_id) || {}).name || 'Unknown',
    payer_name: p.payer_name,
    amount: p.amount,
    status: p.status, // 'pending' = QR issued, not yet paid. 'failed' = expired/declined, needs resend.
    created_at: p.created_at,
    resend_count: p.resend_count,
    tickets: groupTicketsForDisplay(p, tickets),
  }));
  return { payments: out };
}

async function resendPayment(session, { payment_id }) {
  requireRole(session, ['admin', 'superadmin']);
  const { data: payment } = await supabase.from('bbq_payments').select('*').eq('id', payment_id).single();
  if (!payment) throw httpError(404, 'Payment not found');
  if (payment.method !== 'card') throw httpError(400, 'Only card payments can be resent');
  if (payment.status === 'paid' || payment.status === 'void') throw httpError(400, `Cannot resend — this payment is already ${payment.status}`);
  if (!payment.ticket_numbers || !payment.ticket_numbers.length) throw httpError(400, 'No tickets recorded against this payment');

  const { data: currentTickets } = await supabase.from('bbq_tickets')
    .select('*').eq('series_id', payment.series_id).in('ticket_number', payment.ticket_numbers);

  // A ticket is "lost" if someone else's payment has since claimed it, or it's now marked paid under another sale.
  const lost = currentTickets.filter(t => t.payment_id && t.payment_id !== payment.id);
  if (lost.length) {
    throw httpError(409, `Can't resend — ticket(s) ${lost.map(t => t.ticket_number).join(', ')} were already sold to someone else in the meantime. Start a fresh sale for just those.`);
  }

  // Re-claim (covers the case where the stale-payment sweep already released them to unsold)
  for (const t of currentTickets) {
    await supabase.from('bbq_tickets').update({ status: 'held', payment_id: payment.id, sold_by: session.uid, sold_at: new Date().toISOString() }).eq('id', t.id);
  }

  const { data: series } = await supabase.from('bbq_series').select('name').eq('id', payment.series_id).single();
  const ref = `BBQ-${payment.id.slice(0, 8)}-R${payment.resend_count + 1}`;
  const resp = await fetch('https://api.sumup.com/v0.1/checkouts', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUMUP_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      checkout_reference: ref,
      amount: payment.amount,
      currency: 'GBP',
      merchant_code: SUMUP_MERCHANT_CODE,
      description: `${series ? series.name : 'Parish'} tickets ${payment.ticket_numbers.join(',')} (resend)`,
      hosted_checkout: { enabled: true },
    }),
  });
  const sumupData = await resp.json().catch(() => ({}));
  if (!resp.ok) throw httpError(502, `SumUp checkout creation failed (HTTP ${resp.status}): ${sumupData.message || sumupData.error_message || sumupData.error || JSON.stringify(sumupData) || resp.statusText}`);

  await supabase.from('bbq_payments').update({
    status: 'pending', sumup_checkout_id: sumupData.id, sumup_checkout_ref: ref, resend_count: payment.resend_count + 1,
  }).eq('id', payment.id);

  return { ok: true, pay_url: sumupData.hosted_checkout_url, amount: payment.amount };
}

const RETENTION_DAYS = 90;

async function retentionFlags(session) {
  requireRole(session, ['superadmin']);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: oldPayments } = await supabase.from('bbq_payments')
    .select('id, payer_name, created_at').not('payer_name', 'is', null).lt('created_at', cutoff);
  const { data: oldTickets } = await supabase.from('bbq_tickets')
    .select('id, attendee_name, sold_at').not('attendee_name', 'is', null).lt('sold_at', cutoff);
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
  requireRole(session, ['superadmin']);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: payments, error: e1 } = await supabase.from('bbq_payments')
    .update({ payer_name: null }).not('payer_name', 'is', null).lt('created_at', cutoff).select();
  const { data: tickets, error: e2 } = await supabase.from('bbq_tickets')
    .update({ attendee_name: null }).not('attendee_name', 'is', null).lt('sold_at', cutoff).select();
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
  const { data: payment } = await supabase.from('bbq_payments').select('id').eq('id', payment_id).single();
  if (!payment) throw httpError(404, 'Payment not found');

  const buffer = Buffer.from(image_base64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (buffer.length > 4 * 1024 * 1024) throw httpError(400, 'Image too large — please use a smaller photo');
  const path = `${payment_id}-${Date.now()}.jpg`;
  const { error } = await supabase.storage.from('payment-evidence').upload(path, buffer, { contentType: 'image/jpeg' });
  if (error) throw httpError(500, 'Photo upload failed: ' + error.message);

  await supabase.from('bbq_payments').update({ photo_path: path }).eq('id', payment_id);
  return { ok: true };
}

async function getPaymentPhotoUrl(session, { payment_id }) {
  requireRole(session, ['admin', 'superadmin']);
  const { data: payment } = await supabase.from('bbq_payments').select('photo_path').eq('id', payment_id).single();
  if (!payment || !payment.photo_path) throw httpError(404, 'No photo attached to this payment');
  const { data, error } = await supabase.storage.from('payment-evidence').createSignedUrl(payment.photo_path, 300); // 5 min
  if (error) throw httpError(500, error.message);
  return { url: data.signedUrl };
}

async function sellerState(session, { series_id } = {}) {
  requireRole(session, ['seller', 'admin', 'superadmin']);
  let payQ = supabase.from('bbq_payments').select('*').eq('seller_id', session.uid).neq('status', 'void').neq('status', 'failed');
  let tixQ = supabase.from('bbq_tickets').select('status').eq('sold_by', session.uid).neq('status', 'unsold');
  if (series_id) { payQ = payQ.eq('series_id', series_id); tixQ = tixQ.eq('series_id', series_id); }
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
  bootstrap_superadmin: (s, b) => bootstrapSuperadmin(b),
  login: (s, b) => login(b),
  create_user: (s, b) => createUser(s, b),
  set_user_active: (s, b) => setUserActive(s, b),
  reset_password: (s, b) => resetPassword(s, b),
  list_users: (s) => listUsers(s),
  create_series: (s, b) => createSeries(s, b),
  list_series: (s, b) => listSeries(s, b),
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
