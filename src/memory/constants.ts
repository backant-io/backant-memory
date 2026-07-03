/**
 * Sentinel cycle_id used when a memory operation runs outside an active kairos cycle
 * (e.g., one-off CLI invocations, postinstall bootstrap, migration script).
 *
 * Downstream consumers (audit queries, consolidate-logs) recognise this value as
 * "not attributable to a specific cycle" rather than treating it as a real cycle.
 */
export const UNTRACKED_CYCLE_ID = "untracked";

/**
 * Sentinel cycle_id used by the markdown -> SQLite migration script. Distinct from
 * UNTRACKED_CYCLE_ID so audit queries can filter migration-time writes specifically
 * (e.g., to exclude bootstrapped seed data from cycle-level analytics).
 */
export const MIGRATION_CYCLE_ID = "migration";
