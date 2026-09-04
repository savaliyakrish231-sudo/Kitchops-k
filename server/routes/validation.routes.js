'use strict';

/**
 * The sheet-generation gate and the calculation preview.
 *
 * These endpoints are the integration seam the sheet/task engine will call. They
 * exist now so the Phase 1 rules (yield, peeling, cut method, FROZEN, BATCH,
 * dynamic stations) are enforced and provable before the engine is written.
 */

const express = require('express');
const { all, get, run } = require('../db/connection');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const repo = require('../services/recipe.repo');
const rules = require('../services/recipe-rules.service');
const yieldSvc = require('../services/yield.service');
const roster = require('../services/roster.service');
const { wrap, fail, audit, numOrNull } = require('./helpers');

const router = express.Router();

function decimals() {
  const row = get("SELECT value FROM settings WHERE key = 'quantity_decimals'");
  const n = Number(row?.value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * SHEET READINESS — must be called before generating any station sheet.
 * `canGenerate:false` means generation is BLOCKED and `errors` carries the
 * documented messages verbatim.
 */
router.get('/sheet-readiness', requireAnyPermission('sheets.generate', 'recipes.view'), wrap((req, res) => {
  const stationId = req.query.stationId ? Number(req.query.stationId) : undefined;
  if (stationId && !get('SELECT 1 AS x FROM stations WHERE id = ?', [stationId])) {
    fail(404, 'Station not found.');
  }
  const result = repo.validateForSheetGeneration({ stationId });

  // Staffing is part of readiness: a station with items but nobody available
  // cannot have its tasks distributed.
  const date = roster.isDateString(req.query.date) ? req.query.date : roster.today();
  const staffing = roster.rosterOverview(date)
    .filter((s) => !stationId || s.station.id === stationId)
    .map((s) => ({
      stationId: s.station.id,
      stationName: s.station.name,
      assignedCount: s.assignedCount,
      availableCount: s.availableCount,
      itemCount: result.routed.filter((r) => r.stationId === s.station.id).length,
    }))
    .filter((s) => s.itemCount > 0 && s.availableCount === 0)
    .map((s) => ({
      code: 'NO_STAFF_AVAILABLE',
      station: s.stationName,
      message: `No counter person is available at ${s.stationName} on ${date}.`,
    }));

  res.json({ ...result, date, staffingWarnings: staffing });
}));

/**
 * Yield calculator — the same service the engine uses.
 * Accepts either an explicit yieldPercent or a recipe item id.
 */
router.post('/yield-calculator', requireAnyPermission('recipes.view', 'sheets.generate'), wrap((req, res) => {
  const netQuantity = numOrNull(req.body?.netQuantity);
  if (netQuantity === null) fail(400, 'netQuantity is required.');

  let yieldPercent = numOrNull(req.body?.yieldPercent);
  let item = null;

  if (req.body?.itemId) {
    item = repo.findById(Number(req.body.itemId));
    if (!item) fail(404, 'Recipe item not found.');
    if (yieldPercent === null) yieldPercent = item.yield_percent;

    if (yieldPercent === null && rules.requiresYield(item)) {
      // Never silently assume 100%.
      return res.status(422).json({
        blocked: true,
        code: 'YIELD_MISSING',
        error: rules.MESSAGES.yieldMissing(item.item_name),
      });
    }
  }
  if (yieldPercent === null) fail(400, 'yieldPercent is required when no recipe item is supplied.');

  try {
    const calc = yieldSvc.calculateRawQuantity(netQuantity, yieldPercent, {
      decimals: decimals(),
      itemName: item?.item_name,
    });
    res.json({
      ...calc,
      item: item ? { id: item.id, name: item.item_name, unit: item.unit_code } : null,
      formula: `Raw Qty = ${calc.netQuantity} / ${calc.yieldFraction} = ${calc.rawQuantity}`,
    });
  } catch (err) {
    if (err instanceof yieldSvc.YieldError) fail(422, err.message, { code: err.code });
    throw err;
  }
}));

/**
 * ORDER LINE CHECK — routing + calculation for one item at one location.
 * This is where Rules 21 (FROZEN) and 22 (BATCH) are enforced before an item is
 * ever sent to a station.
 */
router.post('/order-line', requireAnyPermission('orders.submit', 'sheets.generate', 'recipes.view'),
  wrap((req, res) => {
    const netQuantity = numOrNull(req.body?.netQuantity);
    const locationId = req.body?.locationId ? Number(req.body.locationId) : null;

    const item = req.body?.itemId
      ? repo.findById(Number(req.body.itemId))
      : repo.findByName(String(req.body?.itemName || '').trim());

    if (!item) {
      // v10.2 s1.13 — unrecognised items are flagged, not silently dropped.
      return res.status(200).json({
        accepted: false,
        code: 'UNRECOGNISED',
        message: `${req.body?.itemName || 'Item'} is not in the Recipe Database. Flagged UNRECOGNISED for admin review.`,
      });
    }

    const routing = rules.resolveRouting(item);

    // Rule 22 — BATCH items are blocked from the daily form.
    if (routing.route === rules.ROUTE.BLOCKED_BATCH) {
      return res.status(200).json({
        accepted: false,
        blocked: true,
        code: 'BATCH_ITEM',
        item: item.item_name,
        message: rules.MESSAGES.batchNotDaily(),
      });
    }

    const location = locationId ? get('SELECT * FROM locations WHERE id = ?', [locationId]) : null;
    if (locationId && !location) fail(400, 'Location not found.');

    // Rule 21 — FROZEN items produce a Packing Sheet line only. No station task.
    if (routing.route === rules.ROUTE.PACKING_ONLY) {
      return res.json({
        accepted: true,
        route: routing.route,
        item: item.item_name,
        createsStationTask: false,
        packingLine: rules.MESSAGES.frozenFromFreezer(
          netQuantity ?? '', item.unit_code, location?.name || 'each location'),
        message: routing.reason,
      });
    }

    const { errors } = rules.validateRecipeItem(item);
    if (errors.length) {
      return res.status(422).json({
        accepted: false, blocked: true, item: item.item_name,
        code: 'CONFIGURATION_INCOMPLETE',
        errors,
        message: 'Sheet generation is blocked for this item until its Recipe DB configuration is complete.',
      });
    }

    const override = locationId
      ? get(`SELECT o.*, ct.name AS cut_type_name FROM recipe_location_overrides o
               LEFT JOIN cut_types ct ON ct.id = o.cut_type_id
              WHERE o.recipe_item_id = ? AND o.location_id = ?`, [item.id, locationId])
      : null;
    const cut = rules.resolveCutForLocation(item, override);

    let calculation = null;
    if (netQuantity !== null && item.yield_percent !== null && item.yield_percent !== undefined) {
      calculation = yieldSvc.calculateRawQuantity(netQuantity, item.yield_percent,
        { decimals: decimals(), itemName: item.item_name });
    } else if (netQuantity !== null) {
      calculation = { netQuantity, yieldPercent: null, rawQuantity: netQuantity, note: 'No yield applies to this item.' };
    }

    res.json({
      accepted: true,
      route: routing.route,
      item: item.item_name,
      unit: item.unit_code,
      station: { id: item.station_id, name: item.station_name, type: item.station_type },
      location: location ? { id: location.id, name: location.name } : null,
      createsStationTask: true,
      // Rule 12 — peeling happens first, then cutting.
      peelingStep: rules.needsPeelingStep(item)
        ? { required: true, method: item.peeling_method, colour: rules.colourForMethod(item.peeling_method) }
        : { required: false },
      cut: { ...cut, wholeAkhaj: Number(item.whole_akhaj) === 1 },
      calculation,
    });
  }));

/**
 * STATION SHEET STRUCTURE — proves a newly created station is picked up with no
 * code change: it lists every active station with the items routed to it and the
 * persons who would receive those tasks.
 */
router.get('/station-preview', requireAnyPermission('sheets.view_all', 'stations.view'), wrap((req, res) => {
  const date = roster.isDateString(req.query.date) ? req.query.date : roster.today();
  const stations = all(`
    SELECT s.*, st.name AS type_name, st.requires_cut_method, st.is_peeling, st.is_packing
      FROM stations s JOIN station_types st ON st.code = s.type_code
     WHERE s.is_active = 1
     ORDER BY s.sort_order, s.sheet_label, s.name COLLATE NOCASE`);

  const sheets = stations.map((station) => {
    const items = repo.list({ stationId: station.id, activeOnly: true });
    const rows = items
      .map((item) => ({ item, routing: rules.resolveRouting(item), check: rules.validateRecipeItem(item) }))
      .filter((r) => r.routing.route === rules.ROUTE.STATION)
      .map((r) => ({
        itemId: r.item.id,
        item: r.item.item_name,
        unit: r.item.unit_code,
        cutType: r.item.cut_type_name,
        method: r.item.default_cut_method,
        colour: rules.colourForMethod(r.item.default_cut_method),
        yieldPercent: r.item.yield_percent,
        needsPeeling: Number(r.item.needs_peeling) === 1,
        peelingMethod: r.item.peeling_method,
        blocking: r.check.errors,
      }));

    const staff = roster.stationRoster(station.id, date);
    const preview = roster.distributeRoundRobin(rows, staff.filter((p) => p.available));

    return {
      station: {
        id: station.id, name: station.name, sheetLabel: station.sheet_label,
        sheetColour: station.sheet_colour, type: station.type_code, typeName: station.type_name,
      },
      itemCount: rows.length,
      rows,
      staff,
      taskDistribution: preview.perPerson.map((p) => ({
        userId: p.userId, fullName: p.fullName, taskCount: p.taskCount,
        items: p.tasks.map((t) => t.item),
      })),
      blocked: rows.some((r) => r.blocking.length > 0),
      blockingErrors: rows.flatMap((r) => r.blocking),
      warnings: [
        ...(staff.filter((p) => p.available).length === 0 && rows.length
          ? [`No counter person is available at ${station.name} on ${date}.`] : []),
        ...(rows.length === 0 ? [`No recipe items are assigned to ${station.name} yet.`] : []),
      ],
    };
  });

  // FROZEN items never reach a station — they belong on the Packing Sheet only.
  const frozen = repo.list({ activeOnly: true, storageType: 'FROZEN' }).map((i) => ({
    itemId: i.id, item: i.item_name, unit: i.unit_code,
    packingLine: rules.MESSAGES.frozenFromFreezer('[Qty]', i.unit_code, '[Location]'),
  }));
  const batch = repo.list({ activeOnly: true, prepFrequency: 'BATCH' }).map((i) => ({
    itemId: i.id, item: i.item_name, reason: rules.MESSAGES.batchNotDaily(),
  }));

  res.json({
    date,
    stationCount: sheets.length,
    sheets,
    frozenPackingOnly: frozen,
    batchExcluded: batch,
    note: 'One sheet per active station in Station Master. Adding a station here requires no code change.',
  });
}));

/**
 * Records that sheets were generated for a date, so a later Yield % edit knows
 * to raise the "Recalculate all sheets?" prompt. The engine itself is separate.
 */
router.post('/sheet-runs', requirePermission('sheets.generate'), wrap((req, res) => {
  const date = roster.isDateString(req.body?.date) ? req.body.date : roster.today();
  const gate = repo.validateForSheetGeneration({});
  if (!gate.canGenerate) {
    return res.status(422).json({
      generated: false, blocked: true,
      message: 'Sheet generation is blocked. Fix the Recipe DB errors listed below.',
      errors: gate.errors,
    });
  }
  const stations = all('SELECT id FROM stations WHERE is_active = 1');
  for (const s of stations) {
    run(`INSERT INTO sheet_runs (work_date, station_id, status) VALUES (?, ?, 'GENERATED')
         ON CONFLICT(work_date, station_id) DO UPDATE SET status = 'GENERATED', generated_at = datetime('now')`,
      [date, s.id]);
  }
  audit(req, 'SHEET_RUN_RECORDED', 'sheet_run', date, { stations: stations.length });
  res.json({ generated: true, date, stations: stations.length, ...gate });
}));

router.get('/sheet-runs', requireAnyPermission('sheets.view_all', 'recipes.view'), wrap((req, res) => {
  const date = roster.isDateString(req.query.date) ? req.query.date : roster.today();
  res.json({
    date,
    runs: all(`SELECT sr.*, s.name AS station_name FROM sheet_runs sr
                 JOIN stations s ON s.id = sr.station_id
                WHERE sr.work_date = ? ORDER BY s.sort_order, s.name`, [date]),
  });
}));

module.exports = router;
