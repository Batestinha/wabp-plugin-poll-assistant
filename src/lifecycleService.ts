import { createHash } from 'node:crypto';
import type { PluginServiceRegistration } from '../../../../packages/plugin-sdk/src/services';
import { type PluginServiceRegistrationContext } from './runtime';
import { parsePollAssistantConfig } from './config';
import { enqueuePollDeliveryJob, enqueuePollPublishJob } from './jobs';
import {
  POLL_ASSISTANT_LIFECYCLE_CANCEL_METHOD,
  POLL_ASSISTANT_LIFECYCLE_ENSURE_METHOD,
  POLL_ASSISTANT_LIFECYCLE_FINALIZE_METHOD,
  POLL_ASSISTANT_LIFECYCLE_INSPECT_METHOD,
  POLL_ASSISTANT_LIFECYCLE_SERVICE_ID,
  pollAssistantLifecycleCancelInputSchema,
  pollAssistantLifecycleCancelOutputSchema,
  pollAssistantLifecycleEnsureInputSchema,
  pollAssistantLifecycleEnsureOutputSchema,
  pollAssistantLifecycleFinalizeInputSchema,
  pollAssistantLifecycleFinalizeOutputSchema,
  pollAssistantLifecycleInspectInputSchema,
  pollAssistantLifecycleInspectOutputSchema,
  type PollAssistantLifecycleCancelInput,
  type PollAssistantLifecycleCancelOutput,
  type PollAssistantLifecycleEnsureInput,
  type PollAssistantLifecycleEnsureOutput,
  type PollAssistantLifecycleFinalizeInput,
  type PollAssistantLifecycleFinalizeOutput,
  type PollAssistantLifecycleInspectInput,
  type PollAssistantLifecycleInspectOutput
} from './lifecycleServiceApi';
import { requestPollClose } from './operations';
import {
  PollActiveLimitReachedError,
  cancelPoll,
  createPoll,
  getPollAggregate,
  getPollAggregateBySource,
  getPollDelivery,
  getPollLifecycleSnapshot,
  pollsDatabase,
  recordPollLifecycleAction,
  type StoredPollAggregate
} from './store';
import { pollAssistantAutomationPolicySnapshotSchema } from './workingHours';

type ServiceCall = Parameters<PluginServiceRegistration['methods'][number]['handler']>[1];

export function registerPollAssistantLifecycleService(
  context: PluginServiceRegistrationContext
): PluginServiceRegistration {
  return {
    serviceId: POLL_ASSISTANT_LIFECYCLE_SERVICE_ID,
    methods: [
      {
        name: POLL_ASSISTANT_LIFECYCLE_ENSURE_METHOD,
        access: 'mutation',
        inputSchema: pollAssistantLifecycleEnsureInputSchema,
        outputSchema: pollAssistantLifecycleEnsureOutputSchema,
        async handler(rawInput, call) {
          return ensureSourceSurvey(
            context,
            rawInput as PollAssistantLifecycleEnsureInput,
            call
          );
        }
      },
      {
        name: POLL_ASSISTANT_LIFECYCLE_INSPECT_METHOD,
        access: 'read',
        inputSchema: pollAssistantLifecycleInspectInputSchema,
        outputSchema: pollAssistantLifecycleInspectOutputSchema,
        handler(rawInput, call) {
          return inspectSourceSurvey(
            context,
            rawInput as PollAssistantLifecycleInspectInput,
            call
          );
        }
      },
      {
        name: POLL_ASSISTANT_LIFECYCLE_FINALIZE_METHOD,
        access: 'mutation',
        inputSchema: pollAssistantLifecycleFinalizeInputSchema,
        outputSchema: pollAssistantLifecycleFinalizeOutputSchema,
        async handler(rawInput, call) {
          return finalizeSourceSurvey(
            context,
            rawInput as PollAssistantLifecycleFinalizeInput,
            call
          );
        }
      },
      {
        name: POLL_ASSISTANT_LIFECYCLE_CANCEL_METHOD,
        access: 'mutation',
        inputSchema: pollAssistantLifecycleCancelInputSchema,
        outputSchema: pollAssistantLifecycleCancelOutputSchema,
        async handler(rawInput, call) {
          return cancelSourceSurvey(
            context,
            rawInput as PollAssistantLifecycleCancelInput,
            call
          );
        }
      }
    ]
  };
}

