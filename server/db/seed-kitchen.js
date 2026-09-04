'use strict';

/**
 * REAL master data — Central Kitchen Surat.
 *
 * Transcribed from the kitchen org chart "CENTRAL KITCHEN SURAT — Reporting
 * structure and section allocation", prepared by Manish Kudchi (Kitchen
 * Operations Manager).
 *
 * Rows created here are REAL master data (is_sample = 0), unlike seed-sample.js.
 * Everything remains editable in the UI — this file just saves re-typing 15
 * users and 5 sections by hand.
 *
 *   npm run seed:kitchen
 *
 * Each user gets a generated password, written to data/STAFF_CREDENTIALS.txt
 * (gitignored) for handover. Everyone must change it at first sign-in.
 *
 * Re-running is safe: existing usernames and station names are skipped, not
 * duplicated.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { get, run, tx, DATA_DIR } = require('./connection');
const { migrate } = require('./migrate');
const roster = require('../services/roster.service');

// ---------------------------------------------------------------------------
// Sections from the org chart -> Station Master.
//
// station_type is what drives engine behaviour (never the name):
//   PREP    — prepares its own items
//   CUTTING — requires a cut type + MACHINE/MANUAL on every item routed to it
// ---------------------------------------------------------------------------
const SECTIONS = [
  { name: 'Dough',         label: 'A', type: 'PREP',    colour: '#b45309', note: 'Pizza dough, breads' },
  { name: 'Pasta & Sauce', label: 'B', type: 'PREP',    colour: '#b91c1c', note: 'All pasta, all sauces' },
  { name: 'Dimsum',        label: 'C', type: 'PREP',    colour: '#7e22ce', note: 'All dimsum items' },
  { name: 'Prep',          label: 'D', type: 'CUTTING', colour: '#15803d', note: 'Cutting, chopping' },
  { name: 'Beverage',      label: 'E', type: 'PREP',    colour: '#0891b2', note: 'All juices' },
];

// ---------------------------------------------------------------------------
// Management line. "All sections report to Mohit, Sous Chef."
// ---------------------------------------------------------------------------
const MANAGEMENT = [
  { fullName: 'Parth', username: 'parth', designation: 'CPK Executive Head', role: 'SUPER_ADMIN' },
  { fullName: 'Rahul', username: 'rahul', designation: 'Head Chef, CPK',     role: 'PREP_KITCHEN_ADMIN' },
  { fullName: 'Mohit', username: 'mohit', designation: 'Sous Chef, CPK',     role: 'PREP_KITCHEN_ADMIN' },
];

// ---------------------------------------------------------------------------
// Section staff. "All section staff hold Line Cook designation."
// A section takes as many people as the chart shows — no fixed slots.
// ---------------------------------------------------------------------------
const STAFF = [
  { fullName: 'Pritam',       username: 'pritam',       section: 'Dough' },
  { fullName: 'Jayesh',       username: 'jayesh',       section: 'Dough' },
  { fullName: 'Bandhana',     username: 'bandhana',     section: 'Dough' },

  { fullName: 'Shravan',      username: 'shravan',      section: 'Pasta & Sauce', extra: 'Vegetable Receiving Head' },
  { fullName: 'Aftab',        username: 'aftab',        section: 'Pasta & Sauce' },

  { fullName: 'Ranu',         username: 'ranu',         section: 'Dimsum' },
  { fullName: 'Pritam Gupta', username: 'pritam.gupta', section: 'Dimsum' },

  { fullName: 'Smita',        username: 'smita',        section: 'Prep', extra: 'Hygiene Head' },
  { fullName: 'Kunal',        username: 'kunal',        section: 'Prep', extra: 'Vegetable Receiving Head' },
  { fullName: 'Pritam Shah',  username: 'pritam.shah',  section: 'Prep' },
  { fullName: 'Shiv',         username: 'shiv',         section: 'Prep' },

  { fullName: 'Rana',         username: 'rana',         section: 'Beverage' },
];

function seed() {
  migrate({ silent: true });

  const handover = [];
  const created = { stations: 0, users: 0, assignments: 0 };
  const skipped = { stations: [], users: [] };

  tx(() => {
    // --- sections -> Station Master -------------------------------------
    const stationIds = {};
    SECTIONS.forEach((s, i) => {
      const existing = get('SELECT id FROM stations WHERE name = ?', [s.name]);
      if (existing) {
        stationIds[s.name] = existing.id;
        skipped.stations.push(s.name);
        return;
      }
      const r = run(
        `INSERT INTO stations (name, sheet_label, sheet_colour, type_code, sort_order, is_active, is_sample, notes)
         VALUES (?, ?, ?, ?, ?, 1, 0, ?)`,
        [s.name, s.label, s.colour, s.type, i + 1, s.note]);
      stationIds[s.name] = Number(r.lastInsertRowid);
      created.stations++;
    });

    // --- users ----------------------------------------------------------
    const makeUser = ({ fullName, username, designation, role, extra }) => {
      if (get('SELECT id FROM users WHERE username = ?', [username])) {
        skipped.users.push(username);
        return null;
      }
      const password = crypto.randomBytes(6).toString('base64url');
      const r = run(
        `INSERT INTO users (full_name, username, password_hash, role_code, designation,
                            additional_responsibility, is_active, is_sample, must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, 1)`,
        [fullName, username, bcrypt.hashSync(password, 10), role, designation, extra ?? null]);
      handover.push({ fullName, username, password, role, designation, extra: extra ?? '' });
      created.users++;
      return Number(r.lastInsertRowid);
    };

    for (const m of MANAGEMENT) makeUser(m);

    // Section staff are Counter Persons, assigned to their section from today.
    const today = roster.today();
    for (const person of STAFF) {
      const id = makeUser({ ...person, designation: 'Line Cook', role: 'COUNTER_PERSON' });
      if (id === null) continue;
      run('INSERT INTO user_stations (user_id, station_id, effective_from) VALUES (?, ?, ?)',
        [id, stationIds[person.section], today]);
      created.assignments++;
    }
  });

  if (handover.length) {
    const file = path.join(DATA_DIR, 'STAFF_CREDENTIALS.txt');
    const width = Math.max(...handover.map((h) => h.fullName.length), 12);
    fs.writeFileSync(file,
      'KitchOps — Central Kitchen Surat sign-in details\n' +
      'Everyone is prompted to change their password at first sign-in.\n' +
      'This file is gitignored. Delete it once the passwords have been handed out.\n\n' +
      handover.map((h) =>
        `${h.fullName.padEnd(width)}  ${h.username.padEnd(14)}  ${h.password.padEnd(10)}  ` +
        `${h.designation}${h.extra ? ' + ' + h.extra : ''}`).join('\n') + '\n');
    console.log(`[seed:kitchen] passwords written to ${file}`);
  }

  console.log(`[seed:kitchen] created ${created.stations} station(s), ${created.users} user(s), ` +
    `${created.assignments} station assignment(s).`);
  if (skipped.stations.length) console.log(`[seed:kitchen] stations already present: ${skipped.stations.join(', ')}`);
  if (skipped.users.length) console.log(`[seed:kitchen] users already present: ${skipped.users.join(', ')}`);
}

module.exports = { seed, SECTIONS, MANAGEMENT, STAFF };

if (require.main === module) seed();
