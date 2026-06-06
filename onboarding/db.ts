/**
 * onboarding/db.ts
 *
 * SQLite singleton.  All modules must import `db` from here — never import
 * better-sqlite3 directly anywhere else (CLAUDE.md rule).
 *
 * On first require():
 *  1. Opens (or creates) the database at DB_PATH (env) or data/onboarding.db.
 *     Set DB_PATH=:memory: in tests for a fully-isolated in-memory database.
 *  2. Enables WAL mode for better concurrent read performance.
 *  3. Runs data/init.sql if the `apps` table does not yet exist,
 *     which creates all six tables and inserts seed data.
 *
 * All log output goes to process.stderr — never stdout.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DB_PATH ?? 'data/onboarding.db';

// `:memory:` is a special SQLite keyword — do not resolve it as a file path.
const isMemory = DB_PATH === ':memory:';
const dbPath = isMemory ? ':memory:' : path.resolve(process.cwd(), DB_PATH);

if (!isMemory) {
  // Ensure the parent directory exists before opening the database.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new Database(dbPath);

// WAL mode: readers don't block writers and vice-versa.
// WAL is a no-op for :memory: databases but harmless.
db.pragma('journal_mode = WAL');

// Run init.sql exactly once — guard on absence of the `apps` table.
const tableExists = db
  .prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='apps'`
  )
  .get();

if (!tableExists) {
  const initSqlPath = path.resolve(process.cwd(), 'data/init.sql');
  const initSql = fs.readFileSync(initSqlPath, 'utf-8');
  db.exec(initSql);
  process.stderr.write(
    `[db] Schema initialised from data/init.sql (${isMemory ? ':memory:' : dbPath})\n`
  );
} else {
  process.stderr.write(`[db] Connected to existing database at ${dbPath}\n`);
}

export default db;
