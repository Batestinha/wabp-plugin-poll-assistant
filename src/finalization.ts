import { createHash, randomUUID } from 'node:crypto';
import type { PluginRuntimeContext } from './runtime';
import { mapAuthoritativePollReadback } from './authoritativeReadback';
import type { PollBallotMappingTarget } from './ballotMapping';
import type { PollReadbackBallot } from './domain';
import type { PollAssistantLifecycleSnapshot } from './lifecycleServiceApi';
import { parsePollAssistantConfig } from './config';
import {
  DOAS_PRIVATE_POLL_RECONCILE_METHOD,
  DOAS_PRIVATE_POLL_SERVICE_ID,
  doasPrivatePollReconcileInputSchema,
  type DoasPrivatePollReconcileOutput
} from './contracts/doas-poll-v1';
import { enqueuePollDeliveryJob, enqueuePollFinalizeJob, pollRetryAt } from './jobs';
import { calculatePollResult } from './resultCalculator';
import { renderPollResultMessages } from './resultRendering';
import { deliverPollRandomDrawAudit } from './randomDrawAudit';
import { deliverPollPrivatePublicationAudit } from './privatePublicationAudit';
import {
  POLL_FINALIZATION_LEASE_MS,
  claimPollRoundFinalization,
  completePollRoundFinalization,
  createPollResultInputSha256,
  getPollAggregate,
  getPollDelivery,
  getPollLifecycleByRoundId,
  getPollPrivateIssuance,
  listPollPrivateIssuancesByRound,
  pollsDatabase,
  reconcilePollPrivateIssuanceAtCutoff,
  replacePollBallotsFromAuthoritativeReadback,
  renewPollRoundFinalizationClaim,
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
    renewFinalizationClaim(db, claim, clock());
    if (snapshot.poll.definition.ballotDelivery === 'private') {
      await reconcilePrivatePollIssuancesAtCutoff(
        context,
        snapshot,
        claim,
        () => renewFinalizationClaim(db, claim, clock()),
        clock
      );
    }
    const aggregate = getPollAggregate(db, claim.poll.id);
    if (!aggregate || !snapshot.round.electorateCapturedAt) {
      throw new Error('Poll finalization requires a captured electorate.');
    }
    const electorateWidByIdentityId = new Map(aggregate.electorate.map((elector) => [
      elector.voterIdentityId,
      elector.voterWid
    ]));
    const readbackBallots = snapshot.poll.definition.ballotDelivery === 'private'
      ? await readPrivatePollBallots(
          context,
          snapshot,
          cutoffAt,
          electorateWidByIdentityId,
          () => renewFinalizationClaim(db, claim, clock())
        )
      : await readGroupPollBallots(
          context,
          snapshot,
          cutoffAt,
          electorateWidByIdentityId,
          () => renewFinalizationClaim(db, claim, clock())
        );
    const readAt = clock();
    renewFinalizationClaim(db, claim, readAt);
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
    const completedAt = clock();
    const lifecycleSnapshot = claim.poll.sourceLifecycleKind === 'survey'
      ? sourceSurveySnapshot(claim, readbackBallots, cutoffAt, completedAt)
      : undefined;
    const deliveries = claim.poll.presentationOwner === 'source_plugin'
      ? []
      : await resultDeliveries({
          context,
          claim,
          roundId,
          result,
          ballots,
          electorate: aggregate.electorate,
          cutoffAt,
          completedAt
        });
    renewFinalizationClaim(db, claim, completedAt);
    const completed = completePollRoundFinalization(db, {
      roundId,
      claimToken: claim.claimToken,
      result,
      inputSha256,
      readbackSource: 'transport_readback',
      ...(deliveries[0] ? { delivery: deliveries[0] } : {}),
      additionalDeliveries: deliveries.slice(1),
      ...(lifecycleSnapshot ? { lifecycleSnapshot } : {}),
      completedAt: completedAt.toISOString()
    });
    if (completed === 'completed' || completed === 'already_completed') {
      try {
        await deliverPollRandomDrawAudit(context, roundId, clock);
      } catch (error) {
        context.logger.warn({ error, pollId: claim.poll.id, roundId }, 'Random-draw audit delivery deferred');
      }
      for (const [index, delivery] of deliveries.entries()) {
        if (index > 0) {
          continue;
        }
        const stored = getPollDelivery(db, delivery.id);
        if (!stored || stored.status === 'sent') {
          continue;
        }
        await enqueuePollDeliveryJob(context, {
          scopeId: claim.poll.scopeId,
          deliveryId: delivery.id,
          ...(claim.poll.groupId ? { groupId: claim.poll.groupId } : {}),
          groupWid: claim.poll.chatId,
          attempt: stored.attempt + 1
        });
      }
    }
  } catch (error) {
    await rescheduleFinalization(context, claim, error, clock());
  }
}

