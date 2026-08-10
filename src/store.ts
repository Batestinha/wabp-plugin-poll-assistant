import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  PluginDatabase,
  PluginDatabaseRegistry,
  PluginDatabaseRow
} from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import { numberPollOptions } from '../../../platform/transport/pollContract';
import { equivalentWhatsAppMessageIds } from '../../../platform/transport/messageIds';
import { pollAssistantDatabase } from './database';
import {
  pollAllowsMultipleAnswers,
  pollBallotSchema,
  pollDefinitionSchema,
  pollElectorSchema,
  pollReadbackBallotSchema,
  pollResultSchema,
  type PollBallot,
  type PollDefinition,
  type PollElector,
  type PollReadbackBallot,
  type PollResult
} from './domain';

const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export type PollStatus = 'active' | 'tie_pending' | 'resolved' | 'cancelled' | 'failed';
export type PollRoundStatus =
  | 'publish_pending'
  | 'publishing'
  | 'open'
  | 'finalizing'
  | 'finalized'
  | 'tie_pending'
  | 'cancelled'
  | 'failed';
export type PollPublicationOutcome = 'not_attempted' | 'unknown' | 'accepted';
export type PollDeliveryStatus = 'pending' | 'sending' | 'sent' | 'uncertain';
export type PollDeliveryKind = 'result' | 'tie' | 'cancelled' | 'failure';

export const POLL_PUBLICATION_LEASE_MS = 2 * 60 * 1_000;
export const POLL_FINALIZATION_LEASE_MS = 2 * 60 * 1_000;
export const POLL_DELIVERY_LEASE_MS = 2 * 60 * 1_000;

export class PollActiveLimitReachedError extends Error {
  override readonly name = 'PollActiveLimitReachedError';
}

export class PollTieResultDeliveryPendingError extends Error {
  override readonly name = 'PollTieResultDeliveryPendingError';
}

export interface CreatePollInput {
  definition: PollDefinition;
  scopeId: string;
  chatId: string;
  groupId?: string | undefined;
  creatorIdentityId: string;
  creatorWid: string;
  creatorLabel: string;
  roundId: string;
  publishIdempotencyKey: string;
  maxActivePollsPerChat: number;
  createdAt: string;
}

export interface StoredPollRound {
  id: string;
  pollId: string;
  roundNumber: number;
  status: PollRoundStatus;
  question: string;
  allowMultipleAnswers: boolean;
  publishIdempotencyKey: string;
  pollWaMessageId?: string | undefined;
  closesAt?: string | undefined;
  publishedAt?: string | undefined;
  finalizationAttempt: number;
  publicationAttempt: number;
  publicationClaimToken?: string | undefined;
  publicationLeaseExpiresAt?: string | undefined;
  publicationNextAttemptAt?: string | undefined;
  electorateCapturedAt?: string | undefined;
  publicationStartedAt?: string | undefined;
  publicationOutcome: PollPublicationOutcome;
  finalizationClaimToken?: string | undefined;
  finalizationLeaseExpiresAt?: string | undefined;
  finalizationNextAttemptAt?: string | undefined;
  finalizedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string | undefined;
}

export interface StoredPoll {
  id: string;
  scopeId: string;
  chatId: string;
  groupId?: string | undefined;
  creatorIdentityId: string;
  creatorWid: string;
  creatorLabel: string;
  purpose: PollDefinition['purpose'];
  definition: PollDefinition;
  status: PollStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | undefined;
  cancelledAt?: string | undefined;
  cancelledByIdentityId?: string | undefined;
  cancelledByWid?: string | undefined;
  cancelReason?: string | undefined;
  ballotsPurgedAt?: string | undefined;
  lastError?: string | undefined;
}

export interface StoredPollAggregate {
  poll: StoredPoll;
  rounds: StoredPollRound[];
  electorate: PollElector[];
}

export interface PollFinalizationClaim {
  poll: StoredPoll;
  round: StoredPollRound;
  claimToken: string;
  leaseExpiresAt: string;
}

export interface PollPublicationClaim {
  poll: StoredPoll;
  round: StoredPollRound;
  claimToken: string;
  leaseExpiresAt: string;
}

export interface StoredPollRoundOption {
  optionId: string;
  ordinal: number;
  label: string;
  wireLabel: string;
}

export interface StoredPollRoundSnapshot {
  poll: StoredPoll;
  round: StoredPollRound;
  options: StoredPollRoundOption[];
}

export interface RecoverablePollRound {
  kind: 'publication' | 'finalization';
  round: StoredPollRound;
}

export interface PollDeliveryIntent {
  id: string;
  kind: PollDeliveryKind;
  deliveryKey: string;
  chatId: string;
  text: string;
  idempotencyKey: string;
}

export interface StoredPollDelivery extends PollDeliveryIntent {
  pollId: string;
  roundId: string;
  status: PollDeliveryStatus;
  attempt: number;
  claimToken?: string | undefined;
  leaseExpiresAt?: string | undefined;
  nextAttemptAt?: string | undefined;
  messageId?: string | undefined;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
  sentAt?: string | undefined;
}

export interface PollDeliveryClaim {
  delivery: StoredPollDelivery;
  claimToken: string;
  leaseExpiresAt: string;
}

interface PollRow extends PluginDatabaseRow {
  id: string;
  scope_id: string;
  chat_id: string;
  group_id: string | null;
  creator_identity_id: string;
  creator_wid: string;
  creator_label: string;
  purpose: PollDefinition['purpose'];
  definition_json: string;
  status: PollStatus;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  cancelled_at: string | null;
  cancelled_by_identity_id: string | null;
  cancelled_by_wid: string | null;
  cancel_reason: string | null;
  ballots_purged_at: string | null;
  cleanup_next_review_at: string | null;
  last_error: string | null;
}

