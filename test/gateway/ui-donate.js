// Browser checks for Make a Donation, in a real (headless) Edge or Chrome, against the real api.js on the in-memory stand-in database:
// the donate door and the banner envelope on the parish page, the donation page, paying, the donation's own page, and the office screen.
//   node test/gateway/ui-donate.js [output-folder]
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { db, clock, api, addUser, call } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'ui-shots-donate'));
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

// ---------- demo data: a parish with donations open, an email address and a WhatsApp channel
const AD = addUser('uA-ad', 'admin', 'org-A', Date.now() + 6 * 36e5);
Object.assign(T('users').find(u => u.id === 'uA-ad'), { mobile: '07000000002', name: 'admin', confidentiality_version: 1 });
const VO = addUser('uA-vo', 'volunteer', 'org-A', Date.now() + 6 * 36e5);
Object.assign(T('users').find(u => u.id === 'uA-vo'), { mobile: '07000000004', name: 'volunteer', confidentiality_version: 1 });
Object.assign(T('organizations').find(o => o.id === 'org-A'), { contact_email: 'osterley@example.org', gateway_whatsapp: 'https://whatsapp.com/channel/0029VaAbCdEf12345' });
T('donation_settings').push({ org_id: 'org-A', enabled: true, intro_text: 'Thank you for supporting our parish.', next_ref: 1 });
T('gateway_links').push({ id: 'l1', org_id: 'org-A', position: 1, label: 'Book the Parish Hall', sub: '', url: 'https://example.org/hall' });

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


