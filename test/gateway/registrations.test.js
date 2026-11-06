// Registrations 2: pick-several, notes and headings, "Other, please type", questions that show only for some answers,
// several places in one registration, and the counts / printable list for the office.
// Run with:  node --test "test/gateway/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, clock, call, addUser } = require('./harness');

const T = db.T;
let SA, FI, AD;
const reset = () => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  clock.set('2026-11-02T12:00:00Z');
  T('organizations').push({ id: 'org-A', name: 'Test Parish', gateway_enabled: false, timezone: 'Europe/London' });
  T('organizations').push({ id: 'org-B', name: 'Other Parish', gateway_enabled: false, timezone: 'Europe/London' });
  SA = addUser('u-sa', 'superadmin', 'org-A'); FI = addUser('u-fi', 'finance', 'org-A'); AD = addUser('u-ad', 'admin', 'org-A');
  for (const u of T('users')) u.confidentiality_version = 1;
};
const make = async (form_def, extra = {}) => {
  const r = await call('create_campaign', { kind: 'registration', name: 'Test Form', keep_until: '2027-06-01', form_def, ...extra }, { session: SA });
  assert.equal(r.status, 200, r.raw);
  return r.body.campaign.id;
};
const reg = (campaign_id, body = {}) => call('public_register', { campaign_id, name: 'Pat Smith', email: 'pat@example.org', agreements: {}, ...body });
const q = (type, label, o = {}) => ({ type, label, ...o });

test('the new kinds of question are accepted and tidied', async (t) => {
  await t.test('a form with tick boxes, a heading, a note and "Other" saves, and the new fields survive', async () => {
    reset();
    const id = await make({ fields: [
      q('heading', 'About the child'), q('note', 'Rehearsals are on Saturdays.'),
      q('multichoice', 'Which roles?', { options: ['Angel', 'Shepherd', 'Narrator'], allow_other: true, max_choices: 2 }),
    ] });
    const f = T('campaigns').find(c => c.id === id).form_def.fields;
    assert.deepEqual(f.map(x => x.type), ['heading', 'note', 'multichoice']);
    assert.equal(f[2].allow_other, true); assert.equal(f[2].max_choices, 2);
    assert.equal(f[0].required, false); assert.equal(f[1].label, 'Rehearsals are on Saturdays.');
  });
  await t.test('bad definitions are refused with a plain reason', async () => {
    reset();
    const bad = async (fields, re) => { const r = await call('create_campaign', { kind: 'registration', name: 'X', keep_until: '2027-06-01', form_def: { fields } }, { session: SA }); assert.equal(r.status, 400, r.raw); assert.match(r.body.error, re); };
    await bad([q('multichoice', 'Pick', { options: ['One'] })], /at least two/);
    await bad([q('multichoice', 'Pick', { options: ['One', 'one'] })], /same/);
    await bad([q('dropdown', 'Pick', { options: ['A', 'Other'], allow_other: true })], /"Other" is added for you/);
    await bad([q('multichoice', 'Pick', { options: ['A', 'B'], max_choices: 3 })], /from 1 to 2/);
    await bad([q('note', '')], /needs its text/);
    await bad([q('yesno', 'Later', { show_if: { field: 'q1', values: ['yes'] } })], /earlier question that has choices/);   // depends on itself / nothing before
    await bad([q('text', 'Name?'), q('text', 'Dependent', { show_if: { field: 'q1', values: ['x'] } })], /earlier question that has choices/);   // a text question cannot be depended on
    await bad([q('yesno', 'Come?', { id: 'come' }), q('text', 'Why not?', { show_if: { field: 'come', values: ['maybe'] } })], /choose which answers/);
    await bad([q('text', 'A', { show_if: { field: 'later', values: ['yes'] } }), q('yesno', 'Later', { id: 'later' })], /earlier question/);   // only an EARLIER question
    const tooMany = await call('create_campaign', { kind: 'registration', name: 'X', keep_until: '2027-06-01', form_def: { fields: [], party: { max: 50 } } }, { session: SA });
    assert.equal(tooMany.status, 400); assert.match(tooMany.body.error, /from 2 to 10/);
  });
});

