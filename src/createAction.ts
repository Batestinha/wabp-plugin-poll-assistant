import { z } from 'zod';
import type { PluginServiceRegistrationContext } from '../../../platform/pluginRuntime/types';
import type { PluginServiceRegistration, PluginServiceCallContext } from '../../../platform/pluginRuntime/pluginServices';
import { pluginWorkflowGroupCapabilities } from '../../../platform/pluginRuntime/workflowContext';
import { canonicalJson, workflowDigest, preparedActionSchema, workflowActionResultSchema, type WorkflowActionResult, type WorkflowProgram } from '../../../platform/workflows/contracts';
import { parsePollAssistantConfig } from './config';
import { POLL_CREATE_ACTION_SERVICE, pollCreateAction, pollCreateActionInputSchema } from './createActionApi';
import { createPoll, getPollAggregate, pollsDatabase } from './store';
import { enqueuePollPublishJob } from './jobs';
import { canonicalPollOutcomeProgram, freezePollOutcome, renderPollOutcomeProgram, pollOutcomeResultSchema } from './outcomeConfig';
import { renderPollConfiguration } from './announcements';
import { pollDefinitionSchema } from './domain';

export function registerPollCreateAction(context: PluginServiceRegistrationContext): PluginServiceRegistration {
  const read = z.object({ input: z.record(z.unknown()), bindings: z.array(z.unknown()).optional() }).strict();
  const execute = z.object({ input: pollCreateActionInputSchema, guard: z.record(z.unknown()), operationId: z.string().min(1), predecessors: z.record(z.unknown()) }).strict();
  const inspect = z.object({ operationId: z.string().min(1) }).strict();
  return { serviceId: POLL_CREATE_ACTION_SERVICE, methods: [
    { name: 'describe', access: 'read', inputSchema: read, outputSchema: z.record(z.unknown()), handler: async (_raw, call) => {
      await requester(context, call);
      return { inputSchema: pollCreateAction.inputSchema, groupWid: call.groupWid ?? null,
        outcomeActions: context.flowEngine?.workflowActions ? await context.flowEngine.workflowActions.list({ runtimeBindingId: context.flowEngine.workflowRuntimeBindingId,
          source: 'poll_outcome', scopeId: call.scopeId, actorIdentityId: call.actorIdentityId!, chatId: call.groupWid ?? '',
          ...(call.groupWid ? { groupWid: call.groupWid } : {}), ...(call.groupId ? { groupId: call.groupId } : {}) }) : [] };
    } },
    { name: 'prepare', access: 'read', inputSchema: read, outputSchema: preparedActionSchema, handler: async (raw, call) => {
      const request = read.parse(raw);
      if (request.bindings?.length) throw new Error('Poll creation does not accept result bindings');
      const input = pollCreateActionInputSchema.parse(request.input);
      const current = await requester(context, call, input);
      let outcome: WorkflowProgram | undefined;
      if (input.outcome) {
        if (!context.flowEngine?.workflowActions) throw new Error('Poll outcome catalog unavailable');
        outcome = await context.flowEngine.workflowActions.prepareProgram({ runtimeBindingId: context.flowEngine.workflowRuntimeBindingId, source: 'poll_outcome',
          scopeId: call.scopeId, actorIdentityId: call.actorIdentityId!, chatId: current.actor.deliveryChatId, groupWid: input.groupWid,
          ...(call.groupId ? { groupId: call.groupId } : {}) }, canonicalPollOutcomeProgram(input.outcome.program, input.definition), pollOutcomeResultSchema);
      }
      const summary = current.t('official.poll-assistant.outcome.createPreview', { question: input.definition.question,
        options: input.definition.options.map((option) => `${option.label}${option.numericValue !== undefined ? ` = ${option.numericValue}` : ''}`).join('; '),
        rules: renderPollConfiguration(input.definition, current.t, current.config.timezone),
        consequences: outcome ? renderPollOutcomeProgram(outcome, input.definition, current.t) : current.t('official.poll-assistant.outcome.none'),
        policy: input.outcome ? current.t(`official.poll-assistant.outcome.policy.${input.outcome.policy}`) : '-' });
      return { input, summary, guard: { inputDigest: workflowDigest(input), ...(outcome ? { outcome } : {}) },
        effects: [{ resource: `poll:new:${input.groupWid}`, fields: ['publication'], description: summary }] };
    } },
    { name: 'execute', access: 'mutation', inputSchema: execute, outputSchema: workflowActionResultSchema, handler: async (raw, call) => {
      const request = execute.parse(raw);
      const current = await requester(context, call, request.input);
      if (workflowDigest(request.input) !== request.guard.inputDigest) throw new Error('Poll differs from the approved proposal');
      const db = pollsDatabase(context.databases);
      const pollId = `poll-${workflowDigest(request.operationId).slice(0, 40)}`;
      const digest = workflowDigest([request.input, request.guard]);
      const previous = db.get<{ input_digest: string; actor_identity_id: string; scope_id: string }>('SELECT * FROM poll_workflow_operations WHERE operation_id = ?', request.operationId);
      if (previous && (previous.input_digest !== digest || previous.actor_identity_id !== call.actorIdentityId || previous.scope_id !== call.scopeId)) throw new Error('Poll operation identity conflict');
      if (!previous) {
        const ids = new Map(request.input.definition.options.map((option) => [option.id, `${pollId}:option:${option.ordinal}`]));
        const definition = pollDefinitionSchema.parse({ ...request.input.definition, id: pollId,
          options: request.input.definition.options.map((option) => ({ ...option, id: ids.get(option.id)! })),
          ...(request.input.definition.purpose === 'decide' && request.input.definition.rule.kind === 'approve_reject' ? { rule: { ...request.input.definition.rule,
            approveOptionId: ids.get(request.input.definition.rule.approveOptionId), rejectOptionId: ids.get(request.input.definition.rule.rejectOptionId) } } : {}) });
        const now = new Date().toISOString();
        const prepared = request.guard.outcome as WorkflowProgram | undefined;
        const program = prepared ? structuredClone(prepared) : undefined;
        for (const node of program?.nodes ?? []) {
          for (const condition of node.conditions) if (['winnerOptionId', 'selectedOptionIds'].includes(condition.path[0]!)) condition.value = ids.get(String(condition.value)) ?? condition.value;
          for (const binding of node.bindings) if (binding.source.kind === 'result' && binding.source.path[0] === 'winnerOptionId') {
            binding.mapping = binding.mapping?.map((entry) => ({ ...entry, from: ids.get(String(entry.from)) ?? entry.from }));
          }
        }
        createPoll(db, { definition, scopeId: call.scopeId, chatId: request.input.groupWid, ...(call.groupId ? { groupId: call.groupId } : {}),
            workflowOperation: { operationId: request.operationId, inputDigest: digest },
            creatorIdentityId: current.actor.identityId, creatorWid: current.actor.canonicalWid, creatorLabel: current.actor.displayName ?? current.actor.canonicalWid,
            roundId: `${pollId}:round:1`, publishIdempotencyKey: `poll-assistant:publish:${pollId}`, maxActivePollsPerChat: current.config.maxActivePollsPerChat, createdAt: now,
            ...(program && request.input.outcome ? { outcome: freezePollOutcome({ version: 1, policy: request.input.outcome.policy, program,
              summary: renderPollOutcomeProgram(program, definition, current.t) }, { requesterIdentityId: current.actor.identityId,
                requesterChatId: current.actor.deliveryChatId, approvedAt: now, approvalSourceId: request.operationId }) } : {}) });
      }
      await enqueuePollPublishJob(context, { pollId, roundId: `${pollId}:round:1`, scopeId: call.scopeId, groupWid: request.input.groupWid,
        ...(call.groupId ? { groupId: call.groupId } : {}), attempt: 1 });
      return inspectOperation(context, request.operationId, call);
    } },
    { name: 'inspect', access: 'read', inputSchema: inspect, outputSchema: workflowActionResultSchema,
      handler: async (raw, call) => inspectOperation(context, inspect.parse(raw).operationId, call) }
  ] };
}