interface PollRoundRow extends PluginDatabaseRow {
  id: string;
  poll_id: string;
  round_number: number;
  status: PollRoundStatus;
  question: string;
  allow_multiple_answers: number;
  publish_idempotency_key: string;
  poll_wa_message_id: string | null;
  closes_at: string | null;
  published_at: string | null;
  publication_attempt: number;
  publication_claim_token: string | null;
  publication_lease_expires_at: string | null;
  publication_next_attempt_at: string | null;
  electorate_captured_at: string | null;
  publication_started_at: string | null;
  publication_outcome: PollPublicationOutcome;
  finalization_attempt: number;
  finalization_claim_token: string | null;
  finalization_lease_expires_at: string | null;
  finalization_next_attempt_at: string | null;
  finalized_at: string | null;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

interface ElectorRow extends PluginDatabaseRow {
  voter_identity_id: string;
  voter_wid: string;
  display_label: string | null;
}

interface BallotRow extends PluginDatabaseRow {
  round_id: string;
  voter_identity_id: string;
  voter_wid: string;
  selected_option_ids_json: string;
  source_kind: 'transport_event' | 'transport_readback';
  source_id: string;
  interacted_at: string;
}

interface DeliveryRow extends PluginDatabaseRow {
  id: string;
  poll_id: string;
  round_id: string;
  kind: PollDeliveryKind;
  delivery_key: string;
  chat_id: string;
  text: string;
  idempotency_key: string;
  status: PollDeliveryStatus;
  attempt: number;
  claim_token: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  message_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export function pollsDatabase(registry: PluginDatabaseRegistry | undefined): PluginDatabase {
  return pollAssistantDatabase(registry);
}

export function createPoll(db: PluginDatabase, input: CreatePollInput): StoredPollAggregate {
  const definition = pollDefinitionSchema.parse(input.definition);
  const createdAt = timestampSchema.parse(input.createdAt);
  const scopeId = required(input.scopeId, 'scopeId');
  const chatId = required(input.chatId, 'chatId');
  const groupId = input.groupId === undefined ? undefined : required(input.groupId, 'groupId');
  const creatorIdentityId = required(input.creatorIdentityId, 'creatorIdentityId');
  const creatorWid = required(input.creatorWid, 'creatorWid');
  const creatorLabel = required(input.creatorLabel, 'creatorLabel');
  const roundId = required(input.roundId, 'roundId');
  const publishIdempotencyKey = required(input.publishIdempotencyKey, 'publishIdempotencyKey');
  if (!Number.isInteger(input.maxActivePollsPerChat) || input.maxActivePollsPerChat < 1) {
    throw new Error('maxActivePollsPerChat must be a positive integer.');
  }
  const orderedOptions = [...definition.options].sort((left, right) => left.ordinal - right.ordinal);
  const wireLabels = numberPollOptions(orderedOptions.map((option) => option.label));

  return db.transaction(() => {
    const existing = getPollAggregate(db, definition.id);
    if (existing) {
      if (!matchesCreateInput(existing, {
        definition,
        scopeId,
        chatId,
        groupId,
        creatorIdentityId,
        creatorWid,
        creatorLabel,
        roundId,
        publishIdempotencyKey,
        createdAt
      })) {
        throw new Error(`Poll id ${definition.id} is already bound to different canonical input.`);
      }
      return existing;
    }
    const activeCount = db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM polls
        WHERE chat_id = ? AND status IN ('active', 'tie_pending')`,
      chatId
    )?.count ?? 0;
    if (activeCount >= input.maxActivePollsPerChat) {
      throw new PollActiveLimitReachedError(`Chat ${chatId} has reached its active poll limit.`);
    }
    db.run(
      `INSERT INTO polls (
         id, scope_id, chat_id, group_id, creator_identity_id, creator_wid, creator_label,
         purpose, definition_json, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      definition.id,
      scopeId,
      chatId,
      groupId ?? null,
      creatorIdentityId,
      creatorWid,
      creatorLabel,
      definition.purpose,
      JSON.stringify(definition),
      createdAt,
      createdAt
    );
    db.run(
      `INSERT INTO poll_rounds (
         id, poll_id, round_number, status, question, allow_multiple_answers,
         publish_idempotency_key, closes_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'publish_pending', ?, ?, ?, ?, ?, ?)`,
      roundId,
      definition.id,
      definition.question,
      pollAllowsMultipleAnswers(definition) ? 1 : 0,
      publishIdempotencyKey,
      definition.closing.kind === 'deadline' && definition.closing.deadline.mode === 'at'
        ? definition.closing.deadline.closesAt
        : null,
      createdAt,
      createdAt
    );
    orderedOptions.forEach((option, index) => {
      db.run(
        `INSERT INTO poll_options (poll_id, id, ordinal, label, wire_label, numeric_value)
         VALUES (?, ?, ?, ?, ?, ?)`,
        definition.id,
        option.id,
        option.ordinal,
        option.label,
        wireLabels[index]!,
        option.numericValue ?? null
      );
      db.run(
        `INSERT INTO poll_round_options (round_id, poll_id, option_id, ordinal)
         VALUES (?, ?, ?, ?)`,
        roundId,
        definition.id,
        option.id,
        option.ordinal
      );
    });
    return getPollAggregate(db, definition.id)!;
  });
}

export function getPollAggregate(db: PluginDatabase, pollId: string): StoredPollAggregate | undefined {
  const row = db.get<PollRow>('SELECT * FROM polls WHERE id = ?', pollId);
  if (!row) {
    return undefined;
  }
  return {
    poll: pollFromRow(row),
    rounds: db.all<PollRoundRow>(
      'SELECT * FROM poll_rounds WHERE poll_id = ? ORDER BY round_number ASC',
      pollId
    ).map(roundFromRow),
    electorate: db.all<ElectorRow>(
      `SELECT voter_identity_id, voter_wid, display_label
         FROM poll_electorate
        WHERE poll_id = ?
        ORDER BY voter_identity_id ASC`,
      pollId
    ).map(electorFromRow)
  };
}

export function listActivePollsByChat(
  db: PluginDatabase,
  chatId: string,
  limit = 100
): StoredPoll[] {
  return db.all<PollRow>(
    `SELECT * FROM polls
      WHERE chat_id = ? AND status IN ('active', 'tie_pending')
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
    required(chatId, 'chatId'),
    normalizedLimit(limit)
  ).map(pollFromRow);
}

export function listPollsByChat(
  db: PluginDatabase,
  chatId: string,
  limit = 50
): StoredPoll[] {
  return db.all<PollRow>(
    `SELECT * FROM polls
      WHERE chat_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    required(chatId, 'chatId'),
    normalizedLimit(limit)
  ).map(pollFromRow);
}

export function countActivePollsByChat(db: PluginDatabase, chatId: string): number {
  return db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM polls
      WHERE chat_id = ? AND status IN ('active', 'tie_pending')`,
    required(chatId, 'chatId')
  )?.count ?? 0;
}

export function cancelPoll(db: PluginDatabase, input: {
  pollId: string;
  cancelledByIdentityId: string;
  cancelledByWid: string;
  reason?: string | undefined;
  delivery: PollDeliveryIntent;
  cancelledAt: string;
}): boolean {
  const pollId = required(input.pollId, 'pollId');
  const cancelledAt = timestampSchema.parse(input.cancelledAt);
  validateDeliveryIntent(input.delivery);
  if (input.delivery.kind !== 'cancelled') {
    throw new Error('Poll cancellation requires a cancelled delivery.');
  }
  return db.transaction(() => {
    const round = db.get<PollRoundRow>(
      `SELECT * FROM poll_rounds WHERE poll_id = ? ORDER BY round_number DESC LIMIT 1`,
      pollId
    );
    if (!round) {
      return false;
    }
    if (round.status === 'publishing' || round.status === 'finalizing') {
      return false;
    }
    if (
      round.status === 'open'
      && round.closes_at
      && Date.parse(round.closes_at) <= Date.parse(cancelledAt)
    ) {
      return false;
    }
    requireTieResultDeliverySent(db, round);
    const updated = db.run(
      `UPDATE polls
          SET status = 'cancelled', cancelled_at = ?, cancelled_by_identity_id = ?,
              cancelled_by_wid = ?, cancel_reason = ?, updated_at = ?
        WHERE id = ? AND status IN ('active', 'tie_pending')`,
      cancelledAt,
      required(input.cancelledByIdentityId, 'cancelledByIdentityId'),
      required(input.cancelledByWid, 'cancelledByWid'),
      input.reason?.trim() || null,
      cancelledAt,
      pollId
    );
    if (updated.changes !== 1) {
      return false;
    }
    db.run(
      `UPDATE poll_rounds
          SET status = 'cancelled', publication_claim_token = NULL,
              publication_lease_expires_at = NULL, finalization_claim_token = NULL,
              finalization_lease_expires_at = NULL, updated_at = ?
        WHERE poll_id = ?
          AND status IN ('publish_pending', 'open', 'finalizing', 'tie_pending')`,
      cancelledAt,
      pollId
    );
    insertDelivery(db, pollId, round.id, input.delivery, cancelledAt);
    return true;
  });
}

export function listPollCleanupCandidateIds(db: PluginDatabase, input: {
  terminalBefore: string;
  limit?: number | undefined;
}): string[] {
  const terminalBefore = timestampSchema.parse(input.terminalBefore);
  return db.all<{ id: string }>(
    `WITH terminal_polls AS (
       SELECT p.id,
              COALESCE(p.resolved_at, p.cancelled_at, p.updated_at) AS terminal_at,
              (SELECT MAX(d.sent_at) FROM poll_deliveries d WHERE d.poll_id = p.id) AS latest_delivery_at
         FROM polls p
        WHERE p.status IN ('resolved', 'cancelled', 'failed')
          AND p.ballots_purged_at IS NULL
          AND (
            p.cleanup_next_review_at IS NULL
            OR julianday(p.cleanup_next_review_at) <= julianday(?)
          )
          AND EXISTS (SELECT 1 FROM poll_deliveries d WHERE d.poll_id = p.id)
          AND NOT EXISTS (
            SELECT 1 FROM poll_deliveries d
             WHERE d.poll_id = p.id AND d.status <> 'sent'
          )
     ), anchored AS (
       SELECT id,
              CASE
                WHEN julianday(latest_delivery_at) > julianday(terminal_at) THEN latest_delivery_at
                ELSE terminal_at
              END AS retention_anchor
         FROM terminal_polls
     )
     SELECT anchored.id
       FROM anchored
      WHERE julianday(retention_anchor) <= julianday(?)
      ORDER BY retention_anchor ASC, anchored.id ASC
      LIMIT ?`,
    terminalBefore,
    terminalBefore,
    normalizedLimit(input.limit)
  ).map((row) => row.id);
}

export function markPollCleanupReview(db: PluginDatabase, input: {
  pollId: string;
  nextReviewAt: string;
}): boolean {
  const pollId = required(input.pollId, 'pollId');
  const nextReviewAt = timestampSchema.parse(input.nextReviewAt);
  const updated = db.run(
    `UPDATE polls
        SET cleanup_next_review_at = ?
      WHERE id = ?
        AND status IN ('resolved', 'cancelled', 'failed')
        AND ballots_purged_at IS NULL`,
    nextReviewAt,
    pollId
  );
  return updated.changes === 1;
}

export function getPollRetentionAnchor(db: PluginDatabase, pollIdInput: string): string | undefined {
  const pollId = required(pollIdInput, 'pollId');
  const row = db.get<{ retention_anchor: string }>(
    `WITH terminal_poll AS (
       SELECT COALESCE(p.resolved_at, p.cancelled_at, p.updated_at) AS terminal_at,
              (SELECT MAX(d.sent_at) FROM poll_deliveries d WHERE d.poll_id = p.id) AS latest_delivery_at
         FROM polls p
        WHERE p.id = ?
          AND p.status IN ('resolved', 'cancelled', 'failed')
          AND p.ballots_purged_at IS NULL
          AND EXISTS (SELECT 1 FROM poll_deliveries d WHERE d.poll_id = p.id)
          AND NOT EXISTS (
            SELECT 1 FROM poll_deliveries d
             WHERE d.poll_id = p.id AND d.status <> 'sent'
          )
     )
     SELECT CASE
              WHEN julianday(latest_delivery_at) > julianday(terminal_at) THEN latest_delivery_at
              ELSE terminal_at
            END AS retention_anchor
       FROM terminal_poll`,
    pollId
  );
  return row ? timestampSchema.parse(row.retention_anchor) : undefined;
}

export function purgePollBallotData(db: PluginDatabase, input: {
  pollId: string;
  terminalBefore: string;
  purgedAt: string;
}): boolean {
  const pollId = required(input.pollId, 'pollId');
  const terminalBefore = timestampSchema.parse(input.terminalBefore);
  const purgedAt = timestampSchema.parse(input.purgedAt);
  return db.transaction(() => {
    const eligible = db.get(
      `WITH terminal_poll AS (
         SELECT COALESCE(p.resolved_at, p.cancelled_at, p.updated_at) AS terminal_at,
                (SELECT MAX(d.sent_at) FROM poll_deliveries d WHERE d.poll_id = p.id) AS latest_delivery_at
           FROM polls p
          WHERE p.id = ?
            AND p.status IN ('resolved', 'cancelled', 'failed')
            AND p.ballots_purged_at IS NULL
            AND EXISTS (SELECT 1 FROM poll_deliveries d WHERE d.poll_id = p.id)
            AND NOT EXISTS (
              SELECT 1 FROM poll_deliveries d
               WHERE d.poll_id = p.id AND d.status <> 'sent'
            )
       )
       SELECT 1
         FROM terminal_poll
        WHERE julianday(
          CASE
            WHEN julianday(latest_delivery_at) > julianday(terminal_at) THEN latest_delivery_at
            ELSE terminal_at
          END
        ) <= julianday(?)`,
      pollId,
      terminalBefore
    );
    if (!eligible) {
      return false;
    }
    const roundIds = db.all<{ id: string }>(
      'SELECT id FROM poll_rounds WHERE poll_id = ?',
      pollId
    ).map((row) => row.id);
    for (const roundId of roundIds) {
      db.run('DELETE FROM poll_ballots WHERE round_id = ?', roundId);
      db.run('DELETE FROM poll_vote_events WHERE round_id = ?', roundId);
      db.run('DELETE FROM poll_readbacks WHERE round_id = ?', roundId);
    }
    db.run('DELETE FROM poll_electorate WHERE poll_id = ?', pollId);
    const updated = db.run(
      `UPDATE polls
          SET ballots_purged_at = ?, cleanup_next_review_at = NULL, updated_at = ?
        WHERE id = ? AND ballots_purged_at IS NULL`,
      purgedAt,
      purgedAt,
      pollId
    );
    return updated.changes === 1;
  });
}

export function claimPollRoundPublication(db: PluginDatabase, input: {
  roundId: string;
  claimToken: string;
  now: string;
  leaseExpiresAt: string;
}): PollPublicationClaim | undefined {
  const roundId = required(input.roundId, 'roundId');
  const claimToken = required(input.claimToken, 'claimToken');
  const now = timestampSchema.parse(input.now);
  const leaseExpiresAt = timestampSchema.parse(input.leaseExpiresAt);
  if (Date.parse(leaseExpiresAt) <= Date.parse(now)) {
    throw new Error('Publication lease must expire after it starts.');
  }
  return db.transaction(() => {
    const claimed = db.run(
      `UPDATE poll_rounds
          SET status = 'publishing', publication_attempt = publication_attempt + 1,
              publication_claim_token = ?, publication_lease_expires_at = ?,
              publication_next_attempt_at = NULL, updated_at = ?, last_error = NULL
        WHERE id = ? AND poll_wa_message_id IS NULL AND (
          (status = 'publish_pending'
            AND (publication_next_attempt_at IS NULL
              OR julianday(publication_next_attempt_at) <= julianday(?)))
          OR (status = 'publishing'
            AND julianday(publication_lease_expires_at) <= julianday(?))
        )`,
      claimToken,
      leaseExpiresAt,
      now,
      roundId,
      now,
      now
    );
    if (claimed.changes !== 1) {
      return undefined;
    }
    const roundRow = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId)!;
    const pollRow = db.get<PollRow>('SELECT * FROM polls WHERE id = ?', roundRow.poll_id)!;
    return {
      poll: pollFromRow(pollRow),
      round: roundFromRow(roundRow),
      claimToken,
      leaseExpiresAt
    };
  });
}

/**
 * Extends an unexpired publication claim with compare-and-swap semantics.
 *
 * An expired token is never revived: once its lease reaches the cutoff, the
 * worker has lost authority to cross the provider mutation boundary even when
 * no successor has claimed the round yet.
 */
export function renewPollRoundPublicationClaim(db: PluginDatabase, input: {
  roundId: string;
  claimToken: string;
  now: string;
  leaseExpiresAt: string;
}): boolean {
  const now = timestampSchema.parse(input.now);
  const leaseExpiresAt = timestampSchema.parse(input.leaseExpiresAt);
  if (Date.parse(leaseExpiresAt) <= Date.parse(now)) {
    throw new Error('Renewed publication lease must expire after renewal.');
  }
  const renewed = db.run(
    `UPDATE poll_rounds
        SET publication_lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'publishing' AND publication_claim_token = ?
        AND poll_wa_message_id IS NULL
        AND julianday(publication_lease_expires_at) > julianday(?)`,
    leaseExpiresAt,
    now,
    required(input.roundId, 'roundId'),
    required(input.claimToken, 'claimToken'),
    now
  );
  return renewed.changes === 1;
}

export function reschedulePollRoundPublication(db: PluginDatabase, input: {
  roundId: string;
  claimToken: string;
  nextAttemptAt: string;
  error: string;
  updatedAt: string;
}): boolean {
  const nextAttemptAt = timestampSchema.parse(input.nextAttemptAt);
  const updatedAt = timestampSchema.parse(input.updatedAt);
  const result = db.run(
    `UPDATE poll_rounds
        SET status = 'publish_pending', publication_claim_token = NULL,
            publication_lease_expires_at = NULL, publication_next_attempt_at = ?,
            updated_at = ?, last_error = ?
      WHERE id = ? AND status = 'publishing' AND publication_claim_token = ?`,
    nextAttemptAt,
    updatedAt,
    required(input.error, 'error'),
    required(input.roundId, 'roundId'),
    required(input.claimToken, 'claimToken')
  );
  return result.changes === 1;
}

export function reschedulePollRoundPublicationUncertain(db: PluginDatabase, input: {
  roundId: string;
  claimToken: string;
  nextAttemptAt: string;
  error: string;
  updatedAt: string;
}): boolean {
  const nextAttemptAt = timestampSchema.parse(input.nextAttemptAt);
  const updatedAt = timestampSchema.parse(input.updatedAt);
  const result = db.run(
    `UPDATE poll_rounds
        SET status = 'publish_pending', publication_claim_token = NULL,
            publication_lease_expires_at = NULL, publication_next_attempt_at = ?,
            publication_outcome = 'unknown', updated_at = ?, last_error = ?
      WHERE id = ? AND status = 'publishing' AND publication_claim_token = ?
        AND poll_wa_message_id IS NULL`,
    nextAttemptAt,
    updatedAt,
    required(input.error, 'error'),
    required(input.roundId, 'roundId'),
    required(input.claimToken, 'claimToken')
  );
  return result.changes === 1;
}

/**
 * Releases a publication claim after the transport proved that no poll was sent.
 *
 * Relative deadlines and the frozen electorate are publication-time facts. They
 * must be captured again on the next real attempt; retaining them across a
 * definitely-not-sent failure could publish an already-expired poll hours later.
 */
export function resetPollRoundPublicationAfterDefiniteNonDelivery(
  db: PluginDatabase,
  input: {
    roundId: string;
    claimToken: string;
    nextAttemptAt: string;
    error: string;
    updatedAt: string;
  }
): boolean {
  const roundId = required(input.roundId, 'roundId');
  const claimToken = required(input.claimToken, 'claimToken');
  const nextAttemptAt = timestampSchema.parse(input.nextAttemptAt);
  const updatedAt = timestampSchema.parse(input.updatedAt);
  return db.transaction(() => {
    const round = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId);
    if (
      !round
      || round.status !== 'publishing'
      || round.publication_claim_token !== claimToken
      || round.poll_wa_message_id
    ) {
      return false;
    }
    db.run('DELETE FROM poll_electorate WHERE poll_id = ?', round.poll_id);
    const reset = db.run(
      `UPDATE poll_rounds
          SET status = 'publish_pending', publication_claim_token = NULL,
              publication_lease_expires_at = NULL, publication_next_attempt_at = ?,
              electorate_captured_at = NULL, publication_started_at = NULL,
              publication_outcome = 'not_attempted',
              updated_at = ?, last_error = ?
        WHERE id = ? AND status = 'publishing' AND publication_claim_token = ?
          AND poll_wa_message_id IS NULL`,
      nextAttemptAt,
      updatedAt,
      required(input.error, 'error'),
      roundId,
      claimToken
    );
    if (reset.changes !== 1) {
      throw new Error(`Publication claim for poll round ${roundId} changed while resetting it.`);
    }
    return true;
  });
}

export function capturePollElectorate(db: PluginDatabase, input: {
  roundId: string;
  claimToken: string;
  electorate: readonly PollElector[];
  capturedAt: string;
}): PollElector[] {
  const roundId = required(input.roundId, 'roundId');
  const claimToken = required(input.claimToken, 'claimToken');
  const capturedAt = timestampSchema.parse(input.capturedAt);
  const electorate = input.electorate.map((elector) => pollElectorSchema.parse(elector))
    .sort((left, right) => left.voterIdentityId.localeCompare(right.voterIdentityId));
  requireDistinct(electorate.map((elector) => elector.voterIdentityId), 'Electorate identity ids');
  return db.transaction(() => {
    const round = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId);
    if (
      !round
      || round.status !== 'publishing'
      || round.publication_claim_token !== claimToken
    ) {
      throw new Error(`Publication claim for poll round ${roundId} was lost.`);
    }
    if (round.electorate_captured_at) {
      const existing = getPollAggregate(db, round.poll_id)!.electorate;
      if (
        round.electorate_captured_at !== capturedAt
        || JSON.stringify(existing) !== JSON.stringify(electorate)
      ) {
        throw new Error(`Poll round ${roundId} already captured a different electorate.`);
      }
      return existing;
    }
    electorate.forEach((elector) => {
      db.run(
        `INSERT INTO poll_electorate (
           poll_id, voter_identity_id, voter_wid, display_label, captured_at
         ) VALUES (?, ?, ?, ?, ?)`,
        round.poll_id,
        elector.voterIdentityId,
        elector.voterWid,
        elector.displayLabel ?? null,
        capturedAt
      );
    });
    const updated = db.run(
      `UPDATE poll_rounds
          SET electorate_captured_at = ?, updated_at = ?
        WHERE id = ? AND status = 'publishing' AND publication_claim_token = ?
          AND electorate_captured_at IS NULL`,
      capturedAt,
      capturedAt,
      roundId,
      claimToken
    );
    if (updated.changes !== 1) {
      throw new Error(`Publication claim for poll round ${roundId} was lost.`);
    }
    return electorate;
  });
}

/**
 * Discards an electorate that was captured by a publication worker which
 * stopped before durably anchoring its first provider invocation.
 *
 * No native send can have started while publication_started_at is null, so a
 * reclaimed worker must take a fresh membership snapshot instead of treating
 * the abandoned observation as members-at-publication evidence.
 */
export function discardUnanchoredPollElectorate(db: PluginDatabase, input: {
  roundId: string;
  claimToken: string;
  updatedAt: string;
}): boolean {
  const roundId = required(input.roundId, 'roundId');
  const claimToken = required(input.claimToken, 'claimToken');
  const updatedAt = timestampSchema.parse(input.updatedAt);
  return db.transaction(() => {
    const round = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId);
    if (
      !round
      || round.status !== 'publishing'
      || round.publication_claim_token !== claimToken
      || round.poll_wa_message_id
    ) {
      throw new Error(`Publication claim for poll round ${roundId} was lost.`);
    }
    if (round.publication_started_at || !round.electorate_captured_at) {
      return false;
    }
    db.run('DELETE FROM poll_electorate WHERE poll_id = ?', round.poll_id);
    const updated = db.run(
      `UPDATE poll_rounds
          SET electorate_captured_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'publishing' AND publication_claim_token = ?
          AND electorate_captured_at IS NOT NULL AND publication_started_at IS NULL
          AND poll_wa_message_id IS NULL`,
      updatedAt,
      roundId,
      claimToken
    );
    if (updated.changes !== 1) {
      throw new Error(`Publication claim for poll round ${roundId} changed while refreshing its electorate.`);
    }
    return true;
  });
}

/**
 * Durably anchors the first provider invocation independently from the earlier
 * electorate observation. The existing value wins on an ambiguous retry so a
 * later send attempt can never extend a relative voting window.
 */
export function startPollRoundPublicationAttempt(db: PluginDatabase, input: {
  roundId: string;
  claimToken: string;
  startedAt: string;
}): string {
  const roundId = required(input.roundId, 'roundId');
  const claimToken = required(input.claimToken, 'claimToken');
  const startedAt = timestampSchema.parse(input.startedAt);
  return db.transaction(() => {
    const round = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId);
    if (
      !round
      || round.status !== 'publishing'
      || round.publication_claim_token !== claimToken
      || !round.electorate_captured_at
      || round.poll_wa_message_id
    ) {
      throw new Error(`Publication claim for poll round ${roundId} was lost before provider invocation.`);
    }
    if (round.publication_started_at) {
      return round.publication_started_at;
    }
    const updated = db.run(
      `UPDATE poll_rounds
          SET publication_started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'publishing' AND publication_claim_token = ?
          AND electorate_captured_at IS NOT NULL AND publication_started_at IS NULL
          AND poll_wa_message_id IS NULL`,
      startedAt,
      startedAt,
      roundId,
      claimToken
    );
    if (updated.changes !== 1) {
      throw new Error(`Publication claim for poll round ${roundId} changed before provider invocation.`);
    }
    return startedAt;
  });
}

export function getCapturedPollElectorateByRoundId(
  db: PluginDatabase,
  roundId: string
): PollElector[] | undefined {
  const round = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId);
  if (!round?.electorate_captured_at) {
    return undefined;
  }
  return getPollAggregate(db, round.poll_id)!.electorate;
}

export function failPollRoundPublication(db: PluginDatabase, input: {
  roundId: string;
  claimToken: string;
  error: string;
  delivery: PollDeliveryIntent;
  failedAt: string;
}): boolean {
  const roundId = required(input.roundId, 'roundId');
  const claimToken = required(input.claimToken, 'claimToken');
  const failedAt = timestampSchema.parse(input.failedAt);
  validateDeliveryIntent(input.delivery);
  if (input.delivery.kind !== 'failure') {
    throw new Error('Terminal publication failure requires a failure delivery.');
  }
  return db.transaction(() => {
    const round = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId);
    if (
      !round
      || round.status !== 'publishing'
      || round.publication_claim_token !== claimToken
    ) {
      return false;
    }
    const error = required(input.error, 'error');
    db.run(
      `UPDATE poll_rounds
          SET status = 'failed', publication_claim_token = NULL,
              publication_lease_expires_at = NULL, updated_at = ?, last_error = ?
        WHERE id = ? AND status = 'publishing' AND publication_claim_token = ?`,
      failedAt,
      error,
      roundId,
      claimToken
    );
    db.run(
      `UPDATE polls SET status = 'failed', updated_at = ?, last_error = ?
        WHERE id = ? AND status = 'active'`,
      failedAt,
      error,
      round.poll_id
    );
    insertDelivery(db, round.poll_id, roundId, input.delivery, failedAt);
    return true;
  });
}

export function markPollRoundPublished(db: PluginDatabase, input: {
  roundId: string;
  claimToken: string;
  pollWaMessageId: string;
  acceptedAt: string;
  deadlineAnchorAt?: string | undefined;
}): boolean {
  const acceptedAt = timestampSchema.parse(input.acceptedAt);
  const deadlineAnchorAt = timestampSchema.parse(input.deadlineAnchorAt ?? acceptedAt);
  if (Date.parse(deadlineAnchorAt) > Date.parse(acceptedAt)) {
    throw new Error('A Poll deadline anchor cannot be later than provider acceptance.');
  }
  const roundId = required(input.roundId, 'roundId');
  const claimToken = required(input.claimToken, 'claimToken');
  return db.transaction(() => {
    const round = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId);
    if (
      !round
      || round.status !== 'publishing'
      || round.publication_claim_token !== claimToken
      || !round.electorate_captured_at
      || !round.publication_started_at
      || round.poll_wa_message_id
    ) {
      return false;
    }
    const poll = db.get<PollRow>('SELECT * FROM polls WHERE id = ?', round.poll_id)!;
    const definition = pollFromRow(poll).definition;
    const closesAt = definition.closing.kind === 'deadline'
      && definition.closing.deadline.mode === 'after_publish'
      ? new Date(
          Date.parse(deadlineAnchorAt)
            + definition.closing.deadline.durationMinutes * 60_000
        ).toISOString()
      : round.closes_at;
    const result = db.run(
      `UPDATE poll_rounds
          SET status = 'open', poll_wa_message_id = ?, published_at = ?, closes_at = ?,
              publication_outcome = 'accepted',
              publication_claim_token = NULL, publication_lease_expires_at = NULL,
              publication_next_attempt_at = NULL, updated_at = ?, last_error = NULL
        WHERE id = ? AND status = 'publishing' AND publication_claim_token = ?
          AND poll_wa_message_id IS NULL`,
      required(input.pollWaMessageId, 'pollWaMessageId'),
      acceptedAt,
      closesAt,
      acceptedAt,
      roundId,
      claimToken
    );
    return result.changes === 1;
  });
}

export function getPollRoundByWhatsAppMessageId(
  db: PluginDatabase,
  pollWaMessageId: string
): StoredPollRound | undefined {
  const exact = db.get<PollRoundRow>(
    'SELECT * FROM poll_rounds WHERE poll_wa_message_id = ?',
    pollWaMessageId
  );
  if (exact) {
    return roundFromRow(exact);
  }
  const equivalent = db.all<PollRoundRow>(
    `SELECT * FROM poll_rounds
      WHERE poll_wa_message_id IS NOT NULL
      ORDER BY created_at DESC, id ASC`
  ).find((row) => equivalentWhatsAppMessageIds(row.poll_wa_message_id ?? undefined, pollWaMessageId));
  return equivalent ? roundFromRow(equivalent) : undefined;
}

export function getPollRoundSnapshotByWhatsAppMessageId(
  db: PluginDatabase,
  pollWaMessageId: string
): StoredPollRoundSnapshot | undefined {
  const round = getPollRoundByWhatsAppMessageId(db, pollWaMessageId);
  return round ? getPollRoundSnapshot(db, round.id) : undefined;
}

export function getPollLifecycleByRoundId(
  db: PluginDatabase,
  roundId: string
): StoredPollRoundSnapshot | undefined {
  return getPollRoundSnapshot(db, roundId);
}

export function listRecoverablePollRounds(db: PluginDatabase, input: {
  now: string;
  limit?: number | undefined;
}): RecoverablePollRound[] {
  const now = timestampSchema.parse(input.now);
  const limit = normalizedLimit(input.limit);
  const rows = db.all<PollRoundRow>(
    `SELECT * FROM poll_rounds
      WHERE (
        (status = 'publish_pending'
          AND (publication_next_attempt_at IS NULL
            OR julianday(publication_next_attempt_at) <= julianday(?)))
        OR (status = 'publishing'
          AND julianday(publication_lease_expires_at) <= julianday(?))
        OR (status = 'open' AND closes_at IS NOT NULL
          AND julianday(closes_at) <= julianday(?)
          AND (finalization_next_attempt_at IS NULL
            OR julianday(finalization_next_attempt_at) <= julianday(?)))
        OR (status = 'finalizing'
          AND julianday(finalization_lease_expires_at) <= julianday(?))
      )
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
    now,
    now,
    now,
    now,
    now,
    limit
  );
  return rows.map((row) => ({
    kind: row.status === 'publish_pending' || row.status === 'publishing'
      ? 'publication'
      : 'finalization',
    round: roundFromRow(row)
  }));
}

function getPollRoundSnapshot(
  db: PluginDatabase,
  roundId: string
): StoredPollRoundSnapshot | undefined {
  const roundRow = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId);
  if (!roundRow) {
    return undefined;
  }
  const pollRow = db.get<PollRow>('SELECT * FROM polls WHERE id = ?', roundRow.poll_id)!;
  const options = db.all<{
    option_id: string;
    ordinal: number;
    label: string;
    wire_label: string;
  }>(
    `SELECT pro.option_id, pro.ordinal, po.label, po.wire_label
       FROM poll_round_options pro
       JOIN poll_options po ON po.poll_id = pro.poll_id AND po.id = pro.option_id
      WHERE pro.round_id = ?
      ORDER BY pro.ordinal ASC`,
    roundId
  ).map((row) => ({
    optionId: row.option_id,
    ordinal: row.ordinal,
    label: row.label,
    wireLabel: row.wire_label
  }));
  return { poll: pollFromRow(pollRow), round: roundFromRow(roundRow), options };
}

