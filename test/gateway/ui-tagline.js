// Browser checks for the optional campaign tagline: the public page (one line, smaller than the headline, at phone widths) and the office screens that set it.
//   node test/gateway/ui-tagline.js [output-folder]
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { db, clock, api, addUser, call } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'ui-shots-tagline'));
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
      const r = await api.handler({ httpMethod: 'POST', path: u.pathname, headers: { host: req.headers.host, 'x-nf-client-connection-ip': u.pathname === '/api/public_heart' ? '10.9.9.9' : '10.1.1.' + (1 + Math.floor(Math.random() * 200)) }, body });
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

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://localhost:' + server.address().port;
  await launch();
  const mk = async (extra) => { const r = await call('create_campaign', { name: 'Christmas Dinner 2026', kind: 'event', age_restricted: false, public_page_enabled: true, public_only: true, keep_until: '2027-03-01', details_text: 'Bring a chair.', tiers: [{ name: 'Adult', price: 15 }], blocks: [{ type: 'digital', label: 'Online', number_prefix: 'O', range_start: 1, range_end: 50 }], ...extra }, { session: SA }); if (r.status !== 200) throw new Error(r.raw); const id = r.body.campaign.id; T('tickets').filter(x => x.campaign_id === id).forEach(x => { x.status = 'unsold'; }); return id; };
  const withTag = await mk({ tagline: 'Buffet Dinner & Family Entertainment' });
  const without = await mk({ name: 'Summer Picnic' });
  const LINES = `(() => { const h = document.querySelector('.top h1'), t = document.querySelector('.top .tagline'); if (!t) return { none: true, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }; const hr = h.getBoundingClientRect(), tr = t.getBoundingClientRect(); const lh = parseFloat(getComputedStyle(t).lineHeight); return { text: t.textContent, tagPx: parseFloat(getComputedStyle(t).fontSize), headPx: parseFloat(getComputedStyle(h).fontSize), lines: Math.round(tr.height / lh), below: tr.top >= hr.bottom - 1, clipped: t.scrollWidth > t.clientWidth, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }; })()`;

  for (const [w, h] of [[390, 844], [360, 740], [320, 640]]) {
    await view(w, h);
    await open(base + '/buy.html?campaign_id=' + withTag, "document.querySelector('.top h1')");
    const m = await ev(LINES); if (!m.text) console.log('  debug:', await ev('JSON.stringify(info && info.campaign)'), await ev('document.body.innerText.slice(0,300)'));
    check(`public page at ${w}px: the tagline sits under the headline, in a smaller font, on one line, with no sideways scroll`, m.text === 'Buffet Dinner & Family Entertainment' && m.tagPx < m.headPx && m.lines === 1 && m.below && !m.hscroll, JSON.stringify(m));
    if (w === 320) check('...and even at 320px a 36-character tagline is not cut off', !m.clipped, JSON.stringify(m));
    if (w === 390) await shot('buy-390-tagline');
  }
  // the longest allowed (50 characters) must still stay on one line, never pushing the page sideways
  const longest = await mk({ name: 'Long one', tagline: 'W'.repeat(50) });
  await view(320, 640); await open(base + '/buy.html?campaign_id=' + longest, "document.querySelector('.top h1')");
  const lm = await ev(LINES);
  check('the longest tagline (50 wide letters) stays on one line at 320px and does not push the page sideways', lm.lines === 1 && !lm.hscroll, JSON.stringify(lm));
  await view(390, 844); await open(base + '/buy.html?campaign_id=' + without, "document.querySelector('.top h1')");
  const nm = await ev(LINES);
  check('no tagline: nothing extra is drawn on the public page', nm.none && !nm.hscroll, JSON.stringify(nm));

  // ---- the office: the wizard has the optional field, the campaign settings can change it
  await view(390, 844);
  await open(base + '/', "document.getElementById('app')");
  await ev(`localStorage.setItem('x','y'); 'ok'`);
  const login = async () => { await ev(`(async () => { state.session = ${JSON.stringify(SA)}; state.user = { id: 'uA-sa', name: 'superadmin', role: 'superadmin', org_id: 'org-A', mobile: '07000000001' }; try { sessionStorage.setItem('session', state.session); } catch (e) {} render(); return 'ok'; })()`); };
  await login(); await waitFor(`document.querySelector('.tabs.sections')`, 8000);
  await ev(`openCampaignWizard('event'); 'ok'`);
  await waitFor(`document.querySelector('.kindcard')`);
  await ev(`setWizKind('event'); goToWizStep(2); 'ok'`);
  const f = await waitFor(`document.getElementById('wTagline')`);
  const fm = f && await ev(`(() => { const i = document.getElementById('wTagline'), l = i.previousElementSibling; return { max: i.maxLength, label: l.textContent, optional: /optional/.test(l.textContent), notRequired: !i.required }; })()`);
  check('the wizard has an optional Tagline box limited to 50 characters', f && fm.max === 50 && fm.optional && fm.notRequired, JSON.stringify(fm));
  await ev(`(() => { const i = document.getElementById('wTagline'); i.value = 'Turkey and all the trimmings'; i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
  check('it counts the characters as you type', (await ev(`document.getElementById('wTaglineN').textContent`)) === '28');
  await shot('wizard-390-tagline');
  await ev(`setWizKind('registration'); drawWizard && drawWizard(); 'ok'`).catch(() => {});
  await ev(`closeCampaignWizard(); 'ok'`);

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL TAGLINE BROWSER CHECKS PASSED');
  console.log('screenshots in ' + OUT);
  proc.kill(); server.close(); process.exit(failures ? 1 : 0);
})().catch(e => { console.log('The browser run stopped: ' + (e && e.stack || e)); try { proc.kill(); } catch (x) { /* gone */ } process.exit(1); });