async function resultDeliveries(input: {
  context: PluginRuntimeContext;
  claim: PollFinalizationClaim;
  roundId: string;
  result: Parameters<typeof renderPollResultMessages>[0]['result'];
  ballots: Parameters<typeof renderPollResultMessages>[0]['ballots'];
  electorate: Parameters<typeof renderPollResultMessages>[0]['electorate'];
  cutoffAt: Date;
  completedAt: Date;
}) {
  const [t, localeResolution, configInput] = await Promise.all([
    input.context.i18n.translatorForScope(input.claim.poll.scopeId),
    input.context.i18n.resolveScopeLocale(input.claim.poll.scopeId),
    input.context.configFor(input.claim.poll.scopeId)
  ]);
  const config = parsePollAssistantConfig(configInput);
  const cutoffAtLabel = formatTimestamp(input.cutoffAt, config.timezone, localeResolution.locale);
  const resultMessages = renderPollResultMessages({
    definition: input.claim.poll.definition,
    result: input.result,
    ballots: input.ballots,
    electorate: input.electorate,
    cutoffAtLabel,
    timezone: config.timezone,
    templates: config.messages,
    locale: localeResolution.locale,
    t
  });
  const deliveryId = `poll-result:${input.roundId}`;
  return resultMessages.map((text, index) => ({
    id: index === 0 ? deliveryId : `${deliveryId}:page:${index + 1}`,
    kind: index === 0 && input.result.purpose === 'decide' && input.result.outcome.status === 'tie'
      ? 'tie' as const
      : 'result' as const,
    deliveryKey: index === 0
      ? `result:${input.roundId}:v1`
      : `result:${input.roundId}:page:${index + 1}:v1`,
    chatId: input.claim.poll.chatId,
    text,
    idempotencyKey: index === 0
      ? `poll-assistant:result:${input.claim.poll.id}:${input.roundId}:v1`
      : `poll-assistant:result:${input.claim.poll.id}:${input.roundId}:page:${index + 1}:v1`,
    deliveryBatchKey: `poll-result:${input.roundId}`,
    deliverySequence: index,
    ...(index > 0
      ? { notBefore: new Date(input.completedAt.getTime() + index * 2_000).toISOString() }
      : {})
  }));
}

function sourceSurveySnapshot(
  claim: PollFinalizationClaim,
  ballots: readonly PollReadbackBallot[],
  cutoffAt: Date,
  completedAt: Date
): PollAssistantLifecycleSnapshot {
  const source = claim.poll.source;
  const pollWaMessageId = claim.round.pollWaMessageId;
  if (!source || !pollWaMessageId) {
    throw new Error('Source survey finalization has no immutable source or publication reference.');
  }
  return {
    schemaVersion: 1,
    sourcePluginId: source.pluginId,
    sourceIdempotencyKey: source.idempotencyKey,
    groupWid: claim.poll.chatId,
    pollId: claim.poll.id,
    roundId: claim.round.id,
    pollWaMessageId,
    cutoffAt: cutoffAt.toISOString(),
    finalizedAt: completedAt.toISOString(),
    ballots: [...ballots]
      .sort((left, right) => left.voterIdentityId.localeCompare(right.voterIdentityId))
      .map((ballot) => {
        if (!ballot.sourceWaMessageId || !ballot.receivedAt) {
          throw new Error('Source survey readback lacks an immutable source or receipt timestamp.');
        }
        return {
          voterIdentityId: ballot.voterIdentityId,
          voterWid: ballot.voterWid,
          selectedOptionIds: [...ballot.selectedOptionIds],
          sourceWaMessageId: ballot.sourceWaMessageId,
          interactedAt: ballot.interactedAt,
          receivedAt: ballot.receivedAt
        };
      })
  };
}

async function reconcilePrivatePollIssuancesAtCutoff(
  context: PluginRuntimeContext,
  snapshot: StoredPollRoundSnapshot,
  claim: PollFinalizationClaim,
  renewClaim: () => void,
  clock: () => Date
): Promise<void> {
  const db = pollsDatabase(context.databases);
  for (const issuance of listPollPrivateIssuancesByRound(db, snapshot.round.id)) {
    if (issuance.status === 'sent') {
      if (!issuance.pollWaMessageId) {
        throw new Error(`Private poll issuance ${issuance.id} is sent without a message id.`);
      }
      continue;
    }
    if (issuance.status === 'failed') {
      continue;
    }
    const observedAt = clock();
    if (
      issuance.status === 'publishing'
      && issuance.leaseExpiresAt
      && Date.parse(issuance.leaseExpiresAt) > observedAt.getTime()
    ) {
      throw new Error(`Private poll issuance ${issuance.id} is still being published at cutoff.`);
    }

    if (!issuance.publicationStartedAt) {
      renewClaim();
      const settled = reconcilePollPrivateIssuanceAtCutoff(db, {
        roundId: snapshot.round.id,
        finalizationClaimToken: claim.claimToken,
        issuanceId: issuance.id,
        resolution: 'absent',
        reconciledAt: observedAt.toISOString()
      });
      if (!settled && !isTerminalPrivateIssuance(db, issuance.id)) {
        throw new Error(`Private poll issuance ${issuance.id} changed during cutoff settlement.`);
      }
      continue;
    }

    if (!context.services) {
      throw new Error('Private poll receipt reconciliation service is unavailable.');
    }
    renewClaim();
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
    if (receipt.status === 'unknown') {
      throw new Error(`Private poll issuance ${issuance.id} still has an unknown provider outcome.`);
    }
    const reconciledAt = clock();
    renewClaim();
    const settled = reconcilePollPrivateIssuanceAtCutoff(db, {
      roundId: snapshot.round.id,
      finalizationClaimToken: claim.claimToken,
      issuanceId: issuance.id,
      resolution: receipt.status,
      ...(receipt.messageId ? { pollWaMessageId: receipt.messageId } : {}),
      ...(receipt.remoteChatId ? { remoteChatId: receipt.remoteChatId } : {}),
      ...(receipt.acceptedAt ? { acceptedAt: receipt.acceptedAt } : {}),
      reconciledAt: reconciledAt.toISOString()
    });
    if (!settled && !isTerminalPrivateIssuance(db, issuance.id)) {
      throw new Error(`Private poll issuance ${issuance.id} changed during receipt reconciliation.`);
    }
    if (receipt.status === 'found') {
      try {
        await deliverPollPrivatePublicationAudit(context, issuance.id, clock);
      } catch (error) {
        context.logger.warn(
          { error, issuanceId: issuance.id },
          'official.poll-assistant private publication audit delivery deferred'
        );
      }
    }
  }
}

