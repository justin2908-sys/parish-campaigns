// Browser checks for Light a Candle and the Thursday email, in a real (headless) Edge or Chrome, against the real api.js on the in-memory stand-in database:
// the candle shortcut on the parish page, the request form, paying, the request page, and the office screens.
//   node test/gateway/ui-candles.js [output-folder]
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { db, clock, api, addUser, call } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'ui-shots-candles'));
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
  return { hscroll: document.documentElement.scrollWidth > innerWidth + 1, scrollWidth: document.documentElement.scrollWidth, innerWidth, smallText, smallTargets };
})()`;
const MEASURE_PAGE = MEASURE.replace('ROOT', 'body'), MEASURE_ADMIN = MEASURE.replace('ROOT', '#adminContent');
const CLIP = `(() => { window.__copied = []; const rec = (t) => { window.__copied.push(t); };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => rec(t), write: async (items) => { const b = await items[0].getType('text/plain'); rec(await b.text()); } } }); return 'ok'; })()`;


(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://localhost:' + server.address().port;
  await launch();
  const toastText = () => ev(`(document.getElementById('toast') || {}).textContent`);
  const typeIn = async (sel, v) => { await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`); };
  const statusReady = "document.querySelector('.status h1') && !/^Loading/.test(document.querySelector('.status h1').textContent)";

  // ---- the parish page has a picture-only candle shortcut
  await view(390, 844);
  await open(base + '/go/svp-osterley', "document.querySelector('.door')");
  const ic = await ev(`(() => { const a = document.querySelector('a.ic[href^="/candles/"]'); return a && { href: a.getAttribute('href'), words: a.textContent.trim(), aria: a.getAttribute('aria-label'), w: a.getBoundingClientRect().width, h: a.getBoundingClientRect().height }; })()`);
  check('the parish page has a candle picture button to Light a Candle (no words on it; its name is for screen readers)', ic && ic.href === '/candles/svp-osterley' && ic.words === '' && /candle/i.test(ic.aria) && ic.w >= 44 && ic.h >= 44, JSON.stringify(ic));
  await click('a.ic[href^="/candles/"]');
  check('it opens the candle page', await waitFor(`document.querySelector('.altar')`));
  check('the page names the parish, has both candle stands, and a pay bar that says nothing is chosen yet', await ev(`(() => { const t = document.body.innerText; return /Osterley/.test(t) && /Altar of Our Lady/.test(t) && /Altar of St Anthony of Padua/.test(t) && !!document.getElementById('payBtn') && /Choose an offering/.test(document.getElementById('totalLine').textContent); })()`));
  check('the week buttons are short ("From Mon 16 Nov"), one for each week offered', await ev(`(() => { const c = [...document.querySelectorAll('.weeks .chip')]; return c.length === 4 && c.every(b => /^From [A-Z][a-z]{2} \\d{1,2} [A-Z][a-z]{2}$/.test(b.textContent.trim())); })()`), JSON.stringify(await ev(`[...document.querySelectorAll('.weeks .chip')].map(b => b.textContent)`)));
  const m0 = await ev(MEASURE_PAGE);
  check('the request form: no sideways scroll, text 15px or larger, tap targets 44px or larger', !m0.hscroll && !m0.smallText.length && !m0.smallTargets.length, JSON.stringify([m0.scrollWidth, m0.smallText.slice(0, 3), m0.smallTargets.slice(0, 4)]));
  await shot('candles-390-form');

  // ---- asking for candles: mistakes are caught in words first, then the request is made and the card page is opened
  await click('#payBtn');
  check('pressing Pay with nothing chosen says what is missing, in words', await waitFor(`/where the candle should be lit/.test((document.querySelector('.err') || {}).textContent || '')`));
  await click('[data-altar="anthony"]');
  await click('#payBtn');
  check('then asks for the day', await waitFor(`/choose the day/i.test((document.querySelector('.err') || {}).textContent || '')`));
  const pick = await ev(`(() => { const d = document.querySelectorAll('.days .day')[2]; d.click(); return d.getAttribute('data-date'); })()`);
  await click('[data-inc]'); await click('[data-inc]');
  check('the stepper shows 3 candles', (await ev(`document.getElementById('nOut').textContent`)) === '3');
  await click('[data-offer="2"]');
  check('the total reads 3 × £2.00 = £6.00 and the pay bar shows £6.00', await ev(`/3 candles × £2\\.00 = £6\\.00/.test(document.getElementById('totalLine').textContent) && document.getElementById('payAmt').textContent === '£6.00'`));
  await click('[data-offer="other"]'); await waitFor(`document.getElementById('fOther')`);
  await typeIn('#fOther', '7');
  await click('#payBtn');
  check('an offering above £5 for each candle is refused in words', await waitFor(`/£1\\.50 to £5\\.00/.test((document.querySelector('.err') || {}).textContent || '')`));
  await typeIn('#fOther', '2.5');
  check('"Other" £2.50 changes the total to £7.50', await ev(`document.getElementById('payAmt').textContent === '£7.50'`));
  await click('[data-offer="2"]');
  await click('#payBtn');
  check('then asks for a name', await waitFor(`/enter your name/i.test((document.querySelector('.err') || {}).textContent || '')`));
  await typeIn('#fName', 'Mary Murphy');
  await click('#payBtn');
  check('then asks for a mobile number or an email', await waitFor(`/mobile number or an email/i.test((document.querySelector('.err') || {}).textContent || '')`));
  await shot('candles-390-error');
  await typeIn('#fPhone', '07700 900123'); await typeIn('#fWhy', 'For my mother, who is unwell');
  await click('#payBtn'); await sleep(2500);
  const req = T('candle_requests')[0], pay = T('payments')[0];
  check('paying makes a card payment of £6.00, holds the request until it is paid, and keeps the intention private to the office', req && req.status === 'awaiting_payment' && req.altar_id === 'anthony' && req.candles === 3 && req.light_date === pick && req.intention === 'For my mother, who is unwell' && pay && pay.amount === 6 && /07700/.test(pay.contact_value), JSON.stringify(req && [req.status, req.altar_id, req.candles, req.light_date, pick, pay && pay.amount, pay && pay.contact_value]));

  // ---- the request's own page
  await open(base + '/candles.html?request=' + req.id, statusReady);
  check('before payment it says it is waiting for payment, with a way back to the payment page', /Waiting for your payment/.test(await ev(`document.querySelector('.status h1').textContent`)) && await ev(`!!document.querySelector('a.btn[href^="https://pay.example"]')`) && /CAN-001/.test(await ev(`document.body.innerText`)));
  sumupStatus = 'PAID';
  await open(base + '/candles.html?request=' + req.id, statusReady);
  const done = await ev(`({ h: document.querySelector('.status h1').textContent, text: document.body.innerText, copy: !!document.querySelector('[data-copy="CAN-001"]') })`);
  check('once paid it thanks them and shows the reference, the stand, the day, the number of candles and the offering', /Thank you/.test(done.h) && /CAN-001/.test(done.text) && /3 candles/.test(done.text) && /St Anthony/.test(done.text) && /£6\.00/.test(done.text) && done.copy, JSON.stringify(done.text.slice(0, 200)));
  check('and the request is now on the list as paid', T('candle_requests')[0].status === 'paid');
  await ev(CLIP); await click('[data-copy]'); await waitFor(`window.__copied.length > 0`, 3000);
  check('the copy button copies the reference and says so', (await ev(`window.__copied[0]`)) === 'CAN-001' && /copied/i.test(await toastText()));
  const m1 = await ev(MEASURE_PAGE);
  check('the request page: no sideways scroll, text 15px or larger, tap targets 44px or larger', !m1.hscroll && !m1.smallText.length && !m1.smallTargets.length, JSON.stringify([m1.scrollWidth, m1.smallText.slice(0, 3), m1.smallTargets.slice(0, 4)]));
  await shot('candles-390-thanks');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await sleep(200);
  await open(base + '/candles/svp-osterley', "document.querySelector('.altar')"); await sleep(300); await shot('candles-390-dark-form');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await open(base + '/candles/unknown-parish', "document.querySelector('.status h1')");
  check('an address that is not a parish says candle requests are not open (no crash)', /not open/i.test(await ev(`document.querySelector('.status h1').textContent`)));

  // ---- a second paid request, put in directly (a different day and stand), so the office list has something to group
  const monday = (() => { const [y, m, d] = pick.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d)); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); })();
  T('campaigns').push({ id: 'camp-x', org_id: 'org-A', name: 'Candles, test', binned: false });
  T('payments').push({ id: 'pay-2', campaign_id: 'camp-x', method: 'link', amount: 3, status: 'paid', payer_name: 'Joseph Okafor', contact_value: 'joseph@example.org' });
  T('candle_requests').push({ id: '00000000-0000-4000-8000-000000000002', org_id: 'org-A', ref_no: 2, payment_id: 'pay-2', status: 'paid', light_date: pick, altar_id: 'mary', altar_name: 'Altar of Our Lady', candles: 2, per_candle: 1.5, total: 3, intention: 'Thanksgiving', created_at: new Date().toISOString() });

  // ---- the office
  const loginAs = async (token, user) => {
    await open(base + '/theme.css', 'document.body');
    await ev(`localStorage.setItem('pc_session', JSON.stringify({ session: ${JSON.stringify(token)}, user: ${JSON.stringify(user)}, campaigns: [], org: null, lastCampaignId: null })); 'ok'`);
    await open(base + '/index.html', "document.querySelector('#headerRight button')");
    for (let k = 0; k < 6; k++) { await ev(`viewMode = 'admin'; render(); 'ok'`); if (await waitFor(`document.querySelector('.tabs button')`, 2500)) break; }   // the app may still be starting: ask again
  };
  await view(390, 844);
  await loginAs(AD, { id: 'uA-ad', name: 'admin', role: 'admin', org_id: 'org-A', mobile: '07000000002' });
  await click('[data-group=page]');   // the Parish page section has the Candles tab
  const sawTab = await waitFor(`document.querySelector('[data-tab=candles]')`);
  check('the admin sees a Candles tab', sawTab);
  if (!sawTab) console.log('  (the screen shows: ' + JSON.stringify(await ev(`({ tabs: [...document.querySelectorAll('.tabs button')].map(b => b.textContent.trim()), mode: typeof viewMode !== 'undefined' ? viewMode : '?', body: document.getElementById('app').innerText.slice(0, 120) })`)) + ')');
  await ev(CLIP);
  await click('[data-tab=candles]');
  check('it opens on the requests', await waitFor(`document.querySelector('#adminContent .gw-status') && document.querySelector('#adminContent .seg')`));
  await ev(`cndGoWeek(${JSON.stringify(monday)}); 'ok'`);
  check('the week list groups the paid requests by day and candle stand, with names and counts', await waitFor(`document.querySelectorAll('#adminContent .rp-order').length === 2`) && await ev(`(() => { const t = document.getElementById('adminContent').innerText; return /Altar of Our Lady/.test(t) && /Altar of St Anthony of Padua/.test(t) && /Mary Murphy/.test(t) && /Joseph Okafor/.test(t) && /5 candles/.test(t) && /still to light/.test(t); })()`));
  check('the office (and only the office) can read the private “who it is for”', await ev(`(() => { const t = document.getElementById('adminContent').innerText; return /For my mother, who is unwell/.test(t) && /Thanksgiving/.test(t) && /private to the office/.test(t); })()`));
  const wm = await ev(MEASURE_ADMIN);
  check('the requests screen: no sideways scroll, tap targets 44px or larger', !wm.hscroll && !wm.smallTargets.length, JSON.stringify([wm.scrollWidth, wm.smallTargets.slice(0, 5)]));
  await shot('admin-390-candles-requests');
  await click('#adminContent button', '✓ Lit'); await waitFor(`/marked as lit/i.test(document.getElementById('toast').textContent)`);
  check('“✓ Lit” says so and the request is marked lit', T('candle_requests').filter(r => r.status === 'lit').length === 1 && await ev(`/Lit/.test(document.getElementById('adminContent').innerText)`));
  await click('#adminContent button', 'Undo: not lit yet'); await waitFor(`/to light/i.test(document.getElementById('toast').textContent)`);
  check('“Undo” puts it back', T('candle_requests').filter(r => r.status === 'lit').length === 0);
  await click('#adminContent button', 'Cancel…'); await waitFor(`document.getElementById('cndWhy')`);
  await click('#adminContent button', 'Yes, cancel it'); await sleep(300);
  check('cancelling without a reason is refused in words', /say why/i.test(await toastText()) && T('candle_requests').every(r => r.status !== 'cancelled'));
  await typeIn('#cndWhy', 'The person asked us to cancel'); await ev(`document.getElementById('cndRefund').click(); 'ok'`);
  await click('#adminContent button', 'Yes, cancel it'); await waitFor(`/refund is recorded/.test(document.getElementById('toast').textContent)`);
  const cx = T('candle_requests').find(r => r.status === 'cancelled');
  check('cancelling with a reason and the refund note cancels it and records the refund in the books', cx && /asked us to cancel/.test(cx.cancel_reason) && T('payments').find(p => p.id === cx.payment_id).refund_amount > 0, JSON.stringify(cx && [cx.ref_no, cx.cancel_reason]));
  check('a cancelled request moves under “Not on the list”', await ev(`/Not on the list/.test(document.getElementById('adminContent').innerText) && /Cancelled/.test(document.getElementById('adminContent').innerText)`));
  await click('#adminContent button', '🖨 Print the list'); await waitFor(`document.getElementById('repoPrintPanel')`);
  const pr1 = await ev(`document.getElementById('repoPrintPanel').innerText`);
  check('the print list has the day, the stand, the names, candle counts and tick boxes, and no “who it is for” by default', /Altar of/.test(pr1) && /Candles to light/.test(pr1) && !/Thanksgiving|For my mother/.test(pr1) && await ev(`document.querySelectorAll('#repoPrintPanel .tick').length >= 1`), JSON.stringify(pr1.slice(0, 160)));
  await ev(`document.getElementById('cndPrintWhy').click(); 'ok'`);
  check('ticking “Include who it is for” adds it to the print list', /Thanksgiving|For my mother/.test(await ev(`document.getElementById('repoPrintPanel').innerText`)));
  await click('#repoPrintPanel button', 'Close');
  check('Close closes the print list', await ev(`!document.getElementById('repoPrintPanel')`));

  // ---- settings
  await click('.seg button', 'Settings'); await waitFor(`document.getElementById('caN0')`);
  const sm = await ev(MEASURE_ADMIN);
  check('the settings screen: no sideways scroll, tap targets 44px or larger', !sm.hscroll && !sm.smallTargets.length, JSON.stringify([sm.scrollWidth, sm.smallTargets.slice(0, 5)]));
  await shot('admin-390-candles-settings');
  await click('#adminContent button', '+ Add a candle stand'); await waitFor(`document.getElementById('caN2')`);
  await click('#adminContent button', 'Save'); await sleep(300);
  check('saving a candle stand with no name is refused in words', /name/i.test(await toastText()));
  await typeIn('#caN2', 'Side chapel'); await typeIn('#cnIntro', 'A volunteer will light your candle.');
  await click('#adminContent button', 'Save'); await waitFor(`document.getElementById('toast').textContent === '✓ Saved'`);
  const st = T('candle_settings').find(s => s.org_id === 'org-A');
  check('saving keeps the new candle stand and the welcome line', st.altars.length === 3 && st.altars[2].name === 'Side chapel' && st.intro_text === 'A volunteer will light your candle.', JSON.stringify(st.altars.map(a => a.name)));
  await click('#adminContent button[aria-label="Remove this candle stand"]'); await sleep(200);
  check('removing a stand says to press Save, and Save then keeps two', /press Save/.test(await toastText()));
  await click('#adminContent button', 'Save'); await waitFor(`document.getElementById('toast').textContent === '✓ Saved'`);
  check('two stands are kept', T('candle_settings').find(s => s.org_id === 'org-A').altars.length === 2);

  // ---- the Thursday email: not set up at first, then set up
  await click('.seg button', 'Thursday email'); await waitFor(`document.getElementById('cnTo')`);
  const noMail = await ev(`document.getElementById('adminContent').innerText`);
  check('before email is set up, the screen says so and lists the steps (Gmail app password, Netlify variables)', /not set up yet/i.test(noMail) && /App passwords/.test(noMail) && /MAIL_APP_PASSWORD/.test(noMail), JSON.stringify(noMail.slice(0, 120)));
  await click('#adminContent button', 'Send it now'); await sleep(400);
  check('“Send it now” without email set up explains why instead of failing quietly', /not been set up/i.test(await toastText()) && mails.length === 0, await toastText());
  api.setMailer(async (m) => { mails.push(m); return { ok: true }; });
  await click('.seg button', 'Requests'); await click('.seg button', 'Thursday email'); await waitFor(`document.getElementById('cnTo')`);
  await typeIn('#cnTo', 'not an email'); await click('#adminContent button', 'Save the address'); await sleep(300);
  check('a bad address is refused in words', /email/i.test(await toastText()) && !T('weekly_digest')[0].to_email, await toastText());
  await typeIn('#cnTo', 'office@example.org'); await click('#adminContent button', 'Save the address'); await waitFor(`/It will go to office@example.org/.test(document.getElementById('toast').textContent)`);
  check('a good address is saved and the toast says where it will go', T('weekly_digest')[0].to_email === 'office@example.org');
  await ev(`[...document.querySelectorAll('#adminContent .gw-switch input')].pop().click(); 'ok'`); await waitFor(`/Thursday email is on/.test(document.getElementById('toast').textContent)`);
  check('the switch turns the Thursday email on and says so', T('weekly_digest')[0].enabled === true && T('candle_settings')[0].enabled === true && await ev(`[...document.querySelectorAll('#adminContent .gw-status')].some(e => e.textContent.trim() === 'On')`));
  await click('#adminContent button', 'See what it would say'); await waitFor(`/This is what the email would say/.test(document.getElementById('toast').textContent)`);
  check('“See what it would say” shows the list without sending it', mails.length === 0 && await ev(`/Mary Murphy|Joseph Okafor|LIGHT A CANDLE/.test(document.getElementById('adminContent').innerText)`));
  await click('#adminContent button', 'Send it now'); await waitFor(`/Sent to office@example.org/.test(document.getElementById('toast').textContent)`);
  check('“Send it now” sends one email to that address and says so', mails.length === 1 && mails[0].to === 'office@example.org', JSON.stringify(mails.map(m => m.to)));
  check('the email has the names and counts but never a phone number, an email address of a parishioner, or an intention', mails[0] && /Joseph Okafor|Mary Murphy/.test(mails[0].text) && !/07700|joseph@example|Thanksgiving|For my mother/.test(mails[0].text + mails[0].html), mails[0] && mails[0].text.slice(0, 300));
  check('the screen then shows when the last email was sent', await waitFor(`/Last email sent/.test(document.getElementById('adminContent').innerText)`));
  const em = await ev(MEASURE_ADMIN);
  check('the Thursday email screen: no sideways scroll, tap targets 44px or larger', !em.hscroll && !em.smallTargets.length, JSON.stringify([em.scrollWidth, em.smallTargets.slice(0, 5)]));
  await shot('admin-390-candles-email');

  // ---- closing it hides the shortcut on the parish page
  await click('.seg button', 'Requests');
  await ev(`document.querySelector('#adminContent .gw-switchrow input').click(); 'ok'`); await waitFor(`/now closed/.test(document.getElementById('toast').textContent)`);
  await open(base + '/go/svp-osterley', "document.querySelector('.door')");
  check('once closed, the candle shortcut is gone from the parish page', await ev(`!document.querySelector('a.ic[href^="/candles/"]')`));

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CANDLES BROWSER CHECKS PASSED');
  console.log('screenshots in ' + OUT);
  proc.kill();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { proc && proc.kill(); } catch { /* done */ } process.exit(2); });
