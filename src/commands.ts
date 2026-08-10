import { createHash } from 'node:crypto';
import type { FlowEngine } from '../../../adminBot/flows/flowEngine';
import type { CommandMetadata } from '../../../adminBot/router/commandMetadata';
import type { CommandContext } from '../../../adminBot/router/commandRouter';
import type { TranslateFn } from '../../../platform/i18n';
import type {
  PluginCancellationRegistration,
  PluginCommandContext
} from '../../../platform/pluginRuntime/types';
import type { TransportAdapter } from '../../../platform/transport/transportTypes';
import { requireOfficialCommandRuntime, requireScopeId } from '../shared';
import { parsePollAssistantConfig, type PollAssistantConfig } from './config';
import { POLL_ASSISTANT_PLUGIN_ID } from './database';
import {
  pollCreationAnswers,
  pollCreationConfirmPurpose,
  pollCreationFlowConfirmed,
  isPollCreationFlowType,
  pollDefinitionFromCreationAnswers,
  type PollCreationFlowPreferences
} from './flow';
import {
  PollCreationFlowStarter,
  pollCreationDraftKey,
  readPollCreationDraft,
  registerPollCreationFlowDefinitionResolver
} from './flowStarter';
import {
  cancelPoll,
  countActivePollsByChat,
  createPoll,
  getPollAggregate,
  getPollDelivery,
  getPollResult,
  listPollsByChat,
  pollsDatabase,
  requestPollRoundClose,
  resolvePollTie,
  type StoredPoll,
  type StoredPollAggregate,
  type StoredPollRound
} from './store';
import {
  enqueuePollDeliveryJob,
  enqueuePollFinalizeJob,
  enqueuePollPublishJob
} from './jobs';

export const POLL_ASSISTANT_COMMAND_PERMISSIONS = {
  create: 'polls.create',
  manage: 'polls.manage'
} as const;

const POLL_LIST_LIMIT = 50;
const completionRegistrations = new WeakMap<FlowEngine, Set<string>>();
export const POLL_CREATION_CANCELLATION_WORKFLOW_ID = 'poll-assistant-create';

export function registerPollAssistantCommands(context: PluginCommandContext): void {
  const runtime = requireOfficialCommandRuntime(context);
  const registerCompletion = (flowType: string, t: TranslateFn) => {
    registerPollCreationFlowCompletionHandler(context, flowType, t);
  };
  registerPollCreationFlowDefinitionResolver({
    flowEngine: context.flowEngine,
    dataStore: runtime.dataStore,
    i18n: context.i18n
  }, registerCompletion);

  context.router.register('poll', 'create', pollCommand({
    interaction: 'group_ack_private_continuation',
    permission: POLL_ASSISTANT_COMMAND_PERMISSIONS.create,
    allowCurrentManagedGroupMemberConfigPath: 'allowMemberCreation',
    requiredBotCapabilities: ['botIsAdmin', 'canSend'],
    auditAction: 'poll-assistant.create',
    usage: '/poll create',
    descriptionKey: 'official.poll-assistant.help.create',
    exampleKey: 'official.poll-assistant.help.create.example',
    topicId: 'create'
  }), async (ctx) => startPollCreation(context, ctx));

  context.router.register('poll', 'list', pollCommand({
    mutation: 'none',
    auditAction: 'poll-assistant.list',
    usage: '/poll list',
    descriptionKey: 'official.poll-assistant.help.list',
    exampleKey: 'official.poll-assistant.help.list.example',
    topicId: 'inspect'
  }), async (ctx) => listPolls(context, ctx));

  context.router.register('poll', 'status', pollCommand({
    mutation: 'none',
    auditAction: 'poll-assistant.status',
    usage: '/poll status <poll ID>',
    descriptionKey: 'official.poll-assistant.help.status',
    exampleKey: 'official.poll-assistant.help.status.example',
    topicId: 'inspect'
  }), async (ctx) => pollStatus(context, ctx));

  context.router.register('poll', 'close', pollCommand({
    dangerous: true,
    auditAction: 'poll-assistant.close',
    usage: '/poll close <poll ID> --confirm',
    descriptionKey: 'official.poll-assistant.help.close',
    exampleKey: 'official.poll-assistant.help.close.example',
    topicId: 'manage'
  }), async (ctx) => closePoll(context, ctx));

  context.router.register('poll', 'cancel', pollCommand({
    dangerous: true,
    auditAction: 'poll-assistant.cancel',
    usage: '/poll cancel <poll ID> --confirm',
    descriptionKey: 'official.poll-assistant.help.cancel',
    exampleKey: 'official.poll-assistant.help.cancel.example',
    topicId: 'manage'
  }), async (ctx) => cancelPollLifecycle(context, ctx));

  context.router.register('poll', 'resolve', pollCommand({
    dangerous: true,
    auditAction: 'poll-assistant.resolve',
    usage: '/poll resolve <poll ID> <option ID or number> [more options] --confirm',
    descriptionKey: 'official.poll-assistant.help.resolve',
    exampleKey: 'official.poll-assistant.help.resolve.example',
    topicId: 'manage'
  }), async (ctx) => resolvePollLifecycleTie(context, ctx));

  context.router.register('poll', '*', pollCommand({
    interaction: 'group_ack_private_continuation',
    permission: POLL_ASSISTANT_COMMAND_PERMISSIONS.create,
    allowCurrentManagedGroupMemberConfigPath: 'allowMemberCreation',
    requiredBotCapabilities: ['botIsAdmin', 'canSend'],
    auditAction: 'poll-assistant.create',
    usage: '/poll',
    descriptionKey: 'official.poll-assistant.help.create',
    exampleKey: 'official.poll-assistant.help.create.example',
    topicId: 'create'
  }), async (ctx) => {
    const args = ctx.remainingArgs ?? ctx.command.args;
    return args.length === 0
      ? startPollCreation(context, ctx)
      : { handled: true, text: ctx.t('official.poll-assistant.usage') };
  });
}