test('pick several, and "Other, please type"', async (t) => {
  let id;
  const setup = async () => { reset(); id = await make({ contact_mode: 'either', fields: [
    q('multichoice', 'Which Masses?', { id: 'm', required: true, options: ['Sat 6pm', 'Sun 9am', 'Sun 11am'], max_choices: 2, allow_other: true }),
    q('dropdown', 'How did you hear?', { id: 'h', options: ['Newsletter', 'Friend'], allow_other: true }),
  ] }); };
  await t.test('several choices are stored, with "Other" spelled out', async () => {
    await setup();
    const r = await reg(id, { answers: { m: ['Sat 6pm', 'Other'], h: 'Other' }, others: { m: 'Weekday evening', h: 'Poster at the school' } });
    assert.equal(r.status, 200, r.raw);
    const row = T('registrations')[0];
    const m = row.answers.find(a => a.id === 'm'), h = row.answers.find(a => a.id === 'h');
    assert.deepEqual(m.value, ['Sat 6pm', 'Other: Weekday evening']); assert.deepEqual(m.choices, ['Sat 6pm', 'Other']);
    assert.equal(h.value, 'Other: Poster at the school'); assert.deepEqual(h.choices, ['Other']);
  });
  await t.test('too many, an unknown choice, "Other" with no text, and a blank required answer are all refused', async () => {
    await setup();
    const msg = async (body) => { const r = await reg(id, body); assert.equal(r.status, 400, r.raw); return r.body.error; };
    assert.match(await msg({ answers: { m: ['Sat 6pm', 'Sun 9am', 'Sun 11am'] } }), /no more than 2/);
    assert.match(await msg({ answers: { m: ['Midnight'] } }), /choose from the options/);
    assert.match(await msg({ answers: { m: ['Other'] } }), /type your answer/);
    assert.match(await msg({ answers: { m: [] } }), /Please answer: Which Masses/);
    assert.match(await msg({ answers: { m: ['Sat 6pm'], h: ['Newsletter', 'Friend'] } }), /just one/);
    assert.equal(T('registrations').length, 0, 'nothing was saved by any refused attempt');
  });
  await t.test('"Other" is refused when the question does not allow it', async () => {
    reset(); const id2 = await make({ fields: [q('dropdown', 'Pick', { id: 'p', options: ['A', 'B'] })] });
    const r = await reg(id2, { answers: { p: 'Other' }, others: { p: 'x' } }); assert.equal(r.status, 400);
  });
});

test('questions that show only for some answers', async (t) => {
  let id;
  const setup = async () => { reset(); id = await make({ fields: [
    q('yesno', 'Do you need a lift?', { id: 'lift', required: true }),
    q('text', 'Pick-up address', { id: 'addr', required: true, show_if: { field: 'lift', values: ['yes'] } }),
    q('dropdown', 'Stage', { id: 'stage', required: true, options: ['Baptised', 'Communion', 'Confirmed'] }),
    q('text', 'Confirmation date', { id: 'cdate', required: true, show_if: { field: 'stage', op: 'is', values: ['Confirmed'] } }),
    q('text', 'Not yet confirmed? Tell us why', { id: 'why', show_if: { field: 'stage', op: 'is_not', values: ['Confirmed'] } }),
    q('dropdown', 'Only for the confirmed', { id: 'deep', required: true, options: ['a', 'b'], show_if: { field: 'stage', values: ['Confirmed'] } }),
  ] }); };
  await t.test('a hidden required question is not required, and what was typed into it is not stored', async () => {
    await setup();
    const r = await reg(id, { answers: { lift: 'no', addr: 'sneaky', stage: 'Baptised' } });
    assert.equal(r.status, 200, r.raw);
    const ids = T('registrations')[0].answers.map(a => a.id);
    assert.deepEqual(ids, ['lift', 'stage', 'why'], 'addr, cdate and deep were not showing, so they are not kept; "why" shows because the stage is not Confirmed');
  });
  await t.test('when it shows, it is required again', async () => {
    await setup();
    const r = await reg(id, { answers: { lift: 'yes', stage: 'Baptised' } });
    assert.equal(r.status, 400); assert.match(r.body.error, /Pick-up address/);
    const r2 = await reg(id, { answers: { lift: 'yes', addr: '1 High St', stage: 'Confirmed', cdate: 'May 2025', deep: 'a' } });
    assert.equal(r2.status, 200, r2.raw);
    assert.deepEqual(T('registrations')[0].answers.map(a => a.id), ['lift', 'addr', 'stage', 'cdate', 'deep']);
  });
  await t.test('a question that depends on a hidden one stays hidden', async () => {
    reset();
    const id3 = await make({ fields: [
      q('yesno', 'A?', { id: 'a' }), q('dropdown', 'B', { id: 'b', options: ['x', 'y'], show_if: { field: 'a', values: ['yes'] } }),
      q('text', 'C (needs B = x)', { id: 'c', required: true, show_if: { field: 'b', op: 'is_not', values: ['x'] } }),
    ] });
    const r = await reg(id3, { answers: { a: 'no' } });   // A=no hides B; so C (is-not-x) must stay hidden too, not appear because B is "not x"
    assert.equal(r.status, 200, r.raw);
  });
  await t.test('a condition on tick boxes matches if any of the listed choices was ticked', async () => {
    reset();
    const id4 = await make({ fields: [
      q('multichoice', 'Roles', { id: 'r', options: ['Angel', 'Shepherd', 'King'], required: true }),
      q('text', 'Costume size', { id: 'size', required: true, show_if: { field: 'r', values: ['Angel', 'King'] } }),
    ] });
    assert.equal((await reg(id4, { answers: { r: ['Shepherd'] } })).status, 200);
    const r = await reg(id4, { answers: { r: ['Shepherd', 'King'] } }); assert.equal(r.status, 400); assert.match(r.body.error, /Costume size/);
  });
});

