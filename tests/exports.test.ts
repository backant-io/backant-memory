import { describe, it, expect } from "vitest";
import * as engine from "../src/index.js";
import * as tools from "../src/tools/index.js";
import * as docker from "../src/docker/index.js";
import * as ollama from "../src/ollama/index.js";

/**
 * The library surface backant-kairos consumes. Every name here is imported by
 * at least one kairos file today (verified against the real import sites);
 * dropping one breaks the consumer. Runtime values only — types are proven by
 * kairos's `tsc --noEmit`, not here.
 */
describe("package export surface", () => {
  it('"." exposes the engine', () => {
    for (const name of [
      "openMemoryDb", "buildMemoryContext", "assertEmbeddingModel",
      "deriveIdentity", "readOrigin", "parseOriginUrl", "sanitizeNamespace", "resolveConnection",
      "encodeEmbedding", "decodeEmbedding", "embeddingToJson",
      "cacheKey", "currentMemorySeq", "readCache", "writeCache",
      "MIGRATION_CYCLE_ID", "UNTRACKED_CYCLE_ID",
      "decayFactorForTier", "decayEdgeFactor", "shouldArchive",
      "DEMOTE_WEIGHT_CAP", "STM_ARCHIVE_CUTOFF",
      "EDGE_ARCHIVE_CUTOFF_NORMAL", "EDGE_ARCHIVE_CUTOFF_LARGE",
      "ACTION_TYPES", "EPISODE_OUTCOMES", "surpriseMultiplier",
      "digestForPaths", "treeShaForPath",
      "parseProcedure", "serializeProcedure", "embeddingTextFor",
      "applySuccess", "applyFailure", "shouldPromote", "shouldArchiveProcedure",
      "ARCHIVE_FLOOR", "ARCHIVE_MIN_APPLICATIONS", "PROMOTION_THRESHOLD",
      "recallAsOf", "buildTraceResults", "sweepRecallTraces", "traceInsertStatement",
      "loadMigrations", "runMigrations", "SchemaSkewError", "MigrationFailedError",
      "SCHEMA_VERSION_KEY", "resolvePaths",
      "readLatestHandoffBrief", "buildHandoffSection",
    ]) {
      expect(engine, `"." must export ${name}`).toHaveProperty(name);
    }
  });

  it('"./tools" exposes every tool implementation', () => {
    for (const name of [
      "writeStm", "writeLtm", "writeEpisode", "recall", "recallWithEdges", "recallById",
      "recallByEdge", "combineScores", "attachEdgeContext", "patternCheck", "reviseLtm",
      "reinforce", "promote", "demote", "decaySweep", "bumpVerdictBoost",
      "taskStateRead", "taskStateWrite", "taskStateId",
      "procedurePropose", "procedureOutcome", "procedureGrounding", "procedureSweep",
      "edgePropose", "edgeApprove", "edgeReject", "edgesPending",
    ]) {
      expect(tools, `"./tools" must export ${name}`).toHaveProperty(name);
    }
  });

  it('"./docker" and "./ollama" expose the container + embed layers', () => {
    for (const name of [
      "isDockerAvailable", "ensureOllamaContainer", "ensureOllamaImage",
      "containerState", "CONTAINER_NAME", "IMAGE_NAME",
    ]) {
      expect(docker, `"./docker" must export ${name}`).toHaveProperty(name);
    }
    for (const name of [
      "OllamaClient", "Embedder", "ensureOllamaRunning", "isMemoryBackendReachable",
      "ensureModelInstalled", "detectHardware", "suggestTier", "embeddingDimForTier",
    ]) {
      expect(ollama, `"./ollama" must export ${name}`).toHaveProperty(name);
    }
  });
});
