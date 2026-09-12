import { paginatePollText, renderPollTemplate } from './templates';
import { createHash } from 'node:crypto';
import { previewAssistantFlow } from '../../../../packages/plugin-sdk/src/flow-preview';
import { createPollCreationFlowDefinition, pollCreationPresetInitialData } from './flow';
import { parseCommand } from '../../../../packages/plugin-sdk/src/command-parser';
import { z } from 'zod';
import { pollActionsCommand, registerPollOutcomeApprovals } from './outcomes';
import { pollOutcomeFromFlow } from './outcomeFlow';
import { frozenPollOutcomeSchema, freezePollOutcome } from './outcomeConfig';
import { type DurableFlowEngine as FlowEngine } from '../../../../packages/plugin-sdk/src/durable-flow';
import { type FlowSessionSnapshot } from '../../../../packages/plugin-sdk/src/flow-engine';
import type { CommandMetadata } from '../../../../packages/plugin-sdk/src/command-metadata';
import type { CommandContext } from '../../../../packages/plugin-sdk/src/commands';
import { type TranslateFn } from '../../../../packages/plugin-sdk/src/i18n';
import { type PluginCancellationRegistration } from '../../../../packages/plugin-sdk/src/cancellations';
import { type PluginCommandContext } from './runtime';
import { requireDurableCommandRuntime as requireOfficialCommandRuntime, type DurableCommandRuntime as OfficialPluginCommandRuntime } from '../../../../packages/plugin-sdk/src/durable-plugin';
import { requireScopeId } from '../../../../packages/plugin-sdk/src/commands';
import {
  parsePollAssistantConfig,
  type PollAssistantConfig,
  type PollCreationPreset
} from './config';
import { POLL_ASSISTANT_PLUGIN_ID } from './database';
import {
  pollCreationAnswers,
  pollCreationConfirmPurpose,
  pollCreationFlowConfirmed,
  isPollCreationFlowType,
  pollDefinitionFromCreationAnswers,
  type PollCreationClosingAnswer,
  type PollCreationFlowPreferences
} from './flow';
import {
  PollCreationFlowStarter,
  pollCreationRecipeFromSnapshot,
  registerPollCreationFlowDefinitionResolver,
  type PollCreationRecipe
} from './flowStarter';
import { pollDefinitionSchema, type PollDefinition } from './domain';
import {
  cancelPoll,
  countActivePollsByChat,
  createPoll,
  getPollAggregate,
  getPollDelivery,
  getPollResult,
  overridePollWorkingHours,
  listPollsByChat,
  PollActiveLimitReachedError,
  PollTieResultDeliveryPendingError,
  pollsDatabase,
  resolvePollTie,
  type StoredPoll,
  type StoredPollAggregate,
  type StoredPollRound
} from './store';
import {
  enqueuePollDeliveryJob,
  enqueuePollPublishJob
} from './jobs';
import { reconcilePollRoundTiming } from './timing';
import {
  actorCanManagePoll,
  latestPollRound,
  lookupPollForGroup,
  requestPollClose
} from './operations';

export const POLL_ASSISTANT_COMMAND_PERMISSIONS = {
  create: 'polls.create',
  manage: 'polls.manage'
} as const;

const POLL_LIST_LIMIT = 50;
const completionRegistrations = new WeakMap<FlowEngine, Set<string>>();
export const POLL_CREATION_CANCELLATION_WORKFLOW_ID = 'poll-assistant-create';

interface PollCreationFlowMessenger {
  getGroupCapabilities(groupWid: string): Promise<{
    botIsAdmin: boolean;
    canSend: boolean;
  }>;
  sendText(
    chatId: string,
    text: string,
    options: { idempotencyKey: string }
  ): Promise<unknown>;
}

const pollCreationTerminalOutcomeSchema = z.enum([
  'cancelled',
  'invalid',
  'runtime_unavailable',
  'platform_disabled',
  'creation_disabled',
  'closing_invalid',
  'identity_unavailable',
  'permission_denied',
  'capability_unavailable',
  'active_limit'
]);

const pollCreationTerminalDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('terminal'),
  pollId: z.string().trim().min(1).max(200),
  outcome: pollCreationTerminalOutcomeSchema,
  maximum: z.number().int().min(1).optional()
}).strict().superRefine((decision, ctx) => {
  const requiresMaximum = decision.outcome === 'closing_invalid'
    || decision.outcome === 'active_limit';
  if (requiresMaximum !== (decision.maximum !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: requiresMaximum
        ? 'This Poll creation terminal outcome requires a maximum value.'
        : 'This Poll creation terminal outcome does not accept a maximum value.',
      path: ['maximum']
    });
  }
});

const pollCreationCreateDecisionSchema = z.object({
  outcome: frozenPollOutcomeSchema.optional(),
  schemaVersion: z.literal(1),
  kind: z.literal('create'),
  pollId: z.string().trim().min(1).max(200),
  definition: pollDefinitionSchema,
  maxActivePollsPerChat: z.number().int().min(1).max(100)
}).strict();

const pollCreationCompletionDecisionSchema = z.union([
  pollCreationTerminalDecisionSchema,
  pollCreationCreateDecisionSchema
]);

