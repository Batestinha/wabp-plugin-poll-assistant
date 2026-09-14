import { createHash } from 'node:crypto';
import { registerPollCreateAction } from './createAction';
import type { PluginServiceRegistration } from '@wabs/plugin-sdk/services';
import { type PluginServiceRegistrationContext } from './runtime';
import { parsePollAssistantConfig } from './config';
import { pollAllowsMultipleAnswers, type PollBallot } from './domain';
import { enqueuePollDeliveryJob, enqueuePollPublishJob } from './jobs';
import { calculatePollResult } from './resultCalculator';
import { renderPollResultMessages, renderPollResultDeliveries } from './resultRendering';
import {
  POLL_ASSISTANT_AUTOMATION_SERVICE_ID,
  POLL_ASSISTANT_CANCEL_POLL_METHOD,
  POLL_ASSISTANT_ENSURE_POLL_METHOD,
  POLL_ASSISTANT_RESOLVE_OUTCOME_METHOD,
  POLL_ASSISTANT_RESOLVE_POLL_METHOD,
  pollAssistantCancelPollInputSchema,
  pollAssistantCancelPollOutputSchema,
  pollAssistantEnsurePollInputSchema,
  pollAssistantEnsurePollOutputSchema,
  pollAssistantResolveOutcomeInputSchema,
  pollAssistantResolveOutcomeOutputSchema,
  pollAssistantResolvePollInputSchema,
  pollAssistantResolvePollOutputSchema,
  type PollAssistantCancelPollInput,
  type PollAssistantCancelPollOutput,
  type PollAssistantEnsurePollInput,
  type PollAssistantEnsurePollOutput,
  type PollAssistantResolveOutcomeInput,
  type PollAssistantResolveOutcomeOutput,
  type PollAssistantResolvePollInput,
  type PollAssistantResolvePollOutput,
  type PollAssistantResolvedOutcome
} from './serviceApi';
import {
  PollActiveLimitReachedError,
  cancelPoll,
  completeActorPollOutcome,
  createPoll,
  createPollResultInputSha256,
  getPollAggregateBySource,
  getPollAutomationAction,
  getPollDelivery,
  getPollResult,
  pollsDatabase,
  recordPollAutomationAction,
  type StoredPollAggregate
} from './store';
import {
  pollAssistantAutomationPolicySnapshotSchema,
  pollAssistantPolicyNotBefore
} from './workingHours';
import { registerPollAssistantLifecycleService } from './lifecycleService';

export function registerPollAssistantServices(
  context: PluginServiceRegistrationContext
): PluginServiceRegistration[] {
  return [{
    serviceId: POLL_ASSISTANT_AUTOMATION_SERVICE_ID,
    methods: [
      {
        name: POLL_ASSISTANT_ENSURE_POLL_METHOD,
        access: 'mutation',
        inputSchema: pollAssistantEnsurePollInputSchema,
        outputSchema: pollAssistantEnsurePollOutputSchema,
        async handler(rawInput, call) {
          return ensureAutomatedPoll(
            context,
            rawInput as PollAssistantEnsurePollInput,
            call
          );
        }
      },
      {
        name: POLL_ASSISTANT_RESOLVE_POLL_METHOD,
        access: 'read',
        inputSchema: pollAssistantResolvePollInputSchema,
        outputSchema: pollAssistantResolvePollOutputSchema,
        handler(rawInput, call) {
          return resolveAutomatedPoll(
            context,
            rawInput as PollAssistantResolvePollInput,
            call
          );
        }
      },
      {
        name: POLL_ASSISTANT_RESOLVE_OUTCOME_METHOD,
        access: 'mutation',
        inputSchema: pollAssistantResolveOutcomeInputSchema,
        outputSchema: pollAssistantResolveOutcomeOutputSchema,
        async handler(rawInput, call) {
          return resolveActorOutcome(
            context,
            rawInput as PollAssistantResolveOutcomeInput,
            call
          );
        }
      },
      {
        name: POLL_ASSISTANT_CANCEL_POLL_METHOD,
        access: 'mutation',
        inputSchema: pollAssistantCancelPollInputSchema,
        outputSchema: pollAssistantCancelPollOutputSchema,
        async handler(rawInput, call) {
          return cancelAutomatedPoll(
            context,
            rawInput as PollAssistantCancelPollInput,
            call
          );
        }
      }
    ]
  }, registerPollAssistantLifecycleService(context), registerPollCreateAction(context)];
}