export function registerPollAssistantCancellations(
  context: PluginCommandContext
): PluginCancellationRegistration[] {
  const runtime = requireOfficialCommandRuntime(context);
  return [{
    workflowId: POLL_CREATION_CANCELLATION_WORKFLOW_ID,
    cancel: async (input) => {
      let cancelled = false;
      for (const flow of input.cancelledFlows) {
        if (!flow.scopeId || !isPollCreationFlowType(flow.flowType)) {
          continue;
        }
        const draft = await readPollCreationDraft(runtime.dataStore, flow.scopeId, flow.id);
        if (!draft || draft.actorIdentityId !== input.actorIdentityId) {
          continue;
        }
        await runtime.dataStore.delete(pollCreationDraftKey(flow.scopeId, flow.id));
        cancelled = true;
      }
      return cancelled
        ? { workflowId: POLL_CREATION_CANCELLATION_WORKFLOW_ID, cancelled: true }
        : undefined;
    }
  }];
}

export function registerPollCreationFlowCompletionHandler(
  context: PluginCommandContext,
  flowType: string,
  t: TranslateFn
): void {
  const registered = completionRegistrations.get(context.flowEngine) ?? new Set<string>();
  if (registered.has(flowType)) {
    return;
  }
  const runtime = requireOfficialCommandRuntime(context);
  context.flowEngine.registerPromptHandler(
    pollCreationConfirmPurpose(flowType),
    async (lock, activeTransport) => {
      if (!lock.flowSessionId) {
        return false;
      }
      const snapshot = await context.flowEngine.getSessionSnapshot(lock.flowSessionId);
      if (!snapshot || snapshot.flowType !== flowType || !snapshot.scopeId) {
        return false;
      }
      const draft = await readPollCreationDraft(runtime.dataStore, snapshot.scopeId, lock.flowSessionId);
      if (!draft) {
        return false;
      }
      const responseChatId = snapshot.conversationChatId ?? snapshot.chatId;
      if (!pollCreationFlowConfirmed(snapshot)) {
        await finishPollCreationFlow({
          context,
          transport: activeTransport,
          flowPromptId: lock.flowPromptId,
          draftKey: pollCreationDraftKey(draft.scopeId, draft.flowSessionId),
          responseChatId,
          text: t('official.poll-assistant.flowCancelled'),
          idempotencyKey: `poll-assistant:create:${draft.pollId}:cancelled`
        });
        return true;
      }
      const answers = pollCreationAnswers(snapshot);
      if (!answers) {
        await finishPollCreationFlow({
          context,
          transport: activeTransport,
          flowPromptId: lock.flowPromptId,
          draftKey: pollCreationDraftKey(draft.scopeId, draft.flowSessionId),
          responseChatId,
          text: t('official.poll-assistant.flowInvalid'),
          idempotencyKey: `poll-assistant:create:${draft.pollId}:invalid`
        });
        return true;
      }
      const db = pollsDatabase(runtime.databases);
      const existing = getPollAggregate(db, draft.pollId);
      let maxActivePollsPerChat = 1;
      if (!existing) {
        const actor = await context.resolveStableIdentityById?.(draft.actorIdentityId)
          .catch(() => undefined);
        if (!actor || actor.identityId !== draft.actorIdentityId) {
          await finishPollCreationFlow({
            context,
            transport: activeTransport,
            flowPromptId: lock.flowPromptId,
            draftKey: pollCreationDraftKey(draft.scopeId, draft.flowSessionId),
            responseChatId,
            text: t('official.poll-assistant.identityUnavailable'),
            idempotencyKey: `poll-assistant:create:${draft.pollId}:identity-unavailable`
          });
          return true;
        }
        const currentConfig = parsePollAssistantConfig(await runtime.configFor(
          draft.scopeId,
          draft.actorIdentityId
        ));
        if (!currentConfig.enabled) {
          await finishPollCreationFlow({
            context,
            transport: activeTransport,
            flowPromptId: lock.flowPromptId,
            draftKey: pollCreationDraftKey(draft.scopeId, draft.flowSessionId),
            responseChatId,
            text: t('official.poll-assistant.disabled'),
            idempotencyKey: `poll-assistant:create:${draft.pollId}:disabled`
          });
          return true;
        }
        const permission = await context.explainPermission?.({
          actorIdentityId: draft.actorIdentityId,
          action: POLL_ASSISTANT_COMMAND_PERMISSIONS.create,
          scopeId: draft.scopeId,
          pluginId: POLL_ASSISTANT_PLUGIN_ID,
          ...(draft.originGroupId ? { groupId: draft.originGroupId } : {}),
          groupWid: draft.originGroupWid,
          requiresCurrentManagedGroupMembership: true,
          currentManagedGroupMembershipMode: 'effective_scope',
          ...(currentConfig.allowMemberCreation ? { allowCurrentManagedGroupMember: true } : {})
        });
        if (!permission?.allowed) {
          await finishPollCreationFlow({
            context,
            transport: activeTransport,
            flowPromptId: lock.flowPromptId,
            draftKey: pollCreationDraftKey(draft.scopeId, draft.flowSessionId),
            responseChatId,
            text: t('official.poll-assistant.permissionDenied'),
            idempotencyKey: `poll-assistant:create:${draft.pollId}:permission-denied`
          });
          return true;
        }
        const capabilities = await activeTransport.getGroupCapabilities(draft.originGroupWid)
          .catch(() => undefined);
        if (!capabilities?.botIsAdmin || !capabilities.canSend) {
          await finishPollCreationFlow({
            context,
            transport: activeTransport,
            flowPromptId: lock.flowPromptId,
            draftKey: pollCreationDraftKey(draft.scopeId, draft.flowSessionId),
            responseChatId,
            text: t('official.poll-assistant.botCapabilityUnavailable'),
            idempotencyKey: `poll-assistant:create:${draft.pollId}:capability-unavailable`
          });
          return true;
        }
        maxActivePollsPerChat = currentConfig.maxActivePollsPerChat;
        if (countActivePollsByChat(db, draft.originGroupWid) >= maxActivePollsPerChat) {
          await finishPollCreationFlow({
            context,
            transport: activeTransport,
            flowPromptId: lock.flowPromptId,
            draftKey: pollCreationDraftKey(draft.scopeId, draft.flowSessionId),
            responseChatId,
            text: t('official.poll-assistant.activeLimitReached', {
              maximum: maxActivePollsPerChat
            }),
            idempotencyKey: `poll-assistant:create:${draft.pollId}:active-limit`
          });
          return true;
        }
      }
      const definition = pollDefinitionFromCreationAnswers({ pollId: draft.pollId, answers });
      const publishIdempotencyKey = `poll-assistant:publish:${draft.pollId}:round:1`;
      createPoll(db, {
        definition,
        scopeId: draft.scopeId,
        chatId: draft.originGroupWid,
        ...(draft.originGroupId ? { groupId: draft.originGroupId } : {}),
        creatorIdentityId: draft.actorIdentityId,
        // Keep the persisted aggregate byte-for-byte stable when recovery retries
        // after the database commit but before the queue acknowledgement.
        creatorWid: draft.actorWid,
        creatorLabel: draft.actorLabel,
        roundId: draft.roundId,
        publishIdempotencyKey,
        maxActivePollsPerChat,
        createdAt: draft.createdAt
      });
      await enqueuePollPublishJob(context, {
        scopeId: draft.scopeId,
        pollId: draft.pollId,
        roundId: draft.roundId,
        ...(draft.originGroupId ? { groupId: draft.originGroupId } : {}),
        groupWid: draft.originGroupWid,
        attempt: 1
      });
      await finishPollCreationFlow({
        context,
        transport: activeTransport,
        flowPromptId: lock.flowPromptId,
        draftKey: pollCreationDraftKey(draft.scopeId, draft.flowSessionId),
        responseChatId,
        text: t('official.poll-assistant.createQueued', { pollId: draft.pollId }),
        idempotencyKey: `poll-assistant:create:${draft.pollId}:queued`
      });
      return true;
    },
    { recoverLocked: true }
  );
  registered.add(flowType);
  completionRegistrations.set(context.flowEngine, registered);
}

