import type { PluginRuntimeContext } from './runtime';
import { describePollRandomDraw } from './resultCalculator';
import {
  getPollLifecycleByRoundId,
  getPollRandomDrawAudit,
  getPollResult,
  markPollRandomDrawAuditSent,
  pollsDatabase
} from './store';

/**
 * Delivers the durable random-draw audit intent created in the same transaction
 * as the immutable poll result. The event key makes the unavoidable
 * audit-success/process-crash retry window correlatable by audit consumers.
 */
export async function deliverPollRandomDrawAudit(
  context: PluginRuntimeContext,
  roundId: string,
  clock: () => Date = () => new Date()
): Promise<boolean> {
  const db = pollsDatabase(context.databases);
  const intent = getPollRandomDrawAudit(db, roundId);
  if (!intent || intent.sentAt) {
    return false;
  }
  const snapshot = getPollLifecycleByRoundId(db, roundId);
  const result = getPollResult(db, roundId);
  if (!snapshot || !result || snapshot.poll.id !== result.pollId) {
    throw new Error(`Random-draw audit ${intent.eventKey} has no immutable owning result.`);
  }
  const trace = describePollRandomDraw(snapshot.poll.definition, result);
  if (!trace) {
    throw new Error(`Random-draw audit ${intent.eventKey} cannot reconstruct its draw trace.`);
  }
  const expectedEventKey = `poll-assistant:random-draw:${roundId}:${trace.drawDigest}`;
  if (intent.eventKey !== expectedEventKey) {
    throw new Error(`Random-draw audit ${intent.eventKey} does not match its immutable result.`);
  }
  await context.audit.record({
    scopeId: snapshot.poll.scopeId,
    ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
    action: 'poll-assistant.tie.random-draw',
    targetJson: {
      pollId: snapshot.poll.id,
      roundId
    },
    metadataJson: {
      eventKey: intent.eventKey,
      organizerIdentityId: snapshot.poll.creatorIdentityId,
      algorithm: trace.algorithm,
      tiedOptionIds: trace.tiedOptionIds,
      selectedOptionIds: trace.selectedOptionIds,
      remainingSeats: trace.remainingSeats,
      drawDigest: trace.drawDigest,
      drawBasis: {
        pollId: snapshot.poll.id,
        roundId,
        cutoffAt: result.cutoffAt
      }
    }
  });
  return markPollRandomDrawAuditSent(db, {
    roundId,
    eventKey: intent.eventKey,
    sentAt: clock().toISOString()
  });
}
