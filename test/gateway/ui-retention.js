// Browser checks for how many days after "keep until" details are removed (30 to 90, default 30): the wizard, the limits, the live note, and the campaign settings.
//   node test/gateway/ui-retention.js [output-folder]
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { db, clock, api, addUser, call } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'ui-shots-retention'));
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
  await view(390, 844);
  await open(base + '/', "document.getElementById('app')");
  await ev(`localStorage.setItem('x','y'); 'ok'`);
  await ev(`(async () => { state.session = ${JSON.stringify(SA)}; state.user = { id: 'uA-sa', name: 'superadmin', role: 'superadmin', org_id: 'org-A', mobile: '07000000001' }; try { sessionStorage.setItem('session', state.session); } catch (e) {} render(); return 'ok'; })()`);
  await waitFor(`document.querySelector('.tabs.sections')`, 8000);

  // ---- the wizard's dates step
  await ev(`openCampaignWizard('event'); 'ok'`); await waitFor(`document.querySelector('.kindcard')`);
  await ev(`setWizKind('event'); wiz.name = 'Retention Dinner'; goToWizStep(3); 'ok'`);
  check('the dates step has a "days later" box', await waitFor(`document.getElementById('wRetain')`));
  const f = await ev(`(() => { const i = document.getElementById('wRetain'); return { value: i.value, min: i.min, max: i.max, type: i.type }; })()`);
  check('it starts at 30, and only allows 30 to 90', f.value === '30' && f.min === '30' && f.max === '90' && f.type === 'number', JSON.stringify(f));
  await setVal('#wKeep', '2027-03-01');
  const n30 = await ev(`document.getElementById('wizDelNote').textContent`);
  check('the note under it says the exact removal day for 30 days', /removed on .*2027.*30 days after that/.test(n30) && /31 Mar/.test(n30), n30);
  await setVal('#wRetain', '90');
  const n90 = await ev(`document.getElementById('wizDelNote').textContent`);
  check('changing it to 90 updates the note at once (30 May 2027)', /30 days|90 days after that/.test(n90) && /90 days after that/.test(n90) && /30 May/.test(n90), n90);
  await shot('wizard-390-dates-retention');
  for (const bad of ['29', '91', '', '45.5']) {
    await setVal('#wRetain', bad);
    await ev(`wizNext(); 'ok'`);
    const err = await ev(`(document.getElementById('wizErr') || {}).textContent || ''`);
    check(`"${bad}" days is refused in plain words and the wizard stays on the dates step`, /between 30 and 90/.test(err) && (await ev('wizStep')) === 3, err);
  }
  await setVal('#wRetain', '45');
  await ev(`wizNext(); 'ok'`);
  check('45 days is accepted and moves on', (await ev('wizStep')) === 4);

  // ---- creating a campaign stores the number chosen
  await ev(`(() => { wiz.audience = 'public'; wiz.type = 'digital'; draftTiers = [{ name: 'Adult', price: '10' }]; draftBlocks = [{ type: 'digital', label: 'Online', range_start: 1, range_end: 20, number_prefix: 'O' }]; return 'ok'; })()`);
  await ev("goToWizStep(6); 'ok'");
  await waitFor("document.querySelector('#wizardPanel button[onclick=\"doCreateCampaignWizard(true)\"]')");
  await click('#wizardPanel button', 'Save as draft');
  await waitFor("!document.getElementById('wizardPanel')", 10000); await sleep(400);
  const made = db.T('campaigns').find(c => c.name === 'Retention Dinner');
  check('the new campaign is saved with the 45 days chosen', made && made.retention_days === 45, JSON.stringify(made && made.retention_days));

  // ---- the campaign's settings show it and can change it
  await ev(`openCampaignSettings('${made.id}'); 'ok'`);
  check('settings show the box with 45', await waitFor(`document.getElementById('csetRetain') && document.getElementById('csetRetain').value === '45'`));
  await shot('settings-390-retention');
  await setVal('#csetRetain', '20'); await ev(`doSaveCsetDates(false); 'ok'`); await sleep(500);
  const bad = await ev(`(document.getElementById('cmsg-dates') || {}).textContent || ''`);
  check('20 days is refused in settings and nothing changes', /between 30 and 90/.test(bad) && db.T('campaigns').find(c => c.id === made.id).retention_days === 45, bad);
  await setVal('#csetRetain', '60'); await ev(`doSaveCsetDates(false); 'ok'`);
  check('60 days saves, and the page confirms the new removal day', await waitFor(`/Names and contact details will be removed on/.test((document.getElementById('cmsg-dates') || {}).textContent || '')`) && db.T('campaigns').find(c => c.id === made.id).retention_days === 60);
  const msg = await ev(`(document.getElementById('cmsg-dates') || {}).textContent || ''`);
  check('...and says 30 April 2027 (1 March + 60 days)', /30 April 2027|Fri 30 Apr/.test(msg) || /30 Apr/.test(msg), msg);

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL RETENTION BROWSER CHECKS PASSED');
  console.log('screenshots in ' + OUT);
  proc.kill(); server.close(); process.exit(failures ? 1 : 0);
})().catch(e => { console.log('The browser run stopped: ' + (e && e.stack || e)); try { proc.kill(); } catch (x) { /* gone */ } process.exit(1); });
