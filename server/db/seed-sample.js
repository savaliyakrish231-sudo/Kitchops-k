'use strict';

/**
 * OPTIONAL sample data — run with `npm run seed:sample`.
 *
 * Every row created here is written with is_sample = 1 and a "SAMPLE" name
 * prefix, so it is visually and programmatically distinct from the real master
 * data. Remove it all at once from Supporting Masters -> "Remove all sample
 * data", or with `npm run seed:sample -- --clear`.
 *
 * These names, yields, cut methods and staff are PLACEHOLDERS for testing the
 * mechanics. They are not business configuration.
 */

const bcrypt = require('bcryptjs');
const { get, run, tx } = require('./connection');
const { migrate } = require('./migrate');
const roster = require('../services/roster.service');

function seed() {
  migrate({ silent: true });

  if (get('SELECT 1 AS x FROM stations WHERE is_sample = 1 LIMIT 1')) {
    console.log('[seed] sample data already present — nothing to do.');
    return;
  }

  const cutTypeId = (name) => get('SELECT id FROM cut_types WHERE name = ?', [name])?.id ?? null;
  const categoryId = (name) => get('SELECT id FROM item_categories WHERE name = ?', [name])?.id ?? null;

  tx(() => {
    // --- stations (any names would do; these exercise each station type) ----
    const stations = [
      ['SAMPLE Peeling Counter', 'A', '#0ea5e9', 'PEELING', 1],
      ['SAMPLE Vegetable Cutting', 'B', '#22c55e', 'CUTTING', 2],
      ['SAMPLE Juice Counter', 'C', '#f97316', 'PREP', 3],
      ['SAMPLE Dry Store Counter', 'D', '#a855f7', 'STORAGE', 4],
      ['SAMPLE Packing Counter', 'E', '#64748b', 'PACKING', 5],
    ].map(([name, label, colour, type, sort]) => {
      const r = run(`INSERT INTO stations (name, sheet_label, sheet_colour, type_code, sort_order, is_sample)
                     VALUES (?, ?, ?, ?, ?, 1)`, [name, label, colour, type, sort]);
      return { id: Number(r.lastInsertRowid), name, type };
    });
    const stationByType = (t) => stations.find((s) => s.type === t).id;

    // --- locations ---------------------------------------------------------
    const locations = ['SAMPLE Location 1', 'SAMPLE Location 2', 'SAMPLE Location 3'].map((name, i) => {
      const r = run('INSERT INTO locations (name, code, sort_order, is_sample) VALUES (?, ?, ?, 1)',
        [name, `S${i + 1}`, i + 1]);
      return { id: Number(r.lastInsertRowid), name };
    });

    // --- users (password: sample123) ---------------------------------------
    const hash = bcrypt.hashSync('sample123', 10);
    const mkUser = (fullName, username, role) => {
      const r = run(`INSERT INTO users (full_name, username, password_hash, role_code, is_sample)
                     VALUES (?, ?, ?, ?, 1)`, [fullName, username, hash, role]);
      return Number(r.lastInsertRowid);
    };

    const admin = mkUser('SAMPLE Prep Kitchen Admin', 'sample.admin', 'PREP_KITCHEN_ADMIN');
    const manager = mkUser('SAMPLE Location Manager', 'sample.manager', 'LOCATION_MANAGER');
    run('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)', [manager, locations[0].id]);

    // A station with THREE persons — proves 1..N staffing per station.
    const cuttingStaff = [
      mkUser('SAMPLE Counter Person 1', 'sample.counter1', 'COUNTER_PERSON'),
      mkUser('SAMPLE Counter Person 2', 'sample.counter2', 'COUNTER_PERSON'),
      mkUser('SAMPLE Counter Person 3', 'sample.counter3', 'COUNTER_PERSON'),
    ];
    const peelingStaff = [mkUser('SAMPLE Counter Person 4', 'sample.counter4', 'COUNTER_PERSON')];

    const today = roster.today();
    for (const uid of cuttingStaff) {
      run('INSERT INTO user_stations (user_id, station_id, effective_from) VALUES (?, ?, ?)',
        [uid, stationByType('CUTTING'), today]);
    }
    for (const uid of peelingStaff) {
      run('INSERT INTO user_stations (user_id, station_id, effective_from) VALUES (?, ?, ?)',
        [uid, stationByType('PEELING'), today]);
    }

    // --- recipe items ------------------------------------------------------
    // Placeholder yields chosen only to exercise the arithmetic.
    const items = [
      // name, station, category, unit, cutType, method, yield, peel, peelMethod, whole, storage, freq
      ['SAMPLE Veg A', 'CUTTING', 'Vegetable', 'GM', 'Diced', 'MACHINE', 79, 1, 'MACHINE', 0, 'FRESH', 'DAILY'],
      ['SAMPLE Veg B', 'CUTTING', 'Vegetable', 'GM', 'Sliced', 'MANUAL', 95, 0, null, 0, 'FRESH', 'DAILY'],
      ['SAMPLE Veg C (Whole)', 'CUTTING', 'Vegetable', 'GM', 'Whole', 'MANUAL', 82, 0, null, 1, 'FRESH', 'DAILY'],
      ['SAMPLE Juice Item', 'PREP', 'Juice', 'ML', null, null, 45, 0, null, 0, 'FRESH', 'DAILY'],
      ['SAMPLE Dry Item', 'STORAGE', 'Other', 'PCS', null, null, null, 0, null, 0, 'DRY', 'DAILY'],
      ['SAMPLE Frozen Item', 'STORAGE', 'Other', 'GM', null, null, null, 0, null, 0, 'FROZEN', 'DAILY'],
      ['SAMPLE Batch Sauce', 'PREP', 'Other', 'GM', null, null, null, 0, null, 0, 'FRESH', 'BATCH'],
    ];

    const created = {};
    for (const [name, type, cat, unit, cut, method, yieldPct, peel, peelMethod, whole, storage, freq] of items) {
      const r = run(`INSERT INTO recipe_items
          (item_name, station_id, category_id, unit_code, default_cut_type_id, default_cut_method,
           whole_akhaj, needs_peeling, peeling_method, yield_percent, prep_frequency,
           shelf_life_value, shelf_life_unit, storage_type, is_sample)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [name, stationByType(type), categoryId(cat), unit, cut ? cutTypeId(cut) : null, method,
          whole, peel, peelMethod, yieldPct, freq,
          freq === 'BATCH' ? 6 : null, freq === 'BATCH' ? 'MONTHS' : null, storage]);
      created[name] = Number(r.lastInsertRowid);
    }

    // --- location cutting overrides: same item cut differently per location -
    run(`INSERT INTO recipe_location_overrides (recipe_item_id, location_id, cut_type_id, cut_method)
         VALUES (?, ?, ?, ?)`, [created['SAMPLE Veg A'], locations[1].id, cutTypeId('Julienne'), 'MANUAL']);
    run(`INSERT INTO recipe_location_overrides (recipe_item_id, location_id, cut_type_id, cut_method)
         VALUES (?, ?, ?, ?)`, [created['SAMPLE Veg A'], locations[2].id, cutTypeId('Sliced'), 'MACHINE']);

    console.log(`[seed] created ${stations.length} stations, ${locations.length} locations, ` +
      `${cuttingStaff.length + peelingStaff.length + 2} users, ${items.length} recipe items — all tagged SAMPLE.`);
    console.log('[seed] sample user password: sample123');
  });
}

function clear() {
  migrate({ silent: true });
  tx(() => {
    run('DELETE FROM recipe_items WHERE is_sample = 1');
    run('DELETE FROM user_stations WHERE user_id IN (SELECT id FROM users WHERE is_sample = 1)');
    run('DELETE FROM user_locations WHERE user_id IN (SELECT id FROM users WHERE is_sample = 1)');
    run('DELETE FROM staff_attendance WHERE user_id IN (SELECT id FROM users WHERE is_sample = 1)');
    run("DELETE FROM users WHERE is_sample = 1 AND role_code != 'SUPER_ADMIN'");
    run('DELETE FROM user_stations WHERE station_id IN (SELECT id FROM stations WHERE is_sample = 1)');
    run('DELETE FROM sheet_runs WHERE station_id IN (SELECT id FROM stations WHERE is_sample = 1)');
    run('DELETE FROM stations WHERE is_sample = 1');
    run('DELETE FROM recipe_location_overrides WHERE location_id IN (SELECT id FROM locations WHERE is_sample = 1)');
    run('DELETE FROM locations WHERE is_sample = 1');
  });
  console.log('[seed] sample data removed.');
}

module.exports = { seed, clear };

if (require.main === module) {
  if (process.argv.includes('--clear')) clear();
  else seed();
}