export type RecordPollVoteResult = 'materialized' | 'stale' | 'duplicate' | 'audit_only';

export function recordPollVoteEvent(db: PluginDatabase, input: {
  ballot: PollBallot;
  receivedAt: string;
}): RecordPollVoteResult {
  const ballot = pollBallotSchema.parse(input.ballot);
  if (ballot.source.kind !== 'transport_event') {
    throw new Error('Live vote events require a transport_event ballot source.');
  }
  const sourceWaMessageId = ballot.source.waMessageId;
  const receivedAt = timestampSchema.parse(input.receivedAt);
  return db.transaction(() => {
    const duplicate = db.get(
      `SELECT 1 FROM poll_vote_events
        WHERE round_id = ? AND source_wa_message_id = ?`,
      ballot.roundId,
      sourceWaMessageId
    );
    if (duplicate) {
      return 'duplicate';
    }
    const round = db.get<{ poll_id: string; status: PollRoundStatus }>(
      'SELECT poll_id, status FROM poll_rounds WHERE id = ?',
      ballot.roundId
    );
    if (!round || !['open', 'finalizing'].includes(round.status)) {
      throw new Error(`Poll round ${ballot.roundId} is not accepting vote events.`);
    }
    const elector = db.get(
      `SELECT 1 FROM poll_electorate
        WHERE poll_id = ? AND voter_identity_id = ?`,
      round.poll_id,
      ballot.voterIdentityId
    );
    if (!elector) {
      throw new Error(`Voter identity ${ballot.voterIdentityId} is not in the captured electorate.`);
    }
    const optionRows = db.all<{ option_id: string; ordinal: number }>(
      `SELECT option_id, ordinal FROM poll_round_options
        WHERE round_id = ? ORDER BY ordinal ASC`,
      ballot.roundId
    );
    const ordinalByOptionId = new Map(optionRows.map((option) => [option.option_id, option.ordinal]));
    if (ballot.selectedOptionIds.some((optionId) => !ordinalByOptionId.has(optionId))) {
      throw new Error(`Vote event ${sourceWaMessageId} contains an unknown option id.`);
    }
    const allowsMultiple = db.get<{ allow_multiple_answers: number }>(
      'SELECT allow_multiple_answers FROM poll_rounds WHERE id = ?',
      ballot.roundId
    )!.allow_multiple_answers === 1;
    if (!allowsMultiple && ballot.selectedOptionIds.length > 1) {
      throw new Error(`Vote event ${sourceWaMessageId} selects too many options.`);
    }
    const selectedOptionIds = [...ballot.selectedOptionIds].sort(
      (left, right) => ordinalByOptionId.get(left)! - ordinalByOptionId.get(right)!
    );
    db.run(
      `INSERT INTO poll_vote_events (
         round_id, source_wa_message_id, voter_identity_id, voter_wid,
         selected_option_ids_json, interacted_at, received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ballot.roundId,
      sourceWaMessageId,
      ballot.voterIdentityId,
      ballot.voterWid,
      JSON.stringify(selectedOptionIds),
      ballot.interactedAt,
      receivedAt
    );
    if (round.status === 'finalizing') {
      return 'audit_only';
    }
    const existing = db.get<{ interacted_at: string; source_id: string }>(
      `SELECT interacted_at, source_id FROM poll_ballots
        WHERE round_id = ? AND voter_identity_id = ?`,
      ballot.roundId,
      ballot.voterIdentityId
    );
    if (existing && !isVoteNewer(ballot, existing)) {
      return 'stale';
    }
    db.run(
      `INSERT INTO poll_ballots (
         round_id, voter_identity_id, voter_wid, selected_option_ids_json,
         source_kind, source_id, interacted_at, updated_at
       ) VALUES (?, ?, ?, ?, 'transport_event', ?, ?, ?)
       ON CONFLICT(round_id, voter_identity_id) DO UPDATE SET
         voter_wid = excluded.voter_wid,
         selected_option_ids_json = excluded.selected_option_ids_json,
         source_kind = excluded.source_kind,
         source_id = excluded.source_id,
         interacted_at = excluded.interacted_at,
         updated_at = excluded.updated_at`,
      ballot.roundId,
      ballot.voterIdentityId,
      ballot.voterWid,
      JSON.stringify(selectedOptionIds),
      sourceWaMessageId,
      ballot.interactedAt,
      receivedAt
    );
    return 'materialized';
  });
}

export function listPollBallots(db: PluginDatabase, roundId: string): PollBallot[] {
  return db.all<BallotRow>(
    'SELECT * FROM poll_ballots WHERE round_id = ? ORDER BY voter_identity_id ASC',
    roundId
  ).map((row) => pollBallotSchema.parse({
    roundId: row.round_id,
    voterIdentityId: row.voter_identity_id,
    voterWid: row.voter_wid,
    selectedOptionIds: parseJson(row.selected_option_ids_json, 'poll ballot selections'),
    source: row.source_kind === 'transport_event'
      ? { kind: 'transport_event', waMessageId: row.source_id }
      : { kind: 'transport_readback', readbackId: row.source_id },
    interactedAt: row.interacted_at
  }));
}

export function replacePollBallotsFromAuthoritativeReadback(db: PluginDatabase, input: {
  roundId: string;
  claimToken: string;
  readbackId: string;
  ballots: readonly PollReadbackBallot[];
  readAt: string;
}): PollBallot[] {
  const roundId = required(input.roundId, 'roundId');
  const claimToken = required(input.claimToken, 'claimToken');
  const readbackId = required(input.readbackId, 'readbackId');
  const readAt = timestampSchema.parse(input.readAt);
  const ballots = input.ballots.map((ballot) => pollReadbackBallotSchema.parse(ballot));
  requireDistinct(ballots.map((ballot) => ballot.voterIdentityId), 'Readback voter identity ids');
  return db.transaction(() => {
    const round = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId);
    if (
      !round
      || round.status !== 'finalizing'
      || round.finalization_claim_token !== claimToken
    ) {
      throw new Error(`Finalization claim for poll round ${roundId} was lost.`);
    }
    if (!round.closes_at) {
      throw new Error(`Poll round ${roundId} has no authoritative close cutoff.`);
    }
    const electorateWidByIdentityId = new Map(db.all<{
      voter_identity_id: string;
      voter_wid: string;
    }>(
      'SELECT voter_identity_id, voter_wid FROM poll_electorate WHERE poll_id = ?',
      round.poll_id
    ).map((row) => [row.voter_identity_id, row.voter_wid]));
    const optionRows = db.all<{ option_id: string; ordinal: number }>(
      `SELECT option_id, ordinal FROM poll_round_options
        WHERE round_id = ? ORDER BY ordinal ASC`,
      roundId
    );
    const ordinalByOptionId = new Map(optionRows.map((row) => [row.option_id, row.ordinal]));
    for (const ballot of ballots) {
      if (!electorateWidByIdentityId.has(ballot.voterIdentityId)) {
        throw new Error(`Voter identity ${ballot.voterIdentityId} is not in the captured electorate.`);
      }
      if (ballot.selectedOptionIds.some((optionId) => !ordinalByOptionId.has(optionId))) {
        throw new Error(`Readback ballot for ${ballot.voterIdentityId} contains an unknown option id.`);
      }
      if (!round.allow_multiple_answers && ballot.selectedOptionIds.length > 1) {
        throw new Error(`Readback ballot for ${ballot.voterIdentityId} selects too many options.`);
      }
      if (Date.parse(ballot.interactedAt) > Date.parse(round.closes_at)) {
        throw new Error(`Readback ballot for ${ballot.voterIdentityId} occurred after the close cutoff.`);
      }
    }
    const canonicalBallots = [...ballots]
      .sort((left, right) => left.voterIdentityId.localeCompare(right.voterIdentityId))
      .map((ballot) => ({
        ...ballot,
        // Never hash a mutable transport delivery alias. This also fences any
        // future caller of the store API to the publication-time electorate.
        voterWid: electorateWidByIdentityId.get(ballot.voterIdentityId)!,
        selectedOptionIds: [...ballot.selectedOptionIds].sort(
          (left, right) => ordinalByOptionId.get(left)! - ordinalByOptionId.get(right)!
        )
      }));
    const ballotsJson = JSON.stringify(canonicalBallots);
    const ballotsSha256 = createHash('sha256').update(ballotsJson).digest('hex');
    const existing = db.get<{ ballots_sha256: string }>(
      'SELECT ballots_sha256 FROM poll_readbacks WHERE round_id = ? AND id = ?',
      roundId,
      readbackId
    );
    if (existing && existing.ballots_sha256 !== ballotsSha256) {
      throw new Error(`Poll readback ${readbackId} is immutable and already contains different ballots.`);
    }
    if (!existing) {
      db.run(
        `INSERT INTO poll_readbacks (
           round_id, id, ballots_json, ballots_sha256, read_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        roundId,
        readbackId,
        ballotsJson,
        ballotsSha256,
        readAt,
        readAt
      );
    }
    db.run('DELETE FROM poll_ballots WHERE round_id = ?', roundId);
    canonicalBallots.forEach((ballot) => {
      db.run(
        `INSERT INTO poll_ballots (
           round_id, voter_identity_id, voter_wid, selected_option_ids_json,
           source_kind, source_id, interacted_at, updated_at
         ) VALUES (?, ?, ?, ?, 'transport_readback', ?, ?, ?)`,
        roundId,
        ballot.voterIdentityId,
        ballot.voterWid,
        JSON.stringify(ballot.selectedOptionIds),
        readbackId,
        ballot.interactedAt,
        readAt
      );
    });
    return listPollBallots(db, roundId);
  });
}

