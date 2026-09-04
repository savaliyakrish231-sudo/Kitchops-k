'use strict';

/**
 * RECIPE DATABASE (v10.2 s1.6) including Yield %, cut configuration,
 * peeling configuration and per-location cutting overrides.
 *
 * Saving an incomplete row is allowed on purpose — admin populates the Recipe DB
 * over days (v10.2 Rule 17) and each save reports what is still missing. The hard
 * stop lives on the sheet-generation gate (see validation.routes.js).
 */

const express = require('express');
const { all, get, run, tx } = require('../db/connection');
const { requirePermission } = require('../middleware/auth');
const repo = require('../services/recipe.repo');
const rules = require('../services/recipe-rules.service');
const yieldSvc = require('../services/yield.service');
const roster = require('../services/roster.service');
const { wrap, fail, audit, numOrNull, strOrNull, uniqueMessage } = require('./helpers');

const router = express.Router();

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

router.get('/', requirePermission('recipes.view'), wrap((req, res) => {
  const items = repo.list({
    stationId: req.query.stationId,
    categoryId: req.query.categoryId,
    storageType: req.query.storageType,
    prepFrequency: req.query.prepFrequency,
    activeOnly: req.query.activeOnly === 'true',
    includeSample: req.query.includeSample === 'false' ? false : undefined,
    search: req.query.search,
    missingYieldOnly: req.query.missingYieldOnly === 'true',
  });

  res.json({
    items: items.map((item) => {
      const { errors, warnings, routing } = rules.validateRecipeItem(item);
      return {
        ...item,
        routing,
        methodColour: rules.colourForMethod(item.default_cut_method),
        issueCount: errors.length,
        issues: errors,
        warnings,
        ready: errors.length === 0,
      };
    }),
  });
}));

/** Every yield change still awaiting a recalculation decision. */
router.get('/yield-changes/pending', requirePermission('recipes.view'), wrap((req, res) => {
  res.json({
    pending: all(`
      SELECT y.*, r.item_name, s.name AS station_name
        FROM yield_change_log y
        JOIN recipe_items r ON r.id = y.recipe_item_id
        LEFT JOIN stations s ON s.id = r.station_id
       WHERE y.recalc_status = 'PENDING' ORDER BY y.changed_at DESC`),
  });
}));

router.get('/:id', requirePermission('recipes.view'), wrap((req, res) => {
  const item = repo.findById(Number(req.params.id));
  if (!item) fail(404, 'Recipe item not found.');
  const { errors, warnings, routing } = rules.validateRecipeItem(item);
  res.json({
    item,
    overrides: repo.overridesFor(item.id),
    cutPlan: repo.cutPlanFor(item),
    routing,
    errors,
    warnings,
    ready: errors.length === 0,
    methodColour: rules.colourForMethod(item.default_cut_method),
    yieldHistory: all(
      `SELECT y.*, u.full_name AS changed_by_name FROM yield_change_log y
         LEFT JOIN users u ON u.id = y.changed_by
        WHERE y.recipe_item_id = ? ORDER BY y.changed_at DESC LIMIT 25`, [item.id]),
  });
}));

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

/** Resolves the context recipe-rules needs to normalise a payload. */
function normalizationContext(body) {
  const whole = get('SELECT id FROM cut_types WHERE is_whole = 1 ORDER BY sort_order LIMIT 1');
  const unitCode = strOrNull(body.unit_code);
  const unit = unitCode ? get('SELECT * FROM units WHERE code = ?', [unitCode]) : null;
  if (unitCode && !unit) fail(400, `Unknown unit "${unitCode}".`);
  return {
    wholeCutTypeId: whole ? whole.id : null,
    unitAllowsPieceWeight: unit ? Number(unit.allows_piece_weight) === 1 : undefined,
  };
}