async function ensureSourceSurvey(
  context: PluginServiceRegistrationContext,
  input: PollAssistantLifecycleEnsureInput,
  call: ServiceCall
): Promise<PollAssistantLifecycleEnsureOutput> {
  assertGroupContext(input.groupWid, call.groupWid);
  const organizer = requireOrganizer(call.actorIdentityId, call.actorWid);
  const requestSha256 = digestJson({
    groupWid: input.groupWid,
    organizerIdentityId: organizer.identityId,
    definition: input.definition,
    presentationOwner: input.presentationOwner
  });
  const db = pollsDatabase(context.databases);
  const existing = getPollAggregateBySource(db, {
    scopeId: call.scopeId,
    sourcePluginId: call.callerPluginId,
    sourceIdempotencyKey: input.sourceIdempotencyKey
  });
  if (existing) {
    assertExistingSourceSurvey(existing, input, organizer.identityId, requestSha256);
    return pollAssistantLifecycleEnsureOutputSchema.parse(
      lifecycleEnvelope(db, existing, 'existing')
    );
  }
  if (!await context.enabledFor(call.scopeId)) {
    throw new Error('official.poll-assistant is disabled for this scope.');
  }
  const config = parsePollAssistantConfig(await context.configFor(call.scopeId, organizer.identityId));
  if (!config.allowCreation) {
    throw new Error('Source survey creation is disabled for this scope.');
  }
  const identityDigest = digestJson({
    scopeId: call.scopeId,
    sourcePluginId: call.callerPluginId,
    sourceIdempotencyKey: input.sourceIdempotencyKey
  });
  const roundId = `poll-round:lifecycle:${identityDigest}`;
  const publishIdempotencyKey = `poll-assistant:lifecycle:${identityDigest}`;
  const createdAt = new Date().toISOString();
  const automationPolicy = pollAssistantAutomationPolicySnapshotSchema.parse({
    timezone: config.timezone,
    workingHours: config.automationWorkingHours,
    bypassWorkingHours: true
  });
  const creatorLabel = await organizerLabel(context, organizer.wid, organizer.identityId);
  let aggregate: StoredPollAggregate;
  try {
    aggregate = createPoll(db, {
      definition: input.definition,
      scopeId: call.scopeId,
      chatId: input.groupWid,
      ...(call.groupId ? { groupId: call.groupId } : {}),
      creatorIdentityId: organizer.identityId,
      creatorWid: organizer.wid,
      creatorLabel,
      roundId,
      publishIdempotencyKey,
      source: {
        pluginId: call.callerPluginId,
        idempotencyKey: input.sourceIdempotencyKey,
        requestSha256
      },
      sourceLifecycleKind: 'survey',
      presentationOwner: input.presentationOwner,
      exactOptionLabels: true,
      automationPolicy,
      maxActivePollsPerChat: config.maxActivePollsPerChat,
      createdAt
    });
  } catch (error) {
    if (!(error instanceof PollActiveLimitReachedError)) throw error;
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
    actorIdentityId: organizer.identityId,
    scopeId: call.scopeId,
    ...(call.groupId ? { groupId: call.groupId } : {}),
    action: 'poll-assistant.lifecycle.ensured',
    targetJson: { pollId: aggregate.poll.id, roundId: round.id, groupWid: aggregate.poll.chatId },
    metadataJson: {
      sourcePluginId: call.callerPluginId,
      sourceIdempotencyKey: input.sourceIdempotencyKey,
      presentationOwner: input.presentationOwner
    }
  });
  return pollAssistantLifecycleEnsureOutputSchema.parse(lifecycleEnvelope(db, aggregate, 'created'));
}

function inspectSourceSurvey(
  context: PluginServiceRegistrationContext,
  input: PollAssistantLifecycleInspectInput,
  call: ServiceCall
): PollAssistantLifecycleInspectOutput {
  assertGroupContext(input.groupWid, call.groupWid);
  const aggregate = getOwnedSourceSurvey(context, input, call, false);
  if (!aggregate) return { kind: 'unavailable', reason: 'not_found' };
  if (normalizeWid(aggregate.poll.chatId) !== normalizeWid(input.groupWid)) {
    return { kind: 'unavailable', reason: 'wrong_group' };
  }
  return pollAssistantLifecycleInspectOutputSchema.parse(
    lifecycleEnvelope(pollsDatabase(context.databases), aggregate, 'found')
  );
}