test('several places in one registration', async (t) => {
  let id;
  const setup = async (places = 10, extra = {}) => { reset(); id = await make({ fields: [], party: { max: 3, label: 'Places for you and guests' } }, { places, ...extra }); };
  const used = () => call('public_registration_info', { campaign_id: id });
  await t.test('the form says how many places can be booked, and counts them', async () => {
    await setup(10);
    assert.deepEqual((await used()).body.form.party, { max: 3, label: 'Places for you and guests' });
    assert.equal((await reg(id, { party: 3 })).status, 200);
    assert.equal(T('registrations')[0].party_size, 3);
    assert.equal((await used()).body.places_left, 7);
    assert.equal((await reg(id)).status, 200);   // no party sent: one place
    assert.equal((await used()).body.places_left, 6);
  });
  await t.test('too many for what is left is refused with the number left; exactly enough works; then it is full', async () => {
    await setup(4);
    assert.equal((await reg(id, { party: 3 })).status, 200);   // 3 of 4
    const r = await reg(id, { party: 2 });
    assert.equal(r.status, 409); assert.match(r.body.error, /only 1 place is left/);
    assert.equal((await reg(id, { party: 1 })).status, 200);
    const full = await reg(id, { party: 1 }); assert.equal(full.status, 409); assert.match(full.body.error, /fully booked/);
    assert.equal(T('registrations').length, 2);
  });
  await t.test('0, 4 (above the form\'s maximum) and 1.5 places are refused', async () => {
    await setup(10);
    for (const p of [0, 4, 1.5, 'lots']) { const r = await reg(id, { party: p }); assert.equal(r.status, 400, `party ${p}: ${r.raw}`); }
    assert.equal(T('registrations').length, 0);
  });
  await t.test('declining or cancelling gives all of the places back', async () => {
    await setup(4);
    const r = await reg(id, { party: 3 });
    const rid = r.body.registration_id;
    const d = await call('registration_decide', { registration_id: rid, decision: 'declined', note: 'Sorry' }, { session: SA }); assert.equal(d.status, 200, d.raw);
    assert.equal((await used()).body.places_left, 4);
  });
  await t.test('a form without the places question ignores a party number and takes one place', async () => {
    reset(); const id2 = await make({ fields: [] }, { places: 5 });
    assert.equal((await reg(id2, { party: 3 })).status, 200);
    assert.equal(T('registrations')[0].party_size, 1);
  });
  await t.test('the staff list and the single view show the places; the limit cannot be set below the places taken', async () => {
    await setup(10);
    const r = await reg(id, { party: 3 });
    const list = await call('registration_list', { campaign_id: id }, { session: SA });
    assert.equal(list.body.registrations[0].party_size, 3);
    const one = await call('registration_get', { registration_id: r.body.registration_id }, { session: SA });
    assert.equal(one.body.registration.party_size, 3);
    const lim = await call('set_registration_places', { campaign_id: id, places: 2 }, { session: SA });
    assert.equal(lim.status, 400); assert.match(lim.body.error, /3 places are already taken/);
    const forms = await call('registration_forms', {}, { session: SA });
    const f = forms.body.forms.find(x => x.id === id); assert.equal(f.total, 1); assert.equal(f.places_used, 3);
  });
});

