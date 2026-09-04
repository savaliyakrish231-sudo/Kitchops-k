-- KitchOps Phase 1 — User Master + Station Master + Recipe/Yield DB
-- ARCHITECTURAL RULE (v10.2 Rule 19): stations are DATA, never code.
-- No table below stores a station name, user name, location name or yield value as a constant.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Lookup: station types. Drives engine behaviour via FLAGS, not via names.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS station_types (
  code                 TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  -- behaviour flags the calculation engine keys off (v10.2 s1.2 "Drives special logic")
  requires_cut_method  INTEGER NOT NULL DEFAULT 0,  -- cutting-type stations need MACHINE/MANUAL
  requires_cut_type    INTEGER NOT NULL DEFAULT 0,  -- cutting-type stations need a cut type
  is_peeling           INTEGER NOT NULL DEFAULT 0,  -- peeling-type: consumes raw, passes net on
  is_packing           INTEGER NOT NULL DEFAULT 0,  -- packing waits for all prep stations
  feeds_into_type      TEXT,                        -- e.g. PEELING feeds into CUTTING
  sort_order           INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- STATION MASTER  (v10.2 s1.2) — fully admin-configurable
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  sheet_label   TEXT,                                  -- A, B, C ... admin sets
  sheet_colour  TEXT    NOT NULL DEFAULT '#64748b',    -- sheet header colour
  type_code     TEXT    NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,            -- inactive = hidden, never deleted
  is_sample     INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (type_code) REFERENCES station_types(code)
);

