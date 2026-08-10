import { createHash, randomUUID } from 'node:crypto';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { equivalentWhatsAppMessageIds } from '../../../platform/transport/messageIds';
import { mapAuthoritativePollReadback } from './authoritativeReadback';
import type { PollBallotMappingTarget } from './ballotMapping';
import { enqueuePollDeliveryJob, enqueuePollFinalizeJob, pollRetryAt } from './jobs';
import { calculatePollResult } from './resultCalculator';
import { renderPollResult } from './resultRendering';
import {
  POLL_FINALIZATION_LEASE_MS,
  claimPollRoundFinalization,
  completePollRoundFinalization,
  createPollResultInputSha256,
  getPollAggregate,
  getPollLifecycleByRoundId,
  pollsDatabase,
  replacePollBallotsFromAuthoritativeReadback,
  reschedulePollRoundFinalization,
  type PollFinalizationClaim,
  type StoredPollRoundSnapshot
} from './store';

export async function finalizePollRound(
  context: PluginRuntimeContext,
  pollId: string,
  roundId: string,
  clock: () => Date = () => new Date()
): Promise<void> {
  const db = pollsDatabase(context.databases);
  const beforeClaim = getPollLifecycleByRoundId(db, roundId);
  if (!beforeClaim || beforeClaim.poll.id !== pollId) {
    context.logger.warn({ pollId, roundId }, 'Ignoring poll finalization job with mismatched lifecycle ids');
    return;
  }
  const claimedAt = clock();
  const claim = claimPollRoundFinalization(db, {
    roundId,
    claimToken: randomUUID(),
    now: claimedAt.toISOString(),
    leaseExpiresAt: new Date(claimedAt.getTime() + POLL_FINALIZATION_LEASE_MS).toISOString()
  });
  if (!claim) {
    await reconcileFinalizationSuccessor(context, pollId, roundId);
    return;
  }

  try {
    const snapshot = requireFinalizationSnapshot(db, claim);
    const cutoffAt = requireCutoff(snapshot);
    if (!context.pollVoteReadbackFor || !context.resolveIdentityAddress) {
      throw new Error('Authoritative historical poll vote readback is unavailable.');
    }
    const readback = await context.pollVoteReadbackFor(snapshot.round.pollWaMessageId!, {
      asOf: cutoffAt
    });
    if (!equivalentWhatsAppMessageIds(readback.pollWaMsgId, snapshot.round.pollWaMessageId)) {
      throw new Error('Authoritative poll readback returned a different poll id.');
    }
    const aggregate = getPollAggregate(db, claim.poll.id);
    if (!aggregate || !snapshot.round.electorateCapturedAt) {
      throw new Error('Poll finalization requires a captured electorate.');
    }
    const readbackBallots = await mapAuthoritativePollReadback({
      readback,
      target: mappingTarget(snapshot),
      cutoffAt,
      eligibleIdentityIds: new Set(aggregate.electorate.map((elector) => elector.voterIdentityId)),
      resolveIdentityAddress: context.resolveIdentityAddress
    });
    const readAt = clock();
    const readbackId = authoritativeReadbackId(roundId, cutoffAt);
    const ballots = replacePollBallotsFromAuthoritativeReadback(db, {
      roundId,
      claimToken: claim.claimToken,
      readbackId,
      ballots: readbackBallots,
      readAt: readAt.toISOString()
    });
    const electorateIdentityIds = aggregate.electorate.map((elector) => elector.voterIdentityId);
    const result = calculatePollResult({
      definition: claim.poll.definition,
      roundId,
      electorateIdentityIds,
      ballots,
      cutoffAt: cutoffAt.toISOString(),
      computedAt: readAt.toISOString()
    });
    const inputSha256 = createPollResultInputSha256({
      definition: claim.poll.definition,
      electorateIdentityIds,
      ballots,
      cutoffAt: cutoffAt.toISOString()
    });
    const t = await context.i18n.translatorForScope(claim.poll.scopeId);
    const deliveryId = `poll-result:${roundId}`;
    const completed = completePollRoundFinalization(db, {
      roundId,
      claimToken: claim.claimToken,
      result,
      inputSha256,
      readbackSource: 'transport_readback',
      delivery: {
        id: deliveryId,
        kind: result.purpose === 'decide' && result.outcome.status === 'tie' ? 'tie' : 'result',
        deliveryKey: `result:${roundId}:v1`,
        chatId: claim.poll.chatId,
        text: renderPollResult({ definition: claim.poll.definition, result, t }),
        idempotencyKey: `poll-assistant:result:${claim.poll.id}:${roundId}:v1`
      },
      completedAt: readAt.toISOString()
    });
    if (completed === 'completed' || completed === 'already_completed') {
      await enqueuePollDeliveryJob(context, {
        scopeId: claim.poll.scopeId,
        deliveryId,
        ...(claim.poll.groupId ? { groupId: claim.poll.groupId } : {}),
        groupWid: claim.poll.chatId,
        attempt: 0
      });
    }
  } catch (error) {
    await rescheduleFinalization(context, claim, error, clock());
  }
}