async function requester(context: PluginServiceRegistrationContext, call: PluginServiceCallContext, input?: z.infer<typeof pollCreateActionInputSchema>) {
  if (!call.actorIdentityId || !context.resolveStableIdentityById || !await context.enabledFor(call.scopeId)) throw new Error('Poll requester unavailable');
  const actor = await context.resolveStableIdentityById(call.actorIdentityId);
  if (actor.identityId !== call.actorIdentityId) throw new Error('Requester identity mismatch');
  const config = parsePollAssistantConfig(await context.configFor(call.scopeId, actor.identityId));
  const t = await context.i18n.translatorForIdentity(actor.identityId, call.scopeId);
  if (!config.allowCreation) throw new Error(t('official.poll-assistant.creationDisabled'));
  const groupWid = input?.groupWid ?? call.groupWid;
  if (!groupWid || (call.groupWid && groupWid !== call.groupWid)) throw new Error(t('official.poll-assistant.groupRequired'));
  const permission = await context.explainPermission?.({ actorIdentityId: actor.identityId, action: 'polls.create', pluginId: context.pluginId, scopeId: call.scopeId,
    groupWid, ...(call.groupId ? { groupId: call.groupId } : {}), requiresCurrentManagedGroupMembership: true, currentManagedGroupMembershipMode: 'effective_scope',
    ...(config.allowMemberCreation ? { allowCurrentManagedGroupMember: true } : {}) });
  if (!permission?.allowed) throw new Error(t('official.poll-assistant.permissionDenied'));
  const caps = await pluginWorkflowGroupCapabilities(context, groupWid);
  if (!caps.botIsAdmin || !caps.canSend) throw new Error(t('official.poll-assistant.botCapabilityUnavailable'));
  const closing = input?.definition.closing;
  if (closing?.kind === 'deadline') {
    const duration = closing.deadline.mode === 'at' ? (Date.parse(closing.deadline.closesAt) - Date.now()) / 60000 : closing.deadline.durationMinutes;
    if (duration <= 0 || duration > config.maxDeadlineMinutes) throw new Error(t('official.poll-assistant.completionClosingInvalid', { maximumMinutes: config.maxDeadlineMinutes }));
  }
  if (input?.definition.electorate.kind === 'actor') throw new Error('Interactive creation requires a group electorate');
  return { actor, config, t };
}