async function finalizeSourceSurvey(
  context: PluginServiceRegistrationContext,
  input: PollAssistantLifecycleFinalizeInput,
  call: ServiceCall
): Promise<PollAssistantLifecycleFinalizeOutput> {
  assertGroupContext(input.groupWid, call.groupWid);
  const aggregate = getOwnedSourceSurvey(context, input, call, true)!;
  const db = pollsDatabase(context.databases);
  const round = aggregate.rounds.at(-1)!;
  if (!['open', 'finalizing', 'finalized', 'cancelled', 'failed'].includes(round.status)) {
    throw new Error('Source survey cannot be finalized before its native poll is open.');
  }
  const requestedAt = input.cutoffAt ? new Date(input.cutoffAt) : new Date();
  if (requestedAt.getTime() > Date.now()) {
    throw new Error('Source survey finalization cutoff cannot be in the future.');
  }
  const action = recordPollLifecycleAction(db, {
    pollId: aggregate.poll.id,
    kind: 'finalize',
    idempotencyKey: input.finalizationIdempotencyKey,
    requestSha256: digestJson(input),
    requestedAt: requestedAt.toISOString()
  });
  if (aggregate.poll.status === 'resolved' && round.status === 'finalized') {
    return pollAssistantLifecycleFinalizeOutputSchema.parse(
      lifecycleEnvelope(db, aggregate, 'finalized')
    );
  }
  if (aggregate.poll.status === 'cancelled') {
    return pollAssistantLifecycleFinalizeOutputSchema.parse(
      lifecycleEnvelope(db, aggregate, 'cancelled')
    );
  }
  if (aggregate.poll.status === 'failed' || round.status === 'failed') {
    return pollAssistantLifecycleFinalizeOutputSchema.parse(
      lifecycleEnvelope(db, aggregate, 'failed')
    );
  }
  if (round.status === 'open') {
    await requestPollClose({
      context,
      databases: context.databases,
      aggregate,
      requestedAt
    });
  }
  if (action.inserted) {
    await context.audit.record({
      actorIdentityId: aggregate.poll.creatorIdentityId,
      scopeId: aggregate.poll.scopeId,
      ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
      action: 'poll-assistant.lifecycle.finalization-requested',
      targetJson: { pollId: aggregate.poll.id, roundId: round.id },
      metadataJson: {
        sourcePluginId: aggregate.poll.source!.pluginId,
        sourceIdempotencyKey: aggregate.poll.source!.idempotencyKey,
        finalizationIdempotencyKey: input.finalizationIdempotencyKey
      }
    });
  }
  const refreshed = getPollAggregate(db, aggregate.poll.id)!;
  const refreshedRound = refreshed.rounds.at(-1)!;
  const kind = refreshed.poll.status === 'resolved' && refreshedRound.status === 'finalized'
    ? 'finalized'
    : action.inserted ? 'queued' : 'existing';
  return pollAssistantLifecycleFinalizeOutputSchema.parse(lifecycleEnvelope(db, refreshed, kind));
}

async function cancelSourceSurvey(
  context: PluginServiceRegistrationContext,
  input: PollAssistantLifecycleCancelInput,
  call: ServiceCall
): Promise<PollAssistantLifecycleCancelOutput> {
  assertGroupContext(input.groupWid, call.groupWid);
  const aggregate = getOwnedSourceSurvey(context, input, call, true)!;
  const db = pollsDatabase(context.databases);
  if (aggregate.poll.status === 'resolved' || aggregate.poll.status === 'failed') {
    throw new Error('Source survey cannot be cancelled after it reaches a terminal result.');
  }
  const cancelledAt = new Date().toISOString();
  const action = recordPollLifecycleAction(db, {
    pollId: aggregate.poll.id,
    kind: 'cancel',
    idempotencyKey: input.cancellationIdempotencyKey,
    requestSha256: digestJson(input),
    requestedAt: cancelledAt
  });
  if (aggregate.poll.status === 'cancelled') {
    return pollAssistantLifecycleCancelOutputSchema.parse(
      lifecycleEnvelope(db, aggregate, 'existing')
    );
  }
  const deliveryId = `poll-assistant:lifecycle:cancel:${aggregate.poll.id}`;
  const delivery = aggregate.poll.presentationOwner === 'source_plugin'
    ? undefined
    : {
        id: deliveryId,
        kind: 'cancelled' as const,
        deliveryKey: deliveryId,
        chatId: aggregate.poll.chatId,
        text: (await context.i18n.translatorForScope(aggregate.poll.scopeId))(
          'official.poll-assistant.delivery.cancelled',
          { question: aggregate.poll.definition.question, pollId: aggregate.poll.id }
        ),
        idempotencyKey: deliveryId
      };
  const cancelled = cancelPoll(db, {
    pollId: aggregate.poll.id,
    cancelledByIdentityId: aggregate.poll.creatorIdentityId,
    cancelledByWid: aggregate.poll.creatorWid,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(delivery ? { delivery } : {}),
    cancelledAt
  });
  const refreshed = getPollAggregate(db, aggregate.poll.id)!;
  if (!cancelled && refreshed.poll.status !== 'cancelled') {
    throw new Error('Source survey cannot be cancelled in its current state.');
  }
  if (action.inserted) {
    await context.audit.record({
      actorIdentityId: aggregate.poll.creatorIdentityId,
      scopeId: aggregate.poll.scopeId,
      ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
      action: 'poll-assistant.lifecycle.cancelled',
      targetJson: { pollId: aggregate.poll.id, roundId: aggregate.rounds.at(-1)!.id },
      metadataJson: {
        sourcePluginId: aggregate.poll.source!.pluginId,
        sourceIdempotencyKey: aggregate.poll.source!.idempotencyKey,
        cancellationIdempotencyKey: input.cancellationIdempotencyKey
      }
    });
  }
  if (delivery) {
    const stored = getPollDelivery(db, deliveryId);
    if (stored && stored.status !== 'sent') {
      await enqueuePollDeliveryJob(context, {
        scopeId: aggregate.poll.scopeId,
        deliveryId,
        ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
        groupWid: aggregate.poll.chatId,
        attempt: stored.attempt + 1
      });
    }
  }
  return pollAssistantLifecycleCancelOutputSchema.parse(
    lifecycleEnvelope(db, refreshed, action.inserted && cancelled ? 'cancelled' : 'existing')
  );
}