async function startPollCreation(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const scopeId = requireScopeId(ctx);
  const actor = ctx.actor?.identityAddress;
  if (!actor?.identityId) {
    return { handled: true, text: ctx.t('official.poll-assistant.identityUnavailable') };
  }
  const originGroupWid = currentGroupWid(ctx);
  if (!originGroupWid) {
    return { handled: true, text: ctx.t('official.poll-assistant.groupRequired') };
  }
  const config = parsePollAssistantConfig(await runtime.configFor(scopeId, actor.identityId));
  if (!config.enabled) {
    return { handled: true, text: ctx.t('official.poll-assistant.disabled') };
  }
  const preferences = flowPreferences(config);
  const starter = new PollCreationFlowStarter({
    flowEngine: context.flowEngine,
    dataStore: runtime.dataStore,
    i18n: context.i18n
  }, (flowType, t) => registerPollCreationFlowCompletionHandler(context, flowType, t));
  try {
    const started = await starter.start({
      actor,
      actorLabel: ctx.message.senderDisplayName?.trim() || actor.displayName?.trim() || actor.canonicalWid,
      externalIdempotencyKey: pollCreationCommandIdempotencyKey(
        scopeId,
        actor.identityId,
        ctx.message.id
      ),
      origin: { chatId: ctx.message.chatId, context: ctx.message.context },
      scopeId,
      originGroupWid,
      ...(ctx.groupId ? { originGroupId: ctx.groupId } : {}),
      preferences,
      privateDeliveryFallback: {
        chatId: originGroupWid,
        mentionedWids: [actor.mentionWid],
        quotedMessageId: ctx.message.id
      }
    });
    return {
      handled: true,
      text: ctx.t(started.usedPrivateDeliveryFallback
        ? 'official.poll-assistant.startedInGroupFallback'
        : 'official.poll-assistant.startedPrivate')
    };
  } catch {
    return { handled: true, text: ctx.t('official.poll-assistant.startFailed') };
  }
}

