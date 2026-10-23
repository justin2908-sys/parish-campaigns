// Loads the real netlify/functions/api.js against the in-memory stand-in database, with a clock the tests control.
const path = require('path'), crypto = require('crypto'), Module = require('module');
const { createFakeDb } = require('./fake-db');

process.env.SUPABASE_URL = 'http://fake.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
process.env.SESSION_SECRET = 'test-secret-for-the-gateway-tests';

// ---- a clock: new Date() and Date.now() return the moment the test chose
const RealDate = Date;
let fixed = null;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0 && fixed !== null) super(fixed); else super(...a); }
  static now() { return fixed !== null ? fixed : RealDate.now(); }
}
global.Date = FakeDate;
const clock = { set(iso) { fixed = new RealDate(iso).getTime(); }, live() { fixed = null; }, now: () => FakeDate.now() };
clock.set('2026-11-02T12:00:00Z');   // a Monday

const db = createFakeDb(clock);

// ---- the two outside packages are replaced, so nothing needs installing
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return { createClient: () => db.client };
  if (request === 'bcryptjs') return { hashSync: () => 'stub', hash: async () => 'stub', compare: async () => true };
  return realLoad.call(this, request, ...rest);
};
const api = require(path.join(__dirname, '..', '..', 'netlify', 'functions', 'api.js'));
Module._load = realLoad;

// ---- sessions: signed the same way the app signs them, for users that exist in the stand-in database
const pf = (hash) => crypto.createHash('sha256').update(String(hash)).digest('base64url').slice(0, 16);
function addUser(id, role, org_id, exp = 4102444800000) {
  const password_hash = 'hash-' + id;
  db.T('users').push({ id, role, org_id, active: true, password_hash, consent_version: 1, name: id });
  const body = Buffer.from(JSON.stringify({ uid: id, role, org_id, name: id, pf: pf(password_hash), exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

let ipCounter = 0;
async function call(action, body, { session, ip } = {}) {
  const res = await api.handler({
    httpMethod: 'POST', path: '/api/' + action,
    headers: { 'x-nf-client-connection-ip': ip || `10.0.0.${++ipCounter % 250}`, host: 'preview.example.netlify.app' },
    body: JSON.stringify({ ...(body || {}), ...(session ? { session } : {}) }),
  });
  let parsed = {}; try { parsed = JSON.parse(res.body); } catch { /* not JSON */ }
  return { status: res.statusCode, body: parsed, headers: res.headers, raw: res.body };
}

module.exports = { api, db, clock, call, addUser, RealDate };
