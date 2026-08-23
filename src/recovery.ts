import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { cleanupPollBallots } from './delivery';
import type { PollElector } from './domain';
import { parsePollAssistantConfig } from './config';
import { deliverPollRandomDrawAudit } from './randomDrawAudit';
import { deliverPollPrivatePublicationAudit } from './privatePublicationAudit';
import {
  enqueuePollDeliveryJob,
  enqueuePollFinalizeJob,
  enqueuePollPrivateIssueJob,
  enqueuePollPublishJob,
  POLL_PRIVATE_ISSUANCE_PACING_MS
} from './jobs';
import {
  getPollAggregate,
  getPollDelivery,
  getPollLifecycleByRoundId,
  getPollPrivateIssuance,
  claimDuePollRollingMembershipReviews,
  deferPollRollingMembershipReview,
  listPollCleanupCandidateIds,
  listPendingPollRandomDrawAudits,
  listPendingPollPrivatePublicationAuditIds,
  listRecoverablePollPrivateIssuanceIds,
  listRecoverablePollDeliveryIds,
  listRecoverablePollRounds,
  markPollCleanupReview,
  pollsDatabase,
  reconcilePollElectorateFromPreCutoffSnapshot,
  reconcileUncertainPollDelivery
} from './store';

export const POLL_ASSISTANT_RECOVERY_SWEEP_MS = 30_000;
const POLL_CLEANUP_FAILURE_REVIEW_MS = 5 * 60_000;
const POLL_ROLLING_MEMBERSHIP_REVIEW_MS = 5 * 60_000;
const POLL_ROLLING_MEMBERSHIP_RETRY_MS = 30_000;
const POLL_ROLLING_MEMBERSHIP_REVIEW_LIMIT = 5;

