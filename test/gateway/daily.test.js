// Parish Gateway: the WhatsApp channel button and the "Today in the Church" card (feast of the day + Mass readings links).
// Run with:  node --test "test/gateway/*.test.js"   (no network: the liturgical calendar is replaced by a stand-in)
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

let S, calls;
const CAL = {   // what the calendar service answers, by date
  '2026-11-09': { date: '2026-11-09', season: 'ordinary', season_week: 32, weekday: 'monday', celebrations: [{ title: 'Dedication of the Lateran basilica', colour: 'white', rank: 'feast', rank_num: 2.7 }] },
  '2026-11-10': { date: '2026-11-10', season: 'ordinary', season_week: 32, weekday: 'tuesday', celebrations: [{ title: 'Saint Leo the Great, pope and doctor', colour: 'white', rank: 'memorial', rank_num: 3.1 }] },
  '2026-11-20': { date: '2026-11-20', season: 'ordinary', season_week: 33, weekday: 'friday', celebrations: [{ title: 'Friday, 33rd week in Ordinary Time', colour: 'green', rank: 'ferial', rank_num: 3.13 }] },
  '2026-12-08': { date: '2026-12-08', season: 'advent', season_week: 2, weekday: 'tuesday', celebrations: [{ title: 'Immaculate Conception of the Blessed Virgin Mary', colour: 'white', rank: 'solemnity', rank_num: 1.3 }] },
};
let mode;   // 'ok' | 'down' | 'junk' | 'slow'
function installCalendar() {
  calls = [];
  mode = 'ok';
  global.fetch = async (url) => {
    calls.push(String(url));
    if (mode === 'down') throw new Error('connection refused');
    if (mode === 'junk') return { ok: true, json: async () => ({ celebrations: [{ title: '<script>alert(1)</script>'.repeat(20), colour: 'pink' }], date: 'x' }) };
    const m = /general-en\/(\d+)\/(\d+)\/(\d+)$/.exec(String(url));
    const key = m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : '';
    const body = CAL[key];
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => body };
  };
}
const reset = (day = '2026-11-09') => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set(day + 'T12:00:00Z');
  const org = (o) => db.T('organizations').push({ gateway_enabled: true, timezone: 'Europe/London', display_name: null, gateway_phone: null, gateway_hours: null, address: null, contact_email: null, ...o });
  org({ id: 'org-A', name: 'St Vincent', slug: 'svp-osterley' });
  org({ id: 'org-B', name: 'Other', slug: 'other-parish' });
  S = { saA: addUser('uA-sa', 'superadmin', 'org-A'), adA: addUser('uA-ad', 'admin', 'org-A'), seA: addUser('uA-se', 'seller', 'org-A'), saB: addUser('uB-sa', 'superadmin', 'org-B') };
  installCalendar();
};
const pub = (slug = 'svp-osterley') => call('public_gateway', { slug });
const orgA = () => db.T('organizations').find(o => o.id === 'org-A');
// the stand-in calendar's answers are remembered per date for hours; moving the clock a day on forgets them
let n = 0;
const freshDay = () => { n++; const d = new Date(Date.UTC(2027, 0, 1 + n)).toISOString().slice(0, 10); CAL[d] = { date: d, season: 'ordinary', celebrations: [{ title: 'Day ' + d, colour: 'green', rank: 'ferial' }] }; return d; };