export function createPollResultInputSha256(input: {
  definition: PollDefinition;
  electorateIdentityIds: readonly string[];
  ballots: readonly PollBallot[];
  cutoffAt: string;
}): string {
  const definition = pollDefinitionSchema.parse(input.definition);
  const canonical = {
    definition,
    electorateIdentityIds: [...input.electorateIdentityIds].sort(),
    ballots: input.ballots.map((ballot) => pollBallotSchema.parse(ballot))
      .sort((left, right) => left.voterIdentityId.localeCompare(right.voterIdentityId))
      .map((ballot) => ({ ...ballot, selectedOptionIds: [...ballot.selectedOptionIds].sort() })),
    cutoffAt: timestampSchema.parse(input.cutoffAt)
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function claimPollRoundFinalization(db: PluginDatabase, input: {
  roundId: string;
  claimToken: string;
  now: string;
  leaseExpiresAt: string;
}): PollFinalizationClaim | undefined {
  const roundId = required(input.roundId, 'roundId');
  const claimToken = required(input.claimToken, 'claimToken');
  const now = timestampSchema.parse(input.now);
  const leaseExpiresAt = timestampSchema.parse(input.leaseExpiresAt);
  if (Date.parse(leaseExpiresAt) <= Date.parse(now)) {
    throw new Error('Finalization lease must expire after it starts.');
  }
  return db.transaction(() => {
    const result = db.run(
      `UPDATE poll_rounds
          SET status = 'finalizing',
              finalization_attempt = finalization_attempt + 1,
              finalization_claim_token = ?,
              finalization_lease_expires_at = ?,
              finalization_next_attempt_at = NULL,
              updated_at = ?,
              last_error = NULL
        WHERE id = ?
          AND (
            (status = 'open'
              AND julianday(closes_at) <= julianday(?)
              AND (finalization_next_attempt_at IS NULL
                OR julianday(finalization_next_attempt_at) <= julianday(?)))
            OR (status = 'finalizing'
              AND julianday(finalization_lease_expires_at) <= julianday(?))
          )`,
      claimToken,
      leaseExpiresAt,
      now,
      roundId,
      now,
      now,
      now
    );
    if (result.changes !== 1) {
      return undefined;
    }
    const roundRow = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId)!;
    const pollRow = db.get<PollRow>('SELECT * FROM polls WHERE id = ?', roundRow.poll_id)!;
    return {
      poll: pollFromRow(pollRow),
      round: roundFromRow(roundRow),
      claimToken,
      leaseExpiresAt
    };
  });
}

export function requestPollRoundClose(db: PluginDatabase, input: {
  roundId: string;
  requestedAt: string;
}): boolean {
  const requestedAt = timestampSchema.parse(input.requestedAt);
  const roundId = required(input.roundId, 'roundId');
  return db.transaction(() => {
    const round = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId);
    if (!round) {
      return false;
    }
    if (['finalizing', 'finalized', 'tie_pending'].includes(round.status)) {
      return Boolean(round.closes_at && Date.parse(round.closes_at) <= Date.parse(requestedAt));
    }
    const result = db.run(
      `UPDATE poll_rounds
          SET closes_at = CASE
                WHEN closes_at IS NULL OR julianday(?) < julianday(closes_at) THEN ?
                ELSE closes_at
              END,
              finalization_next_attempt_at = NULL,
              updated_at = ?
        WHERE id = ? AND status = 'open'`,
      requestedAt,
      requestedAt,
      requestedAt,
      roundId
    );
    return result.changes === 1;
  });
}