-- ---------------------------------------------------------------------------
-- LOCATION MASTER — restaurant/outlet list (admin-entered)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  code              TEXT,
  -- v10.2 Rule 15: some locations are Method-1 only. Admin-set flag, not a hardcoded name.
  allows_method_2   INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1,
  is_sample         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- ROLES + PERMISSIONS  (v10.2 s1.1) — enforced server-side, not by UI hiding
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  code              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  -- which assignment dimensions the Add/Edit User form must show for this role
  needs_location    INTEGER NOT NULL DEFAULT 0,
  needs_station     INTEGER NOT NULL DEFAULT 0,
  -- Short numeric PINs are acceptable for shop-floor staff, never for roles that
  -- can reach master data or settings.
  allows_pin        INTEGER NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS permissions (
  code        TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_code       TEXT NOT NULL,
  permission_code TEXT NOT NULL,
  PRIMARY KEY (role_code, permission_code),
  FOREIGN KEY (role_code)       REFERENCES roles(code)       ON DELETE CASCADE,
  FOREIGN KEY (permission_code) REFERENCES permissions(code) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- USER MASTER
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name      TEXT    NOT NULL,
  username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT    NOT NULL,
  role_code      TEXT    NOT NULL,
  phone          TEXT,
  -- Job title as it appears on the kitchen org chart (e.g. Line Cook, Sous Chef).
  designation    TEXT,
  -- Extra duties held alongside the section posting (e.g. Hygiene Head).
  additional_responsibility TEXT,
  -- PASSWORD (admins) or PIN (counter staff on phone browsers). A PIN is short,
  -- so accounts using one lean on the lockout counters below.
  credential_type TEXT NOT NULL DEFAULT 'PASSWORD'
                  CHECK (credential_type IN ('PASSWORD','PIN')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  last_failed_at  TEXT,
  locked_until    TEXT,
  -- PERMANENT employment status. Distinct from daily absence (see staff_attendance).
  is_active      INTEGER NOT NULL DEFAULT 1,
  is_sample      INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at  TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  created_by     INTEGER,
  FOREIGN KEY (role_code)  REFERENCES roles(code)
);

-- Location Manager -> location(s). Relational, never a CSV string.
CREATE TABLE IF NOT EXISTS user_locations (
  user_id     INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, location_id),
  FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE CASCADE,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- COUNTER STAFF ASSIGNMENT  (v10.2 s1.3)
-- Many-to-many: a station has 1..N persons; a person may cover 1..N stations.
-- Effective-dated because "permanent staff change applies from the NEXT day".
-- A row is live on date D when effective_from <= D AND (effective_to IS NULL OR D < effective_to).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_stations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  station_id     INTEGER NOT NULL,
  effective_from TEXT    NOT NULL,          -- YYYY-MM-DD
  effective_to   TEXT,                      -- NULL = open ended
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  created_by     INTEGER,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_stations_station ON user_stations(station_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_user_stations_user    ON user_stations(user_id, effective_from);

-- ---------------------------------------------------------------------------
-- DAILY ATTENDANCE  (v10.2 s1.4 "Absent Person Handling")
-- "Absent Today" is a per-DATE override. It never touches users.is_active.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_attendance (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  work_date    TEXT    NOT NULL,                       -- YYYY-MM-DD
  status       TEXT    NOT NULL CHECK (status IN ('PRESENT','ABSENT')),
  reason       TEXT,
  marked_by    INTEGER,
  marked_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, work_date),
  FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON staff_attendance(work_date);

-- ---------------------------------------------------------------------------
-- RECIPE DB SUPPORTING MASTERS (all admin-editable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS units (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  allows_piece_weight INTEGER NOT NULL DEFAULT 0,  -- Piece Weight applies only when unit=PCS
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cut_types (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- the Whole/Akhaj target row; admin may rename it but the flag is what the engine uses
  is_whole   INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1,
  is_sample  INTEGER NOT NULL DEFAULT 0
);

-- Item category decides whether Yield % is mandatory (v10.2 Rule 11:
-- "Every Vegetable and Juice item needs Yield %"). The flag is configurable per
-- category so the rule is data-driven rather than a hardcoded name check.
CREATE TABLE IF NOT EXISTS item_categories (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  requires_yield INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1,
  is_sample      INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- RECIPE DATABASE  (v10.2 s1.6)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipe_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  station_id            INTEGER,                       -- FK -> Station Master (dynamic)
  category_id           INTEGER,
  unit_code             TEXT,
  default_cut_type_id   INTEGER,
  default_cut_method    TEXT CHECK (default_cut_method IN ('MACHINE','MANUAL')),
  whole_akhaj           INTEGER NOT NULL DEFAULT 0,
  needs_peeling         INTEGER NOT NULL DEFAULT 0,
  peeling_method        TEXT CHECK (peeling_method IN ('MACHINE','MANUAL')),
  yield_percent         REAL,                          -- 0 < y <= 100, admin-entered
  piece_weight          REAL,                          -- only when unit = PCS
  is_filling_ingredient INTEGER NOT NULL DEFAULT 0,
  prep_frequency        TEXT NOT NULL DEFAULT 'DAILY' CHECK (prep_frequency IN ('DAILY','BATCH')),
  shelf_life_value      REAL,                          -- BATCH items only
  shelf_life_unit       TEXT CHECK (shelf_life_unit IN ('DAYS','WEEKS','MONTHS')),
  storage_type          TEXT NOT NULL DEFAULT 'FRESH' CHECK (storage_type IN ('FRESH','FROZEN','DRY')),
  is_active             INTEGER NOT NULL DEFAULT 1,
  is_sample             INTEGER NOT NULL DEFAULT 0,
  notes                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by            INTEGER,
  FOREIGN KEY (station_id)          REFERENCES stations(id),
  FOREIGN KEY (category_id)         REFERENCES item_categories(id),
  FOREIGN KEY (unit_code)           REFERENCES units(code),
  FOREIGN KEY (default_cut_type_id) REFERENCES cut_types(id)
);
CREATE INDEX IF NOT EXISTS idx_recipe_station ON recipe_items(station_id);

-- Location Cutting Override (v10.2 Rule 13) — same item, different cut per location,
-- WITHOUT duplicating the base recipe row.
CREATE TABLE IF NOT EXISTS recipe_location_overrides (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_item_id INTEGER NOT NULL,
  location_id    INTEGER NOT NULL,
  cut_type_id    INTEGER,                        -- NULL = inherit item default
  cut_method     TEXT CHECK (cut_method IN ('MACHINE','MANUAL')),
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (recipe_item_id, location_id),
  FOREIGN KEY (recipe_item_id) REFERENCES recipe_items(id) ON DELETE CASCADE,
  FOREIGN KEY (location_id)    REFERENCES locations(id)    ON DELETE CASCADE,
  FOREIGN KEY (cut_type_id)    REFERENCES cut_types(id)
);

-- Yield % change history — feeds the "Recalculate all sheets?" prompt (v10.2 s1.13)
CREATE TABLE IF NOT EXISTS yield_change_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_item_id INTEGER NOT NULL,
  old_yield      REAL,
  new_yield      REAL,
  changed_by     INTEGER,
  changed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  recalc_status  TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (recalc_status IN ('PENDING','CONFIRMED','DISMISSED','NOT_REQUIRED')),
  resolved_at    TEXT,
  resolved_by    INTEGER,
  FOREIGN KEY (recipe_item_id) REFERENCES recipe_items(id) ON DELETE CASCADE
);

-- Minimal record that sheets exist for a date, so a yield edit knows whether a
-- recalculation prompt is warranted. The sheet ENGINE itself is a separate module.
CREATE TABLE IF NOT EXISTS sheet_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date    TEXT NOT NULL,
  station_id   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'GENERATED'
               CHECK (status IN ('GENERATED','STALE','RECALCULATED')),
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (work_date, station_id),
  FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- SETTINGS + AUDIT
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  description TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
