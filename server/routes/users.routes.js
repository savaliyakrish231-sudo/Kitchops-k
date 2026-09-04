'use strict';

/**
 * USER MASTER (v10.2 s1.1).
 *
 * Assignment dimensions are driven by roles.needs_location / roles.needs_station,
 * so the form adapts from data rather than from a hardcoded role switch.
 */

const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { all, get, run, tx } = require('../db/connection');
const authMw = require('../middleware/auth');
const { requirePermission, requireAnyPermission, has } = authMw;
const roster = require('../services/roster.service');
const { wrap, fail, audit, bool, strOrNull, uniqueMessage } = require('./helpers');

const router = express.Router();

const SELECT = `
  SELECT u.id, u.full_name, u.username, u.role_code, u.phone,
         u.designation, u.additional_responsibility, u.is_active, u.is_sample,
         u.must_change_password, u.last_login_at, u.created_at, u.updated_at,
         r.name AS role_name, r.needs_location, r.needs_station
    FROM users u JOIN roles r ON r.code = u.role_code
`;

/** Assembles the list-view row: assignments + today's availability. */
function decorate(row, date) {
  const locations = all(
    `SELECT l.id, l.name FROM user_locations ul JOIN locations l ON l.id = ul.location_id
      WHERE ul.user_id = ? ORDER BY l.sort_order, l.name COLLATE NOCASE`, [row.id]);
  const stations = roster.stationsForUser(row.id, date);
  const attendance = roster.attendanceFor(row.id, date);
  const absentToday = attendance?.status === 'ABSENT';

  return {
    ...row,
    locations,
    stations,
    attendance: attendance || null,
    absentToday,
    // Three distinct states — "Absent Today" is never permanent deactivation.
    statusLabel: Number(row.is_active) !== 1 ? 'INACTIVE' : absentToday ? 'ABSENT_TODAY' : 'ACTIVE',
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

router.get('/', requirePermission('users.view'), wrap((req, res) => {
  const where = [];
  const params = [];
  if (req.query.role) { where.push('u.role_code = ?'); params.push(String(req.query.role)); }
  if (req.query.activeOnly === 'true') where.push('u.is_active = 1');
  if (req.query.includeSample === 'false') where.push('u.is_sample = 0');
  if (req.query.search) { where.push('(u.full_name LIKE ? OR u.username LIKE ?)'); params.push(`%${req.query.search}%`, `%${req.query.search}%`); }

  const date = roster.isDateString(req.query.date) ? req.query.date : roster.today();
  let rows = all(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                  ORDER BY r.sort_order, u.full_name COLLATE NOCASE`, params)
    .map((r) => decorate(r, date));

  if (req.query.stationId) {
    const sid = Number(req.query.stationId);
    rows = rows.filter((u) => u.stations.some((s) => s.id === sid));
  }
  res.json({ users: rows, date });
}));

router.get('/:id', requireAnyPermission('users.view', 'tasks.view_own'), wrap((req, res) => {
  const id = Number(req.params.id);
  if (!authMw.canReadUserRecord(req.user, id)) fail(403, 'You may only view your own user record.');
  const row = get(`${SELECT} WHERE u.id = ?`, [id]);
  if (!row) fail(404, 'User not found.');
  const date = roster.isDateString(req.query.date) ? req.query.date : roster.today();
  res.json({
    user: decorate(row, date),
    assignmentHistory: has(req.user, 'users.view') ? roster.assignmentHistory(id) : undefined,
  });
}));

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

function readPayload(body, { requirePassword }) {
  const fullName = strOrNull(body.full_name);
  const username = strOrNull(body.username);
  const roleCode = strOrNull(body.role_code);
  if (!fullName) fail(400, 'Full Name is required.');
  if (!username) fail(400, 'Username is required.');
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) {
    fail(400, 'Username must be 3–40 characters: letters, digits, dot, underscore or hyphen.');
  }
  if (!roleCode) fail(400, 'Role is required.');

  const role = get('SELECT * FROM roles WHERE code = ?', [roleCode]);
  if (!role) fail(400, `Unknown role "${roleCode}".`);

  const password = body.password ? String(body.password) : null;
  if (requirePassword && !password) fail(400, 'Password is required.');
  if (password && password.length < 6) fail(400, 'Password must be at least 6 characters.');

  const locationIds = [...new Set((body.location_ids || []).map(Number).filter(Boolean))];
  const stationIds = [...new Set((body.station_ids || []).map(Number).filter(Boolean))];

  // Role-adaptive validation, driven by the role's own flags.
  if (Number(role.needs_location) === 1 && locationIds.length === 0) {
    fail(400, `${role.name} must be assigned to at least one location.`);
  }
  if (Number(role.needs_location) === 0 && locationIds.length > 0) {
    fail(400, `${role.name} does not take a location assignment.`);
  }
  if (Number(role.needs_station) === 0 && stationIds.length > 0) {
    fail(400, `${role.name} does not take a station assignment.`);
  }
  for (const id of locationIds) {
    if (!get('SELECT 1 AS x FROM locations WHERE id = ?', [id])) fail(400, `Location ${id} does not exist.`);
  }
  for (const id of stationIds) {
    if (!get('SELECT 1 AS x FROM stations WHERE id = ?', [id])) fail(400, `Station ${id} does not exist.`);
  }

  return {
    full_name: fullName,
    username,
    role_code: roleCode,
    role,
    phone: strOrNull(body.phone),
    designation: strOrNull(body.designation),
    additional_responsibility: strOrNull(body.additional_responsibility),
    is_active: body.is_active === undefined ? 1 : bool(body.is_active),
    is_sample: bool(body.is_sample),
    password,
    locationIds,
    stationIds,
    effectiveFrom: roster.isDateString(body.effective_from) ? body.effective_from : null,
  };
}

router.post('/', requirePermission('users.manage'), wrap((req, res) => {
  const p = readPayload(req.body || {}, { requirePassword: false });
  // Generated when the admin leaves it blank; shown once so it can be handed over.
  const generated = p.password ? null : crypto.randomBytes(6).toString('base64url');
  const password = p.password || generated;

  const result = tx(() => {
    let inserted;
    try {
      inserted = run(
        `INSERT INTO users (full_name, username, password_hash, role_code, phone,
                            designation, additional_responsibility, is_active, is_sample,
                            must_change_password, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.full_name, p.username, bcrypt.hashSync(password, 10), p.role_code, p.phone,
          p.designation, p.additional_responsibility,
          p.is_active, p.is_sample, generated ? 1 : 0, req.user.id]);
    } catch (err) {
      const msg = uniqueMessage(err, `The username "${p.username}"`);
      if (msg) fail(409, msg);
      throw err;
    }
    const id = Number(inserted.lastInsertRowid);
    for (const locId of p.locationIds) {
      run('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)', [id, locId]);
    }
    return id;
  });

  let assignment = null;
  if (p.stationIds.length) {
    assignment = roster.setUserStations(result, p.stationIds,
      { effectiveFrom: p.effectiveFrom, actorId: req.user.id });
  }
  audit(req, 'USER_CREATED', 'user', result,
    { username: p.username, role: p.role_code, locations: p.locationIds, stations: p.stationIds });

  res.status(201).json({
    user: decorate(get(`${SELECT} WHERE u.id = ?`, [result]), roster.today()),
    assignment,
    generatedPassword: generated,
  });
}));

