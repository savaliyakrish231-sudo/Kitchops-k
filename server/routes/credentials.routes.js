'use strict';

/**
 * SIGN-IN CREDENTIALS — set the login ID and PIN/password for many users at once.
 *
 * Existing secrets can never be read back: they are bcrypt hashes. The plaintext
 * exists only at the moment it is set, which is why the bulk save echoes back
 * exactly what was just applied so the admin can print a handout. Nothing is
 * stored in the clear.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { all, get, run, tx } = require('../db/connection');
const { requirePermission } = require('../middleware/auth');
const credentials = require('../services/credentials.service');
const { wrap, fail, audit, bool } = require('./helpers');

const router = express.Router();

const SELECT = `
  SELECT u.id, u.full_name, u.username, u.role_code, u.designation, u.is_active,
         u.credential_type, u.must_change_password, u.last_login_at,
         u.failed_attempts, u.locked_until,
         r.name AS role_name, r.allows_pin, r.sort_order AS role_sort
    FROM users u JOIN roles r ON r.code = u.role_code
`;

function decorate(row) {
  const lock = credentials.lockState(row);
  return {
    id: row.id,
    fullName: row.full_name,
    username: row.username,
    role: row.role_code,
    roleName: row.role_name,
    designation: row.designation,
    isActive: Number(row.is_active) === 1,
    // What kind of secret this account uses. The secret itself is never returned.
    credentialType: row.credential_type,
    allowsPin: Number(row.allows_pin) === 1,
    mustChange: Number(row.must_change_password) === 1,
    hasSignedIn: Boolean(row.last_login_at),
    lastLoginAt: row.last_login_at,
    failedAttempts: Number(row.failed_attempts || 0),
    locked: lock.locked,
    lockedMinutesLeft: lock.minutesLeft,
  };
}

/** Everyone's login ID and credential type — never their secret. */
router.get('/', requirePermission('users.manage'), wrap((req, res) => {
  const rows = all(`${SELECT} ORDER BY r.sort_order, u.full_name COLLATE NOCASE`).map(decorate);
  res.json({
    users: rows,
    policy: {
      pinMinLength: credentials.PIN_MIN_LENGTH,
      pinMaxLength: credentials.PIN_MAX_LENGTH,
      passwordMinLength: credentials.PASSWORD_MIN_LENGTH,
      maxFailedAttempts: credentials.MAX_FAILED_ATTEMPTS,
      lockoutMinutes: credentials.LOCKOUT_MINUTES,
    },
    note: 'Existing PINs and passwords are hashed and cannot be displayed. '
      + 'Set a new one to see it, then print the handout before leaving this page.',
  });
}));

/** Suggested PINs for the roles that may use one — nothing is saved. */
router.post('/suggest', requirePermission('users.manage'), wrap((req, res) => {
  const length = Number(req.body?.length) || credentials.PIN_MIN_LENGTH;
  const ids = (req.body?.user_ids || []).map(Number).filter(Boolean);
  const rows = ids.length
    ? all(`${SELECT} WHERE u.id IN (${ids.map(() => '?').join(',')})`, ids)
    : all(`${SELECT} WHERE r.allows_pin = 1 AND u.is_active = 1`);

  const used = new Set();
  const suggestions = rows.filter((r) => Number(r.allows_pin) === 1).map((r) => {
    let pin;
    // Distinct PINs across the team so a slip handed to the wrong person is obvious.
    do { pin = credentials.generatePin(length); } while (used.has(pin));
    used.add(pin);
    return { userId: r.id, fullName: r.full_name, pin };
  });
  res.json({ suggestions });
}));

/**
 * Applies login IDs and secrets for many users in one transaction.
 * Everything is validated first, so a single bad row rejects the whole batch
 * rather than leaving half the team changed.
 */
