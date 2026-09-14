import { randomUUID } from 'node:crypto';
import type { PluginRuntimeContext } from './runtime';
import {
  isDefinitelyNotSentTransportError,
  isTransportProviderUnavailableError
} from '@wabs/plugin-sdk/transport-errors';
import { parsePollAssistantConfig } from './config';
import {
  DOAS_PRIVATE_POLL_RELEASE_METHOD,
  DOAS_PRIVATE_POLL_SERVICE_ID,
  doasPrivatePollReleaseInputSchema,
  type DoasPrivatePollReleaseOutput
} from './contracts/doas-poll-v1';
import { enqueuePollCleanupJob, enqueuePollDeliveryJob, pollRetryAt } from './jobs';
import {
  POLL_DELIVERY_LEASE_MS,
  claimPollDeliveryById,
  getPollAggregate,
  getPollDelivery,
  getNextPendingPollDeliveryInBatch,
  getPollRetentionAnchor,
  listPollPrivateIssuancesByRound,
  markPollCleanupReview,
  markPollDeliverySent,
  markPollDeliveryUncertain,
  pollsDatabase,
  purgePollBallotData,
  reschedulePollDelivery,
  type PollDeliveryClaim,
  type StoredPoll
} from './store';

const POLL_CLEANUP_REVIEW_INTERVAL_MS = 5 * 60_000;

class PollDeliveryNotAttemptedError extends Error {
  override readonly name = 'PollDeliveryNotAttemptedError';
}

export async function deliverPollMessage(
  context: PluginRuntimeContext,
  deliveryId: string,
  clock: () => Date = () => new Date()
): Promise<void> {
  const db = pollsDatabase(context.databases);
  const claimedAt = clock();
  const claim = claimPollDeliveryById(db, {
    deliveryId,
    claimToken: randomUUID(),
    now: claimedAt.toISOString(),
    leaseExpiresAt: new Date(claimedAt.getTime() + POLL_DELIVERY_LEASE_MS).toISOString()
  });
  if (!claim) {
    const existing = getPollDelivery(db, deliveryId);
    if (existing?.status === 'sent' && existing.sentAt) {
      await scheduleNextPollResultPage(context, existing, new Date(existing.sentAt));
      await schedulePollCleanup(context, existing.pollId);
    }
    return;
  }

  try {
    if (!context.sendText) {
      throw new PollDeliveryNotAttemptedError('Poll result delivery transport is unavailable.');
    }
    const sent = await context.sendText(claim.delivery.chatId, claim.delivery.text, {
      idempotencyKey: claim.delivery.idempotencyKey,
      ...(claim.delivery.mentionedWids?.length ? { mentionedWids: [...claim.delivery.mentionedWids] } : {}),
      ...(claim.delivery.inlineMentions ? { inlineMentions: true } : {}),
      ...(claim.delivery.mentionAll ? { mentionAll: true } : {}),
      ...(claim.delivery.groupMentions?.length ? { groupMentions: claim.delivery.groupMentions } : {}),
      requiredProviderId: 'whatsmeow'
    });
    const messageId = sent.messageId?.trim();
    if (!messageId) {
      throw new Error('Poll result delivery returned no WhatsApp message id.');
    }
    const sentAt = clock();
    const persisted = markPollDeliverySent(db, {
      deliveryId,
      claimToken: claim.claimToken,
      messageId,
      sentAt: sentAt.toISOString()
    });
    if (persisted) {
      await scheduleNextPollResultPage(context, claim.delivery, sentAt);
      await schedulePollCleanup(context, claim.delivery.pollId);
    }
  } catch (error) {
    if (isSafeToRetryDelivery(error)) {
      await rescheduleDelivery(context, claim, error, clock());
      return;
    }
    markPollDeliveryUncertain(db, {
      deliveryId,
      claimToken: claim.claimToken,
      error: errorMessage(error),
      updatedAt: clock().toISOString()
    });
  }
}