export function reschedulePollRoundFinalization(db: PluginDatabase, input: {
  roundId: string;
  claimToken: string;
  nextAttemptAt: string;
  error: string;
  updatedAt: string;
}): boolean {
  const nextAttemptAt = timestampSchema.parse(input.nextAttemptAt);
  const updatedAt = timestampSchema.parse(input.updatedAt);
  const result = db.run(
    `UPDATE poll_rounds
        SET status = 'open',
            finalization_claim_token = NULL,
            finalization_lease_expires_at = NULL,
            finalization_next_attempt_at = ?,
            updated_at = ?,
            last_error = ?
      WHERE id = ? AND status = 'finalizing' AND finalization_claim_token = ?`,
    nextAttemptAt,
    updatedAt,
    required(input.error, 'error'),
    required(input.roundId, 'roundId'),
    required(input.claimToken, 'claimToken')
  );
  return result.changes === 1;
}

export type CompletePollRoundResult = 'completed' | 'already_completed' | 'claim_lost';

export function completePollRoundFinalization(db: PluginDatabase, input: {
  roundId: string;
  claimToken: string;
  result: PollResult;
  inputSha256: string;
  readbackSource: 'events' | 'transport_readback';
  delivery: PollDeliveryIntent;
  completedAt: string;
}): CompletePollRoundResult {
  const resultDocument = pollResultSchema.parse(input.result);
  const roundId = required(input.roundId, 'roundId');
  const claimToken = required(input.claimToken, 'claimToken');
  const inputSha256 = sha256Schema.parse(input.inputSha256);
  const completedAt = timestampSchema.parse(input.completedAt);
  validateDeliveryIntent(input.delivery);
  if (resultDocument.roundId !== roundId) {
    throw new Error('Poll result roundId does not match the finalization round.');
  }
  const tiePending = resultDocument.purpose === 'decide'
    && resultDocument.outcome.status === 'tie';
  if ((input.delivery.kind === 'tie') !== tiePending) {
    throw new Error('Tie results require a tie delivery; non-tie results require another delivery kind.');
  }
  return db.transaction(() => {
    const existing = db.get<{ result_json: string; input_sha256: string }>(
      'SELECT result_json, input_sha256 FROM poll_results WHERE round_id = ?',
      roundId
    );
    if (existing) {
      const sameResult = JSON.stringify(pollResultSchema.parse(parseJson(
        existing.result_json,
        'poll result'
      ))) === JSON.stringify(resultDocument);
      if (!sameResult || existing.input_sha256 !== inputSha256) {
        throw new Error(`Poll round ${roundId} already has a different immutable result.`);
      }
      return 'already_completed';
    }
    const round = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId);
    if (
      !round
      || round.status !== 'finalizing'
      || round.finalization_claim_token !== claimToken
      || !round.finalization_lease_expires_at
      || Date.parse(round.finalization_lease_expires_at) < Date.parse(completedAt)
    ) {
      return 'claim_lost';
    }
    if (resultDocument.pollId !== round.poll_id) {
      throw new Error('Poll result pollId does not match its round.');
    }
    db.run(
      `INSERT INTO poll_results (
         round_id, poll_id, result_json, input_sha256, cutoff_at, readback_source, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      roundId,
      round.poll_id,
      JSON.stringify(resultDocument),
      inputSha256,
      resultDocument.cutoffAt,
      input.readbackSource,
      completedAt
    );
    db.run(
      `UPDATE poll_rounds
          SET status = ?, finalized_at = ?, finalization_claim_token = NULL,
              finalization_lease_expires_at = NULL, updated_at = ?, last_error = NULL
        WHERE id = ? AND status = 'finalizing' AND finalization_claim_token = ?`,
      tiePending ? 'tie_pending' : 'finalized',
      completedAt,
      completedAt,
      roundId,
      claimToken
    );
    db.run(
      `UPDATE polls
          SET status = ?, resolved_at = ?, updated_at = ?, last_error = NULL
        WHERE id = ? AND status = 'active'`,
      tiePending ? 'tie_pending' : 'resolved',
      tiePending ? null : completedAt,
      completedAt,
      round.poll_id
    );
    insertDelivery(db, round.poll_id, roundId, input.delivery, completedAt);
    return 'completed';
  });
}

export function getPollResult(db: PluginDatabase, roundId: string): PollResult | undefined {
  const row = db.get<{ result_json: string }>(
    'SELECT result_json FROM poll_results WHERE round_id = ?',
    roundId
  );
  return row
    ? pollResultSchema.parse(parseJson(row.result_json, 'poll result'))
    : undefined;
}

export function claimNextPollDelivery(db: PluginDatabase, input: {
  claimToken: string;
  now: string;
  leaseExpiresAt: string;
}): PollDeliveryClaim | undefined {
  const claimToken = required(input.claimToken, 'claimToken');
  const now = timestampSchema.parse(input.now);
  const leaseExpiresAt = timestampSchema.parse(input.leaseExpiresAt);
  if (Date.parse(leaseExpiresAt) <= Date.parse(now)) {
    throw new Error('Delivery lease must expire after it starts.');
  }
  return db.transaction(() => {
    const candidate = db.get<DeliveryRow>(
      `SELECT * FROM poll_deliveries
        WHERE (
          (status = 'pending' AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday(?)))
          OR (status = 'sending' AND julianday(lease_expires_at) <= julianday(?))
        )
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      now,
      now
    );
    if (!candidate) {
      return undefined;
    }
    const claimed = db.run(
      `UPDATE poll_deliveries
          SET status = 'sending', attempt = attempt + 1, claim_token = ?,
              lease_expires_at = ?, updated_at = ?, last_error = NULL
        WHERE id = ? AND status = ? AND COALESCE(claim_token, '') = COALESCE(?, '')`,
      claimToken,
      leaseExpiresAt,
      now,
      candidate.id,
      candidate.status,
      candidate.claim_token
    );
    if (claimed.changes !== 1) {
      return undefined;
    }
    const delivery = deliveryFromRow(
      db.get<DeliveryRow>('SELECT * FROM poll_deliveries WHERE id = ?', candidate.id)!
    );
    return { delivery, claimToken, leaseExpiresAt };
  });
}