function validateReferences(v) {
  if (v.station_id && !get('SELECT 1 AS x FROM stations WHERE id = ?', [v.station_id])) {
    fail(400, 'Selected station does not exist in Station Master.');
  }
  if (v.category_id && !get('SELECT 1 AS x FROM item_categories WHERE id = ?', [v.category_id])) {
    fail(400, 'Selected item category does not exist.');
  }
  if (v.default_cut_type_id && !get('SELECT 1 AS x FROM cut_types WHERE id = ?', [v.default_cut_type_id])) {
    fail(400, 'Selected cut type does not exist.');
  }
  if (v.yield_percent !== null && !yieldSvc.isValidYieldPercent(v.yield_percent)) {
    fail(400, `Yield % must be between ${yieldSvc.MIN_YIELD} and ${yieldSvc.MAX_YIELD}.`);
  }
  if (v.piece_weight !== null && !(Number(v.piece_weight) > 0)) {
    fail(400, 'Piece Weight must be greater than zero.');
  }
  if (v.shelf_life_value !== null && !(Number(v.shelf_life_value) > 0)) {
    fail(400, 'Shelf Life must be greater than zero.');
  }
  if (v.shelf_life_value !== null && !v.shelf_life_unit) {
    fail(400, 'Shelf Life unit is required when a shelf life value is entered.');
  }
}

const COLUMNS = [
  'item_name', 'station_id', 'category_id', 'unit_code', 'default_cut_type_id', 'default_cut_method',
  'whole_akhaj', 'needs_peeling', 'peeling_method', 'yield_percent', 'piece_weight',
  'is_filling_ingredient', 'prep_frequency', 'shelf_life_value', 'shelf_life_unit',
  'storage_type', 'is_active', 'is_sample', 'notes',
];

router.post('/', requirePermission('recipes.manage'), wrap((req, res) => {
  const body = req.body || {};
  const { values, notes } = rules.normalizeRecipeInput(body, normalizationContext(body));
  if (!values.item_name) fail(400, 'Item Name is required.');
  validateReferences(values);

  let result;
  try {
    result = run(
      `INSERT INTO recipe_items (${COLUMNS.join(', ')}, updated_by)
       VALUES (${COLUMNS.map(() => '?').join(', ')}, ?)`,
      [...COLUMNS.map((c) => values[c] ?? null), req.user.id]);
  } catch (err) {
    const msg = uniqueMessage(err, `A recipe item named "${values.item_name}"`);
    if (msg) fail(409, msg);
    throw err;
  }
  const id = Number(result.lastInsertRowid);

  if (values.yield_percent !== null) {
    run('INSERT INTO yield_change_log (recipe_item_id, old_yield, new_yield, changed_by, recalc_status) VALUES (?, NULL, ?, ?, ?)',
      [id, values.yield_percent, req.user.id, 'NOT_REQUIRED']);
  }
  audit(req, 'RECIPE_CREATED', 'recipe_item', id, values.item_name);

  const check = repo.validateOne(id);
  res.status(201).json({
    item: check.item, autoAdjustments: notes,
    errors: check.errors, warnings: check.warnings, ready: check.ready, routing: check.routing,
  });
}));

