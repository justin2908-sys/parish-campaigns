// A small in-memory stand-in for the Supabase client, so the gateway tests run anywhere (no network, no installs).
// It understands only the calls api.js makes in the gateway code and in the helpers that code reuses
// (eq / neq / in / lte / gte / lt / gt, order, limit, single, insert, update, delete, upsert, counts, rate_hit).
const crypto = require('crypto');

function createFakeDb(clock) {
  const tables = {};
  const T = (n) => (tables[n] = tables[n] || []);
  const joins = { ticket_blocks: 'block_id' };   // tickets.block_id -> ticket_blocks, for "ticket_blocks!inner(type)"
  const unique = { organizations: [['slug']], gateway_links: [['org_id', 'position']], gateway_order: [['org_id', 'section']],
    repository_weekends: [['org_id', 'weekend']], repository_items: [['org_id', 'sumup_variant_id']], listings: [['org_id', 'client_ref'], ['token']], listing_months: [['org_id', 'month']], listings_settings: [['org_id']], candle_months: [['org_id', 'month']], candle_settings: [['org_id']], weekly_digest: [['org_id']], candle_requests: [['org_id', 'ref_no'], ['org_id', 'client_ref']], repository_orders: [['org_id', 'ref_no'], ['org_id', 'client_ref']] };
  const defaults = { campaigns: () => ({ binned: false }), gateway_items: () => ({ listed: true }), gateway_announcements: () => ({ urgent: false }), gateway_links: () => ({ sub: '' }),
    repository_items: () => ({ available: true, stock: null, sort: 0, featured: false, hearts: 0 }),
    listings: () => ({ views: 0, contacts: 0, reports: 0, hearts: 0, featured: false, images: [], description: '' }),
    candle_settings: () => ({ enabled: false, altars: [{ id: 'mary', name: 'Altar of Our Lady', active: true }, { id: 'anthony', name: 'Altar of St Anthony of Padua', active: true }], intro_text: null, cutoff_weekday: 3, cutoff_time: '23:59', next_ref: 1 }),
    weekly_digest: () => ({ enabled: false, to_email: null, last_week_start: null, last_sent_at: null, last_status: null, last_note: null, last_attempt_at: null }),
    listings_settings: () => ({ enabled: false, intro_text: null, price_base: 3, price_per_extra_week: 1.5, price_per_image: 0.5 }),
    repository_settings: () => ({ enabled: false, slots: [], cutoff_weekday: 3, cutoff_time: '23:59', intro_text: null, next_ref: 1 }) };
  let seq = 0;
  const faults = [];   // { table, op, when? }: the next matching write fails once, so tests can see what the code does when the database refuses
  const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

  const get = (row, col) => {
    if (col.includes('.')) {
      const [rel, c] = col.split('.');
      const j = T(rel).find(r => r.id === row[joins[rel]]);
      return j ? j[c] : undefined;
    }
    return row[col];
  };
  const keyOf = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
  const uniqueClash = (table, rows, candidate, selfRow) => {
    for (const cols of unique[table] || []) {
      if (cols.some(c => candidate[c] === null || candidate[c] === undefined)) continue;
      if (rows.some(r => r !== selfRow && cols.every(c => keyOf(r[c]) === keyOf(candidate[c])))) return true;
    }
    return false;
  };
  const dup = (table) => ({ data: null, error: { code: '23505', message: `duplicate key value violates unique constraint on ${table}` } });

  function builder(table) {
    const st = { op: 'select', cols: '*', opts: {}, filters: [], orders: [], limit: null, single: null, patch: null, rows: null, conflict: null, returning: false };
    const match = (row) => st.filters.every(f => {
      const v = get(row, f.col);
      switch (f.op) {
        case 'eq': return v === f.val;
        case 'neq': return v !== f.val;
        case 'in': return f.val.includes(v);
        case 'lte': return v !== null && v !== undefined && v <= f.val;
        case 'gte': return v !== null && v !== undefined && v >= f.val;
        case 'lt': return v !== null && v !== undefined && v < f.val;
        case 'gt': return v !== null && v !== undefined && v > f.val;
        case 'is': return f.val === null ? (v === null || v === undefined) : v === f.val;
        case 'notnull': return v !== null && v !== undefined;
        default: throw new Error('fake db: unsupported filter ' + f.op);
      }
    });
    const project = (row) => {
      if (st.cols === '*') return clone(row);
      const names = st.cols.split(',').map(s => s.trim()).filter(s => s && !s.includes('('));
      const out = st.cols.trim().startsWith('*') ? clone(row) : {};   // "*, campaigns!inner(...)" means every column plus the join
      for (const n of names) if (n !== '*') out[n] = clone(row[n]);
      const em = /campaigns!inner\(([^)]*)\)/.exec(st.cols);   // the embedded join the payment code uses: campaigns!inner(org_id, name, ...)
      if (em) { const c = T('campaigns').find(x => x.id === row.campaign_id); out.campaigns = c ? Object.fromEntries(em[1].split(',').map(s => s.trim()).filter(Boolean).map(k => [k, c[k]])) : null; }
      if (st.cols.includes('ticket_blocks!inner(type)')) { const b = T('ticket_blocks').find(x => x.id === row.block_id); out.ticket_blocks = b ? { type: b.type } : null; }
      return out;
    };
    function exec() {
      const rows = T(table);
      const fi = faults.findIndex(x => x.table === table && x.op === st.op && (!x.when || x.when(st.patch || st.rows)));
      if (fi >= 0) { faults.splice(fi, 1); return { data: null, error: { code: 'XX000', message: 'injected failure' } }; }
      if (st.op === 'insert') {
        const made = [];
        for (const r of st.rows) {
          const row = { ...(defaults[table] ? defaults[table]() : {}), ...clone(r) };
          if (!row.id && table !== 'gateway_order') row.id = crypto.randomUUID();
          if (!row.created_at) row.created_at = new Date(clock.now() + (++seq)).toISOString();
          if (uniqueClash(table, rows, row, null)) return dup(table);
          rows.push(row); made.push(row);
        }
        return finish(made);
      }
      if (st.op === 'upsert') {
        const made = [];
        for (const r of st.rows) {
          const cols = st.conflict.split(',').map(s => s.trim());
          const ex = rows.find(x => cols.every(c => keyOf(x[c]) === keyOf(r[c])));
          if (ex) { Object.assign(ex, clone(r)); made.push(ex); }
          else { const row = { ...(defaults[table] ? defaults[table]() : {}), ...clone(r) }; if (!row.id && table !== 'gateway_order') row.id = crypto.randomUUID(); rows.push(row); made.push(row); }
        }
        return finish(made);
      }
      const hit = rows.filter(match);
      if (st.op === 'update') {
        for (const row of hit) {
          const next = { ...row, ...clone(st.patch) };
          if (uniqueClash(table, rows, next, row)) return dup(table);
          Object.assign(row, clone(st.patch));
        }
        return finish(hit);
      }
      if (st.op === 'delete') {
        const keep = rows.filter(r => !hit.includes(r)); rows.length = 0; rows.push(...keep);
        return finish(hit);
      }
      let out = hit.slice();
      for (const o of st.orders.slice().reverse()) {
        out.sort((a, b) => { const x = get(a, o.col), y = get(b, o.col); const c = x === y ? 0 : (x === undefined || x === null) ? -1 : (y === undefined || y === null) ? 1 : x < y ? -1 : 1; return o.asc ? c : -c; });
      }
      if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
      if (st.limit !== null) out = out.slice(0, st.limit);
      if (st.opts.count) return { data: st.opts.head ? null : out.map(project), count: hit.length, error: null };
      return finish(out, true);
    }
    function finish(list, isSelect) {
      const wantRows = isSelect || st.returning;
      if (st.single) {
        if (!list.length) return st.single === 'one' ? { data: null, error: { code: 'PGRST116', message: 'no rows' } } : { data: null, error: null };
        return { data: wantRows ? project(list[0]) : null, error: null };
      }
      return { data: wantRows ? list.map(project) : null, error: null };
    }
    const api = {
      select(cols, opts) { if (st.op === 'select') { st.cols = cols || '*'; st.opts = opts || {}; } else { st.returning = true; st.cols = cols || '*'; } return api; },
      insert(rows) { st.op = 'insert'; st.rows = Array.isArray(rows) ? rows : [rows]; return api; },
      upsert(rows, o) { st.op = 'upsert'; st.rows = Array.isArray(rows) ? rows : [rows]; st.conflict = (o && o.onConflict) || 'id'; return api; },
      update(patch) { st.op = 'update'; st.patch = patch; return api; },
      delete() { st.op = 'delete'; return api; },
      eq: (col, val) => (st.filters.push({ op: 'eq', col, val }), api),
      neq: (col, val) => (st.filters.push({ op: 'neq', col, val }), api),
      in: (col, val) => (st.filters.push({ op: 'in', col, val }), api),
      lte: (col, val) => (st.filters.push({ op: 'lte', col, val }), api),
      gte: (col, val) => (st.filters.push({ op: 'gte', col, val }), api),
      lt: (col, val) => (st.filters.push({ op: 'lt', col, val }), api),
      gt: (col, val) => (st.filters.push({ op: 'gt', col, val }), api),
      is: (col, val) => (st.filters.push({ op: 'is', col, val }), api),
      not: (col, op, val) => { if (op === 'is' && val === null) st.filters.push({ op: 'notnull', col }); else throw new Error('fake db: unsupported not()'); return api; },
      order: (col, o) => (st.orders.push({ col, asc: !(o && o.ascending === false) }), api),
      limit: (n) => ((st.limit = n), api),
      range: (a, b) => ((st.range = [a, b]), api),
      maybeSingle: () => ((st.single = 'maybe'), api),
      single: () => ((st.single = 'one'), api),
      then(onF, onR) { try { return Promise.resolve(exec()).then(onF, onR); } catch (e) { return Promise.reject(e).then(onF, onR); } },
    };
    return api;
  }

  const hits = new Map();
  const rpc = async (name, a) => {
    if (name === 'rate_hit') {
      const e = hits.get(a.p_key), now = clock.now();
      if (!e || e.start < now - a.p_window_seconds * 1000) { hits.set(a.p_key, { n: 1, start: now }); return { data: 1, error: null }; }
      e.n += 1; return { data: e.n, error: null };
    }
    if (name === 'rate_peek') { const e = hits.get(a.p_key); return { data: e ? e.n : 0, error: null }; }
    if (name === 'claim_lowest_available_tickets') {
      const free = T('tickets').filter(t => t.block_id === a.p_block_id && t.status === 'unsold').sort((x, y) => x.ticket_number - y.ticket_number).slice(0, a.p_tier_ids.length);
      if (free.length !== a.p_tier_ids.length) return { data: null, error: { message: 'CLAIM_FAILED: not enough' } };
      free.forEach((t, i) => Object.assign(t, { tier_id: a.p_tier_ids[i], status: a.p_status, payment_id: a.p_payment_id, sold_by: a.p_sold_by, sold_at: new Date(clock.now()).toISOString() }));
      return { data: free.map(t => ({ ticket_number: t.ticket_number })), error: null };
    }
    if (name === 'claim_specific_tickets') {
      const rows = a.p_items.map(it => T('tickets').find(t => t.campaign_id === a.p_campaign_id && t.ticket_number === it.ticket_number && t.status === 'unsold'));
      if (rows.some(r => !r)) return { data: null, error: { message: 'CLAIM_FAILED' } };
      rows.forEach((t, i) => Object.assign(t, { tier_id: a.p_items[i].tier_id, status: a.p_status, payment_id: a.p_payment_id, sold_by: a.p_sold_by, sold_at: new Date(clock.now()).toISOString() }));
      return { data: null, error: null };
    }
    if (name === 'registration_used') {   // same rule as the SQL function: places held by registrations that are not declined or cancelled
      const n = T('registrations').filter(r => r.campaign_id === a.p_campaign && ['awaiting_payment', 'submitted', 'accepted'].includes(r.status)).reduce((s, r) => s + (r.party_size || 1), 0);
      return { data: n, error: null };
    }
    if (name === 'register_claim') {   // mirrors the SQL function (lock, next number, FULL / TOO_MANY, insert)
      const c = T('campaigns').find(x => x.id === a.p_campaign);
      if (!c) return { data: null, error: { message: 'NO_CAMPAIGN' } };
      const mine = T('registrations').filter(r => r.campaign_id === a.p_campaign);
      const next = mine.reduce((m, r) => Math.max(m, r.reg_number), 0) + 1;
      const used = mine.filter(r => !['cancelled', 'declined'].includes(r.status)).reduce((s, r) => s + (r.party_size || 1), 0);
      const party = Math.max(1, a.p_party == null ? 1 : a.p_party);
      if (c.places != null && used >= c.places) return { data: null, error: { message: 'FULL' } };
      if (c.places != null && used + party > c.places) return { data: null, error: { message: 'TOO_MANY:' + (c.places - used) } };
      const row = { id: crypto.randomUUID(), campaign_id: a.p_campaign, reg_number: next, name: a.p_name, phone: a.p_phone, email: a.p_email, answers: clone(a.p_answers), agreements: clone(a.p_agreements), status: a.p_status, payment_id: a.p_payment, client_ip: a.p_ip, client_ref: a.p_client_ref, party_size: party, created_at: new Date(clock.now() + (++seq)).toISOString() };
      if (a.p_client_ref && mine.some(r => r.client_ref === a.p_client_ref)) return { data: null, error: { code: '23505', message: 'duplicate client_ref' } };
      T('registrations').push(row);
      return { data: [{ reg_id: row.id, number: next }], error: null };
    }
    // The Repository's three functions, mirroring the SQL in 20261109010000_repository_shop.sql (which was also tested against the real database).
    if (name === 'shop_place_order') {
      let st = T('repository_settings').find(s => s.org_id === a.p_org);
      if (!st) { st = { ...defaults.repository_settings(), org_id: a.p_org }; T('repository_settings').push(st); }
      const want = new Map();
      for (const l of a.p_lines) want.set(l.item_id, (want.get(l.item_id) || 0) + Number(l.qty));
      let total = 0;
      for (const id of [...want.keys()].sort()) {
        const it = T('repository_items').find(x => x.id === id && x.org_id === a.p_org);
        if (!it || !it.available) return { data: null, error: { message: 'NOT_AVAILABLE:' + (it ? it.name : 'an item') } };
        if (it.stock !== null && it.stock !== undefined && it.stock < want.get(id)) return { data: null, error: { message: `SOLD_OUT:${it.name}:${it.stock}` } };
        total += Math.round(Number(it.price) * 100) * want.get(id);
      }
      total /= 100;
      if (total !== Number(a.p_expected_total)) return { data: null, error: { message: 'PRICE_CHANGED' } };
      if (a.p_client_ref && T('repository_orders').some(o => o.org_id === a.p_org && o.client_ref === a.p_client_ref)) return { data: null, error: { code: '23505', message: 'duplicate client_ref' } };
      const ref = st.next_ref; st.next_ref += 1;
      const order = { id: crypto.randomUUID(), org_id: a.p_org, ref_no: ref, payment_id: a.p_payment, status: 'awaiting_payment', collect_date: a.p_collect, slot_id: a.p_slot_id, slot_label: a.p_slot_label, total, cancel_reason: null, client_ref: a.p_client_ref, created_at: new Date(clock.now() + (++seq)).toISOString(), paid_at: null, prepared_at: null, collected_at: null, cancelled_at: null };
      T('repository_orders').push(order);
      for (const [id, qty] of want) {
        const it = T('repository_items').find(x => x.id === id);
        T('repository_order_lines').push({ id: crypto.randomUUID(), order_id: order.id, item_id: id, item_name: it.name, unit_price: it.price, qty });
        if (it.stock !== null && it.stock !== undefined) it.stock -= qty;
      }
      return { data: [{ order_id: order.id, ref_no: ref, total }], error: null };
    }
    if (name === 'shop_cancel_order') {
      const o = T('repository_orders').find(x => x.id === a.p_order);
      if (!o) return { data: 'missing', error: null };
      if (['cancelled', 'collected'].includes(o.status)) return { data: o.status, error: null };
      if (a.p_only_unpaid && o.status !== 'awaiting_payment') return { data: o.status, error: null };
      for (const l of T('repository_order_lines').filter(x => x.order_id === o.id && x.item_id)) { const it = T('repository_items').find(x => x.id === l.item_id); if (it && it.stock !== null && it.stock !== undefined) it.stock += l.qty; }
      Object.assign(o, { status: 'cancelled', cancel_reason: String(a.p_reason).slice(0, 200), cancelled_at: new Date(clock.now()).toISOString() });
      return { data: 'cancelled', error: null };
    }
    if (name === 'shop_reinstate_order') {
      const o = T('repository_orders').find(x => x.id === a.p_order);
      if (!o) return { data: 'missing', error: null };
      if (o.status !== 'cancelled' || o.cancel_reason !== 'Payment not completed') return { data: o.status, error: null };
      const ls = T('repository_order_lines').filter(x => x.order_id === o.id && x.item_id);
      for (const l of ls) { const it = T('repository_items').find(x => x.id === l.item_id); if (it && it.stock !== null && it.stock !== undefined && it.stock < l.qty) return { data: 'SOLD_OUT:' + it.name, error: null }; }
      for (const l of ls) { const it = T('repository_items').find(x => x.id === l.item_id); if (it && it.stock !== null && it.stock !== undefined) it.stock -= l.qty; }
      Object.assign(o, { status: 'paid', cancel_reason: null, cancelled_at: null, paid_at: new Date(clock.now()).toISOString() });
      return { data: 'paid', error: null };
    }
    if (name === 'candle_next_ref') {   // as the SQL function: take the next number in one step
      let st = T('candle_settings').find(x => x.org_id === a.p_org);
      if (!st) { st = { ...defaults.candle_settings(), org_id: a.p_org }; T('candle_settings').push(st); }
      const n = st.next_ref; st.next_ref += 1; return { data: n, error: null };
    }
    if (name === 'listing_event') {   // once per visitor per day, as in the SQL function
      const ev = T('listing_events');
      if (ev.some(e => e.listing_id === a.p_listing && e.kind === a.p_kind && e.day === a.p_day && e.ip_hash === a.p_ip)) return { data: false, error: null };
      ev.push({ listing_id: a.p_listing, kind: a.p_kind, day: a.p_day, ip_hash: a.p_ip });
      const l = T('listings').find(x => x.id === a.p_listing);
      if (l) { const k = { view: 'views', contact: 'contacts', report: 'reports' }[a.p_kind]; l[k] = (l[k] || 0) + 1; }
      return { data: true, error: null };
    }
    if (name === 'heart_set') {   // one per visitor per thing, can be taken back; the stored count is recounted, as in the SQL function
      const H = T('hearts');
      const same = (h) => h.kind === a.p_kind && h.target_id === a.p_target;
      if (a.p_on) { if (!H.some(h => same(h) && h.ip_hash === a.p_ip)) H.push({ kind: a.p_kind, target_id: a.p_target, ip_hash: a.p_ip, created_at: new Date(clock.now()).toISOString() }); }
      else { const keep = H.filter(h => !(same(h) && h.ip_hash === a.p_ip)); H.length = 0; H.push(...keep); }
      const n = H.filter(same).length;
      const row = T(a.p_kind === 'listing' ? 'listings' : 'repository_items').find(x => x.id === a.p_target);
      if (row) row.hearts = n;
      return { data: n, error: null };
    }
    return { data: null, error: null };   // rate_reset, rate_prune
  };

  // Supabase Storage: only the upload the Repository uses; what was stored is kept in `uploads` so tests can look at it
  const uploads = [];
  const removed = [];
  const storage = { from: (bucket) => ({ upload: async (path, buf, opts) => { uploads.push({ bucket, path, bytes: buf.length, opts }); return { data: { path }, error: null }; }, remove: async (paths) => { removed.push(...paths); return { data: null, error: null }; } }) };
  return { client: { from: builder, rpc, storage }, tables, T, faults, uploads, removed };
}

module.exports = { createFakeDb };
