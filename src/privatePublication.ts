import { randomUUID } from 'node:crypto';
import type { PluginRuntimeContext } from './runtime';
import { isPluginServiceNotInvokedError } from '../../../../packages/plugin-sdk/src/services';
import {
  findTransportRateLimitError,
  isDefinitelyNotSentTransportError,
  isTransportProviderUnavailableError
} from '../../../../packages/plugin-sdk/src/transport-errors';
import {
  DOAS_PRIVATE_POLL_PUBLISH_METHOD,
  DOAS_PRIVATE_POLL_RECONCILE_METHOD,
  DOAS_PRIVATE_POLL_SERVICE_ID,
  doasPrivatePollPublishInputSchema,
  doasPrivatePollReconcileInputSchema,
  type DoasPrivatePollPublishOutput,
  type DoasPrivatePollReconcileOutput
} from './contracts/doas-poll-v1';
import { enqueuePollPrivateIssueJob, pollRetryAt } from './jobs';
import { deliverPollPrivatePublicationAudit } from './privatePublicationAudit';
import {
  POLL_PUBLICATION_LEASE_MS,
  claimPollPrivateIssuance,
  failPollPrivateIssuance,
  getPollAggregate,
  getPollLifecycleByRoundId,
  getPollPrivateIssuance,
  markPollPrivateIssuanceSent,
  pollsDatabase,
  renewPollPrivateIssuanceClaim,
  reschedulePollPrivateIssuance,
  startPollPrivateIssuanceAttempt,
  type StoredPollPrivateIssuance,
  type StoredPollRoundSnapshot
} from './store';

