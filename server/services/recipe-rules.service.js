'use strict';

/**
 * Recipe DB business rules from v10.2 — normalisation, validation and routing.
 *
 * Every rule below is keyed off DATA (station_types flags, item_categories flags,
 * cut_types.is_whole) and never off a station, item or location NAME.
 *
 * Pure functions. The caller supplies an "enriched" recipe row: the recipe_items
 * columns plus the joined flags listed in ENRICHED_SHAPE below.
 */

const { validateItemYield, requiresYield } = require('./yield.service');

/**
 * ENRICHED_SHAPE — what a row passed to these functions must carry:
 *   id, item_name, unit_code, station_id, storage_type, prep_frequency,
 *   needs_peeling, peeling_method, whole_akhaj, default_cut_method,
 *   default_cut_type_id, yield_percent, piece_weight, shelf_life_value,
 *   shelf_life_unit, is_active
 *   station_name, station_type, station_active,
 *   station_requires_cut_method, station_requires_cut_type, station_is_peeling,
 *   station_is_packing, station_feeds_into_type,
 *   category_requires_yield,
 *   unit_allows_piece_weight,
 *   cut_type_name, cut_type_is_whole
 */

// v10.2 Rule 5 — MANDATORY colour coding. Machine = Blue, Manual = Orange.
const METHOD_COLOURS = Object.freeze({
  MACHINE: Object.freeze({ method: 'MACHINE', colourName: 'Blue',   hex: '#1d4ed8', cssClass: 'method-machine' }),
  MANUAL:  Object.freeze({ method: 'MANUAL',  colourName: 'Orange', hex: '#ea580c', cssClass: 'method-manual'  }),
});

/** Colour token for a MACHINE/MANUAL method. Never inline these colours elsewhere. */
function colourForMethod(method) {
  return METHOD_COLOURS[String(method || '').toUpperCase()] || null;
}

const ROUTE = Object.freeze({
  STATION: 'STATION',              // normal: generate a task on the item's station
  PACKING_ONLY: 'PACKING_ONLY',    // v10.2 Rule 21 — FROZEN
  BLOCKED_BATCH: 'BLOCKED_BATCH',  // v10.2 Rule 22 — BATCH
  UNROUTABLE: 'UNROUTABLE',        // no active station configured yet
});

/** Exact wording required by v10.2 s1.13 / Rule 22. */
const MESSAGES = {
  yieldMissing: (item) => `Yield % missing for ${item}.`,
  peelingMethodMissing: (item) => `Peeling Method (Machine/Manual) not defined for ${item}.`,
  cutMethodMissing: (item) => `Machine/Manual not defined for ${item}.`,
  batchNotDaily: () => 'This is a batch-prep item — not prepared daily.',
  frozenFromFreezer: (qty, unit, location) =>
    `Take ${qty}${unit ? ' ' + unit : ''} from Freezer → pack for ${location}`,
};

// ---------------------------------------------------------------------------
// Normalisation — applied when a recipe row is saved.
// ---------------------------------------------------------------------------

/**
 * Coerces a submitted recipe payload into a consistent state.
 * Returns { values, notes } where notes explain each automatic adjustment.
 *
 * @param {object} input   raw payload from the form
 * @param {object} ctx     { wholeCutTypeId, unitAllowsPieceWeight, stationRequiresCutType }
 */