async function listPolls(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const scopeId = requireScopeId(ctx);
  const groupWid = currentGroupWid(ctx);
  if (!groupWid) {
    return { handled: true, text: ctx.t('official.poll-assistant.groupRequired') };
  }
  const polls = listPollsByChat(pollsDatabase(runtime.databases), groupWid, POLL_LIST_LIMIT)
    .filter((poll) => poll.scopeId === scopeId);
  if (polls.length === 0) {
    return { handled: true, text: ctx.t('official.poll-assistant.list.none') };
  }
  return {
    handled: true,
    text: ctx.t('official.poll-assistant.list.result', {
      count: polls.length,
      polls: polls.map((poll) => ctx.t('official.poll-assistant.list.item', {
        question: poll.definition.question,
        purpose: purposeLabel(poll, ctx.t),
        status: pollStatusLabel(poll, ctx.t),
        pollId: poll.id
      })).join('\n')
    })
  };
}

async function pollStatus(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const lookup = lookupPollForCurrentGroup(runtime.databases, ctx);
  if (lookup.kind !== 'found') {
    return { handled: true, text: lookup.text };
  }
  const config = parsePollAssistantConfig(await runtime.configFor(
    lookup.aggregate.poll.scopeId,
    ctx.actor?.identityAddress.identityId
  ));
  const round = latestRound(lookup.aggregate);
  return {
    handled: true,
    text: ctx.t('official.poll-assistant.status.result', {
      question: lookup.aggregate.poll.definition.question,
      purpose: purposeLabel(lookup.aggregate.poll, ctx.t),
      pollStatus: pollStatusLabel(lookup.aggregate.poll, ctx.t),
      roundStatus: round
        ? ctx.t(`official.poll-assistant.round.${round.status}`)
        : ctx.t('official.poll-assistant.status.noRound'),
      closing: closingLabel(lookup.aggregate, config, ctx.locale, ctx.t),
      options: lookup.aggregate.poll.definition.options
        .map((option) => ctx.t('official.poll-assistant.status.option', {
          ordinal: option.ordinal,
          label: option.label,
          optionId: option.id
        })).join('\n'),
      pollId: lookup.aggregate.poll.id
    })
  };
}