function getOwnedSourceSurvey(
  context: PluginServiceRegistrationContext,
  input: { sourceIdempotencyKey: string; groupWid: string },
  call: ServiceCall,
  required: boolean
): StoredPollAggregate | undefined {
  const aggregate = getPollAggregateBySource(pollsDatabase(context.databases), {
    scopeId: call.scopeId,
    sourcePluginId: call.callerPluginId,
    sourceIdempotencyKey: input.sourceIdempotencyKey
  });
  if (!aggregate || aggregate.poll.sourceLifecycleKind !== 'survey') {
    if (required) throw new Error('No owned Poll Assistant source survey lifecycle exists.');
    return undefined;
  }
  if (required && normalizeWid(aggregate.poll.chatId) !== normalizeWid(input.groupWid)) {
    throw new Error('The Poll Assistant source survey belongs to another group.');
  }
  return aggregate;
}

function lifecycleEnvelope(
  db: ReturnType<typeof pollsDatabase>,
  aggregate: StoredPollAggregate,
  kind: 'created' | 'existing' | 'found' | 'queued' | 'finalized' | 'cancelled' | 'failed'
) {
  const round = aggregate.rounds.at(-1)!;
  const storedSnapshot = getPollLifecycleSnapshot(db, round.id);
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
    presentationOwner: aggregate.poll.presentationOwner,
    question: aggregate.poll.definition.question,
    allowMultipleAnswers: round.allowMultipleAnswers,
    pollWaMessageId: round.pollWaMessageId ?? null,
    closesAt: round.closesAt ?? null,
    options: [...aggregate.poll.definition.options]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((option) => ({ id: option.id, label: option.label, ordinal: option.ordinal })),
    snapshot: storedSnapshot?.snapshot ?? null,
    snapshotSha256: storedSnapshot?.snapshotSha256 ?? null
  };
}

function assertExistingSourceSurvey(
  aggregate: StoredPollAggregate,
  input: PollAssistantLifecycleEnsureInput,
  organizerIdentityId: string,
  requestSha256: string
): void {
  if (
    aggregate.poll.sourceLifecycleKind !== 'survey'
    || normalizeWid(aggregate.poll.chatId) !== normalizeWid(input.groupWid)
    || aggregate.poll.creatorIdentityId !== organizerIdentityId
    || aggregate.poll.presentationOwner !== input.presentationOwner
    || aggregate.poll.source?.requestSha256 !== requestSha256
  ) {
    throw new Error('Source idempotency key is already bound to different canonical survey input.');
  }
}

function assertGroupContext(inputGroupWid: string, contextGroupWid: string | undefined): void {
  if (!contextGroupWid || normalizeWid(contextGroupWid) !== normalizeWid(inputGroupWid)) {
    throw new Error('Poll Assistant lifecycle requires an exact authorized target group.');
  }
}

function requireOrganizer(
  actorIdentityId: string | undefined,
  actorWid: string | undefined
): { identityId: string; wid: string } {
  const identityId = actorIdentityId?.trim();
  const wid = actorWid?.trim();
  if (!identityId || !wid) {
    throw new Error('Poll Assistant lifecycle requires an authoritative organizer actor.');
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

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeWid(value: string): string {
  return value.trim().toLowerCase();
}
