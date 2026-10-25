// Presentation checks for the Parish Gateway, in a real (headless) Edge or Chrome: layout widths, text and tap-target sizes,
// light and dark, "See all", text shown as text, the saved copy with no signal, and the admin tab. Takes screenshots.
// The page and the admin tab run against the real api.js on top of the in-memory stand-in database, so nothing is mocked in the browser.
//   node test/gateway/ui-check.js [output-folder]          (needs Microsoft Edge or Google Chrome installed)
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { db, clock, api, addUser, call } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'ui-shots'));
fs.mkdirSync(OUT, { recursive: true });
const BROWSERS = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
const BROWSER = BROWSERS.find(p => fs.existsSync(p));
if (!BROWSER) { console.log('No Edge or Chrome found: skipping the browser checks.'); process.exit(0); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- demo data around today's real date
clock.live();
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const day = (n) => { const x = new Date(today + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const T = db.T;
T('organizations').push({ id: 'org-A', name: 'St.Vincent De Paul Church, Osterley', slug: 'svp-osterley', gateway_enabled: true, timezone: 'Europe/London', display_name: null, address: '2 Witham Road, Osterley, TW7 4AJ', contact_email: 'osterley@rcdow.org', gateway_phone: '020 8560 0000', gateway_hours: 'Tue to Fri, 10:00 am to 1:00 pm' });
T('organizations').push({ id: 'org-B', name: 'Other Parish', slug: 'other-parish', gateway_enabled: false, timezone: 'Europe/London' });
const sessions = { sa: addUser('uA-sa', 'superadmin', 'org-A', Date.now() + 6 * 36e5), ad: addUser('uA-ad', 'admin', 'org-A', Date.now() + 6 * 36e5), pr: addUser('uA-pr', 'priest', 'org-A', Date.now() + 6 * 36e5) };
for (const [id, role, mobile] of [['uA-sa', 'superadmin', '07000000001'], ['uA-ad', 'admin', '07000000002'], ['uA-pr', 'priest', '07000000003']]) Object.assign(T('users').find(u => u.id === id), { mobile, name: role });
const slugOf = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const camp = (name, kind, extra) => T('campaigns').push({ id: slugOf(name), org_id: 'org-A', name, kind, active: true, binned: false, is_draft: false, public_page_enabled: true, opens_on: day(-5), closes_on: day(20), places: null, waiting_list: false, listed_on_gateway: true, gateway_cta: null, ...extra });
const online = (name, unsold, paid) => { const cid = slugOf(name); T('ticket_blocks').push({ id: 'b-' + cid, campaign_id: cid, type: 'digital' }); for (let i = 0; i < unsold + paid; i++) T('tickets').push({ id: cid + i, campaign_id: cid, block_id: 'b-' + cid, status: i < unsold ? 'unsold' : 'paid' }); };
camp('Autumn Raffle', 'raffle', { closes_on: day(9) }); online('Autumn Raffle', 10, 40);
camp('Walsingham Pilgrimage', 'event', { closes_on: day(21) }); online('Walsingham Pilgrimage', 12, 38);
camp('First Holy Communion', 'registration', { places: 40, closes_on: day(28) }); for (let i = 0; i < 32; i++) T('registrations').push({ id: 'f' + i, campaign_id: 'first-holy-communion', status: 'submitted' });
camp('Youth Group', 'registration', { places: 30, waiting_list: true, closes_on: day(40) }); for (let i = 0; i < 30; i++) T('registrations').push({ id: 'y' + i, campaign_id: 'youth-group', status: 'accepted' });
camp('Confirmation', 'registration', { opens_on: day(14), closes_on: day(60) });
camp('Christmas Fete', 'event', { listed_on_gateway: false, opens_on: day(20), closes_on: day(52) }); online('Christmas Fete', 100, 0);
camp('Quiz Night (tickets only in person)', 'event', { listed_on_gateway: false });
T('ticket_blocks').push({ id: 'b-phys', campaign_id: slugOf('Quiz Night (tickets only in person)'), type: 'physical' });
const item = (id, section, label, extra) => T('gateway_items').push({ id, org_id: 'org-A', section, label, url: 'https://stmarys.example.org/' + id, cta: 'Find out more', starts_on: day(-3), ends_on: day(35), listed: true, ...extra });
item('hampers', 'involved', 'Christmas Hamper Collection'); item('coffee', 'involved', 'Friday Coffee Morning', { ends_on: day(60) });
[['hall', 'Book the Parish Hall', 'Check dates and send a request', 'https://osterley-hall-booking.netlify.app/'], ['mass', 'Request a Mass Intention', 'For the living or the departed', 'https://osterley-hall-booking.netlify.app/mass'], ['news', 'Parish Newsletter', 'This week’s notices and news', 'https://stmarys.example.org/newsletter']]
  .forEach(([id, label, sub, url], i) => T('gateway_links').push({ id, org_id: 'org-A', position: i + 1, label, sub, url }));
const setNotice = (n) => { T('gateway_announcements').length = 0; if (n) T('gateway_announcements').push({ id: 'n1', org_id: 'org-A', message: n.message, link_url: n.link || null, urgent: !!n.urgent, starts_at: new Date(Date.now() - 36e5).toISOString(), ends_at: new Date(Date.now() + 6 * 864e5).toISOString(), created_at: new Date().toISOString() }); };
setNotice({ message: 'The parish office is closed this Friday. Mass times are unchanged.', link: 'https://stmarys.example.org/notices' });

// ---------- a tiny web server: the app's public folder, the /go/* rewrite, and /api/* handled by the real api.js
const PUB = path.join(__dirname, '..', '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
    if (process.env.UI_DEBUG) console.log('  api ' + u.pathname);
    // The Sell screen (not part of this feature) needs far more of the database than the stand-in provides, so it is answered with an empty list.
    if (u.pathname === '/api/sell_screen') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ campaigns: [], organization: {}, campaign_id: null, stats: null })); req.resume(); return; }
    let body = ''; req.on('data', c => { body += c; }); if (process.env.UI_DEBUG) console.log('  api ' + u.pathname);
    req.on('end', async () => {
      const r = await api.handler({ httpMethod: 'POST', path: u.pathname, headers: { host: req.headers.host, 'x-nf-client-connection-ip': '10.1.1.1' }, body });
      res.writeHead(r.statusCode, r.headers); res.end(r.body);
    });
    return;
  }
  let p = u.pathname; if (p === '/') p = '/index.html'; else if (p.startsWith('/go/') && p !== '/go/sw.js') p = '/go.html';
  const file = path.join(PUB, p);
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});