router.post('/bulk', requirePermission('users.manage'), wrap((req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (!entries.length) fail(400, 'No changes were submitted.');

  const forceChange = req.body?.require_change_on_first_signin !== false;
  const planned = [];
  const errors = [];
  const takenUsernames = new Map();

  for (const entry of entries) {
    const id = Number(entry.user_id);
    const row = get(`${SELECT} WHERE u.id = ?`, [id]);
    if (!row) { errors.push({ userId: id, message: `User ${id} does not exist.` }); continue; }

    const change = { id, fullName: row.full_name, roleName: row.role_name };
    try {
      // --- login ID ------------------------------------------------------
      const wanted = entry.username === undefined || entry.username === null || entry.username === ''
        ? row.username
        : credentials.validateUsername(entry.username);

      if (wanted.toLowerCase() !== row.username.toLowerCase()) {
        const clash = get('SELECT id FROM users WHERE username = ? AND id != ?', [wanted, id]);
        if (clash) throw new credentials.CredentialError(
          `Login ID "${wanted}" is already used by another user.`, 'USERNAME_TAKEN');
        change.username = wanted;
      }
      // Two rows in the same batch must not claim the same ID.
      const key = wanted.toLowerCase();
      if (takenUsernames.has(key)) {
        throw new credentials.CredentialError(
          `Login ID "${wanted}" is used twice in this batch (${takenUsernames.get(key)} and ${row.full_name}).`,
          'USERNAME_DUPLICATE_IN_BATCH');
      }
      takenUsernames.set(key, row.full_name);

      // --- secret --------------------------------------------------------
      if (entry.secret !== undefined && entry.secret !== null && entry.secret !== '') {
        const checked = credentials.validateSecret(entry.secret, {
          roleAllowsPin: Number(row.allows_pin) === 1,
          roleName: row.role_name,
          fullName: row.full_name,
        });
        change.secret = checked.secret;
        change.credentialType = checked.type;
      }

      if (change.username || change.secret) planned.push({ ...change, finalUsername: wanted });
    } catch (err) {
      errors.push({ userId: id, fullName: row.full_name, message: err.message, code: err.code });
    }
  }

  if (errors.length) {
    return res.status(422).json({
      applied: false,
      message: `Nothing was saved — ${errors.length} row(s) need fixing first.`,
      errors,
    });
  }
  if (!planned.length) fail(400, 'No changes were submitted.');

  tx(() => {
    for (const change of planned) {
      if (change.username) {
        run("UPDATE users SET username = ?, updated_at = datetime('now') WHERE id = ?",
          [change.username, change.id]);
      }
      if (change.secret) {
        run(`UPDATE users SET password_hash = ?, credential_type = ?, must_change_password = ?,
               failed_attempts = 0, locked_until = NULL, updated_at = datetime('now')
             WHERE id = ?`,
          [bcrypt.hashSync(change.secret, 10), change.credentialType,
            forceChange && change.credentialType === 'PASSWORD' ? 1 : 0, change.id]);
      }
    }
  });

  audit(req, 'CREDENTIALS_BULK_SET', 'user', null,
    { count: planned.length, users: planned.map((c) => c.finalUsername) });

  // Echoed back once, purely so the admin can print the handout.
  res.json({
    applied: true,
    changed: planned.length,
    handout: planned.map((c) => ({
      userId: c.id,
      fullName: c.fullName,
      roleName: c.roleName,
      username: c.finalUsername,
      secret: c.secret || null,
      credentialType: c.credentialType || null,
    })),
  });
}));

/** Clears a lockout immediately — the counterpart to the 5-attempt freeze. */
router.post('/:id/unlock', requirePermission('users.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  const row = get(`${SELECT} WHERE u.id = ?`, [id]);
  if (!row) fail(404, 'User not found.');
  credentials.clearFailures(id);
  audit(req, 'ACCOUNT_UNLOCKED', 'user', id);
  res.json({ user: decorate(get(`${SELECT} WHERE u.id = ?`, [id])) });
}));

/** Forces (or clears) the "change this at next sign-in" prompt. */
router.post('/:id/require-change', requirePermission('users.manage'), wrap((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT 1 AS x FROM users WHERE id = ?', [id])) fail(404, 'User not found.');
  const required = bool(req.body?.required);
  run("UPDATE users SET must_change_password = ?, updated_at = datetime('now') WHERE id = ?", [required, id]);
  audit(req, required ? 'CHANGE_REQUIRED' : 'CHANGE_CLEARED', 'user', id);
  res.json({ user: decorate(get(`${SELECT} WHERE u.id = ?`, [id])) });
}));

module.exports = router;