export async function publishPrivatePollIssuance(
  context: PluginRuntimeContext,
  issuanceId: string,
  clock: () => Date = () => new Date()
): Promise<void> {
  const db = pollsDatabase(context.databases);
  const claimedAt = clock();
  const claimToken = randomUUID();
  const issuance = claimPollPrivateIssuance(db, {
    issuanceId,
    claimToken,
    now: claimedAt.toISOString(),
    leaseExpiresAt: new Date(claimedAt.getTime() + POLL_PUBLICATION_LEASE_MS).toISOString()
  });
  if (!issuance) {
    return;
  }

  let providerMutationAttempted = false;
  try {
    const snapshot = requirePrivateIssuanceSnapshot(context, issuance);
    const notAfter = privateIssuanceNotAfter(snapshot);
    if (notAfter && Date.parse(notAfter) <= clock().getTime()) {
      throw new PrivateIssuanceTerminalError('The private ballot voting window has ended.');
    }
    if (!context.services) {
      throw new Error('Private poll publication service registry is unavailable.');
    }
    const receipt = await context.services.call<DoasPrivatePollReconcileOutput>({
      serviceId: DOAS_PRIVATE_POLL_SERVICE_ID,
      method: DOAS_PRIVATE_POLL_RECONCILE_METHOD,
      scopeId: snapshot.poll.scopeId,
      actorIdentityId: snapshot.poll.creatorIdentityId,
      ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
      groupWid: snapshot.poll.chatId,
      input: doasPrivatePollReconcileInputSchema.parse({
        groupWid: snapshot.poll.chatId,
        recipientIdentityId: issuance.voterIdentityId,
        recipientDeliveryChatId: issuance.voterWid,
        idempotencyKey: issuance.publishIdempotencyKey
      })
    });
    if (receipt.status === 'found') {
      persistPrivateReceipt(db, issuance, claimToken, receipt);
      await deliverPrivatePublicationAuditBestEffort(context, issuance.id, clock);
      return;
    }

    if (!issuance.publicationStartedAt) {
      startPollPrivateIssuanceAttempt(db, {
        issuanceId: issuance.id,
        claimToken,
        startedAt: clock().toISOString()
      });
    }
    const providerBoundaryAt = clock();
    if (!renewPollPrivateIssuanceClaim(db, {
      issuanceId: issuance.id,
      claimToken,
      now: providerBoundaryAt.toISOString(),
      leaseExpiresAt: new Date(
        providerBoundaryAt.getTime() + POLL_PUBLICATION_LEASE_MS
      ).toISOString()
    })) {
      throw new Error(`Private poll issuance claim ${issuance.id} expired before provider invocation.`);
    }
    const providerSnapshot = requirePrivateIssuanceProviderBoundary(
      context,
      issuance.id,
      claimToken,
      providerBoundaryAt
    );
    const providerNotAfter = privateIssuanceNotAfter(providerSnapshot.snapshot);
    providerMutationAttempted = true;
    const sent = await context.services.call<DoasPrivatePollPublishOutput>({
      serviceId: DOAS_PRIVATE_POLL_SERVICE_ID,
      method: DOAS_PRIVATE_POLL_PUBLISH_METHOD,
      scopeId: snapshot.poll.scopeId,
      actorIdentityId: snapshot.poll.creatorIdentityId,
      ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
      groupWid: snapshot.poll.chatId,
      input: doasPrivatePollPublishInputSchema.parse({
        groupWid: providerSnapshot.snapshot.poll.chatId,
        recipientIdentityId: providerSnapshot.issuance.voterIdentityId,
        recipientDeliveryChatId: providerSnapshot.issuance.voterWid,
        question: providerSnapshot.snapshot.round.question,
        options: [...providerSnapshot.snapshot.options]
          .sort((left, right) => left.ordinal - right.ordinal)
          .map((option) => option.wireLabel),
        allowMultipleAnswers: providerSnapshot.snapshot.round.allowMultipleAnswers,
        idempotencyKey: providerSnapshot.issuance.publishIdempotencyKey,
        ...(providerNotAfter ? { notAfter: providerNotAfter } : {})
      })
    });
    persistPrivateReceipt(db, issuance, claimToken, {
      status: 'found',
      providerId: 'whatsmeow',
      ...(sent.messageId ? { messageId: sent.messageId } : {}),
      ...(sent.remoteChatId ? { remoteChatId: sent.remoteChatId } : {}),
      ...(sent.acceptedAt ? { acceptedAt: sent.acceptedAt } : {})
    });
    await deliverPrivatePublicationAuditBestEffort(context, issuance.id, clock);
  } catch (error) {
    const failedAt = clock();
    if (error instanceof PrivateIssuanceTerminalError || terminalTransportError(error)) {
      failPollPrivateIssuance(db, {
        issuanceId: issuance.id,
        claimToken,
        error: errorMessage(error),
        failedAt: failedAt.toISOString()
      });
      return;
    }
    const rateLimit = findTransportRateLimitError(error);
    const definitelyNotSent = isPluginServiceNotInvokedError(error)
      || isDefinitelyNotSentTransportError(error)
      || isTransportProviderUnavailableError(error)
      || rateLimit?.outcome === 'not_attempted';
    const backoffAt = pollRetryAt(failedAt, issuance.attempt);
    const nextAttemptAt = new Date(Math.max(
      backoffAt.getTime(),
      rateLimit?.retryAt?.getTime() ?? 0,
      failedAt.getTime() + (rateLimit?.retryAfterMs ?? 0)
    ));
    const persisted = reschedulePollPrivateIssuance(db, {
      issuanceId: issuance.id,
      claimToken,
      status: providerMutationAttempted && !definitelyNotSent ? 'uncertain' : 'pending',
      nextAttemptAt: nextAttemptAt.toISOString(),
      error: errorMessage(error),
      updatedAt: failedAt.toISOString(),
      resetPublicationAnchor: !providerMutationAttempted || definitelyNotSent
    });
    if (!persisted) {
      return;
    }
    const snapshot = getPollLifecycleByRoundId(db, issuance.roundId);
    if (!snapshot || snapshot.poll.status !== 'active') {
      return;
    }
    await enqueuePollPrivateIssueJob(context, {
      scopeId: snapshot.poll.scopeId,
      issuanceId: issuance.id,
      ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
      groupWid: snapshot.poll.chatId,
      attempt: issuance.attempt + 1,
      runAt: nextAttemptAt
    });
  }
}

