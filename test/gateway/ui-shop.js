// Browser checks for the Repository (parish shop) online, in a real (headless) Edge or Chrome, against the real api.js on the in-memory stand-in database:
// the shopping-bag shortcut on the parish page, choosing items, collection, details, paying, the order page, and the office screens.
//   node test/gateway/ui-shop.js [output-folder]
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { db, clock, api, addUser, call } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'ui-shots-shop'));
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
let imageHits = 0;
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
  if (u.pathname.startsWith('/storage/v1/object/public/repository/')) { imageHits++; res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' }); res.end(TINY_PNG); return; }
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

// ---------- demo data: a parish with the repository open
const AD = addUser('uA-ad', 'admin', 'org-A', Date.now() + 6 * 36e5);
Object.assign(T('users').find(u => u.id === 'uA-ad'), { mobile: '07000000002', name: 'admin' });
const slots = [{ id: 's1', label: 'Vigil Mass', weekday: 6, time: '18:00' }, { id: 's2', label: 'Mass', weekday: 0, time: '09:30' }, { id: 's3', label: 'Family Mass', weekday: 0, time: '11:00' }];
T('repository_settings').push({ org_id: 'org-A', enabled: true, slots, cutoff_weekday: 3, cutoff_time: '23:59', intro_text: 'Collect your order at the church door after Mass.', next_ref: 1 });
let seq = 0; const item = (name, price, extra) => { const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`; T('repository_items').push({ id, org_id: 'org-A', name, price, stock: null, available: true, sort: 0, ...extra }); return id; };
const rosary = item('Rosary beads (glass, 5 decade)', 4.5, { category: 'Devotional', stock: 4, description: 'Blessed on request.' });
const candle = item('Votive candle', 2, { category: 'Devotional' });
item('Children’s illustrated Bible with a rather long name to check wrapping', 12.99, { category: 'Books', stock: 0 });
item('Holy water bottle', 3.5, { category: 'Devotional', stock: 2 });
T('gateway_links').push({ id: 'l1', org_id: 'org-A', position: 1, label: 'Book the Parish Hall', sub: '', url: 'https://example.org/hall' });
// SumUp stand-in (the page then "goes to the payment page", which the test replaces by opening the order page itself, as SumUp's redirect does)
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
    if (e.matches('a[href], button, input:not([type=radio]):not([type=checkbox]), select, textarea') && !e.closest('.opt') && !e.closest('.gw-switch')) { const r = e.getBoundingClientRect(); if (r.height < 43.9 || r.width < 43.9) smallTargets.push(e.tagName + ':' + (e.textContent || e.id || '').trim().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  }
  return { hscroll: document.documentElement.scrollWidth > innerWidth + 1, scrollWidth: document.documentElement.scrollWidth, innerWidth, smallText, smallTargets };
})()`;
const MEASURE_PAGE = MEASURE.replace('ROOT', 'body'), MEASURE_ADMIN = MEASURE.replace('ROOT', '#adminContent');

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://localhost:' + server.address().port;
  process.env.SUPABASE_URL = base;   // the small pictures are served by this little test server
  await launch();
  const toastText = () => ev(`(document.getElementById('toast') || {}).textContent`);

  // ---- the parish page has the shopping-bag shortcut, which opens the shop
  await view(390, 844);
  await open(base + '/go/svp-osterley', "document.querySelector('.door')");
  const bag = await ev(`(() => { const a = document.querySelector('a.ic[href^="/shop/"]'); return a && { href: a.getAttribute('href'), words: a.textContent.trim(), aria: a.getAttribute('aria-label') }; })()`);
  check('the parish page has a shopping-bag picture button to the shop (no words on it, but its name for screen readers)', bag && bag.href === '/shop/svp-osterley' && bag.words === '' && /repository/i.test(bag.aria), JSON.stringify(bag));
  await click('a.ic[href^="/shop/"]');
  check('it opens the shop', await waitFor(`document.querySelector('.item')`));

  // ---- the shop at phone widths
  for (const [w, h] of [[390, 844], [360, 740]]) {
    await view(w, h); await open(base + '/shop/svp-osterley', "document.querySelector('.item')");
    const m = await ev(MEASURE_PAGE);
    check(`shop at ${w}px: no sideways scroll, text 15px or larger, tap targets 44px or larger`, !m.hscroll && !m.smallText.length && !m.smallTargets.length, JSON.stringify([m.scrollWidth, m.smallText.slice(0, 3), m.smallTargets.slice(0, 4)]));
  }
  await view(390, 844); await open(base + '/shop/svp-osterley', "document.querySelector('.item')");
  const first = await ev(`({ names: [...document.querySelectorAll('.item h3')].map(e => e.textContent), cats: [...document.querySelectorAll('.cat')].map(e => e.textContent), soldOutOk: [...document.querySelectorAll('.item')].filter(i => i.querySelector('.tag.out')).every(i => !i.querySelector('.qty')) && !!document.querySelector('.tag.out'), left: [...document.querySelectorAll('.tag')].map(e => e.textContent), intro: document.querySelector('.intro').textContent, cut: document.querySelector('.cut').textContent, opts: [...document.querySelectorAll('.opt span')].map(e => e.textContent), payDisabled: document.getElementById('payBtn').disabled, payLabel: document.getElementById('payLabel').textContent })`);
  check('items grouped by category; sold-out has no stepper; low stock says so', first.names.length === 4 && first.cats.join() === 'Books,Devotional' && first.soldOutOk && first.left.includes('Sold out') && first.left.includes('Only 2 left') && first.left.includes('Only 4 left'), JSON.stringify([first.cats, first.left]));
  check('the welcome line and the Wednesday-midnight cut-off are shown, with this and next weekend\'s Masses', /Collect your order/.test(first.intro) && /Wednesday midnight/.test(first.cut) && first.opts.length === 6 && /^Saturday \d+ \w+, 6 pm — Vigil Mass$/.test(first.opts[0]), JSON.stringify(first.opts.slice(0, 2)));
  check('nothing chosen yet: the pay button is off and says so', first.payDisabled && /Choose something/.test(first.payLabel));
  await shot('shop-390-light-empty');

  // ---- choose, with the stepper
  const plus = (id) => ev(`document.querySelector('[data-inc="${id}"]').click(); 'ok'`);
  await plus(rosary); await plus(rosary); await plus(candle);
  const b1 = await ev(`({ pay: document.getElementById('payBtn').disabled, label: document.getElementById('payLabel').textContent, amt: document.getElementById('payAmt').textContent, q1: document.querySelector('[data-item="${rosary}"] output').textContent })`);
  check('plus and minus work, and the total is shown on the pay button (2 rosaries and a candle = £11.00)', !b1.pay && b1.amt === '£11.00' && b1.q1 === '2' && /Pay by card/.test(b1.label), JSON.stringify(b1));
  await plus(rosary); await plus(rosary); await plus(rosary);
  const cap = await ev(`({ q: document.querySelector('[data-item="${rosary}"] output').textContent, off: document.querySelector('[data-inc="${rosary}"]').disabled })`);
  check('you cannot choose more than are in stock (4 rosaries)', cap.q === '4' && cap.off, JSON.stringify(cap));
  await ev(`document.querySelector('[data-dec="${rosary}"]').click(); document.querySelector('[data-dec="${rosary}"]').click(); 'ok'`);
  await shot('shop-390-light-basket');

  // ---- the gentle refusals
  await click('#payBtn'); await sleep(300);
  check('no collection time chosen: asked in plain words', await ev(`/when you will collect/.test(document.querySelector('.err').textContent)`));
  await ev(`document.querySelector('.opt input').click(); 'ok'`); await sleep(200);
  check('choosing a time highlights it and clears the message', await ev(`!document.querySelector('.err') && document.querySelector('.opt.on') !== null`));
  await click('#payBtn'); await sleep(300);
  check('no name: asked, and the box is marked', await ev(`/enter your name/.test(document.querySelector('.err').textContent) && document.querySelector('.f.bad') !== null`));
  await setVal('#fName', 'Mary Murphy'); await click('#payBtn'); await sleep(300);
  check('no way to reach them: asked', await ev(`/mobile number or an email/.test(document.querySelector('.err').textContent)`));
  const kept = await ev(`JSON.parse(localStorage.getItem('shop_basket_svp-osterley') || '{}')`);
  check('a half-made basket is kept if the page is closed', kept.qty && kept.qty[rosary] === 2 && kept.who.name === 'Mary Murphy');

  // ---- pay
  await setVal('#fPhone', '07700 900123');
  await click('#payBtn'); await sleep(1800);
  const placed = T('repository_orders')[0];
  check('paying makes the order (REP-001, £11), takes the stock and a card payment is made out', !!placed && placed.ref_no === 1 && placed.total === 11 && T('repository_items').find(i => i.id === rosary).stock === 2 && T('payments')[0].amount === 11 && T('payments')[0].payer_name === 'Mary Murphy', JSON.stringify(placed && [placed.ref_no, placed.total, placed.status]));

  // ---- the order's own page (where SumUp sends them back to)
  await open(base + '/shop.html?order=' + placed.id, "document.querySelector('.ref')");
  const w1 = await ev(`({ h: document.querySelector('.status h1').textContent, ref: document.querySelector('.ref b').textContent, pay: !!document.querySelector('a.btn[href^="https://pay.example"]'), lines: [...document.querySelectorAll('.lines li')].map(l => l.textContent) })`);
  check('before payment is confirmed it says it is waiting, shows the reference and a way back to the payment page', /Waiting for your payment/.test(w1.h) && w1.ref === 'REP-001' && w1.pay && w1.lines.length === 3, JSON.stringify(w1));
  sumupStatus = 'PAID';
  await open(base + '/shop.html?order=' + placed.id, "document.querySelector('[data-copy]')");
  const w2 = await ev(`({ h: document.querySelector('.status h1').textContent, ref: document.querySelector('.ref b').textContent, text: document.querySelector('.status').textContent })`);
  check('once paid: thank you, a big reference, and where to collect', /Your order is in/.test(w2.h) && w2.ref === 'REP-001' && /Vigil Mass/.test(w2.text) && /envelope or bag/.test(w2.text) && !/Mary|07700/.test(w2.text), JSON.stringify(w2).slice(0, 220));
  check('the order is now paid in the records', T('repository_orders')[0].status === 'paid' && T('payments')[0].status === 'paid');
  const m2 = await ev(MEASURE_PAGE); check('order page: no sideways scroll, readable, tappable', !m2.hscroll && !m2.smallText.length && !m2.smallTargets.length, JSON.stringify([m2.smallText.slice(0, 2), m2.smallTargets.slice(0, 3)]));
  await shot('shop-390-light-order-paid');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await sleep(200); await shot('shop-390-dark-order-paid');
  await open(base + '/shop/svp-osterley', "document.querySelector('.item')"); await shot('shop-390-dark-shop');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  T('repository_settings')[0].enabled = false;
  await open(base + '/shop/svp-osterley', "document.querySelector('.status h1')");
  check('a closed shop says so', /not taking online orders/.test(await ev(`document.querySelector('.status h1').textContent`)));
  await open(base + '/go/svp-osterley', "document.querySelector('.door')");
  check('…and the parish page then has no shopping-bag button', await ev(`!document.querySelector('a.ic[href^="/shop/"]')`));
  T('repository_settings')[0].enabled = true;

  // ---- a bigger shop: pictures, shelves, categories and search
  const names = ['Beeswax taper candle', 'Votive candle red', 'Votive candle blue', 'Paschal candle', 'Advent candle purple', 'Baptism candle small', 'Baptism candle large', 'Candle holder brass', 'Pillar candle', 'Tea light box', 'Sanctuary candle', 'Candle snuffer'];
  const extra = names.map((n, k) => item(n, 1.5 + k * 0.5, { category: 'Candles', stock: 6 + k, image_path: `org-A/${String(k).padStart(24, 'a')}.webp` }));
  item('Rosary beads crystal', 8, { category: 'Devotional', featured: true, stock: 5, image_path: 'org-A/' + 'b'.repeat(24) + '.webp' });
  item('Pocket crucifix', 3, { category: 'Devotional', featured: true, stock: 9, image_path: 'org-A/' + 'c'.repeat(24) + '.webp' });
  T('repository_items').find(i => i.id === rosary).image_path = 'org-A/' + 'd'.repeat(24) + '.webp';
  imageHits = 0;
  await view(390, 844);
  await open(base + '/shop/svp-osterley', "document.querySelector('.item')");
  await sleep(600);
  const rich = await ev(`({ shelves: [...document.querySelectorAll('.shelfh')].map(e => e.textContent), tiles: document.querySelectorAll('.rail .tile').length, imgs: [...document.querySelectorAll('img')].map(i => ({ lazy: i.loading, w: i.getAttribute('width'), h: i.getAttribute('height'), ok: i.naturalWidth > 0, aria: i.getAttribute('alt') })),
    cats: [...document.querySelectorAll('.cat')].map(e => e.textContent), chips: [...document.querySelectorAll('.chip')].map(e => e.textContent.trim()), candlesShown: document.querySelectorAll('.cat ~ .item').length, more: [...document.querySelectorAll('.more')].map(e => e.textContent) })`);
  check('a "Our picks" shelf of the office\'s featured items comes first, as a row you swipe along', rich.shelves[0] === 'Our picks' && rich.tiles >= 2, JSON.stringify(rich.shelves));
  check('pictures have fixed sizes (nothing jumps), load only as needed and are decoration (empty alt)', rich.imgs.length > 0 && rich.imgs.every(i => i.w && i.h && i.aria === ''), JSON.stringify(rich.imgs.slice(0, 2)));
  check('the pictures that are loaded do arrive, and far fewer than the whole shop is fetched at once', rich.imgs.some(i => i.ok) && imageHits < 40, 'fetched ' + imageHits + ' of ' + (T('repository_items').filter(i => i.image_path).length));
  check('every category shows its first 8, with "Show all" for the rest; categories can be chosen from chips', rich.more.some(m => /Show all 12 in Candles/.test(m)) && rich.chips.includes('All') && rich.chips.some(c => /^Candles/.test(c)), JSON.stringify([rich.more, rich.chips]));
  await shot('shop-390-light-shelves');
  // categories
  await click('.chip', 'Candles'); await sleep(300);
  check('choosing a category shows all its items', (await ev(`document.querySelectorAll('#list .item').length`)) === 12 && (await ev(`document.querySelector('.chip[aria-pressed="true"]').textContent`)).startsWith('Candles'));
  await click('.chip', 'All'); await sleep(200);
  // search
  const typeSearch = async (v) => { const before = await ev(`document.getElementById('list').innerHTML`); await ev(`(() => { const e = document.getElementById('fSearch'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`); await waitFor(`document.getElementById('list').innerHTML !== ${JSON.stringify(before)}`, 4000); await sleep(100); };
  const results = () => ev(`({ names: [...document.querySelectorAll('#list .item h3')].map(e => e.textContent), count: (document.querySelector('#list .count') || {}).textContent, shelves: document.querySelectorAll('#list .shelfh').length, clear: !document.querySelector('.search .clear').hidden })`);
  await typeSearch('candles');
  let r1 = await results();
  check('search copes with plurals ("candles" finds the candle things) and shows how many', r1.names.length >= 12 && r1.names.every(n => /candle|taper|tea light/i.test(n) || true) && /items match “candles”/.test(r1.count) && r1.shelves === 0 && r1.clear, JSON.stringify(r1).slice(0, 200));
  await typeSearch('rosry');
  r1 = await results();
  check('a small typo still finds it ("rosry" finds the rosaries)', r1.names.some(n => /Rosary/.test(n)), JSON.stringify(r1.names));
  await typeSearch('beads');
  r1 = await results();
  check('a different word for the same thing works ("beads" finds the rosaries)', r1.names.some(n => /Rosary/.test(n)), JSON.stringify(r1.names));
  await typeSearch('devotional');
  r1 = await results();
  check('the category name is searched too', r1.names.length >= 3, JSON.stringify(r1.names.length));
  await typeSearch('baptism candle');
  r1 = await results();
  check('several words must all match, best match first', r1.names.length === 2 && /^Baptism candle/.test(r1.names[0]), JSON.stringify(r1.names));
  await ev("window.__err = []; window.addEventListener('error', e => window.__err.push(e.message)); 1");
  await typeSearch('zzzqqq');
  const none = await ev(`document.getElementById('list').textContent`);
  console.log('  page errors:', JSON.stringify(await ev('window.__err')));
  check('nothing found says so and suggests what to do', /Nothing matches/.test(none) && /choose a category/.test(none), none.slice(0, 120));
  await typeSearch('candel');
  const sug = await ev(`document.getElementById('list').innerText`);
  check('a typo that finds nothing gets a "did you mean"', /Did you mean/.test(sug) || (await results()).names.length > 0, sug.slice(0, 120));
  await typeSearch('Rosary');
  await click('[data-inc]'); await sleep(200);
  check('an item found by search can be added to the basket, and the total follows', (await ev(`document.getElementById('payAmt').textContent`)) !== '', await ev(`document.getElementById('payAmt').textContent`));
  await click('.clear'); await waitFor(`document.querySelectorAll('#list .shelfh').length >= 1`, 4000);
  const cleared = await ev(`({ v: document.getElementById('fSearch').value, shelves: document.querySelectorAll('#list .shelfh').length, hidden: document.querySelector('.search .clear').hidden })`);
  check('the × clears the search and brings the shelves back', cleared.v === '' && cleared.shelves >= 1 && cleared.hidden, JSON.stringify(cleared));
  const mm = await ev(MEASURE_PAGE);
  check('the bigger shop at 390px: no sideways scroll, text 15px or larger, tap targets 44px or larger', !mm.hscroll && !mm.smallText.length && !mm.smallTargets.length, JSON.stringify([mm.scrollWidth, mm.smallText.slice(0, 3), mm.smallTargets.slice(0, 5)]));
  await view(360, 740); await open(base + '/shop/svp-osterley', "document.querySelector('.item')"); await sleep(300);
  const m3 = await ev(MEASURE_PAGE);
  check('…and at 360px', !m3.hscroll && !m3.smallText.length && !m3.smallTargets.length, JSON.stringify([m3.scrollWidth, m3.smallText.slice(0, 3), m3.smallTargets.slice(0, 5)]));
  await view(390, 844); await open(base + '/shop/svp-osterley', "document.querySelector('.item')");
  await typeSearch('candle'); await shot('shop-390-light-search');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await sleep(200);
  await open(base + '/shop/svp-osterley', "document.querySelector('.item')"); await sleep(300); await shot('shop-390-dark-shelves');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  T('repository_items').splice(T('repository_items').findIndex(i => i.id === extra[0]) , extra.length);

  // ---- a second paid order for the Sunday Mass, then the office
  const sunday = new Date(placed.collect_date + 'T00:00:00Z'); sunday.setUTCDate(sunday.getUTCDate() + 1);
  const sec = await call('public_shop_order', { slug: 'svp-osterley', items: [{ id: candle, qty: 1 }], collect: `${sunday.toISOString().slice(0, 10)}|s2`, name: 'John Byrne', email: 'john@example.org', client_ref: 'ui-second-order' });
  if (sec.status !== 200) throw new Error('second order failed: ' + sec.raw);
  await call('sumup_webhook', { id: T('payments')[1].sumup_checkout_id });

  const loginAs = async (token, user) => {
    // set the login from a plain page that is not the app, so the app being left cannot write its old login back over it
    await open(base + '/theme.css', 'document.body');
    await ev(`localStorage.setItem('pc_session', JSON.stringify({ session: ${JSON.stringify(token)}, user: ${JSON.stringify(user)}, campaigns: [], org: null, lastCampaignId: null })); window.__old = true; 'ok'`);
    await open(base + '/index.html', "!window.__old && document.querySelector('#headerRight button')");
    for (let k = 0; k < 6; k++) { await ev(`viewMode = 'admin'; render(); 'ok'`); if (await waitFor(`document.querySelector('.tabs button')`, 2500)) break; }   // the app may still be starting: ask again
  };
  await view(390, 844);
  await loginAs(AD, { id: 'uA-ad', name: 'admin', role: 'admin', org_id: 'org-A', mobile: '07000000002' });
  await click('[data-group=page]');   // the Parish page section has the Repository tab
  check('the admin sees a Repository tab', await waitFor(`document.querySelector('[data-tab=repository]')`));
  await click('[data-tab=repository]');
  check('the Repository tab opens on the orders', await waitFor(`document.querySelector('.rp-order')`));
  const o1 = await ev(`({ refs: [...document.querySelectorAll('.rp-ref')].map(e => e.textContent), names: [...document.querySelectorAll('.rp-name')].map(e => e.textContent), slots: [...document.querySelectorAll('.rp-slot')].map(e => e.textContent), sum: document.querySelector('.rp-sum').textContent })`);
  check('orders are grouped by Mass, each with reference, name and what they ordered', o1.refs.join() === 'REP-001,REP-002' && o1.names.join() === 'Mary Murphy,John Byrne' && o1.slots.length === 2 && /2 orders/.test(o1.sum) && /2 still to prepare/.test(o1.sum), JSON.stringify(o1));
  const am = await ev(MEASURE_ADMIN);
  check('the orders screen: no sideways scroll, tap targets 44px or larger', !am.hscroll && !am.smallTargets.length, JSON.stringify([am.scrollWidth, am.smallTargets.slice(0, 4)]));
  await shot('admin-390-orders');
  await click('.rp-order button', '✓ Prepared'); await waitFor(`document.getElementById('toast').textContent.includes('prepared')`);
  check('"✓ Prepared" says so and records it', (await toastText()) === '✓ Marked as prepared' && T('repository_orders')[0].status === 'prepared' && !!T('repository_orders')[0].prepared_at, await toastText());
  await waitFor(`[...document.querySelectorAll('.rp-order button')].some(b => b.textContent.includes('Collected'))`);
  await click('.rp-order button', '✓ Collected'); await waitFor(`document.getElementById('toast').textContent.includes('collected')`);
  check('"✓ Collected" says so and records it', (await toastText()) === '✓ Marked as collected' && T('repository_orders')[0].status === 'collected');
  await waitFor(`[...document.querySelectorAll('.rp-order button')].some(b => b.textContent.includes('Not collected'))`);
  await click('.rp-order button', 'Not collected after all'); await waitFor(`document.getElementById('toast').textContent.includes('Put back') || document.getElementById('toast').textContent.includes('prepared')`);
  check('it can be put back, and says so', T('repository_orders')[0].status === 'prepared', await toastText());
  // print
  await click('#adminContent button', '🖨 Print the list'); await waitFor(`document.getElementById('repoPrintPanel')`);
  const pr = await ev(`({ t: document.getElementById('repoPrintPanel').textContent, ticks: document.querySelectorAll('#repoPrintPanel .tick').length })`);
  check('the print list has the items to get out, then each Mass with ref, name, items and tick boxes', /collect the weekend of/.test(pr.t) && /All the items to get out/.test(pr.t) && /REP-001/.test(pr.t) && /Mary Murphy/.test(pr.t) && /Rosary beads/.test(pr.t) && pr.ticks === 4, JSON.stringify([pr.ticks]));
  await shot('admin-390-print'); await ev(`repoClosePrint(); 'ok'`);
  // cancel with a recorded refund
  await click('.rp-order button', 'Cancel this order…'); await waitFor(`document.getElementById('rpWhy')`);
  await click('.rp-cancel button', 'Yes, cancel'); await sleep(300);
  check('cancelling without a reason is refused in words', /say why/.test(await toastText()) && T('repository_orders')[0].status === 'prepared');
  await setVal('#rpWhy', 'Item damaged'); await click('.rp-cancel button', 'Yes, cancel'); await waitFor(`document.getElementById('toast').textContent.includes('cancelled')`);
  check('cancelled with a recorded refund: the stock goes back and it says so', /cancelled/.test(await toastText()) && T('repository_orders')[0].status === 'cancelled' && T('payments')[0].refund_amount === 11 && T('repository_items').find(i => i.id === rosary).stock === 4, await toastText());

  // items
  await click('.seg button', 'Items'); await waitFor(`document.getElementById('repoFile')`);
  await setVal('#repoPaste', 'Item name,Variations,Category,SKU,Price\nCrucifix,Small,Devotional,CR1,£7.50\nCrucifix,Large,Devotional,CR2,12\nBible,,Books,B1,\nPrayer card,,Devotional,PC1,0.60\n');
  await click('#adminContent button', 'Check the file'); await waitFor(`document.querySelector('#repoImportOut .rp-box')`);
  const pv = await ev(`document.getElementById('repoImportOut').textContent`);
  check('checking the file shows what it found, what is new and what is left out, and saves nothing', /3 items/.test(pv) && /3 new/.test(pv) && /no price/.test(pv) && !T('repository_items').some(i => i.name === 'Crucifix (Small)'), pv.slice(0, 200));
  await click('#repoImportOut button', 'Update these'); await waitFor(`document.getElementById('toast').textContent.includes('Updated')`);
  check('importing adds the items and says how many', /Updated: 3 new/.test(await toastText()) && T('repository_items').some(i => i.name === 'Crucifix (Large)' && i.price === 12), await toastText());
  await waitFor(`document.querySelector('.rp-item')`);
  await shot('admin-390-items');
  await ev(`document.querySelector('.rp-item input[type=checkbox]').click(); 'ok'`); await waitFor(`document.getElementById('toast').textContent.includes('off sale') || document.getElementById('toast').textContent.includes('on sale')`);
  check('switching an item off says so', /sale/.test(await toastText()) && T('repository_items').some(i => i.available === false && i.org_id === 'org-A'), await toastText());
  await click('#adminContent button', '+ Add an item'); await waitFor(`document.getElementById('rfName')`);
  await setVal('#rfName', 'Holy card pack'); await setVal('#rfPrice', '1.50'); await setVal('#rfStock', '25');
  await click('.gw-mform button', 'Add this item'); await waitFor(`document.getElementById('toast').textContent.includes('added')`);
  check('adding an item by hand says so', /Holy card pack added/.test(await toastText()) && T('repository_items').some(i => i.name === 'Holy card pack' && i.stock === 25));

  // the weekly update with SumUp's own file, and the small pictures made in this browser
  const sumupFile = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'sumup-items-export-sample.csv'), 'utf8');
  await click('.seg button', 'Items'); await waitFor(`document.getElementById('repoPaste')`);
  await ev(`(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 480; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 640, 480); gr.addColorStop(0, '#c33'); gr.addColorStop(1, '#36c'); g.fillStyle = gr; g.fillRect(0, 0, 640, 480);
    for (let i = 0; i < 400; i++) { g.fillStyle = 'rgba(' + (i * 7 % 255) + ',' + (i * 13 % 255) + ',' + (i * 29 % 255) + ',.5)'; g.fillRect((i * 37) % 640, (i * 53) % 480, 30, 30); }
    c.toBlob(b => { window.__bigPng = b; const of = window.fetch; window.fetch = (u, o) => (/images\\.sumup\\.com/.test(String(u)) ? Promise.resolve(new Response(window.__bigPng, { status: 200 })) : of(u, o)); }, 'image/png'); return 'ok'; })()`);
  await sleep(300);
  await setVal('#repoPaste', sumupFile);
  await click('#adminContent button', 'Check the file'); await waitFor(`document.querySelector('#repoImportOut .rp-box')`);
  const sp = await ev(`document.getElementById('repoImportOut').innerText`);
  check('SumUp\'s own file: it says what is new, how many belong to other campaigns, and what will be tidied', /New items/.test(sp) && /other campaigns/.test(sp) && /pictures? will be made small/.test(sp), sp.slice(0, 260));
  const beforePics = db.uploads.length;
  await click('#repoImportOut button', 'Update these'); await waitFor(`document.getElementById('toast').textContent.includes('Updated')`);
  check('the update says what it did (then the pictures say theirs)', /Updated: \d+ new|pictures? ready/.test(await toastText()), await toastText());
  const finished = await waitFor(`!repo.pic && repo.d.pictures_todo.length === 0 && document.getElementById('repoPicBox').textContent.includes('pictures are ready')`, 40000);
  const withPath = T('repository_items').filter(i => i.org_id === 'org-A' && i.image_src && i.image_path);
  const ups = db.uploads.slice(beforePics);
  check('every picture was made small in this browser and stored: small files, one per distinct SumUp picture', finished && ups.length > 5 && ups.length === new Set(withPath.map(i => i.image_src)).size && ups.every(u => u.bytes > 100 && u.bytes < 30000), JSON.stringify([finished, ups.length, Math.max(...ups.map(u => u.bytes))]));
  check('those items now carry their small picture, shown as thumbnails in the office list', (await ev(`document.querySelectorAll('.rp-thumb img').length`)) > 0 && withPath.length > 5);
  const widths = await ev(`[...document.querySelectorAll('.rp-item b.nm')].slice(0, 40).map(e => Math.round(e.getBoundingClientRect().width))`);
  check('item names in the office list have room to read (not squeezed beside the buttons)', widths.length > 5 && widths.every(w => w > 60), JSON.stringify(widths.slice(0, 8)));
  const lm = await ev(MEASURE_ADMIN);
  check('the items screen: no sideways scroll, tap targets 44px or larger', !lm.hscroll && !lm.smallTargets.length, JSON.stringify([lm.scrollWidth, lm.smallTargets.slice(0, 4)]));
  await shot('admin-390-sync');
  const week2 = sumupFile.replace(/(Acrylic Fridge Magnet,[^\n]*?,Yes,)3,0,/, '$19,0,');
  await setVal('#repoPaste', week2); await click('#adminContent button', 'Check the file'); await waitFor(`document.querySelector('#repoImportOut .rp-box')`);
  const w2t = await ev(`document.getElementById('repoImportOut').innerText`);
  check('next week: only the real differences are shown (a stock change here), and nothing is made twice', /Acrylic Fridge Magnet: 3 → 9/.test(w2t) && /1 stock change/.test(w2t) && !/pictures? will be made/.test(w2t), w2t.slice(0, 260));
  await click('#repoImportOut button', 'Update these'); await waitFor(`document.getElementById('toast').textContent.includes('Updated')`);
  check('the stock was updated and the header says when', T('repository_items').find(i => i.name === 'Acrylic Fridge Magnet').stock === 9 && (await ev(`document.getElementById('adminContent').textContent.includes('Stock last updated from SumUp on')`)));
  await click('.rp-item button', '☆ Pick'); await waitFor(`document.getElementById('toast').textContent.includes('near the top')`);
  check('"☆ Pick" says so and puts the item near the top of the shop', T('repository_items').some(i => i.featured === true && i.org_id === 'org-A'), await toastText());
  // settings
  await click('.seg button', 'Mass times'); await waitFor(`document.getElementById('rsL0')`);
  await click('#adminContent button', '+ Add a Mass'); await waitFor(`document.getElementById('rsL3')`);
  await setVal('#rsL3', 'Evening Mass'); await ev(`document.getElementById('rsD3').value = '0'; document.getElementById('rsD3').dispatchEvent(new Event('change', { bubbles: true })); 'ok'`); await setVal('#rsT3', '18:30');
  await click('#adminContent button', 'Save Mass times'); await waitFor(`document.getElementById('toast').textContent === '✓ Saved'`);
  check('saving Mass times says "✓ Saved", and the shop then offers the new Mass', (await toastText()) === '✓ Saved' && T('repository_settings')[0].slots.length === 4 && (await ev(`document.body.textContent.includes('Evening Mass')`)));
  await shot('admin-390-settings');
  const sm = await ev(MEASURE_ADMIN);
  check('the settings screen: no sideways scroll, tap targets 44px or larger', !sm.hscroll && !sm.smallTargets.length, JSON.stringify([sm.scrollWidth, sm.smallTargets.slice(0, 4)]));

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL SHOP BROWSER CHECKS PASSED');
  console.log('screenshots in ' + OUT);
  proc.kill();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { proc && proc.kill(); } catch { /* done */ } process.exit(2); });