async function closePoll(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const args = commandArgs(ctx);
  if (!args.includes('--confirm')) {
    return { handled: true, text: ctx.t('official.poll-assistant.confirmRequired') };
  }
  const lookup = lookupPollForCurrentGroup(runtime.databases, ctx);
  if (lookup.kind !== 'found') {
    return { handled: true, text: lookup.text };
  }
  if (!await canManagePoll(context, ctx, lookup.aggregate.poll)) {
    return { handled: true, text: ctx.t('official.poll-assistant.lifecyclePermissionDenied') };
  }
  const round = latestRound(lookup.aggregate);
  if (!round || round.status !== 'open') {
    return { handled: true, text: ctx.t('official.poll-assistant.close.notOpen') };
  }
  const requestedAt = new Date();
  if (!requestPollRoundClose(pollsDatabase(runtime.databases), {
    roundId: round.id,
    requestedAt: requestedAt.toISOString()
  })) {
    return { handled: true, text: ctx.t('official.poll-assistant.close.notOpen') };
  }
  await enqueuePollFinalizeJob(context, {
    scopeId: lookup.aggregate.poll.scopeId,
    pollId: lookup.aggregate.poll.id,
    roundId: round.id,
    ...(lookup.aggregate.poll.groupId ? { groupId: lookup.aggregate.poll.groupId } : {}),
    groupWid: lookup.aggregate.poll.chatId,
    runAt: requestedAt,
    attempt: round.finalizationAttempt + 1
  });
  return {
    handled: true,
    text: ctx.t('official.poll-assistant.close.queued', { pollId: lookup.aggregate.poll.id })
  };
}

async function cancelPollLifecycle(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const args = commandArgs(ctx);
  if (!args.includes('--confirm')) {
    return { handled: true, text: ctx.t('official.poll-assistant.confirmRequired') };
  }
  const lookup = lookupPollForCurrentGroup(runtime.databases, ctx);
  if (lookup.kind !== 'found') {
    return { handled: true, text: lookup.text };
  }
  if (!await canManagePoll(context, ctx, lookup.aggregate.poll)) {
    return { handled: true, text: ctx.t('official.poll-assistant.lifecyclePermissionDenied') };
  }
  const actor = ctx.actor?.identityAddress;
  if (!actor?.identityId) {
    return { handled: true, text: ctx.t('official.poll-assistant.identityUnavailable') };
  }
  const round = latestRound(lookup.aggregate);
  if (!round) {
    return { handled: true, text: ctx.t('official.poll-assistant.cancel.unavailable', {
      pollId: lookup.aggregate.poll.id
    }) };
  }
  const groupT = await context.i18n.translatorForScope(lookup.aggregate.poll.scopeId);
  const deliveryId = `poll-assistant:cancel:${lookup.aggregate.poll.id}`;
  const cancelled = cancelPoll(pollsDatabase(runtime.databases), {
    pollId: lookup.aggregate.poll.id,
    cancelledByIdentityId: actor.identityId,
    cancelledByWid: actor.canonicalWid,
    delivery: {
      id: deliveryId,
      kind: 'cancelled',
      deliveryKey: deliveryId,
      chatId: lookup.aggregate.poll.chatId,
      text: groupT('official.poll-assistant.delivery.cancelled', {
        question: lookup.aggregate.poll.definition.question,
        pollId: lookup.aggregate.poll.id
      }),
      idempotencyKey: deliveryId
    },
    cancelledAt: new Date().toISOString()
  });
  if (!cancelled) {
    return { handled: true, text: ctx.t('official.poll-assistant.cancel.unavailable', {
      pollId: lookup.aggregate.poll.id
    }) };
  }
  const delivery = getPollDelivery(pollsDatabase(runtime.databases), deliveryId);
  if (!delivery) {
    throw new Error(`Poll cancellation delivery ${deliveryId} was not persisted.`);
  }
  await enqueuePollDeliveryJob(context, {
    scopeId: lookup.aggregate.poll.scopeId,
    deliveryId,
    ...(lookup.aggregate.poll.groupId ? { groupId: lookup.aggregate.poll.groupId } : {}),
    groupWid: lookup.aggregate.poll.chatId,
    attempt: delivery.attempt + 1
  });
  return {
    handled: true,
    text: ctx.t('official.poll-assistant.cancel.done', { pollId: lookup.aggregate.poll.id })
  };
}

