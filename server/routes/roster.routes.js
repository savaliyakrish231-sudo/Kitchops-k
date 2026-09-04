'use strict';

/**
 * COUNTER SETTINGS + DAILY ATTENDANCE (v10.2 s1.3 / s1.4).
 *
 * Two clearly separated operations:
 *   PUT  /stations/:id/roster  -> permanent staff list, effective from a date
 *   POST /attendance           -> Absent Today / Present, for one date only
 */

const express = require('express');
const { all, get } = require('../db/connection');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const roster = require('../services/roster.service');
const { wrap, fail, audit } = require('./helpers');

const router = express.Router();

/** Full staffing picture for a date — the Counter Settings landing view. */
router.get('/overview', requireAnyPermission('users.view', 'stations.view'), wrap((req, res) => {
  const date = roster.isDateString(req.query.date) ? req.query.date : roster.today();
  const overview = roster.rosterOverview(date);
  res.json({
    date,
    tomorrow: roster.tomorrow(),
    stations: overview,
    unstaffedStations: overview.filter((s) => s.unstaffed).map((s) => s.station.name),
    // Anyone who can hold a station assignment, for the picker.
    counterPersonPool: all(`
      SELECT u.id, u.full_name, u.username, u.is_active
        FROM users u JOIN roles r ON r.code = u.role_code
       WHERE r.needs_station = 1
       ORDER BY u.full_name COLLATE NOCASE`),
  });
}));

router.get('/stations/:id/roster', requireAnyPermission('users.view', 'stations.view'), wrap((req, res) => {
  const id = Number(req.params.id);
  const station = get('SELECT * FROM stations WHERE id = ?', [id]);
  if (!station) fail(404, 'Station not found.');
  const date = roster.isDateString(req.query.date) ? req.query.date : roster.today();
  res.json({
    station, date,
    roster: roster.stationRoster(id, date),
    availableCount: roster.availableRoster(id, date).length,
  });
}));

/**
 * Replaces a station's permanent person list. A station takes 1..N persons —
 * there is no fixed number of slots.
 *
 * effective_from defaults to TOMORROW, matching "permanent staff change applies
 * from the next day". Pass today's date explicitly for initial setup.
 */
router.put('/stations/:id/roster', requirePermission('users.assign_stations'), wrap((req, res) => {
  const id = Number(req.params.id);
  const station = get('SELECT * FROM stations WHERE id = ?', [id]);
  if (!station) fail(404, 'Station not found.');

  const userIds = [...new Set((req.body?.user_ids || []).map(Number).filter(Boolean))];
  for (const uid of userIds) {
    const u = get(`SELECT u.id, u.is_active, r.needs_station FROM users u
                     JOIN roles r ON r.code = u.role_code WHERE u.id = ?`, [uid]);
    if (!u) fail(400, `User ${uid} does not exist.`);
    if (Number(u.needs_station) !== 1) fail(400, `User ${uid} holds a role that is not assigned to stations.`);
    if (Number(u.is_active) !== 1) fail(400, `User ${uid} is inactive and cannot be assigned to a station.`);
  }

  const result = roster.setStationRoster(id, userIds,
    { effectiveFrom: req.body?.effective_from, actorId: req.user.id });
  audit(req, 'STATION_ROSTER_UPDATED', 'station', id, result);

  res.json({
    ...result,
    station,
    rosterToday: roster.stationRoster(id, roster.today()),
    rosterFromEffectiveDate: roster.stationRoster(id, result.effectiveFrom),
    message: result.appliesFromNextDay
      ? `Permanent staff change saved. The new list applies from ${result.effectiveFrom}.`
      : `Staff list applied from ${result.effectiveFrom}.`,
  });
}));

// ---------------------------------------------------------------------------
// Daily attendance — Absent Today / Present
// ---------------------------------------------------------------------------

router.get('/attendance', requirePermission('attendance.view'), wrap((req, res) => {
  const date = roster.isDateString(req.query.date) ? req.query.date : roster.today();
  res.json({
    date,
    records: all(`
      SELECT a.*, u.full_name, u.username, m.full_name AS marked_by_name
        FROM staff_attendance a
        JOIN users u ON u.id = a.user_id
        LEFT JOIN users m ON m.id = a.marked_by
       WHERE a.work_date = ? ORDER BY u.full_name COLLATE NOCASE`, [date]),
  });
}));

/**
 * Mark ABSENT or PRESENT for one date.
 * This is NOT permanent deactivation — users.is_active is untouched. The response
 * includes the redistribution preview for each station the person covers.
 */
router.post('/attendance', requirePermission('attendance.manage'), wrap((req, res) => {
  const userId = Number(req.body?.user_id);
  const status = String(req.body?.status || '').toUpperCase();
  const date = roster.isDateString(req.body?.date) ? req.body.date : roster.today();

  const user = get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) fail(404, 'User not found.');
  if (Number(user.is_active) !== 1) {
    fail(400, 'This user is permanently inactive. Reactivate the account in User Master instead.');
  }

  const record = roster.markAttendance(userId, { date, status, reason: req.body?.reason ?? null, actorId: req.user.id });
  audit(req, status === 'ABSENT' ? 'MARKED_ABSENT_TODAY' : 'MARKED_PRESENT', 'user', userId, { date });

  // Show the admin exactly what changes at each station the person covers.
  const stations = roster.stationsForUser(userId, date);
  const impact = stations.map((s) => {
    const r = roster.stationRoster(s.id, date);
    return {
      stationId: s.id,
      stationName: s.name,
      assignedCount: r.length,
      availableCount: r.filter((p) => p.available).length,
      availablePersons: r.filter((p) => p.available).map((p) => ({ userId: p.userId, fullName: p.fullName })),
      warning: r.filter((p) => p.available).length === 0
        ? `No counter person remains available at ${s.name} today.` : null,
    };
  });

  res.json({
    attendance: record,
    date,
    user: { id: user.id, fullName: user.full_name },
    redistribution: impact,
    message: status === 'ABSENT'
      ? `${user.full_name} is marked absent for ${date} only. Their tasks redistribute to the remaining persons at each station. Their permanent assignment is unchanged.`
      : `${user.full_name} is marked present for ${date}. Remaining undone tasks can be redistributed to include them.`,
  });
}));

/**
 * Preview of how N tasks would be shared out at a station on a date.
 * Lets the absent/present behaviour be verified before the task engine exists.
 */
router.get('/stations/:id/distribution-preview', requireAnyPermission('sheets.view_all', 'dashboard.view'),
  wrap((req, res) => {
    const id = Number(req.params.id);
    if (!get('SELECT 1 AS x FROM stations WHERE id = ?', [id])) fail(404, 'Station not found.');
    const date = roster.isDateString(req.query.date) ? req.query.date : roster.today();
    const count = Math.max(0, Math.min(500, Number(req.query.taskCount) || 0));
    const tasks = Array.from({ length: count }, (_, i) => ({ taskNo: i + 1 }));
    res.json(roster.redistributionPreview(id, tasks, date));
  }));

module.exports = router;
