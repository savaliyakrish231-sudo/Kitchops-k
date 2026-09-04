'use strict';

/**
 * Lookups + supporting masters.
 *
 * /bootstrap is the single call every form makes to populate its dropdowns.
 * Station and location options ALWAYS come from here, never from a constant in
 * the frontend — that is what keeps stations configurable.
 */

const express = require('express');
const { all, get, run } = require('../db/connection');
const { requireAuth, requirePermission, has } = require('../middleware/auth');
const { wrap, fail, audit, bool, numOrNull, strOrNull, uniqueMessage } = require('./helpers');

const router = express.Router();

router.get('/bootstrap', requireAuth, wrap((req, res) => {
  const canSeeMasters = has(req.user, 'recipes.view') || has(req.user, 'users.view')
    || has(req.user, 'stations.view') || has(req.user, 'orders.submit');

  res.json({
    roles: all('SELECT * FROM roles ORDER BY sort_order'),
    stationTypes: all('SELECT * FROM station_types ORDER BY sort_order'),
    units: all('SELECT * FROM units WHERE is_active = 1 ORDER BY sort_order'),
    cutTypes: all('SELECT * FROM cut_types WHERE is_active = 1 ORDER BY sort_order, name COLLATE NOCASE'),
    itemCategories: all('SELECT * FROM item_categories WHERE is_active = 1 ORDER BY sort_order, name COLLATE NOCASE'),
    // Station Master — the dynamic source for every station dropdown in the app.
    stations: canSeeMasters
      ? all(`SELECT s.id, s.name, s.sheet_label, s.sheet_colour, s.type_code, s.sort_order, s.is_active, s.is_sample,
                    st.requires_cut_method, st.requires_cut_type, st.is_peeling, st.is_packing
               FROM stations s JOIN station_types st ON st.code = s.type_code
              ORDER BY s.sort_order, s.sheet_label, s.name COLLATE NOCASE`)
      : [],
    locations: canSeeMasters
      ? all('SELECT id, name, code, allows_method_2, is_active, is_sample FROM locations ORDER BY sort_order, name COLLATE NOCASE')
      : [],
    storageTypes: ['FRESH', 'FROZEN', 'DRY'],
    prepFrequencies: ['DAILY', 'BATCH'],
    methods: ['MACHINE', 'MANUAL'],
    shelfLifeUnits: ['DAYS', 'WEEKS', 'MONTHS'],
    settings: has(req.user, 'settings.manage')
      ? all('SELECT * FROM settings ORDER BY key')
      : all("SELECT key, value FROM settings WHERE key = 'cutoff_time'"),
    permissionCatalogue: all('SELECT * FROM permissions ORDER BY code'),
    rolePermissions: all('SELECT * FROM role_permissions ORDER BY role_code, permission_code'),
  });
}));

// ---------------------------------------------------------------------------
// Cut types  (admin-extendable — v10.2 lists six, the sheets show more)
// ---------------------------------------------------------------------------

router.get('/cut-types', requireAuth, wrap((req, res) => {
  res.json({ cutTypes: all('SELECT * FROM cut_types ORDER BY sort_order, name COLLATE NOCASE') });
}));

router.post('/cut-types', requirePermission('masters.manage'), wrap((req, res) => {
  const name = strOrNull(req.body?.name);
  if (!name) fail(400, 'Cut Type name is required.');
  let result;
  try {
    result = run('INSERT INTO cut_types (name, is_whole, sort_order, is_sample) VALUES (?, ?, ?, ?)',
      [name, bool(req.body?.is_whole), numOrNull(req.body?.sort_order) ?? 99, bool(req.body?.is_sample)]);
  } catch (err) {
    const msg = uniqueMessage(err, `A cut type named "${name}"`);
    if (msg) fail(409, msg);
    throw err;
  }
  audit(req, 'CUT_TYPE_CREATED', 'cut_type', Number(result.lastInsertRowid), name);
  res.status(201).json({ cutType: get('SELECT * FROM cut_types WHERE id = ?', [Number(result.lastInsertRowid)]) });
}));

router.put('/cut-types/:id', requirePermission('masters.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT 1 AS x FROM cut_types WHERE id = ?', [id])) fail(404, 'Cut Type not found.');
  const name = strOrNull(req.body?.name);
  if (!name) fail(400, 'Cut Type name is required.');
  run('UPDATE cut_types SET name = ?, is_whole = ?, sort_order = ?, is_active = ? WHERE id = ?',
    [name, bool(req.body?.is_whole), numOrNull(req.body?.sort_order) ?? 99,
      req.body?.is_active === undefined ? 1 : bool(req.body.is_active), id]);
  audit(req, 'CUT_TYPE_UPDATED', 'cut_type', id, name);
  res.json({ cutType: get('SELECT * FROM cut_types WHERE id = ?', [id]) });
}));

// ---------------------------------------------------------------------------
// Item categories — the flag that makes Yield % mandatory (v10.2 Rule 11)
// ---------------------------------------------------------------------------

router.get('/item-categories', requireAuth, wrap((req, res) => {
  res.json({ itemCategories: all('SELECT * FROM item_categories ORDER BY sort_order, name COLLATE NOCASE') });
}));

