import type { FlowDefinition, FlowState, FlowStep } from '../../../adminBot/flows/flowTypes';
import type { FlowEngine } from '../../../adminBot/flows/flowEngine';
import type { TranslateFn } from '../../../platform/i18n';
import type { WorkflowNode, WorkflowProgram, WorkflowPrincipal } from '../../../platform/workflows/contracts';
import { workflowProgramSchema } from '../../../platform/workflows/contracts';
import { workflowFormFields, parseWorkflowFormValue, setWorkflowFormValue, type WorkflowFormField } from '../../../platform/workflows/form';
import { canonicalPollOutcomeProgram, pollOutcomeConfigurationSchema, renderPollOutcomeProgram, pollOutcomeResultSchema, type PollOutcomeConfiguration } from './outcomeConfig';
import { pollCreationAnswers, pollDefinitionFromCreationAnswers } from './flow';
import type { PollCreationRecipe } from './flowStarter';

const key = (name: string) => `outcome-${name}`;
export const POLL_OUTCOME_REVIEW_KEY = key('review');
interface Selection { actionId: string; version: number; inputSchema: Record<string, unknown>; targetPath?: string[]; candidates: { id: string; label: string }[] }
interface Target { input: Record<string, unknown>; fields: WorkflowFormField[] }
const value = <T>(state: FlowState, name: string): T => state.data[key(name)] as T;
const picked = (state: FlowState, name: string) => (value<string[]>(state, name) ?? [])[0];