export function claimPollDeliveryById(db: PluginDatabase, input: {
  deliveryId: string;
  claimToken: string;
  now: string;
  leaseExpiresAt: string;
}): PollDeliveryClaim | undefined {
  const deliveryId = required(input.deliveryId, 'deliveryId');
  const claimToken = required(input.claimToken, 'claimToken');
  const now = timestampSchema.parse(input.now);
  const leaseExpiresAt = timestampSchema.parse(input.leaseExpiresAt);
  if (Date.parse(leaseExpiresAt) <= Date.parse(now)) {
    throw new Error('Delivery lease must expire after it starts.');
  }
  return db.transaction(() => {
    const claimed = db.run(
      `UPDATE poll_deliveries
          SET status = 'sending', attempt = attempt + 1, claim_token = ?,
              lease_expires_at = ?, updated_at = ?, last_error = NULL
        WHERE id = ? AND (
          (status = 'pending'
            AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday(?)))
          OR (status = 'sending' AND julianday(lease_expires_at) <= julianday(?))
        )`,
      claimToken,
      leaseExpiresAt,
      now,
      deliveryId,
      now,
      now
    );
    if (claimed.changes !== 1) {
      return undefined;
    }
    return {
      delivery: deliveryFromRow(
        db.get<DeliveryRow>('SELECT * FROM poll_deliveries WHERE id = ?', deliveryId)!
      ),
      claimToken,
      leaseExpiresAt
    };
  });
}