(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://localhost:' + server.address().port;
  await launch();
  const toastText = () => ev(`(document.getElementById('toast') || {}).textContent`);
  const typeIn = async (sel, v) => { await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`); };
  const readyDonate = "document.getElementById('payBtn')";

  // ---- the parish page: banner envelope, donate door first, WhatsApp at the foot
  await view(390, 844);
  await open(base + '/go/svp-osterley', "document.querySelector('.door')");
  const pg = await ev(`(() => { const doors = [...document.querySelectorAll('.door')], m = document.querySelector('.mast .mailbtn'), wa = document.querySelector('a.follow'), h1 = document.querySelector('.mast h1'), mast = document.querySelector('.mast');
    return { first: doors[0] && doors[0].textContent.trim().replace(/\\s+/g, ' '), href: doors[0] && doors[0].getAttribute('href'), second: doors[1] && doors[1].textContent.trim(), mailInMast: !!m, mailAria: m && m.getAttribute('aria-label'), mailW: m && m.getBoundingClientRect().width, mailH: m && m.getBoundingClientRect().height,
      mailSameRowAsName: !!(m && Math.abs((m.getBoundingClientRect().top + m.getBoundingClientRect().height / 2) - (h1.getBoundingClientRect().top + h1.getBoundingClientRect().height / 2)) < 30), mastH: mast.getBoundingClientRect().height,
      noMailInRow: !document.querySelector('.iconrow [data-copy]'), waInFoot: !!(wa && wa.closest('.info')), waAfterDoors: !!(wa && doors[0] && (doors[0].compareDocumentPosition(wa) & Node.DOCUMENT_POSITION_FOLLOWING)), waH: wa && wa.getBoundingClientRect().height, noRowFollow: !document.querySelector('.iconrow + a.follow, main > .wrap > a.follow') }; })()`);
  check('"Make a Donation" is the first of the big buttons, above "Book the Parish Hall", and goes to the donation page', /^Make a Donation/.test(pg.first) && pg.href === '/donate/svp-osterley' && /Book the Parish Hall/.test(pg.second), JSON.stringify([pg.first, pg.href, pg.second]));
  check('the email envelope sits in the top banner on the same line as the parish name (44px, named for screen readers), and is gone from the shortcut row', pg.mailInMast && pg.mailSameRowAsName && pg.mailW >= 44 && pg.mailH >= 44 && /Copy the parish email address/.test(pg.mailAria) && pg.noMailInRow, JSON.stringify(pg));
  check('"Follow us on WhatsApp" now sits with the parish details at the foot (44px tall), not as a line at the top', pg.waInFoot && pg.waAfterDoors && pg.waH >= 44 && pg.noRowFollow, JSON.stringify([pg.waInFoot, pg.waAfterDoors, pg.waH]));
  await ev(CLIP);
  await click('.mast .mailbtn');
  check('pressing the envelope copies the parish email address and says so', await waitFor(`/osterley@example.org/.test(document.getElementById('toast').textContent)`) && (await ev('window.__copied[0]')) === 'osterley@example.org', await toastText());
  await shot('parish-390');

  // ---- the donation page
  await click('.door', 'Make a Donation');
  check('it opens the donation page with the welcome line, the quick amounts and £10 already filled in', await waitFor(readyDonate) && await ev(`(() => { const t = document.body.innerText; return /Thank you for supporting our parish/.test(t) && [...document.querySelectorAll('.q')].map(b => b.textContent.trim()).join() === '£10,£20,£50,£100' && document.getElementById('fAmount').value === '10' && document.querySelector('.q[aria-pressed=true]').textContent.trim() === '£10' && /£10\\.00/.test(document.getElementById('payAmt').textContent); })()`));
  const m0 = await ev(MEASURE_PAGE);
  check('the donation page: no sideways scroll, text 15px or larger, tap targets 44px or larger', !m0.hscroll && !m0.smallText.length && !m0.smallTargets.length, JSON.stringify([m0.scrollWidth, m0.smallText.slice(0, 3), m0.smallTargets.slice(0, 4)]));
  await shot('donate-390-form');
  await click('.q', '£50');
  check('choosing £50 fills the amount box and the pay button says £50.00', (await ev("document.getElementById('fAmount').value")) === '50' && /£50\.00/.test(await ev("document.getElementById('payAmt').textContent")));
  await typeIn('#fAmount', '37.5');
  check('typing any amount updates the pay button and un-highlights the quick amounts', /£37\.50/.test(await ev("document.getElementById('payAmt').textContent")) && (await ev("document.querySelectorAll('.q[aria-pressed=true]').length")) === 0);

  // ---- mistakes are caught in words, before anything is sent
  const before = T('donations').length;
  await typeIn('#fAmount', '0.50'); await click('#payBtn');
  check('under £1 is refused in words and nothing is sent', await waitFor(`/from £1\\.00 to £5,000/.test((document.querySelector('.err') || {}).textContent || '')`) && T('donations').length === before);
  await typeIn('#fAmount', '6000'); await click('#payBtn');
  check('over £5,000 is refused in words and nothing is sent', await waitFor(`/from £1\\.00 to £5,000/.test((document.querySelector('.err') || {}).textContent || '')`) && T('donations').length === before);
  await typeIn('#fAmount', ''); await click('#payBtn');
  check('an empty amount asks for one', await waitFor(`/enter the amount/.test((document.querySelector('.err') || {}).textContent || '')`));
  await typeIn('#fAmount', '25'); await typeIn('#fContact', 'not-an-address'); await click('#payBtn');
  check('a contact that is neither an email nor a mobile number is refused in words (the server says which), and nothing is created', await waitFor(`document.querySelector('.err') && /mobile number/i.test(document.querySelector('.err').textContent)`) && T('donations').length === before, await ev("(document.querySelector('.err') || {}).textContent"));

  // ---- giving: no name, no contact needed
  await typeIn('#fContact', ''); await typeIn('#fAmount', '25');
  await click('#payBtn');
  const made = await waitFor(`true`) && await (async () => { for (let i = 0; i < 40; i++) { await sleep(150); if (T('donations').length === before + 1) return true; } return false; })();
  check('pressing the pay button creates one donation for £25.00 with no name or contact, and sends the browser to the card page', made && T('donations')[before].amount === 25 && T('payments').at(-1).payer_name === null && T('payments').at(-1).contact_value === null, JSON.stringify(T('donations').at(-1)));
  const donationId = T('donations')[before] && T('donations')[before].id;

  // ---- the donation's own page: waiting, then thanks
  await open(base + '/donate.html?donation=' + donationId, "document.querySelector('.status h1')");
  check('before it is paid the donation page says it is waiting, shows the reference, and offers the payment page', await waitFor(`/Waiting for your payment/.test(document.querySelector('.status h1').textContent)`) && await ev(`/DON-001/.test(document.body.innerText) && !!document.querySelector('a.btn[href^="https://pay.example/"]')`));
  sumupStatus = 'PAID';
  await open(base + '/donate.html?donation=' + donationId, "document.querySelector('.status h1')");
  check('once paid it says thank you with the amount, the reference, a copy button and a way back to the parish page', await waitFor(`/Thank you for your gift of £25\\.00/.test(document.querySelector('.status h1').textContent)`) && await ev(`/DON-001/.test(document.body.innerText) && !!document.querySelector('[data-copy="DON-001"]') && !!document.querySelector('a.btn[href="/go/svp-osterley"]')`));
  await shot('donate-390-thanks');
  await ev(CLIP); await click('[data-copy]');
  check('the copy button copies the reference and says so', await waitFor(`/Reference copied: DON-001/.test(document.getElementById('toast').textContent)`));
  await open(base + '/donate.html?donation=11111111-1111-1111-1111-111111111111', "document.querySelector('.status h1')");
  check('an unknown donation link says so kindly', await waitFor(`/could not find that donation/.test(document.querySelector('.status h1').textContent)`));
  await view(320, 640); await open(base + '/donate/svp-osterley', readyDonate);
  const m1 = await ev(MEASURE_PAGE);
  check('at 320px wide the donation page still has no sideways scroll and big enough taps', !m1.hscroll && !m1.smallTargets.length, JSON.stringify([m1.scrollWidth, m1.smallTargets.slice(0, 4)]));
  await shot('donate-320-form');
  await view(390, 844);

  // ---- moving it down below the Hall button (as the office would, in Settings)
  T('donation_settings')[0].door_position = 2;
  await open(base + '/go/svp-osterley', "document.querySelector('.door')");
  check('with the position set to 2, "Book the Parish Hall" comes first and "Make a Donation" second', await ev(`(() => { const d = [...document.querySelectorAll('.door')]; return /Book the Parish Hall/.test(d[0].textContent) && /Make a Donation/.test(d[1].textContent); })()`));
  T('donation_settings')[0].door_position = 9;
  await open(base + '/go/svp-osterley', "document.querySelector('.door')");
  check('a position past the last button still shows it (at the end), never loses it', await ev(`(() => { const d = [...document.querySelectorAll('.door')]; return d.length === 2 && /Make a Donation/.test(d[1].textContent); })()`));
  T('donation_settings')[0].door_position = 1;

  // ---- the office
  const loginAs = async (token, user) => {
    await open(base + '/theme.css', 'document.body');
    await ev(`localStorage.setItem('pc_session', JSON.stringify({ session: ${JSON.stringify(token)}, user: ${JSON.stringify(user)}, campaigns: [], org: null, lastCampaignId: null })); 'ok'`);
    await open(base + '/index.html', "document.querySelector('#headerRight button')");
    for (let k = 0; k < 6; k++) { await ev(`viewMode = 'admin'; render(); 'ok'`); if (await waitFor(`document.querySelector('.tabs button')`, 2500)) break; }
  };
  await loginAs(AD, { id: 'uA-ad', name: 'admin', role: 'admin', org_id: 'org-A', mobile: '07000000002' });
  await click('[data-group=money]');
  check('the admin sees a Donations tab in the Money section', await waitFor(`document.querySelector('[data-tab=donations]')`));
  await click('[data-tab=donations]');
  check('it shows this month\'s total (the paid £25.00), the latest donations and the Open switch', await waitFor(`/£25\\.00/.test(document.getElementById('adminContent').innerText) && /DON-001/.test(document.getElementById('adminContent').innerText)`) && await ev(`/Open/.test(document.querySelector('#adminContent .gw-status').textContent)`));
  const am = await ev(MEASURE_ADMIN);
  check('the Donations screen: no sideways scroll, tap targets 44px or larger', !am.hscroll && !am.smallTargets.length, JSON.stringify([am.scrollWidth, am.smallTargets.slice(0, 5)]));
  await shot('admin-390-donations');
  await click('.seg button', 'Settings');
  check('Settings offers where the button goes: at the top, or after each of the other buttons (named)', await waitFor(`document.getElementById('dnPos')`) && await ev(`[...document.querySelectorAll('#dnPos option')].map(o => o.textContent).join('|')`) === 'At the top (first button)|After “Book the Parish Hall”');
  await ev(`(() => { const s = document.getElementById('dnPos'); s.value = '2'; s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await typeIn('#dnIntro', 'God bless your generosity.');
  await click('#adminContent button', 'Save');
  check('saving the welcome line says Saved, and the donation page then shows it', await waitFor(`/Saved/.test(document.getElementById('toast').textContent)`) && T('donation_settings')[0].intro_text === 'God bless your generosity.' && T('donation_settings')[0].door_position === 2);
  await click('.seg button', 'Donations');
  await ev(`document.querySelector('#adminContent .gw-switchrow input').click(); 'ok'`);
  check('switching it off says Donations are now closed', await waitFor(`/now closed/.test(document.getElementById('toast').textContent)`) && T('donation_settings')[0].enabled === false);
  await open(base + '/go/svp-osterley', "document.querySelector('.door')");
  check('once closed, the donate button is gone from the parish page (the Hall button is first again)', await ev(`!document.querySelector('.door[href^="/donate/"]') && /Book the Parish Hall/.test(document.querySelector('.door').textContent)`));
  await open(base + '/donate/svp-osterley', "document.querySelector('.status h1')");
  check('and the donation page itself says donations are not open', await waitFor(`/not open right now/.test(document.querySelector('.status h1').textContent)`));
  await loginAs(VO, { id: 'uA-vo', name: 'volunteer', role: 'volunteer', org_id: 'org-A', mobile: '07000000004' });
  check('a volunteer is not shown any Donations tab', await ev(`!document.querySelector('[data-tab=donations]') && ![...document.querySelectorAll('.tabs button')].some(b => /Donations/.test(b.textContent))`));

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL DONATION BROWSER CHECKS PASSED');
  console.log('screenshots in ' + OUT);
  proc.kill();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { proc && proc.kill(); } catch { /* done */ } process.exit(2); });
