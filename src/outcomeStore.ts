import type { PluginDatabase } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import { canonicalJson, workflowDigest } from '../../../platform/workflows/contracts';
import { frozenPollOutcomeSchema, pollOutcomeResult, type FrozenPollOutcome } from './outcomeConfig';
import type { PollResult } from './domain';

export function savePollOutcomeConfiguration(db: PluginDatabase, pollId: string, raw: FrozenPollOutcome): void {
  const config = frozenPollOutcomeSchema.parse(raw);
  if (workflowDigest(config.program) !== config.programDigest) throw new Error('Poll outcome preparation was changed after approval');
  const existing = getPollOutcomeConfiguration(db, pollId);
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(config)) throw new Error('Poll consequences are immutable');
    return;
  }
  if (db.get('SELECT id FROM poll_rounds WHERE poll_id = ? AND publication_started_at IS NOT NULL', pollId)) throw new Error('Poll voting configuration is frozen');
  const poll = db.get<{ creator_identity_id: string }>('SELECT creator_identity_id FROM polls WHERE id = ?', pollId);
  if (poll?.creator_identity_id !== config.requesterIdentityId) throw new Error('Only the poll requester may authorize consequences');
  db.run('INSERT INTO poll_outcome_configurations (poll_id, configuration_json, configuration_digest, approved_at) VALUES (?, ?, ?, ?)',
    pollId, canonicalJson(config), workflowDigest(config), config.approvedAt);
}

export function getPollOutcomeConfiguration(db: PluginDatabase, pollId: string): FrozenPollOutcome | undefined {
  const row = db.get<{ configuration_json: string }>('SELECT configuration_json FROM poll_outcome_configurations WHERE poll_id = ?', pollId);
  return row ? frozenPollOutcomeSchema.parse(JSON.parse(row.configuration_json)) : undefined;
}

/** Called inside the same SQLite transaction as the authoritative decision. */
export function ensurePollOutcomeHandoff(db: PluginDatabase, result: PollResult, completedAt: string, resolution?: readonly string[]): void {
  if (!getPollOutcomeConfiguration(db, result.pollId)) return;
  const resolved = pollOutcomeResult(result, resolution);
  if (!resolved) return;
  const digest = workflowDigest(resolved);
  const prior = db.get<{ result_digest: string }>('SELECT result_digest FROM poll_outcome_handoffs WHERE poll_id = ?', result.pollId);
  if (prior) {
    if (prior.result_digest !== digest) throw new Error('Poll already has another immutable consequence result');
    return;
  }
  db.run(`INSERT INTO poll_outcome_handoffs (poll_id, round_id, result_json, result_digest, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`, result.pollId, result.roundId, canonicalJson(resolved), digest, completedAt, completedAt);
}

export interface PollOutcomeHandoff extends Record<string, unknown> {
  poll_id: string; round_id: string; result_json: string; result_digest: string; workflow_run_id: string | null; reported_digest: string | null;
}
export function listPollOutcomeHandoffs(db: PluginDatabase): PollOutcomeHandoff[] {
  return db.all<PollOutcomeHandoff>('SELECT * FROM poll_outcome_handoffs ORDER BY updated_at ASC LIMIT 100');
}