export function listRecoverablePollDeliveryIds(db: PluginDatabase, input: {
  now: string;
  limit?: number | undefined;
}): string[] {
  const now = timestampSchema.parse(input.now);
  return db.all<{ id: string }>(
    `SELECT id FROM poll_deliveries
      WHERE (
        (status = 'pending' AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday(?)))
        OR (status = 'sending' AND julianday(lease_expires_at) <= julianday(?))
        OR status = 'uncertain'
      )
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
    now,
    now,
    normalizedLimit(input.limit)
  ).map((row) => row.id);
}

export function reconcileUncertainPollDelivery(db: PluginDatabase, input: {
  deliveryId: string;
  resolution: 'sent' | 'retry';
  reconciledAt: string;
  messageId?: string | undefined;
  nextAttemptAt?: string | undefined;
  note?: string | undefined;
}): boolean {
  const reconciledAt = timestampSchema.parse(input.reconciledAt);
  const deliveryId = required(input.deliveryId, 'deliveryId');
  if (input.resolution === 'sent') {
    const result = db.run(
      `UPDATE poll_deliveries
          SET status = 'sent', message_id = ?, sent_at = ?, next_attempt_at = NULL,
              updated_at = ?, last_error = ?
        WHERE id = ? AND status = 'uncertain'`,
      required(input.messageId ?? '', 'messageId'),
      reconciledAt,
      reconciledAt,
      input.note?.trim() || null,
      deliveryId
    );
    return result.changes === 1;
  }
  const nextAttemptAt = timestampSchema.parse(input.nextAttemptAt ?? reconciledAt);
  const result = db.run(
    `UPDATE poll_deliveries
        SET status = 'pending', next_attempt_at = ?, updated_at = ?, last_error = ?
      WHERE id = ? AND status = 'uncertain'`,
    nextAttemptAt,
    reconciledAt,
    input.note?.trim() || null,
    deliveryId
  );
  return result.changes === 1;
}

export function markPollDeliverySent(db: PluginDatabase, input: {
  deliveryId: string;
  claimToken: string;
  messageId: string;
  sentAt: string;
}): boolean {
  const sentAt = timestampSchema.parse(input.sentAt);
  const result = db.run(
    `UPDATE poll_deliveries
        SET status = 'sent', message_id = ?, sent_at = ?, claim_token = NULL,
            lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?, last_error = NULL
      WHERE id = ? AND status = 'sending' AND claim_token = ?`,
    required(input.messageId, 'messageId'),
    sentAt,
    sentAt,
    required(input.deliveryId, 'deliveryId'),
    required(input.claimToken, 'claimToken')
  );
  return result.changes === 1;
}

export function markPollDeliveryUncertain(db: PluginDatabase, input: {
  deliveryId: string;
  claimToken: string;
  error: string;
  updatedAt: string;
}): boolean {
  const updatedAt = timestampSchema.parse(input.updatedAt);
  const result = db.run(
    `UPDATE poll_deliveries
        SET status = 'uncertain', claim_token = NULL, lease_expires_at = NULL,
            updated_at = ?, last_error = ?
      WHERE id = ? AND status = 'sending' AND claim_token = ?`,
    updatedAt,
    required(input.error, 'error'),
    required(input.deliveryId, 'deliveryId'),
    required(input.claimToken, 'claimToken')
  );
  return result.changes === 1;
}

export function reschedulePollDelivery(db: PluginDatabase, input: {
  deliveryId: string;
  claimToken: string;
  nextAttemptAt: string;
  error: string;
  updatedAt: string;
}): boolean {
  const nextAttemptAt = timestampSchema.parse(input.nextAttemptAt);
  const updatedAt = timestampSchema.parse(input.updatedAt);
  const result = db.run(
    `UPDATE poll_deliveries
        SET status = 'pending', claim_token = NULL, lease_expires_at = NULL,
            next_attempt_at = ?, updated_at = ?, last_error = ?
      WHERE id = ? AND status = 'sending' AND claim_token = ?`,
    nextAttemptAt,
    updatedAt,
    required(input.error, 'error'),
    required(input.deliveryId, 'deliveryId'),
    required(input.claimToken, 'claimToken')
  );
  return result.changes === 1;
}

export function getPollDelivery(db: PluginDatabase, deliveryId: string): StoredPollDelivery | undefined {
  const row = db.get<DeliveryRow>('SELECT * FROM poll_deliveries WHERE id = ?', deliveryId);
  return row ? deliveryFromRow(row) : undefined;
}

export function resolvePollTie(db: PluginDatabase, input: {
  roundId: string;
  selectedOptionIds: readonly string[];
  resolverIdentityId: string;
  resolverWid: string;
  reason?: string | undefined;
  delivery: PollDeliveryIntent;
  resolvedAt: string;
}): void {
  const resolvedAt = timestampSchema.parse(input.resolvedAt);
  const roundId = required(input.roundId, 'roundId');
  requireDistinct(input.selectedOptionIds, 'Selected tie-break option ids');
  validateDeliveryIntent(input.delivery);
  if (input.delivery.kind !== 'result') {
    throw new Error('A tie resolution requires a result delivery.');
  }
  db.transaction(() => {
    const result = getPollResult(db, roundId);
    if (!result || result.purpose !== 'decide' || result.outcome.status !== 'tie') {
      throw new Error(`Poll round ${roundId} does not have an unresolved tie result.`);
    }
    const round = db.get<PollRoundRow>('SELECT * FROM poll_rounds WHERE id = ?', roundId);
    if (!round || round.status !== 'tie_pending') {
      throw new Error(`Poll round ${roundId} is not awaiting a tie resolution.`);
    }
    requireTieResultDeliverySent(db, round);
    if (input.selectedOptionIds.length !== result.outcome.remainingSeats) {
      throw new Error(`Tie resolution requires exactly ${result.outcome.remainingSeats} option(s).`);
    }
    const tiedOptions = new Set(result.outcome.tiedOptionIds);
    if (input.selectedOptionIds.some((optionId) => !tiedOptions.has(optionId))) {
      throw new Error('Tie resolution can select only tied options.');
    }
    db.run(
      `INSERT INTO poll_resolutions (
         round_id, poll_id, kind, selected_option_ids_json,
         resolver_identity_id, resolver_wid, reason, created_at
       ) VALUES (?, ?, 'manual_tie_break', ?, ?, ?, ?, ?)`,
      roundId,
      round.poll_id,
      JSON.stringify(input.selectedOptionIds),
      required(input.resolverIdentityId, 'resolverIdentityId'),
      required(input.resolverWid, 'resolverWid'),
      input.reason?.trim() || null,
      resolvedAt
    );
    db.run(
      `UPDATE poll_rounds SET status = 'finalized', updated_at = ?
        WHERE id = ? AND status = 'tie_pending'`,
      resolvedAt,
      roundId
    );
    db.run(
      `UPDATE polls SET status = 'resolved', resolved_at = ?, updated_at = ?
        WHERE id = ? AND status = 'tie_pending'`,
      resolvedAt,
      resolvedAt,
      round.poll_id
    );
    insertDelivery(db, round.poll_id, roundId, input.delivery, resolvedAt);
  });
}

function requireTieResultDeliverySent(db: PluginDatabase, round: PollRoundRow): void {
  if (round.status !== 'tie_pending') {
    return;
  }
  const tieDelivery = db.get<{ status: PollDeliveryStatus }>(
    `SELECT status FROM poll_deliveries
      WHERE id = ? AND round_id = ? AND kind = 'tie'`,
    `poll-result:${round.id}`,
    round.id
  );
  if (tieDelivery?.status !== 'sent') {
    throw new PollTieResultDeliveryPendingError(
      `Poll round ${round.id} cannot transition before its tie result is delivered.`
    );
  }
}

function insertDelivery(
  db: PluginDatabase,
  pollId: string,
  roundId: string,
  delivery: PollDeliveryIntent,
  createdAt: string
): void {
  db.run(
    `INSERT INTO poll_deliveries (
       id, poll_id, round_id, kind, delivery_key, chat_id, text,
       idempotency_key, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    delivery.id,
    pollId,
    roundId,
    delivery.kind,
    delivery.deliveryKey,
    delivery.chatId,
    delivery.text,
    delivery.idempotencyKey,
    createdAt,
    createdAt
  );
}

function validateDeliveryIntent(delivery: PollDeliveryIntent): void {
  required(delivery.id, 'delivery.id');
  required(delivery.deliveryKey, 'delivery.deliveryKey');
  required(delivery.chatId, 'delivery.chatId');
  required(delivery.text, 'delivery.text');
  required(delivery.idempotencyKey, 'delivery.idempotencyKey');
  if (!['result', 'tie', 'cancelled', 'failure'].includes(delivery.kind)) {
    throw new Error(`Invalid poll delivery kind ${delivery.kind}.`);
  }
}

function pollFromRow(row: PollRow): StoredPoll {
  const definition = pollDefinitionSchema.parse(parseJson(row.definition_json, 'poll definition'));
  if (definition.id !== row.id || definition.purpose !== row.purpose) {
    throw new Error(`Stored poll ${row.id} does not match its canonical definition.`);
  }
  return {
    id: row.id,
    scopeId: row.scope_id,
    chatId: row.chat_id,
    ...(row.group_id ? { groupId: row.group_id } : {}),
    creatorIdentityId: row.creator_identity_id,
    creatorWid: row.creator_wid,
    creatorLabel: row.creator_label,
    purpose: row.purpose,
    definition,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
    ...(row.cancelled_by_identity_id
      ? { cancelledByIdentityId: row.cancelled_by_identity_id }
      : {}),
    ...(row.cancelled_by_wid ? { cancelledByWid: row.cancelled_by_wid } : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    ...(row.ballots_purged_at ? { ballotsPurgedAt: row.ballots_purged_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {})
  };
}

function roundFromRow(row: PollRoundRow): StoredPollRound {
  return {
    id: row.id,
    pollId: row.poll_id,
    roundNumber: row.round_number,
    status: row.status,
    question: row.question,
    allowMultipleAnswers: row.allow_multiple_answers === 1,
    publishIdempotencyKey: row.publish_idempotency_key,
    ...(row.poll_wa_message_id ? { pollWaMessageId: row.poll_wa_message_id } : {}),
    ...(row.closes_at ? { closesAt: row.closes_at } : {}),
    ...(row.published_at ? { publishedAt: row.published_at } : {}),
    publicationAttempt: row.publication_attempt,
    ...(row.publication_claim_token ? { publicationClaimToken: row.publication_claim_token } : {}),
    ...(row.publication_lease_expires_at
      ? { publicationLeaseExpiresAt: row.publication_lease_expires_at }
      : {}),
    ...(row.publication_next_attempt_at
      ? { publicationNextAttemptAt: row.publication_next_attempt_at }
      : {}),
    ...(row.electorate_captured_at ? { electorateCapturedAt: row.electorate_captured_at } : {}),
    ...(row.publication_started_at ? { publicationStartedAt: row.publication_started_at } : {}),
    publicationOutcome: row.publication_outcome,
    finalizationAttempt: row.finalization_attempt,
    ...(row.finalization_claim_token ? { finalizationClaimToken: row.finalization_claim_token } : {}),
    ...(row.finalization_lease_expires_at
      ? { finalizationLeaseExpiresAt: row.finalization_lease_expires_at }
      : {}),
    ...(row.finalization_next_attempt_at
      ? { finalizationNextAttemptAt: row.finalization_next_attempt_at }
      : {}),
    ...(row.finalized_at ? { finalizedAt: row.finalized_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_error ? { lastError: row.last_error } : {})
  };
}

function electorFromRow(row: ElectorRow): PollElector {
  return pollElectorSchema.parse({
    voterIdentityId: row.voter_identity_id,
    voterWid: row.voter_wid,
    ...(row.display_label ? { displayLabel: row.display_label } : {})
  });
}

function deliveryFromRow(row: DeliveryRow): StoredPollDelivery {
  return {
    id: row.id,
    pollId: row.poll_id,
    roundId: row.round_id,
    kind: row.kind,
    deliveryKey: row.delivery_key,
    chatId: row.chat_id,
    text: row.text,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempt: row.attempt,
    ...(row.claim_token ? { claimToken: row.claim_token } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.sent_at ? { sentAt: row.sent_at } : {})
  };
}

function isVoteNewer(
  ballot: PollBallot,
  existing: { interacted_at: string; source_id: string }
): boolean {
  if (ballot.source.kind !== 'transport_event') {
    return false;
  }
  const timestampDifference = Date.parse(ballot.interactedAt) - Date.parse(existing.interacted_at);
  return timestampDifference > 0
    || (timestampDifference === 0 && ballot.source.waMessageId > existing.source_id);
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required.`);
  }
  return normalized;
}

function normalizedLimit(value: number | undefined): number {
  const resolved = value ?? 100;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 1_000) {
    throw new Error('limit must be an integer from 1 to 1000.');
  }
  return resolved;
}

function matchesCreateInput(existing: StoredPollAggregate, input: {
  definition: PollDefinition;
  scopeId: string;
  chatId: string;
  groupId?: string | undefined;
  creatorIdentityId: string;
  creatorWid: string;
  creatorLabel: string;
  roundId: string;
  publishIdempotencyKey: string;
  createdAt: string;
}): boolean {
  const firstRound = existing.rounds.find((round) => round.roundNumber === 1);
  if (!firstRound) {
    return false;
  }
  return existing.poll.scopeId === input.scopeId
    && existing.poll.chatId === input.chatId
    && existing.poll.groupId === input.groupId
    && existing.poll.creatorIdentityId === input.creatorIdentityId
    && existing.poll.creatorWid === input.creatorWid
    && existing.poll.creatorLabel === input.creatorLabel
    && existing.poll.createdAt === input.createdAt
    && JSON.stringify(existing.poll.definition) === JSON.stringify(input.definition)
    && firstRound.id === input.roundId
    && firstRound.publishIdempotencyKey === input.publishIdempotencyKey
    && firstRound.createdAt === input.createdAt;
}

function requireDistinct(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must be unique.`);
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Stored ${label} is not valid JSON.`);
  }
}