router.put('/:id', requirePermission('recipes.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  const before = get('SELECT * FROM recipe_items WHERE id = ?', [id]);
  if (!before) fail(404, 'Recipe item not found.');

  const body = req.body || {};
  const { values, notes } = rules.normalizeRecipeInput(body, normalizationContext(body));
  if (!values.item_name) fail(400, 'Item Name is required.');
  validateReferences(values);

  try {
    run(`UPDATE recipe_items SET ${COLUMNS.map((c) => `${c} = ?`).join(', ')},
           updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
      [...COLUMNS.map((c) => values[c] ?? null), req.user.id, id]);
  } catch (err) {
    const msg = uniqueMessage(err, `A recipe item named "${values.item_name}"`);
    if (msg) fail(409, msg);
    throw err;
  }

  // v10.2 s1.13 — "Yield % changed after sheets generated -> Recalculate all sheets?"
  let recalculation = null;
  const oldYield = before.yield_percent;
  const newYield = values.yield_percent;
  if (Number(oldYield) !== Number(newYield) && !(oldYield == null && newYield == null)) {
    recalculation = recordYieldChange(id, oldYield, newYield, req.user.id);
  }

  audit(req, 'RECIPE_UPDATED', 'recipe_item', id, { item: values.item_name, oldYield, newYield });
  const check = repo.validateOne(id);
  res.json({
    item: check.item, autoAdjustments: notes,
    errors: check.errors, warnings: check.warnings, ready: check.ready, routing: check.routing,
    recalculation,
  });
}));

router.patch('/:id/status', requirePermission('recipes.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT 1 AS x FROM recipe_items WHERE id = ?', [id])) fail(404, 'Recipe item not found.');
  const active = req.body?.is_active ? 1 : 0;
  run("UPDATE recipe_items SET is_active = ?, updated_at = datetime('now') WHERE id = ?", [active, id]);
  audit(req, active ? 'RECIPE_ACTIVATED' : 'RECIPE_DEACTIVATED', 'recipe_item', id);
  res.json({ item: repo.findById(id) });
}));

// ---------------------------------------------------------------------------
// Yield-specific endpoints
// ---------------------------------------------------------------------------

/** Focused Yield % edit — same recalculation prompt as a full save. */
router.patch('/:id/yield', requirePermission('recipes.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  const before = get('SELECT * FROM recipe_items WHERE id = ?', [id]);
  if (!before) fail(404, 'Recipe item not found.');

  const newYield = numOrNull(req.body?.yield_percent);
  if (newYield !== null && !yieldSvc.isValidYieldPercent(newYield)) {
    fail(400, `Yield % must be between ${yieldSvc.MIN_YIELD} and ${yieldSvc.MAX_YIELD}.`);
  }
  run("UPDATE recipe_items SET yield_percent = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
    [newYield, req.user.id, id]);

  const recalculation = Number(before.yield_percent) === Number(newYield)
    ? null
    : recordYieldChange(id, before.yield_percent, newYield, req.user.id);

  audit(req, 'YIELD_CHANGED', 'recipe_item', id, { from: before.yield_percent, to: newYield });
  const check = repo.validateOne(id);
  res.json({ item: check.item, errors: check.errors, ready: check.ready, recalculation });
}));

/**
 * Logs a yield change and reports whether generated sheets are now stale.
 * Returns the prompt payload the UI shows: "Recalculate all sheets?"
 */
function recordYieldChange(recipeItemId, oldYield, newYield, actorId) {
  const item = repo.findById(recipeItemId);
  const affected = item.station_id
    ? all(`SELECT sr.*, s.name AS station_name FROM sheet_runs sr JOIN stations s ON s.id = sr.station_id
            WHERE sr.station_id = ? AND sr.status IN ('GENERATED','RECALCULATED') AND sr.work_date >= ?`,
      [item.station_id, roster.today()])
    : [];

  const status = affected.length ? 'PENDING' : 'NOT_REQUIRED';
  const inserted = run(
    'INSERT INTO yield_change_log (recipe_item_id, old_yield, new_yield, changed_by, recalc_status) VALUES (?, ?, ?, ?, ?)',
    [recipeItemId, oldYield, newYield, actorId, status]);

  return {
    changeId: Number(inserted.lastInsertRowid),
    oldYield, newYield,
    requiresRecalculation: affected.length > 0,
    prompt: affected.length ? 'Recalculate all sheets?' : null,
    affectedSheets: affected.map((s) => ({
      sheetRunId: s.id, workDate: s.work_date, stationId: s.station_id, stationName: s.station_name,
    })),
  };
}

/** Confirms the "Recalculate all sheets?" prompt — marks affected sheets stale. */
router.post('/yield-changes/:changeId/recalculate', requirePermission('recipes.manage', 'sheets.generate'),
  wrap((req, res) => {
    const changeId = Number(req.params.changeId);
    const change = get('SELECT * FROM yield_change_log WHERE id = ?', [changeId]);
    if (!change) fail(404, 'Yield change not found.');
    if (change.recalc_status !== 'PENDING') fail(409, 'This yield change has already been resolved.');

    const confirmed = req.body?.confirm !== false;
    const item = repo.findById(change.recipe_item_id);
    let marked = [];

    tx(() => {
      if (confirmed && item.station_id) {
        marked = all(
          `SELECT id FROM sheet_runs WHERE station_id = ? AND work_date >= ? AND status IN ('GENERATED','RECALCULATED')`,
          [item.station_id, roster.today()]);
        for (const row of marked) {
          run("UPDATE sheet_runs SET status = 'STALE' WHERE id = ?", [row.id]);
        }
      }
      run("UPDATE yield_change_log SET recalc_status = ?, resolved_at = datetime('now'), resolved_by = ? WHERE id = ?",
        [confirmed ? 'CONFIRMED' : 'DISMISSED', req.user.id, changeId]);
    });

    audit(req, confirmed ? 'SHEETS_MARKED_FOR_RECALC' : 'RECALC_DISMISSED', 'recipe_item', change.recipe_item_id,
      { changeId, sheetsMarked: marked.length });
    res.json({ ok: true, confirmed, sheetsMarkedStale: marked.length });
  }));


// ---------------------------------------------------------------------------
// Location cutting overrides (v10.2 Rule 13)
// ---------------------------------------------------------------------------

router.get('/:id/overrides', requirePermission('recipes.view'), wrap((req, res) => {
  const item = repo.findById(Number(req.params.id));
  if (!item) fail(404, 'Recipe item not found.');
  res.json({ overrides: repo.overridesFor(item.id), cutPlan: repo.cutPlanFor(item) });
}));

/** Creates or replaces the override for one location. */
router.put('/:id/overrides/:locationId', requirePermission('recipes.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  const locationId = Number(req.params.locationId);
  const item = repo.findById(id);
  if (!item) fail(404, 'Recipe item not found.');
  if (!get('SELECT 1 AS x FROM locations WHERE id = ?', [locationId])) fail(400, 'Location does not exist.');

  const cutTypeId = numOrNull(req.body?.cut_type_id);
  const cutMethod = strOrNull(req.body?.cut_method)?.toUpperCase() || null;
  if (cutTypeId && !get('SELECT 1 AS x FROM cut_types WHERE id = ?', [cutTypeId])) {
    fail(400, 'Selected cut type does not exist.');
  }
  if (cutMethod && !['MACHINE', 'MANUAL'].includes(cutMethod)) {
    fail(400, 'Cut Method must be MACHINE or MANUAL.');
  }
  if (cutTypeId === null && cutMethod === null) {
    fail(400, 'An override must set a cut type, a cut method, or both.');
  }
  if (Number(item.whole_akhaj) === 1) {
    fail(409, `${item.item_name} is marked Whole / Akhaj — its cut type is fixed to WHOLE and cannot be overridden per location.`);
  }

  run(`INSERT INTO recipe_location_overrides (recipe_item_id, location_id, cut_type_id, cut_method, notes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(recipe_item_id, location_id) DO UPDATE SET
         cut_type_id = excluded.cut_type_id, cut_method = excluded.cut_method, notes = excluded.notes`,
    [id, locationId, cutTypeId, cutMethod, strOrNull(req.body?.notes)]);

  audit(req, 'OVERRIDE_SAVED', 'recipe_item', id, { locationId, cutTypeId, cutMethod });
  res.json({ overrides: repo.overridesFor(id), cutPlan: repo.cutPlanFor(repo.findById(id)) });
}));

router.delete('/:id/overrides/:locationId', requirePermission('recipes.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  const locationId = Number(req.params.locationId);
  const result = run('DELETE FROM recipe_location_overrides WHERE recipe_item_id = ? AND location_id = ?',
    [id, locationId]);
  if (!result.changes) fail(404, 'No override exists for that location.');
  audit(req, 'OVERRIDE_REMOVED', 'recipe_item', id, { locationId });
  res.json({ overrides: repo.overridesFor(id), cutPlan: repo.cutPlanFor(repo.findById(id)) });
}));

module.exports = router;
