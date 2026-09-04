'use strict';

const { run } = require('../db/connection');

/** Wraps an async handler so thrown errors reach the express error handler. */
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Throws a plain error carrying an HTTP status. */
function fail(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  throw err;
}

function audit(req, action, entity, entityId, detail = null) {
  run('INSERT INTO audit_log (actor_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
    [req.user?.id ?? null, action, entity, entityId == null ? null : String(entityId),
      detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail))]);
}

const bool = (x) => (x === true || x === 1 || x === '1' || x === 'true' || x === 'on' ? 1 : 0);
const numOrNull = (x) => (x === '' || x === null || x === undefined ? null : Number(x));
const strOrNull = (x) => {
  if (x === null || x === undefined) return null;
  const s = String(x).trim();
  return s === '' ? null : s;
};

/** Turns a UNIQUE-constraint failure into a readable 409. */
function uniqueMessage(err, label) {
  if (String(err.message || '').includes('UNIQUE constraint failed')) {
    return `${label} already exists.`;
  }
  return null;
}

module.exports = { wrap, fail, audit, bool, numOrNull, strOrNull, uniqueMessage };
