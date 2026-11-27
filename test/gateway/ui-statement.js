// Browser checks for the money statement (Money > Statement), in a real (headless) Edge or Chrome, against the real api.js on the in-memory stand-in database:
// quick dates, own dates, filters, download, print, narrow phones, and who can see it.
//   node test/gateway/ui-statement.js [output-folder]
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { db, clock, api, addUser, call } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'ui-shots-statement'));
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
  let p = u.pathname; if (p === '/') p = '/index.html'; else if (p.startsWith('/donate/')) p = '/donate.html'; else if (p.startsWith('/candles/')) p = '/candles.html'; else if (p.startsWith('/go/') && p !== '/go/sw.js') p = '/go.html'; else if (p.startsWith('/go/') && p !== '/go/sw.js') p = '/go.html';
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


// ---------- demo data: money in and refunds across a raffle, a registration form and the hidden Donations month
const FI = addUser('uA-fi', 'finance', 'org-A', Date.now() + 6 * 36e5);
Object.assign(T('users').find(u => u.id === 'uA-fi'), { mobile: '07000000003', name: 'Frances Finance', confidentiality_version: 1 });
const VO = addUser('uA-vo', 'volunteer', 'org-A', Date.now() + 6 * 36e5);
Object.assign(T('users').find(u => u.id === 'uA-vo'), { mobile: '07000000004', name: 'volunteer', confidentiality_version: 1 });
const SE = addUser('uA-se', 'seller', 'org-A', Date.now() + 6 * 36e5);
Object.assign(T('users').find(u => u.id === 'uA-se'), { mobile: '07000000005', name: 'Sam Seller', confidentiality_version: 1 });
const nowIso = new Date().toISOString(), daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
T('campaigns').push({ id: 'c-raffle', org_id: 'org-A', name: 'Christmas Raffle', kind: 'raffle', binned: false });
T('campaigns').push({ id: 'c-reg', org_id: 'org-A', name: 'First Communion', kind: 'registration', binned: false, form_def: {} });
T('campaigns').push({ id: 'c-don', org_id: 'org-A', name: 'Donations, this month', kind: 'registration', binned: false, form_def: { donations: true } });
T('ticket_blocks').push({ id: 'b1', campaign_id: 'c-raffle', number_prefix: 'A' });
T('payments').push({ id: 'p1', campaign_id: 'c-raffle', method: 'machine', amount: 20, status: 'paid', seller_id: 'uA-se', paid_at: nowIso, sumup_transaction_code: 'TAAA111', ticket_snapshot: [{ ticket_number: 5, block_id: 'b1' }, { ticket_number: 6, block_id: 'b1' }, { ticket_number: 7, block_id: 'b1' }] });
T('payments').push({ id: 'p2', campaign_id: 'c-reg', method: 'link', amount: 15, status: 'paid', paid_at: nowIso, sumup_checkout_ref: 'CHK-77' });
T('registrations').push({ id: 'r1', campaign_id: 'c-reg', reg_number: 7, payment_id: 'p2', status: 'accepted' });
T('payments').push({ id: 'p3', campaign_id: 'c-don', method: 'link', amount: 25, status: 'paid', paid_at: nowIso, sumup_transaction_code: 'TAAA333', refund_amount: 5, refunded_at: nowIso, refunded_by: 'uA-fi', refund_note: 'Gave twice by mistake' });
T('donations').push({ id: 'd1', org_id: 'org-A', ref_no: 12, payment_id: 'p3', amount: 25, status: 'paid', purpose: 'Altar Flowers' });
T('payments').push({ id: 'p4', campaign_id: 'c-raffle', method: 'link', amount: 8, status: 'paid', paid_at: daysAgo(40), sumup_transaction_code: 'TOLD444', ticket_snapshot: [{ ticket_number: 1, block_id: 'b1' }] });
T('payments').push({ id: 'p5', campaign_id: 'c-raffle', method: 'cash', amount: 50, status: 'pending', seller_id: 'uA-se' });   // cash still held: not in the statement

