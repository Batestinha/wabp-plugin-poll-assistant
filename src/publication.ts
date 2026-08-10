import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import {
  isDefinitelyNotSentTransportError,
  TransportGroupNotFoundError
} from '../../../platform/transport/transportErrors';
import {
  DOAS_POLL_PUBLISH_METHOD,
  DOAS_POLL_SERVICE_ID,
  doasPollPublishInputSchema,
  type DoasPollPublishOutput
} from '../doas/serviceApi';
import type { PollElector } from './domain';
import { POLL_ASSISTANT_PLUGIN_ID } from './database';
import { enqueuePollDeliveryJob, enqueuePollFinalizeJob, enqueuePollPublishJob, pollRetryAt } from './jobs';
import {
  POLL_PUBLICATION_LEASE_MS,
  capturePollElectorate,
  claimPollRoundPublication,
  failPollRoundPublication,
  getCapturedPollElectorateByRoundId,
  getPollLifecycleByRoundId,
  markPollRoundPublished,
  pollsDatabase,
  reschedulePollRoundPublication,
  type PollPublicationClaim,
  type StoredPollRoundSnapshot
} from './store';

const PUBLICATION_FAILURE_MESSAGE_KEY = 'official.poll-assistant.failure.publication';

class CanonicalPollPublicationError extends Error {
  override readonly name = 'CanonicalPollPublicationError';
}

export async function publishPollRound(
  context: PluginRuntimeContext,
  pollId: string,
  roundId: string,
  clock: () => Date = () => new Date()
): Promise<void> {
  const db = pollsDatabase(context.databases);
  const claimedAt = clock();
  const claim = claimPollRoundPublication(db, {
    roundId,
    claimToken: randomUUID(),
    now: claimedAt.toISOString(),
    leaseExpiresAt: new Date(claimedAt.getTime() + POLL_PUBLICATION_LEASE_MS).toISOString()
  });
  if (!claim) {
    await reconcilePublicationSuccessor(context, pollId, roundId);
    return;
  }
  if (claim.poll.id !== pollId) {
    await reschedulePublication(
      context,
      claim,
      new Error(`Poll round ${roundId} does not belong to poll ${pollId}.`),
      clock()
    );
    return;
  }

  try {
    const snapshot = requireClaimedSnapshot(db, claim);
    if (!snapshot.round.publicationStartedAt) {
      requirePublicationDeadlineHasNotPassed(snapshot, clock());
    }
    await ensurePublicationElectorate(context, claim, clock);
    const sendSnapshot = requireClaimedSnapshot(db, claim);
    const publicationStartedAt = sendSnapshot.round.publicationStartedAt;
    if (!publicationStartedAt) {
      throw new Error('Poll electorate capture did not persist its publication timestamp.');
    }
    const publishInput = canonicalPublishInput(sendSnapshot);
    if (!context.services) {
      throw new Error('Poll publication service registry is unavailable.');
    }
    const sent = await context.services.call<DoasPollPublishOutput>({
      serviceId: DOAS_POLL_SERVICE_ID,
      method: DOAS_POLL_PUBLISH_METHOD,
      scopeId: claim.poll.scopeId,
      actorIdentityId: claim.poll.creatorIdentityId,
      ...(claim.poll.groupId ? { groupId: claim.poll.groupId } : {}),
      groupWid: claim.poll.chatId,
      input: publishInput
    });
    const pollWaMessageId = sent?.messageId?.trim();
    if (!pollWaMessageId) {
      throw new Error('Poll publication returned no WhatsApp message id.');
    }
    const persisted = markPollRoundPublished(db, {
      roundId,
      claimToken: claim.claimToken,
      pollWaMessageId,
      publishedAt: publicationStartedAt
    });
    if (!persisted) {
      return;
    }
    const published = getPollLifecycleByRoundId(db, roundId);
    if (published?.round.closesAt) {
      await enqueuePollFinalizeJob(context, {
        scopeId: published.poll.scopeId,
        pollId: published.poll.id,
        roundId,
        ...(published.poll.groupId ? { groupId: published.poll.groupId } : {}),
        groupWid: published.poll.chatId,
        attempt: published.round.finalizationAttempt,
        runAt: new Date(published.round.closesAt)
      });
    }
  } catch (error) {
    if (isTerminalPublicationError(error)) {
      await persistTerminalPublicationFailure(context, claim, error, clock());
      return;
    }
    await reschedulePublication(context, claim, error, clock());
  }
}

