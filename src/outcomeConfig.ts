import { z } from 'zod';
import { canonicalJson, workflowDigest, workflowProgramSchema, type WorkflowProgram } from '../../../../packages/plugin-sdk/src/workflows';
import type { PollDefinition, PollResult } from './domain';
import { type TranslateFn } from '../../../../packages/plugin-sdk/src/i18n';

/** Presets may suggest a program, but cannot supply the requester's application policy. */
export const pollOutcomePresetSchema = z.object({ program: workflowProgramSchema }).strict();
export const pollOutcomeConfigurationSchema = z.object({
  version: z.literal(1),
  policy: z.enum(['automatic', 'requester_confirmation']),
  program: workflowProgramSchema,
  summary: z.string().min(1).max(50000)
}).strict();
export type PollOutcomeConfiguration = z.infer<typeof pollOutcomeConfigurationSchema>;
export const frozenPollOutcomeSchema = pollOutcomeConfigurationSchema.extend({
  requesterIdentityId: z.string().min(1),
  requesterChatId: z.string().min(1),
  approvedAt: z.string().datetime({ offset: true }),
  approvalSourceId: z.string().min(1),
  programDigest: z.string().length(64)
}).strict();
export type FrozenPollOutcome = z.infer<typeof frozenPollOutcomeSchema>;

export const pollOutcomeResultFields = [
  { path: ['status'], type: 'string', values: ['selected', 'counted', 'measured', 'quorum_not_met', 'no_decision'] },
  { path: ['winnerOptionId'], type: 'string' },
  { path: ['selectedOptionIds'], type: 'array', items: { type: 'string' } },
  { path: ['total'], type: 'number' },
  { path: ['responseCount'], type: 'number' },
  { path: ['turnoutBasisPoints'], type: 'number' },
  { path: ['quorumMet'], type: 'boolean' }
] as const;

export const pollOutcomeResultSchema: Record<string, unknown> = {
  type: 'object', properties: Object.fromEntries(pollOutcomeResultFields.map((field) => [field.path[0], {
    type: field.type, ...('values' in field ? { enum: field.values } : {}), ...('items' in field ? { items: field.items } : {})
  }]))
};

export function pollOutcomeResult(result: PollResult, resolution?: readonly string[]): Record<string, unknown> | undefined {
  const outcome = result.outcome;
  if (outcome.status === 'tie' && !resolution) return undefined;
  const selected = outcome.status === 'selected' ? outcome.selectedOptionIds
    : outcome.status === 'tie' ? [...outcome.certainOptionIds, ...resolution!] : [];
  return { pollId: result.pollId, roundId: result.roundId, purpose: result.purpose,
    status: outcome.status === 'tie' ? 'selected' : outcome.status,
    quorumMet: result.quorumMet, responseCount: result.responseCount, turnoutBasisPoints: result.turnoutBasisPoints,
    selectedOptionIds: selected, winnerOptionId: selected.length === 1 ? selected[0]! : null,
    total: outcome.status === 'counted' ? outcome.total : null,
    result };
}

