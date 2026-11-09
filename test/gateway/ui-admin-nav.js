// Browser checks for the admin navigation: four sections with a row of tabs inside each, for each role, at phone width.
//   node test/gateway/ui-admin-nav.js [output-folder]
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { db, clock, api, addUser, call } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'ui-shots-nav'));
fs.mkdirSync(OUT, { recursive: true });
const BROWSERS = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
const BROWSER = BROWSERS.find(p => fs.existsSync(p));
if (!BROWSER) { console.log('No Edge or Chrome found: skipping the browser checks.'); process.exit(0); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
clock.live();
const T = db.T;
T('organizations').push({ id: 'org-A', name: 'St.Vincent De Paul Church, Osterley', slug: 'svp-osterley', gateway_enabled: true, timezone: 'Europe/London', address: '2 Witham Road, Osterley' });
const SA = addUser('uA-sa', 'superadmin', 'org-A', Date.now() + 6 * 36e5);
Object.assign(T('users').find(u => u.id === 'uA-sa'), { mobile: '07000000001', name: 'superadmin', confidentiality_version: 1 });

const PUB = path.join(__dirname, '..', '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
    if (u.pathname === '/api/sell_screen') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ campaigns: [], organization: {}, campaign_id: null, stats: null })); req.resume(); return; }
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', async () => {
      const r = await api.handler({ httpMethod: 'POST', path: u.pathname, headers: { host: req.headers.host, 'x-nf-client-connection-ip': '10.1.1.' + (1 + Math.floor(Math.random() * 200)) }, body });
      res.writeHead(r.statusCode, r.headers); res.end(r.body);
    });
    return;
  }
  if (u.pathname.startsWith('/storage/v1/object/public/')) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' }); res.end(TINY_PNG); return; }
  let p = u.pathname; if (p === '/') p = '/index.html'; else if (p.startsWith('/candles/')) p = '/candles.html'; else if (p.startsWith('/go/') && p !== '/go/sw.js') p = '/go.html'; else if (p.startsWith('/go/') && p !== '/go/sw.js') p = '/go.html';
  const file = path.join(PUB, p);
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});

let proc, ws, nid = 0; const pending = new Map();
const send = (method, params) => new Promise((res, rej) => { const i = ++nid; const t = setTimeout(() => { pending.delete(i); rej(new Error('browser did not answer ' + method)); }, 20000); pending.set(i, (d) => { clearTimeout(t); res(d); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (x.result.exceptionDetails) throw new Error(JSON.stringify(x.result.exceptionDetails).slice(0, 400)); return x.result.result.value; };
async function launch() {
  spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue'], { stdio: 'ignore' });
  const dbg = 9500 + Math.floor(Math.random() * 400);
  proc = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + dbg, '--user-data-dir=' + path.join(OUT, 'profile' + Date.now()), '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
  let target; for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find(t => t.type === 'page'); } catch { /* starting */ } }
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => { ws.onopen = r; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === 'Page.javascriptDialogOpening') { console.log('  (the page opened a dialog: ' + JSON.stringify(d.params.message).slice(0, 160) + ')'); send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }
  };
  await send('Page.enable'); await send('Runtime.enable');
}
const view = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
async function open(url, waitFor) { await send('Page.navigate', { url }); for (let i = 0; i < 60; i++) { await sleep(250); try { if (await ev(`!!(${waitFor})`)) return true; } catch { /* page loading */ } } return false; }
async function shot(...a) { try { return await shotRaw(...a); } catch (e) { console.log('  (screenshot skipped: ' + e.message + ')'); } }   // pictures are a courtesy; a slow screenshot must not fail the checks
async function shotRaw(name) {
  const m = await send('Page.getLayoutMetrics');
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(m.result.cssContentSize.width), height: Math.min(6000, Math.ceil(m.result.cssContentSize.height)), scale: 1 } });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
}
const waitFor = async (expr, ms = 8000) => { for (let i = 0; i < ms / 200; i++) { await sleep(200); try { if (await ev(`!!(${expr})`)) return true; } catch { /* busy */ } } return false; };
const click = (sel, text) => ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => !${JSON.stringify(text || '')} || x.textContent.trim().startsWith(${JSON.stringify(text || '')})); if (!e) return 'NOT FOUND ' + ${JSON.stringify(sel + ' ' + (text || ''))}; e.click(); return 'ok'; })()`);
const setVal = (sel, v, evName = 'input') => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'NOT FOUND'; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event(${JSON.stringify(evName)}, { bubbles: true })); return 'ok'; })()`);
let failures = 0;
const check = (name, ok, extra) => { if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };

// ---------- demo data: a parish with Listings open and a few live listings
// ---------- demo data: a parish with Light a Candle open, two candle stands, and the Thursday email not yet set up
const AD = addUser('uA-ad', 'admin', 'org-A', Date.now() + 6 * 36e5);
Object.assign(T('users').find(u => u.id === 'uA-ad'), { mobile: '07000000002', name: 'admin' });
T('organizations').find(o => o.id === 'org-A').contact_email = 'osterley@example.org';
T('candle_settings').push({ org_id: 'org-A', enabled: true, altars: [{ id: 'mary', name: 'Altar of Our Lady', active: true }, { id: 'anthony', name: 'Altar of St Anthony of Padua', active: true }], intro_text: 'Light a candle for someone you love.', cutoff_weekday: 3, cutoff_time: '23:59', next_ref: 1 });
T('gateway_links').push({ id: 'l1', org_id: 'org-A', position: 1, label: 'Book the Parish Hall', sub: '', url: 'https://example.org/hall' });
const mails = [];

// SumUp stand-in
const localFetch = global.fetch; let sumupN = 0, sumupStatus = 'PENDING';
global.fetch = async (url, o = {}) => {
  const u = String(url);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(u)) return localFetch(url, o);
  if (o.method === 'POST' && u.endsWith('/v0.1/checkouts')) { sumupN++; return { ok: true, status: 200, json: async () => ({ id: 'co-' + sumupN, hosted_checkout_url: 'https://pay.example/' + sumupN }) }; }
  if (/\/v0\.1\/checkouts\/co-/.test(u)) return { ok: true, status: 200, json: async () => ({ id: u.split('/').pop(), status: sumupStatus, date: new Date().toISOString(), transactions: sumupStatus === 'PAID' ? [{ id: 'tx1', transaction_code: 'TAAA000001', status: 'SUCCESSFUL' }] : [] }) };
  if (o.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
  return { ok: false, status: 404, json: async () => ({}) };
};
const MEASURE = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const smallText = [], smallTargets = [];
  for (const e of document.querySelectorAll('ROOT *')) {
    if (!vis(e) || e.closest('script,style,svg,.trap')) continue;
    if ([...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) { const px = parseFloat(getComputedStyle(e).fontSize); if (px < 14.99) smallText.push(e.tagName + ':' + e.textContent.trim().slice(0, 30) + ' ' + px + 'px'); }
    if (e.matches('a[href], button, input:not([type=radio]):not([type=checkbox]):not([type=file]), select, textarea') && !e.closest('.gw-switch') && !e.closest('.agree')) { const r = e.getBoundingClientRect(); if (r.height < 43.9 || r.width < 43.9) smallTargets.push(e.tagName + ':' + (e.textContent || e.id || '').trim().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  }
  return { hscroll: document.documentElement.scrollWidth > Math.min(innerWidth, (window.visualViewport || {}).width || innerWidth) + 1, scrollWidth: document.documentElement.scrollWidth, innerWidth, smallText, smallTargets };
})()`;
const MEASURE_PAGE = MEASURE.replace('ROOT', 'body'), MEASURE_ADMIN = MEASURE.replace('ROOT', '#adminContent');
const CLIP = `(() => { window.__copied = []; const rec = (t) => { window.__copied.push(t); };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => rec(t), write: async (items) => { const b = await items[0].getType('text/plain'); rec(await b.text()); } } }); return 'ok'; })()`;


const PR = addUser('uA-pr', 'priest', 'org-A', Date.now() + 6 * 36e5);
Object.assign(T('users').find(u => u.id === 'uA-pr'), { mobile: '07000000003', name: 'priest' });
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://localhost:' + server.address().port;
  await launch();
  const loginAs = async (token, user) => {
    await open(base + '/theme.css', 'document.body');
    await ev(`localStorage.setItem('pc_session', JSON.stringify({ session: ${JSON.stringify(token)}, user: ${JSON.stringify(user)}, campaigns: [], org: null, lastCampaignId: null })); 'ok'`);
    await open(base + '/index.html', "document.querySelector('#headerRight button')");
    for (let k = 0; k < 6; k++) { await ev(`viewMode = 'admin'; render(); 'ok'`); if (await waitFor(`document.querySelector('.tabs button')`, 2500)) break; }
  };
  const sections = () => ev(`[...document.querySelectorAll('.tabs.sections button')].map(b => b.textContent.trim() + (b.classList.contains('active') ? '*' : ''))`);
  const subs = () => ev(`[...document.querySelectorAll('.tabs.subtabs button')].map(b => b.textContent.trim() + (b.classList.contains('active') ? '*' : ''))`);
  const NAV = `(() => { const sec = document.querySelector('.tabs.sections'), sub = document.querySelector('.tabs.subtabs'); const small = [...document.querySelectorAll('.tabs button')].filter(b => { const r = b.getBoundingClientRect(); return r.height < 43.9 || r.width < 43.9; }).map(b => b.textContent.trim()); const vw = Math.min(innerWidth, (window.visualViewport || {}).width || innerWidth), wide = [...document.querySelectorAll("#adminContent *")].filter(e => e.getBoundingClientRect().width && e.getBoundingClientRect().right > vw + 1).slice(0, 5).map(e => e.tagName.toLowerCase() + "." + String(e.className).slice(0, 24) + ":" + Math.round(e.getBoundingClientRect().right)); return { wide, hscroll: document.documentElement.scrollWidth > vw + 1, subFits: !sub || sub.scrollWidth <= sub.clientWidth + 1, secOneLine: !sec || new Set([...sec.children].map(b => Math.round(b.getBoundingClientRect().top))).size === 1, small }; })()`;
  const content = () => ev(`document.getElementById('adminContent').innerText`);

  for (const w of [390, 360]) {
    await view(w, 844);
    await loginAs(SA, { id: 'uA-sa', name: 'superadmin', role: 'superadmin', org_id: 'org-A', mobile: '07000000001' });
    await waitFor(`document.querySelector('.tabs.sections')`);
    check(`${w}px, SuperAdmin: four sections in one row — Campaigns, Money, Parish page, Manage`, JSON.stringify(await sections()) === JSON.stringify(['Campaigns*', 'Money', 'Parish page', 'Manage']), JSON.stringify(await sections()));
    check(`${w}px: it opens on Campaigns, with its four tabs in one row`, JSON.stringify(await subs()) === JSON.stringify(['Campaigns*', 'Registrations', 'Overview', 'Sales']), JSON.stringify(await subs()));
    let nm = await ev(NAV);
    check(`${w}px: no sideways scroll, every button 44px or larger, the tabs fit without scrolling`, !nm.hscroll && !nm.small.length && nm.subFits && nm.secOneLine, JSON.stringify(nm));
    await shot(`nav-${w}-campaigns`);
    for (const [group, want, tab] of [['money', ['Cash Recon*', 'Needs Attention'], 'cash'], ['page', ['Page*', 'Repository', 'Listings', 'Candles'], 'parishpage'], ['manage', ['Users*', 'Recycle Bin', 'Data & privacy'], 'users']]) {
      await click(`[data-group=${group}]`);
      check(`${w}px: ${group} opens its first tab (${tab}), with the right row of tabs`, JSON.stringify(await subs()) === JSON.stringify(want) && await waitFor(`!/^Loading/.test(document.getElementById('adminContent').innerText)`, 6000), JSON.stringify(await subs()));
      nm = await ev(NAV);
      check(`${w}px: the ${group} section fits one row, no sideways scroll`, !nm.hscroll && !nm.small.length && nm.subFits, JSON.stringify(nm));
      await shot(`nav-${w}-${group}`);
    }
    if (w === 390) {
      // each tab in every section opens real content, not an error
      for (const t of ['users', 'bin', 'privacy']) { await ev(`setAdminTab('${t}'); 'ok'`); await waitFor(`!/^Loading/.test(document.getElementById('adminContent').innerText)`, 6000); const c = await content(); check(`Manage → ${t} opens its screen`, c.length > 20 && !(await ev(`!!document.querySelector('#adminContent .error')`)), c.slice(0, 80)); }
      for (const t of ['campaigns', 'registrations', 'overview', 'sales', 'cash', 'attention', 'parishpage', 'repository', 'listings', 'candles']) { await ev(`setAdminTab('${t}'); 'ok'`); await waitFor(`!/^Loading/.test(document.getElementById('adminContent').innerText)`, 6000); const c = await content(); check(`${t} opens its screen (no error)`, c.length > 20 && !(await ev(`!!document.querySelector('#adminContent .error')`)), c.slice(0, 80)); }
      // the section remembers where you were
      await click('[data-group=money]'); await click('[data-tab=attention]'); await waitFor(`document.querySelector('[data-tab=attention].active')`);
      await click('[data-group=campaigns]'); await click('[data-group=money]');
      check('going back to a section returns to the tab you were on (Needs Attention)', JSON.stringify(await subs()) === JSON.stringify(['Cash Recon', 'Needs Attention*']), JSON.stringify(await subs()));
      // one service header: name, open/closed switch, one line, two link buttons, the long text folded away
      await click('[data-group=page]'); await click('[data-tab=candles]'); await waitFor(`document.querySelector('#adminContent .fh')`);
      const fh = await ev(`(() => { const f = document.querySelector('#adminContent .fh'), d = f.querySelector('.fh-how'); const r = f.getBoundingClientRect(); return { title: f.querySelector('h3').textContent, sw: !!f.querySelector('.gw-switch input'), blurb: f.querySelector('.fh-blurb').textContent.length, tools: [...f.querySelectorAll('.fh-tools button')].map(b => b.textContent.trim()), howOpen: !d.hidden, h: Math.round(r.height), seg: [...document.querySelectorAll('#adminContent .seg')[0].children].map(b => b.textContent) }; })()`);
      check('the service header is compact: name, switch, one line, Copy link / View the page, and "How it works" folded away', fh.title === 'Light a Candle' && fh.sw && fh.blurb < 90 && fh.tools.join('|') === 'Copy link|View the page|i' && !fh.howOpen && fh.h < 215 && fh.seg.join('|') === 'Requests|Settings|Thursday email', JSON.stringify(fh));
      await click('#adminContent .fh-howbtn'); await sleep(200);
      check('tapping "How it works" opens the explanation, and tapping again folds it away', await ev(`!document.querySelector('#adminContent .fh-how').hidden && document.querySelector('#adminContent .fh-howbtn').getAttribute('aria-expanded') === 'true'`) && (await click('#adminContent .fh-howbtn'), await ev(`document.querySelector('#adminContent .fh-how').hidden`)));
      await click('#adminContent .fh-howbtn'); await sleep(150);
      await shot('nav-390-candles-header');
    }
  }

  // ---- the Admin role has no Manage section; the priest sees Registrations and Parish page only
  await view(390, 844);
  await loginAs(AD, { id: 'uA-ad', name: 'admin', role: 'admin', org_id: 'org-A', mobile: '07000000002' });
  await waitFor(`document.querySelector('.tabs.sections')`);
  check('Admin: three sections (no Manage)', JSON.stringify(await sections()) === JSON.stringify(['Campaigns*', 'Money', 'Parish page']), JSON.stringify(await sections()));
  check('Admin: Campaigns has Campaigns, Overview and Sales (Registrations is not an Admin tab)', JSON.stringify(await subs()) === JSON.stringify(['Campaigns*', 'Overview', 'Sales']), JSON.stringify(await subs()));
  await loginAs(PR, { id: 'uA-pr', name: 'priest', role: 'priest', org_id: 'org-A', mobile: '07000000003' });
  await waitFor(`document.querySelector('.tabs.sections')`);
  check('Priest: two sections, named for what they hold — Registrations and Parish page', JSON.stringify(await sections()) === JSON.stringify(['Registrations*', 'Parish page']), JSON.stringify(await sections()));
  check('Priest: Registrations has no second row of tabs, and opens the registrations screen', (await subs()).length === 0 && await waitFor(`!/^Loading/.test(document.getElementById('adminContent').innerText)`, 6000) && !(await ev(`!!document.querySelector('#adminContent .error')`)));
  await click('[data-group=page]');
  check('Priest: Parish page has Page, Repository, Listings, Candles', JSON.stringify(await subs()) === JSON.stringify(['Page*', 'Repository', 'Listings', 'Candles']), JSON.stringify(await subs()));
  await shot('nav-390-priest');

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL ADMIN NAVIGATION CHECKS PASSED');
  console.log('screenshots in ' + OUT);
  proc.kill();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { proc && proc.kill(); } catch { /* done */ } process.exit(2); });