function isTerminalPrivateIssuance(
  db: ReturnType<typeof pollsDatabase>,
  issuanceId: string
): boolean {
  const issuance = getPollPrivateIssuance(db, issuanceId);
  return issuance?.status === 'sent' || issuance?.status === 'failed';
}

function formatTimestamp(value: Date, timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: timezone
  }).format(value);
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
    || (
      snapshot.poll.definition.ballotDelivery === 'group'
      && !snapshot.round.pollWaMessageId
    )
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

function mappingTarget(
  snapshot: StoredPollRoundSnapshot,
  pollWaMessageId: string
): PollBallotMappingTarget {
  return {
    roundId: snapshot.round.id,
    pollWaMessageId,
    allowMultipleAnswers: snapshot.round.allowMultipleAnswers,
    options: snapshot.options.map((option) => ({
      optionId: option.optionId,
      ordinal: option.ordinal,
      wireLabel: option.wireLabel
    }))
  };
}

async function readGroupPollBallots(
  context: PluginRuntimeContext,
  snapshot: StoredPollRoundSnapshot,
  cutoffAt: Date,
  electorateWidByIdentityId: ReadonlyMap<string, string>,
  renewClaim: () => void
) {
  const pollWaMessageId = snapshot.round.pollWaMessageId!;
  renewClaim();
  const readback = await context.pollVoteReadbackFor!(pollWaMessageId, { asOf: cutoffAt });
  return mapAuthoritativePollReadback({
    readback,
    target: mappingTarget(snapshot, pollWaMessageId),
    cutoffAt,
    electorateWidByIdentityId,
    resolveIdentityAddress: context.resolveIdentityAddress!
  });
}

async function readPrivatePollBallots(
  context: PluginRuntimeContext,
  snapshot: StoredPollRoundSnapshot,
  cutoffAt: Date,
  electorateWidByIdentityId: ReadonlyMap<string, string>,
  renewClaim: () => void
) {
  const issuances = listPollPrivateIssuancesByRound(
    pollsDatabase(context.databases),
    snapshot.round.id
  ).filter((issuance) =>
    issuance.status === 'sent'
    && issuance.pollWaMessageId
    && electorateWidByIdentityId.has(issuance.voterIdentityId));
  const ballots: PollReadbackBallot[] = [];
  for (const issuance of issuances) {
    const pollWaMessageId = issuance.pollWaMessageId!;
    renewClaim();
    const readback = await context.pollVoteReadbackFor!(pollWaMessageId, { asOf: cutoffAt });
    const mapped = await mapAuthoritativePollReadback({
      readback,
      target: mappingTarget(snapshot, pollWaMessageId),
      cutoffAt,
      electorateWidByIdentityId,
      resolveIdentityAddress: context.resolveIdentityAddress!
    });
    if (mapped.some((ballot) => ballot.voterIdentityId !== issuance.voterIdentityId)) {
      throw new Error('Authoritative private poll readback returned a ballot for another elector.');
    }
    ballots.push(...mapped);
  }
  return ballots;
}

function renewFinalizationClaim(
  db: ReturnType<typeof pollsDatabase>,
  claim: PollFinalizationClaim,
  renewedAt: Date
): void {
  const renewed = renewPollRoundFinalizationClaim(db, {
    roundId: claim.round.id,
    claimToken: claim.claimToken,
    now: renewedAt.toISOString(),
    leaseExpiresAt: new Date(renewedAt.getTime() + POLL_FINALIZATION_LEASE_MS).toISOString()
  });
  if (!renewed) {
    throw new Error(`Finalization claim for poll round ${claim.round.id} expired during readback.`);
  }
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
      attempt: claim.round.finalizationAttempt + 1,
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
    const deliveryId = `poll-result:${roundId}`;
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