type PollCreationTerminalOutcome = z.infer<typeof pollCreationTerminalOutcomeSchema>;
type PollCreationTerminalDecision = z.infer<typeof pollCreationTerminalDecisionSchema>;
type PollCreationCompletionDecision = z.infer<typeof pollCreationCompletionDecisionSchema>;

export function registerPollAssistantCommands(context: PluginCommandContext): void {
  requireOfficialCommandRuntime(context);
  registerPollOutcomeApprovals(context.flowEngine);
  context.flowEngine.registerAssistantCommandVerification?.('poll.*', async (owner, sessions) => {
    const session = sessions.find((session) => isPollCreationFlowType(session.flowType));
    if (!session || session.status !== 'COMPLETED') return undefined;
    const snapshot = await context.flowEngine.getSessionSnapshot(session.id);
    const recipe = snapshot ? pollCreationRecipeFromSnapshot(snapshot) : undefined;
    if (!recipe) return undefined;
    const aggregate = getPollAggregate(pollsDatabase(context.databases), recipe.pollId);
    const t = await context.i18n.translatorForIdentity(owner.actorIdentityId, owner.scopeId);
    if (!aggregate) return { status: 'blocked', reason: t('official.poll-assistant.flowInvalid'), retryable: false };
    const round = aggregate.rounds[0]!;
    return round.publishedAt && round.pollWaMessageId
      ? { status: 'completed', output: { pollId: recipe.pollId }, summary: t('official.poll-assistant.outcome.created', { question: aggregate.poll.definition.question, pollId: recipe.pollId }) }
      : { status: 'pending', operationId: `${owner.runId}:${owner.operationId}`, summary: t('official.poll-assistant.outcome.publicationPending') };
  });
  context.router.register('poll', 'actions', pollCommand({ auditAction: 'poll-assistant.actions',
    usage: '/poll actions <poll ID> [status|review|retry|cancel]',
    descriptionKey: 'official.poll-assistant.outcome.help', exampleKey: 'official.poll-assistant.outcome.help.example', topicId: 'manage'
  }), async (ctx) => pollActionsCommand(context, ctx));
  context.flowEngine.registerAssistantCommandPreparation?.('poll.create', async ({ body, context: assistant, answers }) => {
    const runtime = requireOfficialCommandRuntime(context);
    const config = parsePollAssistantConfig(await runtime.configFor(assistant.scopeId, assistant.actor.identityAddress.identityId));
    if (!config.allowCreation) throw new Error('Poll creation is disabled');
    const requestedPresetId = parseCommand(body)?.args[0];
    const preset = resolvePollCreationPreset(config, requestedPresetId);
    if (preset.kind === 'not_found') throw new Error('Poll preset is unavailable');
    const preferences = flowPreferences(config, preset.preset);
    const locale = await context.i18n.resolveLocale({ message: assistant.message, actor: assistant.actor, scopeId: assistant.scopeId });
    const t = context.i18n.translator(locale.locale, locale.languagePackScopes);
    const initialData = pollCreationPresetInitialData(preset.preset);
    const definition = createPollCreationFlowDefinition({ t, locale: locale.locale, preferences, initialData, flowInstanceId: 'preview' });
    return previewAssistantFlow(definition, answers, initialData);
  });
  const registerCompletion = (flowType: string, t: TranslateFn) => {
    registerPollCreationFlowCompletionHandler(context, flowType, t);
  };
  registerPollCreationFlowDefinitionResolver({
    flowEngine: context.flowEngine,
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

  context.router.register('poll', 'open', pollCommand({
    dangerous: true,
    auditAction: 'poll-assistant.open',
    usage: '/poll open [poll ID or question] [--confirm]',
    descriptionKey: 'official.poll-assistant.help.open',
    exampleKey: 'official.poll-assistant.help.open.example',
    topicId: 'manage'
  }), async (ctx) => openPoll(context, ctx));

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
    return startPollCreation(context, ctx);
  });
}