async function deliverPrivatePublicationAuditBestEffort(
  context: PluginRuntimeContext,
  issuanceId: string,
  clock: () => Date
): Promise<void> {
  try {
    await deliverPollPrivatePublicationAudit(context, issuanceId, clock);
  } catch (error) {
    context.logger.warn(
      { error, issuanceId },
      'official.poll-assistant private publication audit delivery deferred'
    );
  }
}

function requirePrivateIssuanceProviderBoundary(
  context: PluginRuntimeContext,
  issuanceId: string,
  claimToken: string,
  now: Date
): { issuance: StoredPollPrivateIssuance; snapshot: StoredPollRoundSnapshot } {
  const db = pollsDatabase(context.databases);
  const issuance = getPollPrivateIssuance(db, issuanceId);
  if (
    !issuance
    || issuance.status !== 'publishing'
    || issuance.claimToken !== claimToken
    || issuance.pollWaMessageId
  ) {
    throw new PrivateIssuanceTerminalError(
      `Private poll issuance ${issuanceId} is no longer publishable.`
    );
  }
  const snapshot = requirePrivateIssuanceSnapshot(context, issuance);
  const notAfter = privateIssuanceNotAfter(snapshot);
  if (notAfter && Date.parse(notAfter) <= now.getTime()) {
    throw new PrivateIssuanceTerminalError('The private ballot voting window has ended.');
  }
  const aggregate = getPollAggregate(db, issuance.pollId);
  if (!aggregate?.electorate.some((elector) =>
    elector.voterIdentityId === issuance.voterIdentityId)) {
    throw new PrivateIssuanceTerminalError(
      `Private poll elector ${issuance.voterIdentityId} is no longer eligible.`
    );
  }
  return { issuance, snapshot };
}

function requirePrivateIssuanceSnapshot(
  context: PluginRuntimeContext,
  issuance: StoredPollPrivateIssuance
): StoredPollRoundSnapshot {
  const snapshot = getPollLifecycleByRoundId(pollsDatabase(context.databases), issuance.roundId);
  if (
    !snapshot
    || snapshot.poll.id !== issuance.pollId
    || snapshot.poll.status !== 'active'
    || snapshot.poll.definition.ballotDelivery !== 'private'
    || !['publishing', 'open'].includes(snapshot.round.status)
  ) {
    throw new PrivateIssuanceTerminalError(
      `Private poll issuance ${issuance.id} no longer has an active owning round.`
    );
  }
  return snapshot;
}

function privateIssuanceNotAfter(snapshot: StoredPollRoundSnapshot): string | undefined {
  if (snapshot.round.closesAt) {
    return snapshot.round.closesAt;
  }
  const closing = snapshot.poll.definition.closing;
  return closing.kind === 'deadline' && closing.deadline.mode === 'at'
    ? closing.deadline.closesAt
    : undefined;
}

function persistPrivateReceipt(
  db: ReturnType<typeof pollsDatabase>,
  issuance: StoredPollPrivateIssuance,
  claimToken: string,
  receipt: DoasPrivatePollReconcileOutput
): void {
  const messageId = receipt.messageId?.trim();
  const acceptedAt = receipt.acceptedAt?.trim();
  if (
    receipt.status !== 'found'
    || receipt.providerId !== 'whatsmeow'
    || !messageId
    || !acceptedAt
    || Number.isNaN(Date.parse(acceptedAt))
  ) {
    throw new Error('Private poll publication returned no authoritative WhatsApp receipt.');
  }
  markPollPrivateIssuanceSent(db, {
    issuanceId: issuance.id,
    claimToken,
    pollWaMessageId: messageId,
    ...(receipt.remoteChatId ? { remoteChatId: receipt.remoteChatId } : {}),
    acceptedAt
  });
}

function terminalTransportError(error: unknown): boolean {
  return isDefinitelyNotSentTransportError(error)
    && (error.code === 'poll_content_invalid' || error.code === 'send_constraint_expired');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class PrivateIssuanceTerminalError extends Error {
  override readonly name = 'PrivateIssuanceTerminalError';
}
