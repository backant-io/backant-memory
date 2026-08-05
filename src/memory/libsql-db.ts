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

  // Bring the store up to this engine's migration chain: pre-versioning stores
  // are normalized and stamped at baseline; newer stores are refused loudly
  // (SchemaSkewError) rather than written by an older engine.
  await runMigrations(client);

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

export type { InArgs, InValue };