test('counts per choice, the printable list, and the CSV', async (t) => {
  let id;
  const setup = async () => {
    reset();
    id = await make({ fields: [
      q('heading', 'Your meal'),
      q('dropdown', 'Main course', { id: 'main', required: true, options: ['Turkey', 'Nut roast'], allow_other: true }),
      q('multichoice', 'Needs', { id: 'needs', options: ['Lift', 'Wheelchair access', 'Gluten free'] }),
      q('yesno', 'Vegetarian?', { id: 'veg' }),
      q('text', 'Phone for lift', { id: 'ph', show_if: { field: 'needs', values: ['Lift'] } }),
    ], party: { max: 2, label: 'Places' } });
    await reg(id, { name: 'A One', party: 2, answers: { main: 'Turkey', needs: ['Lift', 'Gluten free'], veg: 'no', ph: '0123' } });
    await reg(id, { name: 'B Two', party: 1, answers: { main: 'Nut roast', veg: 'yes' } });
    await reg(id, { name: 'C Three', party: 1, answers: { main: 'Other', needs: ['Lift'], veg: 'yes' }, others: { main: 'Fish' } });
    const d = await reg(id, { name: 'D Cancelled', party: 2, answers: { main: 'Turkey' } });
    await call('registration_decide', { registration_id: d.body.registration_id, decision: 'cancelled', note: 'changed mind' }, { session: SA });
  };
  await t.test('counts show people and places for every option, leave out cancelled ones, and count blanks', async () => {
    await setup();
    const r = await call('registration_table', { campaign_id: id }, { session: SA });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.people, 3); assert.equal(r.body.places, 4);
    const by = (qid) => r.body.counts.find(c => c.id === qid);
    assert.deepEqual(by('main').options, [{ option: 'Turkey', people: 1, places: 2 }, { option: 'Nut roast', people: 1, places: 1 }, { option: 'Other', people: 1, places: 1 }]);
    assert.deepEqual(by('needs').options, [{ option: 'Lift', people: 2, places: 3 }, { option: 'Wheelchair access', people: 0, places: 0 }, { option: 'Gluten free', people: 1, places: 2 }]);
    assert.equal(by('needs').not_answered, 1);
    assert.deepEqual(by('veg').options, [{ option: 'yes', people: 2, places: 2 }, { option: 'no', people: 1, places: 2 }].sort((a, b) => ['yes', 'no'].indexOf(a.option) - ['yes', 'no'].indexOf(b.option)));
    assert.equal(r.body.counts.length, 3, 'only choice questions are counted; the heading and the text question are not');
    assert.deepEqual(r.body.columns.map(c => c.id), ['main', 'needs', 'veg', 'ph'], 'the heading is not a column');
    assert.equal(r.body.rows.find(x => x.name === 'C Three').answers.main, 'Other: Fish');
    assert.equal(r.body.rows.find(x => x.name === 'A One').answers.needs, 'Lift; Gluten free');
    assert.ok(!r.body.rows.some(x => x.name === 'D Cancelled'));
  });
  await t.test('the CSV has a Places column, no heading column, and joins several choices', async () => {
    await setup();
    const r = await call('registrations_export', { campaign_id: id }, { session: SA });
    assert.equal(r.status, 200, r.raw);
    const lines = r.body.csv.split('\n');
    assert.match(lines[0], /Registration,Registered at,Name,Mobile,Email,Places,Main course,Needs,Vegetarian\?,Phone for lift,/);
    assert.ok(!/Your meal/.test(lines[0]));
    assert.match(lines[1], /A One/); assert.match(lines[1], /Lift; Gluten free/);
  });
  await t.test('only SuperAdmin, Finance and Priest may see the counts; Admin and another organisation get nothing', async () => {
    await setup();
    assert.equal((await call('registration_table', { campaign_id: id }, { session: FI })).status, 200);
    assert.equal((await call('registration_table', { campaign_id: id }, { session: AD })).status, 403);
    const other = addUser('u-sa-b', 'superadmin', 'org-B'); T('users').find(u => u.id === 'u-sa-b').confidentiality_version = 1;
    assert.equal((await call('registration_table', { campaign_id: id }, { session: other })).status, 404);
    const noStatement = addUser('u-new', 'finance', 'org-A');
    const r = await call('registration_table', { campaign_id: id }, { session: noStatement }); assert.equal(r.status, 403);
  });
});