async function resolvePollLifecycleTie(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const args = commandArgs(ctx);
  if (!args.includes('--confirm')) {
    return { handled: true, text: ctx.t('official.poll-assistant.confirmRequired') };
  }
  const lookup = lookupPollForCurrentGroup(runtime.databases, ctx);
  if (lookup.kind !== 'found') {
    return { handled: true, text: lookup.text };
  }
  if (!await canManagePoll(context, ctx, lookup.aggregate.poll)) {
    return { handled: true, text: ctx.t('official.poll-assistant.lifecyclePermissionDenied') };
  }
  const definition = lookup.aggregate.poll.definition;
  if (definition.purpose !== 'decide' || definition.tiePolicy.kind !== 'authorized_choice') {
    return { handled: true, text: ctx.t('official.poll-assistant.resolve.notAuthorizedPolicy', {
      pollId: lookup.aggregate.poll.id
    }) };
  }
  const round = latestRound(lookup.aggregate);
  const result = round ? getPollResult(pollsDatabase(runtime.databases), round.id) : undefined;
  if (!round || round.status !== 'tie_pending' || result?.purpose !== 'decide' || result.outcome.status !== 'tie') {
    return { handled: true, text: ctx.t('official.poll-assistant.resolve.notPending', {
      pollId: lookup.aggregate.poll.id
    }) };
  }
  const tieOutcome = result.outcome;
  const references = args.filter((arg, index) => index > 0 && arg !== '--confirm');
  if (references.length === 0) {
    return { handled: true, text: ctx.t('official.poll-assistant.resolve.selectionRequired') };
  }
  const tiedOptions = definition.options.filter((option) => tieOutcome.tiedOptionIds.includes(option.id));
  const selectedIds = references.flatMap((reference) => {
    const normalized = normalizeOptionReference(reference);
    const option = tiedOptions.find((candidate) => (
      normalizeOptionReference(candidate.id) === normalized
      || String(candidate.ordinal) === normalized
      || normalizeOptionReference(candidate.label) === normalized
    ));
    return option ? [option.id] : [];
  });
  const uniqueSelectedIds = [...new Set(selectedIds)];
  if (
    uniqueSelectedIds.length !== tieOutcome.remainingSeats
    || selectedIds.length !== references.length
  ) {
    return { handled: true, text: ctx.t('official.poll-assistant.resolve.invalidSelection', {
      count: tieOutcome.remainingSeats,
      options: tiedOptions.map((option) => `${option.label} (${option.id})`).join(', ')
    }) };
  }
  const actor = ctx.actor?.identityAddress;
  if (!actor?.identityId) {
    return { handled: true, text: ctx.t('official.poll-assistant.identityUnavailable') };
  }
  const selectedLabels = definition.options
    .filter((option) => uniqueSelectedIds.includes(option.id))
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((option) => option.label);
  const groupT = await context.i18n.translatorForScope(lookup.aggregate.poll.scopeId);
  const deliveryId = `poll-assistant:resolve:${lookup.aggregate.poll.id}`;
  resolvePollTie(pollsDatabase(runtime.databases), {
    roundId: round.id,
    selectedOptionIds: uniqueSelectedIds,
    resolverIdentityId: actor.identityId,
    resolverWid: actor.canonicalWid,
    delivery: {
      id: deliveryId,
      kind: 'result',
      deliveryKey: deliveryId,
      chatId: lookup.aggregate.poll.chatId,
      text: groupT('official.poll-assistant.resolve.delivery', {
        question: definition.question,
        options: selectedLabels.join(', ')
      }),
      idempotencyKey: deliveryId
    },
    resolvedAt: new Date().toISOString()
  });
  const delivery = getPollDelivery(pollsDatabase(runtime.databases), deliveryId);
  if (!delivery) {
    throw new Error(`Poll tie-resolution delivery ${deliveryId} was not persisted.`);
  }
  await enqueuePollDeliveryJob(context, {
    scopeId: lookup.aggregate.poll.scopeId,
    deliveryId,
    ...(lookup.aggregate.poll.groupId ? { groupId: lookup.aggregate.poll.groupId } : {}),
    groupWid: lookup.aggregate.poll.chatId,
    attempt: delivery.attempt + 1
  });
  return {
    handled: true,
    text: ctx.t('official.poll-assistant.resolve.done', { pollId: lookup.aggregate.poll.id })
  };
}