test('Today in the Church', async (t) => {
  await t.test('names the day, with rank, season and colour, and links to the readings and to the saints of the day', async () => {
    reset('2026-11-09');
    const r = await pub();
    assert.equal(r.status, 200);
    const d = r.body.daily;
    assert.equal(d.date, '2026-11-09');
    assert.deepEqual(d.celebration, { title: 'Dedication of the Lateran basilica', rank: 'Feast', season: 'Ordinary Time', colour: 'white' });
    assert.equal(d.readings_url, 'https://universalis.com/europe.england.westminster/20261109/mass.htm');
    assert.equal(d.about_url, 'https://www.vaticannews.va/en/saints/11/09.html');
  });

  await t.test('a saint\'s memorial, an ordinary weekday and a solemnity read correctly', async () => {
    reset('2026-11-10');
    assert.deepEqual((await pub()).body.daily.celebration, { title: 'Saint Leo the Great, pope and doctor', rank: 'Memorial', season: 'Ordinary Time', colour: 'white' });
    reset('2026-11-20');
    assert.deepEqual((await pub()).body.daily.celebration, { title: 'Friday, 33rd week in Ordinary Time', rank: '', season: 'Ordinary Time', colour: 'green' });
    reset('2026-12-08');
    const c = (await pub()).body.daily.celebration;
    assert.equal(c.rank, 'Solemnity'); assert.equal(c.season, 'Advent');
  });

  await t.test('it asks the calendar once, not once per visitor', async () => {
    const day = freshDay();
    reset(day); CAL[day] = CAL[day] || { date: day, season: 'ordinary', celebrations: [{ title: 'x', colour: 'green', rank: 'ferial' }] };
    calls.length = 0;
    await pub(); await pub(); await pub();
    assert.equal(calls.length, 1);
  });

  await t.test('the day is the organisation\'s own date (a parish in New Zealand is already on tomorrow)', async () => {
    reset('2026-11-09');
    db.T('organizations').push({ id: 'org-NZ', name: 'Auckland', slug: 'auckland', gateway_enabled: true, timezone: 'Pacific/Auckland', gateway_phone: null, gateway_hours: null });
    clock.set('2026-11-09T20:00:00Z');   // 9am on the 10th in Auckland
    const r = await pub('auckland');
    assert.equal(r.body.daily.date, '2026-11-10');
    assert.match(r.body.daily.readings_url, /20261110/);
    assert.equal(r.body.daily.celebration.title, 'Saint Leo the Great, pope and doctor');
  });

  await t.test('if the calendar is down the page still works and still links to the readings, then recovers', async () => {
    const day = freshDay();
    reset(day);
    mode = 'down';
    const r = await pub();
    assert.equal(r.status, 200);
    assert.equal(r.body.daily.celebration, null);
    assert.ok(r.body.daily.readings_url.includes(day.replace(/-/g, '')));
    assert.ok(r.body.sections);   // the rest of the page is untouched
    mode = 'ok';
    assert.equal((await pub()).body.daily.celebration, null, 'a failure is remembered briefly, so a broken service is not hammered');
    clock.set(day + 'T12:03:00Z');
    assert.match((await pub()).body.daily.celebration.title, /^Day /);
  });

  await t.test('nonsense from the calendar is never shown: wrong date, over-long text or an unknown colour', async () => {
    const day = freshDay();
    reset(day);
    mode = 'junk';
    const r = await pub();
    assert.equal(r.status, 200);
    assert.equal(r.body.daily.celebration, null);
    assert.equal(r.raw.includes('<script>'), false);
  });

  await t.test('an unknown date from the calendar (404) just leaves the name out', async () => {
    reset('2031-03-03');
    assert.equal((await pub()).body.daily.celebration, null);
  });

  await t.test('the card can be switched off, and then nothing is looked up at all', async () => {
    const day = freshDay();
    reset(day);
    orgA().gateway_daily = false;
    calls.length = 0;
    const r = await pub();
    assert.equal(r.body.daily, null);
    assert.equal(calls.length, 0);
  });

  await t.test('another organisation\'s settings never leak: B has it on, A has it off', async () => {
    const day = freshDay();
    reset(day);
    orgA().gateway_daily = false;
    assert.equal((await pub('svp-osterley')).body.daily, null);
    assert.ok((await pub('other-parish')).body.daily);
  });
});