export async function recoverPollAssistantJobs(
  context: PluginRuntimeContext,
  now: Date = new Date()
): Promise<number> {
  const db = pollsDatabase(context.databases);
  let enqueued = 0;
  for (const recoverable of listRecoverablePollRounds(db, {
    now: now.toISOString(),
    limit: 100
  })) {
    const snapshot = getPollLifecycleByRoundId(db, recoverable.round.id);
    if (!snapshot) {
      continue;
    }
    if (recoverable.kind === 'publication') {
      await enqueuePollPublishJob(context, {
        scopeId: snapshot.poll.scopeId,
        pollId: snapshot.poll.id,
        roundId: snapshot.round.id,
        ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
        groupWid: snapshot.poll.chatId,
        attempt: snapshot.round.publicationAttempt + 1,
        runAt: now
      });
    } else {
      await enqueuePollFinalizeJob(context, {
        scopeId: snapshot.poll.scopeId,
        pollId: snapshot.poll.id,
        roundId: snapshot.round.id,
        ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
        groupWid: snapshot.poll.chatId,
        attempt: snapshot.round.finalizationAttempt + 1,
        runAt: now
      });
    }
    enqueued += 1;
  }

  for (const deliveryId of listRecoverablePollDeliveryIds(db, {
    now: now.toISOString(),
    limit: 100
  })) {
    let delivery = getPollDelivery(db, deliveryId);
    if (!delivery) {
      continue;
    }
    if (delivery.status === 'uncertain') {
      const reconciled = reconcileUncertainPollDelivery(db, {
        deliveryId,
        resolution: 'retry',
        reconciledAt: now.toISOString(),
        nextAttemptAt: now.toISOString(),
        note: 'Automatic retry uses the persisted transport idempotency key.'
      });
      if (!reconciled) {
        continue;
      }
      delivery = getPollDelivery(db, deliveryId)!;
    }
    const aggregate = getPollAggregate(db, delivery.pollId);
    if (!aggregate) {
      continue;
    }
    await enqueuePollDeliveryJob(context, {
      scopeId: aggregate.poll.scopeId,
      deliveryId,
      ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
      groupWid: aggregate.poll.chatId,
      attempt: delivery.attempt + 1,
      runAt: now
    });
    enqueued += 1;
  }

  for (const claim of claimDuePollRollingMembershipReviews(db, {
    now: now.toISOString(),
    claimedUntil: new Date(now.getTime() + POLL_ROLLING_MEMBERSHIP_REVIEW_MS).toISOString(),
    limit: POLL_ROLLING_MEMBERSHIP_REVIEW_LIMIT
  })) {
    try {
      if (await reconcileRollingPollMembership(context, claim.pollId, claim.roundId)) {
        enqueued += 1;
      }
    } catch (error) {
      const nextReviewAt = new Date(
        now.getTime() + POLL_ROLLING_MEMBERSHIP_RETRY_MS
      ).toISOString();
      const deferred = deferPollRollingMembershipReview(db, {
        pollId: claim.pollId,
        claimedUntil: claim.claimedUntil,
        nextReviewAt
      });
      context.logger.warn(
        { error, pollId: claim.pollId, roundId: claim.roundId, nextReviewAt, deferred },
        'official.poll-assistant rolling electorate recovery deferred'
      );
    }
  }

  let privateIssuanceSlot = 0;
  for (const issuanceId of listRecoverablePollPrivateIssuanceIds(db, {
    now: now.toISOString(),
    limit: 100
  })) {
    const issuance = getPollPrivateIssuance(db, issuanceId);
    if (!issuance) {
      continue;
    }
    const snapshot = getPollLifecycleByRoundId(db, issuance.roundId);
    if (!snapshot) {
      continue;
    }
    await enqueuePollPrivateIssueJob(context, {
      scopeId: snapshot.poll.scopeId,
      issuanceId,
      ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
      groupWid: snapshot.poll.chatId,
      attempt: issuance.attempt + 1,
      runAt: new Date(now.getTime() + privateIssuanceSlot * POLL_PRIVATE_ISSUANCE_PACING_MS)
    });
    privateIssuanceSlot += 1;
    enqueued += 1;
  }

  for (const intent of listPendingPollRandomDrawAudits(db, 100)) {
    try {
      if (await deliverPollRandomDrawAudit(context, intent.roundId, () => now)) {
        enqueued += 1;
      }
    } catch (error) {
      context.logger.warn(
        { error, roundId: intent.roundId, eventKey: intent.eventKey },
        'official.poll-assistant random-draw audit recovery deferred'
      );
    }
  }

  for (const issuanceId of listPendingPollPrivatePublicationAuditIds(db, 100)) {
    try {
      if (await deliverPollPrivatePublicationAudit(context, issuanceId, () => now)) {
        enqueued += 1;
      }
    } catch (error) {
      context.logger.warn(
        { error, issuanceId },
        'official.poll-assistant private publication audit recovery deferred'
      );
    }
  }

  for (const pollId of listPollCleanupCandidateIds(db, {
    terminalBefore: now.toISOString(),
    limit: 100
  })) {
    try {
      await cleanupPollBallots(context, pollId, () => now);
      enqueued += 1;
    } catch (error) {
      const nextReviewAt = new Date(
        now.getTime() + POLL_CLEANUP_FAILURE_REVIEW_MS
      ).toISOString();
      let reviewDeferred = false;
      try {
        reviewDeferred = markPollCleanupReview(db, { pollId, nextReviewAt });
      } catch (reviewError) {
        context.logger.error(
          { error: reviewError, pollId, nextReviewAt },
          'official.poll-assistant failed to defer a cleanup candidate after an error'
        );
      }
      context.logger.error(
        { error, pollId, nextReviewAt, reviewDeferred },
        'official.poll-assistant poll cleanup candidate failed'
      );
      try {
        await context.audit.record({
          action: 'poll-assistant.cleanup.failed',
          targetJson: { pollId },
          metadataJson: {
            error: error instanceof Error ? error.message : String(error),
            nextReviewAt,
            reviewDeferred
          }
        });
      } catch (auditError) {
        context.logger.warn(
          { error: auditError, pollId },
          'official.poll-assistant could not audit a cleanup candidate failure'
        );
      }
    }
  }
  return enqueued;
}

