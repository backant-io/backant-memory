import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { loadMigrations, runMigrations, SchemaSkewError } from "../../src/memory/migrations.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

describe("schema skew guard", () => {
  it("refuses a store stamped with a migration this engine does not ship", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-skew-"));
    const client = createClient({ url: `file:${join(tempDir, "mem.db")}` });
    await runMigrations(client); // bring it to the engine's chain

    // Simulate a NEWER engine having migrated this store.
    await client.execute({
      sql: "INSERT INTO schema_migrations (name, sha256, applied_at) VALUES (?, ?, ?)",
      args: ["999-from-the-future", "deadbeef", new Date().toISOString()],
    });
    await client.execute(
      "UPDATE memory_meta SET value='999-from-the-future' WHERE key='schema_version'"
    );

    await expect(runMigrations(client)).rejects.toThrow(SchemaSkewError);
    client.close();
  });

  it("names both versions and the upgrade hint in the message", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-skew-msg-"));
    const client = createClient({ url: `file:${join(tempDir, "mem.db")}` });
    await runMigrations(client);
    await client.execute({
      sql: "INSERT INTO schema_migrations (name, sha256, applied_at) VALUES (?, ?, ?)",
      args: ["999-from-the-future", "deadbeef", new Date().toISOString()],
    });

    const err = await runMigrations(client).catch((e) => e as SchemaSkewError);
    expect(err).toBeInstanceOf(SchemaSkewError);
    expect(err.storeVersion).toBe("999-from-the-future");
    expect(err.engineVersion).toBe(loadMigrations().at(-1)!.name);
    expect(err.message).toContain("999-from-the-future");
    expect(err.message).toContain(loadMigrations().at(-1)!.name);
    expect(err.message).toContain("npm install -g backant-memory@latest");
    client.close();
  });

  it("a store BEHIND the engine is migrated forward, not refused", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-behind-"));
    const client = createClient({ url: `file:${join(tempDir, "mem.db")}` });
    // Apply nothing: an empty ledger is "behind" by the whole chain.
    await runMigrations(client);
    const ledger = await client.execute("SELECT name FROM schema_migrations");
    expect(ledger.rows.length).toBe(loadMigrations().length);
    client.close();
  });
});