async function ensureAutomatedPoll(
  context: PluginServiceRegistrationContext,
  input: PollAssistantEnsurePollInput,
  call: Parameters<PluginServiceRegistration['methods'][number]['handler']>[1]
): Promise<PollAssistantEnsurePollOutput> {
  assertGroupContext(input.groupWid, call.groupWid);
  const actor = requireOrganizer(call.actorIdentityId, call.actorWid);
  const definition = input.definition;
  const bypassWorkingHours = input.bypassWorkingHours ?? false;
  const requestSha256 = digestJson({
    groupWid: input.groupWid,
    organizerIdentityId: actor.identityId,
    definition,
    workingHoursTimezone: input.workingHoursTimezone,
    bypassWorkingHours
  });
  const legacyRequestSha256 = input.workingHoursTimezone
    ? digestJson({
        groupWid: input.groupWid,
        organizerIdentityId: actor.identityId,
        definition,
        bypassWorkingHours
      })
    : undefined;
  const db = pollsDatabase(context.databases);
  const existing = getPollAggregateBySource(db, {
    scopeId: call.scopeId,
    sourcePluginId: call.callerPluginId,
    sourceIdempotencyKey: input.sourceIdempotencyKey
  });
  if (existing) {
    assertExistingAutomationInput(
      existing,
      input.groupWid,
      actor.identityId,
      requestSha256,
      legacyRequestSha256
    );
    return pollAssistantEnsurePollOutputSchema.parse(automationEnvelope(existing, 'existing'));
  }
  if (!await context.enabledFor(call.scopeId)) {
    throw new Error('official.poll-assistant is disabled for this scope.');
  }
  const config = parsePollAssistantConfig(await context.configFor(call.scopeId, actor.identityId));
  if (!config.allowCreation) {
    throw new Error('Automated poll creation is disabled for this scope.');
  }
  const digest = digestJson({
    scopeId: call.scopeId,
    sourcePluginId: call.callerPluginId,
    sourceIdempotencyKey: input.sourceIdempotencyKey
  });
  const roundId = `poll-round:${digest}`;
  const publishIdempotencyKey = `poll-assistant:auto:${digest}`;
  const createdAt = new Date().toISOString();
  const automationPolicy = pollAssistantAutomationPolicySnapshotSchema.parse({
    timezone: input.workingHoursTimezone ?? config.timezone,
    workingHours: config.automationWorkingHours,
    bypassWorkingHours
  });
  const publicationNotBefore = pollAssistantPolicyNotBefore(
    new Date(createdAt),
    automationPolicy
  );
  const firstResponseClosing = definition.closing.kind === 'deadline'
    && definition.closing.deadline.mode === 'after_first_non_creator_response'
    ? definition.closing.deadline
    : undefined;
  if (
    firstResponseClosing?.activationCutoffAt
    && publicationNotBefore.getTime() > Date.parse(firstResponseClosing.activationCutoffAt)
  ) {
    throw new Error('The next allowed Poll Assistant working window starts after the lifecycle activation cutoff.');
  }
  const creatorLabel = await organizerLabel(context, actor.wid, actor.identityId);
  let aggregate: StoredPollAggregate;
  try {
    aggregate = createPoll(db, {
      definition,
      scopeId: call.scopeId,
      chatId: input.groupWid,
      ...(call.groupId ? { groupId: call.groupId } : {}),
      creatorIdentityId: actor.identityId,
      creatorWid: actor.wid,
      creatorLabel,
      roundId,
      publishIdempotencyKey,
      source: {
        pluginId: call.callerPluginId,
        idempotencyKey: input.sourceIdempotencyKey,
        requestSha256
      },
      sourceLifecycleKind: 'automation',
      automationPolicy,
      maxActivePollsPerChat: config.maxActivePollsPerChat,
      createdAt
    });
  } catch (error) {
    if (!(error instanceof PollActiveLimitReachedError)) {
      throw error;
    }
    throw new Error('The target group has reached its active Poll Assistant limit.');
  }
  const round = aggregate.rounds[0]!;
  await enqueuePollPublishJob(context, {
    scopeId: aggregate.poll.scopeId,
    pollId: aggregate.poll.id,
    roundId: round.id,
    ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
    groupWid: aggregate.poll.chatId,
    attempt: round.publicationAttempt + 1,
    runAt: new Date(round.publicationNotBefore)
  });
  await context.audit.record({
    actorIdentityId: actor.identityId,
    scopeId: call.scopeId,
    ...(call.groupId ? { groupId: call.groupId } : {}),
    action: 'poll-assistant.automation.ensured',
    targetJson: {
      pollId: aggregate.poll.id,
      roundId: round.id,
      groupWid: aggregate.poll.chatId
    },
    metadataJson: {
      sourcePluginId: call.callerPluginId,
      sourceIdempotencyKey: input.sourceIdempotencyKey,
      ballotDelivery: definition.ballotDelivery,
      voterDisclosure: definition.voterDisclosure,
      electorateKind: definition.electorate.kind,
      bypassWorkingHours: automationPolicy.bypassWorkingHours,
      workingHoursTimezone: automationPolicy.timezone,
      publicationNotBefore: round.publicationNotBefore
    }
  });
  return pollAssistantEnsurePollOutputSchema.parse(automationEnvelope(aggregate, 'created'));
}