async function finishPollCreationFlow(input: {
  context: PluginCommandContext;
  transport: TransportAdapter;
  flowPromptId: string;
  draftKey: string;
  responseChatId: string;
  text: string;
  idempotencyKey: string;
}): Promise<void> {
  const runtime = requireOfficialCommandRuntime(input.context);
  await input.transport.sendText(input.responseChatId, input.text, {
    idempotencyKey: input.idempotencyKey
  });
  if (!await input.context.flowEngine.acknowledgePromptLock(input.flowPromptId)) {
    throw new Error(`Poll creation prompt lock ${input.flowPromptId} could not be acknowledged.`);
  }
  await runtime.dataStore.delete(input.draftKey);
}

function lookupPollForCurrentGroup(
  databases: Parameters<typeof pollsDatabase>[0],
  ctx: CommandContext
): { kind: 'found'; aggregate: StoredPollAggregate } | { kind: 'reply'; text: string } {
  const pollId = commandArgs(ctx).find((arg) => arg !== '--confirm')?.trim();
  if (!pollId) {
    return { kind: 'reply', text: ctx.t('official.poll-assistant.pollIdRequired') };
  }
  const aggregate = getPollAggregate(pollsDatabase(databases), pollId);
  if (!aggregate || aggregate.poll.scopeId !== requireScopeId(ctx)) {
    return { kind: 'reply', text: ctx.t('official.poll-assistant.notFound', { pollId }) };
  }
  const groupWid = currentGroupWid(ctx);
  if (!groupWid || aggregate.poll.chatId !== groupWid) {
    return { kind: 'reply', text: ctx.t('official.poll-assistant.wrongOriginGroup', { pollId }) };
  }
  return { kind: 'found', aggregate };
}

async function canManagePoll(
  context: PluginCommandContext,
  ctx: CommandContext,
  poll: StoredPoll
): Promise<boolean> {
  const actorIdentityId = ctx.actor?.identityAddress.identityId;
  if (!actorIdentityId) {
    return false;
  }
  if (actorIdentityId === poll.creatorIdentityId) {
    return true;
  }
  const decision = await context.explainPermission?.({
    actorIdentityId,
    action: POLL_ASSISTANT_COMMAND_PERMISSIONS.manage,
    scopeId: poll.scopeId,
    pluginId: POLL_ASSISTANT_PLUGIN_ID,
    ...(poll.groupId ? { groupId: poll.groupId } : {}),
    groupWid: poll.chatId,
    requiresCurrentManagedGroupMembership: true,
    currentManagedGroupMembershipMode: 'effective_scope'
  });
  return decision?.allowed === true;
}