test('WhatsApp channel', async (t) => {
  await t.test('nothing is shown until a link is saved', async () => {
    reset();
    assert.equal((await pub()).body.org.whatsapp, null);
  });

  await t.test('a channel link is saved, tidied (no tracking part) and shown on the public page', async () => {
    reset();
    const ok = await call('gateway_set_details', { phone: '', hours: '', whatsapp: 'https://www.whatsapp.com/channel/0029VaAbCdEf12345/?utm=1' }, { session: S.adA });
    assert.equal(ok.status, 200);
    assert.equal(orgA().gateway_whatsapp, 'https://whatsapp.com/channel/0029VaAbCdEf12345');
    assert.equal((await pub()).body.org.whatsapp, 'https://whatsapp.com/channel/0029VaAbCdEf12345');
    assert.equal((await call('gateway_get', {}, { session: S.adA })).body.org.whatsapp, 'https://whatsapp.com/channel/0029VaAbCdEf12345');
  });

  await t.test('anything that is not a WhatsApp channel link is refused, and the last good one stays', async () => {
    reset();
    await call('gateway_set_details', { phone: '', hours: '', whatsapp: 'https://whatsapp.com/channel/0029VaAbCdEf12345' }, { session: S.adA });
    for (const bad of ['https://evil.example/channel/0029VaAbCdEf12345', 'https://whatsapp.com.evil.example/channel/0029VaAbCdEf12345', 'http://whatsapp.com/channel/0029VaAbCdEf12345',
      'javascript:alert(1)', 'https://chat.whatsapp.com/ABCDEFGHIJKL', 'https://whatsapp.com/', 'https://whatsapp.com/channel/', 'https://whatsapp.com/channel/short', 'whatsapp.com/channel/0029VaAbCdEf12345', 'https://whatsapp.com/channel/0029 VaAbCdEf12345']) {
      const r = await call('gateway_set_details', { phone: '', hours: '', whatsapp: bad }, { session: S.adA });
      assert.equal(r.status, 400, bad);
    }
    assert.equal(orgA().gateway_whatsapp, 'https://whatsapp.com/channel/0029VaAbCdEf12345');
  });

  await t.test('an empty box removes it; an older screen that does not send it leaves it alone', async () => {
    reset();
    await call('gateway_set_details', { phone: '1', hours: '2', whatsapp: 'https://whatsapp.com/channel/0029VaAbCdEf12345', daily: false }, { session: S.adA });
    await call('gateway_set_details', { phone: '3', hours: '4' }, { session: S.adA });
    assert.equal(orgA().gateway_whatsapp, 'https://whatsapp.com/channel/0029VaAbCdEf12345');
    assert.equal(orgA().gateway_daily, false);
    await call('gateway_set_details', { phone: '3', hours: '4', whatsapp: '', daily: true }, { session: S.adA });
    assert.equal(orgA().gateway_whatsapp, null);
    assert.equal(orgA().gateway_daily, true);
  });

  await t.test('only the right people can change it, and only for their own organisation', async () => {
    reset();
    assert.equal((await call('gateway_set_details', { whatsapp: 'https://whatsapp.com/channel/0029VaAbCdEf12345' }, { session: S.seA })).status, 403);
    assert.equal((await call('gateway_set_details', { whatsapp: 'https://whatsapp.com/channel/0029VaAbCdEf12345' })).status >= 400, true);
    await call('gateway_set_details', { phone: '', hours: '', whatsapp: 'https://whatsapp.com/channel/0029VaAbCdEf12345' }, { session: S.saB });
    assert.equal(orgA().gateway_whatsapp == null, true);
    assert.equal(db.T('organizations').find(o => o.id === 'org-B').gateway_whatsapp, 'https://whatsapp.com/channel/0029VaAbCdEf12345');
  });
});

test('The page does not break because of the new parts', async (t) => {
  await t.test('the public answer still has every earlier part, and the new ones add no personal data', async () => {
    reset();
    const r = await pub();
    for (const k of ['org', 'links', 'announcement', 'sections', 'daily']) assert.ok(k in r.body, k);
    assert.deepEqual(Object.keys(r.body.daily).sort(), ['about_url', 'celebration', 'date', 'readings_url']);
  });
});
