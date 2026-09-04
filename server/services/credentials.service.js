'use strict';

/**
 * Sign-in credential rules — the single place that decides what a valid login ID
 * and secret look like, and when an account is locked.
 *
 * Two credential types:
 *   PASSWORD — 6+ characters. The only option for any role that can reach master
 *              data or settings.
 *   PIN      — 4 to 6 digits. Fast to type on a phone browser at a counter, but
 *              a 4-digit PIN is only 10,000 combinations, so it is allowed ONLY
 *              for roles flagged roles.allows_pin, and PIN accounts rely on the
 *              lockout below to make guessing impractical.
 *
 * Pure functions plus small DB helpers for the lockout counters. No HTTP here.
 */

const { get, run } = require('../db/connection');

const PIN_MIN_LENGTH = 4;
const PIN_MAX_LENGTH = 6;
const PASSWORD_MIN_LENGTH = 6;

// Guessing budget before an account is frozen. Deliberately low because PINs are short.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,40}$/;

class CredentialError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
    this.status = 400;
  }
}

const isNumeric = (s) => /^\d+$/.test(s);

/**
 * PINs a person would try first. Rejecting these costs nothing and removes the
 * cases that make a short PIN genuinely unsafe.
 */
function isWeakPin(pin) {
  if (/^(\d)\1+$/.test(pin)) return 'every digit is the same';

  const digits = [...pin].map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (ascending || descending) return 'the digits run in sequence';

  // Repeated pairs such as 1212 / 123123.
  for (const size of [1, 2, 3]) {
    if (pin.length > size && pin.length % size === 0) {
      const unit = pin.slice(0, size);
      if (unit.repeat(pin.length / size) === pin && size !== pin.length) {
        return 'it repeats a short pattern';
      }
    }
  }
  const COMMON = new Set(['1004', '2000', '2020', '2024', '2025', '2026', '1122', '1004']);
  if (COMMON.has(pin)) return 'it is a commonly used PIN';
  return null;
}

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!value) throw new CredentialError('Login ID is required.', 'USERNAME_REQUIRED');
  if (!USERNAME_PATTERN.test(value)) {
    throw new CredentialError(
      'Login ID must be 3–40 characters: letters, digits, dot, underscore or hyphen.',
      'USERNAME_INVALID');
  }
  return value;
}

/**
 * Validates a secret against the role's rules and reports which type it is.
 *
 * @param {string} secret
 * @param {{roleAllowsPin: boolean, roleName: string, fullName?: string}} ctx
 * @returns {{type: 'PIN'|'PASSWORD', secret: string}}
 */
function validateSecret(secret, ctx) {
  const value = String(secret ?? '');
  const who = ctx.fullName ? ` for ${ctx.fullName}` : '';

  if (!value) throw new CredentialError(`A PIN or password is required${who}.`, 'SECRET_REQUIRED');

  if (isNumeric(value)) {
    if (!ctx.roleAllowsPin) {
      throw new CredentialError(
        `${ctx.roleName} cannot use a numeric PIN${who} — this role reaches master data and settings, ` +
        `so it needs a password of at least ${PASSWORD_MIN_LENGTH} characters including a non-digit.`,
        'PIN_NOT_ALLOWED_FOR_ROLE');
    }
    if (value.length < PIN_MIN_LENGTH || value.length > PIN_MAX_LENGTH) {
      throw new CredentialError(
        `PIN${who} must be ${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digits.`, 'PIN_LENGTH');
    }
    const weak = isWeakPin(value);
    if (weak) {
      throw new CredentialError(
        `That PIN${who} is too easy to guess — ${weak}. Choose another.`, 'PIN_WEAK');
    }
    return { type: 'PIN', secret: value };
  }

  if (value.length < PASSWORD_MIN_LENGTH) {
    throw new CredentialError(
      `Password${who} must be at least ${PASSWORD_MIN_LENGTH} characters.`, 'PASSWORD_LENGTH');
  }
  return { type: 'PASSWORD', secret: value };
}

/** A random PIN that passes the weak-PIN rules. */
function generatePin(length = PIN_MIN_LENGTH) {
  const size = Math.min(Math.max(length, PIN_MIN_LENGTH), PIN_MAX_LENGTH);
  for (let attempt = 0; attempt < 200; attempt++) {
    let pin = '';
    for (let i = 0; i < size; i++) pin += Math.floor(Math.random() * 10);
    if (!isWeakPin(pin)) return pin;
  }
  return '2749'.slice(0, size); // unreachable in practice
}

// ---------------------------------------------------------------------------
// Lockout — what makes a short PIN acceptable at all.
// ---------------------------------------------------------------------------

function nowIso() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

/** @returns {{locked: boolean, until: string|null, minutesLeft: number}} */
function lockState(user) {
  if (!user?.locked_until) return { locked: false, until: null, minutesLeft: 0 };
  const until = new Date(user.locked_until.replace(' ', 'T') + 'Z');
  const msLeft = until.getTime() - Date.now();
  if (msLeft <= 0) return { locked: false, until: user.locked_until, minutesLeft: 0 };
  return { locked: true, until: user.locked_until, minutesLeft: Math.ceil(msLeft / 60000) };
}

/**
 * Records a failed sign-in. Locks the account once the budget is spent.
 * @returns {{locked: boolean, attempts: number, minutesLeft: number}}
 */
function registerFailure(userId) {
  const user = get('SELECT failed_attempts FROM users WHERE id = ?', [userId]);
  const attempts = Number(user?.failed_attempts || 0) + 1;

  if (attempts >= MAX_FAILED_ATTEMPTS) {
    const until = new Date(Date.now() + LOCKOUT_MINUTES * 60000)
      .toISOString().slice(0, 19).replace('T', ' ');
    run(`UPDATE users SET failed_attempts = ?, last_failed_at = ?, locked_until = ? WHERE id = ?`,
      [attempts, nowIso(), until, userId]);
    return { locked: true, attempts, minutesLeft: LOCKOUT_MINUTES };
  }
  run('UPDATE users SET failed_attempts = ?, last_failed_at = ? WHERE id = ?',
    [attempts, nowIso(), userId]);
  return { locked: false, attempts, minutesLeft: 0, remaining: MAX_FAILED_ATTEMPTS - attempts };
}

function clearFailures(userId) {
  run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [userId]);
}

module.exports = {
  CredentialError,
  PIN_MIN_LENGTH, PIN_MAX_LENGTH, PASSWORD_MIN_LENGTH,
  MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES,
  USERNAME_PATTERN,
  isNumeric, isWeakPin,
  validateUsername, validateSecret, generatePin,
  lockState, registerFailure, clearFailures,
};