router.post('/item-categories', requirePermission('masters.manage'), wrap((req, res) => {
  const name = strOrNull(req.body?.name);
  if (!name) fail(400, 'Category name is required.');
  let result;
  try {
    result = run('INSERT INTO item_categories (name, requires_yield, sort_order, is_sample) VALUES (?, ?, ?, ?)',
      [name, bool(req.body?.requires_yield), numOrNull(req.body?.sort_order) ?? 99, bool(req.body?.is_sample)]);
  } catch (err) {
    const msg = uniqueMessage(err, `A category named "${name}"`);
    if (msg) fail(409, msg);
    throw err;
  }
  audit(req, 'CATEGORY_CREATED', 'item_category', Number(result.lastInsertRowid), name);
  res.status(201).json({ itemCategory: get('SELECT * FROM item_categories WHERE id = ?', [Number(result.lastInsertRowid)]) });
}));

router.put('/item-categories/:id', requirePermission('masters.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT 1 AS x FROM item_categories WHERE id = ?', [id])) fail(404, 'Category not found.');
  const name = strOrNull(req.body?.name);
  if (!name) fail(400, 'Category name is required.');
  run('UPDATE item_categories SET name = ?, requires_yield = ?, sort_order = ?, is_active = ? WHERE id = ?',
    [name, bool(req.body?.requires_yield), numOrNull(req.body?.sort_order) ?? 99,
      req.body?.is_active === undefined ? 1 : bool(req.body.is_active), id]);
  audit(req, 'CATEGORY_UPDATED', 'item_category', id, name);
  res.json({ itemCategory: get('SELECT * FROM item_categories WHERE id = ?', [id]) });
}));

// ---------------------------------------------------------------------------
// Settings (Super Admin) — cutoff time etc.
// ---------------------------------------------------------------------------

router.get('/settings', requirePermission('settings.manage'), wrap((req, res) => {
  res.json({ settings: all('SELECT * FROM settings ORDER BY key') });
}));

router.put('/settings/:key', requirePermission('settings.manage'), wrap((req, res) => {
  const key = req.params.key;
  if (!get('SELECT 1 AS x FROM settings WHERE key = ?', [key])) fail(404, 'Unknown setting.');
  const value = strOrNull(req.body?.value);
  if (key === 'cutoff_time' && value && !/^\d{2}:\d{2}$/.test(value)) {
    fail(400, 'Cutoff time must be in HH:MM (24-hour) format.');
  }
  run("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?", [value, key]);
  audit(req, 'SETTING_UPDATED', 'setting', key, value);
  res.json({ setting: get('SELECT * FROM settings WHERE key = ?', [key]) });
}));

// ---------------------------------------------------------------------------
// Sample data — clearly separated from real master data (v10.2 handover)
// ---------------------------------------------------------------------------

const SAMPLE_TABLES = [
  ['recipe_items', 'Recipe items'],
  ['users', 'Users'],
  ['stations', 'Stations'],
  ['locations', 'Locations'],
  ['cut_types', 'Cut types'],
  ['item_categories', 'Item categories'],
];

router.get('/sample-data', requirePermission('masters.manage'), wrap((req, res) => {
  res.json({
    counts: SAMPLE_TABLES.map(([table, label]) => ({
      table, label, count: get(`SELECT COUNT(*) AS n FROM ${table} WHERE is_sample = 1`).n,
    })),
  });
}));

/** One-click purge so tomorrow's real master data starts from a clean base. */
router.delete('/sample-data', requirePermission('masters.manage', 'users.manage'), wrap((req, res) => {
  const removed = {};
  // Children first, then parents, so foreign keys stay satisfied.
  removed.recipe_items = run('DELETE FROM recipe_items WHERE is_sample = 1').changes;
  run('DELETE FROM user_stations WHERE user_id IN (SELECT id FROM users WHERE is_sample = 1)');
  run('DELETE FROM user_locations WHERE user_id IN (SELECT id FROM users WHERE is_sample = 1)');
  run('DELETE FROM staff_attendance WHERE user_id IN (SELECT id FROM users WHERE is_sample = 1)');
  removed.users = run("DELETE FROM users WHERE is_sample = 1 AND role_code != 'SUPER_ADMIN'").changes;
  run('DELETE FROM user_stations WHERE station_id IN (SELECT id FROM stations WHERE is_sample = 1)');
  run('DELETE FROM sheet_runs WHERE station_id IN (SELECT id FROM stations WHERE is_sample = 1)');
  removed.stations = run('DELETE FROM stations WHERE is_sample = 1').changes;
  run('DELETE FROM recipe_location_overrides WHERE location_id IN (SELECT id FROM locations WHERE is_sample = 1)');
  removed.locations = run('DELETE FROM locations WHERE is_sample = 1').changes;
  removed.cut_types = run('DELETE FROM cut_types WHERE is_sample = 1').changes;
  removed.item_categories = run('DELETE FROM item_categories WHERE is_sample = 1').changes;

  audit(req, 'SAMPLE_DATA_PURGED', 'system', null, removed);
  res.json({ ok: true, removed });
}));

module.exports = router;