async function reconcileRollingPollMembership(
  context: PluginRuntimeContext,
  pollId: string,
  roundId: string
): Promise<boolean> {
  const db = pollsDatabase(context.databases);
  const snapshot = getPollLifecycleByRoundId(db, roundId);
  if (
    !snapshot
    || snapshot.poll.id !== pollId
    || snapshot.poll.status !== 'active'
    || snapshot.round.status !== 'open'
    || snapshot.poll.definition.ballotDelivery !== 'private'
    || snapshot.poll.definition.electorate.kind !== 'group_members_until_cutoff'
  ) {
    return false;
  }
  if (!context.getAuthoritativeGroupParticipantSnapshot || !context.resolveIdentityAddress) {
    throw new Error('Authoritative group membership and identity recovery is unavailable.');
  }
  const participantSnapshot = await context.getAuthoritativeGroupParticipantSnapshot(
    snapshot.poll.chatId
  );
  if (
    participantSnapshot.providerId !== 'whatsmeow'
    || Number.isNaN(participantSnapshot.observedAt.getTime())
    || !participantSnapshot.botWid.trim()
  ) {
    throw new Error('Authoritative rolling electorate snapshot has invalid provider evidence.');
  }
  if (
    snapshot.round.closesAt
    && participantSnapshot.observedAt.getTime() >= Date.parse(snapshot.round.closesAt)
  ) {
    return false;
  }

  const botIdentity = await context.resolveIdentityAddress(participantSnapshot.botWid);
  if (!botIdentity.identityId.trim()) {
    throw new Error('Rolling electorate bot identity resolution was incomplete.');
  }
  const byIdentityId = new Map<string, PollElector>();
  const participants = [...participantSnapshot.participants]
    .map((participant) => ({ ...participant, wid: participant.wid.trim() }))
    .sort((left, right) => left.wid.localeCompare(right.wid));
  if (participants.some((participant) => !participant.wid)) {
    throw new Error('Rolling electorate snapshot returned an empty participant identity.');
  }
  // Resolve sequentially: a recovery sweep should not burst identity lookups on
  // large groups or compete with the live WhatsApp event loop.
  for (const participant of participants) {
    const resolution = await context.resolveIdentityAddress(participant.wid);
    const identityId = resolution.identityId.trim();
    const voterWid = resolution.deliveryChatId.trim();
    if (!identityId || !voterWid) {
      throw new Error('Rolling electorate participant identity resolution was incomplete.');
    }
    if (identityId === botIdentity.identityId) {
      continue;
    }
    const displayLabel = participant.displayName?.trim() || resolution.displayName?.trim();
    const candidate: PollElector = {
      voterIdentityId: identityId,
      voterWid,
      ...(displayLabel ? { displayLabel } : {})
    };
    const existing = byIdentityId.get(identityId);
    if (!existing || rollingElectorSortKey(candidate) < rollingElectorSortKey(existing)) {
      byIdentityId.set(identityId, candidate);
    }
  }
  const electorate = [...byIdentityId.values()]
    .sort((left, right) => left.voterIdentityId.localeCompare(right.voterIdentityId));
  const config = parsePollAssistantConfig(await context.configFor(snapshot.poll.scopeId));
  const currentIdentityIds = new Set(
    getPollAggregate(db, pollId)?.electorate.map((elector) => elector.voterIdentityId) ?? []
  );
  const cappedElectorate = electorate.length <= config.maxPrivateElectorateSize
    ? electorate
    : [...electorate]
      .sort((left, right) => {
        const leftCurrent = currentIdentityIds.has(left.voterIdentityId) ? 0 : 1;
        const rightCurrent = currentIdentityIds.has(right.voterIdentityId) ? 0 : 1;
        return leftCurrent - rightCurrent
          || left.voterIdentityId.localeCompare(right.voterIdentityId);
      })
      .slice(0, config.maxPrivateElectorateSize)
      .sort((left, right) => left.voterIdentityId.localeCompare(right.voterIdentityId));
  return reconcilePollElectorateFromPreCutoffSnapshot(db, {
    pollId,
    roundId,
    electorate: cappedElectorate,
    observedAt: participantSnapshot.observedAt.toISOString(),
    maxElectorateSize: config.maxPrivateElectorateSize
  });
}

function rollingElectorSortKey(elector: PollElector): string {
  return `${elector.voterWid}\u0000${elector.displayLabel ?? ''}`;
}

export function startPollAssistantRecovery(context: PluginRuntimeContext): () => Promise<void> {
  let stopped = false;
  let activeSweep: Promise<void> | undefined;
  const sweep = async (): Promise<void> => {
    if (stopped || activeSweep) {
      return;
    }
    activeSweep = recoverPollAssistantJobs(context)
      .then(() => undefined)
      .catch((error) => {
        context.logger.error({ error }, 'official.poll-assistant recovery sweep failed');
      })
      .finally(() => {
        activeSweep = undefined;
      });
    await activeSweep;
  };
  void sweep();
  const timer = setInterval(() => void sweep(), POLL_ASSISTANT_RECOVERY_SWEEP_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await activeSweep;
  };
}