router.put('/:id', requirePermission('users.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  const existing = get('SELECT * FROM users WHERE id = ?', [id]);
  if (!existing) fail(404, 'User not found.');
  const p = readPayload(req.body || {}, { requirePassword: false });

  // Never let the last active Super Admin lock everyone out.
  if (existing.role_code === 'SUPER_ADMIN' && (p.role_code !== 'SUPER_ADMIN' || !p.is_active)) {
    assertNotLastSuperAdmin(id);
  }

  tx(() => {
    try {
      run(`UPDATE users SET full_name = ?, username = ?, role_code = ?, phone = ?,
             designation = ?, additional_responsibility = ?,
             is_active = ?, is_sample = ?, updated_at = datetime('now') WHERE id = ?`,
        [p.full_name, p.username, p.role_code, p.phone,
          p.designation, p.additional_responsibility, p.is_active, p.is_sample, id]);
    } catch (err) {
      const msg = uniqueMessage(err, `The username "${p.username}"`);
      if (msg) fail(409, msg);
      throw err;
    }
    run('DELETE FROM user_locations WHERE user_id = ?', [id]);
    for (const locId of p.locationIds) {
      run('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)', [id, locId]);
    }
  });

  // Station changes are effective-dated (permanent staff change -> next day).
  const assignment = roster.setUserStations(id, p.stationIds,
    { effectiveFrom: p.effectiveFrom, actorId: req.user.id });

  audit(req, 'USER_UPDATED', 'user', id, { username: p.username, role: p.role_code, assignment });
  res.json({ user: decorate(get(`${SELECT} WHERE u.id = ?`, [id]), roster.today()), assignment });
}));