function resolveAutomatedPoll(
  context: PluginServiceRegistrationContext,
  input: PollAssistantResolvePollInput,
  call: Parameters<PluginServiceRegistration['methods'][number]['handler']>[1]
): PollAssistantResolvePollOutput {
  assertGroupContext(input.groupWid, call.groupWid);
  const aggregate = getPollAggregateBySource(pollsDatabase(context.databases), {
    scopeId: call.scopeId,
    sourcePluginId: call.callerPluginId,
    sourceIdempotencyKey: input.sourceIdempotencyKey
  });
  if (!aggregate) {
    return { kind: 'unavailable', reason: 'not_found' };
  }
  if (normalizeWid(aggregate.poll.chatId) !== normalizeWid(input.groupWid)) {
    return { kind: 'unavailable', reason: 'wrong_group' };
  }
  return pollAssistantResolvePollOutputSchema.parse({
    ...automationEnvelope(aggregate, 'found'),
    outcome: resolvedOutcome(context, aggregate)
  });
}

async function resolveActorOutcome(
  context: PluginServiceRegistrationContext,
  input: PollAssistantResolveOutcomeInput,
  call: Parameters<PluginServiceRegistration['methods'][number]['handler']>[1]
): Promise<PollAssistantResolveOutcomeOutput> {
  assertGroupContext(input.groupWid, call.groupWid);
  const actor = requireOrganizer(call.actorIdentityId, call.actorWid);
  const db = pollsDatabase(context.databases);
  const aggregate = requireOwnedAutomationPoll(context, input, call, actor.identityId);
  if (aggregate.poll.definition.electorate.kind !== 'actor') {
    throw new Error('Only actor-electorate polls support direct outcome resolution.');
  }
  const actionRequestSha256 = digestJson(input);
  const existingAction = getPollAutomationAction<PollAssistantResolveOutcomeOutput>(db, {
    pollId: aggregate.poll.id,
    kind: 'resolve_outcome'
  });
  if (existingAction) {
    assertActionReplay(existingAction, input.resolutionIdempotencyKey, actionRequestSha256);
    return pollAssistantResolveOutcomeOutputSchema.parse({
      ...existingAction.response,
      kind: 'existing'
    });
  }
  const optionIds = new Set(aggregate.poll.definition.options.map((option) => option.id));
  if (input.selectedOptionIds.some((optionId) => !optionIds.has(optionId))) {
    throw new Error('Actor outcome contains an unknown option id.');
  }
  if (!pollAllowsMultipleAnswers(aggregate.poll.definition) && input.selectedOptionIds.length !== 1) {
    throw new Error('Actor outcome must select exactly one option.');
  }
  const round = aggregate.rounds.at(-1)!;
  const completedAt = new Date();
  const ballot: PollBallot = {
    roundId: round.id,
    voterIdentityId: actor.identityId,
    voterWid: actor.wid,
    selectedOptionIds: input.selectedOptionIds,
    source: { kind: 'service_resolution', resolutionId: input.resolutionIdempotencyKey },
    interactedAt: completedAt.toISOString()
  };
  const result = calculatePollResult({
    definition: aggregate.poll.definition,
    roundId: round.id,
    electorateIdentityIds: [actor.identityId],
    ballots: [ballot],
    cutoffAt: completedAt.toISOString(),
    computedAt: completedAt.toISOString()
  });
  if (result.purpose !== 'decide' || result.outcome.status !== 'selected') {
    throw new Error('Actor outcome did not produce a final decision.');
  }
  const response: PollAssistantResolveOutcomeOutput = {
    kind: 'resolved',
    pollId: aggregate.poll.id,
    roundId: round.id,
    selectedOptionIds: result.outcome.selectedOptionIds,
    resolvedAt: completedAt.toISOString()
  };
  const [t, localeResolution, configInput] = await Promise.all([
    context.i18n.translatorForScope(aggregate.poll.scopeId),
    context.i18n.resolveScopeLocale(aggregate.poll.scopeId),
    context.configFor(aggregate.poll.scopeId, actor.identityId)
  ]);
  const config = parsePollAssistantConfig(configInput);
  const deliveryId = `poll-result:${round.id}`;
  const messages = await renderPollResultDeliveries({
        definition: aggregate.poll.definition,
        result,
        ballots: [ballot],
        electorate: aggregate.electorate.length > 0
          ? aggregate.electorate
          : [{
              voterIdentityId: actor.identityId,
              voterWid: actor.wid,
              ...(aggregate.poll.creatorLabel.trim()
                ? { displayLabel: aggregate.poll.creatorLabel.trim() }
                : {})
            }],
        cutoffAtLabel: new Intl.DateTimeFormat(localeResolution.locale, {
          dateStyle: 'medium',
          timeStyle: 'medium',
          timeZone: config.timezone
        }).format(completedAt),
        timezone: config.timezone,
        templates: config.messages,
        locale: localeResolution.locale,
        t
      }, context, aggregate.poll);
  const deliveries = messages.map((message, index) => ({
    id: index === 0 ? deliveryId : `${deliveryId}:page:${index + 1}`, kind: 'result' as const,
    deliveryKey: index === 0 ? `result:${round.id}:v1` : `result:${round.id}:page:${index + 1}:v1`,
    chatId: aggregate.poll.chatId, ...message,
    idempotencyKey: index === 0 ? `poll-assistant:result:${aggregate.poll.id}:${round.id}:v1` : `poll-assistant:result:${aggregate.poll.id}:${round.id}:page:${index + 1}:v1`,
    deliveryBatchKey: deliveryId, deliverySequence: index,
    ...(index ? { notBefore: new Date(completedAt.getTime() + index * 2_000).toISOString() } : {})
  }));
  const completion = completeActorPollOutcome(db, {
    pollId: aggregate.poll.id,
    result,
    inputSha256: createPollResultInputSha256({
      definition: aggregate.poll.definition,
      electorateIdentityIds: [actor.identityId],
      ballots: [ballot],
      cutoffAt: completedAt.toISOString()
    }),
    actionIdempotencyKey: input.resolutionIdempotencyKey,
    actionRequestSha256,
    actionResponse: response,
    delivery: deliveries[0]!,
    additionalDeliveries: deliveries.slice(1),
    completedAt: completedAt.toISOString()
  });
  if (completion === 'completed') {
    await enqueuePollDeliveryJob(context, {
      scopeId: aggregate.poll.scopeId,
      deliveryId,
      ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
      groupWid: aggregate.poll.chatId,
      attempt: 1
    });
  }
  return pollAssistantResolveOutcomeOutputSchema.parse({
    ...response,
    kind: completion === 'completed' ? 'resolved' : 'existing'
  });
}