test('answers given before this update (single dropdown, plain text) still count and still export', async () => {
  reset();
  const id = await make({ fields: [q('dropdown', 'Main', { id: 'main', options: ['Turkey', 'Nut roast'] })] });
  T('registrations').push({ id: 'old1', campaign_id: id, reg_number: 1, name: 'Old Reg', status: 'submitted', answers: [{ id: 'main', label: 'Main', type: 'dropdown', value: 'Turkey', sensitive: false }], agreements: [] });
  const r = await call('registration_table', { campaign_id: id }, { session: SA });
  assert.deepEqual(r.body.counts[0].options, [{ option: 'Turkey', people: 1, places: 1 }, { option: 'Nut roast', people: 0, places: 0 }]);
  assert.equal(r.body.places, 1);
});

test('editing the questions: free before anyone registers, safe changes only afterwards', async (t) => {
  let id;
  const base = () => ({ intro: 'Hello', contact_mode: 'either', approval: false, fields: [
    q('text', 'Child name', { id: 'child', required: true }),
    q('dropdown', 'Stage', { id: 'stage', options: ['Baptised', 'Communion'] }),
  ] });
  const save = (def) => call('set_registration_form', { campaign_id: id, form_def: def }, { session: SA });
  const setup = async () => { reset(); id = await make(base()); };
  await t.test('before anyone registers anything can be changed', async () => {
    await setup();
    const r = await save({ ...base(), fields: [q('heading', 'New'), q('yesno', 'Only one', { id: 'one' })] });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(T('campaigns').find(c => c.id === id).form_def.fields.map(f => f.id), ['q1', 'one']);
  });
  await t.test('after people register: rewording, a new option, a note and a new optional question are fine', async () => {
    await setup(); await reg(id, { answers: { child: 'Tom', stage: 'Baptised' } });
    const d = base(); d.intro = 'Updated intro';
    d.fields[0].label = 'Child\'s full name'; d.fields[1].options.push('Confirmed');
    d.fields.splice(1, 0, q('note', 'Please read this'));
    d.fields.push(q('text', 'Allergies', { id: 'allergy' }));
    const r = await save(d); assert.equal(r.status, 200, r.raw);
    const f = T('campaigns').find(c => c.id === id).form_def.fields;
    assert.deepEqual(f.map(x => x.id), ['child', 'q2', 'stage', 'allergy']);
    assert.equal(T('registrations')[0].answers[0].label, 'Child name', 'the person\'s own record keeps the words they were asked');
  });
  await t.test('after people register: removing, re-ordering, re-typing, taking an option away and a new REQUIRED question are refused', async () => {
    await setup(); await reg(id, { answers: { child: 'Tom' } });
    const refuse = async (mut, re) => { const d = base(); mut(d); const r = await save(d); assert.equal(r.status, 409, r.raw); assert.match(r.body.error, re); };
    await refuse(d => d.fields.pop(), /can't be removed/);
    await refuse(d => d.fields.reverse(), /different order/);
    await refuse(d => { d.fields[0].type = 'longtext'; }, /different kind/);
    await refuse(d => { d.fields[1].options = ['Baptised', 'Other thing']; }, /can't be taken away/);
    await refuse(d => d.fields.push(q('text', 'Must answer', { id: 'must', required: true })), /has to be optional/);
    await refuse(d => { d.fields[0].required = false; }, /required and optional/);
    await refuse(d => { d.agreements = [{ text: 'I agree' }]; }, /agreements/);
    await refuse(d => { d.approval = true; }, /approval/);
    await refuse(d => { d.payment = { min: 5, max: 20 }; }, /payment/);
    await refuse(d => { d.party = { max: 3 }; }, /places question/);
  });
  await t.test('the form of another organisation, or by a seller, cannot be edited', async () => {
    await setup();
    const other = addUser('u-sa-b', 'superadmin', 'org-B');
    assert.equal((await call('set_registration_form', { campaign_id: id, form_def: base() }, { session: other })).status, 404);
    const se = addUser('u-se', 'seller', 'org-A');
    assert.equal((await call('set_registration_form', { campaign_id: id, form_def: base() }, { session: se })).status, 403);
  });
});