function normalizeRecipeInput(input, ctx = {}) {
  const v = { ...input };
  const notes = [];

  const bool = (x) => (x === true || x === 1 || x === '1' || x === 'true' || x === 'on' ? 1 : 0);
  const num = (x) => (x === '' || x === null || x === undefined ? null : Number(x));
  const upper = (x) => (x === '' || x === null || x === undefined ? null : String(x).toUpperCase());

  v.item_name = String(v.item_name || '').trim();
  v.whole_akhaj = bool(v.whole_akhaj);
  v.needs_peeling = bool(v.needs_peeling);
  v.is_filling_ingredient = bool(v.is_filling_ingredient);
  v.is_active = v.is_active === undefined ? 1 : bool(v.is_active);
  v.is_sample = bool(v.is_sample);
  v.yield_percent = num(v.yield_percent);
  v.piece_weight = num(v.piece_weight);
  v.shelf_life_value = num(v.shelf_life_value);
  v.station_id = num(v.station_id);
  v.category_id = num(v.category_id);
  v.default_cut_type_id = num(v.default_cut_type_id);
  v.default_cut_method = upper(v.default_cut_method);
  v.peeling_method = upper(v.peeling_method);
  v.shelf_life_unit = upper(v.shelf_life_unit);
  v.storage_type = upper(v.storage_type) || 'FRESH';
  v.prep_frequency = upper(v.prep_frequency) || 'DAILY';
  v.unit_code = upper(v.unit_code);

  // v10.2 Rule 14 — Whole/Akhaj forces cut type WHOLE and an Orange (MANUAL) row.
  // Yield % still applies; nothing here bypasses it.
  if (v.whole_akhaj) {
    if (ctx.wholeCutTypeId && v.default_cut_type_id !== ctx.wholeCutTypeId) {
      v.default_cut_type_id = ctx.wholeCutTypeId;
      notes.push('Whole / Akhaj is ON — Cut Type set to WHOLE automatically.');
    }
    if (v.default_cut_method !== 'MANUAL') {
      v.default_cut_method = 'MANUAL';
      notes.push('Whole / Akhaj is ON — Cut Method set to MANUAL (Orange row).');
    }
  }

  // Peeling Method only exists when Needs Peeling = YES.
  if (!v.needs_peeling && v.peeling_method) {
    v.peeling_method = null;
    notes.push('Needs Peeling is OFF — Peeling Method cleared.');
  }

  // Shelf Life is a BATCH-only field (v10.2 s1.6).
  if (v.prep_frequency !== 'BATCH' && (v.shelf_life_value !== null || v.shelf_life_unit)) {
    v.shelf_life_value = null;
    v.shelf_life_unit = null;
    notes.push('Prep Frequency is DAILY — Shelf Life cleared (Shelf Life applies to BATCH items).');
  }

  // Piece Weight applies only when the unit supports it (Unit = PCS).
  if (v.piece_weight !== null && ctx.unitAllowsPieceWeight === false) {
    v.piece_weight = null;
    notes.push('Piece Weight cleared — it applies only when Unit = PCS.');
  }

  if (!v.peeling_method) v.peeling_method = null;
  if (!v.default_cut_method) v.default_cut_method = null;
  if (!v.shelf_life_unit) v.shelf_life_unit = null;

  return { values: v, notes };
}

// ---------------------------------------------------------------------------
// Routing — decided BEFORE an item is sent to any station (v10.2 Rules 21/22).
// ---------------------------------------------------------------------------

/**
 * Where does this item go today?
 * @returns {{route: string, stationId: number|null, stationName: string|null, reason: string, blocking: boolean}}
 */
function resolveRouting(item) {
  // Rule 22 — BATCH items never appear on daily prep sheets.
  if (item.prep_frequency === 'BATCH') {
    return {
      route: ROUTE.BLOCKED_BATCH,
      stationId: null,
      stationName: null,
      reason: MESSAGES.batchNotDaily(),
      blocking: true,
    };
  }

  // Rule 21 — FROZEN items are already prepared. No station task at all.
  if (item.storage_type === 'FROZEN') {
    return {
      route: ROUTE.PACKING_ONLY,
      stationId: null,
      stationName: null,
      reason: 'Storage Type is FROZEN — Packing Sheet only, no station task.',
      blocking: false,
    };
  }

  if (!item.station_id || Number(item.station_active) === 0) {
    return {
      route: ROUTE.UNROUTABLE,
      stationId: item.station_id || null,
      stationName: item.station_name || null,
      reason: item.station_id
        ? `Station "${item.station_name}" is inactive.`
        : `No station assigned for ${item.item_name}.`,
      blocking: true,
    };
  }

  return {
    route: ROUTE.STATION,
    stationId: item.station_id,
    stationName: item.station_name,
    reason: `Routed to ${item.station_name}.`,
    blocking: false,
  };
}

/** True when the item should produce a peeling task first (v10.2 Rule 12). */
function needsPeelingStep(item) {
  return Number(item.needs_peeling) === 1 && item.storage_type !== 'FROZEN' && item.prep_frequency !== 'BATCH';
}

// ---------------------------------------------------------------------------
// Validation gate — run before generating any affected station sheet.
// ---------------------------------------------------------------------------