async function cancelAutomatedPoll(
  context: PluginServiceRegistrationContext,
  input: PollAssistantCancelPollInput,
  call: Parameters<PluginServiceRegistration['methods'][number]['handler']>[1]
): Promise<PollAssistantCancelPollOutput> {
  assertGroupContext(input.groupWid, call.groupWid);
  const actor = requireOrganizer(call.actorIdentityId, call.actorWid);
  const db = pollsDatabase(context.databases);
  const aggregate = requireOwnedAutomationPoll(context, input, call, actor.identityId);
  const actionRequestSha256 = digestJson(input);
  const existingAction = getPollAutomationAction<PollAssistantCancelPollOutput>(db, {
    pollId: aggregate.poll.id,
    kind: 'cancel'
  });
  if (existingAction) {
    assertActionReplay(existingAction, input.cancellationIdempotencyKey, actionRequestSha256);
    return pollAssistantCancelPollOutputSchema.parse({
      ...existingAction.response,
      kind: 'existing'
    });
  }
  const cancelledAt = aggregate.poll.cancelledAt ?? new Date().toISOString();
  if (aggregate.poll.status !== 'cancelled') {
    const round = aggregate.rounds.at(-1)!;
    const t = await context.i18n.translatorForScope(aggregate.poll.scopeId);
    const deliveryId = `poll-assistant:cancel:${aggregate.poll.id}`;
    const cancelled = cancelPoll(db, {
      pollId: aggregate.poll.id,
      cancelledByIdentityId: actor.identityId,
      cancelledByWid: actor.wid,
      ...(input.reason ? { reason: input.reason } : {}),
      delivery: {
        id: deliveryId,
        kind: 'cancelled',
        deliveryKey: deliveryId,
        chatId: aggregate.poll.chatId,
        text: t('official.poll-assistant.delivery.cancelled', {
          question: aggregate.poll.definition.question,
          pollId: aggregate.poll.id
        }),
        idempotencyKey: deliveryId
      },
      cancelledAt
    });
    if (!cancelled) {
      throw new Error('Automated poll cannot be cancelled in its current state.');
    }
    const delivery = getPollDelivery(db, deliveryId);
    if (delivery) {
      await enqueuePollDeliveryJob(context, {
        scopeId: aggregate.poll.scopeId,
        deliveryId,
        ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
        groupWid: aggregate.poll.chatId,
        attempt: delivery.attempt + 1
      });
    }
  }
  const response: PollAssistantCancelPollOutput = {
    kind: aggregate.poll.status === 'cancelled' ? 'existing' : 'cancelled',
    pollId: aggregate.poll.id,
    cancelledAt
  };
  recordPollAutomationAction(db, {
    pollId: aggregate.poll.id,
    kind: 'cancel',
    idempotencyKey: input.cancellationIdempotencyKey,
    requestSha256: actionRequestSha256,
    response,
    createdAt: cancelledAt
  });
  return pollAssistantCancelPollOutputSchema.parse(response);
}