export async function cleanupPollBallots(
  context: PluginRuntimeContext,
  pollId: string,
  clock: () => Date = () => new Date()
): Promise<void> {
  const db = pollsDatabase(context.databases);
  const aggregate = getPollAggregate(db, pollId);
  if (!aggregate || !isTerminalPoll(aggregate.poll)) {
    return;
  }
  const now = clock();
  const config = parsePollAssistantConfig(await context.configFor(aggregate.poll.scopeId));
  const retentionMs = config.ballotRetentionDays * 24 * 60 * 60_000;
  const retentionAnchorValue = getPollRetentionAnchor(db, pollId);
  if (!retentionAnchorValue) {
    return;
  }
  const retentionAnchor = new Date(retentionAnchorValue);
  const eligibleAt = new Date(retentionAnchor.getTime() + retentionMs);
  if (eligibleAt.getTime() > now.getTime()) {
    markPollCleanupReview(db, {
      pollId,
      nextReviewAt: new Date(Math.min(
        eligibleAt.getTime(),
        now.getTime() + POLL_CLEANUP_REVIEW_INTERVAL_MS
      )).toISOString()
    });
    await enqueuePollCleanupJob(context, {
      scopeId: aggregate.poll.scopeId,
      pollId,
      ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
      groupWid: aggregate.poll.chatId,
      runAt: eligibleAt
    });
    return;
  }
  if (aggregate.poll.definition.ballotDelivery === 'private') {
    if (!context.services) {
      throw new Error('Private poll vote-history release service is unavailable.');
    }
    for (const round of aggregate.rounds) {
      for (const issuance of listPollPrivateIssuancesByRound(db, round.id)) {
        if (!issuance.publicationStartedAt) {
          continue;
        }
        const released = await context.services.call<DoasPrivatePollReleaseOutput>({
          serviceId: DOAS_PRIVATE_POLL_SERVICE_ID,
          method: DOAS_PRIVATE_POLL_RELEASE_METHOD,
          scopeId: aggregate.poll.scopeId,
          actorIdentityId: aggregate.poll.creatorIdentityId,
          ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
          groupWid: aggregate.poll.chatId,
          input: doasPrivatePollReleaseInputSchema.parse({
            groupWid: aggregate.poll.chatId,
            recipientIdentityId: issuance.voterIdentityId,
            recipientDeliveryChatId: issuance.voterWid,
            idempotencyKey: issuance.publishIdempotencyKey
          })
        });
        if (!released.released) {
          throw new Error(`Private poll history receipt ${issuance.id} was not released.`);
        }
      }
    }
  } else {
    if (!context.releasePollSendReceipt) {
      throw new Error('Authoritative Poll vote-history release is unavailable.');
    }
    for (const round of aggregate.rounds) {
      await context.releasePollSendReceipt(
        aggregate.poll.chatId,
        round.publishIdempotencyKey
      );
    }
  }
  purgePollBallotData(db, {
    pollId,
    terminalBefore: new Date(now.getTime() - retentionMs).toISOString(),
    purgedAt: now.toISOString()
  });
}

async function scheduleNextPollResultPage(
  context: PluginRuntimeContext,
  delivered: { deliveryBatchKey?: string | undefined; pollId: string },
  now: Date
): Promise<void> {
  if (!delivered.deliveryBatchKey) {
    return;
  }
  const db = pollsDatabase(context.databases);
  const next = getNextPendingPollDeliveryInBatch(db, delivered.deliveryBatchKey);
  if (!next) {
    return;
  }
  const aggregate = getPollAggregate(db, delivered.pollId);
  if (!aggregate) {
    return;
  }
  const scheduledAt = next.nextAttemptAt ? new Date(next.nextAttemptAt) : now;
  await enqueuePollDeliveryJob(context, {
    scopeId: aggregate.poll.scopeId,
    deliveryId: next.id,
    ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
    groupWid: aggregate.poll.chatId,
    attempt: next.attempt + 1,
    ...(scheduledAt.getTime() > now.getTime() ? { runAt: scheduledAt } : {})
  });
}

async function rescheduleDelivery(
  context: PluginRuntimeContext,
  claim: PollDeliveryClaim,
  error: unknown,
  failedAt: Date
): Promise<void> {
  const nextAttemptAt = pollRetryAt(failedAt, claim.delivery.attempt);
  const persisted = reschedulePollDelivery(pollsDatabase(context.databases), {
    deliveryId: claim.delivery.id,
    claimToken: claim.claimToken,
    nextAttemptAt: nextAttemptAt.toISOString(),
    error: errorMessage(error),
    updatedAt: failedAt.toISOString()
  });
  if (!persisted) {
    return;
  }
  const aggregate = getPollAggregate(pollsDatabase(context.databases), claim.delivery.pollId);
  if (!aggregate) {
    throw new Error(`Poll delivery ${claim.delivery.id} has no owning poll.`);
  }
  await enqueuePollDeliveryJob(context, {
    scopeId: aggregate.poll.scopeId,
    deliveryId: claim.delivery.id,
    ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
    groupWid: aggregate.poll.chatId,
    attempt: claim.delivery.attempt + 1,
    runAt: nextAttemptAt
  });
}

async function schedulePollCleanup(
  context: PluginRuntimeContext,
  pollId: string
): Promise<void> {
  const db = pollsDatabase(context.databases);
  const aggregate = getPollAggregate(db, pollId);
  if (!aggregate || !isTerminalPoll(aggregate.poll)) {
    return;
  }
  const retentionAnchorValue = getPollRetentionAnchor(db, pollId);
  if (!retentionAnchorValue) {
    return;
  }
  const config = parsePollAssistantConfig(await context.configFor(aggregate.poll.scopeId));
  await enqueuePollCleanupJob(context, {
    scopeId: aggregate.poll.scopeId,
    pollId,
    ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
    groupWid: aggregate.poll.chatId,
    runAt: new Date(
      new Date(retentionAnchorValue).getTime()
      + config.ballotRetentionDays * 24 * 60 * 60_000
    )
  });
}

function isSafeToRetryDelivery(error: unknown): boolean {
  return error instanceof PollDeliveryNotAttemptedError
    || isDefinitelyNotSentTransportError(error)
    || isTransportProviderUnavailableError(error);
}

function isTerminalPoll(poll: StoredPoll): boolean {
  return poll.status === 'resolved' || poll.status === 'cancelled' || poll.status === 'failed';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