const MEASURE = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const smallText = [], smallTargets = [];
  for (const e of document.querySelectorAll('#adminContent *')) {
    if (!vis(e) || e.closest('script,style,svg')) continue;
    if (e.closest('[class*=stmt-]') && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) { const px = parseFloat(getComputedStyle(e).fontSize); if (px < 14.99) smallText.push(e.tagName + ':' + e.textContent.trim().slice(0, 30) + ':' + px); }
    if (e.matches('a[href], button, input, select, textarea') && !e.closest('.gw-switch')) { const r = e.getBoundingClientRect(); if (r.height < 43.5 || r.width < 43.5) smallTargets.push(e.tagName + ':' + (e.textContent || e.id || '').trim().slice(0, 30) + ':' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  }
  return { hscroll: document.documentElement.scrollWidth > innerWidth + 1, scrollWidth: document.documentElement.scrollWidth, innerWidth, smallText: smallText.slice(0, 6), smallTargets: smallTargets.slice(0, 6) };
})()`;

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://localhost:' + server.address().port;
  await launch();
  const toastText = () => ev(`(document.getElementById('toast') || {}).textContent`);
  const loginAs = async (token, user) => {
    await open(base + '/theme.css', 'document.body');
    await ev(`localStorage.setItem('pc_session', JSON.stringify({ session: ${JSON.stringify(token)}, user: ${JSON.stringify(user)}, campaigns: [], org: null, lastCampaignId: null })); 'ok'`);
    await open(base + '/index.html', "document.querySelector('#headerRight button')");
    for (let k = 0; k < 6; k++) { await ev(`viewMode = 'admin'; render(); 'ok'`); if (await waitFor(`document.querySelector('.tabs button')`, 2500)) break; }
  };
  const lines = () => ev(`[...document.querySelectorAll('.stmt-line')].map(l => l.innerText.replace(/\\s+/g, ' ').trim())`);
  const tiles = () => ev(`[...document.querySelectorAll('.stmt-tile')].map(t => t.querySelector('b').textContent.trim())`);
  await view(390, 844);
  await loginAs(FI, { id: 'uA-fi', name: 'Frances Finance', role: 'finance', org_id: 'org-A', mobile: '07000000003' });
  await click('[data-group=money]');
  check('Finance sees a Statement tab in the Money section, and all four Money tabs fit one row', await waitFor(`document.querySelector('[data-tab=statement]')`) && await ev(`(() => { const r = document.querySelector('.subtabs'); return r.scrollWidth <= r.clientWidth + 1 && r.querySelectorAll('button').length === 4; })()`));
  await click('[data-tab=statement]');
  check('it opens on This month with the quick dates, From and To, and the totals', await waitFor(`document.querySelector('.stmt-tile')`) && await ev(`document.querySelector('.stmt-chips [aria-pressed=true]').textContent === 'This month' && !!document.getElementById('stFrom').value && !!document.getElementById('stTo').value`));
  const tl = await tiles();
  check('Money in £60.00 (three payments), Refunds £5.00, Net £55.00; the old payment and the cash still held are not in this month', JSON.stringify(tl) === JSON.stringify(['£60.00', '−£5.00', '£55.00']), JSON.stringify(tl));
  const ls = await lines();
  check('each line has the amount, the campaign and what it was for, the booking reference, the payment reference and who took it', ls.some(l => /^\+£20\.00 Christmas Raffle · Tickets/.test(l) && /Booking ref A5–A7/.test(l) && /Payment ref TAAA111/.test(l) && /Card machine/.test(l) && /Taken by Sam Seller/.test(l)) && ls.some(l => /First Communion · Registration/.test(l) && /Booking ref R7/.test(l) && /Payment ref CHK-77/.test(l) && /Taken by Online/.test(l)) && ls.some(l => /^\+£25\.00 Donations · Donation · for Altar Flowers/.test(l) && /Booking ref DON-012/.test(l)), JSON.stringify(ls));
  check('a refund line says Refund, its amount in red-minus, the booking and payment references, and WHO refunded it, with the note', ls.some(l => /^−£5\.00 Refund · Donations · Donation/.test(l) && /Booking ref DON-012/.test(l) && /Payment ref TAAA333/.test(l) && /Refunded by Frances Finance/.test(l) && /Gave twice by mistake/.test(l) && /of £25\.00 paid/.test(l)), JSON.stringify(ls.filter(l => /Refund/.test(l))));
  check('a by-campaign breakdown adds up per campaign', await ev(`(() => { const t = document.querySelector('.stmt-by').innerText.replace(/\\s+/g, ' '); return /Christmas Raffle £20\\.00 £0\\.00 £20\\.00/.test(t) && /Donations £25\\.00 −£5\\.00 £20\\.00/.test(t); })()`), await ev(`document.querySelector('.stmt-by').innerText.replace(/\\s+/g, ' ')`));
  check('no buyer names or contact details appear anywhere on it', await ev(`!/@|07\\d{9}/.test(document.getElementById('adminContent').innerText)`));
  const m390 = await ev(MEASURE);
  check('390px: no sideways scroll, text 15px or bigger, every button and field 44px or taller', !m390.hscroll && !m390.smallText.length && !m390.smallTargets.length, JSON.stringify(m390));
  await shot('statement-390');

  await click('.stmt-chips button', 'Today');
  check('Today: the chip highlights, says so, and the older payment stays out', await waitFor(`/Showing today/.test(document.getElementById('toast').textContent)`) && await ev(`document.querySelector('.stmt-chips [aria-pressed=true]').textContent === 'Today'`) && JSON.stringify(await tiles()) === JSON.stringify(['£60.00', '−£5.00', '£55.00']));
  await click('.stmt-chips button', 'Last 30 days');
  check('Last 30 days says so, and leaves out the payment from forty days ago', await waitFor(`/Showing last 30 days/.test(document.getElementById('toast').textContent)`) && JSON.stringify(await tiles()) === JSON.stringify(['£60.00', '−£5.00', '£55.00']) && !(await lines()).some(l => /TOLD444/.test(l)), JSON.stringify(await tiles()));
  check('the lines are grouped under their day, with each day\'s net', await ev(`document.querySelectorAll('.stmt-day').length === 1 && /4 lines · net £55\\.00/.test(document.querySelector('.stmt-day span').textContent)`), await ev(`[...document.querySelectorAll('.stmt-day')].map(d => d.innerText.replace(/\\s+/g, ' ')).join(' | ')`));

  await ev(`(() => { const s = document.getElementById('stCamp'); s.value = 'First Communion'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check('choosing a campaign shows only its lines and totals, and says so', await waitFor(`/Showing First Communion only/.test(document.getElementById('toast').textContent)`) && JSON.stringify(await tiles()) === JSON.stringify(['£15.00', '£0.00', '£15.00']) && (await lines()).length === 1, JSON.stringify(await tiles()));
  await ev(`(() => { const s = document.getElementById('stCamp'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await click('.seg button', 'Refunds');
  check('Refunds only shows just the refund, with its totals', await waitFor(`/Showing refunds only/.test(document.getElementById('toast').textContent)`) && (await lines()).length === 1 && JSON.stringify(await tiles()) === JSON.stringify(['£0.00', '−£5.00', '−£5.00']), JSON.stringify(await tiles()));
  await click('.seg button', 'Money in');
  check('Money in only drops the refund', await waitFor(`/money in only/.test(document.getElementById('toast').textContent)`) && (await lines()).length === 3 && JSON.stringify(await tiles()) === JSON.stringify(['£60.00', '£0.00', '£60.00']));
  await click('.seg button', 'Everything');

  // search: any word on any line, including the SumUp code
  const typeSearch = (v) => ev(`(() => { const e = document.getElementById('stSearch'); e.focus(); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
  const count = (n) => waitFor(`document.querySelectorAll('.stmt-line').length === ${n}`);
  check('there is a Search box and an All dates button', await ev(`!!document.getElementById('stSearch') && [...document.querySelectorAll('.stmt-chips button')].some(b => b.textContent === 'All dates')`));
  await typeSearch('taaa111');
  check('a SumUp code (any capitals) finds that one payment; the totals are for just that line; the cursor stays in the box', await count(1) && JSON.stringify(await tiles()) === JSON.stringify(['£20.00', '£0.00', '£20.00']) && await ev(`document.activeElement.id === 'stSearch'`) && /1 line match/.test(await ev(`document.getElementById('stmtBody').innerText`)), JSON.stringify(await tiles()));
  await typeSearch('TAAA333');
  check('the same code finds the payment and its refund', await count(2) && JSON.stringify(await tiles()) === JSON.stringify(['£25.00', '−£5.00', '£20.00']));
  await typeSearch('chk-77');
  check('a checkout reference is found too', await count(1) && (await lines())[0].includes('R7'));
  await typeSearch('don012');
  check('a booking reference is found even without its dash (DON012 finds DON-012)', await count(2));
  await typeSearch('a5');
  check('a ticket number is found', await count(1) && (await lines())[0].includes('A5–A7'));
  await typeSearch('altar');
  check('the purpose of a gift is searched', await count(2));
  await typeSearch('sam seller');
  check('every word must match: a staff name finds their sale', await count(1));
  await typeSearch('refund frances');
  check('two words from different parts of a line: "refund frances" finds the refund Frances recorded', await count(1) && /^−£5\.00 Refund/.test((await lines())[0]));
  await typeSearch('gave twice');
  check('a refund note is searched', await count(1));
  await typeSearch('£15');
  check('an amount is searched, with or without the pound sign', await count(1) && (await lines())[0].includes('First Communion'));
  await typeSearch('machine');
  check('the payment method is searched', await count(1));
  await typeSearch('TOLD444');
  check('a code that is not in these dates says so plainly and offers to search all dates', await waitFor(`/Nothing matches “TOLD444” on these dates/.test(document.getElementById('stmtBody').innerText)`) && await ev(`[...document.querySelectorAll('#stmtBody .gw-btns button')].some(b => /Search all dates/.test(b.textContent))`));
  await click('#stmtBody .gw-btns button', 'Search all dates');
  check('pressing it searches every date, keeps the words typed, and finds the older payment (and says so)', await waitFor(`/Showing all dates/.test(document.getElementById('toast').textContent)`) && await count(1) && (await lines())[0].includes('TOLD444') && await ev(`document.getElementById('stSearch').value === 'TOLD444' && /^All dates/.test(document.querySelector('#stmtResults h3').textContent) && document.querySelector('.stmt-chips [aria-pressed=true]').textContent === 'All dates'`), JSON.stringify(await lines()));
  await typeSearch('');
  check('clearing the search under All dates shows every payment and refund ever, with all the totals', await count(5) && JSON.stringify(await tiles()) === JSON.stringify(['£68.00', '−£5.00', '£63.00']), JSON.stringify(await tiles()));
  await click('.stmt-chips button', 'This month');
  await waitFor(`/Showing this month/.test(document.getElementById('toast').textContent)`);
  check('going back to a month keeps the search box empty and shows the month\'s totals', await ev(`document.getElementById('stSearch').value === ''`) && JSON.stringify(await tiles()) === JSON.stringify(['£60.00', '−£5.00', '£55.00']));

  // own dates
  const fromOld = new Date(Date.now() - 42 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }), toOld = new Date(Date.now() - 38 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  await setVal('#stFrom', fromOld, 'change'); await setVal('#stTo', toOld, 'change');
  await click('button', 'Show these dates');
  check('typing a From and a To date and pressing Show gives exactly that period, and says Statement updated', await waitFor(`/Statement updated/.test(document.getElementById('toast').textContent)`) && JSON.stringify(await tiles()) === JSON.stringify(['£8.00', '£0.00', '£8.00']) && await ev(`document.querySelectorAll('.stmt-chips [aria-pressed=true]').length === 0`), JSON.stringify(await tiles()));
  await setVal('#stFrom', toOld, 'change'); await setVal('#stTo', fromOld, 'change');
  await click('button', 'Show these dates');
  check('a From date after the To date is refused in plain words', await waitFor(`/From date must be on or before/.test(document.getElementById('toast').textContent)`));
  await setVal('#stFrom', fromOld, 'change'); await setVal('#stTo', fromOld, 'change');
  await click('button', 'Show these dates');
  check('a quiet day says so instead of showing an empty list', await waitFor(`/No money came in and no refunds/.test(document.getElementById('adminContent').innerText)`) && await ev(`[...document.querySelectorAll('#stmtResults .gw-btns button')].every(b => b.disabled)`));

  // download and print
  await click('.stmt-chips button', 'Last 30 days');
  await waitFor(`document.querySelectorAll('.stmt-line').length === 4`);
  await ev(`(() => { window.__blobs = []; const real = URL.createObjectURL; URL.createObjectURL = (b) => { window.__blobs.push(b); return 'blob:test'; }; HTMLAnchorElement.prototype.click = function () { window.__dl = this.download; }; window.__printed = []; window.open = () => ({ document: { write: (h) => window.__printed.push(h), close() {} }, focus() {}, print() { window.__didPrint = true; } }); 'ok'; })()`);
  await click('button', '⬇ Download');
  const csv = await ev(`window.__blobs[0] ? window.__blobs[0].text() : ''`);
  check('Download gives a CSV named for the dates, and says how many lines', await waitFor(`/Downloaded 4 lines/.test(document.getElementById('toast').textContent)`) && /^money-statement-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/.test(await ev('window.__dl')), await ev('window.__dl'));
  const rowsCsv = csv.replace(/^﻿/, '').split('\r\n');
  check('the CSV has the headings, one row per line, refunds as negative amounts, who refunded, and totals at the foot', rowsCsv[0].startsWith('Date,Time,Money in / Refund,Amount (£),Campaign,What for,Booking reference,Payment reference') && rowsCsv.length === 4 + 1 + 4 && rowsCsv.some(r => /,Refund,-5,Donations,Donation,DON-012,TAAA333,.*Frances Finance,Gave twice by mistake,Altar Flowers,p3$/.test(r)) && rowsCsv.some(r => /^Net,,,55$/.test(r)), rowsCsv.join(' // ').slice(0, 900));
  await click('button', '🖨 Print');
  check('Print opens a print window with the statement in it, and says so', await waitFor(`/Print window opened/.test(document.getElementById('toast').textContent)`) && await ev(`window.__printed.length === 1 && /Money statement/.test(window.__printed[0]) && /TAAA111/.test(window.__printed[0]) && /Refunded by Frances Finance/.test(window.__printed[0]) && !/<script/i.test(window.__printed[0])`));
  await ev(`(() => { const s = document.getElementById('stCamp'); s.value = 'Christmas Raffle'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await click('button', '⬇ Download');
  const csv2 = await ev(`window.__blobs[1] ? window.__blobs[1].text() : ''`);
  check('Download and Print follow the filters on screen (only the raffle lines)', csv2.split('\r\n').filter(r => /Christmas Raffle/.test(r)).length === 1 && !/First Communion/.test(csv2));

  await typeSearch('TAAA111');
  await click('button', '⬇ Download');
  const csv3 = await ev(`window.__blobs[2] ? window.__blobs[2].text() : ''`);
  check('Download and Print follow the search too (only the line with that SumUp code)', csv3.split('\r\n').filter(r => /,TAAA111,/.test(r)).length === 1 && !/TAAA333|CHK-77/.test(csv3));
  await typeSearch('');

  // narrow phone
  await view(320, 700);
  await click('[data-group=money]'); await click('[data-tab=statement]');
  await waitFor(`document.querySelector('.stmt-tile')`);
  const m320 = await ev(MEASURE);
  check('320px: no sideways scroll, text 15px or bigger, every button and field 44px or taller', !m320.hscroll && !m320.smallText.length && !m320.smallTargets.length, JSON.stringify(m320));
  check('320px: the four Money tabs still fit one row', await ev(`(() => { const r = document.querySelector('.subtabs'); return r.scrollWidth <= r.clientWidth + 1; })()`));
  await shot('statement-320');
  await view(390, 844);

  // who can see it
  await loginAs(VO, { id: 'uA-vo', name: 'volunteer', role: 'volunteer', org_id: 'org-A', mobile: '07000000004' });
  check('a volunteer has no Statement tab', await ev(`!document.querySelector('[data-tab=statement]') && ![...document.querySelectorAll('.tabs button')].some(b => /Statement/.test(b.textContent))`));
  const refused = await call('statement_get', { preset: 'this_month' }, { session: SE });
  check('and a seller is refused by the server too', refused.status === 403);

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL STATEMENT BROWSER CHECKS PASSED');
  console.log('screenshots in ' + OUT);
  proc.kill();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { proc && proc.kill(); } catch { /* done */ } process.exit(2); });