function requireOwnedAutomationPoll(
  context: PluginServiceRegistrationContext,
  input: { groupWid: string; sourceIdempotencyKey: string },
  call: Parameters<PluginServiceRegistration['methods'][number]['handler']>[1],
  actorIdentityId: string
): StoredPollAggregate {
  const aggregate = getPollAggregateBySource(pollsDatabase(context.databases), {
    scopeId: call.scopeId,
    sourcePluginId: call.callerPluginId,
    sourceIdempotencyKey: input.sourceIdempotencyKey
  });
  if (!aggregate) {
    throw new Error('No Poll Assistant lifecycle exists for this source idempotency key.');
  }
  if (normalizeWid(aggregate.poll.chatId) !== normalizeWid(input.groupWid)) {
    throw new Error('The Poll Assistant lifecycle belongs to another group.');
  }
  if (aggregate.poll.creatorIdentityId !== actorIdentityId) {
    throw new Error('Only the authoritative poll organizer may mutate this lifecycle.');
  }
  return aggregate;
}

function automationEnvelope(
  aggregate: StoredPollAggregate,
  kind: 'created' | 'existing' | 'found'
) {
  const round = aggregate.rounds.at(-1)!;
  const workingHoursPolicy = aggregate.poll.automationPolicy
    ?? pollAssistantAutomationPolicySnapshotSchema.parse({
      timezone: 'UTC',
      workingHours: {},
      bypassWorkingHours: true
    });
  return {
    kind,
    sourcePluginId: aggregate.poll.source!.pluginId,
    sourceIdempotencyKey: aggregate.poll.source!.idempotencyKey,
    organizerIdentityId: aggregate.poll.creatorIdentityId,
    groupWid: aggregate.poll.chatId,
    pollId: aggregate.poll.id,
    roundId: round.id,
    pollStatus: aggregate.poll.status,
    roundStatus: round.status,
    ballotDelivery: aggregate.poll.definition.ballotDelivery,
    voterDisclosure: aggregate.poll.definition.voterDisclosure,
    electorate: aggregate.poll.definition.electorate,
    publicationNotBefore: round.publicationNotBefore,
    activationDeadlineAt: round.activationDeadlineAt ?? null,
    activatedAt: round.activatedAt ?? null,
    closesAt: round.closesAt ?? null,
    workingHoursPolicy,
    workingHoursOverrideAt: round.workingHoursOverrideAt ?? null,
    options: [...aggregate.poll.definition.options]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((option) => ({ id: option.id, label: option.label, ordinal: option.ordinal }))
  };
}

