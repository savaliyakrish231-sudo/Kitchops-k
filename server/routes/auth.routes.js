'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run } = require('../db/connection');
const auth = require('../middleware/auth');
const roster = require('../services/roster.service');
const credentials = require('../services/credentials.service');
const { wrap, fail, audit } = require('./helpers');

const router = express.Router();

router.post('/login', wrap((req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) fail(400, 'Username and password are required.');

  const user = get('SELECT * FROM users WHERE username = ?', [username]);
  const secretOk = user && bcrypt.compareSync(password, user.password_hash);

  // Wrong credentials get ONE fixed message, whether or not the account exists.
  // No attempt counter, no "PIN vs password" wording, no lockout hint — any of
  // those would confirm to a guesser that the login ID is real.
  if (!secretOk) {
    if (user) {
      const result = credentials.registerFailure(user.id);
      audit(req, 'LOGIN_FAILED', 'user', user.id, { attempts: result.attempts, locked: result.locked });
    }
    fail(401, 'Invalid login ID or password.');
  }

  // The secret was correct, so telling this caller the account is locked reveals
  // nothing they did not already know.
  const lock = credentials.lockState(user);
  if (lock.locked) {
    audit(req, 'LOGIN_BLOCKED_LOCKED', 'user', user.id);
    fail(423, `Too many failed attempts. This account is locked for another ${lock.minutesLeft} minute(s). ` +
      'An administrator can unlock it from Sign-in Credentials.');
  }
  if (Number(user.is_active) !== 1) {
    fail(403, 'This account is inactive. Contact your administrator.');
  }

  credentials.clearFailures(user.id);
  run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [user.id]);
  auth.setAuthCookie(res, auth.signToken(user));

  const principal = auth.loadPrincipal(user.id);
  res.json({ user: withContext(principal) });
}));

router.post('/logout', (req, res) => {
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ user: withContext(req.user) });
});

/** Any signed-in user may change their OWN password. */
router.post('/change-password', auth.requireAuth, wrap((req, res) => {
  const current = String(req.body?.currentPassword || '');
  const next = String(req.body?.newPassword || '');

  const row = get(`SELECT u.password_hash, u.role_code, r.name AS role_name, r.allows_pin
                     FROM users u JOIN roles r ON r.code = u.role_code WHERE u.id = ?`, [req.user.id]);
  if (!bcrypt.compareSync(current, row.password_hash)) {
    fail(400, 'Your current PIN or password is incorrect.');
  }

  // Same rules as the admin credentials screen — a counter person may move to a
  // PIN, an admin may not.
  const checked = credentials.validateSecret(next, {
    roleAllowsPin: Number(row.allows_pin) === 1,
    roleName: row.role_name,
  });

  run(`UPDATE users SET password_hash = ?, credential_type = ?, must_change_password = 0,
         failed_attempts = 0, locked_until = NULL, updated_at = datetime('now') WHERE id = ?`,
    [bcrypt.hashSync(checked.secret, 10), checked.type, req.user.id]);
  audit(req, 'CREDENTIAL_CHANGED', 'user', req.user.id, { type: checked.type });
  res.json({ ok: true, credentialType: checked.type });
}));

/** Adds the caller's own assignment context so the UI can scope itself. */
function withContext(principal) {
  const stations = principal.role === 'COUNTER_PERSON' || principal.permissions.includes('tasks.view_own')
    ? roster.stationsForUser(principal.id)
    : [];
  const attendance = roster.attendanceFor(principal.id);
  return {
    ...principal,
    stations,
    absentToday: attendance?.status === 'ABSENT',
  };
}

module.exports = router;
