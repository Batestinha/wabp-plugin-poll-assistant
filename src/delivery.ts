import { randomUUID } from 'node:crypto';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import {
  isDefinitelyNotSentTransportError,
  isTransportProviderUnavailableError
} from '../../../platform/transport/transportErrors';
import { parsePollAssistantConfig } from './config';
import { enqueuePollCleanupJob, enqueuePollDeliveryJob, pollRetryAt } from './jobs';
import {
  POLL_DELIVERY_LEASE_MS,
  claimPollDeliveryById,
  getPollAggregate,
  getPollDelivery,
  markPollDeliverySent,
  markPollDeliveryUncertain,
  pollsDatabase,
  purgePollBallotData,
  reschedulePollDelivery,
  type PollDeliveryClaim,
  type StoredPoll
} from './store';

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
      await schedulePollCleanup(context, existing.pollId, deliveryId, new Date(existing.sentAt));
    }
    return;
  }

  try {
    if (!context.sendText) {
      throw new PollDeliveryNotAttemptedError('Poll result delivery transport is unavailable.');
    }
    const sent = await context.sendText(claim.delivery.chatId, claim.delivery.text, {
      idempotencyKey: claim.delivery.idempotencyKey
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
      await schedulePollCleanup(context, claim.delivery.pollId, deliveryId, sentAt);
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
  const terminalAt = pollTerminalAt(aggregate.poll);
  const eligibleAt = new Date(terminalAt.getTime() + retentionMs);
  if (eligibleAt.getTime() > now.getTime()) {
    await enqueuePollCleanupJob(context, {
      scopeId: aggregate.poll.scopeId,
      pollId,
      ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
      groupWid: aggregate.poll.chatId,
      scheduleKey: terminalAt.toISOString(),
      runAt: eligibleAt
    });
    return;
  }
  purgePollBallotData(db, {
    pollId,
    terminalBefore: new Date(now.getTime() - retentionMs).toISOString(),
    purgedAt: now.toISOString()
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
    attempt: claim.delivery.attempt,
    runAt: nextAttemptAt
  });
}

async function schedulePollCleanup(
  context: PluginRuntimeContext,
  pollId: string,
  deliveryId: string,
  sentAt: Date
): Promise<void> {
  const aggregate = getPollAggregate(pollsDatabase(context.databases), pollId);
  if (!aggregate || !isTerminalPoll(aggregate.poll)) {
    return;
  }
  const config = parsePollAssistantConfig(await context.configFor(aggregate.poll.scopeId));
  await enqueuePollCleanupJob(context, {
    scopeId: aggregate.poll.scopeId,
    pollId,
    ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
    groupWid: aggregate.poll.chatId,
    scheduleKey: deliveryId,
    runAt: new Date(sentAt.getTime() + config.ballotRetentionDays * 24 * 60 * 60_000)
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

function pollTerminalAt(poll: StoredPoll): Date {
  const value = poll.resolvedAt ?? poll.cancelledAt ?? poll.updatedAt;
  const terminalAt = new Date(value);
  if (Number.isNaN(terminalAt.getTime())) {
    throw new Error(`Poll ${poll.id} has no valid terminal timestamp.`);
  }
  return terminalAt;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
