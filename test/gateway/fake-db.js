// A small in-memory stand-in for the Supabase client, so the gateway tests run anywhere (no network, no installs).
// It understands only the calls api.js makes in the gateway code and in the helpers that code reuses
// (eq / neq / in / lte / gte / lt / gt, order, limit, single, insert, update, delete, upsert, counts, rate_hit).
const crypto = require('crypto');

function createFakeDb(clock) {
  const tables = {};
  const T = (n) => (tables[n] = tables[n] || []);
  const joins = { ticket_blocks: 'block_id' };   // tickets.block_id -> ticket_blocks, for "ticket_blocks!inner(type)"
  const unique = { organizations: [['slug']], gateway_links: [['org_id', 'position']], gateway_order: [['org_id', 'section']] };
  const defaults = { gateway_items: () => ({ listed: true }), gateway_announcements: () => ({ urgent: false }), gateway_links: () => ({ sub: '' }) };
  let seq = 0;
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
      const out = {}; for (const n of names) out[n] = clone(row[n]);
      if (st.cols.includes('campaigns!inner(org_id)')) { const c = T('campaigns').find(x => x.id === row.campaign_id); out.campaigns = c ? { org_id: c.org_id } : null; }   // the one embedded join the payment code uses
      if (st.cols.includes('ticket_blocks!inner(type)')) { const b = T('ticket_blocks').find(x => x.id === row.block_id); out.ticket_blocks = b ? { type: b.type } : null; }
      return out;
    };
    function exec() {
      const rows = T(table);
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
    return { data: null, error: null };   // rate_reset, rate_prune
  };

  return { client: { from: builder, rpc }, tables, T };
}

module.exports = { createFakeDb };
