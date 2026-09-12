import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PluginRuntimeContext } from './runtime';
import { isPluginServiceNotInvokedError } from '@wabs/plugin-sdk/services';
import {
  isDefinitelyNotSentTransportError,
  isTransportProviderUnavailableError,
  TransportGroupNotFoundError
} from '@wabs/plugin-sdk/transport-errors';
import {
  DOAS_POLL_PUBLISH_METHOD,
  DOAS_POLL_RECONCILE_METHOD,
  DOAS_POLL_SERVICE_ID,
  doasPollPublishInputSchema,
  doasPollReconcileInputSchema,
  type DoasPollPublishOutput,
  type DoasPollReconcileOutput
} from './contracts/doas-poll-v1';
import type { PollElector } from './domain';
import { parsePollAssistantConfig } from './config';
import { POLL_ASSISTANT_PLUGIN_ID } from './database';
import {
  enqueuePollDeliveryJob,
  enqueuePollFinalizeJob,
  enqueuePollPrivateIssueJob,
  enqueuePollPublishJob,
  POLL_PRIVATE_ISSUANCE_PACING_MS,
  POLL_PRIVATE_MINIMUM_VOTING_WINDOW_MS,
  pollRetryAt
} from './jobs';
import {
  POLL_PUBLICATION_LEASE_MS,
  capturePollElectorate,
  claimPollRoundPublication,
  discardUnanchoredPollElectorate,
  ensurePollPrivateIssuancesForCapturedElectorate,
  failPollRoundPublication,
  getCapturedPollElectorateByRoundId,
  getPollDelivery,
  getPollLifecycleByRoundId,
  markPollRoundPublished,
  markPrivatePollRoundPublished,
  pollsDatabase,
  resetPollRoundPublicationAfterDefiniteNonDelivery,
  renewPollRoundPublicationClaim,
  reschedulePollRoundPublication,
  reschedulePollRoundPublicationUncertain,
  startPollRoundPublicationAttempt,
  type PollPublicationClaim,
  type StoredPollRoundSnapshot
} from './store';
import { reconcilePollRoundTiming } from './timing';

const PUBLICATION_FAILURE_MESSAGE_KEY = 'official.poll-assistant.failure.publication';

class CanonicalPollPublicationError extends Error {
  override readonly name: string = 'CanonicalPollPublicationError';
}

class UnconfirmedPollPublicationError extends CanonicalPollPublicationError {
  override readonly name = 'UnconfirmedPollPublicationError';
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
  let deliveryAttempted = false;
  let resumedAttempt = false;

