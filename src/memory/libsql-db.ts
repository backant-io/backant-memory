import { createClient, type Client, type InArgs, type InValue } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "./migrations.js";

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

/**
 * SQLITE_BUSY, including "cannot commit transaction - SQL statements in
 * progress". @libsql/client never resets a statement that failed with BUSY, so
 * it stays an active writer on the connection: later COMMITs fail and later
 * autocommit writes report ok without committing. Only a new connection clears
 * it (issue #8).
 */
export function isBusyError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return /SQLITE_BUSY|database is locked|statements in progress/i.test(`${e?.code} ${e?.message ?? err}`);
}

const BACKOFF_MS = [50, 100, 200, 400, 800];

/**
 * busy_timeout on every connection; WAL once per file (it persists). Switching
 * to WAL needs no other connection in a write, so if it cannot switch now we
 * keep the current mode and try again on the next open or reconnect.
 */
async function applyPragmas(client: Client): Promise<void> {
  await client.execute("PRAGMA busy_timeout=2000");
  try {
    await client.execute("PRAGMA journal_mode=WAL");
  } catch {
    // Busy: stay in the current mode. The failed statement is never reset, so
    // this connection is dropped too (see isBusyError).
    await client.reconnect();
    await client.execute("PRAGMA busy_timeout=2000");
  }
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

  await applyPragmas(client);

  // Bring the store up to this engine's migration chain: pre-versioning stores
  // are normalized and stamped at baseline; newer stores are refused loudly
  // (SchemaSkewError) rather than written by an older engine.
  await runMigrations(client);
  // The migration runner retries BUSY on this same connection, so it may hand
  // back one holding a stuck statement. Start the store on a clean one.
  await client.reconnect();
  await applyPragmas(client);

  // On BUSY, drop the connection (the only way to clear the stuck statement),
  // back off with jitter and retry; after the last retry surface the error.
  // The reconnect happens before every throw too, so the connection is never
  // left in a state where a later write reports ok without committing.
  async function withBusyRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isBusyError(err)) throw err;
        await client.reconnect();
        await applyPragmas(client);
        if (attempt >= BACKOFF_MS.length) throw err;
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt] * (0.5 + Math.random())));
      }
    }
  }

  return {
    async all(sql, args) {
      const rs = await withBusyRetry(() => client.execute({ sql, args: args ?? [] }));
      return rs.rows as unknown as never;
    },
    async get(sql, args) {
      const rs = await withBusyRetry(() => client.execute({ sql, args: args ?? [] }));
      return rs.rows[0] as unknown as never;
    },
    async run(sql, args) {
      await withBusyRetry(() => client.execute({ sql, args: args ?? [] }));
    },
    async batch(stmts) {
      await withBusyRetry(() =>
        client.batch(
          stmts.map((s) => ({ sql: s.sql, args: (s.args ?? []) as InArgs })),
          "write"
        )
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

export type { InArgs, InValue };
