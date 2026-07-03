import type { MemoryDb } from "./libsql-db.js";

/**
 * Record (on first use) and enforce the embedding model+dim a namespace was
 * built with. Because embeddings are computed locally per device, a device
 * running a different model would write vectors that don't compare against
 * existing ones — corrupting recall silently. Refuse loudly instead.
 */
export async function assertEmbeddingModel(db: MemoryDb, model: string, dim: number): Promise<void> {
  const want = `${model}:${dim}`;
  const row = await db.get<{ value: string }>(
    "SELECT value FROM memory_meta WHERE key='embed_model'"
  );
  if (!row) {
    await db.run("INSERT INTO memory_meta (key, value) VALUES ('embed_model', ?)", [want]);
    return;
  }
  if (row.value !== want) {
    throw new Error(
      `embedding model mismatch: namespace was built with ${row.value}, ` +
        `this device uses ${want}. Re-embed (backant memory reindex) or align the model.`
    );
  }
}
