'use strict';

/**
 * A counter person's own work for a date (v10.2 s1.5).
 *
 * SCOPE NOTE — this returns a PREVIEW, not generated tasks. The daily task
 * engine (orders -> tasks -> Mark Done with start/finish timestamps) is a
 * separate Phase 1 module that is not built yet, so there are no persisted task
 * rows and no quantities, which come from a location's daily order.
 *
 * What it does give is the same computation the admin dashboard shows, scoped
 * to the caller: the items routed to their station, shared round-robin among
 * whoever is available that day. Previously the dashboard said "Kunal: 1 task"
 * while Kunal's own screen showed nothing, because this endpoint did not exist.
 *
 * Scoping is enforced here, not in the UI: the caller only ever receives rows
 * that round-robin allocated to their own user id.
 */

const express = require('express');
const { requirePermission } = require('../middleware/auth');
const repo = require('../services/recipe.repo');
const rules = require('../services/recipe-rules.service');
const roster = require('../services/roster.service');
const { wrap } = require('./helpers');

const router = express.Router();

router.get('/mine', requirePermission('tasks.view_own'), wrap((req, res) => {
  const date = roster.isDateString(req.query.date) ? req.query.date : roster.today();
  const me = req.user.id;

  const attendance = roster.attendanceFor(me, date);
  const absentToday = attendance?.status === 'ABSENT';

  const stations = roster.stationsForUser(me, date)
    .filter((s) => Number(s.is_active) === 1);

  const perStation = stations.map((station) => {
    // Items routed to this station, in the same order the sheet would list them.
    const rows = repo.list({ stationId: station.id, activeOnly: true })
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
        wholeAkhaj: Number(r.item.whole_akhaj) === 1,
        needsPeeling: Number(r.item.needs_peeling) === 1,
        peelingMethod: r.item.peeling_method,
        blocking: r.check.errors.map((e) => e.message),
      }));

    // Round-robin over the people actually available today — the same rule the
    // dashboard applies, so the two screens cannot disagree.
    const available = roster.availableRoster(station.id, date);
    const { perPerson } = roster.distributeRoundRobin(rows, available);
    const mine = perPerson.find((p) => p.userId === me);

    return {
      station: {
        id: station.id,
        name: station.name,
        sheetLabel: station.sheet_label,
        sheetColour: station.sheet_colour,
        type: station.type_code,
      },
      teamSize: available.length,
      stationItemCount: rows.length,
      tasks: mine ? mine.tasks : [],
    };
  });

  const tasks = perStation.reduce((n, s) => n + s.tasks.length, 0);

  res.json({
    date,
    absentToday,
    stations: perStation,
    taskCount: tasks,
    // Made explicit so the UI never implies a generated sheet exists.
    preview: true,
    note: absentToday
      ? 'You are marked absent today, so your work has been shared out among the rest of your station.'
      : 'Based on the current Recipe Database. Quantities and Mark Done arrive with the daily sheet engine.',
  });
}));

module.exports = router;
