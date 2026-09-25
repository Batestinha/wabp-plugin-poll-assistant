import { z } from 'zod';
import { type PluginServiceRegistrationContext } from './runtime';
import type { PluginServiceRegistration, PluginServiceCallContext } from '@wabs/plugin-sdk/services';
import { pluginWorkflowGroupCapabilities } from '@wabs/plugin-sdk/durable-plugin';
import { canonicalJson, workflowDigest, preparedActionSchema, workflowActionResultSchema, type WorkflowActionResult, type WorkflowProgram } from '@wabs/plugin-sdk/workflows';
import { parsePollAssistantConfig } from './config';
import { POLL_CREATE_ACTION_SERVICE, pollCreateAction, pollCreateActionInputSchema, pollCreateActionDraftInputSchema } from './createActionApi';
import { flowPreferences, resolvePollCreationPreset } from './commands';
import { createPoll, getPollAggregate, pollsDatabase } from './store';
import { enqueuePollPublishJob } from './jobs';
import { canonicalPollOutcomeProgram, freezePollOutcome, renderPollOutcomeProgram, pollOutcomeResultSchema } from './outcomeConfig';
import { pollConfigurationValues, renderPollConfiguration } from './announcements';
import { renderPollTemplate } from './templates';
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
      const draft = pollCreateActionDraftInputSchema.parse(request.input);
      const current = await requester(context, call, { groupWid: draft.groupWid });
      const input = pollCreateActionInputSchema.parse({
        groupWid: draft.groupWid,
        definition: resolveCreationDefinition(draft.definition, current.config, draft.presetId),
        ...(draft.outcome ? { outcome: draft.outcome } : {})
      });
      await requester(context, call, input);
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
      const options = input.definition.options.map((option) => renderPollTemplate({ kind: 'proposalOption', overrides: current.config.messages, t: current.t, values: {
        ordinal: option.ordinal, label: option.label, numericValue: option.numericValue,
        option: `${option.label}${option.numericValue !== undefined ? ` = ${option.numericValue}` : ''}`
      } })).join('\n');
      const proposalText = renderPollTemplate({ kind: 'assistantProposal', overrides: current.config.messages, t: current.t, values: {
        question: input.definition.question, options,
        ...pollConfigurationValues(input.definition, current.t, current.config.timezone),
        ...(outcome && input.outcome ? { consequences: renderPollOutcomeProgram(outcome, input.definition, current.t),
          policy: current.t(`official.poll-assistant.outcome.policy.${input.outcome.policy}`) } : {})
      } });
      return { input, summary, proposalText, entries: [
        { title: current.t('official.poll-assistant.outcome.entry.question'), value: input.definition.question },
        { title: current.t('official.poll-assistant.outcome.entry.options'), value: options },
        { title: current.t('official.poll-assistant.outcome.entry.rule'), value: renderPollConfiguration(input.definition, current.t, current.config.timezone) },
        ...(outcome ? [{ title: current.t('official.poll-assistant.outcome.entry.consequences'), value: renderPollOutcomeProgram(outcome, input.definition, current.t) }] : [])
      ], guard: { inputDigest: workflowDigest(input), ...(outcome ? { outcome } : {}) },
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

export function resolveCreationDefinition(raw: Record<string, unknown>, config: ReturnType<typeof parsePollAssistantConfig>, requestedPresetId?: string) {
  const selection = resolvePollCreationPreset(config, requestedPresetId);
  if (selection.kind === 'not_found') throw new Error(`Poll creation preset ${selection.presetId} is unavailable`);
  const preset = selection.preset;
  // A guided-flow "ask" field still has an operator value in its preset.
  // When a natural-language request omits that field, propose that value.
  const preferences = flowPreferences(config, preset ? {
    ...preset,
    closing: { ...preset.closing, mode: 'suggest' },
    quorum: { ...preset.quorum, mode: 'suggest' }
  } : undefined);
  const fixed = (field: string, mode: string | undefined, supplied: unknown, value: unknown) => {
    if (mode === 'fixed' && supplied !== undefined && workflowDigest(supplied) !== workflowDigest(value)) {
      throw new Error(`Poll creation preset fixes ${field}`);
    }
    return supplied ?? value;
  };
  const purpose = fixed('purpose', preset?.purpose.mode, raw.purpose, preset?.purpose.value ?? 'decide');
  const ballotDelivery = fixed('ballotDelivery', preset?.ballotDelivery.mode, raw.ballotDelivery, preset?.ballotDelivery.value ?? 'group');
  const voterDisclosure = fixed('voterDisclosure', preset?.voterDisclosure.mode, raw.voterDisclosure, preset?.voterDisclosure.value ?? 'named');
  const closing = preferences.defaultClosing.kind === 'manual'
    ? { kind: 'manual' }
    : { kind: 'deadline', deadline: preferences.defaultClosing.kind === 'deadline'
      ? { mode: 'after_publish', durationMinutes: preferences.defaultClosing.durationMinutes }
      : { mode: 'after_first_non_creator_response', durationMinutes: preferences.defaultClosing.durationMinutes,
        activationTimeoutMinutes: preferences.defaultClosing.activationTimeoutMinutes } };
  const rule = purpose === 'count'
    ? { kind: 'sum', unit: preset?.countUnit.value ?? 'items' }
    : purpose === 'measure'
      ? preset?.measureRule.kind === 'ordered_scale' ? { kind: 'ordered_scale' }
        : { kind: 'distribution', allowMultipleAnswers: preset?.measureRule.kind === 'distribution_multiple' }
      : preset?.decideRule.kind === 'single_non_transferable' || preset?.decideRule.kind === 'multiwinner_approval'
        ? { kind: preset.decideRule.kind, seats: preset.decideRule.seats }
        : preset?.decideRule.kind === 'approve_reject'
          ? { kind: 'approve_reject', approveOptionId: (raw.options as Array<{ id: string }> | undefined)?.[0]?.id,
            rejectOptionId: (raw.options as Array<{ id: string }> | undefined)?.[1]?.id,
            minimumApprovalBasisPoints: preset.decideRule.minimumApprovalBasisPoints }
          : { kind: preset?.decideRule.kind ?? 'plurality' };
  const ruleMode = purpose === 'count' ? preset?.countUnit.mode : purpose === 'measure' ? preset?.measureRule.mode : preset?.decideRule.mode;
  const result = pollDefinitionSchema.parse({
    schemaVersion: raw.schemaVersion ?? 1,
    id: raw.id ?? 'draft',
    ...raw,
    purpose,
    rule: fixed('rule', ruleMode, raw.rule, rule),
    closing: fixed('closing', preset?.closing.mode, raw.closing, closing),
    quorum: fixed('quorum', preset?.quorum.mode, raw.quorum, preferences.defaultQuorum),
    ballotDelivery,
    voterDisclosure,
    electorate: raw.electorate ?? { kind: ballotDelivery === 'private' ? 'group_members_until_cutoff' : 'members_at_publication' },
    ...(purpose === 'decide' ? { tiePolicy: fixed('tiePolicy', preset?.tiePolicy.mode, raw.tiePolicy,
      { kind: preset?.tiePolicy.kind ?? 'no_decision' }) } : {})
  });
  if (result.purpose === 'count' && result.options.some((option) => option.numericValue === 0)) {
    throw new Error('Count poll option values must be greater than zero.');
  }
  return result;
}

async function requester(context: PluginServiceRegistrationContext, call: PluginServiceCallContext,
  input?: { groupWid: string; definition?: z.infer<typeof pollDefinitionSchema> }) {
  if (!call.actorIdentityId || !context.resolveStableIdentityById || !await context.enabledFor(call.scopeId)) throw new Error('Poll requester unavailable');
  const actor = await context.resolveStableIdentityById(call.actorIdentityId);
  if (actor.identityId !== call.actorIdentityId) throw new Error('Requester identity mismatch');
  const config = parsePollAssistantConfig(await context.configFor(call.scopeId, actor.identityId));
  const t = await context.i18n.translatorForScope(call.scopeId);
  if (!config.allowCreation) throw new Error(t('official.poll-assistant.creationDisabled'));
  const groupWid = input?.groupWid ?? call.groupWid;
  if (!groupWid || (call.groupWid && groupWid !== call.groupWid)) throw new Error(t('official.poll-assistant.groupRequired'));
  const permission = await context.explainPermission?.({ actorIdentityId: actor.identityId, action: 'polls.create', pluginId: context.pluginId, scopeId: call.scopeId,
    groupWid, ...(call.groupId ? { groupId: call.groupId } : {}), requiresCurrentManagedGroupMembership: true, currentManagedGroupMembershipMode: 'effective_scope',
    ...(config.allowMemberCreation ? { allowCurrentManagedGroupMember: true } : {}) });
  if (!permission?.allowed) throw new Error(t('official.poll-assistant.permissionDenied'));
  const caps = await pluginWorkflowGroupCapabilities(context, groupWid);
  if (!caps.botIsAdmin || !caps.canSend) throw new Error(t('official.poll-assistant.botCapabilityUnavailable'));
  const closing = input?.definition?.closing;
  if (closing?.kind === 'deadline') {
    const duration = closing.deadline.mode === 'at' ? (Date.parse(closing.deadline.closesAt) - Date.now()) / 60000 : closing.deadline.durationMinutes;
    if (duration <= 0 || duration > config.maxDeadlineMinutes) throw new Error(t('official.poll-assistant.completionClosingInvalid', { maximumMinutes: config.maxDeadlineMinutes }));
  }
  if (input?.definition?.electorate.kind === 'actor') throw new Error('Interactive creation requires a group electorate');
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
