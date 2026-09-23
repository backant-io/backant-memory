import { createClient, type Client, type InArgs, type InValue } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
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
  /** How long a statement waits for another process's lock. Defaults to 2000. */
  busyTimeoutMs?: number;
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

let gcFn: (() => void) | null | undefined;
/**
 * The dropped connection's file descriptors stay open until V8 collects it
 * (2 per reconnect in WAL), so every reconnect is followed by a gc. Uses
 * global.gc under --expose-gc (the launchd service), otherwise exposes it at
 * runtime so long-lived stdio servers are covered too.
 */
function getGc(): (() => void) | null {
  if (gcFn === undefined) {
    if (typeof globalThis.gc === "function") gcFn = globalThis.gc as () => void;
    else {
      try {
        setFlagsFromString("--expose-gc");
        gcFn = runInNewContext("gc") as () => void;
      } catch {
        gcFn = null;
      }
    }
  }
  return gcFn;
}

export async function openMemoryDb(opts: OpenOpts): Promise<MemoryDb> {
  mkdirSync(dirname(opts.localPath), { recursive: true });

  const busyTimeout = `PRAGMA busy_timeout=${opts.busyTimeoutMs ?? 2000}`;
  const client = createClient({
    url: `file:${opts.localPath}`,
    ...(opts.syncUrl ? { syncUrl: opts.syncUrl, authToken: opts.authToken } : {}),
    ...(opts.syncIntervalSeconds ? { syncInterval: opts.syncIntervalSeconds * 1000 } : {}),
  });

  // Pull remote state before applying schema so we never clobber a populated
  // namespace with an empty local file.
  if (opts.syncUrl) await client.sync();

  // A new connection: the only way to clear a statement that failed with BUSY
  // (see isBusyError). The gc waits one tick, or the old handle is still live.
  async function freshConnection(): Promise<void> {
    await client.reconnect();
    await client.execute(busyTimeout);
    await new Promise((r) => setImmediate(r));
    getGc()?.();
  }

  await client.execute(busyTimeout);
  // WAL persists in the file, so only open tries it. Switching needs no other
  // connection in a write; if one is, keep the current mode and try again on
  // the next open rather than fail it.
  try {
    await client.execute("PRAGMA journal_mode=WAL");
  } catch (err) {
    if (!isBusyError(err)) throw err;
    await freshConnection();
  }

  // Bring the store up to this engine's migration chain: pre-versioning stores
  // are normalized and stamped at baseline; newer stores are refused loudly
  // (SchemaSkewError) rather than written by an older engine.
  await runMigrations(client);
  // The migration runner retries BUSY on this same connection, so it may hand
  // back one holding a stuck statement. Start the store on a clean one.
  await freshConnection();

  // On BUSY, drop the connection, back off with jitter and retry; after the
  // last retry surface the error. Every BUSY gets a fresh connection, including
  // the last: a retry on the connection a BUSY poisoned can report ok for a
  // write that never commits, even in WAL with busy_timeout.
  async function withBusyRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isBusyError(err)) throw err;
        await freshConnection();
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
