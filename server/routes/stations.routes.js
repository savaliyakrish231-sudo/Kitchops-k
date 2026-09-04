'use strict';

/**
 * STATION MASTER (v10.2 s1.2) — the table the whole engine reads from.
 * Adding a station here requires no code change anywhere.
 */

const express = require('express');
const { all, get, run } = require('../db/connection');
const { requirePermission } = require('../middleware/auth');
const roster = require('../services/roster.service');
const { wrap, fail, audit, bool, numOrNull, strOrNull, uniqueMessage } = require('./helpers');

const router = express.Router();

const SELECT = `
  SELECT s.*, st.name AS type_name,
         st.requires_cut_method, st.requires_cut_type,
         st.is_peeling, st.is_packing, st.feeds_into_type,
         (SELECT COUNT(*) FROM recipe_items ri WHERE ri.station_id = s.id) AS recipe_item_count
    FROM stations s
    JOIN station_types st ON st.code = s.type_code
`;

router.get('/', requirePermission('stations.view'), wrap((req, res) => {
  const where = [];
  const params = [];
  if (req.query.activeOnly === 'true') where.push('s.is_active = 1');
  if (req.query.includeSample === 'false') where.push('s.is_sample = 0');
  const rows = all(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.sort_order, s.sheet_label, s.name COLLATE NOCASE`, params);

  const date = roster.isDateString(req.query.date) ? req.query.date : roster.today();
  res.json({
    stations: rows.map((s) => ({
      ...s,
      staffCount: roster.stationRoster(s.id, date).length,
      availableStaffCount: roster.availableRoster(s.id, date).length,
    })),
  });
}));

router.get('/:id', requirePermission('stations.view'), wrap((req, res) => {
  const station = get(`${SELECT} WHERE s.id = ?`, [Number(req.params.id)]);
  if (!station) fail(404, 'Station not found.');
  const date = roster.isDateString(req.query.date) ? req.query.date : roster.today();
  res.json({
    station,
    roster: roster.stationRoster(station.id, date),
    recipeItems: all(
      'SELECT id, item_name, is_active FROM recipe_items WHERE station_id = ? ORDER BY item_name COLLATE NOCASE',
      [station.id]),
  });
}));

function payload(body) {
  const name = strOrNull(body.name);
  if (!name) fail(400, 'Station Name is required.');
  const typeCode = strOrNull(body.type_code);
  if (!typeCode) fail(400, 'Station Type is required.');
  if (!get('SELECT 1 AS x FROM station_types WHERE code = ?', [typeCode])) {
    fail(400, `Unknown station type "${typeCode}".`);
  }
  return {
    name,
    type_code: typeCode,
    sheet_label: strOrNull(body.sheet_label),
    sheet_colour: strOrNull(body.sheet_colour) || '#64748b',
    sort_order: numOrNull(body.sort_order) ?? 0,
    is_active: body.is_active === undefined ? 1 : bool(body.is_active),
    is_sample: bool(body.is_sample),
    notes: strOrNull(body.notes),
  };
}

router.post('/', requirePermission('stations.manage'), wrap((req, res) => {
  const p = payload(req.body || {});
  let result;
  try {
    result = run(
      `INSERT INTO stations (name, type_code, sheet_label, sheet_colour, sort_order, is_active, is_sample, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.name, p.type_code, p.sheet_label, p.sheet_colour, p.sort_order, p.is_active, p.is_sample, p.notes]);
  } catch (err) {
    const msg = uniqueMessage(err, `A station named "${p.name}"`);
    if (msg) fail(409, msg);
    throw err;
  }
  const id = Number(result.lastInsertRowid);
  audit(req, 'STATION_CREATED', 'station', id, p);
  res.status(201).json({ station: get(`${SELECT} WHERE s.id = ?`, [id]) });
}));

router.put('/:id', requirePermission('stations.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT 1 AS x FROM stations WHERE id = ?', [id])) fail(404, 'Station not found.');
  const p = payload(req.body || {});
  try {
    run(`UPDATE stations SET name = ?, type_code = ?, sheet_label = ?, sheet_colour = ?,
           sort_order = ?, is_active = ?, is_sample = ?, notes = ?, updated_at = datetime('now')
         WHERE id = ?`,
      [p.name, p.type_code, p.sheet_label, p.sheet_colour, p.sort_order, p.is_active, p.is_sample, p.notes, id]);
  } catch (err) {
    const msg = uniqueMessage(err, `A station named "${p.name}"`);
    if (msg) fail(409, msg);
    throw err;
  }
  audit(req, 'STATION_UPDATED', 'station', id, p);
  res.json({ station: get(`${SELECT} WHERE s.id = ?`, [id]) });
}));

/** Activate / deactivate. v10.2: "Inactive stations are hidden ... No data deleted." */
router.patch('/:id/status', requirePermission('stations.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT 1 AS x FROM stations WHERE id = ?', [id])) fail(404, 'Station not found.');
  const active = bool(req.body?.is_active);
  run("UPDATE stations SET is_active = ?, updated_at = datetime('now') WHERE id = ?", [active, id]);
  audit(req, active ? 'STATION_ACTIVATED' : 'STATION_DEACTIVATED', 'station', id);
  res.json({ station: get(`${SELECT} WHERE s.id = ?`, [id]) });
}));

/**
 * Deletion is allowed ONLY while nothing references the station — otherwise the
 * master-data rule ("no data deleted") wins and the caller is told to deactivate.
 */
router.delete('/:id', requirePermission('stations.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  const station = get('SELECT * FROM stations WHERE id = ?', [id]);
  if (!station) fail(404, 'Station not found.');

  const recipeCount = get('SELECT COUNT(*) AS n FROM recipe_items WHERE station_id = ?', [id]).n;
  const staffCount = get('SELECT COUNT(*) AS n FROM user_stations WHERE station_id = ?', [id]).n;
  const sheetCount = get('SELECT COUNT(*) AS n FROM sheet_runs WHERE station_id = ?', [id]).n;

  if (recipeCount || staffCount || sheetCount) {
    fail(409,
      'This station is in use and cannot be deleted. Deactivate it instead — its data stays intact.',
      { references: { recipeItems: recipeCount, assignedStaff: staffCount, generatedSheets: sheetCount } });
  }
  run('DELETE FROM stations WHERE id = ?', [id]);
  audit(req, 'STATION_DELETED', 'station', id, station.name);
  res.json({ ok: true, deleted: id });
}));

module.exports = router;
