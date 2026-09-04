'use strict';

/**
 * Authentication + role-based access control.
 *
 * Permissions are re-read from the database on EVERY request, so a role change,
 * a deactivation or a permission change takes effect immediately. The frontend
 * also hides what a user cannot do, but that is cosmetic only — every protected
 * route calls requirePermission() and every scoped route filters by the caller's
 * own locations / stations / user id.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { all, get, DATA_DIR } = require('../db/connection');

const TOKEN_COOKIE = 'kitchops_token';
const TOKEN_TTL = '12h';

function loadSecret() {
  if (process.env.KITCHOPS_JWT_SECRET) return process.env.KITCHOPS_JWT_SECRET;
  const file = path.join(DATA_DIR, '.jwtsecret');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

const SECRET = loadSecret();

function signToken(user) {
  return jwt.sign({ uid: user.id, role: user.role_code }, SECRET, { expiresIn: TOKEN_TTL });
}

function setAuthCookie(res, token) {
  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(TOKEN_COOKIE);
}

function permissionsForRole(roleCode) {
  return all('SELECT permission_code FROM role_permissions WHERE role_code = ?', [roleCode])
    .map((r) => r.permission_code);
}

/** Builds the full principal for a user id, or null if they may not log in. */
function loadPrincipal(userId) {
  const user = get(
    `SELECT u.id, u.full_name, u.username, u.role_code, u.is_active, u.must_change_password,
            r.name AS role_name
       FROM users u JOIN roles r ON r.code = u.role_code
      WHERE u.id = ?`, [userId]);
  if (!user || Number(user.is_active) !== 1) return null;

  return {
    id: user.id,
    fullName: user.full_name,
    username: user.username,
    role: user.role_code,
    roleName: user.role_name,
    mustChangePassword: Number(user.must_change_password) === 1,
    permissions: permissionsForRole(user.role_code),
    locationIds: all('SELECT location_id FROM user_locations WHERE user_id = ?', [userId])
      .map((r) => r.location_id),
  };
}

/** Populates req.user when a valid token is present. Never rejects on its own. */
function authenticate(req, _res, next) {
  const token = req.cookies?.[TOKEN_COOKIE]
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = loadPrincipal(payload.uid) || undefined;
  } catch {
    // expired / tampered token — treated as anonymous
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  next();
}

function has(user, code) {
  return Boolean(user && user.permissions.includes(code));
}

/** Requires ALL listed permissions. */
function requirePermission(...codes) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    const missing = codes.filter((c) => !has(req.user, c));
    if (missing.length) {
      return res.status(403).json({
        error: 'You do not have permission to perform this action.',
        requiredPermissions: codes,
      });
    }
    next();
  };
}

/** Requires AT LEAST ONE of the listed permissions. */
function requireAnyPermission(...codes) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (!codes.some((c) => has(req.user, c))) {
      return res.status(403).json({
        error: 'You do not have permission to perform this action.',
        requiredPermissions: codes,
      });
    }
    next();
  };
}

/**
 * Data scoping: a Location Manager may only touch their own locations, and a
 * Counter Person may only ever see their own record.
 */
function assertLocationAccess(user, locationId) {
  if (has(user, 'locations.view') || has(user, 'sheets.view_all')) return true;
  return user.locationIds.includes(Number(locationId));
}

function canReadUserRecord(user, targetUserId) {
  if (has(user, 'users.view')) return true;
  return Number(user.id) === Number(targetUserId);
}

module.exports = {
  TOKEN_COOKIE,
  signToken, setAuthCookie, clearAuthCookie,
  authenticate, requireAuth, requirePermission, requireAnyPermission,
  loadPrincipal, permissionsForRole, has,
  assertLocationAccess, canReadUserRecord,
};