/**
 * All blocking problems for one recipe item, plus non-blocking warnings.
 * @returns {{errors: Array, warnings: Array, routing: object}}
 */
function validateRecipeItem(item) {
  const errors = [];
  const warnings = [];
  const routing = resolveRouting(item);

  const push = (list, code, message) =>
    list.push({ code, item: item.item_name, itemId: item.id, message });

  // BATCH items are excluded from daily sheets rather than being an error in the DB.
  if (routing.route === ROUTE.BLOCKED_BATCH) {
    return { errors, warnings, routing };
  }

  // FROZEN items skip every station rule — they are only ever a Packing Sheet line.
  if (routing.route === ROUTE.PACKING_ONLY) {
    if (!item.unit_code) push(warnings, 'UNIT_MISSING', `Unit not set for ${item.item_name}.`);
    return { errors, warnings, routing };
  }

  if (routing.route === ROUTE.UNROUTABLE) {
    push(errors, 'STATION_MISSING', routing.reason);
  }

  // Yield % — v10.2 Rule 11. Never assume 100%.
  errors.push(...validateItemYield(item));

  // Peeling Method — v10.2 s1.13.
  if (Number(item.needs_peeling) === 1 && !item.peeling_method) {
    push(errors, 'PEELING_METHOD_MISSING', MESSAGES.peelingMethodMissing(item.item_name));
  }

  // Cut Method / Cut Type — required for cutting-type stations (flag-driven).
  if (Number(item.station_requires_cut_method) === 1 && !item.default_cut_method) {
    push(errors, 'CUT_METHOD_MISSING', MESSAGES.cutMethodMissing(item.item_name));
  }
  if (Number(item.station_requires_cut_type) === 1 && !item.default_cut_type_id) {
    push(errors, 'CUT_TYPE_MISSING', `Cut Type not defined for ${item.item_name}.`);
  }

  if (!item.unit_code) {
    push(errors, 'UNIT_MISSING', `Unit not set for ${item.item_name}.`);
  }
  if (!item.category_id) {
    push(warnings, 'CATEGORY_MISSING',
      `Item Category not set for ${item.item_name} — the system cannot tell whether Yield % is mandatory.`);
  }
  if (Number(item.unit_allows_piece_weight) === 1 && item.piece_weight == null) {
    push(warnings, 'PIECE_WEIGHT_MISSING',
      `Piece Weight not set for ${item.item_name} (Unit = ${item.unit_code}). Optional.`);
  }

  return { errors, warnings, routing };
}

// ---------------------------------------------------------------------------
// Location cutting override — v10.2 Rule 13.
// ---------------------------------------------------------------------------

/**
 * Effective cut configuration for one item at one location.
 * The override never duplicates the base item; missing fields inherit the default.
 *
 * @param {object} item      enriched recipe row
 * @param {object|null} override  row from recipe_location_overrides (+ joined cut type name)
 */
function resolveCutForLocation(item, override) {
  // Whole/Akhaj wins — v10.2 Rule 14 fixes the row to WHOLE / MANUAL.
  if (Number(item.whole_akhaj) === 1) {
    return {
      cutTypeId: item.default_cut_type_id,
      cutTypeName: item.cut_type_name,
      cutMethod: 'MANUAL',
      colour: colourForMethod('MANUAL'),
      source: 'WHOLE_AKHAJ',
    };
  }

  const cutTypeId = override && override.cut_type_id != null ? override.cut_type_id : item.default_cut_type_id;
  const cutTypeName = override && override.cut_type_id != null ? override.cut_type_name : item.cut_type_name;
  const cutMethod = (override && override.cut_method) || item.default_cut_method || null;

  let source = 'DEFAULT';
  if (override && (override.cut_type_id != null || override.cut_method)) source = 'LOCATION_OVERRIDE';

  return {
    cutTypeId: cutTypeId ?? null,
    cutTypeName: cutTypeName ?? null,
    cutMethod,
    colour: colourForMethod(cutMethod),
    source,
  };
}

module.exports = {
  METHOD_COLOURS,
  ROUTE,
  MESSAGES,
  colourForMethod,
  normalizeRecipeInput,
  resolveRouting,
  needsPeelingStep,
  validateRecipeItem,
  resolveCutForLocation,
  requiresYield,
};