function requirePublicationDeadlineHasNotPassed(
  snapshot: StoredPollRoundSnapshot,
  now: Date
): void {
  const closing = snapshot.poll.definition.closing;
  if (
    closing.kind === 'deadline'
    && closing.deadline.mode === 'at'
    && Date.parse(closing.deadline.closesAt) <= now.getTime()
  ) {
    throw new CanonicalPollPublicationError(
      `Poll ${snapshot.poll.id} expired before its first publication attempt.`
    );
  }
}

function requireClaimedSnapshot(
  db: ReturnType<typeof pollsDatabase>,
  claim: PollPublicationClaim
): StoredPollRoundSnapshot {
  const snapshot = getPollLifecycleByRoundId(db, claim.round.id);
  if (
    !snapshot
    || snapshot.poll.id !== claim.poll.id
    || snapshot.round.status !== 'publishing'
    || snapshot.round.publicationClaimToken !== claim.claimToken
    || snapshot.options.length !== snapshot.poll.definition.options.length
  ) {
    throw new CanonicalPollPublicationError(
      `Poll round ${claim.round.id} has no canonical publication snapshot.`
    );
  }
  return snapshot;
}

function canonicalPublishInput(snapshot: StoredPollRoundSnapshot) {
  try {
    return doasPollPublishInputSchema.parse({
      groupWid: snapshot.poll.chatId,
      question: snapshot.round.question,
      options: [...snapshot.options]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((option) => option.wireLabel),
      allowMultipleAnswers: snapshot.round.allowMultipleAnswers,
      idempotencyKey: snapshot.round.publishIdempotencyKey,
      sourcePluginId: POLL_ASSISTANT_PLUGIN_ID
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new CanonicalPollPublicationError('Stored poll content cannot be published.');
    }
    throw error;
  }
}

async function ensurePublicationElectorate(
  context: PluginRuntimeContext,
  claim: PollPublicationClaim,
  clock: () => Date
): Promise<readonly PollElector[]> {
  const db = pollsDatabase(context.databases);
  const captured = getCapturedPollElectorateByRoundId(db, claim.round.id);
  if (captured) {
    if (captured.length === 0) {
      throw new Error('Poll electorate is empty.');
    }
    return captured;
  }
  if (!context.getGroupParticipants || !context.resolveIdentityAddress || !context.getCurrentBotWid) {
    throw new Error('Authoritative group participant and identity reads are unavailable.');
  }
  const botWid = (await context.getCurrentBotWid())?.trim();
  if (!botWid) {
    throw new Error('The current WhatsApp bot identity is unavailable.');
  }
  const participants = (await context.getGroupParticipants(claim.poll.chatId))
    .map((participant) => ({ ...participant, wid: participant.wid.trim() }))
    .sort((left, right) => left.wid.localeCompare(right.wid));
  if (participants.some((participant) => !participant.wid)) {
    throw new Error('Group participant read returned an empty WhatsApp identity.');
  }
  const [botIdentity, ...participantIdentities] = await Promise.all([
    context.resolveIdentityAddress(botWid),
    ...participants.map(async (participant) => ({
      participant,
      resolution: await context.resolveIdentityAddress!(participant.wid)
    }))
  ]);
  if (!botIdentity.identityId.trim()) {
    throw new Error('Bot identity resolution did not return a stable identity id.');
  }
  const byIdentityId = new Map<string, PollElector>();
  for (const resolved of participantIdentities) {
    const identityId = resolved.resolution.identityId.trim();
    const voterWid = resolved.resolution.deliveryChatId.trim();
    if (!identityId || !voterWid) {
      throw new Error('Participant identity resolution was incomplete.');
    }
    if (identityId === botIdentity.identityId) {
      continue;
    }
    const displayLabel = resolved.participant.displayName?.trim()
      || resolved.resolution.displayName?.trim();
    const candidate: PollElector = {
      voterIdentityId: identityId,
      voterWid,
      ...(displayLabel ? { displayLabel } : {})
    };
    const existing = byIdentityId.get(identityId);
    if (!existing || electorSortKey(candidate) < electorSortKey(existing)) {
      byIdentityId.set(identityId, candidate);
    }
  }
  const electorate = [...byIdentityId.values()]
    .sort((left, right) => left.voterIdentityId.localeCompare(right.voterIdentityId));
  if (electorate.length === 0) {
    throw new Error('Poll electorate is empty.');
  }
  return capturePollElectorate(db, {
    roundId: claim.round.id,
    claimToken: claim.claimToken,
    electorate,
    capturedAt: clock().toISOString()
  });
}

function electorSortKey(elector: PollElector): string {
  return `${elector.voterWid}\u0000${elector.displayLabel ?? ''}`;
}

function isTerminalPublicationError(error: unknown): boolean {
  return error instanceof CanonicalPollPublicationError
    || error instanceof TransportGroupNotFoundError
    || (
      isDefinitelyNotSentTransportError(error)
      && (error.code === 'group_not_found' || error.code === 'poll_content_invalid')
    );
}

async function persistTerminalPublicationFailure(
  context: PluginRuntimeContext,
  claim: PollPublicationClaim,
  error: unknown,
  failedAt: Date
): Promise<void> {
  const t = await context.i18n.translatorForScope(claim.poll.scopeId);
  const deliveryId = `poll-publication-failure:${claim.round.id}`;
  const persisted = failPollRoundPublication(pollsDatabase(context.databases), {
    roundId: claim.round.id,
    claimToken: claim.claimToken,
    error: errorMessage(error),
    delivery: {
      id: deliveryId,
      kind: 'failure',
      deliveryKey: `publication-failure:${claim.round.id}:v1`,
      chatId: claim.poll.chatId,
      text: t(PUBLICATION_FAILURE_MESSAGE_KEY, {
        question: claim.poll.definition.question,
        pollId: claim.poll.id
      }),
      idempotencyKey: `poll-assistant:publication-failure:${claim.poll.id}:${claim.round.id}:v1`
    },
    failedAt: failedAt.toISOString()
  });
  if (persisted) {
    await enqueuePollDeliveryJob(context, {
      scopeId: claim.poll.scopeId,
      deliveryId,
      ...(claim.poll.groupId ? { groupId: claim.poll.groupId } : {}),
      groupWid: claim.poll.chatId,
      attempt: 0
    });
  }
}

async function reschedulePublication(
  context: PluginRuntimeContext,
  claim: PollPublicationClaim,
  error: unknown,
  failedAt: Date
): Promise<void> {
  const nextAttemptAt = pollRetryAt(failedAt, claim.round.publicationAttempt);
  const persisted = reschedulePollRoundPublication(pollsDatabase(context.databases), {
    roundId: claim.round.id,
    claimToken: claim.claimToken,
    nextAttemptAt: nextAttemptAt.toISOString(),
    error: errorMessage(error),
    updatedAt: failedAt.toISOString()
  });
  if (persisted) {
    await enqueuePollPublishJob(context, {
      scopeId: claim.poll.scopeId,
      pollId: claim.poll.id,
      roundId: claim.round.id,
      ...(claim.poll.groupId ? { groupId: claim.poll.groupId } : {}),
      groupWid: claim.poll.chatId,
      attempt: claim.round.publicationAttempt,
      runAt: nextAttemptAt
    });
    return;
  }
  await reconcilePublicationSuccessor(context, claim.poll.id, claim.round.id);
}

async function reconcilePublicationSuccessor(
  context: PluginRuntimeContext,
  pollId: string,
  roundId: string
): Promise<void> {
  const snapshot = getPollLifecycleByRoundId(pollsDatabase(context.databases), roundId);
  if (!snapshot || snapshot.poll.id !== pollId) {
    return;
  }
  if (snapshot.round.status === 'open' && snapshot.round.closesAt) {
    await enqueuePollFinalizeJob(context, {
      scopeId: snapshot.poll.scopeId,
      pollId: snapshot.poll.id,
      roundId,
      ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
      groupWid: snapshot.poll.chatId,
      attempt: snapshot.round.finalizationAttempt,
      runAt: new Date(snapshot.round.closesAt)
    });
    return;
  }
  if (snapshot.round.status === 'failed') {
    await enqueuePollDeliveryJob(context, {
      scopeId: snapshot.poll.scopeId,
      deliveryId: `poll-publication-failure:${roundId}`,
      ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
      groupWid: snapshot.poll.chatId,
      attempt: 0
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
