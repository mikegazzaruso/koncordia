import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  github_id     TEXT UNIQUE,
  github_login  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  role          TEXT NOT NULL DEFAULT 'user',
  password_hash TEXT,
  application_json TEXT,
  applied_at    TEXT,
  approved_at   TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  hash        TEXT NOT NULL UNIQUE,
  label       TEXT,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  topic             TEXT NOT NULL,
  seats_json        TEXT NOT NULL,
  max_rounds        INTEGER NOT NULL,
  min_turns_before_agree INTEGER NOT NULL DEFAULT 1,
  round             INTEGER NOT NULL DEFAULT 1,
  round_seats_json  TEXT NOT NULL DEFAULT '[]',
  state             TEXT NOT NULL DEFAULT 'open',
  guide_slug        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  archived_at       TEXT
);
CREATE INDEX IF NOT EXISTS rooms_user ON rooms(user_id, created_at);

CREATE TABLE IF NOT EXISTS entries (
  room_id   TEXT NOT NULL REFERENCES rooms(id),
  n         INTEGER NOT NULL,
  seat      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  body      TEXT NOT NULL,
  ref       TEXT,
  ts        TEXT NOT NULL,
  PRIMARY KEY (room_id, n)
);

CREATE TABLE IF NOT EXISTS cursors (
  room_id   TEXT NOT NULL REFERENCES rooms(id),
  seat      TEXT NOT NULL,
  n         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, seat)
);

CREATE TABLE IF NOT EXISTS guides (
  slug        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'other',
  title       TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'public',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS guides_user ON guides(user_id, created_at);

CREATE TABLE IF NOT EXISTS revisions (
  id           TEXT PRIMARY KEY,
  guide_slug   TEXT NOT NULL REFERENCES guides(slug),
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  version      INTEGER NOT NULL,
  state        TEXT NOT NULL DEFAULT 'proposed',
  content      TEXT NOT NULL,
  proposed_by  TEXT NOT NULL,
  ts           TEXT NOT NULL,
  UNIQUE (guide_slug, version)
);
CREATE INDEX IF NOT EXISTS revisions_room ON revisions(room_id, version);

CREATE TABLE IF NOT EXISTS votes (
  revision_id  TEXT NOT NULL REFERENCES revisions(id),
  seat         TEXT NOT NULL,
  vote         TEXT NOT NULL,
  reason       TEXT,
  ts           TEXT NOT NULL,
  PRIMARY KEY (revision_id, seat)
);

CREATE TABLE IF NOT EXISTS waitlist (
  id      TEXT PRIMARY KEY,
  email   TEXT NOT NULL,
  tier    TEXT NOT NULL,
  ip      TEXT,
  ts      TEXT NOT NULL,
  UNIQUE (email, tier)
);

CREATE TABLE IF NOT EXISTS usage (
  user_id         TEXT NOT NULL,
  month           TEXT NOT NULL,
  rooms_created   INTEGER NOT NULL DEFAULT 0,
  entries_posted  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);
`;

/** Open (or create) the SQLite database and apply the schema. Pass ":memory:" for tests. */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive migrations for databases created by earlier versions. Each entry is idempotent. */
const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "rooms", column: "min_turns_before_agree", ddl: "INTEGER NOT NULL DEFAULT 1" },
  { table: "rooms", column: "archived_at", ddl: "TEXT" },
  { table: "users", column: "github_id", ddl: "TEXT" },
  { table: "users", column: "github_login", ddl: "TEXT" },
  { table: "users", column: "status", ddl: "TEXT NOT NULL DEFAULT 'pending'" },
  { table: "users", column: "application_json", ddl: "TEXT" },
  { table: "users", column: "applied_at", ddl: "TEXT" },
  { table: "users", column: "approved_at", ddl: "TEXT" },
  { table: "users", column: "role", ddl: "TEXT NOT NULL DEFAULT 'user'" },
  { table: "users", column: "password_hash", ddl: "TEXT" },
];

function migrate(db: Db) {
  for (const m of COLUMN_MIGRATIONS) {
    const cols = (db.pragma(`table_info(${m.table})`) as { name: string }[]).map((c) => c.name);
    if (!cols.includes(m.column)) db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_github ON users(github_id)`);
}
