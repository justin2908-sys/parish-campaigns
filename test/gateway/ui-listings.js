// Browser checks for Listings (the parish classifieds), in a real (headless) Edge or Chrome, against the real api.js on the in-memory stand-in database:
// the shopping-bag shortcut on the parish page, choosing items, collection, details, paying, the order page, and the office screens.
//   node test/gateway/ui-shop.js [output-folder]
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { db, clock, api, addUser, call } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'ui-shots-listings'));
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
  let p = u.pathname; if (p === '/') p = '/index.html'; else if (p.startsWith('/listings/')) p = '/listings.html'; else if (p.startsWith('/go/') && p !== '/go/sw.js') p = '/go.html'; else if (p.startsWith('/go/') && p !== '/go/sw.js') p = '/go.html';
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
const AD = addUser('uA-ad', 'admin', 'org-A', Date.now() + 6 * 36e5);
Object.assign(T('users').find(u => u.id === 'uA-ad'), { mobile: '07000000002', name: 'admin' });
T('listings_settings').push({ org_id: 'org-A', enabled: true, intro_text: 'A noticeboard for our parish family.', price_base: 3, price_per_extra_week: 1.5, price_per_image: 0.5 });
T('gateway_links').push({ id: 'l1', org_id: 'org-A', position: 1, label: 'Book the Parish Hall', sub: '', url: 'https://example.org/hall' });
let lseq = 0;
const nowIso = new Date().toISOString(), inDays = (n) => new Date(Date.now() + n * 864e5).toISOString(), ago = (n) => new Date(Date.now() - n * 864e5).toISOString();
const live = (title, extra) => { const id = `00000000-0000-4000-8000-${String(++lseq).padStart(12, '0')}`; T('listings').push({ id, org_id: 'org-A', token: String(lseq).padStart(32, 'a'), title, description: 'A fairly full description of this listing, with enough words to be a proper description of it.', category: 'Other', kind: 'sell', price_text: '', display_name: 'Pat', email: `lister${lseq}@secret-example.org`, days: 14, status: 'live', images: [], fee: 0, featured: false, views: 0, contacts: 0, reports: 0, created_at: ago(1), starts_at: ago(1), ends_at: inDays(13), ...extra }); return id; };
const chairs = live('Garden chairs, set of four', { category: 'Furniture & home', price_text: '£40 the set', images: [{ t: 'org-A/chairs-t.webp', f: 'org-A/chairs-f.webp' }, { t: 'org-A/chairs2-t.webp', f: 'org-A/chairs2-f.webp' }], views: 12, contacts: 3, description: 'Four sturdy wooden garden chairs, a few years old but in good condition.\n\nCollect from Osterley.' });
live('Plumber available for small jobs', { category: 'Services & trades', kind: 'service', price_text: 'From £30 an hour', views: 9, contacts: 2 });
live('Children’s winter coats, free', { category: 'Clothes & children', kind: 'free', created_at: ago(8), starts_at: ago(8), views: 5, contacts: 1 });
live('Homemade fruit cakes for sale', { category: 'Food & baking', price_text: '£12 each', created_at: ago(0.2), starts_at: ago(0.2) });
live('Gardening and hedge trimming', { category: 'Garden & outdoors', kind: 'service', price_text: 'Quotes free', created_at: ago(5), starts_at: ago(5), views: 4 });
live('Bulk chicken, 10 kilo boxes', { category: 'Food & baking', price_text: '£45 a box', created_at: ago(6), starts_at: ago(6) });
T('listings').find(l => l.id === chairs).featured = true;
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
  process.env.SUPABASE_URL = base;   // the small pictures are served by this little test server
  await launch();
  const toastText = () => ev(`(document.getElementById('toast') || {}).textContent`);
  const typeIn = async (sel, v) => { await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`); };

  // ---- the parish page has a picture-only shortcut to Listings
  await view(390, 844);
  await open(base + '/go/svp-osterley', "document.querySelector('.door')");
  const tag = await ev(`(() => { const a = document.querySelector('a.ic[href^="/listings/"]'); return a && { href: a.getAttribute('href'), words: a.textContent.trim(), aria: a.getAttribute('aria-label') }; })()`);
  check('the parish page has a price-tag picture button to Listings (no words on it; its name is for screen readers)', tag && tag.href === '/listings/svp-osterley' && tag.words === '' && /listings/i.test(tag.aria), JSON.stringify(tag));
  await click('a.ic[href^="/listings/"]');
  check('it opens the Listings page', await waitFor(`document.querySelector('.item')`));
  // the invitation: Listings is new, so the first time someone opens it they are warmly asked to add something
  const inv = await waitFor(`document.getElementById('inviteCard')`, 6000);
  check('a friendly prompt to list appears on screen when the page opens', inv);
  const iv = await ev(`(() => { const c = document.getElementById('inviteCard'); return c && { head: c.querySelector('h2').textContent, text: c.textContent, add: !!c.querySelector('a[href="#new"]'), looking: [...c.querySelectorAll('button')].some(b => /Just looking/.test(b.textContent)), focused: document.activeElement === c }; })()`);
  check('it has a catchy line, says how quick it is, that £0 is fine, that the office checks, and how many are listed already', iv && iv.head.length > 15 && /two minutes/.test(iv.text) && /£0 is a perfectly good price/.test(iv.text) && /office looks at every listing/.test(iv.text) && /6 listings/.test(iv.text) && /The more of us list/.test(iv.text), JSON.stringify(iv && [iv.head, iv.text.slice(0, 160)]));
  check('it has an "Add a listing" button and a "Just looking" way out, and takes the focus', iv && iv.add && iv.looking && iv.focused);
  await shot('listings-390-light-invite');
  const inm = await ev(MEASURE_PAGE);
  check('the prompt at 390px: readable and tappable', !inm.hscroll && !inm.smallText.length && !inm.smallTargets.length, JSON.stringify([inm.smallText.slice(0, 2), inm.smallTargets.slice(0, 3)]));
  await click('[data-invite-close]', 'Just looking'); await sleep(200);
  check('"Just looking" closes it, and it is not asked again on the next visit', await ev(`!document.getElementById('invite') && !!localStorage.getItem('lst_invited_svp-osterley')`));
  await open(base + '/listings/svp-osterley', "document.querySelector('.item')"); await sleep(600);
  check('…not even after the page is opened again', await ev(`!document.getElementById('invite')`));
  await ev(`localStorage.removeItem('lst_invited_svp-osterley'); 'ok'`);
  await open(base + '/listings/svp-osterley', "document.getElementById('invite')");
  await click('[data-invite-add]');
  check('"Add a listing" in the prompt takes them straight to the form', await waitFor(`location.hash === '#new' && document.getElementById('fTitle') && !document.getElementById('invite')`, 6000));
  await ev(`localStorage.setItem('lst_invited_svp-osterley', String(Date.now() - 4 * 864e5)); 'ok'`);
  await open(base + '/listings/svp-osterley', "document.querySelector('.item')"); await sleep(500);
  check('after a few days it asks again, kindly', await ev(`!!document.getElementById('invite')`));
  await click('[data-invite-close]');
  await ev(`(() => { const e = document.getElementById('invite'); return 'closed'; })()`);

  // ---- the page itself
  for (const [w, h] of [[390, 844], [360, 740]]) {
    await view(w, h); await open(base + '/listings/svp-osterley', "document.querySelector('.item')"); await sleep(300);
    const m = await ev(MEASURE_PAGE);
    check(`browse at ${w}px: no sideways scroll, text 15px or larger, tap targets 44px or larger`, !m.hscroll && !m.smallText.length && !m.smallTargets.length, JSON.stringify([m.scrollWidth, m.smallText.slice(0, 3), m.smallTargets.slice(0, 4)]));
  }
  await view(390, 844); await open(base + '/listings/svp-osterley', "document.querySelector('.item')"); await sleep(300);
  const b1 = await ev(`({ notice: document.querySelector('.notice').textContent, add: !!document.getElementById('addBtn'), shelves: [...document.querySelectorAll('.shelfh')].map(e => e.textContent), items: document.querySelectorAll('.item').length, chips: [...document.querySelectorAll('.chip')].map(e => e.textContent.trim()), noindex: document.querySelector('meta[name=robots]').content, intro: document.querySelector('.intro').textContent,
    noEmail: !/secret-example|@/.test(document.getElementById('app').innerHTML + document.getElementById('sheetHost').innerHTML) })`);
  check('the notice is on the page without anyone asking: the church does not check, take part or accept responsibility', /does not check or guarantee/.test(b1.notice) && /takes no part in any deal/.test(b1.notice) && /not responsible/.test(b1.notice), b1.notice.slice(0, 120));
  check('the page is kept out of search engines, has a welcome line and an "Add a listing" button', /noindex/.test(b1.noindex) && b1.add && /noticeboard/.test(b1.intro));
  check('shelves ("Picked by the office", "Just added", "Most viewed"), every listing, and group chips (For sale, Free, Service, categories)', b1.shelves[0] === 'Picked by the office' && b1.shelves.includes('Just added') && b1.shelves.includes('Most viewed') && b1.items >= 6 && b1.chips.includes('All') && b1.chips.some(c => /^Free/.test(c)) && b1.chips.some(c => /^Service/.test(c)), JSON.stringify([b1.shelves, b1.chips]));
  check('no email address anywhere in the page', b1.noEmail);
  await click('[data-notice]'); await sleep(200);
  check('"Read the full notice" shows all of it', /Please check things for yourself/.test(await ev(`document.querySelector('.notice').textContent`)));
  await shot('listings-390-light-browse');

  // ---- search and groups
  const typeSearch = async (v) => { const before = await ev(`document.getElementById('list').innerHTML`); await typeIn('#fSearch', v); await waitFor(`document.getElementById('list').innerHTML !== ${JSON.stringify(before)}`, 4000); await sleep(100); };
  const titles = () => ev(`[...document.querySelectorAll('#list .item .tt')].map(e => e.textContent)`);
  await typeSearch('plumbing');
  check('a search finds a related word ("plumbing" finds the plumber)', (await titles()).some(t => /Plumber/.test(t)), JSON.stringify(await titles()));
  await typeSearch('cakes');
  check('plurals work ("cakes" finds the cakes)', (await titles()).some(t => /cakes/.test(t)));
  await typeSearch('gardner');
  check('a small typo still finds it ("gardner")', (await titles()).some(t => /Gardening/.test(t)), JSON.stringify(await titles()));
  await typeSearch('zzzqqq');
  check('no match says so and suggests what to do', /Nothing matches/.test(await ev(`document.getElementById('list').textContent`)));
  await click('[data-clear]'); await waitFor(`document.querySelectorAll('#list .shelfh').length >= 1`, 4000);
  await click('.chip', 'Free'); await sleep(250);
  const freeOnly = await titles();
  check('the "Free" group shows only free things', freeOnly.length === 1 && /coats/.test(freeOnly[0]), JSON.stringify(freeOnly));
  await click('.chip', 'All'); await sleep(200);

  // ---- one listing, opened: the email address is not on the page; a button hands it over
  await ev(CLIP);
  await click('.item', 'Plumber available for small jobs').catch(() => {});
  await ev(`document.querySelector('[data-open="${chairs}"]').click(); 'ok'`);
  check('a listing opens, with its description and pictures', await waitFor(`document.getElementById('sheetCard')`) && await ev(`document.querySelectorAll('#sheetCard .gallery img').length === 2 && /Collect from Osterley/.test(document.querySelector('.desc').textContent)`));
  const sh = await ev(`({ html: document.getElementById('sheetCard').innerHTML, text: document.getElementById('sheetCard').textContent })`);
  check('the sheet shows no email address and says plainly that it is not shown and that the church takes no part', !/secret-example|@/.test(sh.html) && /not shown on this page/.test(sh.text) && /takes no part in any deal/.test(sh.text));
  const viewsBefore = T('listings').find(l => l.id === chairs).views;
  check('opening it counted as a view', viewsBefore >= 13, String(viewsBefore));
  await shot('listings-390-light-detail');
  const emailOf = T('listings').find(l => l.id === chairs).email;
  await click('[data-copyemail]'); await waitFor(`window.__copied.length > 0`, 4000);
  const copied = await ev(`window.__copied`);
  check('"Copy email address" puts the address on the clipboard', copied[0] === emailOf, JSON.stringify(copied));
  const tt2 = await toastText();
  check('…and says so without showing the address', /Email address copied/.test(tt2) && !/@/.test(tt2) && !/secret-example/.test(await ev(`document.getElementById('app').innerHTML + document.getElementById('sheetHost').innerHTML`)), tt2);
  check('the press was counted', T('listings').find(l => l.id === chairs).contacts === 4);
  await click('[data-report]'); await waitFor(`document.getElementById('rpWhy')`);
  await click('[data-sendreport]'); await sleep(250);
  check('reporting needs a reason', /say what is wrong/.test(await toastText()));
  await typeIn('#rpWhy', 'This looks like a scam to me'); await click('[data-sendreport]'); await waitFor(`document.getElementById('toast').textContent.includes('Thank you')`);
  check('a report says thank you, and is kept for the office', /office will look/.test(await toastText()) && T('listing_reports').length === 1);
  await click('[data-close]'); await sleep(200);
  check('closing the sheet returns to the list', await ev(`!document.getElementById('sheetCard')`));

  // ---- making a listing
  await open(base + '/listings/svp-osterley#new', "document.getElementById('fTitle')"); await sleep(300);
  const n1 = await ev(MEASURE_PAGE);
  check('the form at 390px: no sideways scroll, readable, tappable', !n1.hscroll && !n1.smallText.length && !n1.smallTargets.length, JSON.stringify([n1.scrollWidth, n1.smallText.slice(0, 3), n1.smallTargets.slice(0, 4)]));
  const fm = await ev(`({ notice: !!document.querySelector('.notice'), panels: [...document.querySelectorAll('.panel h2')].map(e => e.textContent), pay: [...document.querySelectorAll('[data-pay]')].map(e => e.textContent.replace(/\\s+/g, ' ')), bar: document.getElementById('sendBtn').textContent })`);
  check('the form has the notice, six steps, and two suggested amounts plus "Other"', fm.notice && fm.panels.length === 6 && fm.pay.length === 3 && /Other amount/.test(fm.pay[2]), JSON.stringify(fm.pay));
  const expected = (await call('public_listings', { slug: 'svp-osterley' })).body.new_listing.quotes.find(q => q.days === 14 && q.images === 0);
  check('the suggested amounts are the server\'s (2 weeks, no pictures)', fm.pay[0].includes('£' + String(expected.suggested)) && fm.pay[1].includes('£' + String(expected.supporter)), JSON.stringify([expected, fm.pay.slice(0, 2)]));
  await shot('listings-390-light-form');
  await click('#sendBtn'); await sleep(300);
  check('pressing send with nothing filled in says what to do first', /whether it is for sale, free, or a service/.test(await ev(`document.querySelector('.err').textContent`)));
  await click('[data-fkind]', 'For sale'); await click('[data-fcat]', 'Furniture & home');
  await typeIn('#fTitle', 'Oak bookcase, good condition'); await typeIn('#fDesc', 'A solid oak bookcase with four shelves. Call me on 07700 900123 to arrange a visit please.');
  check('a phone number typed in the description is flagged straight away', await ev(`!!document.querySelector('#fDesc').closest('.f').querySelector('.warnline')`));
  await typeIn('#fDesc', 'A solid oak bookcase with four shelves. Buyer collects from Osterley, any evening this week.');
  check('…and the flag goes when it is taken out', await ev(`!document.querySelector('#fDesc').closest('.f').querySelector('.warnline')`));
  await typeIn('#fPrice', '£60'); await typeIn('#fEmail', 'newlister@example.org'); await typeIn('#fName', 'Sam');
  await typeIn('#fEmail2', 'newlister@exmaple.org');
  check('typing the email a second time shows at once if the two do not match', /do not match yet/.test(await ev(`document.getElementById('emailMatch').textContent`)));
  await typeIn('#fEmail2', 'newlister@example.org');
  check('…and says so when they do', /They match/.test(await ev(`document.getElementById('emailMatch').textContent`)));
  // pictures: a big photo is made small in the browser before it is sent
  await ev(`(() => { const c = document.createElement('canvas'); c.width = 3000; c.height = 2000; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 3000, 2000); gr.addColorStop(0, '#c33'); gr.addColorStop(1, '#36c'); g.fillStyle = gr; g.fillRect(0, 0, 3000, 2000);
    for (let i = 0; i < 3000; i++) { g.fillStyle = 'rgba(' + (i * 7 % 255) + ',' + (i * 13 % 255) + ',' + (i * 29 % 255) + ',.6)'; g.fillRect((i * 37) % 3000, (i * 53) % 2000, 60, 60); }
    c.toBlob(b => { window.__photoBytes = b.size; const dt = new DataTransfer(); dt.items.add(new File([b], 'photo1.png', { type: 'image/png' })); dt.items.add(new File([b], 'photo2.png', { type: 'image/png' })); const inp = document.getElementById('fPhoto'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); }, 'image/png'); return 'ok'; })()`);
  check('two photos are accepted and previewed', await waitFor(`document.querySelectorAll('.ph').length === 2`, 20000));
  const bigBytes = await ev(`window.__photoBytes`);
  const expected2 = (await call('public_listings', { slug: 'svp-osterley' })).body.new_listing.quotes.find(q => q.days === 14 && q.images === 2);
  check('the suggestion went up with the pictures', (await ev(`document.querySelector('[data-pay="suggested"]').textContent`)).includes('£' + String(expected2.suggested)), JSON.stringify(expected2));
  await click('[data-fdays]', '1 month');
  const expected3 = (await call('public_listings', { slug: 'svp-osterley' })).body.new_listing.quotes.find(q => q.days === 30 && q.images === 2);
  check('…and with the length', (await ev(`document.querySelector('[data-pay="suggested"]').textContent`)).includes('£' + String(expected3.suggested)), JSON.stringify(expected3));
  await click('[data-fdays]', '1 week');
  // Other = 0
  await click('[data-pay="other"]'); await waitFor(`document.getElementById('fOther')`); await typeIn('#fOther', '0');
  check('choosing "Other" and typing 0 turns the button into a plain "Send for approval"', (await ev(`document.getElementById('sendBtn').textContent`)) === 'Send for approval', await ev(`document.getElementById('sendBtn').textContent`));
  await typeIn('#fEmail2', 'wrong@example.org'); await click('#sendBtn'); await sleep(300);
  check('sending with two different email addresses is stopped, in words, and the second box is marked', /two email addresses do not match/.test(await ev(`document.querySelector('.err').textContent`)) && await ev(`!!document.getElementById('fEmail2').closest('.f.bad')`));
  await typeIn('#fEmail2', 'newlister@example.org');
  await click('#sendBtn'); await sleep(300);
  check('not ticking the box stops it, in words', /tick the box/.test(await ev(`document.querySelector('.err').textContent`)));
  await ev(`document.getElementById('fAgree').click(); 'ok'`);
  await ev(`(() => { window.__sent = null; const of = window.fetch; window.fetch = (u, o) => { if (/public_listing_create/.test(String(u))) window.__sent = JSON.parse(o.body); return of(u, o); }; return 'ok'; })()`);
  await click('#sendBtn');
  check('a £0 listing is sent without any payment, and lands on the lister\'s own page', await waitFor(`/manage=/.test(location.search) && document.querySelector('.status h1')`, 15000));
  const sent = await ev(`window.__sent`).catch(() => null);
  const mp = await ev(`({ h: document.querySelector('.status h1').textContent, text: document.querySelector('.status').textContent })`);
  check('it says thank you and that nothing is shown until the office approves', /office will look at it/.test(mp.h) && /Nothing is shown to anyone until it is approved/.test(mp.text), JSON.stringify(mp).slice(0, 200));
  const made = T('listings').find(l => l.email === 'newlister@example.org');
  check('the listing is with the office (no payment), with its two pictures made small and stored', made && made.status === 'pending_review' && made.fee === 0 && T('payments').length === 0 && made.images.length === 2 && db.uploads.filter(u => u.bucket === 'listings').length === 4 && db.uploads.filter(u => u.bucket === 'listings').every(u => u.bytes < 150000), JSON.stringify(made && [made.status, made.images.length, db.uploads.map(u => u.bytes)]));
  check('a photo of several megabytes became a few tens of kilobytes', bigBytes > 500000 && db.uploads.filter(u => u.bucket === 'listings').every(u => u.bytes < 150000) && Math.max(...db.uploads.filter(u => /-t\./.test(u.path)).map(u => u.bytes)) < 40000, JSON.stringify([bigBytes, db.uploads.map(u => u.bytes)]));
  await shot('listings-390-light-submitted');
  const mm = await ev(MEASURE_PAGE);
  check('the lister\'s page: no sideways scroll, readable, tappable', !mm.hscroll && !mm.smallText.length && !mm.smallTargets.length, JSON.stringify([mm.smallText.slice(0, 2), mm.smallTargets.slice(0, 3)]));
  const myToken = made.token;

  // a paid listing: card payment on the suggested amount
  await open(base + '/listings/svp-osterley#new', "document.getElementById('fTitle')");
  await click('[data-fkind]', 'Service'); await click('[data-fcat]', 'Services & trades');
  await typeIn('#fTitle', 'Electrician, local and reliable'); await typeIn('#fDesc', 'Qualified electrician offering small domestic jobs: sockets, lights, fault finding. Parishioner rates.');
  await typeIn('#fEmail', 'sparky@example.org'); await typeIn('#fEmail2', 'sparky@example.org'); await ev(`document.getElementById('fAgree').click(); 'ok'`);
  const wantAmt = (await call('public_listings', { slug: 'svp-osterley' })).body.new_listing.quotes.find(q => q.days === 14 && q.images === 0).suggested;
  check('the button says what will be paid', (await ev(`document.getElementById('sendBtn').textContent`)) === 'Pay £' + wantAmt.toFixed(2).replace(/.00$/, '') + ' and send for approval', await ev(`document.getElementById('sendBtn').textContent`));
  await click('#sendBtn'); await sleep(2500);
  const paid = T('listings').find(l => l.email === 'sparky@example.org');
  check('paying makes a card payment of that amount and holds the listing until it is paid', paid && paid.status === 'awaiting_payment' && T('payments').length === 1 && T('payments')[0].amount === wantAmt && T('payments')[0].contact_value === 'sparky@example.org', JSON.stringify(paid && [paid.status, T('payments').map(p => p.amount)]));
  await open(base + '/listings.html?manage=' + paid.token, "document.querySelector('.status h1') && !/^Loading/.test(document.querySelector('.status h1').textContent)");
  check('before payment is confirmed its page says it is waiting, with a way back to the payment page', /Waiting for your payment/.test(await ev(`document.querySelector('.status h1').textContent`)) && await ev(`!!document.querySelector('a.btn[href^="https://pay.example"]')`));
  sumupStatus = 'PAID';
  await open(base + '/listings.html?manage=' + paid.token, "document.querySelector('.status h1') && !/^Loading/.test(document.querySelector('.status h1').textContent)");
  check('once paid it waits for the office', /office will look at it/.test(await ev(`document.querySelector('.status h1').textContent`)) && T('listings').find(l => l.id === paid.id).status === 'pending_review');

  // ---- the office
  const loginAs = async (token, user) => {
    await open(base + '/theme.css', 'document.body');
    await ev(`localStorage.setItem('pc_session', JSON.stringify({ session: ${JSON.stringify(token)}, user: ${JSON.stringify(user)}, campaigns: [], org: null, lastCampaignId: null })); 'ok'`);
    await open(base + '/index.html', "document.querySelector('#headerRight button')");
    for (let k = 0; k < 6; k++) { await ev(`viewMode = 'admin'; render(); 'ok'`); if (await waitFor(`document.querySelector('.tabs button')`, 2500)) break; }   // the app may still be starting: ask again
  };
  await view(390, 844);
  await loginAs(AD, { id: 'uA-ad', name: 'admin', role: 'admin', org_id: 'org-A', mobile: '07000000002' });
  const sawTab = await waitFor(`document.querySelector('[data-tab=listings]')`);
  check('the admin sees a Listings tab', sawTab);
  if (!sawTab) console.log('  (the screen shows: ' + JSON.stringify(await ev(`({ tabs: [...document.querySelectorAll('.tabs button')].map(b => b.textContent.trim()), mode: typeof viewMode !== 'undefined' ? viewMode : '?', role: typeof state !== 'undefined' && state.user ? state.user.role : '?', body: document.getElementById('app').innerText.slice(0, 120) })`)) + ')');
  await click('[data-tab=listings]');
  check('it opens on what is waiting for approval', await waitFor(`document.querySelector('#adminContent .rp-order')`));
  const aw = await ev(`({ titles: [...document.querySelectorAll('#adminContent .rp-name')].map(e => e.textContent), head: document.querySelector('#adminContent .hint').textContent, text: document.getElementById('adminContent').innerText })`);
  check('both new listings are waiting, with their email addresses for the office, and a banner counting them', aw.titles.includes('Oak bookcase, good condition') && aw.titles.includes('Electrician, local and reliable') && /newlister@example.org/.test(aw.text) && /2 listings are waiting/.test(aw.head), JSON.stringify(aw.titles));
  const am = await ev(MEASURE_ADMIN);
  check('the office screen: no sideways scroll, tap targets 44px or larger', !am.hscroll && !am.smallTargets.length, JSON.stringify([am.scrollWidth, am.smallTargets.slice(0, 4)]));
  await shot('admin-390-listings-waiting');
  await ev(CLIP);
  await click('#adminContent button', 'Copy their email'); await waitFor(`window.__copied.length > 0`, 3000);
  check('the office can copy the lister\'s email', (await ev(`window.__copied[0]`)) === 'newlister@example.org' && /Email address copied/.test(await toastText()));
  await click('#adminContent button', '✓ Approve'); await waitFor(`document.getElementById('toast').textContent.includes('Approved')`);
  check('"✓ Approve" says so, and starts the days', /Approved. It is live for \d+ days/.test(await toastText()) && T('listings').filter(l => l.status === 'live').length === 7, await toastText());
  await click('#adminContent button', 'Not suitable…'); await waitFor(`document.getElementById('lstWhy')`);
  await click('#adminContent button', "Yes, don't accept"); await sleep(300);
  check('refusing without a reason is refused in words', /say why/.test(await toastText()));
  await typeIn('#lstWhy', 'We cannot list trades without a reference');
  await ev(`(() => { const b = document.getElementById('lstRefund'); return b ? 'has refund box' : 'none'; })()`);
  await click('#adminContent button', "Yes, don't accept"); await waitFor(`document.getElementById('toast').textContent.includes('Not accepted')`);
  const rejected = T('listings').find(l => l.email === 'sparky@example.org');
  check('refusing with a reason says so, and notes the refund of a paid fee', rejected.status === 'rejected' && rejected.review_note === 'We cannot list trades without a reference' && T('payments')[0].refund_amount === wantAmt && /refund is recorded/.test(await toastText()), await toastText());
  check('the lister sees why on their own page', (await call('public_listing_manage', { token: rejected.token })).body.review_note === 'We cannot list trades without a reference');
  await click('.rp-pills button', 'Live'); await waitFor(`document.querySelector('#adminContent .rp-order')`);
  const lv = await ev(`document.getElementById('adminContent').innerText`);
  check('Live shows the numbers (looked, asked) and the reported listing with its reason', /looked/.test(lv) && /asked for the email/.test(lv) && /This looks like a scam to me/.test(lv) && /1 report/.test(lv));
  await click('#adminContent button', '☆ Pick'); await waitFor(`document.getElementById('toast').textContent.includes('near the top')`);
  check('"☆ Pick" says so', T('listings').filter(l => l.featured).length === 2);
  await click('#adminContent button', 'Dismiss the reports'); await waitFor(`document.getElementById('toast').textContent.includes('dismissed')`);
  check('dismissing reports says so', T('listing_reports').length === 0);
  await click('#adminContent button', 'Take down…'); await waitFor(`document.getElementById('lstTake')`);
  await typeIn('#lstTake', 'Not suitable for the parish noticeboard'); await click('#adminContent button', 'Yes, take it down'); await waitFor(`document.getElementById('toast').textContent.includes('Taken down')`);
  check('taking one down needs a reason, says so, and it is gone from the public page', T('listings').filter(l => l.status === 'removed').length === 1 && (await call('public_listings', { slug: 'svp-osterley' })).body.listings.length === 6);
  await click('.rp-pills button', 'Settings'); await waitFor(`document.getElementById('lstBase')`);
  await typeIn('#lstBase', '4'); await typeIn('#lstWeek', '2'); await click('#adminContent button', 'Save'); await waitFor(`document.getElementById('toast').textContent === '✓ Saved'`);
  check('saving the three numbers says "✓ Saved" and the suggestions follow', T('listings_settings').find(s => s.org_id === 'org-A').price_base === 4 && (await call('public_listings', { slug: 'svp-osterley' })).body.new_listing.quotes.find(q => q.days === 14 && q.images === 0).suggested === 6);
  const sm = await ev(MEASURE_ADMIN);
  check('the settings screen: no sideways scroll, tap targets 44px or larger', !sm.hscroll && !sm.smallTargets.length, JSON.stringify([sm.scrollWidth, sm.smallTargets.slice(0, 4)]));
  await shot('admin-390-listings-settings');

  // ---- the lister takes their own listing down
  await open(base + '/listings.html?manage=' + myToken, "document.querySelector('.status h1') && !/^Loading/.test(document.querySelector('.status h1').textContent)");
  const lp = await ev(`({ h: document.querySelector('.status h1').textContent, stats: document.querySelectorAll('.stat').length })`);
  check('their page shows it is live, with how it has done', /Your listing is live/.test(lp.h) && lp.stats === 2, JSON.stringify([lp, T('listings').find(l => l.token === myToken).status]));
  await shot('listings-390-light-live');
  await click('[data-withdraw]'); await click('[data-withdraw]'); await waitFor(`/You took this listing down/.test(document.querySelector('.status h1').textContent)`, 8000);
  check('"Take it down" asks once more, then takes it down', T('listings').find(l => l.token === myToken).status === 'withdrawn');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await sleep(200);
  await open(base + '/listings/svp-osterley', "document.querySelector('.item')"); await sleep(300); await shot('listings-390-dark-browse');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL LISTINGS BROWSER CHECKS PASSED');
  console.log('screenshots in ' + OUT);
  proc.kill();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { proc && proc.kill(); } catch { /* done */ } process.exit(2); });