function pollCommand(input: {
  interaction?: CommandMetadata['interaction'] | undefined;
  mutation?: CommandMetadata['mutation'] | undefined;
  permission?: string | undefined;
  allowCurrentManagedGroupMemberConfigPath?: string | undefined;
  requiredBotCapabilities?: string[] | undefined;
  dangerous?: boolean | undefined;
  auditAction: string;
  usage: string;
  descriptionKey: string;
  exampleKey: string;
  topicId: 'create' | 'inspect' | 'manage';
}): CommandMetadata {
  return {
    plane: 'group_operation',
    interaction: input.interaction ?? 'group_same_chat',
    pluginId: POLL_ASSISTANT_PLUGIN_ID,
    requiresManagedGroup: true,
    requiresCurrentManagedGroupMembership: true,
    currentManagedGroupMembershipMode: 'effective_scope',
    ...(input.permission ? { permission: input.permission } : {}),
    ...(input.allowCurrentManagedGroupMemberConfigPath
      ? { allowCurrentManagedGroupMemberConfigPath: input.allowCurrentManagedGroupMemberConfigPath }
      : {}),
    ...(input.requiredBotCapabilities
      ? { requiredBotCapabilities: input.requiredBotCapabilities }
      : {}),
    mutation: input.mutation ?? 'durable',
    auditAction: input.auditAction,
    ...(input.dangerous !== undefined ? { dangerous: input.dangerous } : {}),
    assistant: {
      intentTags: ['poll', input.topicId],
      examples: [input.usage],
      executable: true,
      requiresConfirmation: input.mutation !== 'none'
    },
    help: {
      familyKey: 'official.poll-assistant.help.family',
      featureId: 'poll-assistant',
      topicId: input.topicId,
      descriptionKey: input.descriptionKey,
      usage: input.usage,
      exampleKeys: [input.exampleKey],
      keywords: ['poll', input.topicId]
    }
  };
}

function flowPreferences(config: PollAssistantConfig): PollCreationFlowPreferences {
  const defaultQuorum = config.defaultQuorumMode === 'absolute'
    ? { kind: 'absolute' as const, minimumResponses: config.defaultAbsoluteQuorumResponses }
    : config.defaultQuorumMode === 'percentage'
      ? {
          kind: 'percentage' as const,
          minimumTurnoutBasisPoints: config.defaultPercentageQuorumBasisPoints
        }
      : { kind: 'none' as const };
  return {
    timezone: config.timezone,
    maxDeadlineMinutes: config.maxDeadlineMinutes,
    defaultClosing: config.defaultClosingMode === 'manual'
      ? { kind: 'manual' }
      : { kind: 'deadline', durationMinutes: config.defaultDeadlineMinutes },
    defaultQuorum
  };
}

function currentGroupWid(ctx: CommandContext): string | undefined {
  const groupWid = ctx.groupWid?.trim()
    || (ctx.message.context === 'group' ? ctx.message.chatId.trim() : '');
  return groupWid || undefined;
}

function commandArgs(ctx: CommandContext): string[] {
  return ctx.remainingArgs ?? ctx.command.args;
}

function latestRound(aggregate: StoredPollAggregate): StoredPollRound | undefined {
  return [...aggregate.rounds].sort((left, right) => right.roundNumber - left.roundNumber)[0];
}

function purposeLabel(poll: StoredPoll, t: TranslateFn): string {
  return t(`official.poll-assistant.purpose.${poll.purpose}`);
}

function pollStatusLabel(poll: StoredPoll, t: TranslateFn): string {
  return t(`official.poll-assistant.status.${poll.status}`);
}

function closingLabel(
  aggregate: StoredPollAggregate,
  config: PollAssistantConfig,
  locale: string,
  t: TranslateFn
): string {
  const round = latestRound(aggregate);
  if (round?.closesAt) {
    return formatTimestamp(round.closesAt, config.timezone, locale);
  }
  const closing = aggregate.poll.definition.closing;
  if (closing.kind === 'manual') {
    return t('official.poll-assistant.flow.summary.manual');
  }
  if (closing.deadline.mode === 'at') {
    return formatTimestamp(closing.deadline.closesAt, config.timezone, locale);
  }
  return t('official.poll-assistant.flow.summary.duration', {
    minutes: closing.deadline.durationMinutes
  });
}

function formatTimestamp(value: string, timezone: string, locale: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone
  }).format(date);
}

function pollCreationCommandIdempotencyKey(
  scopeId: string,
  actorIdentityId: string,
  messageId: string
): string {
  const digest = createHash('sha256')
    .update(scopeId)
    .update('\0')
    .update(actorIdentityId)
    .update('\0')
    .update(messageId)
    .digest('hex');
  return `poll-assistant:create:${digest}`;
}

function normalizeOptionReference(value: string): string {
  return value.trim().toLocaleLowerCase();
}
