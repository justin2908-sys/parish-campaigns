// Browser checks for the lists of campaigns and forms (filter chips, Active by default), deleting a draft, and the Parish page editor showing only what is live.
//   node test/gateway/ui-lists.js [output-folder]
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { db, clock, api, addUser, call } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'ui-shots-lists'));
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
  const todayISO = new Date().toISOString().slice(0, 10), plus = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  // ---- seed: one of each kind of campaign and form
  const ticketed = async (name, patch, extra) => { const r = await call('create_campaign', { name, kind: 'event', age_restricted: false, public_page_enabled: true, public_only: true, keep_until: plus(60), tiers: [{ name: 'Adult', price: 10 }], blocks: [{ type: 'digital', label: 'Online', number_prefix: 'O', range_start: 1, range_end: 10 }], ...extra }, { session: SA }); if (r.status !== 200) throw new Error(r.raw); const id = r.body.campaign.id; T('tickets').filter(x => x.campaign_id === id).forEach(x => { x.status = 'unsold'; }); Object.assign(T('campaigns').find(c => c.id === id), patch || {}); return id; };
  const form = async (name, patch, extra) => { const r = await call('create_campaign', { kind: 'registration', name, keep_until: plus(60), form_def: { fields: [] }, ...extra }, { session: SA }); if (r.status !== 200) throw new Error(r.raw); Object.assign(T('campaigns').find(c => c.id === r.body.campaign.id), patch || {}); return r.body.campaign.id; };
  const live = await ticketed('Christmas Dinner', { listed_on_gateway: true }, { closes_on: plus(30) });
  const soon = await ticketed('Easter Lunch', {}, { opens_on: plus(20), closes_on: plus(40) });
  const draft = await ticketed('Summer Fete', {}, { is_draft: true });
  const ended = await ticketed('Walsingham Pilgrimage', { listed_on_gateway: true }, { closes_on: plus(-30), opens_on: plus(-90) });
  const paused = await ticketed('Old Raffle', { active: false });
  const liveForm = await form('Film Night', { listed_on_gateway: true });
  const draftForm = await form('Choir Sign-up', {}, { is_draft: true });
  const endedForm = await form('Last Year Form', { listed_on_gateway: true }, { closes_on: plus(-10) });

  const login = async () => { await ev(`(async () => { state.session = ${JSON.stringify(SA)}; state.user = { id: 'uA-sa', name: 'superadmin', role: 'superadmin', org_id: 'org-A', mobile: '07000000001' }; try { sessionStorage.setItem('session', state.session); } catch (e) {} viewMode = 'admin'; render(); return 'ok'; })()`); };
  const names = (sel) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.textContent.trim())`);
  const chips = () => ev(`[...document.querySelectorAll('#adminContent .listfilter button')].map(b => b.textContent.replace(/\\s+/g, ' ').trim() + (b.getAttribute('aria-pressed') === 'true' ? '*' : ''))`);
  const hscroll = () => ev(`document.documentElement.scrollWidth > Math.min(innerWidth, (window.visualViewport || {}).width || innerWidth) + 1`);
  await view(390, 844);
  await open(base + '/', "document.getElementById('app')");
  await login(); await waitFor(`document.querySelector('.tabs.sections')`, 8000);

  // ---- the Campaigns list
  await waitFor(`document.querySelector('#adminContent .listfilter')`, 8000);
  const camps = await names('#adminContent table td[data-draftname]');
  check('the Campaigns list shows only the ACTIVE ones by default (the live dinner and the live form)', JSON.stringify(camps.sort()) === JSON.stringify(['Christmas Dinner', 'Film Night']), JSON.stringify(camps));
  check('the chips show a count on each and only the ones with something behind them: Active 2, Upcoming 1, Draft 2, Ended or inactive 3, All 8', JSON.stringify(await chips()) === JSON.stringify(['Active 2*', 'Upcoming 1', 'Draft 2', 'Ended or inactive 3', 'All 8']), JSON.stringify(await chips()));
  check('the chips fit a phone screen without the page scrolling sideways', !(await hscroll()));
  await shot('lists-390-active');
  await click('#adminContent .listfilter button', 'Draft');
  await waitFor(`document.querySelector('#adminContent .listfilter button[aria-pressed="true"]').textContent.startsWith('Draft')`);
  check('the Draft chip shows the two drafts', JSON.stringify((await names('#adminContent table td[data-draftname]')).sort()) === JSON.stringify(['Choir Sign-up', 'Summer Fete']), JSON.stringify(await names('#adminContent table td[data-draftname]')));
  await click('#adminContent .listfilter button', 'Ended or inactive');
  await waitFor(`document.querySelector('#adminContent .listfilter button[aria-pressed="true"]').textContent.startsWith('Ended')`);
  check('Ended or inactive brings up the ended and the paused ones (Walsingham is here, not on the main list)', JSON.stringify((await names('#adminContent table td[data-draftname]')).sort()) === JSON.stringify(['Last Year Form', 'Old Raffle', 'Walsingham Pilgrimage']), JSON.stringify(await names('#adminContent table td[data-draftname]')));
  await click('#adminContent .listfilter button', 'Upcoming');
  await waitFor(`document.querySelector('#adminContent .listfilter button[aria-pressed="true"]').textContent.startsWith('Upcoming')`);
  check('Upcoming shows what has not opened yet', JSON.stringify(await names('#adminContent table td[data-draftname]')) === JSON.stringify(['Easter Lunch']));
  await click('#adminContent .listfilter button', 'All');
  await waitFor(`document.querySelector('#adminContent .listfilter button[aria-pressed="true"]').textContent.startsWith('All')`);
  check('All shows everything', (await names('#adminContent table td[data-draftname]')).length === 8);

  // ---- deleting a draft
  await click('#adminContent .listfilter button', 'Draft');
  await waitFor(`document.querySelector('#adminContent .listfilter button[aria-pressed="true"]').textContent.startsWith('Draft')`);
  const delBtns = await ev(`[...document.querySelectorAll('#adminContent table tr')].filter(tr => tr.querySelector('[data-draftname]')).map(tr => ({ n: tr.querySelector('[data-draftname]').textContent, del: !!([...tr.querySelectorAll('button')].find(b => b.textContent.trim() === 'Delete')) }))`);
  check('every draft has a Delete button', delBtns.length === 2 && delBtns.every(x => x.del), JSON.stringify(delBtns));
  await ev(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(m); return false; }; 'ok'`);
  await ev(`[...document.querySelectorAll('#adminContent table tr')].find(tr => tr.textContent.includes('Summer Fete')).querySelector('button[onclick^="doDeleteDraft"]').click(); 'ok'`);
  await sleep(300);
  check('Delete asks first, in plain words, and "Cancel" deletes nothing', /Summer Fete/.test(await ev(`window.__confirms[0] || ''`)) && T('campaigns').some(c => c.id === draft));
  await ev(`window.confirm = () => true; 'ok'`);
  await ev(`[...document.querySelectorAll('#adminContent table tr')].find(tr => tr.textContent.includes('Summer Fete')).querySelector('button[onclick^="doDeleteDraft"]').click(); 'ok'`);
  check('confirming deletes the draft for good, with a message, and the list updates', await waitFor(`!document.body.innerText.includes('Summer Fete')`, 8000) && !T('campaigns').some(c => c.id === draft) && /deleted/.test(await ev(`(document.getElementById('toast') || {}).textContent || ''`)) && T('tickets').filter(t => t.campaign_id === draft).length === 0);
  check('an opened campaign has no Delete button (it goes to the Recycle Bin)', await (async () => { await click('#adminContent .listfilter button', 'Active'); await waitFor(`document.querySelector('#adminContent .listfilter button[aria-pressed="true"]').textContent.startsWith('Active')`); return ev(`![...document.querySelectorAll('#adminContent table button')].some(b => b.textContent.trim() === 'Delete')`); })());

  // ---- the Registrations list
  await ev(`setAdminGroup('campaigns'); setAdminTab('registrations'); 'ok'`);
  await waitFor(`document.querySelector('#adminContent .listfilter')`, 8000);
  const forms = await names('#adminContent [data-draftname]');
  check('the Registrations list shows only the active form by default, with the same chips', JSON.stringify(forms) === JSON.stringify(['Film Night']) && (await chips())[0] === 'Active 1*', JSON.stringify([forms, await chips()]));
  await click('#adminContent .listfilter button', 'Draft');
  await waitFor(`document.querySelector('#adminContent .listfilter button[aria-pressed="true"]').textContent.startsWith('Draft')`);
  check('its draft has a Delete button, and deleting it works', await (async () => {
    await ev(`window.confirm = () => true; 'ok'`);
    const had = await ev(`!!document.querySelector('#adminContent button[onclick^="doDeleteDraft"]')`);
    await ev(`document.querySelector('#adminContent button[onclick^="doDeleteDraft"]').click(); 'ok'`);
    await waitFor(`!document.body.innerText.includes('Choir Sign-up')`, 8000);
    return had && !T('campaigns').some(c => c.id === draftForm);
  })());
  await shot('lists-390-forms');

  // ---- the Parish page editor
  await ev(`setAdminGroup('page'); setAdminTab('parishpage'); 'ok'`);
  await waitFor(`document.querySelector('#gwItems')`, 8000);
  const onPage = await names('#gwItems .gw-arow .nm');
  check('the Parish page editor lists only what is live or coming (Walsingham, the old form and the draft are not in it)', onPage.sort().join('|') === 'Christmas Dinner|Easter Lunch|Film Night', JSON.stringify(onPage));
  const hid = await ev(`(() => { const b = [...document.querySelectorAll('#gwItems button')].find(x => /Show ended/.test(x.textContent)); return b && b.textContent.trim(); })()`);
  check('a button says how many are tucked away', /Show ended, paused and draft \(\d+\)/.test(hid || ''), hid);
  await click('#gwItems button', 'Show ended');
  await waitFor(`document.querySelector('#gwItems').textContent.includes('Walsingham Pilgrimage')`);
  check('pressing it brings them back, and it can be hidden again', (await names('#gwItems .gw-arow .nm')).includes('Walsingham Pilgrimage') && /Hide ended/.test(await ev(`document.querySelector('#gwItems').textContent`)));
  await shot('lists-390-parish-page');
  // the public page itself never showed them
  const pub = await call('public_gateway', { slug: 'svp-osterley' });
  const pubNames = [...(pub.body.sections.involved || []), ...(pub.body.sections.registration || [])].map(i => i.name).sort();
  check('and the public parish page shows only the live ones', pubNames.join('|') === 'Christmas Dinner|Film Night', JSON.stringify(pubNames));

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL LIST BROWSER CHECKS PASSED');
  console.log('screenshots in ' + OUT);
  proc.kill(); server.close(); process.exit(failures ? 1 : 0);
})().catch(e => { console.log('The browser run stopped: ' + (e && e.stack || e)); try { proc.kill(); } catch (x) { /* gone */ } process.exit(1); });
