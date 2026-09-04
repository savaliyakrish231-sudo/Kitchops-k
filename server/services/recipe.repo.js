'use strict';

/**
 * Data access for the Recipe DB.
 *
 * ENRICHED_SELECT joins every flag the rule engine needs, so recipe-rules.service
 * can stay pure and name-agnostic.
 */

const { all, get } = require('../db/connection');
const rules = require('./recipe-rules.service');

const ENRICHED_SELECT = `
  SELECT r.*,
         s.name        AS station_name,
         s.type_code   AS station_type,
         s.is_active   AS station_active,
         s.sheet_label AS station_sheet_label,
         s.sheet_colour AS station_sheet_colour,
         st.requires_cut_method AS station_requires_cut_method,
         st.requires_cut_type   AS station_requires_cut_type,
         st.is_peeling          AS station_is_peeling,
         st.is_packing          AS station_is_packing,
         st.feeds_into_type     AS station_feeds_into_type,
         c.name           AS category_name,
         c.requires_yield AS category_requires_yield,
         u.allows_piece_weight AS unit_allows_piece_weight,
         ct.name     AS cut_type_name,
         ct.is_whole AS cut_type_is_whole
    FROM recipe_items r
    LEFT JOIN stations        s  ON s.id  = r.station_id
    LEFT JOIN station_types   st ON st.code = s.type_code
    LEFT JOIN item_categories c  ON c.id  = r.category_id
    LEFT JOIN units           u  ON u.code = r.unit_code
    LEFT JOIN cut_types       ct ON ct.id = r.default_cut_type_id
`;

function findById(id) {
  return get(`${ENRICHED_SELECT} WHERE r.id = ?`, [id]);
}

function findByName(name) {
  return get(`${ENRICHED_SELECT} WHERE r.item_name = ?`, [name]);
}

function list(filters = {}) {
  const where = [];
  const params = [];

  if (filters.stationId) { where.push('r.station_id = ?'); params.push(Number(filters.stationId)); }
  if (filters.categoryId) { where.push('r.category_id = ?'); params.push(Number(filters.categoryId)); }
  if (filters.storageType) { where.push('r.storage_type = ?'); params.push(String(filters.storageType).toUpperCase()); }
  if (filters.prepFrequency) { where.push('r.prep_frequency = ?'); params.push(String(filters.prepFrequency).toUpperCase()); }
  if (filters.activeOnly) { where.push('r.is_active = 1'); }
  if (filters.includeSample === false) { where.push('r.is_sample = 0'); }
  if (filters.search) { where.push('r.item_name LIKE ?'); params.push(`%${filters.search}%`); }
  if (filters.missingYieldOnly) {
    where.push('c.requires_yield = 1 AND (r.yield_percent IS NULL OR r.yield_percent <= 0)');
  }

  const sql = `${ENRICHED_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.item_name COLLATE NOCASE`;
  return all(sql, params);
}

function overridesFor(recipeItemId) {
  return all(`
    SELECT o.*, l.name AS location_name, l.is_active AS location_active, ct.name AS cut_type_name
      FROM recipe_location_overrides o
      JOIN locations l  ON l.id  = o.location_id
      LEFT JOIN cut_types ct ON ct.id = o.cut_type_id
     WHERE o.recipe_item_id = ?
     ORDER BY l.sort_order, l.name COLLATE NOCASE`, [recipeItemId]);
}

/**
 * The per-location effective cut plan for an item (v10.2 Rule 13), covering every
 * active location — those without an override inherit the item default.
 */
function cutPlanFor(item) {
  const overrides = overridesFor(item.id);
  const byLocation = new Map(overrides.map((o) => [o.location_id, o]));
  const locations = all('SELECT id, name FROM locations WHERE is_active = 1 ORDER BY sort_order, name COLLATE NOCASE');

  return locations.map((loc) => {
    const resolved = rules.resolveCutForLocation(item, byLocation.get(loc.id) || null);
    return { locationId: loc.id, locationName: loc.name, ...resolved };
  });
}

/**
 * THE SHEET-GENERATION GATE (v10.2 s1.13).
 *
 * Validates every item that would take part in a day's sheets and reports the
 * documented blocking errors. Sheet generation must call this and refuse to run
 * while `canGenerate` is false.
 *
 * @param {{stationId?: number}} opts  limit to items routed to one station
 */
function validateForSheetGeneration(opts = {}) {
  const items = list({ activeOnly: true, stationId: opts.stationId });

  const errors = [];
  const warnings = [];
  const routed = [];
  const packingOnly = [];
  const excludedBatch = [];

  for (const item of items) {
    const { errors: e, warnings: w, routing } = rules.validateRecipeItem(item);
    errors.push(...e.map((x) => ({ ...x, station: item.station_name || null })));
    warnings.push(...w.map((x) => ({ ...x, station: item.station_name || null })));

    const summary = {
      itemId: item.id,
      item: item.item_name,
      station: item.station_name || null,
      stationId: item.station_id || null,
      route: routing.route,
      reason: routing.reason,
    };
    if (routing.route === rules.ROUTE.STATION) routed.push(summary);
    else if (routing.route === rules.ROUTE.PACKING_ONLY) packingOnly.push(summary);
    else if (routing.route === rules.ROUTE.BLOCKED_BATCH) excludedBatch.push(summary);
  }

  const blockedStations = [...new Set(errors.map((e) => e.station).filter(Boolean))];

  return {
    canGenerate: errors.length === 0,
    checkedItems: items.length,
    errors,
    warnings,
    blockedStations,
    routed,
    packingOnly,
    excludedBatch,
  };
}

/**
 * Validates a single item, used by the Recipe DB form to show live status.
 */
function validateOne(id) {
  const item = findById(id);
  if (!item) return null;
  const { errors, warnings, routing } = rules.validateRecipeItem(item);
  return { item, errors, warnings, routing, ready: errors.length === 0 };
}

module.exports = {
  ENRICHED_SELECT,
  findById,
  findByName,
  list,
  overridesFor,
  cutPlanFor,
  validateForSheetGeneration,
  validateOne,
};