/** Resolve preset option references once, then persist only the actual stable IDs. */
export function canonicalPollOutcomeProgram(program: WorkflowProgram, definition: PollDefinition): WorkflowProgram {
  const option = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    if (definition.options.some((option) => option.id === value)) return value;
    const byLabel = definition.options.filter((option) => option.label === value);
    const byOrdinal = /^option:[1-9]\d*$/.test(value) ? definition.options.find((option) => option.ordinal === Number(value.slice(7))) : undefined;
    if (byLabel.length === 1) return byLabel[0]!.id;
    if (byOrdinal) return byOrdinal.id;
    throw new Error(`Unknown poll option reference: ${value}`);
  };
  const copy = workflowProgramSchema.parse(JSON.parse(canonicalJson(program)));
  for (const node of copy.nodes) {
    delete node.prepared;
    if (!node.conditions.length) throw new Error('Each poll action requires an explicit result condition');
    for (const condition of node.conditions) {
      const field = pollOutcomeResultFields.find((field) => canonicalJson(field.path) === canonicalJson(condition.path));
      if (!field) throw new Error('Unsupported poll result condition');
      if (field.type === 'array') {
        if (condition.operator !== 'includes' || typeof condition.value !== 'string') throw new Error('Selected option conditions require includes and one option');
      } else if (field.type === 'number') {
        if (condition.operator === 'includes' || typeof condition.value !== 'number' || !Number.isFinite(condition.value)) throw new Error('Numeric poll conditions require a number');
      } else if (condition.operator !== 'eq' || typeof condition.value !== field.type) throw new Error('Poll condition type or operator is invalid');
      if ('values' in field && !(field.values as readonly unknown[]).includes(condition.value)) throw new Error('Unknown poll outcome status');
      if (['gt', 'gte', 'lt', 'lte'].includes(condition.operator) && (field.type !== 'number' || typeof condition.value !== 'number')) throw new Error('Numeric poll conditions require a number');
      if (condition.path[0] === 'total' && definition.purpose !== 'count') throw new Error('Totals require a count poll');
      if (['winnerOptionId', 'selectedOptionIds'].includes(condition.path[0]!)) {
        if (definition.purpose !== 'decide') throw new Error('Option outcomes require a decision poll');
        condition.value = option(condition.value);
      }
    }
    for (const binding of node.bindings) {
      if (binding.source.kind !== 'result') continue;
      const field = pollOutcomeResultFields.find((field) => canonicalJson(field.path) === canonicalJson(binding.source.path));
      if (!field) throw new Error('Unsupported poll result binding');
      if (binding.source.path[0] === 'total' && definition.purpose !== 'count') throw new Error('Totals require a count poll');
      if (['winnerOptionId', 'selectedOptionIds'].includes(binding.source.path[0]!) && definition.purpose !== 'decide') throw new Error('Option outcomes require a decision poll');
      if (binding.source.path[0] === 'winnerOptionId') {
        if (!binding.mapping?.length) throw new Error('Winner bindings require explicit option mappings');
        binding.mapping = binding.mapping.map((entry) => ({ from: option(entry.from), to: entry.to }));
        const coverage = new Set(binding.mapping.map((entry) => entry.from));
        const constrainedWinner = node.conditions.find((condition) => condition.path[0] === 'winnerOptionId' && condition.operator === 'eq');
        const required = constrainedWinner ? [constrainedWinner.value] : definition.options.map((option) => option.id);
        if (required.some((id) => !coverage.has(id))) throw new Error('Every eligible winning option needs a mapping');
      }
    }
    // No-decision and insufficient-turnout outcomes must be deliberately selected.
    if (!node.conditions.some((condition) => ['status', 'quorumMet'].includes(condition.path[0]!))) {
      node.conditions.unshift({ path: ['quorumMet'], operator: 'eq', value: true });
    }
  }
  return copy;
}

export function freezePollOutcome(input: PollOutcomeConfiguration, approval: Omit<FrozenPollOutcome, keyof PollOutcomeConfiguration | 'programDigest'>): FrozenPollOutcome {
  if (input.program.nodes.some((node) => !node.prepared)) throw new Error('Poll actions must be prepared before approval');
  return frozenPollOutcomeSchema.parse({ ...input, ...approval, programDigest: workflowDigest(input.program) });
}

export function renderPollOutcomeProgram(program: WorkflowProgram, definition: PollDefinition, t: TranslateFn): string {
  const display = (value: unknown): string => definition.options.find((option) => option.id === value)?.label
    ?? (Array.isArray(value) ? value.map(display).join(', ') : value && typeof value === 'object'
      ? Object.entries(value).map(([key, item]) => `${key}: ${display(item)}`).join('; ') : String(value));
  return program.nodes.map((node) => {
    const conditions = node.conditions.map((condition) => `${t(`official.poll-assistant.outcome.field.${condition.path[0]}`)} ${condition.operator} ${display(condition.value)}`).join('; ');
    const mappings = node.bindings.flatMap((binding) => (binding.mapping ?? []).map((mapping) =>
      `${display(mapping.from)} → ${binding.inputPath.join('.')}: ${display(mapping.to)}`));
    return `${node.id}: ${node.prepared!.summary}\n${t('official.poll-assistant.outcome.conditions')}: ${conditions}`
      + (mappings.length ? '\n' + mappings.join('\n') : '')
      + `\n${t('official.poll-assistant.outcome.dependencies')}: ${node.dependsOn.join(', ') || '-'}`;
  }).join('\n\n');
}