/** The same generic provider metadata drives this chat form and the console builder. */
export function attachPollOutcomeFlow(definition: FlowDefinition, engine: FlowEngine, recipe: PollCreationRecipe, t: TranslateFn): FlowDefinition {
  if (!engine.workflowActions) {
    if (recipe.preferences.preset?.outcome) throw new Error('Poll outcome catalog unavailable');
    return definition;
  }
  const catalog = engine.workflowActions;
  const principal: WorkflowPrincipal = { runtimeBindingId: engine.workflowRuntimeBindingId, source: 'poll_outcome',
    scopeId: recipe.scopeId, actorIdentityId: recipe.actorIdentityId, chatId: recipe.actorWid,
    groupWid: recipe.originGroupWid, ...(recipe.originGroupId ? { groupId: recipe.originGroupId } : {}) };
  const tr = (name: string, params: Record<string, string | number> = {}) => t(`official.poll-assistant.outcome.${name}`, params);
  const preset = recipe.preferences.preset?.outcome;
  const program = (state: FlowState): WorkflowProgram => picked(state, 'enabled') === 'preset'
    ? preset!.program : value<WorkflowProgram>(state, 'save') ?? { version: 1, nodes: [] };
  const choices = (name: string, options: { value: string; label: string }[], next?: string): FlowStep => ({ id: key(name), kind: 'choice',
    prompt: tr(`flow.${name}`), options, minSelections: 1, maxSelections: 1, ...(next ? { nextStepId: key(next) } : {}) });
  const textStep = (name: string, next: string, prompt: (state: FlowState) => string,
    parse: (state: FlowState, text: string) => unknown | Promise<unknown>): FlowStep => ({ id: key(name), kind: 'text',
    prompt: tr(`flow.${name}`), promptForState: prompt, nextStepId: key(next),
    resolveInputAsync: async ({ state, input }) => {
      try { return { status: 'use-value', value: await parse(state, input) }; }
      catch (error) { return { status: 'error', reply: tr('invalid', { reason: error instanceof Error ? error.message : String(error) }) }; }
    } });
  const steps: Record<string, FlowStep> = {};
  steps[key('enabled')] = { ...choices('enabled', [
    { value: 'none', label: tr('none') }, { value: 'configure', label: tr('configure') },
    ...(preset ? [{ value: 'preset', label: tr('usePreset') }] : [])
  ]), nextStepIdByValue: { none: 'confirm', configure: key('catalog'), preset: key('policy') } };
  steps[key('catalog')] = textStep('catalog', 'action', () => tr('flow.catalog'), async (_state, input) => {
    if (input !== tr('continue')) throw new Error(tr('continue'));
    return (await catalog.list(principal)).map((action) => ({ ...action, label: t(action.titleKey) }));
  });
  steps[key('action')] = textStep('action', 'target', (state) => tr('flow.action') + '\n' +
    (value<{ actionId: string; label: string }[]>(state, 'catalog') ?? []).map((action, index) => `${index + 1}. ${action.label}`).join('\n'), async (state, input) => {
    const actions = value<{ actionId: string; version: number; label: string; inputSchema: Record<string, unknown> }[]>(state, 'catalog');
    const action = select(actions, input, (entry) => [entry.actionId, entry.label]);
    const description = await catalog.describe(principal, action.actionId, action.version, {}) as Record<string, unknown>;
    return { actionId: action.actionId, version: action.version, inputSchema: action.inputSchema,
      targetPath: workflowFormFields(action.inputSchema).find((field) => field.target)?.path ?? [],
      candidates: description.candidates ?? [] };
  });
  steps[key('target')] = textStep('target', 'input', (state) => tr('flow.target') + '\n' +
    (value<Selection>(state, 'action')?.candidates ?? []).map((candidate, index) => `${index + 1}. ${candidate.label}`).join('\n'), async (state, input) => {
    const action = value<Selection>(state, 'action');
    const target: Record<string, unknown> = {};
    if (action.targetPath?.length) setWorkflowFormValue(target, action.targetPath, select(action.candidates, input, (entry) => [entry.id, entry.label]).id);
    const description = await catalog.describe(principal, action.actionId, action.version, target) as { fields?: WorkflowFormField[] };
    const dynamic = (description.fields ?? []).filter((field) => Array.isArray(field.path));
    return { input: target, fields: [...workflowFormFields(action.inputSchema).filter((field) => !field.target), ...dynamic] };
  });
  steps[key('input')] = textStep('input', 'condition', (state) => tr('flow.input') + '\n' +
    (value<Target>(state, 'target')?.fields ?? []).map((field) => `${field.path.join('.')} — ${field.label}${field.values ? ` (${field.values.join(', ')})` : ''}`).join('\n'), (state, input) => {
    const target = value<Target>(state, 'target');
    const output = structuredClone(target.input);
    if (input !== '-') for (const line of input.split('\n').filter((line) => line.trim())) {
      const separator = line.indexOf('=');
      if (separator < 1) throw new Error(tr('flow.input'));
      const field = target.fields.find((field) => [field.path.join('.'), field.label].includes(line.slice(0, separator).trim()));
      if (!field) throw new Error(tr('unknownField'));
      setWorkflowFormValue(output, field.path, parseWorkflowFormValue(field, line.slice(separator + 1)));
    }
    return output;
  });
  steps[key('condition')] = textStep('condition', 'binding', (state) => tr('flow.condition') + '\n' + pollOptions(state).map((option) => option.label).join('\n'), (state, input) => {
    if (input === 'selected') return [{ path: ['status'], operator: 'eq', value: 'selected' }];
    if (input === 'measured') return [{ path: ['status'], operator: 'eq', value: 'measured' }];
    if (input === 'quorum_not_met' || input === 'no_decision') return [{ path: ['status'], operator: 'eq', value: input }];
    const threshold = /^total\s*(>=|>|<=|<)\s*(-?\d+(?:\.\d+)?)$/.exec(input);
    if (threshold) return [{ path: ['status'], operator: 'eq', value: 'counted' }, { path: ['total'], operator: ({ '>=': 'gte', '>': 'gt', '<=': 'lte', '<': 'lt' } as Record<string, string>)[threshold[1]!], value: Number(threshold[2]) }];
    const option = select(pollOptions(state), input, (entry) => [entry.id, entry.label]);
    return [{ path: ['selectedOptionIds'], operator: 'includes', value: option.id }];
  });
  steps[key('binding')] = textStep('binding', 'mapping', () => tr('flow.binding'), (state, input) => {
    if (input === '-') return null;
    const field = value<Target>(state, 'target').fields.find((field) => [field.path.join('.'), field.label].includes(input));
    if (!field) throw new Error(tr('unknownField'));
    return field;
  });
  steps[key('mapping')] = textStep('mapping', 'dependencies', () => tr('flow.mapping'), (state, input) => {
    const field = value<WorkflowFormField | null>(state, 'binding');
    if (!field) return [];
    const mapping = input.split('\n').filter(Boolean).map((line) => {
      const separator = line.indexOf('=');
      const option = select(pollOptions(state), line.slice(0, separator).trim(), (entry) => [entry.id, entry.label]);
      return { from: option.id, to: parseWorkflowFormValue(field, line.slice(separator + 1)) };
    });
    return [{ inputPath: field.path, source: { kind: 'result', path: ['winnerOptionId'] }, mapping }];
  });
  steps[key('dependencies')] = textStep('dependencies', 'save', (state) => tr('flow.dependencies') + '\n' + program(state).nodes.map((node) => `${node.id}: ${node.prepared?.summary ?? node.actionId}`).join('\n'), (state, input) => {
    if (input === '-') return [];
    return input.split(',').map((id) => select(program(state).nodes, id.trim(), (entry) => [entry.id]).id);
  });
  steps[key('save')] = { ...textStep('save', 'policy', () => tr('flow.save'), async (state, input) => {
    if (![tr('addAnother'), tr('continue')].includes(input)) throw new Error(tr('flow.save'));
    const action = value<Selection>(state, 'action');
    const previous = program(state);
    const node: WorkflowNode = { id: `action-${previous.nodes.length + 1}`, actionId: action.actionId, version: action.version,
      input: value(state, 'input'), conditions: value(state, 'condition'), bindings: value(state, 'mapping'), dependsOn: value(state, 'dependencies') };
    return { ...await catalog.prepareProgram(principal, canonicalPollOutcomeProgram(workflowProgramSchema.parse({ version: 1, nodes: [...previous.nodes, node] }), pollDefinition(state)), pollOutcomeResultSchema), more: input === tr('addAnother') };
  }), nextStepIdForState: (state) => value<{ more?: boolean }>(state, 'save')?.more ? key('action') : key('policy') };
  steps[key('policy')] = choices('policy', [
    { value: 'requester_confirmation', label: tr('policy.requester_confirmation') }, { value: 'automatic', label: tr('policy.automatic') }
  ], 'review');
  steps[POLL_OUTCOME_REVIEW_KEY] = { ...textStep('review', 'review', () => tr('flow.review'), async (state, input) => {
    if (input !== tr('continue')) throw new Error(tr('continue'));
    const candidate = program(state);
    const prepared = await catalog.prepareProgram(principal, canonicalPollOutcomeProgram({ version: 1, nodes: candidate.nodes }, pollDefinition(state)), pollOutcomeResultSchema);
    return pollOutcomeConfigurationSchema.parse({ version: 1, policy: picked(state, 'policy'), program: prepared,
      summary: renderPollOutcomeProgram(prepared, pollDefinition(state), t) });
  }), nextStepId: 'confirm' };
  const final = definition.steps.confirm!;
  const beforeOutcome = Object.fromEntries(Object.entries(definition.steps).map(([id, step]) => [id, { ...step,
    ...(step.nextStepId === 'confirm' ? { nextStepId: key('enabled') } : {}),
    ...(step.nextStepIdByValue ? { nextStepIdByValue: Object.fromEntries(Object.entries(step.nextStepIdByValue).map(([value, next]) => [value, next === 'confirm' ? key('enabled') : next])) } : {}),
    ...(step.nextStepIdForState ? { nextStepIdForState: (state: FlowState) => { const next = step.nextStepIdForState!(state); return next === 'confirm' ? key('enabled') : next; } } : {})
  }]));
  return { ...definition, initialStepId: definition.initialStepId === 'confirm' ? key('enabled') : definition.initialStepId, steps: { ...beforeOutcome, ...steps,
    confirm: { ...final, promptForState: (state) => (final.promptForState?.(state) ?? final.prompt) +
      (pollOutcomeFromFlow(state) ? '\n\n' + tr('published', { summary: pollOutcomeFromFlow(state)!.summary,
        policy: tr(`policy.${pollOutcomeFromFlow(state)!.policy}`) }) : '') } } };

  function pollDefinition(state: FlowState) {
    const answers = pollCreationAnswers({ state } as Parameters<typeof pollCreationAnswers>[0]);
    if (!answers) throw new Error(tr('invalidPoll'));
    return pollDefinitionFromCreationAnswers({ pollId: recipe.pollId, answers });
  }
  function pollOptions(state: FlowState) { return pollDefinition(state).options; }
}

export function pollOutcomeFromFlow(state: FlowState): PollOutcomeConfiguration | undefined {
  if ((state.data[key('enabled')] as string[] | undefined)?.[0] === 'none') return undefined;
  const parsed = pollOutcomeConfigurationSchema.safeParse(state.data[POLL_OUTCOME_REVIEW_KEY]);
  return parsed.success ? parsed.data : undefined;
}
function select<T>(options: T[], input: string, labels: (entry: T) => string[]): T {
  const exact = options.filter((entry) => labels(entry).includes(input));
  if (exact.length === 1) return exact[0]!;
  const index = /^\d+$/.test(input) ? Number(input) - 1 : -1;
  if (index >= 0 && options[index]) return options[index]!;
  throw new Error('Choose one of the listed options');
}