/** PERMANENT activate/deactivate. Distinct from Absent Today. */
router.patch('/:id/status', requirePermission('users.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  const user = get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) fail(404, 'User not found.');
  const active = bool(req.body?.is_active);
  if (!active) {
    if (id === req.user.id) fail(400, 'You cannot deactivate your own account.');
    if (user.role_code === 'SUPER_ADMIN') assertNotLastSuperAdmin(id);
  }
  run("UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE id = ?", [active, id]);
  audit(req, active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', 'user', id);
  res.json({ user: decorate(get(`${SELECT} WHERE u.id = ?`, [id]), roster.today()) });
}));

/** Admin password reset. Returns the new password once, for handover. */
router.post('/:id/reset-password', requirePermission('users.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT 1 AS x FROM users WHERE id = ?', [id])) fail(404, 'User not found.');
  const supplied = req.body?.password ? String(req.body.password) : null;
  if (supplied && supplied.length < 6) fail(400, 'Password must be at least 6 characters.');
  const password = supplied || crypto.randomBytes(6).toString('base64url');

  run("UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?",
    [bcrypt.hashSync(password, 10), id]);
  audit(req, 'PASSWORD_RESET', 'user', id);
  res.json({ ok: true, password });
}));

/**
 * Deletion is refused once a user carries operational history — master data is
 * deactivated, not destroyed. A never-used record may still be removed.
 */
router.delete('/:id', requirePermission('users.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  const user = get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) fail(404, 'User not found.');
  if (id === req.user.id) fail(400, 'You cannot delete your own account.');
  if (user.role_code === 'SUPER_ADMIN') assertNotLastSuperAdmin(id);

  const assignments = get('SELECT COUNT(*) AS n FROM user_stations WHERE user_id = ?', [id]).n;
  const attendance = get('SELECT COUNT(*) AS n FROM staff_attendance WHERE user_id = ?', [id]).n;
  if (assignments || attendance || user.last_login_at) {
    fail(409,
      'This user has operational history and cannot be deleted. Deactivate the account instead — the record and its history stay intact.',
      { references: { stationAssignments: assignments, attendanceRecords: attendance, hasLoggedIn: Boolean(user.last_login_at) } });
  }
  tx(() => {
    run('DELETE FROM user_locations WHERE user_id = ?', [id]);
    run('DELETE FROM users WHERE id = ?', [id]);
  });
  audit(req, 'USER_DELETED', 'user', id, user.username);
  res.json({ ok: true, deleted: id });
}));

function assertNotLastSuperAdmin(excludingId) {
  const others = get(
    "SELECT COUNT(*) AS n FROM users WHERE role_code = 'SUPER_ADMIN' AND is_active = 1 AND id != ?",
    [excludingId]).n;
  if (others === 0) fail(400, 'At least one active Super Admin must remain.');
}

module.exports = router;
