'use strict';

/** LOCATION MASTER — outlets that submit daily requirements. Admin-entered. */

const express = require('express');
const { all, get, run } = require('../db/connection');
const { requirePermission } = require('../middleware/auth');
const { wrap, fail, audit, bool, numOrNull, strOrNull, uniqueMessage } = require('./helpers');

const router = express.Router();

const SELECT = `
  SELECT l.*,
         (SELECT COUNT(*) FROM user_locations ul WHERE ul.location_id = l.id) AS manager_count,
         (SELECT COUNT(*) FROM recipe_location_overrides o WHERE o.location_id = l.id) AS override_count
    FROM locations l
`;

router.get('/', requirePermission('locations.view'), wrap((req, res) => {
  const where = [];
  if (req.query.activeOnly === 'true') where.push('l.is_active = 1');
  if (req.query.includeSample === 'false') where.push('l.is_sample = 0');
  res.json({
    locations: all(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                    ORDER BY l.sort_order, l.name COLLATE NOCASE`),
  });
}));

router.get('/:id', requirePermission('locations.view'), wrap((req, res) => {
  const row = get(`${SELECT} WHERE l.id = ?`, [Number(req.params.id)]);
  if (!row) fail(404, 'Location not found.');
  res.json({ location: row });
}));

function payload(body) {
  const name = strOrNull(body.name);
  if (!name) fail(400, 'Location Name is required.');
  return {
    name,
    code: strOrNull(body.code),
    allows_method_2: body.allows_method_2 === undefined ? 1 : bool(body.allows_method_2),
    sort_order: numOrNull(body.sort_order) ?? 0,
    is_active: body.is_active === undefined ? 1 : bool(body.is_active),
    is_sample: bool(body.is_sample),
  };
}

router.post('/', requirePermission('locations.manage'), wrap((req, res) => {
  const p = payload(req.body || {});
  let result;
  try {
    result = run(
      `INSERT INTO locations (name, code, allows_method_2, sort_order, is_active, is_sample)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [p.name, p.code, p.allows_method_2, p.sort_order, p.is_active, p.is_sample]);
  } catch (err) {
    const msg = uniqueMessage(err, `A location named "${p.name}"`);
    if (msg) fail(409, msg);
    throw err;
  }
  const id = Number(result.lastInsertRowid);
  audit(req, 'LOCATION_CREATED', 'location', id, p);
  res.status(201).json({ location: get(`${SELECT} WHERE l.id = ?`, [id]) });
}));

router.put('/:id', requirePermission('locations.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT 1 AS x FROM locations WHERE id = ?', [id])) fail(404, 'Location not found.');
  const p = payload(req.body || {});
  try {
    run(`UPDATE locations SET name = ?, code = ?, allows_method_2 = ?, sort_order = ?,
           is_active = ?, is_sample = ?, updated_at = datetime('now') WHERE id = ?`,
      [p.name, p.code, p.allows_method_2, p.sort_order, p.is_active, p.is_sample, id]);
  } catch (err) {
    const msg = uniqueMessage(err, `A location named "${p.name}"`);
    if (msg) fail(409, msg);
    throw err;
  }
  audit(req, 'LOCATION_UPDATED', 'location', id, p);
  res.json({ location: get(`${SELECT} WHERE l.id = ?`, [id]) });
}));

router.patch('/:id/status', requirePermission('locations.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT 1 AS x FROM locations WHERE id = ?', [id])) fail(404, 'Location not found.');
  const active = bool(req.body?.is_active);
  run("UPDATE locations SET is_active = ?, updated_at = datetime('now') WHERE id = ?", [active, id]);
  audit(req, active ? 'LOCATION_ACTIVATED' : 'LOCATION_DEACTIVATED', 'location', id);
  res.json({ location: get(`${SELECT} WHERE l.id = ?`, [id]) });
}));

router.delete('/:id', requirePermission('locations.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  const location = get('SELECT * FROM locations WHERE id = ?', [id]);
  if (!location) fail(404, 'Location not found.');

  const managers = get('SELECT COUNT(*) AS n FROM user_locations WHERE location_id = ?', [id]).n;
  const overrides = get('SELECT COUNT(*) AS n FROM recipe_location_overrides WHERE location_id = ?', [id]).n;
  if (managers || overrides) {
    fail(409, 'This location is in use and cannot be deleted. Deactivate it instead — its data stays intact.',
      { references: { managers, cuttingOverrides: overrides } });
  }
  run('DELETE FROM locations WHERE id = ?', [id]);
  audit(req, 'LOCATION_DELETED', 'location', id, location.name);
  res.json({ ok: true, deleted: id });
}));

module.exports = router;
