import { createRequire } from "node:module";

const requireModule = createRequire(import.meta.url);
const isBun = Boolean(process.versions.bun);

export type SqliteBindValue = string | number | bigint | null;

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  get(...params: SqliteBindValue[]): unknown;
  all(...params: SqliteBindValue[]): unknown[];
  run(...params: SqliteBindValue[]): SqliteRunResult;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  transaction<Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
  ): (...args: Args) => Result;
  close(): void;
}

interface SqliteConstructor {
  new (path: string, options?: Record<string, unknown>): SqliteDatabase;
}

// The driver is resolved at runtime so Bun never loads the native better-sqlite3
// addon (unsupported) and Node never loads the bun:sqlite builtin. The require
// result is untyped, so the cast to our structural contract is unavoidable here.
function loadDatabaseConstructor(): SqliteConstructor {
  if (isBun) {
    return (requireModule("bun:sqlite") as { Database: SqliteConstructor }).Database;
  }
  return requireModule("better-sqlite3") as SqliteConstructor;
}

export function openSqlite(
  dbPath: string,
  options: { create: boolean; timeoutMs?: number | undefined },
): SqliteDatabase {
  const Database = loadDatabaseConstructor();
  const db = isBun
    ? new Database(dbPath, { create: options.create, readwrite: true })
    : new Database(
        dbPath,
        options.timeoutMs === undefined
          ? { fileMustExist: !options.create }
          : { fileMustExist: !options.create, timeout: options.timeoutMs },
      );

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  if (isBun && options.timeoutMs !== undefined) {
    db.exec(`PRAGMA busy_timeout = ${options.timeoutMs}`);
  }

  return db;
}
