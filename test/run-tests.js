'use strict';

/**
 * End-to-end tests for Phase 1 — User Master, Station Master, Recipe/Yield DB.
 *
 * Runs the real Express app against a throwaway SQLite file, over real HTTP,
 * with real cookie-based sessions. No mocks.
 *
 *   npm test
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kitchops-test-')), 'test.db');
process.env.KITCHOPS_DB = DB;
process.env.KITCHOPS_JWT_SECRET = 'test-secret-not-used-in-production';
process.env.KITCHOPS_ADMIN_USER = 'testadmin';
process.env.KITCHOPS_ADMIN_PASS = 'testadmin123';

const { migrate } = require('../server/db/migrate');
const { createApp } = require('../server/index');
const yieldSvc = require('../server/services/yield.service');
const rules = require('../server/services/recipe-rules.service');

// ---------------------------------------------------------------- harness
let passed = 0;
let failed = 0;
const failures = [];
let group = '';

function section(name) { group = name; console.log(`\n\x1b[1m${name}\x1b[0m`); }

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${group} → ${name}: ${err.message}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${group} → ${name}: ${err.message}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
  }
}

function assert(cond, message) { if (!cond) throw new Error(message); }
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ------------------------------------------------------------ http client
let baseUrl;

function client() {
  let cookie = null;
  async function call(method, url, body) {
    const opts = { method, headers: {} };
    if (cookie) opts.headers.cookie = cookie;
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(baseUrl + url, opts);
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const c of setCookie) {
      if (c.startsWith('kitchops_token=')) cookie = c.split(';')[0];
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { status: res.status, data };
  }
  return {
    get: (u) => call('GET', u),
    post: (u, b) => call('POST', u, b ?? {}),
    put: (u, b) => call('PUT', u, b ?? {}),
    patch: (u, b) => call('PATCH', u, b ?? {}),
    del: (u) => call('DELETE', u),
    async login(username, password) {
      const r = await call('POST', '/api/auth/login', { username, password });
      assert(r.status === 200, `login failed for ${username}: ${r.data.error}`);
      return r.data.user;
    },
  };
}

// ================================================================== TESTS
async function main() {
  migrate({ silent: true });
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const admin = client();
  await admin.login('testadmin', 'testadmin123');

  // ------------------------------------------------------------ pure yield
  section('Yield calculation service (v10.2 Rule 11)');

  check('79% of 1000 -> 1266 raw (not 1000/79)', () => {
    const r = yieldSvc.calculateRawQuantity(1000, 79);
    equal(r.rawQuantity, 1266, 'raw quantity');
    assert(Math.abs(r.rawQuantity - 1000 / 79) > 1000, 'must not divide by the raw percentage');
  });

  check('percentage converts to its decimal fraction', () => {
    equal(yieldSvc.toDecimalFraction(79), 0.79, 'fraction');
    equal(yieldSvc.toDecimalFraction(100), 1, 'fraction at 100%');
  });

  check('every worked example in the document reproduces exactly', () => {
    const cases = [
      [500, 88, 568], [1000, 78, 1282], [100, 87, 115],
      [1000, 79, 1266], [200, 95, 211], [100, 70, 143],
      [300, 82, 366], [100, 45, 222],
    ];
    for (const [net, y, expected] of cases) {
      equal(yieldSvc.calculateRawQuantity(net, y).rawQuantity, expected, `${net} @ ${y}%`);
    }
  });

  check('rounds half away from zero (200/0.95 = 210.5 -> 211)', () => {
    equal(yieldSvc.roundQuantity(210.5), 211, 'half-up rounding');
  });

  check('missing yield throws instead of assuming 100%', () => {
    let threw = false;
    try { yieldSvc.calculateRawQuantity(1000, null, { itemName: 'Potato' }); }
    catch (e) { threw = true; equal(e.message, 'Yield % missing for Potato.', 'documented message'); }
    assert(threw, 'a missing yield must throw');
  });

  check('yield outside 0–100 is rejected', () => {
    for (const bad of [0, -5, 101]) {
      let threw = false;
      try { yieldSvc.calculateRawQuantity(100, bad); } catch { threw = true; }
      assert(threw, `yield ${bad} must be rejected`);
    }
  });

  check('MACHINE = Blue and MANUAL = Orange', () => {
    equal(rules.colourForMethod('MACHINE').colourName, 'Blue', 'machine colour');
    equal(rules.colourForMethod('MANUAL').colourName, 'Orange', 'manual colour');
  });

  // -------------------------------------------------------- station master
  section('Station Master — configurable, not hardcoded');

  let peeling; let cutting; let juice; let storage; let packing;
  await checkAsync('create stations of every type', async () => {
    const mk = async (name, type, label, sort) => {
      const r = await admin.post('/api/stations', { name, type_code: type, sheet_label: label, sort_order: sort });
      assert(r.status === 201, `create ${name}: ${r.data.error}`);
      return r.data.station;
    };
    peeling = await mk('Peeling Counter', 'PEELING', 'A', 1);
    cutting = await mk('Vegetable Cutting', 'CUTTING', 'B', 2);
    juice = await mk('Juice Counter', 'PREP', 'C', 3);
    storage = await mk('Dry Store Counter', 'STORAGE', 'D', 4);
    packing = await mk('Packing Counter', 'PACKING', 'E', 5);
    equal(cutting.requires_cut_method, 1, 'cutting type requires a cut method');
    equal(peeling.feeds_into_type, 'CUTTING', 'peeling feeds into cutting');
  });

  await checkAsync('duplicate station name is rejected', async () => {
    const r = await admin.post('/api/stations', { name: 'Peeling Counter', type_code: 'PEELING' });
    equal(r.status, 409, 'duplicate name status');
  });

  await checkAsync('station appears in the shared bootstrap dropdown source', async () => {
    const r = await admin.get('/api/meta/bootstrap');
    assert(r.data.stations.some((s) => s.name === 'Vegetable Cutting'), 'station missing from bootstrap');
  });

  // ------------------------------------------------------ location master
  section('Location Master');

  const locations = [];
  await checkAsync('create three locations', async () => {
    for (const name of ['Location Alpha', 'Location Beta', 'Location Gamma']) {
      const r = await admin.post('/api/locations', { name });
      assert(r.status === 201, `create ${name}: ${r.data.error}`);
      locations.push(r.data.location);
    }
    equal(locations.length, 3, 'locations created');
  });

  // ------------------------------------------------------------ user master
  section('User Master');

  let managerUser; const counters = [];
  await checkAsync('create a Location Manager with a location assignment', async () => {
    const r = await admin.post('/api/users', {
      full_name: 'Manager One', username: 'manager.one', role_code: 'LOCATION_MANAGER',
      password: 'manager123', location_ids: [locations[0].id],
    });
    assert(r.status === 201, `create manager: ${r.data.error}`);
    managerUser = r.data.user;
    equal(managerUser.locations.length, 1, 'location assigned');
    equal(managerUser.stations.length, 0, 'manager holds no station');
  });

  await checkAsync('Location Manager without a location is rejected', async () => {
    const r = await admin.post('/api/users', {
      full_name: 'No Location', username: 'no.location', role_code: 'LOCATION_MANAGER', password: 'secret123',
    });
    equal(r.status, 400, 'must require a location');
  });

  await checkAsync('assign THREE counter persons to one station (1..N, no fixed slots)', async () => {
    for (const name of ['Counter One', 'Counter Two', 'Counter Three']) {
      const r = await admin.post('/api/users', {
        full_name: name, username: name.toLowerCase().replace(' ', '.'),
        role_code: 'COUNTER_PERSON', password: 'counter123',
        station_ids: [cutting.id], effective_from: new Date().toISOString().slice(0, 10),
      });
      assert(r.status === 201, `create ${name}: ${r.data.error}`);
      counters.push(r.data.user);
    }
    const roster = await admin.get(`/api/roster/stations/${cutting.id}/roster`);
    equal(roster.data.roster.length, 3, 'three persons on one station');
    equal(roster.data.availableCount, 3, 'all three available');
  });

  await checkAsync('a counter person may cover more than one station', async () => {
    const r = await admin.put(`/api/users/${counters[2].id}`, {
      full_name: 'Counter Three', username: 'counter.three', role_code: 'COUNTER_PERSON',
      station_ids: [cutting.id, peeling.id], effective_from: new Date().toISOString().slice(0, 10),
    });
    assert(r.status === 200, `update: ${r.data.error}`);
    equal(r.data.user.stations.length, 2, 'two stations held');
  });

  await checkAsync('designation and additional responsibility round-trip', async () => {
    const r = await admin.post('/api/users', {
      full_name: 'Line Cook With Extra Duty', username: 'extra.duty', role_code: 'COUNTER_PERSON',
      password: 'counter123', designation: 'Line Cook',
      additional_responsibility: 'Hygiene Head',
    });
    assert(r.status === 201, `create: ${r.data.error}`);
    equal(r.data.user.designation, 'Line Cook', 'designation stored');
    equal(r.data.user.additional_responsibility, 'Hygiene Head', 'additional responsibility stored');

    const edited = await admin.put(`/api/users/${r.data.user.id}`, {
      full_name: 'Line Cook With Extra Duty', username: 'extra.duty', role_code: 'COUNTER_PERSON',
      designation: 'Line Cook', additional_responsibility: 'Vegetable Receiving Head',
    });
    equal(edited.data.user.additional_responsibility, 'Vegetable Receiving Head', 'responsibility editable');

    // A person may hold an extra duty without it becoming a second station.
    equal(edited.data.user.stations.length, 0, 'an extra duty is not a station assignment');
  });

  await checkAsync('duplicate username is rejected', async () => {
    const r = await admin.post('/api/users', {
      full_name: 'Clone', username: 'counter.one', role_code: 'COUNTER_PERSON', password: 'secret123',
    });
    equal(r.status, 409, 'duplicate username status');
  });

  await checkAsync('a generated password is returned once when none is supplied', async () => {
    const r = await admin.post('/api/users', {
      full_name: 'Auto Password', username: 'auto.pw', role_code: 'COUNTER_PERSON',
    });
    assert(r.status === 201, `create: ${r.data.error}`);
    assert(typeof r.data.generatedPassword === 'string' && r.data.generatedPassword.length >= 6,
      'generated password missing');
    equal(r.data.user.must_change_password, 1, 'must change password on first sign-in');
  });

  await checkAsync('deactivate then reactivate a user', async () => {
    const target = counters[0].id;
    let r = await admin.patch(`/api/users/${target}/status`, { is_active: false });
    equal(r.data.user.statusLabel, 'INACTIVE', 'deactivated');

    const roster = await admin.get(`/api/roster/stations/${cutting.id}/roster`);
    equal(roster.data.availableCount, 2, 'inactive user drops out of the available roster');

    r = await admin.patch(`/api/users/${target}/status`, { is_active: true });
    equal(r.data.user.statusLabel, 'ACTIVE', 'reactivated');
  });

  await checkAsync('the last active Super Admin cannot be deactivated', async () => {
    const list = await admin.get('/api/users?role=SUPER_ADMIN');
    const sa = list.data.users[0];
    const r = await admin.patch(`/api/users/${sa.id}/status`, { is_active: false });
    equal(r.status, 400, 'must be blocked');
  });

  await checkAsync('a user with history cannot be deleted, only deactivated', async () => {
    const r = await admin.del(`/api/users/${counters[0].id}`);
    equal(r.status, 409, 'deletion refused');
    assert(/deactivate/i.test(r.data.error), 'error should point to deactivation');
  });

  // ----------------------------------------------------- absent vs inactive
  section('Absent Today vs permanent Inactive');

  await checkAsync('marking absent removes the person from today only', async () => {
    const r = await admin.post('/api/roster/attendance', { user_id: counters[1].id, status: 'ABSENT' });
    assert(r.status === 200, `mark absent: ${r.data.error}`);

    const roster = await admin.get(`/api/roster/stations/${cutting.id}/roster`);
    const entry = roster.data.roster.find((p) => p.userId === counters[1].id);
    equal(entry.status, 'ABSENT_TODAY', 'status is absent today');
    equal(entry.available, false, 'not available today');
  });

  await checkAsync('an absent person keeps their permanent assignment and active flag', async () => {
    const r = await admin.get(`/api/users/${counters[1].id}`);
    equal(r.data.user.is_active, 1, 'is_active untouched');
    equal(r.data.user.absentToday, true, 'flagged absent today');
    assert(r.data.user.stations.some((s) => s.id === cutting.id), 'station assignment retained');
  });

  await checkAsync('tasks redistribute to the remaining persons while someone is absent', async () => {
    const r = await admin.get(`/api/roster/stations/${cutting.id}/distribution-preview?taskCount=6`);
    equal(r.data.availablePersons, 2, 'two persons remain');
    equal(r.data.absentPersons.length, 1, 'one absent');
    equal(r.data.perPerson.length, 2, 'tasks split across the remaining two');
    equal(r.data.perPerson.reduce((n, p) => n + p.taskCount, 0), 6, 'all six tasks assigned');
    assert(!r.data.perPerson.some((p) => p.userId === counters[1].id), 'absent person receives nothing');
  });

  await checkAsync('marking present brings the person back into the distribution', async () => {
    await admin.post('/api/roster/attendance', { user_id: counters[1].id, status: 'PRESENT' });
    const r = await admin.get(`/api/roster/stations/${cutting.id}/distribution-preview?taskCount=6`);
    equal(r.data.availablePersons, 3, 'three available again');
    equal(r.data.perPerson.length, 3, 'tasks now span three people');
    assert(r.data.perPerson.some((p) => p.userId === counters[1].id), 'returning person receives tasks');
  });

  await checkAsync('a permanently inactive user cannot be marked absent', async () => {
    await admin.patch(`/api/users/${counters[0].id}/status`, { is_active: false });
    const r = await admin.post('/api/roster/attendance', { user_id: counters[0].id, status: 'ABSENT' });
    equal(r.status, 400, 'must be refused');
    await admin.patch(`/api/users/${counters[0].id}/status`, { is_active: true });
  });

  await checkAsync('a permanent staff change applies from the next day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await admin.put(`/api/roster/stations/${peeling.id}/roster`, { user_ids: [counters[0].id] });
    assert(r.status === 200, `roster update: ${r.data.error}`);
    equal(r.data.appliesFromNextDay, true, 'effective from tomorrow');
    assert(r.data.effectiveFrom > today, 'effective date is after today');

    const todayRoster = await admin.get(`/api/roster/stations/${peeling.id}/roster?date=${today}`);
    assert(!todayRoster.data.roster.some((p) => p.userId === counters[0].id),
      "today's roster must be unchanged by a permanent change");

    const future = await admin.get(`/api/roster/stations/${peeling.id}/roster?date=${r.data.effectiveFrom}`);
    assert(future.data.roster.some((p) => p.userId === counters[0].id), 'new list live from the effective date');
  });

  // ------------------------------------------------------------- recipe db
  section('Recipe DB — configuration and validation');

  const cats = await admin.get('/api/meta/item-categories');
  const vegCat = cats.data.itemCategories.find((c) => c.name === 'Vegetable');
  const juiceCat = cats.data.itemCategories.find((c) => c.name === 'Juice');
  const otherCat = cats.data.itemCategories.find((c) => c.name === 'Other');
  const cutTypes = (await admin.get('/api/meta/cut-types')).data.cutTypes;
  const cutId = (n) => cutTypes.find((c) => c.name === n).id;

  let potato; let noYield; let noPeelMethod; let noCutMethod; let wholeItem;
  let frozenItem; let batchItem; let juiceItem;

  await checkAsync('create a fully configured item with a station from Station Master', async () => {
    const r = await admin.post('/api/recipes', {
      item_name: 'Potato', station_id: cutting.id, category_id: vegCat.id, unit_code: 'GM',
      default_cut_type_id: cutId('Diced'), default_cut_method: 'MACHINE',
      needs_peeling: true, peeling_method: 'MACHINE', yield_percent: 78,
    });
    assert(r.status === 201, `create: ${r.data.error}`);
    potato = r.data.item;
    equal(r.data.ready, true, 'item should be ready');
    equal(potato.station_name, 'Vegetable Cutting', 'station resolved from Station Master');
  });

  await checkAsync('missing Yield % blocks sheet generation with the documented message', async () => {
    const r = await admin.post('/api/recipes', {
      item_name: 'No Yield Veg', station_id: cutting.id, category_id: vegCat.id, unit_code: 'GM',
      default_cut_type_id: cutId('Sliced'), default_cut_method: 'MANUAL',
    });
    noYield = r.data.item;
    equal(r.data.ready, false, 'must not be ready');
    assert(r.data.errors.some((e) => e.message === 'Yield % missing for No Yield Veg.'),
      `expected the documented message, got: ${JSON.stringify(r.data.errors)}`);
  });

  await checkAsync('missing Peeling Method blocks with the documented message', async () => {
    const r = await admin.post('/api/recipes', {
      item_name: 'Needs Peel', station_id: cutting.id, category_id: vegCat.id, unit_code: 'GM',
      default_cut_type_id: cutId('Chopped'), default_cut_method: 'MANUAL',
      yield_percent: 90, needs_peeling: true,
    });
    noPeelMethod = r.data.item;
    assert(r.data.errors.some((e) => e.message === 'Peeling Method (Machine/Manual) not defined for Needs Peel.'),
      `expected the documented message, got: ${JSON.stringify(r.data.errors)}`);
  });

  await checkAsync('missing Cut Method on a cutting-type station blocks with the documented message', async () => {
    const r = await admin.post('/api/recipes', {
      item_name: 'No Method', station_id: cutting.id, category_id: vegCat.id, unit_code: 'GM',
      default_cut_type_id: cutId('Chopped'), yield_percent: 90,
    });
    noCutMethod = r.data.item;
    assert(r.data.errors.some((e) => e.message === 'Machine/Manual not defined for No Method.'),
      `expected the documented message, got: ${JSON.stringify(r.data.errors)}`);
  });

  await checkAsync('Whole / Akhaj forces WHOLE + MANUAL and keeps the yield', async () => {
    const r = await admin.post('/api/recipes', {
      item_name: 'Capsicum', station_id: cutting.id, category_id: vegCat.id, unit_code: 'GM',
      whole_akhaj: true, default_cut_type_id: cutId('Diced'), default_cut_method: 'MACHINE',
      yield_percent: 82,
    });
    wholeItem = r.data.item;
    equal(wholeItem.cut_type_name, 'Whole', 'cut type forced to WHOLE');
    equal(wholeItem.default_cut_method, 'MANUAL', 'forced to MANUAL (orange)');
    equal(Number(wholeItem.yield_percent), 82, 'yield still applies');
    assert(r.data.autoAdjustments.length >= 2, 'the automatic adjustments should be reported');
  });

  await checkAsync('Whole / Akhaj still runs the yield calculation (300 @ 82% -> 366)', async () => {
    const r = await admin.post('/api/validation/yield-calculator', { itemId: wholeItem.id, netQuantity: 300 });
    equal(r.data.rawQuantity, 366, 'yield is not bypassed for Whole/Akhaj');
  });

  await checkAsync('Piece Weight is kept for PCS and cleared otherwise', async () => {
    const pcs = await admin.post('/api/recipes', {
      item_name: 'Momo Wrapper', station_id: storage.id, category_id: otherCat.id,
      unit_code: 'PCS', piece_weight: 12, storage_type: 'DRY',
    });
    equal(Number(pcs.data.item.piece_weight), 12, 'piece weight kept for PCS');

    const gm = await admin.post('/api/recipes', {
      item_name: 'Gram Item', station_id: storage.id, category_id: otherCat.id,
      unit_code: 'GM', piece_weight: 12, storage_type: 'DRY',
    });
    equal(gm.data.item.piece_weight, null, 'piece weight cleared for GM');
  });

  await checkAsync('Is Filling Ingredient is stored', async () => {
    const r = await admin.post('/api/recipes', {
      item_name: 'Cabbage', station_id: cutting.id, category_id: vegCat.id, unit_code: 'GM',
      default_cut_type_id: cutId('Chopped'), default_cut_method: 'MACHINE',
      yield_percent: 79, is_filling_ingredient: true,
    });
    equal(r.data.item.is_filling_ingredient, 1, 'filling flag stored');
  });

  await checkAsync('Shelf Life is kept for BATCH and cleared for DAILY', async () => {
    const r = await admin.post('/api/recipes', {
      item_name: 'Batch Sauce', station_id: juice.id, category_id: otherCat.id, unit_code: 'GM',
      prep_frequency: 'BATCH', shelf_life_value: 6, shelf_life_unit: 'MONTHS',
    });
    batchItem = r.data.item;
    equal(Number(batchItem.shelf_life_value), 6, 'shelf life kept for BATCH');

    const daily = await admin.post('/api/recipes', {
      item_name: 'Daily Thing', station_id: juice.id, category_id: otherCat.id, unit_code: 'GM',
      prep_frequency: 'DAILY', shelf_life_value: 6, shelf_life_unit: 'MONTHS',
    });
    equal(daily.data.item.shelf_life_value, null, 'shelf life cleared for DAILY');
  });

  await checkAsync('create a FROZEN item and a JUICE item', async () => {
    let r = await admin.post('/api/recipes', {
      item_name: 'Frozen Patty', station_id: cutting.id, category_id: otherCat.id,
      unit_code: 'GM', storage_type: 'FROZEN',
    });
    frozenItem = r.data.item;
    r = await admin.post('/api/validation/yield-calculator', { netQuantity: 100, yieldPercent: 45 });
    equal(r.data.rawQuantity, 222, 'juice yield maths');

    r = await admin.post('/api/recipes', {
      item_name: 'Lemon Juice', station_id: juice.id, category_id: juiceCat.id,
      unit_code: 'ML', yield_percent: 45,
    });
    juiceItem = r.data.item;
    equal(r.data.ready, true, 'juice item ready');
  });

  await checkAsync('Yield % is mandatory for a Juice item too', async () => {
    const r = await admin.post('/api/recipes', {
      item_name: 'Orange Juice', station_id: juice.id, category_id: juiceCat.id, unit_code: 'ML',
    });
    assert(r.data.errors.some((e) => e.code === 'YIELD_MISSING'), 'juice requires a yield');
    // Park this deliberately-broken row so it does not block the later gate tests.
    await admin.patch(`/api/recipes/${r.data.item.id}/status`, { is_active: false });
  });

  // ----------------------------------------------------------- yield edits
  section('Yield editing and the recalculation prompt');

  await checkAsync('yield can be added to an item that was missing one', async () => {
    const r = await admin.patch(`/api/recipes/${noYield.id}/yield`, { yield_percent: 88 });
    assert(r.status === 200, `patch: ${r.data.error}`);
    equal(Number(r.data.item.yield_percent), 88, 'yield saved');
    equal(r.data.ready, true, 'item now passes validation');
  });

  await checkAsync('an out-of-range yield is rejected', async () => {
    const r = await admin.patch(`/api/recipes/${noYield.id}/yield`, { yield_percent: 150 });
    equal(r.status, 400, 'must be rejected');
  });

  await checkAsync('editing a yield with no generated sheets needs no recalculation', async () => {
    const r = await admin.patch(`/api/recipes/${potato.id}/yield`, { yield_percent: 77 });
    equal(r.data.recalculation.requiresRecalculation, false, 'no sheets exist yet');
  });

  await checkAsync('editing a yield AFTER sheets exist prompts "Recalculate all sheets?"', async () => {
    // Fix the two deliberately broken items so generation is allowed to proceed.
    await admin.put(`/api/recipes/${noPeelMethod.id}`, {
      item_name: 'Needs Peel', station_id: cutting.id, category_id: vegCat.id, unit_code: 'GM',
      default_cut_type_id: cutId('Chopped'), default_cut_method: 'MANUAL',
      yield_percent: 90, needs_peeling: true, peeling_method: 'MANUAL',
    });
    await admin.put(`/api/recipes/${noCutMethod.id}`, {
      item_name: 'No Method', station_id: cutting.id, category_id: vegCat.id, unit_code: 'GM',
      default_cut_type_id: cutId('Chopped'), default_cut_method: 'MACHINE', yield_percent: 90,
    });

    const gen = await admin.post('/api/validation/sheet-runs', {});
    assert(gen.data.generated, `sheet run should succeed: ${JSON.stringify(gen.data.errors)}`);

    const r = await admin.patch(`/api/recipes/${potato.id}/yield`, { yield_percent: 75 });
    equal(r.data.recalculation.requiresRecalculation, true, 'recalculation required');
    equal(r.data.recalculation.prompt, 'Recalculate all sheets?', 'documented prompt text');
    assert(r.data.recalculation.affectedSheets.length > 0, 'affected sheets listed');

    const confirm = await admin.post(
      `/api/recipes/yield-changes/${r.data.recalculation.changeId}/recalculate`, { confirm: true });
    assert(confirm.data.sheetsMarkedStale > 0, 'confirming marks sheets for recalculation');
  });

  // ------------------------------------------------------ location overrides
  section('Location cutting overrides (v10.2 Rule 13)');

  await checkAsync('the same item takes a different cut per location without duplication', async () => {
    let r = await admin.put(`/api/recipes/${potato.id}/overrides/${locations[1].id}`,
      { cut_type_id: cutId('Julienne'), cut_method: 'MANUAL' });
    assert(r.status === 200, `override: ${r.data.error}`);
    r = await admin.put(`/api/recipes/${potato.id}/overrides/${locations[2].id}`,
      { cut_type_id: cutId('Sliced'), cut_method: 'MACHINE' });
    assert(r.status === 200, `override: ${r.data.error}`);

    const plan = r.data.cutPlan;
    equal(plan.length, 3, 'a plan row per active location');
    equal(plan.find((p) => p.locationId === locations[0].id).cutTypeName, 'Diced', 'default inherited');
    equal(plan.find((p) => p.locationId === locations[0].id).source, 'DEFAULT', 'marked as default');
    equal(plan.find((p) => p.locationId === locations[1].id).cutTypeName, 'Julienne', 'override applied');
    equal(plan.find((p) => p.locationId === locations[1].id).cutMethod, 'MANUAL', 'override method applied');
    equal(plan.find((p) => p.locationId === locations[2].id).cutTypeName, 'Sliced', 'override applied');

    const items = await admin.get('/api/recipes?search=Potato');
    equal(items.data.items.length, 1, 'the base recipe row is NOT duplicated');
  });

  await checkAsync('override colour follows Machine/Manual', async () => {
    const r = await admin.get(`/api/recipes/${potato.id}/overrides`);
    const julienne = r.data.cutPlan.find((p) => p.locationId === locations[1].id);
    equal(julienne.colour.colourName, 'Orange', 'manual override is orange');
    const sliced = r.data.cutPlan.find((p) => p.locationId === locations[2].id);
    equal(sliced.colour.colourName, 'Blue', 'machine override is blue');
  });

  await checkAsync('an override can be removed and the location falls back to the default', async () => {
    const r = await admin.del(`/api/recipes/${potato.id}/overrides/${locations[2].id}`);
    equal(r.status, 200, 'removed');
    equal(r.data.cutPlan.find((p) => p.locationId === locations[2].id).source, 'DEFAULT', 'back to default');
  });

  await checkAsync('a Whole/Akhaj item refuses per-location cut overrides', async () => {
    const r = await admin.put(`/api/recipes/${wholeItem.id}/overrides/${locations[0].id}`,
      { cut_type_id: cutId('Diced') });
    equal(r.status, 409, 'must be refused');
  });

  // --------------------------------------------------------- frozen / batch
  section('FROZEN and BATCH routing (v10.2 Rules 21 & 22)');

  await checkAsync('a FROZEN item creates no station task and only a packing line', async () => {
    const r = await admin.post('/api/validation/order-line', {
      itemId: frozenItem.id, netQuantity: 500, locationId: locations[0].id,
    });
    equal(r.data.createsStationTask, false, 'no station task');
    equal(r.data.route, 'PACKING_ONLY', 'routed to packing only');
    equal(r.data.packingLine, 'Take 500 GM from Freezer → pack for Location Alpha', 'documented packing line');
  });

  await checkAsync('a FROZEN item never appears on a station sheet', async () => {
    const r = await admin.get('/api/validation/station-preview');
    for (const sheet of r.data.sheets) {
      assert(!sheet.rows.some((row) => row.itemId === frozenItem.id),
        `frozen item leaked onto the ${sheet.station.name} sheet`);
    }
    assert(r.data.frozenPackingOnly.some((f) => f.itemId === frozenItem.id), 'listed under packing-only');
  });

  await checkAsync('a BATCH item ordered on the daily form is blocked with the documented message', async () => {
    const r = await admin.post('/api/validation/order-line', {
      itemId: batchItem.id, netQuantity: 1000, locationId: locations[0].id,
    });
    equal(r.data.blocked, true, 'must be blocked');
    equal(r.data.message, 'This is a batch-prep item — not prepared daily.', 'documented message');
  });

  await checkAsync('a BATCH item never appears on a daily station sheet', async () => {
    const r = await admin.get('/api/validation/station-preview');
    for (const sheet of r.data.sheets) {
      assert(!sheet.rows.some((row) => row.itemId === batchItem.id),
        `batch item leaked onto the ${sheet.station.name} sheet`);
    }
    assert(r.data.batchExcluded.some((b) => b.itemId === batchItem.id), 'listed as excluded');
  });

  await checkAsync('an unrecognised item is flagged rather than silently dropped', async () => {
    const r = await admin.post('/api/validation/order-line', { itemName: 'Nonexistent Thing', netQuantity: 10 });
    equal(r.data.code, 'UNRECOGNISED', 'flagged unrecognised');
  });

  await checkAsync('an order line applies the location override and the yield together', async () => {
    const r = await admin.post('/api/validation/order-line', {
      itemId: potato.id, netQuantity: 300, locationId: locations[1].id,
    });
    equal(r.data.cut.cutTypeName, 'Julienne', 'location override applied');
    equal(r.data.cut.cutMethod, 'MANUAL', 'override method applied');
    equal(r.data.calculation.rawQuantity, 400, '300 at 75% yield = 400 raw');
    equal(r.data.peelingStep.required, true, 'peeling step required first');
  });

  // ------------------------------------------------------ validation gate
  section('Sheet generation gate');

  await checkAsync('generation is blocked while any required Yield % is missing', async () => {
    const broken = await admin.post('/api/recipes', {
      item_name: 'Blocker Veg', station_id: cutting.id, category_id: vegCat.id, unit_code: 'GM',
      default_cut_type_id: cutId('Diced'), default_cut_method: 'MACHINE',
    });
    const gate = await admin.get('/api/validation/sheet-readiness');
    equal(gate.data.canGenerate, false, 'generation blocked');
    assert(gate.data.errors.some((e) => e.message === 'Yield % missing for Blocker Veg.'), 'documented message');
    assert(gate.data.blockedStations.includes('Vegetable Cutting'), 'affected station reported');

    const run = await admin.post('/api/validation/sheet-runs', {});
    equal(run.status, 422, 'the generation endpoint refuses to run');
    equal(run.data.generated, false, 'nothing generated');

    await admin.patch(`/api/recipes/${broken.data.item.id}/yield`, { yield_percent: 85 });
    const after = await admin.get('/api/validation/sheet-readiness');
    equal(after.data.canGenerate, true, 'unblocked once the yield is supplied');
  });

  await checkAsync('a missing yield is never silently treated as 100%', async () => {
    const r = await admin.post('/api/recipes', {
      item_name: 'Silent Check', station_id: cutting.id, category_id: vegCat.id, unit_code: 'GM',
      default_cut_type_id: cutId('Diced'), default_cut_method: 'MACHINE',
    });
    const calc = await admin.post('/api/validation/yield-calculator',
      { itemId: r.data.item.id, netQuantity: 1000 });
    equal(calc.status, 422, 'must refuse to calculate');
    equal(calc.data.error, 'Yield % missing for Silent Check.', 'documented message');
    await admin.patch(`/api/recipes/${r.data.item.id}/status`, { is_active: false });
  });

  // -------------------------------------------------------------- dynamic
  section('Dynamic station test — TEST STATION (v10.2 Rule 19)');

  let testStation;
  await checkAsync('1. add TEST STATION through Station Master', async () => {
    const r = await admin.post('/api/stations', {
      name: 'TEST STATION', type_code: 'PREP', sheet_label: 'Z', sort_order: 99, is_sample: true,
    });
    assert(r.status === 201, `create: ${r.data.error}`);
    testStation = r.data.station;
  });

  await checkAsync('2. the station is immediately offered as a Recipe DB option', async () => {
    const r = await admin.get('/api/meta/bootstrap');
    assert(r.data.stations.some((s) => s.id === testStation.id && s.name === 'TEST STATION'),
      'TEST STATION missing from the station dropdown source');
  });

  let testItem;
  await checkAsync('3. assign a recipe item to it', async () => {
    const r = await admin.post('/api/recipes', {
      item_name: 'TEST ITEM', station_id: testStation.id, category_id: otherCat.id, unit_code: 'GM',
      is_sample: true,
    });
    assert(r.status === 201, `create: ${r.data.error}`);
    testItem = r.data.item;
    equal(testItem.station_name, 'TEST STATION', 'item routed to the new station');
    equal(r.data.routing.route, 'STATION', 'routed to a station task');
  });

  await checkAsync('4. assign MULTIPLE counter persons to it', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await admin.put(`/api/roster/stations/${testStation.id}/roster`, {
      user_ids: [counters[0].id, counters[1].id, counters[2].id], effective_from: today,
    });
    assert(r.status === 200, `roster: ${r.data.error}`);
    equal(r.data.rosterToday.length, 3, 'three persons assigned to the new station');
  });

  await checkAsync('5. its sheet and task structure generate with NO code change', async () => {
    const r = await admin.get('/api/validation/station-preview');
    const sheet = r.data.sheets.find((s) => s.station.id === testStation.id);
    assert(sheet, 'no sheet was generated for TEST STATION');
    equal(sheet.station.name, 'TEST STATION', 'sheet is named after the station');
    equal(sheet.itemCount, 1, 'the assigned item appears on it');
    equal(sheet.rows[0].item, 'TEST ITEM', 'correct item on the sheet');
    equal(sheet.staff.length, 3, 'all three persons appear on the sheet');
    equal(sheet.taskDistribution.length, 3, 'tasks distribute across the three persons');
  });

  await checkAsync('6. deactivate TEST STATION and it disappears from the sheets', async () => {
    const r = await admin.patch(`/api/stations/${testStation.id}/status`, { is_active: false });
    equal(r.data.station.is_active, 0, 'deactivated');

    const preview = await admin.get('/api/validation/station-preview');
    assert(!preview.data.sheets.some((s) => s.station.id === testStation.id),
      'an inactive station must not generate a sheet');

    const stations = await admin.get('/api/stations');
    assert(stations.data.stations.some((s) => s.id === testStation.id),
      'the station record itself must be kept, not deleted');
  });

  await checkAsync('7. an in-use station cannot be deleted', async () => {
    const r = await admin.del(`/api/stations/${testStation.id}`);
    equal(r.status, 409, 'deletion refused while items reference it');
    assert(/deactivate/i.test(r.data.error), 'error should point to deactivation');
  });

  // ------------------------------------------------- real org data shape
  section('Central Kitchen Surat org structure (seed:kitchen)');

  await checkAsync('the org chart loads as 5 sections and 15 users', async () => {
    const { SECTIONS, MANAGEMENT, STAFF } = require('../server/db/seed-kitchen');
    equal(SECTIONS.length, 5, 'five sections on the chart');
    equal(MANAGEMENT.length + STAFF.length, 15, 'fifteen people on the chart');

    // "Prep — Cutting, chopping" is the only cutting-type section, so it is the
    // only one whose items need a cut type + MACHINE/MANUAL.
    const cutting = SECTIONS.filter((s) => s.type === 'CUTTING');
    equal(cutting.length, 1, 'exactly one cutting-type section');
    equal(cutting[0].name, 'Prep', 'the cutting section is Prep');

    // Every staff member points at a section that actually exists.
    const names = new Set(SECTIONS.map((s) => s.name));
    for (const p of STAFF) {
      assert(names.has(p.section), `${p.fullName} is assigned to unknown section "${p.section}"`);
    }
    // Usernames must be unique — three different people are named Pritam.
    const usernames = [...MANAGEMENT, ...STAFF].map((p) => p.username);
    equal(new Set(usernames).size, usernames.length, 'usernames are unique');
    equal(STAFF.filter((p) => p.fullName.startsWith('Pritam')).length, 3, 'three distinct Pritams');
  });

  await checkAsync('sections carry 1..N people with no fixed slots', async () => {
    const { SECTIONS, STAFF } = require('../server/db/seed-kitchen');
    const counts = SECTIONS.map((s) => STAFF.filter((p) => p.section === s.name).length);
    equal(Math.min(...counts), 1, 'the smallest section has one person');
    equal(Math.max(...counts), 4, 'the largest section has four');
    assert(counts.every((n) => n >= 1), 'every section is staffed');
  });

  // ------------------------------------------------- credentials + PIN policy
  section('Sign-in credentials (bulk login IDs and PINs)');

  let pinUser;
  await checkAsync('a counter person can be given a numeric PIN', async () => {
    const created = await admin.post('/api/users', {
      full_name: 'Pin Cook', username: 'pin.cook', role_code: 'COUNTER_PERSON', password: 'temp1234',
    });
    pinUser = created.data.user;

    const r = await admin.post('/api/credentials/bulk', {
      entries: [{ user_id: pinUser.id, username: 'pincook', secret: '4827' }],
    });
    assert(r.data.applied, `bulk save: ${JSON.stringify(r.data.errors || r.data)}`);
    equal(r.data.handout[0].credentialType, 'PIN', 'stored as a PIN');
    equal(r.data.handout[0].secret, '4827', 'handout echoes the PIN once');
    equal(r.data.handout[0].username, 'pincook', 'login ID applied');
  });

  await checkAsync('the new PIN actually signs in', async () => {
    const c = client();
    const me = await c.login('pincook', '4827');
    equal(me.role, 'COUNTER_PERSON', 'signed in with the PIN');
  });

  await checkAsync('an admin role is refused a numeric PIN', async () => {
    const list = await admin.get('/api/users?role=SUPER_ADMIN');
    const sa = list.data.users[0];
    const r = await admin.post('/api/credentials/bulk', {
      entries: [{ user_id: sa.id, secret: '482716' }],
    });
    equal(r.status, 422, 'must be refused');
    assert(r.data.errors.some((e) => e.code === 'PIN_NOT_ALLOWED_FOR_ROLE'),
      `expected PIN_NOT_ALLOWED_FOR_ROLE, got ${JSON.stringify(r.data.errors)}`);
  });

  await checkAsync('guessable PINs are rejected', async () => {
    for (const [pin, why] of [['1111', 'all same'], ['1234', 'sequential'],
      ['4321', 'reverse sequential'], ['1212', 'repeated pattern']]) {
      const r = await admin.post('/api/credentials/bulk', {
        entries: [{ user_id: pinUser.id, secret: pin }],
      });
      equal(r.status, 422, `${pin} (${why}) must be refused`);
      assert(r.data.errors.some((e) => e.code === 'PIN_WEAK'), `${pin} should be flagged weak`);
    }
  });

  await checkAsync('a PIN must be 4–6 digits', async () => {
    for (const pin of ['482', '4827163']) {
      const r = await admin.post('/api/credentials/bulk', { entries: [{ user_id: pinUser.id, secret: pin }] });
      equal(r.status, 422, `${pin} must be refused`);
      assert(r.data.errors.some((e) => e.code === 'PIN_LENGTH'), `${pin} should fail on length`);
    }
  });

  await checkAsync('a bad row rejects the WHOLE batch — nobody is half-changed', async () => {
    const other = await admin.post('/api/users', {
      full_name: 'Batch Mate', username: 'batch.mate', role_code: 'COUNTER_PERSON', password: 'temp1234',
    });
    const r = await admin.post('/api/credentials/bulk', {
      entries: [
        { user_id: other.data.user.id, secret: '5913' },   // valid
        { user_id: pinUser.id, secret: '1111' },           // weak -> kills the batch
      ],
    });
    equal(r.status, 422, 'batch refused');
    equal(r.data.applied, false, 'nothing applied');
    // The valid row must NOT have been written.
    const c = client();
    const attempt = await c.post('/api/auth/login', { username: 'batch.mate', password: '5913' });
    equal(attempt.status, 401, 'the valid row in a failed batch was not applied');
  });

  await checkAsync('a login ID already in use is refused', async () => {
    const r = await admin.post('/api/credentials/bulk', {
      entries: [{ user_id: pinUser.id, username: 'counter.two' }],
    });
    equal(r.status, 422, 'must be refused');
    assert(r.data.errors.some((e) => e.code === 'USERNAME_TAKEN'), 'flagged as taken');
  });

  await checkAsync('the same login ID twice in one batch is refused', async () => {
    const a = await admin.post('/api/users', {
      full_name: 'Dup One', username: 'dup.one', role_code: 'COUNTER_PERSON', password: 'temp1234' });
    const b = await admin.post('/api/users', {
      full_name: 'Dup Two', username: 'dup.two', role_code: 'COUNTER_PERSON', password: 'temp1234' });
    const r = await admin.post('/api/credentials/bulk', {
      entries: [
        { user_id: a.data.user.id, username: 'sharedid' },
        { user_id: b.data.user.id, username: 'sharedid' },
      ],
    });
    equal(r.status, 422, 'must be refused');
    assert(r.data.errors.some((e) => e.code === 'USERNAME_DUPLICATE_IN_BATCH'), 'duplicate detected');
  });

  await checkAsync('no endpoint ever returns a stored secret', async () => {
    const listing = await admin.get('/api/credentials');
    const blob = JSON.stringify(listing.data);
    assert(!blob.includes('4827'), 'a stored PIN leaked in the credentials listing');
    assert(!/password_hash|\$2[aby]\$/.test(blob), 'a password hash leaked to the client');

    const users = await admin.get('/api/users');
    assert(!/password_hash|\$2[aby]\$/.test(JSON.stringify(users.data)), 'hash leaked from the user list');
  });

  await checkAsync('5 wrong PINs lock the account, and an admin can unlock it', async () => {
    const c = client();
    let last;
    for (let i = 0; i < 5; i++) {
      last = await c.post('/api/auth/login', { username: 'pincook', password: '9999' });
      equal(last.status, 401, `attempt ${i + 1} refused`);
    }
    // The 5th failure trips the lock; the next attempt is refused as locked.
    const locked = await c.post('/api/auth/login', { username: 'pincook', password: '4827' });
    equal(locked.status, 423, 'correct PIN must be refused while locked');
    assert(/locked/i.test(locked.data.error), 'error should say the account is locked');

    const listing = await admin.get('/api/credentials');
    const row = listing.data.users.find((u) => u.username === 'pincook');
    equal(row.locked, true, 'admin sees the lock');

    const unlocked = await admin.post(`/api/credentials/${pinUser.id}/unlock`);
    equal(unlocked.data.user.locked, false, 'unlocked');

    const ok = await c.post('/api/auth/login', { username: 'pincook', password: '4827' });
    equal(ok.status, 200, 'sign-in works again after unlocking');
  });

  await checkAsync('a successful sign-in clears the failure counter', async () => {
    const c = client();
    await c.post('/api/auth/login', { username: 'pincook', password: '0000' });
    await c.login('pincook', '4827');
    const listing = await admin.get('/api/credentials');
    equal(listing.data.users.find((u) => u.username === 'pincook').failedAttempts, 0, 'counter reset');
  });

  await checkAsync('suggested PINs are unique and pass the weak-PIN rules', async () => {
    const r = await admin.post('/api/credentials/suggest', {});
    assert(r.data.suggestions.length > 0, 'suggestions returned');
    const pins = r.data.suggestions.map((s) => s.pin);
    equal(new Set(pins).size, pins.length, 'suggested PINs are distinct');
    for (const p of pins) {
      assert(/^\d{4,6}$/.test(p), `"${p}" is not 4-6 digits`);
      assert(!/^(\d)\1+$/.test(p), `"${p}" is all one digit`);
    }
  });

  await checkAsync('only a user manager may reach the credentials screen', async () => {
    const cp = client();
    await cp.login('counter.two', 'counter123');
    equal((await cp.get('/api/credentials')).status, 403, 'counter person forbidden');
    equal((await cp.post('/api/credentials/bulk', { entries: [] })).status, 403, 'bulk save forbidden');

    await admin.post('/api/users', {
      full_name: 'Creds Prep Admin', username: 'creds.pk',
      role_code: 'PREP_KITCHEN_ADMIN', password: 'credspk123',
    });
    const pk = client();
    await pk.login('creds.pk', 'credspk123');
    equal((await pk.get('/api/credentials')).status, 403, 'prep kitchen admin forbidden (users.manage only)');
  });

  await checkAsync('a counter person may switch their own secret to a PIN', async () => {
    const c = client();
    await c.login('pincook', '4827');
    const r = await c.post('/api/auth/change-password', { currentPassword: '4827', newPassword: '7361' });
    equal(r.status, 200, `change: ${r.data.error}`);
    equal(r.data.credentialType, 'PIN', 'still a PIN');
    const again = client();
    equal((await again.post('/api/auth/login', { username: 'pincook', password: '7361' })).status, 200,
      'new PIN works');
  });

  await checkAsync('an admin cannot switch their own secret to a PIN', async () => {
    const c = client();
    await c.login('testadmin', 'testadmin123');
    const r = await c.post('/api/auth/change-password',
      { currentPassword: 'testadmin123', newPassword: '482716' });
    equal(r.status, 400, 'must be refused');
    assert(/cannot use a numeric PIN/i.test(r.data.error), `unexpected message: ${r.data.error}`);
  });

  // ------------------------------------------------------------------ RBAC
  section('Role-based access control (server-enforced)');

  await checkAsync('an anonymous caller cannot read the user list', async () => {
    const anon = client();
    const r = await anon.get('/api/users');
    equal(r.status, 401, 'must require authentication');
  });

  await checkAsync('a Counter Person cannot read the user list or the Recipe DB', async () => {
    const cp = client();
    await cp.login('counter.two', 'counter123');
    equal((await cp.get('/api/users')).status, 403, 'user list must be forbidden');
    equal((await cp.get('/api/recipes')).status, 403, 'recipe DB must be forbidden');
    equal((await cp.get('/api/stations')).status, 403, 'station master must be forbidden');
  });

  await checkAsync('a Counter Person cannot create users, stations or recipe items', async () => {
    const cp = client();
    await cp.login('counter.two', 'counter123');
    equal((await cp.post('/api/users', { full_name: 'X', username: 'x.y', role_code: 'SUPER_ADMIN', password: 'secret123' })).status,
      403, 'user creation must be forbidden');
    equal((await cp.post('/api/stations', { name: 'Sneaky', type_code: 'PREP' })).status,
      403, 'station creation must be forbidden');
    equal((await cp.post('/api/recipes', { item_name: 'Sneaky Item' })).status,
      403, 'recipe creation must be forbidden');
  });

  await checkAsync('a Counter Person cannot mark anyone absent', async () => {
    const cp = client();
    await cp.login('counter.two', 'counter123');
    const r = await cp.post('/api/roster/attendance', { user_id: counters[0].id, status: 'ABSENT' });
    equal(r.status, 403, 'attendance management must be forbidden');
  });

  await checkAsync('a Counter Person sees only their own user record', async () => {
    const cp = client();
    const me = await cp.login('counter.two', 'counter123');
    equal((await cp.get(`/api/users/${me.id}`)).status, 200, 'own record readable');
    equal((await cp.get(`/api/users/${counters[0].id}`)).status, 403, "another person's record must be forbidden");
  });

  await checkAsync('a Location Manager cannot manage users, stations or recipes', async () => {
    const lm = client();
    await lm.login('manager.one', 'manager123');
    equal((await lm.get('/api/users')).status, 403, 'user list must be forbidden');
    equal((await lm.post('/api/stations', { name: 'LM Station', type_code: 'PREP' })).status, 403, 'station creation forbidden');
    equal((await lm.post('/api/recipes', { item_name: 'LM Item' })).status, 403, 'recipe creation forbidden');
  });

  await checkAsync('a Prep Kitchen Admin can manage stations and recipes but not system settings', async () => {
    await admin.post('/api/users', {
      full_name: 'Prep Admin', username: 'prep.admin', role_code: 'PREP_KITCHEN_ADMIN', password: 'prepadmin123',
    });
    const pk = client();
    await pk.login('prep.admin', 'prepadmin123');

    equal((await pk.get('/api/recipes')).status, 200, 'recipe DB readable');
    equal((await pk.get('/api/stations')).status, 200, 'station master readable');
    const st = await pk.post('/api/stations', { name: 'PK Station', type_code: 'PREP' });
    equal(st.status, 201, 'may create a station');

    equal((await pk.get('/api/meta/settings')).status, 403, 'system settings must be Super Admin only');
    equal((await pk.post('/api/users', {
      full_name: 'Nope', username: 'nope.user', role_code: 'COUNTER_PERSON', password: 'secret123',
    })).status, 403, 'user creation must be Super Admin only');

    // ...but it CAN assign counter persons to stations, which is its documented duty.
    const today = new Date().toISOString().slice(0, 10);
    const assign = await pk.put(`/api/roster/stations/${st.data.station.id}/roster`,
      { user_ids: [counters[0].id], effective_from: today });
    equal(assign.status, 200, 'may assign counter persons');
    await admin.patch(`/api/stations/${st.data.station.id}/status`, { is_active: false });
  });

  await checkAsync('an inactive user cannot sign in', async () => {
    await admin.patch(`/api/users/${counters[0].id}/status`, { is_active: false });
    const c = client();
    const r = await c.post('/api/auth/login', { username: 'counter.one', password: 'counter123' });
    equal(r.status, 403, 'inactive account must be refused');
    await admin.patch(`/api/users/${counters[0].id}/status`, { is_active: true });
  });

  await checkAsync('a wrong password is refused without revealing whether the user exists', async () => {
    const c = client();
    const bad = await c.post('/api/auth/login', { username: 'counter.two', password: 'wrong' });
    const missing = await c.post('/api/auth/login', { username: 'nobody.here', password: 'wrong' });
    equal(bad.status, 401, 'wrong password refused');
    equal(bad.status, missing.status, 'identical status for both cases');
    equal(bad.data.error, missing.data.error, 'identical message for both cases');
  });

  await checkAsync('a locked account is indistinguishable from a wrong guess', async () => {
    // Lock a real account, then confirm a WRONG guess against it looks exactly
    // like a guess at a username that does not exist — no enumeration signal.
    const victim = await admin.post('/api/users', {
      full_name: 'Lock Probe', username: 'lock.probe', role_code: 'COUNTER_PERSON', password: 'probe123',
    });
    const c = client();
    for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { username: 'lock.probe', password: 'nope' });

    const lockedWrong = await c.post('/api/auth/login', { username: 'lock.probe', password: 'still-wrong' });
    const missing = await c.post('/api/auth/login', { username: 'nobody.here', password: 'still-wrong' });
    equal(lockedWrong.status, missing.status, 'same status');
    equal(lockedWrong.data.error, missing.data.error, 'same message — no lockout signal leaked');

    // Only the holder of the correct secret learns it is locked.
    const holder = await c.post('/api/auth/login', { username: 'lock.probe', password: 'probe123' });
    equal(holder.status, 423, 'correct secret reveals the lock');
    await admin.post(`/api/credentials/${victim.data.user.id}/unlock`);
  });

  // -------------------------------------------------------------- sample data
  section('Sample data separation');

  await checkAsync('sample records are counted separately and purge only removes them', async () => {
    const before = await admin.get('/api/meta/sample-data');
    const sampleTotal = before.data.counts.reduce((n, c) => n + c.count, 0);
    assert(sampleTotal >= 2, 'the TEST STATION and TEST ITEM should be counted as sample');

    const realRecipesBefore = (await admin.get('/api/recipes')).data.items.filter((i) => i.is_sample === 0).length;
    await admin.del('/api/meta/sample-data');

    const after = await admin.get('/api/meta/sample-data');
    equal(after.data.counts.reduce((n, c) => n + c.count, 0), 0, 'all sample data removed');
    const realRecipesAfter = (await admin.get('/api/recipes')).data.items.filter((i) => i.is_sample === 0).length;
    equal(realRecipesAfter, realRecipesBefore, 'real master data untouched');
  });

  // ------------------------------------------------------------------ done
  server.close();

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  \x1b[32m${passed} passed\x1b[0m${failed ? `, \x1b[31m${failed} failed\x1b[0m` : ''}`);
  if (failed) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  • ${f}`));
  }
  console.log(`${'─'.repeat(64)}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