function resolvedOutcome(
  context: PluginServiceRegistrationContext,
  aggregate: StoredPollAggregate
): PollAssistantResolvedOutcome {
  const round = aggregate.rounds.at(-1)!;
  if (aggregate.poll.status === 'cancelled') {
    return { kind: 'cancelled' };
  }
  if (aggregate.poll.status === 'failed' || round.status === 'failed') {
    return { kind: 'failed' };
  }
  const result = getPollResult(pollsDatabase(context.databases), round.id);
  if (result?.purpose === 'decide') {
    if (result.responseCount === 0) {
      return {
        kind: 'no_response',
        tallies: result.tallies,
        eligibleCount: result.eligibleCount
      };
    }
    if (result.outcome.status === 'selected') {
      return {
        kind: 'decided',
        selectedOptionIds: result.outcome.selectedOptionIds,
        tallies: result.tallies,
        eligibleCount: result.eligibleCount,
        responseCount: result.responseCount
      };
    }
    return {
      kind: 'undecided',
      reason: result.outcome.status === 'quorum_not_met'
        ? 'quorum_not_met'
        : result.outcome.status === 'tie'
          ? 'tie'
          : 'no_decision',
      tallies: result.tallies,
      eligibleCount: result.eligibleCount,
      responseCount: result.responseCount
    };
  }
  if (round.status === 'open') {
    return { kind: 'open' };
  }
  return {
    kind: 'not_finalized',
    reason: ['publish_pending', 'publishing', 'finalizing', 'tie_pending'].includes(round.status)
      ? round.status
      : 'finalizing'
  } as PollAssistantResolvedOutcome;
}

function assertExistingAutomationInput(
  aggregate: StoredPollAggregate,
  groupWid: string,
  organizerIdentityId: string,
  requestSha256: string,
  legacyRequestSha256?: string
): void {
  const storedRequestSha256 = aggregate.poll.source?.requestSha256;
  if (
    normalizeWid(aggregate.poll.chatId) !== normalizeWid(groupWid)
    || aggregate.poll.creatorIdentityId !== organizerIdentityId
    || (
      storedRequestSha256 !== requestSha256
      && storedRequestSha256 !== legacyRequestSha256
    )
  ) {
    throw new Error('Source idempotency key is already bound to different canonical poll input.');
  }
}

function assertGroupContext(inputGroupWid: string, contextGroupWid: string | undefined): void {
  if (!contextGroupWid || normalizeWid(contextGroupWid) !== normalizeWid(inputGroupWid)) {
    throw new Error('Poll Assistant automation requires an exact authorized target group.');
  }
}

function requireOrganizer(
  actorIdentityId: string | undefined,
  actorWid: string | undefined
): { identityId: string; wid: string } {
  const identityId = actorIdentityId?.trim();
  const wid = actorWid?.trim();
  if (!identityId || !wid) {
    throw new Error('Poll Assistant automation requires an authoritative organizer actor.');
  }
  return { identityId, wid };
}

async function organizerLabel(
  context: PluginServiceRegistrationContext,
  wid: string,
  fallback: string
): Promise<string> {
  const resolved = await context.resolveIdentityAddress?.(wid);
  return resolved?.displayName?.trim() || fallback;
}

function assertActionReplay(
  action: { idempotencyKey: string; requestSha256: string },
  idempotencyKey: string,
  requestSha256: string
): void {
  if (action.idempotencyKey !== idempotencyKey || action.requestSha256 !== requestSha256) {
    throw new Error('Automation action idempotency key is already bound to different input.');
  }
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeWid(value: string): string {
  return value.trim().toLowerCase();
}
