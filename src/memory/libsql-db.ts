import { createClient, type Client, type InArgs, type InValue } from "@libsql/client";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

/**
 * Async storage seam over @libsql/client. Every memory tool talks to the store
 * through this adapter (all/get/run/batch) rather than to better-sqlite3
 * directly, so the engine logic is storage-agnostic and the same code path
 * works against a local file or an embedded replica synced to a remote sqld.
 */
export interface MemoryDb {
  all<T = Record<string, unknown>>(sql: string, args?: InArgs): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, args?: InArgs): Promise<T | undefined>;
  run(sql: string, args?: InArgs): Promise<void>;
  batch(stmts: { sql: string; args?: InArgs }[]): Promise<void>;
  /** Pull latest rows from the remote primary (no-op for a pure local file). */
  sync(): Promise<void>;
  close(): Promise<void>;
  /** Current repo key (owner/repo) this connection is scoped to; "" for admin/local opens. */
  repo: string;
  raw: Client;
}

export interface OpenOpts {
  /** Local SQLite file path. With syncUrl set, this file is an embedded replica. */
  localPath: string;
  /** Remote sqld URL for the namespace. When present, opens an embedded replica. */
  syncUrl?: string;
  authToken?: string;
  /** Background sync cadence (seconds). Omit for manual sync() only. */
  syncIntervalSeconds?: number;
  /** Repo key (owner/repo) this connection is scoped to. Defaults to "". */
  repo?: string;
}

export async function openMemoryDb(opts: OpenOpts): Promise<MemoryDb> {
  mkdirSync(dirname(opts.localPath), { recursive: true });

  const client = createClient({
    url: `file:${opts.localPath}`,
    ...(opts.syncUrl ? { syncUrl: opts.syncUrl, authToken: opts.authToken } : {}),
    ...(opts.syncIntervalSeconds ? { syncInterval: opts.syncIntervalSeconds * 1000 } : {}),
  });

  // Pull remote state before applying schema so we never clobber a populated
  // namespace with an empty local file.
  if (opts.syncUrl) await client.sync();

  // Upgrade older-version stores (pre-repo schema) in place so a v1.2 .index.db
  // opens cleanly: add the repo columns the new indexes depend on before the
  // schema's CREATE INDEX … (repo …) runs. No-op on a fresh db.
  await upgradeOlderSchema(client);

  // executeMultiple runs the whole schema (including triggers and FTS5 virtual
  // tables) in one parser pass — splitting on ";" would break CREATE TRIGGER.
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  await client.executeMultiple(schemaSql);

  return {
    async all(sql, args) {
      const rs = await client.execute({ sql, args: args ?? [] });
      return rs.rows as unknown as never;
    },
    async get(sql, args) {
      const rs = await client.execute({ sql, args: args ?? [] });
      return rs.rows[0] as unknown as never;
    },
    async run(sql, args) {
      await client.execute({ sql, args: args ?? [] });
    },
    async batch(stmts) {
      await client.batch(
        stmts.map((s) => ({ sql: s.sql, args: (s.args ?? []) as InArgs })),
        "write"
      );
    },
    async sync() {
      if (opts.syncUrl) await client.sync();
    },
    async close() {
      client.close();
    },
    repo: opts.repo ?? "",
    raw: client,
  };
}

/**
 * Add the `repo` column to pre-existing tables that lack it (older-version
 * stores created before per-repo scoping) plus the Memory v2 additive columns.
 * Safe and idempotent: skips tables that don't exist yet (fresh db) or columns
 * that already exist.
 *
 * All ALTERs are collected and applied as one atomic batch so a partial failure
 * rolls back — the spec (§Error handling) guarantees the additive migration is
 * transactional and the store is never left half-migrated.
 */
async function upgradeOlderSchema(client: Client): Promise<void> {
  const alters: string[] = [];

  for (const table of ["memory", "memory_edges", "dream_bucket"]) {
    const info = await client.execute(`PRAGMA table_info(${table})`);
    if (info.rows.length === 0) continue; // table not created yet — fresh db
    const hasRepo = info.rows.some((r) => (r as Record<string, unknown>).name === "repo");
    if (!hasRepo) {
      alters.push(`ALTER TABLE ${table} ADD COLUMN repo TEXT NOT NULL DEFAULT ''`);
    }
  }

  // Memory v2 additive columns (consolidated migration). Inert in Layer 0;
  // added here so later layers need no second migration. Idempotent: only
  // ALTER when the column is absent.
  const memInfo = await client.execute("PRAGMA table_info(memory)");
  if (memInfo.rows.length > 0) {
    const has = (name: string) =>
      memInfo.rows.some((r) => (r as Record<string, unknown>).name === name);
    if (!has("verdict_boost")) {
      alters.push("ALTER TABLE memory ADD COLUMN verdict_boost REAL NOT NULL DEFAULT 0");
    }
    if (!has("valid_from")) {
      alters.push("ALTER TABLE memory ADD COLUMN valid_from TEXT");
    }
    if (!has("valid_to")) {
      alters.push("ALTER TABLE memory ADD COLUMN valid_to TEXT");
    }
  }

  // batch wraps the statements in a single transaction (all-or-nothing); skip
  // the empty case (fresh/already-migrated db) since an empty batch is a no-op.
  if (alters.length > 0) {
    await client.batch(alters, "write");
  }
}

export type { InArgs, InValue };
