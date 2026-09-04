'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.KITCHOPS_DB || path.join(DEFAULT_DATA_DIR, 'kitchops.db');

// Side-car files (credentials, JWT secret) live beside the ACTIVE database, so a
// test or alternate database never overwrites the real installation's files.
const DATA_DIR = path.dirname(DB_PATH);

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

/** Run a SELECT returning all rows. */
function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

/** Run a SELECT returning the first row (or undefined). */
function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

/** Run an INSERT/UPDATE/DELETE. Returns { changes, lastInsertRowid }. */
function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

/** Wrap fn in a transaction. node:sqlite has no helper, so do it explicitly. */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

module.exports = { db, all, get, run, tx, DB_PATH, DATA_DIR };
