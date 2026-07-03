import { homedir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, type MemoryDb } from "./libsql-db.js";
import { deriveIdentity, readOrigin } from "./repo-identity.js";
import { resolveConnection } from "./provision.js";
import { assertEmbeddingModel } from "./embedding-consistency.js";
import { loadCredentials } from "../auth/credentials.js";

export interface MemoryContext {
  db: MemoryDb;
  repo: string;
  namespace: string;
  isLocalOnly: boolean;
}

/**
 * Resolve the repo-scoped memory store for a workspace: derive owner/repo from
 * git origin, provision (create-if-absent) the owner namespace via the backant
 * backend, open the embedded replica, and enforce embedding-model consistency.
 * No git origin → a loud local-only fallback that never provisions a remote.
 *
 * Lives in its own module (no CLI entrypoint guard) so it can be imported by the
 * MCP server, the CLI, and the SessionStart hook without dragging an entrypoint
 * side-effect into their bundles.
 */
export async function buildMemoryContext(opts: {
  workspaceCwd: string;
  originUrl?: string | null;
  token?: string | null;
  kairosHome?: string;
  embeddingModel?: string;
  embeddingDim?: number;
  fetchImpl?: typeof fetch;
  /** Test/offline mode: open the local replica file only, skip remote sync. */
  forceLocal?: boolean;
}): Promise<MemoryContext> {
  // undefined → derive from the workspace; explicit null → treat as no origin.
  const origin = opts.originUrl !== undefined ? opts.originUrl : readOrigin(opts.workspaceCwd);
  const identity = deriveIdentity(origin);
  const kairosHome = opts.kairosHome ?? join(homedir(), ".claude/kairos");
  const token = opts.token ?? loadCredentials()?.access_token ?? null;

  if (identity.isLocalOnly) {
    process.stderr.write(
      "[kairos] WARNING: no git origin for this workspace — memory is LOCAL-ONLY " +
        "(not cross-device, not provisioned). Add an 'origin' remote to enable shared memory.\n"
    );
  }

  const conn = identity.isLocalOnly || opts.forceLocal
    ? { localPath: join(kairosHome, "memory", `ns-${identity.namespace}.db`), namespace: identity.namespace, syncUrl: undefined, authToken: undefined }
    : await resolveConnection({ identity, kairosHome, token, fetchImpl: opts.fetchImpl });

  const db = await openMemoryDb({
    localPath: conn.localPath,
    repo: identity.repoKey,
    syncUrl: opts.forceLocal ? undefined : conn.syncUrl,
    authToken: opts.forceLocal ? undefined : conn.authToken,
    syncIntervalSeconds: conn.syncUrl ? 30 : undefined,
  });

  await assertEmbeddingModel(
    db,
    opts.embeddingModel ?? "qwen3-embedding:0.6b",
    opts.embeddingDim ?? 1024
  );

  return { db, repo: identity.repoKey, namespace: conn.namespace, isLocalOnly: identity.isLocalOnly };
}
