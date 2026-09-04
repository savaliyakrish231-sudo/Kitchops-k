'use strict';

/**
 * Counter-staff roster (v10.2 s1.3 + s1.4).
 *
 * Two INDEPENDENT layers, deliberately kept apart:
 *
 *   1. PERMANENT assignment — user_stations, effective-dated.
 *      "Admin sets list once. Only changes on permanent staff change."
 *      "New list applies from next day."
 *
 *   2. DAILY availability — staff_attendance, one row per person per date.
 *      "Mark Absent Today" removes a person from ONE day only. It never
 *      touches users.is_active, so it can be undone by marking them Present.
 *
 * A person works a station on date D when the permanent row is live on D AND
 * the user is permanently active AND they are not marked ABSENT on D.
 */

const { all, get, run, tx } = require('../db/connection');

const LIVE_ON_DATE = `
  us.effective_from <= ?
  AND (us.effective_to IS NULL OR us.effective_to > ?)
`;

/** Local calendar date as YYYY-MM-DD (kitchen days are local, not UTC). */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function tomorrow() { return addDays(today(), 1); }

function isDateString(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Stations a user is permanently assigned to on a date. */
function stationsForUser(userId, date = today()) {
  return all(`
    SELECT s.id, s.name, s.sheet_label, s.sheet_colour, s.type_code, s.is_active,
           us.effective_from, us.effective_to
      FROM user_stations us
      JOIN stations s ON s.id = us.station_id
     WHERE us.user_id = ? AND ${LIVE_ON_DATE}
     ORDER BY s.sort_order, s.name COLLATE NOCASE`, [userId, date, date]);
}

/** Every permanent assignment row for a user, including future-dated ones. */
function assignmentHistory(userId) {
  return all(`
    SELECT us.*, s.name AS station_name
      FROM user_stations us
      JOIN stations s ON s.id = us.station_id
     WHERE us.user_id = ?
     ORDER BY us.effective_from DESC, s.name COLLATE NOCASE`, [userId]);
}

/**
 * The full roster of one station on a date: everyone permanently assigned, each
 * annotated with their availability for that day.
 */
function stationRoster(stationId, date = today()) {
  const rows = all(`
    SELECT u.id, u.full_name, u.username, u.is_active, u.role_code,
           a.status AS attendance_status, a.reason AS attendance_reason, a.marked_at
      FROM user_stations us
      JOIN users u ON u.id = us.user_id
      LEFT JOIN staff_attendance a ON a.user_id = u.id AND a.work_date = ?
     WHERE us.station_id = ? AND ${LIVE_ON_DATE}
     GROUP BY u.id
     ORDER BY u.full_name COLLATE NOCASE`, [date, stationId, date, date]);

  return rows.map((r) => {
    const permanentlyActive = Number(r.is_active) === 1;
    const absentToday = r.attendance_status === 'ABSENT';
    return {
      userId: r.id,
      fullName: r.full_name,
      username: r.username,
      permanentlyActive,
      absentToday,
      // "Absent Today" is NOT permanent deactivation — three distinct states.
      status: !permanentlyActive ? 'INACTIVE' : absentToday ? 'ABSENT_TODAY' : 'AVAILABLE',
      attendanceReason: r.attendance_reason || null,
      markedAt: r.marked_at || null,
      available: permanentlyActive && !absentToday,
    };
  });
}

/** Only the people who can actually receive tasks on that date. */
function availableRoster(stationId, date = today()) {
  return stationRoster(stationId, date).filter((p) => p.available);
}

/** Roster for every active station on a date. */
function rosterOverview(date = today()) {
  const stations = all(`
    SELECT id, name, sheet_label, sheet_colour, type_code, sort_order
      FROM stations WHERE is_active = 1
     ORDER BY sort_order, sheet_label, name COLLATE NOCASE`);
  return stations.map((s) => {
    const roster = stationRoster(s.id, date);
    return {
      station: s,
      roster,
      assignedCount: roster.length,
      availableCount: roster.filter((p) => p.available).length,
      absentCount: roster.filter((p) => p.absentToday).length,
      unstaffed: roster.filter((p) => p.available).length === 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Permanent assignment writes
// ---------------------------------------------------------------------------

/**
 * A first-time assignment takes effect today (there is no existing roster to
 * disturb). Changing an existing list is a "permanent staff change" and, per
 * v10.2 s1.4, applies from the next day.
 */
function defaultEffectiveFrom(userId) {
  const existing = get(
    'SELECT 1 AS x FROM user_stations WHERE user_id = ? AND (effective_to IS NULL OR effective_to > ?) LIMIT 1',
    [userId, today()],
  );
  return existing ? tomorrow() : today();
}

/**
 * Replaces a user's permanent station list from `effectiveFrom` onward.
 * Existing rows are CLOSED (effective_to), never deleted — history is preserved
 * so yesterday's sheets still explain who was assigned.
 *
 * @returns {{effectiveFrom: string, added: number[], removed: number[], unchanged: number[]}}
 */
function setUserStations(userId, stationIds, { effectiveFrom, actorId = null } = {}) {
  const from = isDateString(effectiveFrom) ? effectiveFrom : defaultEffectiveFrom(userId);
  const wanted = [...new Set((stationIds || []).map(Number).filter(Boolean))];

  return tx(() => {
    // What is live at `from` right now?
    const live = all(
      `SELECT id, station_id FROM user_stations
        WHERE user_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)`,
      [userId, from, from],
    );
    const liveIds = new Set(live.map((r) => r.station_id));

    // Drop any not-yet-started rows that would start on/after `from` and are unwanted.
    const future = all(
      'SELECT id, station_id FROM user_stations WHERE user_id = ? AND effective_from >= ?',
      [userId, from],
    );
    for (const row of future) {
      if (!wanted.includes(row.station_id)) run('DELETE FROM user_stations WHERE id = ?', [row.id]);
    }

    const removed = [];
    for (const row of live) {
      if (!wanted.includes(row.station_id)) {
        run('UPDATE user_stations SET effective_to = ? WHERE id = ?', [from, row.id]);
        removed.push(row.station_id);
      }
    }

    const added = [];
    for (const stationId of wanted) {
      const already = get(
        `SELECT 1 AS x FROM user_stations
          WHERE user_id = ? AND station_id = ? AND effective_from <= ?
            AND (effective_to IS NULL OR effective_to > ?)`,
        [userId, stationId, from, from],
      );
      if (already) continue;
      run(
        `INSERT INTO user_stations (user_id, station_id, effective_from, created_by)
         VALUES (?, ?, ?, ?)`,
        [userId, stationId, from, actorId],
      );
      added.push(stationId);
    }

    return {
      effectiveFrom: from,
      appliesFromNextDay: from > today(),
      added,
      removed,
      unchanged: wanted.filter((id) => liveIds.has(id)),
    };
  });
}

/** Replaces the person list of ONE station (the Counter Settings view). */
function setStationRoster(stationId, userIds, { effectiveFrom, actorId = null } = {}) {
  const from = isDateString(effectiveFrom) ? effectiveFrom : tomorrow();
  const wanted = [...new Set((userIds || []).map(Number).filter(Boolean))];

  return tx(() => {
    const live = all(
      `SELECT id, user_id FROM user_stations
        WHERE station_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)`,
      [stationId, from, from],
    );

    const removed = [];
    for (const row of live) {
      if (!wanted.includes(row.user_id)) {
        run('UPDATE user_stations SET effective_to = ? WHERE id = ?', [from, row.id]);
        removed.push(row.user_id);
      }
    }

    const added = [];
    for (const userId of wanted) {
      const already = get(
        `SELECT 1 AS x FROM user_stations
          WHERE station_id = ? AND user_id = ? AND effective_from <= ?
            AND (effective_to IS NULL OR effective_to > ?)`,
        [stationId, userId, from, from],
      );
      if (already) continue;
      run(
        'INSERT INTO user_stations (user_id, station_id, effective_from, created_by) VALUES (?, ?, ?, ?)',
        [userId, stationId, from, actorId],
      );
      added.push(userId);
    }

    return { effectiveFrom: from, appliesFromNextDay: from > today(), added, removed };
  });
}

// ---------------------------------------------------------------------------
// Daily attendance
// ---------------------------------------------------------------------------

/**
 * Mark a counter person ABSENT or PRESENT for one date.
 * Explicitly does NOT modify users.is_active.
 */
function markAttendance(userId, { date = today(), status, reason = null, actorId = null }) {
  const st = String(status || '').toUpperCase();
  if (st !== 'ABSENT' && st !== 'PRESENT') {
    const err = new Error('Attendance status must be ABSENT or PRESENT.');
    err.status = 400;
    throw err;
  }
  run(
    `INSERT INTO staff_attendance (user_id, work_date, status, reason, marked_by, marked_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, work_date) DO UPDATE SET
       status = excluded.status, reason = excluded.reason,
       marked_by = excluded.marked_by, marked_at = excluded.marked_at`,
    [userId, date, st, reason, actorId],
  );
  return get('SELECT * FROM staff_attendance WHERE user_id = ? AND work_date = ?', [userId, date]);
}

function attendanceFor(userId, date = today()) {
  return get('SELECT * FROM staff_attendance WHERE user_id = ? AND work_date = ?', [userId, date]) || null;
}

// ---------------------------------------------------------------------------
// Round-robin distribution (v10.2 s1.4 step 3)
// ---------------------------------------------------------------------------

/**
 * Deals tasks to people round-robin: person 1 gets task 1, 7, 13; person 2 gets
 * 2, 8, 14 ... Deterministic, so re-running after an absence change is stable.
 *
 * @param {Array} tasks    anything; returned as-is inside the assignment
 * @param {Array} persons  available roster entries
 */
function distributeRoundRobin(tasks, persons) {
  if (!persons.length) {
    return { assignments: [], unassigned: tasks.slice(), perPerson: [] };
  }
  const assignments = tasks.map((task, i) => ({ task, person: persons[i % persons.length] }));
  const perPerson = persons.map((p) => ({
    userId: p.userId,
    fullName: p.fullName,
    taskCount: assignments.filter((a) => a.person.userId === p.userId).length,
    tasks: assignments.filter((a) => a.person.userId === p.userId).map((a) => a.task),
  }));
  return { assignments, unassigned: [], perPerson };
}

/**
 * Shows how a station's tasks would be shared out on a date given who is
 * available — the "tasks auto-redistribute" behaviour, previewable before the
 * task engine exists.
 */
function redistributionPreview(stationId, tasks, date = today()) {
  const roster = stationRoster(stationId, date);
  const available = roster.filter((p) => p.available);
  const result = distributeRoundRobin(tasks, available);
  return {
    date,
    stationId,
    assignedPersons: roster.length,
    availablePersons: available.length,
    absentPersons: roster.filter((p) => p.absentToday).map((p) => ({ userId: p.userId, fullName: p.fullName })),
    taskCount: tasks.length,
    perPerson: result.perPerson,
    unassigned: result.unassigned,
    blocked: available.length === 0 && tasks.length > 0,
    blockedReason: available.length === 0 && tasks.length > 0
      ? 'No counter person is available at this station today.' : null,
  };
}

module.exports = {
  today, tomorrow, addDays, isDateString,
  stationsForUser, assignmentHistory,
  stationRoster, availableRoster, rosterOverview,
  defaultEffectiveFrom, setUserStations, setStationRoster,
  markAttendance, attendanceFor,
  distributeRoundRobin, redistributionPreview,
};
