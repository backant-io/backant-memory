import type { MemoryDb } from "../../memory/libsql-db.js";
import type { Embedder } from "../../ollama/embeddings.js";
import type { ProcedureContent, FailureSignature } from "../../memory/types.js";
import type { ActionType } from "../../memory/episodic-types.js";
import { embeddingToJson } from "../../memory/embedding-util.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";
import {
  parseProcedure, serializeProcedure, embeddingTextFor,
  applySuccess, applyFailure, shouldPromote, shouldArchive,
} from "../../memory/procedure-content.js";
import { writeEpisode } from "./write-episode.js";
import { writeStm } from "./write-stm.js";

/** Internal bookkeeping field stored in the row JSON alongside ProcedureContent. */
type StoredProcedure = ProcedureContent & { successes_since_proposed?: number };

export interface ProcedureOutcomeInput {
  procedure_id: string;
  outcome: "success" | "failure" | "partial";
  /** Whether the judge confirmed this application succeeded — the promotion gate (spec §3.2/3.3). */
  judge_confirmed: boolean;
  /** Episode fields (every application writes an episode — spec §3.3). */
  situation: string;
  action_type: ActionType;
  evidence: string;
  /** Cycle this application belongs to; required because EpisodeContent.cycle_id is required (Plan 1). */
  cycle_id: string;
  /** epic_id is required by EpisodeContent (Plan 1); the procedure id stands in when the
   *  application is not under a tracked epic. */
  epic_id?: string;
}

export interface ProcedureOutcomeDeps {
  db: MemoryDb;
  embedder: Embedder;
  repo?: string;
  cycleId?: string;
  input: ProcedureOutcomeInput;
  now?: () => Date;
}

export interface ProcedureOutcomeResult {
  procedure_id: string;
  status: ProcedureContent["status"];
  success_rate: number | null;
  times_applied: number;
  episode_id: string;
  failure_signature_id: string | null;
}

