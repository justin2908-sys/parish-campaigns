// Browser checks for Cash Recon (what a seller is holding, and reconciling against it), in a real (headless) Edge or Chrome, against the real api.js on the in-memory stand-in database:
// the shopping-bag shortcut on the parish page, choosing items, collection, details, paying, the order page, and the office screens.
//   node test/gateway/ui-shop.js [output-folder]
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { db, clock, api, addUser, call } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'ui-shots-cash'));
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
  let p = u.pathname; if (p === '/') p = '/index.html'; else if (p.startsWith('/shop/')) p = '/shop.html'; else if (p.startsWith('/go/') && p !== '/go/sw.js') p = '/go.html';
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

// ---------- demo data: two sellers holding cash in two campaigns
const AD = addUser('uA-ad', 'admin', 'org-A', Date.now() + 6 * 36e5);
Object.assign(T('users').find(u => u.id === 'uA-ad'), { mobile: '07000000002', name: 'Admin Anne' });
for (const [id, name] of [['sel-mary', 'Mary'], ['sel-john', 'John'], ['sel-none', 'Nora (nothing held)']]) T('users').push({ id, role: 'seller', org_id: 'org-A', active: true, name, mobile: '0700000' + id.length });
T('campaigns').push({ id: 'c-raffle', org_id: 'org-A', name: 'Autumn Raffle', binned: false, kind: 'raffle', active: true }, { id: 'c-bbq', org_id: 'org-A', name: 'Parish BBQ', binned: false, kind: 'event', active: true });
T('tiers').push({ id: 't-adult', campaign_id: 'c-bbq', name: 'Adult' }, { id: 't-child', campaign_id: 'c-bbq', name: 'Child' }, { id: 't-r', campaign_id: 'c-raffle', name: 'Ticket' });
T('ticket_blocks').push({ id: 'b-bbq', campaign_id: 'c-bbq', number_prefix: 'B' }, { id: 'b-r', campaign_id: 'c-raffle', number_prefix: '' });
const iso = (d, h) => `2026-11-0${d}T${String(h).padStart(2, '0')}:00:00.000Z`;
let pseq = 0;
const sale = (seller, campaign, amount, d, h, tickets) => { const id = 'p' + (++pseq); T('payments').push({ id, campaign_id: campaign, method: 'cash', amount, status: 'pending', seller_id: seller, payer_name: 'Buyer ' + pseq, created_at: iso(d, h), cash_recon_batch_id: null });
  (tickets || []).forEach(([tier, block, n]) => T('tickets').push({ id: `${id}-${n}`, campaign_id: campaign, block_id: block, tier_id: tier, ticket_number: n, status: 'cash_pending', payment_id: id })); return id; };