export function registerPollAssistantCancellations(
  _context: PluginCommandContext
): PluginCancellationRegistration[] {
  return [{
    workflowId: POLL_CREATION_CANCELLATION_WORKFLOW_ID,
    cancel: async (input) => {
      let cancelled = false;
      for (const flow of input.cancelledFlows) {
        if (!flow.scopeId || !isPollCreationFlowType(flow.flowType)) {
          continue;
        }
        const recipe = pollCreationRecipeFromSnapshot(flow);
        if (!recipe || recipe.actorIdentityId !== input.actorIdentityId) {
          continue;
        }
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
      const recipe = pollCreationRecipeFromSnapshot(snapshot);
      if (!recipe) {
        return false;
      }
      const responseChatId = snapshot.conversationChatId ?? snapshot.chatId;
      const db = pollsDatabase(runtime.databases);
      const existing = getPollAggregate(db, recipe.pollId);
      const storedDecision = await readPollCreationCompletionDecision(
        context.flowEngine,
        lock.flowPromptId,
        recipe
      );
      if (existing) {
        await finishCommittedPollCreation({
          context,
          messenger: activeTransport,
          flowPromptId: lock.flowPromptId,
          responseChatId,
          recipe,
          t
        });
        return true;
      }
      if (storedDecision) {
        await executePollCreationCompletionDecision({
          context,
          db,
          messenger: activeTransport,
          flowPromptId: lock.flowPromptId,
          responseChatId,
          recipe,
          decision: storedDecision,
          t
        });
        return true;
      }
      const proposedDecision = await computePollCreationCompletionDecision({
        context,
        runtime,
        messenger: activeTransport,
        snapshot,
        recipe,
        db
      });
      const decision = await recordPollCreationCompletionDecision(
        context.flowEngine,
        lock.flowPromptId,
        recipe,
        proposedDecision
      );
      await executePollCreationCompletionDecision({
        context,
        db,
        messenger: activeTransport,
        flowPromptId: lock.flowPromptId,
        responseChatId,
        recipe,
        decision,
        t
      });
      return true;
    },
    { recoverLocked: true }
  );
  registered.add(flowType);
  completionRegistrations.set(context.flowEngine, registered);
}

async function computePollCreationCompletionDecision(input: {
  context: PluginCommandContext;
  runtime: OfficialPluginCommandRuntime;
  messenger: PollCreationFlowMessenger;
  snapshot: FlowSessionSnapshot;
  recipe: PollCreationRecipe;
  db: ReturnType<typeof pollsDatabase>;
}): Promise<PollCreationCompletionDecision> {
  if (!pollCreationFlowConfirmed(input.snapshot)) {
    return terminalPollCreationDecision(input.recipe, 'cancelled');
  }
  const answers = pollCreationAnswers(input.snapshot);
  if (!answers) {
    return terminalPollCreationDecision(input.recipe, 'invalid');
  }
  let definition: PollDefinition;
  try {
    definition = pollDefinitionFromCreationAnswers({ pollId: input.recipe.pollId, answers });
  } catch {
    return terminalPollCreationDecision(input.recipe, 'invalid');
  }
  if (!input.context.enabledFor) {
    return terminalPollCreationDecision(input.recipe, 'runtime_unavailable');
  }
  if (!await input.context.enabledFor(input.recipe.scopeId)) {
    return terminalPollCreationDecision(input.recipe, 'platform_disabled');
  }
  const currentConfig = parsePollAssistantConfig(await input.runtime.configFor(
    input.recipe.scopeId,
    input.recipe.actorIdentityId
  ));
  if (!currentConfig.allowCreation) {
    return terminalPollCreationDecision(input.recipe, 'creation_disabled');
  }
  if (!closingAllowedAtCompletion(answers.closing, currentConfig.maxDeadlineMinutes)) {
    return terminalPollCreationDecision(
      input.recipe,
      'closing_invalid',
      currentConfig.maxDeadlineMinutes
    );
  }
  const actor = await input.context.resolveStableIdentityById?.(input.recipe.actorIdentityId)
    .catch(() => undefined);
  if (!actor || actor.identityId !== input.recipe.actorIdentityId) {
    return terminalPollCreationDecision(input.recipe, 'identity_unavailable');
  }
  const permission = await input.context.explainPermission?.({
    actorIdentityId: input.recipe.actorIdentityId,
    action: POLL_ASSISTANT_COMMAND_PERMISSIONS.create,
    scopeId: input.recipe.scopeId,
    pluginId: POLL_ASSISTANT_PLUGIN_ID,
    ...(input.recipe.originGroupId ? { groupId: input.recipe.originGroupId } : {}),
    groupWid: input.recipe.originGroupWid,
    requiresCurrentManagedGroupMembership: true,
    currentManagedGroupMembershipMode: 'effective_scope',
    ...(currentConfig.allowMemberCreation ? { allowCurrentManagedGroupMember: true } : {})
  });
  if (!permission?.allowed) {
    return terminalPollCreationDecision(input.recipe, 'permission_denied');
  }
  const capabilities = await input.messenger.getGroupCapabilities(input.recipe.originGroupWid)
    .catch(() => undefined);
  if (!capabilities?.botIsAdmin || !capabilities.canSend) {
    return terminalPollCreationDecision(input.recipe, 'capability_unavailable');
  }
  if (
    countActivePollsByChat(input.db, input.recipe.originGroupWid)
    >= currentConfig.maxActivePollsPerChat
  ) {
    return terminalPollCreationDecision(
      input.recipe,
      'active_limit',
      currentConfig.maxActivePollsPerChat
    );
  }
  return pollCreationCompletionDecisionSchema.parse({
    schemaVersion: 1,
    kind: 'create',
    pollId: input.recipe.pollId,
    definition,
    ...(pollOutcomeFromFlow(input.snapshot.state) ? { outcome: freezePollOutcome(pollOutcomeFromFlow(input.snapshot.state)!, {
      requesterIdentityId: input.recipe.actorIdentityId, requesterChatId: actor.deliveryChatId,
      approvedAt: new Date().toISOString(), approvalSourceId: input.snapshot.id
    }) } : {}),
    maxActivePollsPerChat: currentConfig.maxActivePollsPerChat
  });
}

function terminalPollCreationDecision(
  recipe: PollCreationRecipe,
  outcome: PollCreationTerminalOutcome,
  maximum?: number | undefined
): PollCreationTerminalDecision {
  return pollCreationTerminalDecisionSchema.parse({
    schemaVersion: 1,
    kind: 'terminal',
    pollId: recipe.pollId,
    outcome,
    ...(maximum === undefined ? {} : { maximum })
  });
}

async function readPollCreationCompletionDecision(
  flowEngine: FlowEngine,
  flowPromptId: string,
  recipe: PollCreationRecipe
): Promise<PollCreationCompletionDecision | undefined> {
  const rawDecision = await flowEngine.getPromptLockDecision(flowPromptId);
  return rawDecision === undefined
    ? undefined
    : parsePollCreationCompletionDecision(rawDecision, recipe);
}

async function recordPollCreationCompletionDecision(
  flowEngine: FlowEngine,
  flowPromptId: string,
  recipe: PollCreationRecipe,
  decision: PollCreationCompletionDecision
): Promise<PollCreationCompletionDecision> {
  const winningDecision = await flowEngine.recordPromptLockDecision(flowPromptId, decision);
  return parsePollCreationCompletionDecision(winningDecision, recipe);
}

function parsePollCreationCompletionDecision(
  value: unknown,
  recipe: PollCreationRecipe
): PollCreationCompletionDecision {
  const decision = pollCreationCompletionDecisionSchema.parse(value);
  if (decision.pollId !== recipe.pollId) {
    throw new Error(
      `Poll creation prompt decision is bound to ${decision.pollId}, not ${recipe.pollId}.`
    );
  }
  if (decision.kind === 'create' && decision.definition.id !== recipe.pollId) {
    throw new Error(
      `Poll creation prompt decision definition is bound to ${decision.definition.id}, not ${recipe.pollId}.`
    );
  }
  return decision;
}

async function executePollCreationCompletionDecision(input: {
  context: PluginCommandContext;
  db: ReturnType<typeof pollsDatabase>;
  messenger: PollCreationFlowMessenger;
  flowPromptId: string;
  responseChatId: string;
  recipe: PollCreationRecipe;
  decision: PollCreationCompletionDecision;
  t: TranslateFn;
}): Promise<void> {
  if (input.decision.kind === 'terminal') {
    await finishTerminalPollCreation({
      context: input.context,
      messenger: input.messenger,
      flowPromptId: input.flowPromptId,
      responseChatId: input.responseChatId,
      recipe: input.recipe,
      decision: input.decision,
      t: input.t
    });
    return;
  }
  try {
    createPoll(input.db, {
      ...(input.decision.outcome ? { outcome: input.decision.outcome } : {}),
      definition: input.decision.definition,
      scopeId: input.recipe.scopeId,
      chatId: input.recipe.originGroupWid,
      ...(input.recipe.originGroupId ? { groupId: input.recipe.originGroupId } : {}),
      creatorIdentityId: input.recipe.actorIdentityId,
      creatorWid: input.recipe.actorWid,
      creatorLabel: input.recipe.actorLabel,
      roundId: input.recipe.roundId,
      publishIdempotencyKey: pollPublishIdempotencyKey(input.recipe.pollId),
      maxActivePollsPerChat: input.decision.maxActivePollsPerChat,
      createdAt: input.recipe.createdAt
    });
  } catch (error) {
    if (error instanceof PollActiveLimitReachedError) {
      // Capacity changed after the immutable create decision won. Keep the
      // lock recoverable and retry that exact decision when capacity permits;
      // never rewrite it into a contradictory terminal denial.
      throw error;
    }
    throw error;
  }
  await finishCommittedPollCreation({
    context: input.context,
    messenger: input.messenger,
    flowPromptId: input.flowPromptId,
    responseChatId: input.responseChatId,
    recipe: input.recipe,
    t: input.t
  });
}

async function finishTerminalPollCreation(input: {
  context: PluginCommandContext;
  messenger: PollCreationFlowMessenger;
  flowPromptId: string;
  responseChatId: string;
  recipe: PollCreationRecipe;
  decision: PollCreationTerminalDecision;
  t: TranslateFn;
}): Promise<void> {
  const reply = pollCreationTerminalReply(input.decision, input.t);
  await finishPollCreationFlow({
    context: input.context,
    messenger: input.messenger,
    flowPromptId: input.flowPromptId,
    responseChatId: input.responseChatId,
    text: reply.text,
    idempotencyKey: `poll-assistant:create:${input.recipe.pollId}:${reply.idempotencySuffix}`
  });
}

function pollCreationTerminalReply(
  decision: PollCreationTerminalDecision,
  t: TranslateFn
): { text: string; idempotencySuffix: string } {
  switch (decision.outcome) {
    case 'cancelled':
      return { text: t('official.poll-assistant.flowCancelled'), idempotencySuffix: 'cancelled' };
    case 'invalid':
      return { text: t('official.poll-assistant.flowInvalid'), idempotencySuffix: 'invalid' };
    case 'runtime_unavailable':
      return {
        text: t('official.poll-assistant.runtimeUnavailable'),
        idempotencySuffix: 'runtime-unavailable'
      };
    case 'platform_disabled':
      return { text: t('official.poll-assistant.disabled'), idempotencySuffix: 'platform-disabled' };
    case 'creation_disabled':
      return {
        text: t('official.poll-assistant.creationDisabled'),
        idempotencySuffix: 'creation-disabled'
      };
    case 'closing_invalid':
      return {
        text: t('official.poll-assistant.completionClosingInvalid', {
          maximumMinutes: requiredPollCreationDecisionMaximum(decision)
        }),
        idempotencySuffix: 'closing-invalid'
      };
    case 'identity_unavailable':
      return {
        text: t('official.poll-assistant.identityUnavailable'),
        idempotencySuffix: 'identity-unavailable'
      };
    case 'permission_denied':
      return {
        text: t('official.poll-assistant.permissionDenied'),
        idempotencySuffix: 'permission-denied'
      };
    case 'capability_unavailable':
      return {
        text: t('official.poll-assistant.botCapabilityUnavailable'),
        idempotencySuffix: 'capability-unavailable'
      };
    case 'active_limit':
      return {
        text: t('official.poll-assistant.activeLimitReached', {
          maximum: requiredPollCreationDecisionMaximum(decision)
        }),
        idempotencySuffix: 'active-limit'
      };
  }
}

function requiredPollCreationDecisionMaximum(decision: PollCreationTerminalDecision): number {
  if (decision.maximum === undefined) {
    throw new Error(`Poll creation terminal outcome ${decision.outcome} has no maximum value.`);
  }
  return decision.maximum;
}

async function finishCommittedPollCreation(input: {
  context: PluginCommandContext;
  messenger: PollCreationFlowMessenger;
  flowPromptId: string;
  responseChatId: string;
  recipe: PollCreationRecipe;
  t: TranslateFn;
}): Promise<void> {
  await enqueuePollPublishJob(input.context, {
    scopeId: input.recipe.scopeId,
    pollId: input.recipe.pollId,
    roundId: input.recipe.roundId,
    ...(input.recipe.originGroupId ? { groupId: input.recipe.originGroupId } : {}),
    groupWid: input.recipe.originGroupWid,
    attempt: 1
  });
  await finishPollCreationFlow({
    context: input.context,
    messenger: input.messenger,
    flowPromptId: input.flowPromptId,
    responseChatId: input.responseChatId,
    text: input.t('official.poll-assistant.createQueued', { pollId: input.recipe.pollId }),
    idempotencyKey: `poll-assistant:create:${input.recipe.pollId}:queued`
  });
}

function pollPublishIdempotencyKey(pollId: string): string {
  return `poll-assistant:publish:${pollId}:round:1`;
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
  if (!config.allowCreation) {
    return { handled: true, text: ctx.t('official.poll-assistant.creationDisabled') };
  }
  const requestedPresetId = commandArgs(ctx)[0]?.trim();
  const preset = resolvePollCreationPreset(config, requestedPresetId);
  if (preset.kind === 'not_found') {
    return { handled: true, text: ctx.t('official.poll-assistant.presetNotFound', {
      presetId: preset.presetId
    }) };
  }
  const preferences = flowPreferences(config, preset.preset);
  const starter = new PollCreationFlowStarter({
    flowEngine: context.flowEngine,
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
  const selection = await selectManageablePoll(context, runtime, ctx, isManuallyClosablePoll);
  if (selection.kind !== 'selected') return { handled: true, text: selection.text };
  if (!args.includes('--confirm')) return confirmationReply(ctx, 'close', selection.aggregate);
  const aggregate = getPollAggregate(
    pollsDatabase(runtime.databases),
    selection.aggregate.poll.id
  );
  if (!aggregate || !await canManagePoll(context, ctx, aggregate.poll)) {
    return { handled: true, text: ctx.t('official.poll-assistant.lifecyclePermissionDenied') };
  }
  const round = latestRound(aggregate);
  if (!round || !isManuallyClosablePoll(aggregate)) {
    return { handled: true, text: ctx.t('official.poll-assistant.close.notOpen') };
  }
  const close = await requestPollClose({
    context,
    databases: runtime.databases,
    aggregate
  });
  if (close.kind === 'not_open') {
    return { handled: true, text: ctx.t('official.poll-assistant.close.notOpen') };
  }
  return {
    handled: true,
    text: ctx.t('official.poll-assistant.close.queued', { pollId: aggregate.poll.id })
  };
}

function isManuallyClosablePoll(aggregate: StoredPollAggregate): boolean {
  const round = latestRound(aggregate);
  return Boolean(
    round?.status === 'open'
    && (!round.closesAt || Date.parse(round.closesAt) > Date.now())
  );
}

async function openPoll(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const args = commandArgs(ctx);
  const selection = await selectManageablePoll(
    context,
    runtime,
    ctx,
    isScheduleDeferredPoll
  );
  if (selection.kind !== 'selected') return { handled: true, text: selection.text };
  if (!args.includes('--confirm')) return confirmationReply(ctx, 'open', selection.aggregate);
  const actorIdentityId = ctx.actor?.identityAddress.identityId;
  const aggregate = getPollAggregate(
    pollsDatabase(runtime.databases),
    selection.aggregate.poll.id
  );
  const round = aggregate ? latestRound(aggregate) : undefined;
  if (!actorIdentityId || !aggregate || !round) {
    return { handled: true, text: ctx.t('official.poll-assistant.identityUnavailable') };
  }
  if (!isScheduleDeferredPoll(aggregate)) {
    return { handled: true, text: ctx.t('official.poll-assistant.open.unavailable') };
  }
  if (!await canManagePoll(context, ctx, aggregate.poll)) {
    return { handled: true, text: ctx.t('official.poll-assistant.lifecyclePermissionDenied') };
  }
  const overriddenAt = new Date();
  const result = overridePollWorkingHours(pollsDatabase(runtime.databases), {
    pollId: aggregate.poll.id,
    roundId: round.id,
    actorIdentityId,
    overriddenAt: overriddenAt.toISOString()
  });
  if (result === 'unavailable') {
    return { handled: true, text: ctx.t('official.poll-assistant.open.unavailable') };
  }
  if (result === 'publication') {
    await enqueuePollPublishJob(context, {
      scopeId: aggregate.poll.scopeId,
      pollId: aggregate.poll.id,
      roundId: round.id,
      ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
      groupWid: aggregate.poll.chatId,
      attempt: round.publicationAttempt + 1,
      runAt: overriddenAt
    });
  } else {
    await reconcilePollRoundTiming({
      databases: runtime.databases,
      pluginId: runtime.pluginId,
      enqueuePluginJob: context.enqueuePluginJob,
      i18n: context.i18n,
      configFor: runtime.configFor
    }, round.id, overriddenAt);
  }
  return {
    handled: true,
    text: ctx.t('official.poll-assistant.open.done', { pollId: aggregate.poll.id })
  };
}

function isScheduleDeferredPoll(aggregate: StoredPollAggregate): boolean {
  const round = latestRound(aggregate);
  return Boolean(
    aggregate.poll.source
    && aggregate.poll.automationPolicy
    && !aggregate.poll.bypassWorkingHours
    && aggregate.poll.status === 'active'
    && !aggregate.poll.workingHoursOverrideAt
    && round
    && (
      (round.status === 'publish_pending'
        && Date.parse(round.publicationNotBefore) > Date.now())
      || (round.status === 'open' && !round.closesAt && !round.activatedAt)
    )
  );
}

type ManageablePollSelection =
  | { kind: 'selected'; aggregate: StoredPollAggregate }
  | { kind: 'reply'; text: string };

async function selectManageablePoll(
  context: PluginCommandContext,
  runtime: OfficialPluginCommandRuntime,
  ctx: CommandContext,
  stateFilter: (aggregate: StoredPollAggregate) => boolean
): Promise<ManageablePollSelection> {
  const groupWid = currentGroupWid(ctx);
  if (!groupWid) {
    return { kind: 'reply', text: ctx.t('official.poll-assistant.groupRequired') };
  }
  const aggregates = listPollsByChat(pollsDatabase(runtime.databases), groupWid, POLL_LIST_LIMIT)
    .filter((poll) => poll.scopeId === requireScopeId(ctx))
    .flatMap((poll) => {
      const aggregate = getPollAggregate(pollsDatabase(runtime.databases), poll.id);
      return aggregate ? [aggregate] : [];
    });
  const target = commandArgs(ctx).filter((arg) => arg !== '--confirm').join(' ').trim();
  const stateCandidates = aggregates.filter(stateFilter);
  let targeted = stateCandidates;
  if (target) {
    const normalized = target.toLocaleLowerCase(ctx.locale);
    const exactId = stateCandidates.filter((aggregate) => aggregate.poll.id === target);
    const exactQuestion = stateCandidates.filter((aggregate) =>
      aggregate.poll.definition.question.toLocaleLowerCase(ctx.locale) === normalized);
    targeted = exactId.length > 0
      ? exactId
      : exactQuestion.length > 0
        ? exactQuestion
        : stateCandidates.filter((aggregate) =>
            aggregate.poll.definition.question.toLocaleLowerCase(ctx.locale).includes(normalized));
  }
  const candidates: StoredPollAggregate[] = [];
  for (const aggregate of targeted) {
    if (await canManagePoll(context, ctx, aggregate.poll)) {
      candidates.push(aggregate);
    }
  }
  if (candidates.length === 1) {
    return { kind: 'selected', aggregate: candidates[0]! };
  }
  if (candidates.length === 0) {
    return {
      kind: 'reply',
      text: ctx.t('official.poll-assistant.manage.none', { target: target || '—' })
    };
  }
  return {
    kind: 'reply',
    text: ctx.t('official.poll-assistant.manage.choose', {
      polls: candidates.map((aggregate) => ctx.t('official.poll-assistant.manage.choice', {
        question: aggregate.poll.definition.question,
        pollId: aggregate.poll.id
      })).join('\n')
    })
  };
}

function confirmationReply(
  ctx: CommandContext,
  action: 'open' | 'close',
  aggregate: StoredPollAggregate
) {
  return {
    handled: true,
    text: ctx.t('official.poll-assistant.manage.confirm', {
      action: ctx.t(`official.poll-assistant.manage.action.${action}`),
      question: aggregate.poll.definition.question,
      pollId: aggregate.poll.id,
      command: `/poll ${action} ${aggregate.poll.id} --confirm`
    })
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
  let cancelled: boolean;
  try {
    cancelled = cancelPoll(pollsDatabase(runtime.databases), {
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
  } catch (error) {
    if (!(error instanceof PollTieResultDeliveryPendingError)) {
      throw error;
    }
    return { handled: true, text: ctx.t('official.poll-assistant.tieDeliveryPending', {
      pollId: lookup.aggregate.poll.id
    }) };
  }
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
  const tiedOptions = definition.options.filter((option) => tieOutcome.tiedOptionIds.includes(option.id));
  const renderedTiedOptions = tiedOptions.map((option) => ctx.t(
    'official.poll-assistant.status.option',
    {
      ordinal: option.ordinal,
      label: option.label,
      optionId: option.id
    }
  )).join('\n');
  const references = args.filter((arg, index) => index > 0 && arg !== '--confirm');
  if (references.length === 0) {
    return { handled: true, text: ctx.t('official.poll-assistant.resolve.invalidSelection', {
      count: tieOutcome.remainingSeats,
      options: renderedTiedOptions
    }) };
  }
  const selectedIds = references.flatMap((reference) => {
    const option = resolveTiedOptionReference(tiedOptions, reference);
    return option ? [option.id] : [];
  });
  const uniqueSelectedIds = [...new Set(selectedIds)];
  if (
    references.length !== tieOutcome.remainingSeats
    || uniqueSelectedIds.length !== tieOutcome.remainingSeats
    || selectedIds.length !== references.length
  ) {
    return { handled: true, text: ctx.t('official.poll-assistant.resolve.invalidSelection', {
      count: tieOutcome.remainingSeats,
      options: renderedTiedOptions
    }) };
  }
  const actor = ctx.actor?.identityAddress;
  if (!actor?.identityId) {
    return { handled: true, text: ctx.t('official.poll-assistant.identityUnavailable') };
  }
  const finalSelectedOptionIds = new Set([
    ...tieOutcome.certainOptionIds,
    ...uniqueSelectedIds
  ]);
  const selectedOptions = definition.options
    .filter((option) => finalSelectedOptionIds.has(option.id))
    .sort((left, right) => left.ordinal - right.ordinal);
  const groupT = await context.i18n.translatorForScope(lookup.aggregate.poll.scopeId);
  const deliveryId = `poll-assistant:resolve:${lookup.aggregate.poll.id}`;
  const resolvedAt = new Date();
  const config = parsePollAssistantConfig(await runtime.configFor(lookup.aggregate.poll.scopeId));
  const locale = (await context.i18n.resolveScopeLocale(lookup.aggregate.poll.scopeId)).locale;
  const messages = paginatePollText(renderPollTemplate({ kind: 'tieResolved', overrides: config.messages, t: groupT, values: {
    question: definition.question, pollId: definition.id, timezone: config.timezone,
    cutoffAt: round.closesAt ? formatTimestamp(round.closesAt, config.timezone, locale) : undefined,
    options: selectedOptions.map(option => option.label).join(', '), resolver: ctx.message.senderDisplayName || actor.canonicalWid
  } }));
  const deliveries = messages.map((text, index) => ({
    id: index === 0 ? deliveryId : `${deliveryId}:page:${index + 1}`, kind: 'result' as const,
    deliveryKey: index === 0 ? deliveryId : `${deliveryId}:page:${index + 1}`,
    chatId: lookup.aggregate.poll.chatId, text,
    idempotencyKey: index === 0 ? deliveryId : `${deliveryId}:page:${index + 1}`,
    deliveryBatchKey: deliveryId, deliverySequence: index,
    ...(index ? { notBefore: new Date(resolvedAt.getTime() + index * 2_000).toISOString() } : {})
  }));
  try {
    resolvePollTie(pollsDatabase(runtime.databases), {
      roundId: round.id,
      selectedOptionIds: uniqueSelectedIds,
      resolverIdentityId: actor.identityId,
      resolverWid: actor.canonicalWid,
      delivery: deliveries[0]!,
      additionalDeliveries: deliveries.slice(1),
      resolvedAt: resolvedAt.toISOString()
    });
  } catch (error) {
    if (!(error instanceof PollTieResultDeliveryPendingError)) {
      throw error;
    }
    return { handled: true, text: ctx.t('official.poll-assistant.tieDeliveryPending', {
      pollId: lookup.aggregate.poll.id
    }) };
  }
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
  messenger: PollCreationFlowMessenger;
  flowPromptId: string;
  responseChatId: string;
  text: string;
  idempotencyKey: string;
}): Promise<void> {
  await input.messenger.sendText(input.responseChatId, input.text, {
    idempotencyKey: input.idempotencyKey
  });
  if (!await input.context.flowEngine.acknowledgePromptLock(input.flowPromptId)) {
    throw new Error(`Poll creation prompt lock ${input.flowPromptId} could not be acknowledged.`);
  }
}

function lookupPollForCurrentGroup(
  databases: Parameters<typeof pollsDatabase>[0],
  ctx: CommandContext
): { kind: 'found'; aggregate: StoredPollAggregate } | { kind: 'reply'; text: string } {
  const pollId = commandArgs(ctx).find((arg) => arg !== '--confirm')?.trim();
  if (!pollId) {
    return { kind: 'reply', text: ctx.t('official.poll-assistant.pollIdRequired') };
  }
  const groupWid = currentGroupWid(ctx);
  if (!groupWid) {
    return { kind: 'reply', text: ctx.t('official.poll-assistant.groupRequired') };
  }
  const lookup = lookupPollForGroup({
    databases,
    scopeId: requireScopeId(ctx),
    groupWid,
    pollId
  });
  if (lookup.kind === 'not_found') {
    return { kind: 'reply', text: ctx.t('official.poll-assistant.notFound', { pollId }) };
  }
  if (lookup.kind === 'wrong_group') {
    return { kind: 'reply', text: ctx.t('official.poll-assistant.wrongOriginGroup', { pollId }) };
  }
  return { kind: 'found', aggregate: lookup.aggregate };
}

async function canManagePoll(
  context: PluginCommandContext,
  ctx: CommandContext,
  poll: StoredPoll
): Promise<boolean> {
  return actorCanManagePoll({ context, actor: ctx.actor, poll });
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

function flowPreferences(
  config: PollAssistantConfig,
  preset?: PollCreationPreset | undefined
): PollCreationFlowPreferences {
  const configuredQuorumMode = preset && preset.quorum.mode !== 'ask'
    ? preset.quorum.kind
    : config.defaultQuorumMode;
  const defaultQuorum = configuredQuorumMode === 'absolute'
    ? {
        kind: 'absolute' as const,
        minimumResponses: preset && preset.quorum.mode !== 'ask'
          ? preset.quorum.minimumResponses
          : config.defaultAbsoluteQuorumResponses
      }
    : configuredQuorumMode === 'percentage'
      ? {
          kind: 'percentage' as const,
          minimumTurnoutBasisPoints: preset && preset.quorum.mode !== 'ask'
            ? preset.quorum.minimumTurnoutBasisPoints
            : config.defaultPercentageQuorumBasisPoints
        }
      : { kind: 'none' as const };
  const configuredClosing = preset && preset.closing.mode !== 'ask'
    ? preset.closing
    : undefined;
  return {
    timezone: config.timezone,
    maxDeadlineMinutes: config.maxDeadlineMinutes,
    defaultClosing: configuredClosing?.kind === 'manual'
      ? { kind: 'manual' }
      : configuredClosing?.kind === 'duration'
        ? { kind: 'deadline', durationMinutes: configuredClosing.durationMinutes }
        : configuredClosing?.kind === 'after_first_non_creator_response'
          ? {
              kind: 'after_first_non_creator_response',
              durationMinutes: configuredClosing.durationMinutes,
              activationTimeoutMinutes: configuredClosing.activationTimeoutMinutes ?? 120
            }
          : config.defaultClosingMode === 'after_first_non_creator_response'
            ? {
                kind: 'after_first_non_creator_response',
                durationMinutes: config.defaultDeadlineMinutes,
                activationTimeoutMinutes: config.defaultActivationTimeoutMinutes
              }
        : config.defaultClosingMode === 'manual'
      ? { kind: 'manual' }
      : { kind: 'deadline', durationMinutes: config.defaultDeadlineMinutes },
    defaultQuorum,
    ...(preset ? { preset } : {})
  };
}

function resolvePollCreationPreset(
  config: PollAssistantConfig,
  requestedPresetId: string | undefined
): { kind: 'found'; preset?: PollCreationPreset | undefined }
  | { kind: 'not_found'; presetId: string } {
  const enabled = config.creationPresets.filter((preset) => preset.enabled);
  if (requestedPresetId) {
    const preset = enabled.find((candidate) => candidate.id === requestedPresetId);
    return preset
      ? { kind: 'found', preset }
      : { kind: 'not_found', presetId: requestedPresetId };
  }
  const defaultPreset = enabled.find((preset) => preset.isDefault);
  return defaultPreset ? { kind: 'found', preset: defaultPreset } : { kind: 'found' };
}

function closingAllowedAtCompletion(
  closing: PollCreationClosingAnswer,
  maxDeadlineMinutes: number,
  now = new Date()
): boolean {
  if (closing.kind === 'manual') {
    return true;
  }
  if (closing.kind === 'after_publish_duration') {
    return closing.durationMinutes >= 1 && closing.durationMinutes <= maxDeadlineMinutes;
  }
  if (closing.kind === 'after_first_non_creator_response') {
    return closing.durationMinutes >= 1
      && closing.durationMinutes <= maxDeadlineMinutes
      && closing.activationTimeoutMinutes >= 1
      && closing.activationTimeoutMinutes <= maxDeadlineMinutes;
  }
  const closesAt = Date.parse(closing.closesAt);
  const remainingMs = closesAt - now.getTime();
  return Number.isFinite(closesAt)
    && remainingMs > 0
    && remainingMs <= maxDeadlineMinutes * 60_000;
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
  return latestPollRound(aggregate);
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
  if (closing.deadline.mode === 'after_first_non_creator_response') {
    return t('official.poll-assistant.flow.summary.afterFirstResponse', {
      minutes: closing.deadline.durationMinutes,
      timeoutMinutes: closing.deadline.activationTimeoutMinutes
    });
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
  return value.trim().toLowerCase();
}

function resolveTiedOptionReference(
  tiedOptions: readonly StoredPoll['definition']['options'][number][],
  reference: string
): StoredPoll['definition']['options'][number] | undefined {
  const normalized = normalizeOptionReference(reference);
  const idMatch = tiedOptions.find((option) => normalizeOptionReference(option.id) === normalized);
  if (idMatch) {
    return idMatch;
  }
  if (/^[1-9]\d*$/.test(normalized)) {
    const ordinalMatch = tiedOptions.find((option) => String(option.ordinal) === normalized);
    if (ordinalMatch) {
      return ordinalMatch;
    }
  }
  return tiedOptions.find((option) => normalizeOptionReference(option.label) === normalized);
}
