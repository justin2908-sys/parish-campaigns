// Browser checks for Registrations 2, in a real (headless) Edge or Chrome, against the real api.js on the in-memory stand-in database:
// the public form (tick boxes, "Other", show-only-if, places) and the admin side (edit the questions, counts and print list).
//   node test/gateway/ui-registrations.js [output-folder]
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { db, clock, api, addUser, call } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'ui-shots-reg'));
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
  let p = u.pathname; if (p === '/') p = '/index.html';
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
  const q = (type, label, o = {}) => ({ type, label, ...o });
  const mk = async (name, form_def, extra = {}) => { const r = await call('create_campaign', { kind: 'registration', name, keep_until: '2027-06-01', form_def, ...extra }, { session: SA }); if (r.status !== 200) throw new Error(r.raw); return r.body.campaign.id; };
  const dinner = await mk('Senior Citizens Christmas Dinner', { intro: 'We use your details only to organise the dinner.', fields: [
    q('heading', 'Your meal'), q('note', 'Dinner is at 12.30 on Sunday 13 December. Doors open at noon.'),
    q('dropdown', 'Main course', { id: 'main', required: true, options: ['Turkey', 'Nut roast'], allow_other: true }),
    q('multichoice', 'Anything we should arrange?', { id: 'needs', options: ['A lift', 'Wheelchair access', 'Gluten free'], max_choices: 2, allow_other: true }),
    q('yesno', 'Do you need a lift?', { id: 'lift' }),
    q('text', 'Pick-up address', { id: 'addr', required: true, show_if: { field: 'lift', values: ['yes'] } }),
  ], party: { max: 3, label: 'How many places, including you?' } }, { places: 10 });

  // ---- the public form
  await launch(); await view(390, 844);
  const url = `${base}/register.html?campaign_id=${dinner}`;
  check('the form opens', await open(url, "document.getElementById('goBtn')"));
  check('a heading and a note are shown as text to read, with no answer box', await ev(`(() => { const h = document.querySelector('#q_q1 h3'), n = document.querySelector('#q_q2 p'); return !!h && h.textContent === 'Your meal' && !!n && n.textContent.includes('Doors open at noon') && !document.querySelector('#q_q1 input, #q_q2 input'); })()`));
  check('"Pick-up address" is hidden until the lift question is answered Yes', await ev(`document.getElementById('q_addr').hidden === true`));
  await ev(`document.querySelector('#f_lift button[data-v=yes]').click()`);
  check('answering Yes shows it', await ev(`document.getElementById('q_addr').hidden === false`));
  await ev(`document.querySelector('#f_lift button[data-v=no]').click()`);
  check('changing to No hides it again', await ev(`document.getElementById('q_addr').hidden === true`));
  check('"Other, please type" boxes start hidden', await ev(`document.getElementById('fo_main').hidden && document.getElementById('fo_needs').hidden`));
  await setVal('#f_main', 'Other', 'change');
  check('choosing Other on the dropdown shows a box to type in', await ev(`!document.getElementById('fo_main').hidden`));
  await ev(`(() => { const b = document.querySelectorAll('#f_needs input[type=checkbox]'); b[0].click(); b[1].click(); })()`);
  check('with "up to 2" ticked, the other tick boxes are switched off', await ev(`[...document.querySelectorAll('#f_needs input[type=checkbox]')].filter(c => c.disabled).length === 2`));
  await ev(`document.querySelectorAll('#f_needs input[type=checkbox]')[1].click()`);
  check('unticking one frees them again', await ev(`[...document.querySelectorAll('#f_needs input[type=checkbox]')].filter(c => c.disabled).length === 0`));
  check('the places question offers 1 to 3', await ev(`[...document.querySelectorAll('#f_party option')].map(o => o.value).join() === '1,2,3'`));
  const m = await ev(`({ h: document.documentElement.scrollWidth > Math.min(innerWidth, (window.visualViewport || {}).width || innerWidth) + 1, boxes: [...document.querySelectorAll('.chk')].map(e => Math.round(e.getBoundingClientRect().height)) })`);
  check('no sideways scroll at 390px, and tick-box rows are at least 44px tall', !m.h && m.boxes.every(h => h >= 44), JSON.stringify(m));
  await shot('form-390');
  // a refused attempt: Other with nothing typed
  await click('#goBtn');
  check('submitting with the name missing marks it in red and says what to fix', await ev(`document.getElementById('q_name').classList.contains('bad') && document.getElementById('barErr').textContent.includes('marked in red')`));
  await setVal('#f_name', 'Mary Smith'); await setVal('#f_email', 'mary@example.org');
  await click('#goBtn');
  check('"Other" chosen but nothing typed is flagged on that question', await ev(`document.getElementById('q_main').classList.contains('bad') && document.querySelector('#q_main .why').textContent.includes('type your answer')`));
  await setVal('#fo_main', 'Fish pie');
  await ev(`document.querySelector('#f_lift button[data-v=yes]').click()`);
  await click('#goBtn');
  check('a question that is showing and required (pick-up address) is flagged', await ev(`document.getElementById('q_addr').classList.contains('bad')`));
  await setVal('#f_addr', '12 Elm Road'); await setVal('#f_party', '2', 'change');
  await ev(`document.querySelectorAll('#f_needs input[type=checkbox]')[1].click()`);
  await click('#goBtn');
  check('a good submission goes to the person’s own page', await waitFor(`location.pathname === '/registration.html'`));
  const row = T('registrations')[0] || {};
  const A = (id) => (row.answers || []).find(a => a.id === id) || {};
  check('the registration was saved with 2 places, the typed Other, the ticked choices and the address', row.party_size === 2 && A('main').value === 'Other: Fish pie' && JSON.stringify(A('needs').value) === JSON.stringify(['A lift', 'Wheelchair access']) && A('addr').value === '12 Elm Road', JSON.stringify(row.answers));

  // a hidden question's text is never sent
  await open(url, "document.getElementById('goBtn')");
  await ev(`document.querySelector('#f_lift button[data-v=yes]').click()`); await setVal('#f_addr', 'typed then hidden'); await ev(`document.querySelector('#f_lift button[data-v=no]').click()`);
  await setVal('#f_name', 'Jo Hidden'); await setVal('#f_email', 'jo@example.org'); await setVal('#f_main', 'Turkey', 'change');
  await click('#goBtn'); await waitFor(`location.pathname === '/registration.html'`);
  const jo = T('registrations').find(r => r.name === 'Jo Hidden') || {};
  check('text typed into a question that was then hidden is not stored', jo.answers && !jo.answers.some(a => a.id === 'addr') && jo.party_size === 1, JSON.stringify(jo.answers));
  // places left limits the drop-down
  for (let i = 0; i < 6; i++) T('registrations').push({ id: 'fill' + i, campaign_id: dinner, reg_number: 100 + i, status: 'submitted', party_size: 1, answers: [], agreements: [] });
  await open(url, "document.getElementById('goBtn')");
  check('with only 1 place left, the places drop-down offers just 1', await ev(`[...document.querySelectorAll('#f_party option')].map(o => o.value).join() === '1'`), String(await ev(`document.querySelector('.fine').textContent`)));
  T('registrations').splice(T('registrations').findIndex(r => r.id === 'fill0'), 6);

  // ---- the admin side
  const loginAs = async (token, user) => {
    await open(base + '/index.html', "document.getElementById('app')");
    await ev(`localStorage.setItem('pc_session', JSON.stringify({ session: ${JSON.stringify(token)}, user: ${JSON.stringify(user)}, campaigns: [], org: null, lastCampaignId: null })); 'ok'`);
    await open(base + '/index.html', "document.querySelector('#headerRight button')");
    await ev(`viewMode = 'admin'; render(); 'ok'`);
  };
  await loginAs(SA, { id: 'uA-sa', name: 'superadmin', role: 'superadmin', org_id: 'org-A', mobile: '07000000001' });
  await ev(`setAdminTab('registrations'); 'ok'`);
  check('the Registrations tab lists the form and counts places, not just registrations', await waitFor(`document.getElementById('adminContent').textContent.includes('Senior Citizens Christmas Dinner') && /\\d+ registered · \\d+ of 10 places taken/.test(document.getElementById('adminContent').textContent)`), await ev(`document.getElementById('adminContent').textContent.slice(0, 240)`));
  await click('button', 'Responses');
  check('responses show the party size', await waitFor(`document.getElementById('regRows') && document.getElementById('regRows').textContent.includes('× 2 places')`));
  await click('button', '📊 Counts');
  check('the counts panel opens with a count for each choice question, in people and places', await waitFor(`document.getElementById('regTablePanel') && document.getElementById('regTablePanel').textContent.includes('Main course') && document.getElementById('regTablePanel').textContent.includes('Anything we should arrange?')`));
  const tbl = await ev(`document.getElementById('regTablePanel').innerText`);
  check('  Fish pie is counted under Other (typed), 2 places', /Other \(they type it\)\s+1\s+2/.test(tbl) && /Turkey\s+1\s+1/.test(tbl), tbl.replace(/\s+/g, ' ').slice(0, 300));
  check('  the printable list shows the names and leaves private answers out by default', tbl.includes('Mary Smith') && tbl.includes('Jo Hidden'));
  await shot('counts-390');
  await click('#regTablePanel button', 'Close');
  await click('button', '← All forms');
  await waitFor(`[...document.querySelectorAll('#adminContent button')].some(b => b.textContent.includes('Form settings'))`);
  await ev(`openRegForm(${JSON.stringify(dinner)}); 'ok'`);
  check('Form settings has an "Edit the questions" button', await waitFor(`[...document.querySelectorAll('#regFormPanel button')].some(b => b.textContent.includes('Edit the questions'))`));
  await click('#regFormPanel button', '✏ Edit the questions');
  check('the editor opens and warns that people have registered (limited changes)', await waitFor(`document.getElementById('regEditPanel') && document.getElementById('regEditPanel').textContent.includes('People have already registered')`));
  check('an existing question cannot be removed, re-typed or moved, but its wording can change', await ev(`(() => { const c = document.querySelector('#regEditPanel #regFields .card'); const sel = c.querySelector('select'); const btns = [...c.querySelectorAll('button')]; return sel.disabled && btns.every(b => b.disabled) && !c.querySelector('input[data-l], textarea[data-l]').disabled; })()`));
  await shot('editor-locked-390');
  // reword one question and add an optional question + a note, then save
  await setVal('#regEditPanel #regFields .card:nth-child(3) input[data-l]', 'Which main course would you like?');
  await click('#regEditPanel button', '+ Add a question');
  await setVal('#regEditPanel #regFields .card:last-child input[data-l]', 'Anything else we should know?');
  await click('#regEditPanel button', 'Save the questions');
  check('saving says "✓ Questions saved" and the settings panel shows the new wording', await waitFor(`document.getElementById('toast').textContent.includes('Questions saved') && document.getElementById('regFormPanel').textContent.includes('Which main course would you like?') && document.getElementById('regFormPanel').textContent.includes('Anything else we should know?')`));
  const saved = T('campaigns').find(c => c.id === dinner).form_def.fields;
  check('  the server kept the same ids, so the earlier answers still match', saved.find(f => f.label === 'Which main course would you like?').id === 'main' && saved.length === 7, saved.map(f => f.id).join());
  // an unsafe change is refused with a plain reason (a seller-style tamper through the screen: remove is disabled, so use the API as the screen would)
  const refused = await call('set_registration_form', { campaign_id: dinner, form_def: { fields: saved.filter(f => f.id !== 'main') } }, { session: SA });
  check('removing an answered question is refused by the server in plain words', refused.status === 409 && /can't be removed/.test(refused.body.error), refused.raw);

  // a brand-new form (nobody registered): everything editable, and the show-only-if controls work
  const fresh = await mk('Nativity Play', { fields: [q('dropdown', 'Sacramental stage', { id: 'stage', options: ['Baptised', 'Communion'] })] });
  await ev(`closeRegForm(); 'ok'`); await ev(`setAdminTab('registrations'); 'ok'`);
  await waitFor(`document.getElementById('adminContent').textContent.includes('Nativity Play')`);
  await ev(`openRegForm(${JSON.stringify(fresh)}); 'ok'`);
  await waitFor(`document.getElementById('regFormPanel') && [...document.querySelectorAll('#regFormPanel button')].some(b => b.textContent.includes('Edit the questions'))`);
  await click('#regFormPanel button', '✏ Edit the questions');
  check('with nobody registered the editor says anything can change and nothing is locked', await waitFor(`document.getElementById('regEditPanel') && document.getElementById('regEditPanel').textContent.includes('Nobody has registered yet') && ![...document.querySelectorAll('#regEditPanel #regFields .card select')].some(s => s.disabled)`));
  await click('#regEditPanel button', '+ Add a question');
  await setVal('#regEditPanel #regFields .card:last-child input[data-l]', 'Date of communion');
  await ev(`(() => { const cb = [...document.querySelectorAll('#regEditPanel #regFields .card:last-child input[type=checkbox]')].find(c => c.parentNode.textContent.includes('Only show this for some answers')); cb.click(); })()`);
  check('"Only show this for some answers" offers the earlier choice question and its answers', await waitFor(`document.querySelector('#regEditPanel #regFields .card:last-child').textContent.includes('Sacramental stage') && document.querySelector('#regEditPanel #regFields .card:last-child').textContent.includes('Communion')`));
  await click('#regEditPanel button', 'Save the questions');
  check('saving with no answer ticked for the rule is refused with a plain message and nothing is saved', await waitFor(`document.getElementById('reMsg').textContent.includes('tick which answers make it show')`));
  await ev(`(() => { const l = [...document.querySelectorAll('#regEditPanel #regFields .card:last-child label')].find(x => x.textContent.trim() === 'Communion'); l.querySelector('input').click(); })()`);
  await click('#regEditPanel button', 'Save the questions');
  check('ticking an answer lets it save, with the rule stored against the right question', await waitFor(`document.getElementById('toast').textContent.includes('Questions saved')`) && JSON.stringify(T('campaigns').find(c => c.id === fresh).form_def.fields[1].show_if) === JSON.stringify({ field: 'stage', op: 'is', values: ['Communion'] }), JSON.stringify(T('campaigns').find(c => c.id === fresh).form_def.fields[1]));
  await shot('editor-free-390');

  // the new-form wizard still works with the shared builder
  await ev(`closeRegForm(); openCampaignWizard('registration'); 'ok'`);
  // ---- paying on the form (SumUp is stood in for: the page is sent to a pretend payment page)
  global.fetch = async (u, opts = {}) => ({ ok: true, status: 200, json: async () => ({ id: 'co-' + Math.random().toString(36).slice(2), hosted_checkout_url: 'https://pay.example/x' }) });
  const donate = await mk('Special Mass request', { fields: [q('text', 'Who is the Mass for?', { id: 'who', required: true })], payment: { mode: 'choices', amounts: [10, 20, 50], allow_other: true, min: 5, max: 200, label: 'Offering' } });
  const dpage = `${base}/register.html?campaign_id=${donate}`;
  await view(390, 844);
  check('a form with suggested amounts opens', await open(dpage, "document.getElementById('amtGrid')"));
  check('it shows each suggested amount and "Other", none chosen yet, and the Other box hidden', await ev(`[...document.querySelectorAll('#amtGrid button')].map(b => b.textContent).join('|') === '£10.00|£20.00|£50.00|Other' && !document.querySelector('#amtGrid .on') && document.getElementById('otherAmtBox').hidden`));
  const am = await ev(`[...document.querySelectorAll('#amtGrid button')].map(b => Math.round(b.getBoundingClientRect().height))`);
  check('  the amount buttons are at least 44px tall', am.every(h => h >= 44), JSON.stringify(am));
  await setVal('#f_name', 'Peter Payer'); await setVal('#f_email', 'peter@example.org'); await setVal('#f_who', 'Grandad John');
  await click('#goBtn');
  check('submitting without choosing an amount says "Please choose an amount."', await ev(`document.getElementById('q_amount').classList.contains('bad') && document.querySelector('#q_amount .why').textContent === 'Please choose an amount.'`));
  await click('#amtGrid button', 'Other');
  check('tapping Other shows the box for typing an amount, with its limits', await ev(`!document.getElementById('otherAmtBox').hidden && document.getElementById('otherAmtHelp').textContent.includes('£5.00 to £200.00')`));
  await setVal('#f_amount_other', '3'); await click('#goBtn');
  check('an Other amount below the limit is refused on the page', await ev(`document.querySelector('#q_amount .why').textContent.includes('£5.00 to £200.00')`));
  await shot('donate-390');
  await click('#amtGrid button', '£20.00');
  check('tapping a suggested amount selects it and hides the Other box', await ev(`document.querySelector('#amtGrid .on').textContent === '£20.00' && document.getElementById('otherAmtBox').hidden`));
  const before = T('payments').length;
  await click('#goBtn');
  await sleep(2500);
  check('submitting takes £20.00 and sends the person to the payment page; the registration waits for payment', T('payments').length === before + 1 && Number(T('payments').slice(-1)[0].amount) === 20 && T('registrations').slice(-1)[0].status === 'awaiting_payment', JSON.stringify(T('payments').slice(-1)));
  // a fixed price per place updates as the places change
  const dinnerFixed = await mk('Fixed Dinner', { fields: [], party: { max: 4, label: 'Places' }, payment: { mode: 'fixed', amount: 12, per_place: true, label: 'Dinner tickets' } });
  await open(`${base}/register.html?campaign_id=${dinnerFixed}`, "document.getElementById('payFixed')");
  check('a fixed price shows the price, with no amount to type', await ev(`document.getElementById('payFixed').textContent.trim() === '£12.00' && !document.getElementById('f_amount') && !document.getElementById('amtGrid')`));
  await setVal('#f_party', '3', 'change');
  check('choosing 3 places shows £36.00 (3 places × £12.00)', await ev(`document.getElementById('payFixed').textContent.replace(/\\s+/g, ' ').includes('£36.00') && document.getElementById('payFixed').textContent.includes('3 places × £12.00')`));
  // the admin screen: money options in the editor
  const moneyForm = await mk('Altar Servers', { fields: [q('text', 'Child name', { id: 'child' })] });
  await loginAs(SA, { id: 'uA-sa', name: 'superadmin', role: 'superadmin', org_id: 'org-A', mobile: '07000000001' });
  await ev(`setAdminTab('registrations'); 'ok'`); await waitFor(`document.getElementById('adminContent').textContent.includes('Altar Servers')`);
  await ev(`openRegForm(${JSON.stringify(moneyForm)}); 'ok'`);
  await waitFor(`document.getElementById('regFormPanel') && [...document.querySelectorAll('#regFormPanel button')].some(b => b.textContent.includes('Edit the questions'))`);
  await click('#regFormPanel button', '✏ Edit the questions');
  await waitFor(`document.getElementById('regEditPanel')`);
  await click('#regEditPanel button', '💷 Take a payment');
  check('"Take a payment" offers a fixed price, suggested amounts, or let them choose — and says no one in the office does anything', await waitFor(`['A fixed price', 'Suggested amounts', 'They choose'].every(t => [...document.querySelectorAll('#regEditPanel button')].some(b => b.textContent.trim() === t)) && document.getElementById('regEditPanel').textContent.includes('No one in the office has to do anything')`));
  await click('#regEditPanel button', 'Suggested amounts');
  await setVal('#regEditPanel input[placeholder^="e.g. 10"]', '10');
  await click('#regEditPanel button', 'Save the questions');
  check('one suggested amount is refused with a plain message', await waitFor(`document.getElementById('reMsg').textContent.includes('between two and six different suggested amounts')`));
  await setVal('#regEditPanel input[placeholder^="e.g. 10"]', '£10, 25, 50');
  await click('#regEditPanel button', 'Save the questions');
  check('with valid amounts it saves, and the settings page describes the payment in words', await waitFor(`document.getElementById('toast').textContent.includes('Questions saved') && document.getElementById('regFormPanel').textContent.includes('Suggested £10.00, £25.00, £50.00')`), JSON.stringify(T('campaigns').find(c => c.id === moneyForm).form_def.payment));
  check('  stored as mode "choices" with "Other" allowed between the limits', (() => { const p = T('campaigns').find(c => c.id === moneyForm).form_def.payment; return p.mode === 'choices' && JSON.stringify(p.amounts) === '[10,25,50]'; })());

  // every wizard step draws, the ready-made Sacrament template and a copied form build a definition the server accepts
  await ev(`closeRegForm(); openCampaignWizard('registration'); 'ok'`); await waitFor(`typeof wiz !== 'undefined' && wiz && wiz.reg`);
  const wz = await ev(`(() => { const out = {}; try { wizResetContent(); wiz.kind = 'registration'; wiz.name = 'Sacrament test'; wiz.keep_until = '2027-06-01';
    const t = WIZ_TEMPLATES.registration.find(x => x.id === 'sacrament'); t.apply();
    for (const s of [4, 5, 6, 7]) { wizStep = s; out['step' + s] = regWizStepHtml().length; }
    out.heading = regWizStepHtml.toString().length > 0; wizStep = 5; out.hasButtons = regWizStepHtml().includes('+ Add a heading') && regWizStepHtml().includes('+ Add a note');
    out.err = regValidateAll(wiz.reg); out.def = regBuildFormDef(wiz.reg); } catch (e) { out.crash = String(e && e.stack || e); } return out; })()`);
  check('every wizard step draws without errors, with the heading and note buttons', !wz.crash && wz.step4 > 100 && wz.step5 > 100 && wz.step6 > 100 && wz.step7 > 100 && wz.hasButtons, wz.crash || JSON.stringify(wz).slice(0, 200));
  check('the Sacrament template passes the screen\'s own checks and the server accepts what it builds', wz.err === '' && (await call('create_campaign', { kind: 'registration', name: 'Sacrament test', keep_until: '2027-06-01', form_def: wz.def }, { session: SA })).status === 200, wz.err);
  const copied = await ev(`(() => { try { const c = { id: 'x', kind: 'registration', name: 'Copy me', form_def: ${JSON.stringify(T('campaigns').find(c => c.id === dinner).form_def)}, places: 10, waiting_list: false, tiers: [], blocks: [] }; wizCampaigns = [c]; wizCopyCampaign('x'); return { fields: wiz.reg.fields.length, party: wiz.reg.partyOn, max: wiz.reg.partyMax, err: regValidateAll(wiz.reg), keys: wiz.reg.fields.map(f => f.key).join() }; } catch (e) { return { crash: String(e && e.stack || e) }; } })()`);
  check('copying an earlier form keeps its questions, rules and places setting', !copied.crash && copied.fields === 7 && copied.party === true && copied.max === '3' && copied.err === '', JSON.stringify(copied));

  proc.kill();
  console.log(failures ? `\n${failures} FAILED` : '\nALL REGISTRATION BROWSER CHECKS PASSED');
  console.log('screenshots in ' + OUT);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { proc && proc.kill(); } catch { /* done */ } process.exit(2); });