// ---------- the browser, driven over the DevTools protocol
let proc, ws, nid = 0; const pending = new Map();
const send = (method, params) => new Promise((res, rej) => { const i = ++nid; const t = setTimeout(() => { pending.delete(i); rej(new Error('browser did not answer ' + method)); }, 20000); pending.set(i, (d) => { clearTimeout(t); res(d); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (x.result.exceptionDetails) throw new Error(JSON.stringify(x.result.exceptionDetails).slice(0, 300)); return x.result.result.value; };
async function launch(port) {
  spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue'], { stdio: 'ignore' });
  const dbg = 9500 + Math.floor(Math.random() * 400);
  proc = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + dbg, '--user-data-dir=' + path.join(OUT, 'profile' + Date.now()), '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
  let target; for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find(t => t.type === 'page'); } catch { /* starting */ } }
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => { ws.onopen = r; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    // a page that opens an alert or confirm box would freeze every later step: say so, and press OK
    if (d.method === 'Page.javascriptDialogOpening') { console.log('  (the page opened a dialog: ' + JSON.stringify(d.params.message).slice(0, 160) + ')'); send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }
  };
  await send('Page.enable'); await send('Runtime.enable');
}
async function view(w, h, dark) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
}
async function open(url, waitFor) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) { await sleep(250); try { if (await ev(`!!(${waitFor})`)) return true; } catch { /* page loading */ } }
  return false;
}
async function shot(name, full) {
  const m = await send('Page.getLayoutMetrics');
  const h = Math.ceil(m.result.cssContentSize.height), w = Math.ceil(m.result.cssContentSize.width);
  const r = await send('Page.captureScreenshot', full ? { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } } : { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
}
const MEASURE = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const smallText = [], smallTargets = [];
  for (const e of document.querySelectorAll('body *')) {
    if (!vis(e) || e.closest('script,style,svg')) continue;
    const own = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (own) { const px = parseFloat(getComputedStyle(e).fontSize); if (px < 14.99) smallText.push(e.tagName + ':' + e.textContent.trim().slice(0, 30) + ' ' + px + 'px'); }
    if (e.matches('a[href], button, input, select, textarea') && !e.closest('.gw-switch')) { const r = e.getBoundingClientRect(); if (r.height < 43.9 || r.width < 43.9) smallTargets.push(e.tagName + ':' + (e.textContent || e.id || '').trim().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  }
  return { hscroll: document.documentElement.scrollWidth > innerWidth + 1, scrollWidth: document.documentElement.scrollWidth, innerWidth, smallText, smallTargets, baseFont: parseFloat(getComputedStyle(document.body).fontSize) };
})()`;

let failures = 0;
const check = (name, ok, extra) => { if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://localhost:' + server.address().port, page = base + '/go/svp-osterley';
  await launch();

  // ---- the public page: widths, themes, sizes
  for (const [w, h] of [[390, 844], [360, 740]]) for (const dark of [false, true]) {
    await view(w, h, dark);
    const ok = await open(page, "document.querySelector('.door')");
    check(`page opens at ${w}px ${dark ? 'dark' : 'light'}`, ok);
    const m = await ev(MEASURE);
    check(`  no sideways scroll at ${w}px ${dark ? 'dark' : 'light'}`, !m.hscroll, `scrollWidth ${m.scrollWidth} / ${m.innerWidth}`);
    check(`  text 15px or larger, base 17px`, m.smallText.length === 0 && m.baseFont >= 17, m.smallText.slice(0, 3).join(' | ') + ' base ' + m.baseFont);
    check(`  tap targets 44px or larger`, m.smallTargets.length === 0, m.smallTargets.slice(0, 4).join(' | '));
    await shot(`public-${w}-${dark ? 'dark' : 'light'}`, true);
  }
  await view(390, 844, false);
  await open(page, "document.querySelector('.door')");
  const counts = await ev(`({ involved: document.querySelectorAll('#t-involved ~ .list > .card').length, involvedBtn: (document.querySelector('[data-more=involved]')||{}).textContent, reg: document.querySelectorAll('#t-registration ~ .list > .card').length, regBtn: (document.querySelector('[data-more=registration]')||{}).textContent, titles: [...document.querySelectorAll('h2.title')].map(e=>e.textContent), names: [...document.querySelectorAll('.card h3')].map(e=>e.textContent), cta: [...document.querySelectorAll('.card .cta')].map(e=>e.textContent), status: [...document.querySelectorAll('.card .sl')].map(e=>e.textContent) })`);
  check('Get Involved shows three cards and "See all (4)"', counts.involved === 3 && counts.involvedBtn === 'See all (4)', JSON.stringify([counts.involved, counts.involvedBtn]));
  check('Registrations: both open ones show, no button', counts.reg === 2 && !counts.regBtn, JSON.stringify(counts.names));
  check('a full registration with a waiting list says "Join waiting list"; the other says Register', counts.cta.includes('Join waiting list') && counts.cta.includes('Register'), counts.cta.join(' / '));
  check('raffle shows closing date only: no sales, no places', counts.status.some(s => /^(New · )?Closes in 9 days$/.test(s)) && !counts.status.some(s => /sold/i.test(s)), counts.status.join(' | '));
  check('places left show on an event and a registration', counts.status.some(s => /Closes \d+ \w+ · 12 left/.test(s)) && counts.status.some(s => /8 left/.test(s)), counts.status.join(' | '));
  await ev(`document.querySelector('[data-more=involved]').click()`);
  const after = await ev(`({ n: document.querySelectorAll('#t-involved ~ .list > .card').length, btn: document.querySelector('[data-more=involved]').textContent })`);
  check('"See all" reveals the rest in place, and the button then says "Show fewer"', after.n === 4 && after.btn === 'Show fewer', JSON.stringify(after));
  await shot('public-390-light-seeall', true);

  // ---- notices: a normal one opens a panel; an urgent one puts its message in the bar
  await ev(`document.getElementById('notices').click()`);
  check('the notices bar opens a panel with the full message and link', await ev(`!document.getElementById('sheet').hidden && document.querySelector('#sheetBody .note p').textContent.includes('office is closed') && !!document.querySelector('#sheetBody a.more')`));
  await shot('public-390-light-notice-open', false);
  setNotice({ message: 'Mass is cancelled this evening. We are sorry for the short notice.', urgent: true });
  await open(page, "document.querySelector('.notices.urgent')");
  check('an urgent notice shows its message in the bar itself', await ev(`document.querySelector('.notices.urgent .sub').textContent.includes('Mass is cancelled')`));
  await shot('public-390-light-urgent', false);
  await view(390, 844, true); await open(page, "document.querySelector('.notices.urgent')"); await shot('public-390-dark-urgent', false);
  await view(390, 844, false);

  // ---- text is shown as text
  T('gateway_items').push({ id: 'evil', org_id: 'org-A', section: 'involved', label: '<img src=x onerror="window.__x=1"><script>window.__x=2</script>Evil', url: 'https://stmarys.example.org/e', cta: '<b>Go</b>', starts_on: day(-1), ends_on: day(1), listed: true });
  setNotice({ message: '<script>window.__x=3</script> notice' });
  await open(page, "document.querySelector('.door')");
  const evil = await ev(`({ ran: window.__x === undefined ? 'no' : 'YES', imgs: document.querySelectorAll('.card img').length, shown: [...document.querySelectorAll('.card h3')].some(e => e.textContent.includes('<script>window.__x=2</script>Evil')), cta: [...document.querySelectorAll('.cta')].some(e => e.textContent === '<b>Go</b>') })`);
  check('text with <script> or HTML is displayed as text and never runs', evil.ran === 'no' && evil.imgs === 0 && evil.shown && evil.cta, JSON.stringify(evil));
  T('gateway_items').splice(T('gateway_items').findIndex(i => i.id === 'evil'), 1);
  setNotice(null);

  // ---- a page switched off, and an unknown address
  await open(base + '/go/other-parish', "document.querySelector('.status h1')");
  check('a switched-off page says it is not available', (await ev(`document.querySelector('.status h1').textContent`)) === 'This page is not available.');

  // ---- the admin tab (Admin, then the SuperAdmin) on a phone-width screen
  const waitFor = async (expr, ms = 8000) => { for (let i = 0; i < ms / 200; i++) { await sleep(200); try { if (await ev(`!!(${expr})`)) return true; } catch { /* busy */ } } return false; };
  const toastText = () => ev(`(document.getElementById('toast') || {}).textContent`);
  const click = (sel, text) => ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => !${JSON.stringify(text || '')} || x.textContent.trim().startsWith(${JSON.stringify(text || '')})); if (!e) return 'NOT FOUND ' + ${JSON.stringify(sel + ' ' + (text || ''))}; e.click(); return 'ok'; })()`);
  const typeInto = (id, v, evName = 'input') => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event(${JSON.stringify(evName)}, { bubbles: true })); return 'ok'; })()`);
  const MEASURE_ADMIN = MEASURE.replace("document.querySelectorAll('body *')", "document.querySelectorAll('#adminContent *')");
  const loginAs = async (token, user) => {
    const dbgLog = (m) => { if (process.env.UI_DEBUG) console.log('  step ' + m); };
    dbgLog('login: open index');
    await open(base + '/index.html', "document.getElementById('app')");
    dbgLog('login: set session');
    await ev(`localStorage.setItem('pc_session', JSON.stringify({ session: ${JSON.stringify(token)}, user: ${JSON.stringify(user)}, campaigns: [], org: null, lastCampaignId: null })); 'ok'`);
    dbgLog('login: reopen');
    await open(base + '/index.html', "document.querySelector('#headerRight button')");
    dbgLog('login: switch to admin');
    await ev(`viewMode = 'admin'; render(); 'ok'`);
    dbgLog('login: done');
  };

  await view(390, 844, false);
  await loginAs(sessions.ad, { id: 'uA-ad', name: 'admin', role: 'admin', org_id: 'org-A', mobile: '07000000002' });
  check('Admin sees a "Parish page" tab', await waitFor(`document.querySelector('[data-tab=parishpage]')`));
  await click('[data-tab=parishpage]');
  check('the tab opens (links, notice, what is on the page)', await waitFor(`document.querySelector('.gw-linkrow') && document.querySelector('#gwAnnMsg') && document.querySelector('.gw-arow')`));
  check('Admin cannot change the address or switch the page on or off (no such controls, and it says so)', await ev(`!document.getElementById('gwSlug') && !document.querySelector('.gw-switchrow input[aria-label="Page is on"]') && document.getElementById('adminContent').textContent.includes('Only the SuperAdmin can change the address')`));
  const am = await ev(MEASURE_ADMIN);
  check('admin tab: no sideways scroll at 390px, tap targets 44px or larger', !am.hscroll && am.smallTargets.length === 0, am.smallTargets.slice(0, 5).join(' | ') + ' scrollWidth ' + am.scrollWidth);
  await shot('admin-390-light-admin', true);
  // links
  await typeInto('gwU0', 'javascript:alert(1)');
  check('a bad link address is flagged as you type', await ev(`document.getElementById('gwLm0').classList.contains('err') && document.getElementById('gwU0').classList.contains('gw-bad')`));
  await click('.gw-linkrow button', 'Save link 1'); await sleep(500);
  check('…and refused: the page keeps the last good link', (await toastText()).includes('not valid') && T('gateway_links').find(l => l.position === 1).url === 'https://osterley-hall-booking.netlify.app/');
  await typeInto('gwU0', 'https://osterley-hall-booking.netlify.app/book'); await typeInto('gwL0', 'Book the Hall');
  await click('.gw-linkrow button', 'Save link 1'); await waitFor(`document.getElementById('toast').textContent.includes('saved')`);
  check('a good link saves, with a visible "✓ Link 1 saved"', (await toastText()) === '✓ Link 1 saved' && T('gateway_links').find(l => l.position === 1).label === 'Book the Hall');
  // notice
  await click('.gw-pill', 'Mass cancelled');
  check('a quick wording button fills the message', (await ev(`document.getElementById('gwAnnMsg').value`)).startsWith('Mass is cancelled today'));
  check('no end time gives a warning with an "End in 7 days" button', await ev(`!!document.querySelector('#gwAnnWarn button')`));
  await click('#gwAnnWarn button', 'End in 7 days');
  check('"End in 7 days" fills the end time', (await ev(`document.getElementById('gwAnnEnd').value`)).length === 16);
  await typeInto('gwAnnStart', '2030-01-02T10:00', 'change'); await typeInto('gwAnnEnd', '2030-01-01T10:00', 'change');
  check('an end before the start is flagged and cannot be published', await ev(`!!document.querySelector('#gwAnnWarn li.err') && document.getElementById('gwAnnPublish').disabled`));
  await typeInto('gwAnnStart', '', 'change'); await typeInto('gwAnnEnd', '', 'change'); await click('#gwAnnWarn button', 'End in 7 days');
  await click('#gwAnnPublish'); await waitFor(`document.getElementById('toast').textContent.includes('Notice')`);
  check('publishing says "✓ Notice is on the page", and the public page shows it', (await toastText()) === '✓ Notice is on the page' && (await call('public_gateway', { slug: 'svp-osterley' })).body.announcement.message.startsWith('Mass is cancelled'));
  check('the status pill now says "Live now"', await waitFor(`document.getElementById('gwAnnStatus').textContent === 'Live now'`));
  await click('button', 'Take it down'); await waitFor(`document.getElementById('toast').textContent.includes('taken down')`);
  check('"Take it down" removes it, with a visible message', (await toastText()) === '✓ Notice taken down' && (await call('public_gateway', { slug: 'svp-osterley' })).body.announcement === null);
  // order, with Up / Down
  const regNames = () => ev(`[...document.querySelectorAll('.gw-arows[data-sec=registration] .gw-arow b.nm')].map(e => e.textContent)`);
  const before = await regNames();
  await ev(`[...document.querySelectorAll('.gw-arows[data-sec=registration] .gw-arow')][0].querySelectorAll('button')[1].click()`); await waitFor(`document.getElementById('toast').textContent.includes('Order')`);
  const afterMove = await regNames();
  check('Down moves a row and says "✓ Order saved"; the group becomes "Custom order"', afterMove[0] === before[1] && afterMove[1] === before[0] && (await waitFor(`document.querySelector('.gw-mode.custom')`)));
  await click('.gw-mini', 'Back to automatic'); await waitFor(`!document.querySelector('.gw-mode.custom')`);
  check('"Back to automatic" restores closing-date order', JSON.stringify(await regNames()) === JSON.stringify(before));
  // the "On the page" switch
  check('a campaign with no working public page cannot be switched on (explained)', await ev(`(() => { const r = [...document.querySelectorAll('.gw-arow')].find(x => x.textContent.includes('Quiz Night')); return !!r && r.querySelector('input[type=checkbox]').disabled && r.textContent.includes('no online tickets'); })()`));
  await ev(`[...document.querySelectorAll('.gw-arow')].find(x => x.textContent.includes('Christmas Fete')).querySelector('input[type=checkbox]').click()`);
  await waitFor(`document.getElementById('toast').textContent.includes('Christmas Fete')`);
  check('switching a campaign on says so, with a visible message', (await toastText()) === '✓ Christmas Fete is on the page' && T('campaigns').find(c => c.id === 'christmas-fete').listed_on_gateway === true);
  // add by hand
  await click('button', 'Add something');
  check('Add something opens a form; with no end date it cannot be saved', await ev(`!!document.getElementById('gwF_label') && document.getElementById('gwF_save').disabled`));
  await typeInto('gwF_label', 'Parish Quiz Night'); await typeInto('gwF_url', 'http://insecure.example.org'); await typeInto('gwF_end', day(30), 'change');
  check('an http:// address is flagged and cannot be saved', await ev(`!!document.querySelector('#gwF_issues li.err') && document.getElementById('gwF_save').disabled`));
  await typeInto('gwF_url', 'https://stmarys.example.org/quiz');
  check('a valid form can be saved', await ev(`!document.getElementById('gwF_save').disabled`));
  await click('#gwF_save'); await waitFor(`document.getElementById('toast').textContent.includes('Added')`);
  check('adding says "✓ Added. It shows from …" and it is on the list', (await toastText()).startsWith('✓ Added. It shows from') && (await ev(`!!([...document.querySelectorAll('.gw-arow b.nm')].find(e => e.textContent === 'Parish Quiz Night'))`)));
  const quizBtn = `[...document.querySelectorAll('.gw-arow')].find(x => x.textContent.includes('Parish Quiz Night')).querySelector('.danger')`;
  await ev(`${quizBtn}.click()`);
  check('Remove asks you to tap again', (await ev(`${quizBtn}.textContent`)) === 'Tap again to remove');
  await ev(`${quizBtn}.click()`); await waitFor(`document.getElementById('toast').textContent === '✓ Removed'`);
  check('the second tap removes it, with a visible message', (await toastText()) === '✓ Removed' && !T('gateway_items').some(i => i.label === 'Parish Quiz Night'));

  // Needs Attention: a payment that is paid but whose tickets were given away
  T('payments').push({ id: 'flag1', campaign_id: 'walsingham-pilgrimage', method: 'link', status: 'paid', amount: 44, created_at: new Date().toISOString(), sold_at: new Date().toISOString(), payer_name: 'J Example', contact_value: 'j@example.org', sumup_transaction_code: 'TAAA6RM3KPB',
    ticket_snapshot: [{ tier_id: 'x', block_id: 'b-walsingham-pilgrimage', ticket_number: 10 }, { tier_id: 'x', block_id: 'b-walsingham-pilgrimage', ticket_number: 11 }], attention_note: 'Paid at SumUp (TAAA6RM3KPB), but W10, W11 had already been given to someone else. Refund this payment, or give the buyer new ticket numbers.' });
  await ev(`setAdminTab('attention'); 'ok'`);
  check('Needs Attention shows a red "Paid, but the tickets are gone" card with the payer, amount, SumUp code and what to do', await waitFor(`document.getElementById('adminContent').textContent.includes('Paid, but the tickets are gone') && document.getElementById('adminContent').textContent.includes('TAAA6RM3KPB') && document.getElementById('adminContent').textContent.includes('Refund this payment')`));
  await shot('attention-390-light-admin', true);
  await click('#adminContent button', 'Sorted'); await waitFor(`document.getElementById('toast').textContent.includes('sorted')`);
  check('"Sorted" says "✓ Marked as sorted" and the card goes', (await toastText()) === '✓ Marked as sorted' && (await waitFor(`!document.getElementById('adminContent').textContent.includes('Paid, but the tickets are gone')`)) && !!T('payments').find(p => p.id === 'flag1').attention_done_at);

  // Overview: the books check and the check against SumUp
  T('tickets').length = 0; T('payments').length = 0;
  const camp1 = 'walsingham-pilgrimage', blk1 = 'b-walsingham-pilgrimage';
  const sale = (id, nums, extra) => { T('payments').push({ id, campaign_id: camp1, method: 'link', status: 'paid', amount: 22 * nums.length, created_at: new Date().toISOString(), sumup_transaction_code: 'TAAA' + id.toUpperCase().padEnd(7, '0').slice(0, 7), sumup_checkout_id: 'co-' + id, ticket_snapshot: nums.map(n => ({ tier_id: 'x', block_id: blk1, ticket_number: n })), ...extra }); };
  const hold = (id, nums) => nums.forEach(n => T('tickets').push({ id: 'tk' + n, campaign_id: camp1, block_id: blk1, ticket_number: n, status: 'paid', payment_id: id }));
  sale('ok1', [1, 2]); hold('ok1', [1, 2]);
  await ev(`setAdminTab('overview'); 'ok'`);
  check('Overview: a clean set of books says so in green', await waitFor(`document.getElementById('adminContent').textContent.includes('The books add up') && document.getElementById('adminContent').textContent.includes('Checked 1 payments and 2 sold tickets')`));
  await shot('overview-390-light-clean', true);
  sale('wa', [10, 11]); sale('wb', [10, 11]); hold('wb', [10, 11]);
  await ev(`renderOverviewTab(); 'ok'`);
  check('Overview: W10/W11 shows up in red, in plain words', await waitFor(`document.getElementById('adminContent').textContent.includes('The books need a look') && document.getElementById('adminContent').textContent.includes('holds only 0 of its 2 tickets') && document.getElementById('adminContent').textContent.includes('recorded as paid for by 2 different payments')`));
  await shot('overview-390-light-problem', true);
  await click('#adminContent button', "I've dealt with this"); await waitFor(`document.getElementById('toast').textContent.includes('dealt with')`);
  check('one press of "I\'ve dealt with this" clears both messages and says so', (await toastText()) === '✓ Marked as dealt with' && (await waitFor(`document.getElementById('adminContent').textContent.includes('The books add up')`)) && !!T('payments').find(p => p.id === 'wa').attention_done_at);
  // the SumUp file
  const csvPath = require('path').join(OUT, 'sumup-test.csv');
  fs.writeFileSync(csvPath, ['Date,Transaction ID,Description,Amount,Status', '5 Oct 2026,TAAAOK10000,Walsingham2026 — tickets W1 W2,44.00,Successful', '6 Oct 2026,TAAANEW0001,Walsingham2026 — tickets W20 · Test,22.00,Successful'].join('\n'));
  const doc = await send('DOM.getDocument', {}); const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#suFile' });
  await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [csvPath] });
  await click('#adminContent button', 'Check it');
  check('Check against SumUp: it lists a SumUp payment we have no record of, and says "✓ Checked"', await waitFor(`document.getElementById('suResult').textContent.includes('SumUp took these, but they are not recorded here') && document.getElementById('suResult').textContent.includes('TAAANEW0001') && document.getElementById('suResult').textContent.includes('2 SumUp transactions read')`));
  await shot('overview-390-light-sumup', true);

  // the SuperAdmin
  await loginAs(sessions.sa, { id: 'uA-sa', name: 'superadmin', role: 'superadmin', org_id: 'org-A', mobile: '07000000001' });
  await ev(`setAdminTab('parishpage'); 'ok'`);
  check('SuperAdmin sees the address, the name and the on/off switch', await waitFor(`document.getElementById('gwSlug') && document.querySelector('.gw-switchrow input[aria-label="Page is on"]:checked')`));
  const sm = await ev(MEASURE_ADMIN);
  check('SuperAdmin view: no sideways scroll, tap targets 44px or larger', !sm.hscroll && sm.smallTargets.length === 0, sm.smallTargets.slice(0, 5).join(' | '));
  await shot('admin-390-light-superadmin', true);
  await typeInto('gwSlug', 'svp-new-address'); await click('button', 'Save address and name'); await waitFor(`document.querySelector('#gwSlugWarn .hint')`);
  check('changing an address in use asks for confirmation first, and nothing has changed yet', (await ev(`document.getElementById('gwSlugWarn').textContent`)).includes('stops "/go/svp-osterley" working') && T('organizations').find(o => o.id === 'org-A').slug === 'svp-osterley');
  await click('#gwSlugWarn button', 'Yes, change the address'); await waitFor(`document.getElementById('toast').textContent === '✓ Saved'`);
  check('after confirming, the address changes with a visible message', T('organizations').find(o => o.id === 'org-A').slug === 'svp-new-address');
  await typeInto('gwSlug', 'svp-osterley'); await click('button', 'Save address and name'); await waitFor(`document.querySelector('#gwSlugWarn .hint')`);
  await click('#gwSlugWarn button', 'Yes, change the address'); await waitFor(`document.getElementById('toast').textContent === '✓ Saved'`);
  await ev(`document.querySelector('.gw-switchrow input[aria-label="Page is on"]').click()`); await waitFor(`document.getElementById('toast').textContent.includes('now off')`);
  check('the on/off switch takes the page down at once, with a visible message', (await toastText()) === '✓ The page is now off' && (await call('public_gateway', { slug: 'svp-osterley' })).status === 404);
  await ev(`document.querySelector('.gw-switchrow input[aria-label="Page is on"]').click()`); await waitFor(`document.getElementById('toast').textContent.includes('now on')`);
  check('and switches it back on', (await call('public_gateway', { slug: 'svp-osterley' })).status === 200);
  await view(390, 844, true); await ev(`gwPaint()`); await shot('admin-390-dark-superadmin', true); await view(390, 844, false);

  // ---- no signal: the page opens from the saved copy
  await open(page, "document.querySelector('.door')");
  await ev(`navigator.serviceWorker.ready.then(() => 'ready')`);
  await sleep(500);
  await open(page, "navigator.serviceWorker.controller && document.querySelector('.door')");   // now the worker is in charge and saves the answer
  await sleep(800);
  await new Promise(r => server.close(r));   // the connection goes away
  await send('Page.navigate', { url: page });
  let off = false; for (let i = 0; i < 60 && !off; i++) { await sleep(300); try { off = await ev(`!!document.querySelector('.offline') && !!document.querySelector('.door')`); } catch { /* loading */ } }
  check('after one earlier visit, the page opens with no signal, from the saved copy, and says so', off, off ? await ev(`document.querySelector('.offline').textContent`) : 'did not open');
  if (off) { check('  the saved page still lists the open items', (await ev(`document.querySelectorAll('.card').length`)) >= 4); await shot('public-390-light-offline', false); }

  proc.kill();
  console.log(failures ? `\n${failures} FAILED` : '\nALL BROWSER CHECKS PASSED');
  console.log('screenshots in ' + OUT);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { proc && proc.kill(); } catch { /* done */ } process.exit(2); });