async function inspectOperation(context: PluginServiceRegistrationContext, operationId: string, call: PluginServiceCallContext): Promise<WorkflowActionResult> {
  const current = await requester(context, call);
  const db = pollsDatabase(context.databases);
  const row = db.get<{ poll_id: string }>('SELECT poll_id FROM poll_workflow_operations WHERE operation_id = ? AND scope_id = ? AND actor_identity_id = ?', operationId, call.scopeId, call.actorIdentityId!);
  if (!row) return { status: 'blocked', reason: current.t('official.poll-assistant.outcome.unavailable'), retryable: false };
  const aggregate = getPollAggregate(db, row.poll_id)!;
  const round = aggregate.rounds[0]!;
  if (aggregate.poll.status === 'cancelled') return { status: 'blocked', reason: current.t('official.poll-assistant.outcome.status.cancelled'), retryable: false };
  return round.pollWaMessageId && round.publishedAt
    ? { status: 'completed', output: { pollId: aggregate.poll.id, roundId: round.id, messageId: round.pollWaMessageId }, summary: current.t('official.poll-assistant.outcome.created', { question: aggregate.poll.definition.question, pollId: aggregate.poll.id }) }
    : { status: 'pending', operationId, summary: current.t('official.poll-assistant.outcome.publicationPending') };
}