  try {
    const snapshotBeforeCapture = requireClaimedSnapshot(db, claim);
    resumedAttempt = Boolean(snapshotBeforeCapture.round.publicationStartedAt);
    if (!resumedAttempt) {
      requirePublicationDeadlineHasNotPassed(snapshotBeforeCapture, clock());
      discardUnanchoredPollElectorate(db, {
        roundId: claim.round.id,
        claimToken: claim.claimToken,
        updatedAt: clock().toISOString()
      });
    }
    const config = parsePollAssistantConfig(await context.configFor(claim.poll.scopeId));
    const electorate = await ensurePublicationElectorate(
      context,
      claim,
      clock(),
      config.maxPrivateElectorateSize
    );
    let sendSnapshot = requireClaimedSnapshot(db, claim);
    requireTallyTotalWithinSafeInteger(sendSnapshot, electorate.length);
    if (sendSnapshot.poll.definition.ballotDelivery === 'private') {
      const activationBoundaryAt = clock();
      requirePrivateFanoutWindow(sendSnapshot, electorate.length, activationBoundaryAt);
      if (!renewPollRoundPublicationClaim(db, {
        roundId: claim.round.id,
        claimToken: claim.claimToken,
        now: activationBoundaryAt.toISOString(),
        leaseExpiresAt: new Date(
          activationBoundaryAt.getTime() + POLL_PUBLICATION_LEASE_MS
        ).toISOString()
      })) {
        throw new Error(`Publication claim for private poll round ${claim.round.id} expired before activation.`);
      }
      sendSnapshot = requireClaimedSnapshot(db, claim);
      await activatePrivatePollRound(context, claim, sendSnapshot, clock);
      return;
    }
    let publicationStartedAt = sendSnapshot.round.publicationStartedAt;
    if (!context.services) {
      throw new Error('Poll publication service registry is unavailable.');
    }
    const receipt = await context.services.call<DoasPollReconcileOutput>({
      serviceId: DOAS_POLL_SERVICE_ID,
      method: DOAS_POLL_RECONCILE_METHOD,
      scopeId: claim.poll.scopeId,
      actorIdentityId: claim.poll.creatorIdentityId,
      ...(claim.poll.groupId ? { groupId: claim.poll.groupId } : {}),
      groupWid: claim.poll.chatId,
      input: doasPollReconcileInputSchema.parse({
        groupWid: sendSnapshot.poll.chatId,
        idempotencyKey: sendSnapshot.round.publishIdempotencyKey
      })
    });
    if (receipt.status === 'found') {
      if (!publicationStartedAt) {
        throw new CanonicalPollPublicationError(
          'Provider returned a poll receipt without the durable provider-attempt anchor.'
        );
      }
      await persistAcceptedPublication(context, claim, receipt, clock(), {
        deadlineAnchorAt: conservativePublicationAnchor(
          publicationStartedAt,
          receipt.acceptedAt ?? publicationStartedAt
        )
      });
      return;
    }
    if (receipt.status === 'unknown') {
      if (!publicationStartedAt) {
        throw new UnconfirmedPollPublicationError(
          'Provider returned an unresolved poll send without the durable provider-attempt anchor.'
        );
      }
      requireUnknownPublicationWindowHasNotExpired(sendSnapshot, clock());
    }
    if (receipt.status === 'absent' && publicationStartedAt) {
      await reschedulePublication(
        context,
        claim,
        new Error('Provider proved that the previous poll publication attempt was absent.'),
        clock(),
        { resetPublicationWindow: true }
      );
      return;
    }
    if (!publicationStartedAt) {
      publicationStartedAt = startPollRoundPublicationAttempt(db, {
        roundId: claim.round.id,
        claimToken: claim.claimToken,
        startedAt: clock().toISOString()
      });
      sendSnapshot = requireClaimedSnapshot(db, claim);
    }
    const publishInput = canonicalPublishInput(sendSnapshot);
    const providerBoundaryAt = clock();
    if (!renewPollRoundPublicationClaim(db, {
      roundId: claim.round.id,
      claimToken: claim.claimToken,
      now: providerBoundaryAt.toISOString(),
      leaseExpiresAt: new Date(
        providerBoundaryAt.getTime() + POLL_PUBLICATION_LEASE_MS
      ).toISOString()
    })) {
      throw new Error(
        `Publication claim for poll round ${claim.round.id} expired before provider invocation.`
      );
    }
    deliveryAttempted = true;
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
    const acceptedAt = sent?.acceptedAt?.trim();
    if (!pollWaMessageId || !acceptedAt || Number.isNaN(Date.parse(acceptedAt))) {
      throw new Error('Poll publication returned no authoritative WhatsApp receipt.');
    }
    await persistAcceptedPublication(context, claim, {
      status: 'found',
      providerId: 'whatsmeow',
      messageId: pollWaMessageId,
      ...(sent.remoteChatId ? { remoteChatId: sent.remoteChatId } : {}),
      acceptedAt
    }, clock(), receipt.status === 'unknown'
      ? { deadlineAnchorAt: conservativePublicationAnchor(publicationStartedAt, acceptedAt) }
      : undefined);
  } catch (error) {
    if (isTerminalPublicationError(error)) {
      await persistTerminalPublicationFailure(context, claim, error, clock());
      return;
    }
    const definitelyNotAttempted = isPluginServiceNotInvokedError(error)
      || isDefinitelyNotSentTransportError(error)
      || isTransportProviderUnavailableError(error);
    if (deliveryAttempted && !definitelyNotAttempted) {
      await rescheduleUncertainPublication(context, claim, error, clock());
      return;
    }
    if (resumedAttempt) {
      await rescheduleUncertainPublication(context, claim, error, clock());
      return;
    }
    await reschedulePublication(context, claim, error, clock(), {
      resetPublicationWindow: !deliveryAttempted || definitelyNotAttempted
    });
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

function requireUnknownPublicationWindowHasNotExpired(
  snapshot: StoredPollRoundSnapshot,
  now: Date
): void {
  const closing = snapshot.poll.definition.closing;
  if (closing.kind !== 'deadline') {
    return;
  }
  const uncertaintyHorizon = closing.deadline.mode === 'at'
    ? Date.parse(closing.deadline.closesAt)
    : snapshot.round.publicationStartedAt
      ? Date.parse(snapshot.round.publicationStartedAt)
        + closing.deadline.durationMinutes * 60_000
      : undefined;
  if (uncertaintyHorizon !== undefined && uncertaintyHorizon <= now.getTime()) {
    throw new UnconfirmedPollPublicationError(
      `Poll ${snapshot.poll.id} has an unresolved provider send after its anchored publication window.`
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
    const closing = snapshot.poll.definition.closing;
    const relativeNotAfter = closing.kind === 'deadline'
      && closing.deadline.mode === 'after_publish'
      && snapshot.round.publicationStartedAt
      ? new Date(
          Date.parse(snapshot.round.publicationStartedAt)
            + closing.deadline.durationMinutes * 60_000
        ).toISOString()
      : undefined;
    return doasPollPublishInputSchema.parse({
      groupWid: snapshot.poll.chatId,
      question: snapshot.round.question,
      options: [...snapshot.options]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((option) => option.wireLabel),
      allowMultipleAnswers: snapshot.round.allowMultipleAnswers,
      idempotencyKey: snapshot.round.publishIdempotencyKey,
      ...(closing.kind === 'deadline' && closing.deadline.mode === 'at'
        ? { notAfter: closing.deadline.closesAt }
        : relativeNotAfter
          ? { notAfter: relativeNotAfter }
          : {}),
      sourcePluginId: POLL_ASSISTANT_PLUGIN_ID,
      historyHoldOwner: POLL_ASSISTANT_PLUGIN_ID
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new CanonicalPollPublicationError('Stored poll content cannot be published.');
    }
    throw error;
  }
}

function requireTallyTotalWithinSafeInteger(
  snapshot: StoredPollRoundSnapshot,
  electorateSize: number
): void {
  if (snapshot.poll.definition.purpose !== 'count') {
    return;
  }
  const maximumOptionValue = snapshot.poll.definition.options.reduce(
    (maximum, option) => Math.max(maximum, option.numericValue ?? 0),
    0
  );
  if (
    BigInt(maximumOptionValue) * BigInt(electorateSize)
    > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new CanonicalPollPublicationError(
      `Poll ${snapshot.poll.id} can exceed the safe Tally total for its frozen electorate.`
    );
  }
}

async function ensurePublicationElectorate(
  context: PluginRuntimeContext,
  claim: PollPublicationClaim,
  capturedAt: Date,
  maxPrivateElectorateSize: number
): Promise<readonly PollElector[]> {
  const db = pollsDatabase(context.databases);
  const captured = getCapturedPollElectorateByRoundId(db, claim.round.id);
  if (captured) {
    if (captured.length === 0) {
      throw new Error('Poll electorate is empty.');
    }
    if (
      claim.poll.definition.ballotDelivery === 'private'
      && captured.length > maxPrivateElectorateSize
    ) {
      throw new CanonicalPollPublicationError(
        `Private poll electorate ${captured.length} exceeds configured maximum ${maxPrivateElectorateSize}.`
      );
    }
    return captured;
  }
  if (!context.resolveIdentityAddress) {
    throw new Error('Authoritative identity reads are unavailable.');
  }
  if (claim.poll.definition.electorate.kind === 'actor') {
    const organizer = await context.resolveIdentityAddress(claim.poll.creatorWid);
    const voterIdentityId = organizer.identityId.trim();
    const voterWid = organizer.deliveryChatId.trim();
    if (!voterIdentityId || !voterWid || voterIdentityId !== claim.poll.creatorIdentityId) {
      throw new Error('The actor-only electorate could not resolve its authoritative organizer.');
    }
    return capturePollElectorate(db, {
      roundId: claim.round.id,
      claimToken: claim.claimToken,
      electorate: [{
        voterIdentityId,
        voterWid,
        ...(claim.poll.creatorLabel.trim() ? { displayLabel: claim.poll.creatorLabel.trim() } : {})
      }],
      capturedAt: capturedAt.toISOString()
    });
  }
  if (!context.getAuthoritativeGroupParticipantSnapshot) {
    throw new Error('Authoritative group participant and identity reads are unavailable.');
  }
  const participantSnapshot = await context.getAuthoritativeGroupParticipantSnapshot(claim.poll.chatId);
  if (
    participantSnapshot.providerId !== 'whatsmeow'
    || Number.isNaN(participantSnapshot.observedAt.getTime())
  ) {
    throw new Error('Authoritative group participant snapshot has invalid provider evidence.');
  }
  const botWid = participantSnapshot.botWid.trim();
  if (!botWid) {
    throw new Error('The authoritative group snapshot has no bot identity.');
  }
  const participants = participantSnapshot.participants
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
  if (
    claim.poll.definition.ballotDelivery === 'private'
    && electorate.length > maxPrivateElectorateSize
  ) {
    throw new CanonicalPollPublicationError(
      `Private poll electorate ${electorate.length} exceeds configured maximum ${maxPrivateElectorateSize}.`
    );
  }
  return capturePollElectorate(db, {
    roundId: claim.round.id,
    claimToken: claim.claimToken,
    electorate,
    capturedAt: participantSnapshot.observedAt.toISOString()
  });
}

async function activatePrivatePollRound(
  context: PluginRuntimeContext,
  claim: PollPublicationClaim,
  snapshot: StoredPollRoundSnapshot,
  clock: () => Date
): Promise<void> {
  const db = pollsDatabase(context.databases);
  if (!snapshot.round.publicationStartedAt) {
    startPollRoundPublicationAttempt(db, {
      roundId: claim.round.id,
      claimToken: claim.claimToken,
      startedAt: clock().toISOString()
    });
  }
  const issuances = ensurePollPrivateIssuancesForCapturedElectorate(db, {
    roundId: claim.round.id,
    claimToken: claim.claimToken,
    createdAt: clock().toISOString()
  });
  const activatedAt = clock();
  const activated = markPrivatePollRoundPublished(db, {
    roundId: claim.round.id,
    claimToken: claim.claimToken,
    acceptedAt: activatedAt.toISOString()
  });
  const current = getPollLifecycleByRoundId(db, claim.round.id);
  if (!activated && current?.round.status !== 'open') {
    throw new Error(`Private poll round ${claim.round.id} changed before activation.`);
  }
  let slot = 0;
  for (const issuance of issuances) {
    if (issuance.status === 'sent' || issuance.status === 'failed') {
      continue;
    }
    await enqueuePollPrivateIssueJob(context, {
      scopeId: claim.poll.scopeId,
      issuanceId: issuance.id,
      ...(claim.poll.groupId ? { groupId: claim.poll.groupId } : {}),
      groupWid: claim.poll.chatId,
      attempt: issuance.attempt + 1,
      runAt: new Date(activatedAt.getTime() + slot * POLL_PRIVATE_ISSUANCE_PACING_MS)
    });
    slot += 1;
  }
  const published = getPollLifecycleByRoundId(db, claim.round.id);
  if (published) await reconcilePollRoundTiming(context, claim.round.id, activatedAt);
}

function requirePrivateFanoutWindow(
  snapshot: StoredPollRoundSnapshot,
  electorateSize: number,
  activationAt: Date
): void {
  const minimumRemainingMs = Math.max(0, electorateSize - 1) * POLL_PRIVATE_ISSUANCE_PACING_MS
    + POLL_PRIVATE_MINIMUM_VOTING_WINDOW_MS;
  const closing = snapshot.poll.definition.closing;
  if (closing.kind !== 'deadline') {
    return;
  }
  const remainingMs = closing.deadline.mode === 'at'
    ? Date.parse(closing.deadline.closesAt) - activationAt.getTime()
    : closing.deadline.durationMinutes * 60_000;
  if (remainingMs < minimumRemainingMs) {
    throw new CanonicalPollPublicationError(
      `Private poll voting window must leave at least ${Math.ceil(minimumRemainingMs / 60_000)} minute(s) for paced ballot fanout and voting.`
    );
  }
}

function electorSortKey(elector: PollElector): string {
  return `${elector.voterWid}\u0000${elector.displayLabel ?? ''}`;
}

function isTerminalPublicationError(error: unknown): boolean {
  return error instanceof CanonicalPollPublicationError
    || error instanceof TransportGroupNotFoundError
    || (
      isDefinitelyNotSentTransportError(error)
      && (
        error.code === 'group_not_found'
        || error.code === 'poll_content_invalid'
        || error.code === 'send_constraint_expired'
      )
    );
}

async function persistAcceptedPublication(
  context: PluginRuntimeContext,
  claim: PollPublicationClaim,
  receipt: DoasPollReconcileOutput,
  _observedAt: Date,
  options: { deadlineAnchorAt?: string | undefined } = {}
): Promise<void> {
  const pollWaMessageId = receipt.messageId?.trim();
  const acceptedAt = receipt.acceptedAt?.trim();
  if (
    receipt.status !== 'found'
    || receipt.providerId !== 'whatsmeow'
    || !pollWaMessageId
    || !acceptedAt
    || Number.isNaN(Date.parse(acceptedAt))
  ) {
    throw new CanonicalPollPublicationError('Provider returned an invalid authoritative poll receipt.');
  }
  const persisted = markPollRoundPublished(pollsDatabase(context.databases), {
    roundId: claim.round.id,
    claimToken: claim.claimToken,
    pollWaMessageId,
    acceptedAt,
    ...(options.deadlineAnchorAt ? { deadlineAnchorAt: options.deadlineAnchorAt } : {})
  });
  if (!persisted) {
    return;
  }
  const published = getPollLifecycleByRoundId(pollsDatabase(context.databases), claim.round.id);
  if (published) await reconcilePollRoundTiming(context, claim.round.id, new Date(acceptedAt));
}

function conservativePublicationAnchor(publicationStartedAt: string, acceptedAt: string): string {
  return Date.parse(publicationStartedAt) <= Date.parse(acceptedAt)
    ? publicationStartedAt
    : acceptedAt;
}

async function persistTerminalPublicationFailure(
  context: PluginRuntimeContext,
  claim: PollPublicationClaim,
  error: unknown,
  failedAt: Date
): Promise<void> {
  const deliveryId = `poll-publication-failure:${claim.round.id}`;
  const delivery = claim.poll.presentationOwner === 'source_plugin'
    ? undefined
    : await publicationFailureDelivery(context, claim, error, deliveryId);
  const persisted = failPollRoundPublication(pollsDatabase(context.databases), {
    roundId: claim.round.id,
    claimToken: claim.claimToken,
    error: errorMessage(error),
    ...(delivery ? { delivery } : {}),
    failedAt: failedAt.toISOString()
  });
  if (persisted && delivery) {
    await enqueuePollDeliveryJob(context, {
      scopeId: claim.poll.scopeId,
      deliveryId,
      ...(claim.poll.groupId ? { groupId: claim.poll.groupId } : {}),
      groupWid: claim.poll.chatId,
      attempt: 1
    });
  }
}

async function publicationFailureDelivery(
  context: PluginRuntimeContext,
  claim: PollPublicationClaim,
  error: unknown,
  deliveryId: string
) {
  const t = await context.i18n.translatorForScope(claim.poll.scopeId);
  const messageKey = error instanceof UnconfirmedPollPublicationError
    ? 'official.poll-assistant.failure.publicationUnconfirmed'
    : PUBLICATION_FAILURE_MESSAGE_KEY;
  return {
    id: deliveryId,
    kind: 'failure' as const,
    deliveryKey: `publication-failure:${claim.round.id}:v1`,
    chatId: claim.poll.chatId,
    text: t(messageKey, {
      question: claim.poll.definition.question,
      pollId: claim.poll.id
    }),
    idempotencyKey: `poll-assistant:publication-failure:${claim.poll.id}:${claim.round.id}:v1`
  };
}

async function reschedulePublication(
  context: PluginRuntimeContext,
  claim: PollPublicationClaim,
  error: unknown,
  failedAt: Date,
  options: { resetPublicationWindow?: boolean | undefined } = {}
): Promise<void> {
  const nextAttemptAt = pollRetryAt(failedAt, claim.round.publicationAttempt);
  const reschedule = options.resetPublicationWindow
    ? resetPollRoundPublicationAfterDefiniteNonDelivery
    : reschedulePollRoundPublication;
  const persisted = reschedule(pollsDatabase(context.databases), {
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
      attempt: claim.round.publicationAttempt + 1,
      runAt: nextAttemptAt
    });
    return;
  }
  await reconcilePublicationSuccessor(context, claim.poll.id, claim.round.id);
}

async function rescheduleUncertainPublication(
  context: PluginRuntimeContext,
  claim: PollPublicationClaim,
  error: unknown,
  failedAt: Date
): Promise<void> {
  const snapshot = getPollLifecycleByRoundId(pollsDatabase(context.databases), claim.round.id);
  if (snapshot) {
    try {
      requireUnknownPublicationWindowHasNotExpired(snapshot, failedAt);
    } catch (windowError) {
      await persistTerminalPublicationFailure(context, claim, windowError, failedAt);
      return;
    }
  }
  const nextAttemptAt = pollRetryAt(failedAt, claim.round.publicationAttempt);
  const persisted = reschedulePollRoundPublicationUncertain(pollsDatabase(context.databases), {
    roundId: claim.round.id,
    claimToken: claim.claimToken,
    nextAttemptAt: nextAttemptAt.toISOString(),
    error: errorMessage(error),
    updatedAt: failedAt.toISOString()
  });
  if (!persisted) {
    await reconcilePublicationSuccessor(context, claim.poll.id, claim.round.id);
    return;
  }
  await enqueuePollPublishJob(context, {
    scopeId: claim.poll.scopeId,
    pollId: claim.poll.id,
    roundId: claim.round.id,
    ...(claim.poll.groupId ? { groupId: claim.poll.groupId } : {}),
    groupWid: claim.poll.chatId,
    attempt: claim.round.publicationAttempt + 1,
    runAt: nextAttemptAt
  });
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
      attempt: snapshot.round.finalizationAttempt + 1,
      runAt: new Date(snapshot.round.closesAt)
    });
    return;
  }
  if (snapshot.round.status === 'failed') {
    const deliveryId = `poll-publication-failure:${roundId}`;
    const delivery = getPollDelivery(pollsDatabase(context.databases), deliveryId);
    if (!delivery || delivery.status === 'sent') {
      return;
    }
    await enqueuePollDeliveryJob(context, {
      scopeId: snapshot.poll.scopeId,
      deliveryId,
      ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
      groupWid: snapshot.poll.chatId,
      attempt: delivery.attempt + 1
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