sale('sel-mary', 'c-raffle', 5, 7, 9, [['t-r', 'b-r', 11], ['t-r', 'b-r', 12]]); sale('sel-mary', 'c-raffle', 2.5, 7, 10, [['t-r', 'b-r', 13]]);
sale('sel-mary', 'c-bbq', 12, 6, 8, [['t-adult', 'b-bbq', 5], ['t-child', 'b-bbq', 6]]); sale('sel-mary', 'c-bbq', 6, 7, 11, [['t-adult', 'b-bbq', 7]]);
sale('sel-john', 'c-raffle', 20, 7, 9, [['t-r', 'b-r', 21]]);
const MEASURE = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const smallText = [], smallTargets = [];
  for (const e of document.querySelectorAll('#adminContent *')) {
    if (!vis(e) || e.closest('script,style,svg')) continue;
    if ([...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) { const px = parseFloat(getComputedStyle(e).fontSize); if (px < 14.99) smallText.push(e.tagName + ':' + e.textContent.trim().slice(0, 30) + ' ' + px + 'px'); }
    if (e.matches('a[href], button, input:not([type=checkbox]), select, textarea')) { const r = e.getBoundingClientRect(); if (r.height < 43.9 || r.width < 43.9) smallTargets.push(e.tagName + ':' + (e.textContent || e.id || '').trim().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  }
  return { hscroll: document.documentElement.scrollWidth > Math.min(innerWidth, (window.visualViewport || {}).width || innerWidth) + 1, scrollWidth: document.documentElement.scrollWidth, smallText, smallTargets };
})()`;

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://localhost:' + server.address().port;
  await launch();
  const toastText = () => ev(`(document.getElementById('toast') || {}).textContent`);
  const typeAmt = async (v) => { await ev(`(() => { const e = document.getElementById('reconAmount'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`); await sleep(150); };
  const feed = () => ev(`document.getElementById('cashFeed').innerText`);
  const loginAs = async (token, user) => {
    await open(base + '/theme.css', 'document.body');
    await ev(`localStorage.setItem('pc_session', JSON.stringify({ session: ${JSON.stringify(token)}, user: ${JSON.stringify(user)}, campaigns: [], org: null, lastCampaignId: null })); 'ok'`);
    await open(base + '/index.html', "document.querySelector('#headerRight button')");
    for (let k = 0; k < 6; k++) { await ev(`viewMode = 'admin'; render(); 'ok'`); if (await waitFor(`document.querySelector('.tabs button')`, 2500)) break; }
  };
  await view(390, 844);
  await loginAs(AD, { id: 'uA-ad', name: 'Admin Anne', role: 'admin', org_id: 'org-A', mobile: '07000000002' });
  await click('[data-group=money]');   // the Money section has Cash Recon
  await click('[data-tab=cash]');
  check('the Cash Recon tab lists the sellers with what each is holding, biggest first', await waitFor(`document.querySelector('.cash-row')`));
  const rows = await ev(`[...document.querySelectorAll('.cash-row')].map(r => r.innerText.replace(/\\s+/g, ' '))`);
  check('Mary holds £25.50 (4 sales, 2 campaigns), John £20.00, and a seller with nothing says so', /^Mary.*4 sales · 2 campaigns.*£25\.50/.test(rows[0]) && /^John.*1 sale.*£20\.00/.test(rows[1]) && rows.some(r => /Nora.*nothing held.*£0\.00/.test(r)), JSON.stringify(rows));
  await shot('cash-390-list');
  await click('.cash-row', 'Mary'); await waitFor(`document.querySelector('.cash-hold')`);
  const h = await ev(`({ hold: document.querySelector('.cash-hold').innerText.replace(/\\s+/g, ' '), pills: [...document.querySelectorAll('.gw-pill')].map(p => p.textContent.trim()), table: [...document.querySelectorAll('.cash-sales tr')].slice(1).map(r => r.innerText.replace(/\\s+/g, ' ')), feed: document.getElementById('cashFeed').innerText })`);
  check('Mary\'s total is shown big, with how many sales and campaigns', /Mary should hand over £25\.50 from 4 sales not yet reconciled in 2 campaigns/.test(h.hold), h.hold);
  check('the campaign with the oldest sale is shown first, with its sales oldest first, what they were for, and a running total', h.pills[0].startsWith('Parish BBQ · £18.00') && h.table.length === 2 && /Adult: B5 Child: B6.*£12\.00 £12\.00/.test(h.table[0]) && /Adult: B7.*£6\.00 £18\.00/.test(h.table[1]), JSON.stringify([h.pills, h.table]));
  check('before anything is typed it says what to expect', /Expected: £18\.00/.test(h.feed) && (await ev(`document.getElementById('cashGo').disabled`)));
  await typeAmt('18');
  check('typing exactly the expected amount says so and the button names the amount', /Exactly right/.test(await feed()) && (await ev(`document.getElementById('cashGo').textContent`)) === 'Confirm & Reconcile £18.00' && !(await ev(`document.getElementById('cashGo').disabled`)) && !(await ev(`!!document.getElementById('cashAck')`)));
  await typeAmt('14');
  const sh = await feed();
  check('a short amount says how short, what it would cover, and what stays pending', /£4\.00 short/.test(sh) && /first 1 sale \(£12\.00\)/.test(sh) && /1 sale \(£6\.00\) will stay pending/.test(sh), sh);
  check('…and the button stays off until the difference is acknowledged', await ev(`document.getElementById('cashGo').disabled`) && (await ev(`document.getElementById('cashGo').textContent`)) === 'Reconcile £14.00 anyway');
  await ev(`document.getElementById('cashAck').click(); 'ok'`); await sleep(150);
  check('ticking "I have checked this difference" turns the button on', !(await ev(`document.getElementById('cashGo').disabled`)));
  await typeAmt('20');
  check('too much says by how much and that it will be a surplus (and asks to be acknowledged again)', /£2\.00 more than expected/.test(await feed()) && /surplus/.test(await feed()) && (await ev(`document.getElementById('cashGo').disabled`)));
  await typeAmt('0');
  check('zero is refused in words, and the button is off', /more than £0/.test(await feed()) && (await ev(`document.getElementById('cashGo').disabled`)));
  const lm = await ev(MEASURE);
  check('the screen at 390px: no sideways scroll, nothing under 13px, tap targets 44px or larger', !lm.hscroll && !lm.smallText.some(t => parseFloat(t.split(' ').pop()) < 13) && !lm.smallTargets.length, JSON.stringify([lm.scrollWidth, lm.smallText.slice(0, 3), lm.smallTargets.slice(0, 4)]));
  await typeAmt('14'); await ev(`document.getElementById('cashAck').click(); 'ok'`); await shot('cash-390-short');
  await click('.gw-pill', 'Autumn Raffle');
  await waitFor(`/Autumn Raffle: £7\\.50/.test(document.getElementById('cashDetail').innerText)`);
  check('choosing the other campaign shows its own figure and clears the amount', /Expected: £7\.50/.test(await feed()) && (await ev(`document.getElementById('reconAmount').value`)) === '');
  await click('.gw-pill', 'Parish BBQ'); await waitFor(`/Parish BBQ: £18\\.00/.test(document.getElementById('cashDetail').innerText)`);

  // the figure moves while the Admin is counting: another sale is made
  sale('sel-mary', 'c-bbq', 3, 7, 12, [['t-adult', 'b-bbq', 8]]);
  await typeAmt('18'); await click('#cashGo');
  await waitFor(`/changed since you opened this screen/.test(document.getElementById('adminContent').innerText)`, 8000);
  const stale = await ev(`document.getElementById('adminContent').innerText`);
  check('if Mary\'s cash changed while counting, reconciling stops, says what it is now, and the screen shows the new figure', /changed since you opened this screen \(it is now £21\.00\)/.test(stale) && /Mary should hand over\s+£28\.50/.test(stale) && T('payments').filter(p => p.status === 'paid').length === 0, JSON.stringify(T('payments').map(p => [p.id, p.status, p.amount, p.cash_recon_batch_id])));
  // the right amount now
  await typeAmt('21'); await click('#cashGo'); await waitFor(`document.getElementById('toast').textContent.includes('Cash reconciled')`, 8000);
  check('the exact amount reconciles all three BBQ sales, says so, and the figures update', /Cash reconciled — 3 sales, £21\.00/.test(await toastText()) && T('payments').filter(p => p.status === 'paid' && p.campaign_id === 'c-bbq').length === 3);
  const after = await ev(`document.getElementById('adminContent').innerText.replace(/\\s+/g, ' ')`);
  check('afterwards Mary shows £7.50 still held, the result of the last reconciliation, and the history', /Mary should hand over £7\.50/.test(after) && /Done for Mary/.test(after) && /Reconciled with Mary lately/.test(after) && /£21\.00 received, 3 sales \(£21\.00\)/.test(after), after.slice(0, 400));
  await shot('cash-390-done');
  // a part payment: £5 against £7.50
  await typeAmt('5'); await ev(`document.getElementById('cashAck').click(); 'ok'`); await sleep(150);
  await click('#cashGo'); await waitFor(`document.getElementById('toast').textContent.includes('Cash reconciled')`, 8000);
  const part = await ev(`document.getElementById('adminContent').innerText.replace(/\\s+/g, ' ')`);
  check('a part-payment reconciles the oldest sale only; the rest stays held and is shown', /Matched 1 sale totalling £5\.00/.test(part) && /Mary should hand over £2\.50/.test(part) && T('payments').filter(p => p.status === 'pending' && p.seller_id === 'sel-mary').length === 1, part.slice(0, 300));
  await click('.cash-row', 'Nora'); await waitFor(`/is not holding any cash/.test(document.getElementById('cashDetail').innerText)`);
  check('a seller with nothing held is told so, instead of being asked for an amount', !(await ev(`!!document.getElementById('reconAmount')`)));

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CASH BROWSER CHECKS PASSED');
  console.log('screenshots in ' + OUT);
  proc.kill();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { proc && proc.kill(); } catch { /* done */ } process.exit(2); });
