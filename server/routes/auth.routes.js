'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run } = require('../db/connection');
const auth = require('../middleware/auth');
const roster = require('../services/roster.service');
const { wrap, fail, audit } = require('./helpers');

const router = express.Router();

router.post('/login', wrap((req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) fail(400, 'Username and password are required.');

  const user = get('SELECT * FROM users WHERE username = ?', [username]);
  // Same message either way — do not reveal which usernames exist.
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    fail(401, 'Invalid username or password.');
  }
  if (Number(user.is_active) !== 1) {
    fail(403, 'This account is inactive. Contact your administrator.');
  }

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
  if (next.length < 6) fail(400, 'New password must be at least 6 characters.');

  const row = get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!bcrypt.compareSync(current, row.password_hash)) fail(400, 'Current password is incorrect.');

  run("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?",
    [bcrypt.hashSync(next, 10), req.user.id]);
  audit(req, 'PASSWORD_CHANGED', 'user', req.user.id);
  res.json({ ok: true });
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
