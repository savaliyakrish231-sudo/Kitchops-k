'use strict';

/**
 * Yield calculation — the single source of truth (v10.2 Rule 11).
 *
 *     Raw Qty = Net Qty / Yield %
 *
 * The percentage is stored as a human percentage (79 means 79%) and MUST be
 * converted to its decimal form before dividing:
 *
 *     1000 GM net at 79%  ->  1000 / 0.79  =  1265.82...  ->  1266 GM
 *
 * Dividing by the raw number (1000 / 79) is wrong and is what this module exists
 * to prevent. Nothing else in the codebase may re-implement this arithmetic.
 *
 * Pure functions only — no database access — so sheet generation, the Recipe DB
 * preview, the order form and the tests all share identical behaviour.
 */

const MIN_YIELD = 0.01;   // a yield of 0 would divide by zero
const MAX_YIELD = 100;    // you cannot recover more than you started with

class YieldError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'YieldError';
    this.code = code;
    this.details = details;
  }
}

/** True when the value is a usable yield percentage. */
function isValidYieldPercent(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= MIN_YIELD && n <= MAX_YIELD;
}

/** 79 -> 0.79. Never call this on an already-decimal value. */
function toDecimalFraction(yieldPercent) {
  if (!isValidYieldPercent(yieldPercent)) {
    throw new YieldError(
      `Yield % must be a number greater than ${MIN_YIELD} and at most ${MAX_YIELD}.`,
      'YIELD_OUT_OF_RANGE',
      { yieldPercent },
    );
  }
  return Number(yieldPercent) / 100;
}

/**
 * Round half-away-from-zero, matching every worked example in v10.2 s1.10
 * (200 / 0.95 = 210.5 -> 211).
 */
function roundQuantity(value, decimals = 0) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  const scaled = value * factor;
  // Nudge past binary-float representation error (e.g. 210.49999999999997).
  const corrected = Number(scaled.toPrecision(12));
  return (corrected < 0 ? -1 : 1) * Math.round(Math.abs(corrected)) / factor;
}

/**
 * Raw Quantity from Net Quantity and Yield %.
 *
 * @param {number} netQuantity   quantity required AFTER processing loss
 * @param {number} yieldPercent  1..100 (79 means 79%)
 * @param {{decimals?: number, itemName?: string}} [opts]
 * @returns {{netQuantity, yieldPercent, yieldFraction, rawQuantity, rawQuantityExact, wasteQuantity}}
 */
function calculateRawQuantity(netQuantity, yieldPercent, opts = {}) {
  const { decimals = 0, itemName = null } = opts;
  const net = Number(netQuantity);

  if (!Number.isFinite(net) || net < 0) {
    throw new YieldError(
      `Net quantity must be a non-negative number${itemName ? ` for ${itemName}` : ''}.`,
      'INVALID_NET_QUANTITY',
      { netQuantity, itemName },
    );
  }
  if (yieldPercent === null || yieldPercent === undefined || yieldPercent === '') {
    throw new YieldError(
      yieldMissingMessage(itemName),
      'YIELD_MISSING',
      { itemName },
    );
  }

  const fraction = toDecimalFraction(yieldPercent);
  const exact = net / fraction;
  const raw = roundQuantity(exact, decimals);

  return {
    netQuantity: net,
    yieldPercent: Number(yieldPercent),
    yieldFraction: fraction,
    rawQuantity: raw,
    rawQuantityExact: exact,
    wasteQuantity: roundQuantity(raw - net, decimals),
  };
}

/** Inverse: how much net output a known raw quantity yields. */
function calculateNetQuantity(rawQuantity, yieldPercent, opts = {}) {
  const { decimals = 0, itemName = null } = opts;
  const raw = Number(rawQuantity);
  if (!Number.isFinite(raw) || raw < 0) {
    throw new YieldError('Raw quantity must be a non-negative number.', 'INVALID_RAW_QUANTITY', { rawQuantity, itemName });
  }
  if (yieldPercent === null || yieldPercent === undefined || yieldPercent === '') {
    throw new YieldError(yieldMissingMessage(itemName), 'YIELD_MISSING', { itemName });
  }
  const fraction = toDecimalFraction(yieldPercent);
  return roundQuantity(raw * fraction, decimals);
}

/** The exact wording required by v10.2 s1.13. */
function yieldMissingMessage(itemName) {
  return `Yield % missing for ${itemName || 'item'}.`;
}

/**
 * Does this item need a Yield % at all?
 * Driven by the item's category flag (item_categories.requires_yield), never by
 * a hardcoded item or station name.
 *
 * @param {{category_requires_yield?: number, item_name?: string}} item
 */
function requiresYield(item) {
  return Boolean(item && Number(item.category_requires_yield) === 1);
}

/**
 * Yield check for one recipe item, used by the sheet-generation gate.
 * Returns [] when the item is fine, otherwise the blocking errors.
 */
function validateItemYield(item) {
  const errors = [];
  if (!requiresYield(item)) {
    // Not a yield-mandatory category. If a value IS present it still has to be sane.
    if (item.yield_percent !== null && item.yield_percent !== undefined && !isValidYieldPercent(item.yield_percent)) {
      errors.push({
        code: 'YIELD_OUT_OF_RANGE',
        item: item.item_name,
        itemId: item.id,
        message: `Yield % for ${item.item_name} must be between ${MIN_YIELD} and ${MAX_YIELD}.`,
      });
    }
    return errors;
  }

  if (item.yield_percent === null || item.yield_percent === undefined || item.yield_percent === '') {
    // Never silently assume 100%.
    errors.push({
      code: 'YIELD_MISSING',
      item: item.item_name,
      itemId: item.id,
      message: yieldMissingMessage(item.item_name),
    });
  } else if (!isValidYieldPercent(item.yield_percent)) {
    errors.push({
      code: 'YIELD_OUT_OF_RANGE',
      item: item.item_name,
      itemId: item.id,
      message: `Yield % for ${item.item_name} must be between ${MIN_YIELD} and ${MAX_YIELD}.`,
    });
  }
  return errors;
}

module.exports = {
  YieldError,
  MIN_YIELD,
  MAX_YIELD,
  isValidYieldPercent,
  toDecimalFraction,
  roundQuantity,
  calculateRawQuantity,
  calculateNetQuantity,
  yieldMissingMessage,
  requiresYield,
  validateItemYield,
};