export async function procedureOutcome(deps: ProcedureOutcomeDeps): Promise<ProcedureOutcomeResult> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  // cycle_id comes from the tool input (required for the episode); deps.cycleId is the
  // daemon-supplied fallback, UNTRACKED last.
  const cycleId = deps.input.cycle_id ?? deps.cycleId ?? UNTRACKED_CYCLE_ID;
  const repo = deps.repo ?? deps.db.repo;

  const row = await deps.db.get<any>(
    "SELECT id, content FROM memory WHERE id = ? AND type = 'procedure'",
    [deps.input.procedure_id]
  );
  if (!row) throw new Error(`procedure not found: ${deps.input.procedure_id}`);

  const prior = parseProcedure(row.content) as StoredProcedure;
  const succeeded = deps.input.outcome === "success";

  // 1. Recompute rate/count.
  let next: StoredProcedure = succeeded ? applySuccess(prior) : applyFailure(prior);
  // The counter is only meaningful during a proposed/stale spell (spec §3.2: reset on
  // entry to proposed/stale, irrelevant once validated). Force it to 0 outside a spell so
  // a stale row carrying an elevated counter (preserved by procedureSweep's
  // validated→stale flip) cannot re-promote on a single post-stale success — it must
  // re-earn a fresh N=2.
  next.successes_since_proposed =
    next.status === "validated" || next.status === "archived"
      ? 0
      : prior.successes_since_proposed ?? 0;

  // 2. Promotion gate: count only judge-confirmed successes during the proposed/stale spell.
  if (succeeded && deps.input.judge_confirmed && (next.status === "proposed" || next.status === "stale")) {
    next.successes_since_proposed += 1;
  }
  if (shouldPromote(next.status, next.successes_since_proposed)) {
    next.status = "validated";
    next.successes_since_proposed = 0; // spell ends
  }

  // 3. Archive gate (overrides — a procedure that drops below floor is archived even if briefly validated).
  if (shouldArchive(next)) {
    next.status = "archived";
  }

  // 4. Failure → fire failure_signature path (spec §3.2). Server-side, no LLM: the
  //    procedure already names the symptom; we synthesize a FailureSignature directly.
  let failureSignatureId: string | null = null;
  if (!succeeded) {
    const sig: FailureSignature = {
      symptom: deps.input.evidence,
      attempted_fix: `applied procedure ${prior.name}`,
      constraint_violated: deps.input.situation,
      missing_signal: `procedure ${deps.input.procedure_id} did not yield ${deps.input.outcome === "partial" ? "full" : "expected"} success`,
    };
    const written = await writeStm({
      db: deps.db, embedder: deps.embedder, cycleId, repo,
      input: { type: "failure_signature", content: JSON.stringify(sig), sources: [deps.input.procedure_id] },
      now: () => new Date(now),
    });
    failureSignatureId = written.id;
  }

  // 5. Persist the coalesced row rewrite (content + FTS) in one batch (spec locked decision #10/11:
  //    UPDATE fires bump_seq_on_memory_update so recall_cache invalidates correctly).
  const newContentJson = serializeProcedure(stripInternal(next));
  const storedJson = JSON.stringify(next); // keep the internal bookkeeping field in the row
  const reEmbed = next.status !== prior.status; // name/trigger unchanged, but cheap to keep stable
  const embJson = reEmbed
    ? embeddingToJson(await deps.embedder.embed(embeddingTextFor(next)))
    : null;

  const stmts: { sql: string; args: any[] }[] = [
    {
      sql: embJson
        ? "UPDATE memory SET content = ?, last_reinforced = ?, embedding = vector32(?) WHERE id = ?"
        : "UPDATE memory SET content = ?, last_reinforced = ? WHERE id = ?",
      args: embJson
        ? [storedJson, now, embJson, deps.input.procedure_id]
        : [storedJson, now, deps.input.procedure_id],
    },
    {
      sql: "DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)",
      args: [deps.input.procedure_id],
    },
    {
      sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)",
      args: [deps.input.procedure_id, newContentJson],
    },
    {
      sql: `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
            VALUES (?, 'procedure_outcome', ?, ?, ?)`,
      args: [
        cycleId,
        JSON.stringify({ procedure_id: deps.input.procedure_id, outcome: deps.input.outcome, judge_confirmed: deps.input.judge_confirmed }),
        JSON.stringify({ status: next.status, success_rate: next.success_rate, times_applied: next.times_applied }),
        now,
      ],
    },
  ];
  await deps.db.batch(stmts);

  // 6. Every application writes an episode (spec §3.3). The procedure provenance tag
  //    rides Plan 1's singular `source` deps field (it lands in the row's sources as
  //    ['epic:<epic_id>', 'procedure:<id>']); an unknown `sources` input would be
  //    silently dropped. cycle_id and epic_id are required by EpisodeContent (Plan 1) —
  //    epic_id falls back to the procedure id when the application is not under an epic.
  const episode = await writeEpisode({
    db: deps.db, embedder: deps.embedder, cycleId, repo,
    source: `procedure:${deps.input.procedure_id}`,
    input: {
      situation: deps.input.situation,
      action_type: deps.input.action_type,
      action_taken: `apply procedure: ${prior.name}`,
      expected: "success",
      outcome: deps.input.outcome,
      evidence: deps.input.evidence,
      epic_id: deps.input.epic_id ?? deps.input.procedure_id,
      cycle_id: cycleId,
    },
    now: () => new Date(now),
  });

  return {
    procedure_id: deps.input.procedure_id,
    status: next.status,
    success_rate: next.success_rate,
    times_applied: next.times_applied,
    episode_id: episode.id,
    failure_signature_id: failureSignatureId,
  };
}

/** Drop the internal bookkeeping field for the public/FTS content view. */
function stripInternal(p: StoredProcedure): ProcedureContent {
  const { successes_since_proposed: _drop, ...rest } = p;
  return rest;
}
