import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client, Transaction } from "@libsql/client";

/**
 * Shipped migration chain. Resolved next to THIS module so the same code works
 * from source (src/memory/migrations/) and from any tsup bundle (dist/migrations/,
 * dist/hooks/migrations/, …) — the pattern schema.sql used before it.
 */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface Migration {
  /** File name without ".sql", e.g. "000-baseline". Lexicographic sort = apply order. */
  name: string;
  sql: string;
  sha256: string;
}

/** Load the shipped chain, ordered. Throws if the directory is missing (a broken build). */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), "utf8");
      return {
        name: file.slice(0, -".sql".length),
        sql,
        sha256: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

/** memory_meta key holding the name of the newest applied migration. */
export const SCHEMA_VERSION_KEY = "schema_version";

/**
 * Ledger of applied migrations. Created by the runner bootstrap, NEVER by a
 * migration — a migration file may not depend on the ledger existing.
 */
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  sha256     TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

/** A migration failed to apply. The transaction was rolled back; nothing was stamped. */
export class MigrationFailedError extends Error {
  constructor(readonly migration: string, cause: unknown) {
    super(`backant-memory: migration "${migration}" failed and was rolled back — ${String(cause)}`);
    this.name = "MigrationFailedError";
  }
}

const BUSY_RETRIES = 5;
const BUSY_BACKOFF_MS = 50;

function isBusy(err: unknown): boolean {
  return /SQLITE_BUSY|database is locked/i.test(String(err));
}

async function appliedNames(q: { execute(sql: string): Promise<{ rows: unknown[] }> }): Promise<Set<string>> {
  const rs = await q.execute("SELECT name FROM schema_migrations");
  return new Set(rs.rows.map((r) => String((r as Record<string, unknown>).name)));
}

/** Replaced in Task 3 by the real skew guard. */
function assertNoSchemaSkew(_applied: Set<string>, _migrations: Migration[]): void {}

/** Replaced in Task 4 by the folded-in upgradeOlderSchema ALTER set. */
async function normalizePreVersionedStore(_tx: Transaction): Promise<void> {}

/**
 * Bring a store up to the engine's shipped migration chain.
 *
 * Algorithm (spec §2.1): bootstrap the ledger, read the applied set, refuse a
 * store the engine is too old for (see assertNoSchemaSkew), then — only if
 * behind — take a write lock (BEGIN IMMEDIATE), RE-READ the applied set under
 * the lock, apply what is still missing, stamp the ledger and memory_meta, and
 * COMMIT. Losers of the race re-read and find themselves current.
 */
export async function runMigrations(
  client: Client,
  migrations: Migration[] = loadMigrations()
): Promise<void> {
  await client.execute(LEDGER_DDL);
  const applied = await appliedNames(client);
  assertNoSchemaSkew(applied, migrations);
  if (migrations.every((m) => applied.has(m.name))) return;

  for (let attempt = 0; ; attempt++) {
    // BEGIN IMMEDIATE is taken INSIDE the try: acquiring the write lock is the
    // most likely place to meet SQLITE_BUSY, so it must be retried like any
    // other statement in the batch.
    let tx: Transaction | undefined;
    try {
      tx = await client.transaction("write"); // BEGIN IMMEDIATE
      const underLock = await appliedNames(tx);
      const pending = migrations.filter((m) => !underLock.has(m.name));
      if (pending.length === 0) {
        // Lost the race: someone else applied everything. This transaction wrote
        // nothing, so ROLLBACK and COMMIT are equivalent — but COMMIT has to
        // out-wait the other runners' locks (SQLITE_BUSY), while ROLLBACK just
        // drops ours. Losers must never fight for a lock they don't need.
        await tx.rollback();
        return;
      }
      if (underLock.size === 0) await normalizePreVersionedStore(tx);

      const now = new Date().toISOString();
      for (const m of pending) {
        try {
          await tx.executeMultiple(m.sql);
        } catch (e) {
          throw new MigrationFailedError(m.name, e);
        }
        await tx.execute({
          sql: "INSERT INTO schema_migrations (name, sha256, applied_at) VALUES (?, ?, ?)",
          args: [m.name, m.sha256, now],
        });
      }
      await tx.execute({
        sql: `INSERT INTO memory_meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [SCHEMA_VERSION_KEY, migrations[migrations.length - 1].name],
      });
      await tx.commit();
      return;
    } catch (err) {
      try { await tx?.rollback(); } catch { /* already closed by the failure */ }
      if (isBusy(err) && attempt < BUSY_RETRIES) {
        await new Promise((r) => setTimeout(r, BUSY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      throw err;
    } finally {
      tx?.close();
    }
  }
}