function requireFinalizationSnapshot(
  db: ReturnType<typeof pollsDatabase>,
  claim: PollFinalizationClaim
): StoredPollRoundSnapshot {
  const snapshot = getPollLifecycleByRoundId(db, claim.round.id);
  if (
    !snapshot
    || snapshot.poll.id !== claim.poll.id
    || snapshot.round.status !== 'finalizing'
    || snapshot.round.finalizationClaimToken !== claim.claimToken
    || !snapshot.round.pollWaMessageId
  ) {
    throw new Error(`Poll round ${claim.round.id} has no claimed finalization snapshot.`);
  }
  return snapshot;
}

function requireCutoff(snapshot: StoredPollRoundSnapshot): Date {
  const cutoffAt = snapshot.round.closesAt ? new Date(snapshot.round.closesAt) : undefined;
  if (!cutoffAt || Number.isNaN(cutoffAt.getTime())) {
    throw new Error(`Poll round ${snapshot.round.id} has no valid closing cutoff.`);
  }
  return cutoffAt;
}

function mappingTarget(snapshot: StoredPollRoundSnapshot): PollBallotMappingTarget {
  return {
    roundId: snapshot.round.id,
    pollWaMessageId: snapshot.round.pollWaMessageId!,
    allowMultipleAnswers: snapshot.round.allowMultipleAnswers,
    options: snapshot.options.map((option) => ({
      optionId: option.optionId,
      ordinal: option.ordinal,
      wireLabel: option.wireLabel
    }))
  };
}

function authoritativeReadbackId(roundId: string, cutoffAt: Date): string {
  const digest = createHash('sha256')
    .update(roundId)
    .update('\u0000')
    .update(cutoffAt.toISOString())
    .digest('hex');
  return `readback:${digest}`;
}

async function rescheduleFinalization(
  context: PluginRuntimeContext,
  claim: PollFinalizationClaim,
  error: unknown,
  failedAt: Date
): Promise<void> {
  const nextAttemptAt = pollRetryAt(failedAt, claim.round.finalizationAttempt);
  const persisted = reschedulePollRoundFinalization(pollsDatabase(context.databases), {
    roundId: claim.round.id,
    claimToken: claim.claimToken,
    nextAttemptAt: nextAttemptAt.toISOString(),
    error: error instanceof Error ? error.message : String(error),
    updatedAt: failedAt.toISOString()
  });
  if (persisted) {
    await enqueuePollFinalizeJob(context, {
      scopeId: claim.poll.scopeId,
      pollId: claim.poll.id,
      roundId: claim.round.id,
      ...(claim.poll.groupId ? { groupId: claim.poll.groupId } : {}),
      groupWid: claim.poll.chatId,
      attempt: claim.round.finalizationAttempt,
      runAt: nextAttemptAt
    });
    return;
  }
  await reconcileFinalizationSuccessor(context, claim.poll.id, claim.round.id);
}

async function reconcileFinalizationSuccessor(
  context: PluginRuntimeContext,
  pollId: string,
  roundId: string
): Promise<void> {
  const snapshot = getPollLifecycleByRoundId(pollsDatabase(context.databases), roundId);
  if (!snapshot || snapshot.poll.id !== pollId) {
    return;
  }
  if (snapshot.round.status === 'finalized' || snapshot.round.status === 'tie_pending') {
    await enqueuePollDeliveryJob(context, {
      scopeId: snapshot.poll.scopeId,
      deliveryId: `poll-result:${roundId}`,
      ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
      groupWid: snapshot.poll.chatId,
      attempt: 0
    });
  }
}
