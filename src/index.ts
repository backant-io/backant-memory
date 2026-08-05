/**
 * backant-memory — the engine. Everything a consumer needs to open a
 * repo-scoped store, embed, recall, and reason about memory content.
 *
 * Explicit named re-exports (not `export *`): `shouldArchive` is exported by
 * BOTH decay.ts (memory weight) and procedure-content.ts (procedure health).
 * decay's keeps the plain name; procedure-content's is aliased.
 */
export { openMemoryDb } from "./memory/libsql-db.js";
export type { MemoryDb, OpenOpts, InArgs, InValue } from "./memory/libsql-db.js";

export { buildMemoryContext } from "./memory/context.js";
export type { MemoryContext } from "./memory/context.js";

export {
  loadMigrations,
  runMigrations,
  MigrationFailedError,
  SchemaSkewError,
  SCHEMA_VERSION_KEY,
  MIGRATIONS_DIR,
} from "./memory/migrations.js";
export type { Migration } from "./memory/migrations.js";

export { deriveIdentity, readOrigin, parseOriginUrl, sanitizeNamespace } from "./memory/repo-identity.js";
export type { RepoIdentity } from "./memory/repo-identity.js";

export { resolveConnection } from "./memory/provision.js";
export type { Connection, ProvisionResponse, ResolveInput } from "./memory/provision.js";

export { assertEmbeddingModel } from "./memory/embedding-consistency.js";
export { encodeEmbedding, decodeEmbedding, embeddingToJson } from "./memory/embedding-util.js";

export { cacheKey, currentMemorySeq, readCache, writeCache } from "./memory/cache.js";
export type { CacheKeyInput } from "./memory/cache.js";

export { MIGRATION_CYCLE_ID, UNTRACKED_CYCLE_ID } from "./memory/constants.js";

export {
  decayFactorForTier,
  decayEdgeFactor,
  shouldArchive,
  DEMOTE_WEIGHT_CAP,
  STM_ARCHIVE_CUTOFF,
  EDGE_ARCHIVE_CUTOFF_NORMAL,
  EDGE_ARCHIVE_CUTOFF_LARGE,
} from "./memory/decay.js";

export { ACTION_TYPES, EPISODE_OUTCOMES, surpriseMultiplier } from "./memory/episodic-types.js";
export type {
  ActionType,
  EpisodeContent,
  EpisodeExpected,
  EpisodeOutcome,
  HandoffBriefContent,
  TaskStateContent,
  TaskStatePlanStep,
  TaskStateStatus,
  TaskStateTouched,
} from "./memory/episodic-types.js";

export { digestForPaths, treeShaForPath } from "./memory/git-tree-sha.js";

export {
  parseProcedure,
  serializeProcedure,
  embeddingTextFor,
  applySuccess,
  applyFailure,
  shouldPromote,
  shouldArchive as shouldArchiveProcedure,
  ARCHIVE_FLOOR,
  ARCHIVE_MIN_APPLICATIONS,
  PROMOTION_THRESHOLD,
} from "./memory/procedure-content.js";

export { recallAsOf } from "./memory/recall-history.js";
export type { AsOfHit } from "./memory/recall-history.js";

export { buildTraceResults, sweepRecallTraces, traceInsertStatement } from "./memory/recall-trace.js";
export type {
  ScoreBreakdown,
  ScoredHit,
  TraceResult,
  TraceResultSets,
  WriteTraceInput,
} from "./memory/recall-trace.js";

export type {
  CandidateVerdict,
  DreamCandidate,
  Edge,
  EdgeStatus,
  EdgeType,
  FailureSignature,
  LtmHistory,
  MemoryEntry,
  MemoryTier,
  MemoryType,
  Procedure,
  ProcedureContent,
  ProcedureStatus,
} from "./memory/types.js";

export { resolvePaths } from "./paths.js";
export type { ResolvedPaths } from "./paths.js";
