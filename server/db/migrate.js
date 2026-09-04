'use strict';

/**
 * Creates the schema and seeds ONLY system vocabulary that the v10.2 document
 * defines as engine behaviour (roles, permissions, station types, units,
 * the documented cut-type list, and the yield-mandatory categories).
 *
 * It seeds NO stations, NO locations, NO staff, NO recipe items and NO yield
 * values — that is business master data and is entered through the UI.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { db, all, get, run, DATA_DIR } = require('./connection');

/**
 * Adds a column to an existing table if it is not already there.
 * schema.sql uses CREATE TABLE IF NOT EXISTS, which cannot evolve a table that
 * already exists, so column additions are applied here instead.
 */
function addColumnIfMissing(table, column, definition) {
  const columns = all(`PRAGMA table_info(${table})`);
  if (columns.some((c) => c.name === column)) return false;
  run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

const COLUMN_ADDITIONS = [
  ['users', 'designation', 'TEXT'],
  ['users', 'additional_responsibility', 'TEXT'],
  ['users', 'credential_type', "TEXT NOT NULL DEFAULT 'PASSWORD'"],
  ['users', 'failed_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'last_failed_at', 'TEXT'],
  ['users', 'locked_until', 'TEXT'],
  ['roles', 'allows_pin', 'INTEGER NOT NULL DEFAULT 0'],
];

//                                                                          loc stn pin sort
const ROLES = [
  ['SUPER_ADMIN',       'Super Admin',        'Full access — all data, settings, cutoff time, user management', 0, 0, 0, 1],
  ['PREP_KITCHEN_ADMIN','Prep Kitchen Admin', 'View all sheets, manage Station Master, manage recipes, assign persons, override tasks, monitor dashboard', 0, 0, 0, 2],
  ['LOCATION_MANAGER',  'Location Manager',   'Submit item-wise daily requirements for their location', 1, 0, 0, 3],
  ['COUNTER_PERSON',    'Counter Person',     'See ONLY their assigned tasks with Machine/Manual colour coding. Mark done.', 0, 1, 1, 4],
];

const PERMISSIONS = [
  ['users.view',            'View the user list'],
  ['users.manage',          'Create / edit / activate / deactivate users and reset passwords'],
  ['users.assign_stations', 'Assign counter persons to stations (Counter Settings)'],
  ['stations.view',         'View Station Master'],
  ['stations.manage',       'Create / edit / activate / deactivate stations'],
  ['locations.view',        'View Location Master'],
  ['locations.manage',      'Create / edit / activate / deactivate locations'],
  ['recipes.view',          'View the Recipe Database'],
  ['recipes.manage',        'Create / edit recipe items, yield %, cut config and location overrides'],
  ['masters.manage',        'Manage supporting masters (cut types, item categories, units)'],
  ['attendance.view',       'View today’s counter-staff attendance'],
  ['attendance.manage',     'Mark a counter person Absent Today / Present'],
  ['sheets.view_all',       'View every station sheet'],
  ['sheets.generate',       'Run sheet generation / validation'],
  ['tasks.view_own',        'See only their own assigned tasks'],
  ['tasks.override',        'Reassign or override tasks between persons'],
  ['orders.submit',         'Submit the item-wise daily requirement for their location'],
  ['settings.manage',       'Manage system settings including cutoff time'],
  ['dashboard.view',        'View the admin progress dashboard'],
];

// v10.2 s1.1 role -> access mapping. Super Admin gets everything.
const ROLE_PERMISSIONS = {
  PREP_KITCHEN_ADMIN: [
    'users.view', 'users.assign_stations',
    'stations.view', 'stations.manage',
    'locations.view',
    'recipes.view', 'recipes.manage', 'masters.manage',
    'attendance.view', 'attendance.manage',
    'sheets.view_all', 'sheets.generate',
    'tasks.override', 'dashboard.view',
  ],
  LOCATION_MANAGER: ['orders.submit'],
  COUNTER_PERSON: ['tasks.view_own'],
};

// v10.2 s1.2 "Station Type ... Drives special logic". Behaviour lives in these
// flags so the engine never has to look at a station's NAME.
const STATION_TYPES = [
  // code,        name,           cutMethod, cutType, isPeeling, isPacking, feedsInto, sort
  ['PEELING',      'Peeling',       0, 0, 1, 0, 'CUTTING', 1],
  ['CUTTING',      'Cutting',       1, 1, 0, 0, null,      2],
  ['PREP',         'Prep',          0, 0, 0, 0, null,      3],
  ['STORAGE',      'Storage',       0, 0, 0, 0, null,      4],
  ['PACKING',      'Packing',       0, 0, 0, 1, null,      5],
  ['DISTRIBUTION', 'Distribution',  0, 0, 0, 0, null,      6],
];

const UNITS = [
  ['GM',  'Grams',  0, 1],
  ['ML',  'Millilitres', 0, 2],
  ['PCS', 'Pieces', 1, 3],
];

// The six cut types named in v10.2 s1.6. Admin can add more (the station sheets
// in the document also show "Shredded" and "Rough Chop").
const CUT_TYPES = [
  ['Chopped',  0, 1],
  ['Sliced',   0, 2],
  ['Diced',    0, 3],
  ['Julienne', 0, 4],
  ['Ring',     0, 5],
  ['Whole',    1, 6],
];

// v10.2 Rule 11: "Every Vegetable and Juice item needs Yield %."
// Expressed as a per-category flag so admin can extend the list.
const ITEM_CATEGORIES = [
  ['Vegetable', 1, 1],
  ['Juice',     1, 2],
  ['Other',     0, 3],
];

const SETTINGS = [
  ['cutoff_time', '00:30', 'Daily order submission cutoff (v10.2 Rule 1: 12:30 AM)'],
  ['quantity_rounding', 'HALF_UP', 'Rounding mode for calculated raw quantities'],
  ['quantity_decimals', '0', 'Decimal places kept on calculated raw quantities'],
];

function migrate({ silent = false } = {}) {
  const log = silent ? () => {} : console.log;

  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  for (const [table, column, definition] of COLUMN_ADDITIONS) {
    if (addColumnIfMissing(table, column, definition)) {
      log(`[migrate] added ${table}.${column}`);
    }
  }

  for (const r of ROLES) {
    run(`INSERT INTO roles (code, name, description, needs_location, needs_station, allows_pin, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           name = excluded.name, description = excluded.description,
           needs_location = excluded.needs_location, needs_station = excluded.needs_station,
           allows_pin = excluded.allows_pin, sort_order = excluded.sort_order`, r);
  }

  for (const p of PERMISSIONS) {
    run(`INSERT INTO permissions (code, description) VALUES (?, ?)
         ON CONFLICT(code) DO UPDATE SET description = excluded.description`, p);
  }

  run('DELETE FROM role_permissions');
  for (const [code] of PERMISSIONS) {
    run('INSERT INTO role_permissions (role_code, permission_code) VALUES (?, ?)', ['SUPER_ADMIN', code]);
  }
  for (const [roleCode, perms] of Object.entries(ROLE_PERMISSIONS)) {
    for (const code of perms) {
      run('INSERT INTO role_permissions (role_code, permission_code) VALUES (?, ?)', [roleCode, code]);
    }
  }

  for (const t of STATION_TYPES) {
    run(`INSERT INTO station_types
           (code, name, requires_cut_method, requires_cut_type, is_peeling, is_packing, feeds_into_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           name = excluded.name,
           requires_cut_method = excluded.requires_cut_method,
           requires_cut_type = excluded.requires_cut_type,
           is_peeling = excluded.is_peeling,
           is_packing = excluded.is_packing,
           feeds_into_type = excluded.feeds_into_type,
           sort_order = excluded.sort_order`, t);
  }

  for (const u of UNITS) {
    run(`INSERT INTO units (code, name, allows_piece_weight, sort_order) VALUES (?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET name = excluded.name,
           allows_piece_weight = excluded.allows_piece_weight, sort_order = excluded.sort_order`, u);
  }

  for (const c of CUT_TYPES) {
    if (!get('SELECT id FROM cut_types WHERE name = ?', [c[0]])) {
      run('INSERT INTO cut_types (name, is_whole, sort_order) VALUES (?, ?, ?)', c);
    }
  }

  for (const c of ITEM_CATEGORIES) {
    if (!get('SELECT id FROM item_categories WHERE name = ?', [c[0]])) {
      run('INSERT INTO item_categories (name, requires_yield, sort_order) VALUES (?, ?, ?)', c);
    }
  }

  for (const s of SETTINGS) {
    run(`INSERT INTO settings (key, value, description) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET description = excluded.description`, s);
  }

  ensureSuperAdmin(log);
  log('[migrate] schema + system vocabulary ready');
}

/** Creates the first Super Admin with a generated password, written to a gitignored file. */
function ensureSuperAdmin(log = console.log) {
  const existing = get("SELECT id FROM users WHERE role_code = 'SUPER_ADMIN' LIMIT 1");
  if (existing) return null;

  const username = process.env.KITCHOPS_ADMIN_USER || 'superadmin';
  const password = process.env.KITCHOPS_ADMIN_PASS || crypto.randomBytes(9).toString('base64url');
  run(`INSERT INTO users (full_name, username, password_hash, role_code, must_change_password)
       VALUES (?, ?, ?, 'SUPER_ADMIN', 1)`,
    ['Super Admin', username, bcrypt.hashSync(password, 10)]);

  const file = path.join(DATA_DIR, 'ADMIN_CREDENTIALS.txt');
  fs.writeFileSync(file,
    `KitchOps bootstrap Super Admin\nusername: ${username}\npassword: ${password}\n\n` +
    `Change this password after first login. This file is gitignored.\n`);
  log(`[migrate] Super Admin created — credentials written to ${file}`);
  return { username, password };
}

module.exports = { migrate, ensureSuperAdmin };

if (require.main === module) migrate();
