import { randomUUID } from 'node:crypto';
import type { FlowDefinition, FlowState, FlowStep } from '@wabs/plugin-sdk/flow-types';
import { type FlowSessionSnapshot } from '@wabs/plugin-sdk/flow-engine';
import { type TranslateFn } from '@wabs/plugin-sdk/i18n';
import { chronoParserForLocale } from '@wabs/plugin-sdk/chrono-locale';
import { parseLocalizedDateTimeInput } from '@wabs/plugin-sdk/localized-date-time';
import {
  WHATSAPP_POLL_MAX_OPTIONS,
  WHATSAPP_POLL_MIN_OPTIONS,
  numberPollOptions,
  validatePollContent
} from '@wabs/plugin-sdk/poll-contract';
import type { PollCreationPreset } from './config';
import { countUnitSchema, pollDefinitionSchema, type PollDefinition } from './domain';

export const POLL_CREATION_FLOW_TYPE_PREFIX = 'official.poll-assistant.create.';
export const POLL_CREATION_CONFIRM_STEP_ID = 'confirm';

const PURPOSE_STEP_ID = 'purpose';
const DECIDE_QUESTION_STEP_ID = 'decide-question';
const DECIDE_OPTIONS_STEP_ID = 'decide-options';
const DECIDE_RULE_STEP_ID = 'decide-rule';
const DECIDE_SEATS_STEP_ID = 'decide-seats';
const DECIDE_THRESHOLD_STEP_ID = 'decide-threshold';
const MEASURE_QUESTION_STEP_ID = 'measure-question';
const MEASURE_OPTIONS_STEP_ID = 'measure-options';
const MEASURE_RULE_STEP_ID = 'measure-rule';
const COUNT_QUESTION_STEP_ID = 'count-question';
const COUNT_UNIT_STEP_ID = 'count-unit';
const COUNT_OPTIONS_STEP_ID = 'count-options';
const BALLOT_DELIVERY_STEP_ID = 'ballot-delivery';
const VOTER_DISCLOSURE_STEP_ID = 'voter-disclosure';
const CONFIRM_VALUE = 'yes';

export type PollCreationPurpose = 'decide' | 'measure' | 'count';
export type PollCreationClosingAnswer =
  | { kind: 'manual' }
  | { kind: 'after_publish_duration'; durationMinutes: number }
  | {
      kind: 'after_first_non_creator_response';
      durationMinutes: number;
      activationTimeoutMinutes: number;
    }
  | { kind: 'deadline'; closesAt: string };
export type PollCreationQuorumAnswer =
  | { kind: 'none' }
  | { kind: 'absolute'; minimumResponses: number }
  | { kind: 'percentage'; minimumTurnoutBasisPoints: number };

export interface PollCreationOptionAnswer {
  label: string;
  numericValue?: number | undefined;
}

export interface PollCreationFlowPreferences {
  timezone: string;
  maxDeadlineMinutes: number;
  defaultClosing:
    | { kind: 'manual' }
    | { kind: 'deadline'; durationMinutes: number }
    | {
        kind: 'after_first_non_creator_response';
        durationMinutes: number;
        activationTimeoutMinutes: number;
      };
  defaultQuorum: PollCreationQuorumAnswer;
  preset?: PollCreationPreset | undefined;
}

export type PollCreationRuleAnswer =
  | { purpose: 'decide'; kind: 'plurality' }
  | { purpose: 'decide'; kind: 'single_non_transferable'; seats: number }
  | { purpose: 'decide'; kind: 'approval' }
  | { purpose: 'decide'; kind: 'multiwinner_approval'; seats: number }
  | { purpose: 'decide'; kind: 'approve_reject'; minimumApprovalBasisPoints: number }
  | { purpose: 'measure'; kind: 'distribution'; allowMultipleAnswers: boolean }
  | { purpose: 'measure'; kind: 'ordered_scale' }
  | { purpose: 'count'; kind: 'sum'; unit: string };

export interface PollCreationAnswers {
  purpose: PollCreationPurpose;
  question: string;
  options: PollCreationOptionAnswer[];
  rule: PollCreationRuleAnswer;
  closing: PollCreationClosingAnswer;
  quorum: PollCreationQuorumAnswer;
  ballotDelivery: 'group' | 'private';
  voterDisclosure: 'named' | 'hidden';
  tiePolicy?: 'no_decision' | 'authorized_choice' | 'status_quo' | 'random_draw' | undefined;
}

export function createPollCreationFlowDefinition(input: {
  t: TranslateFn;
  locale: string;
  preferences: PollCreationFlowPreferences;
  flowInstanceId?: string | undefined;
  initialData?: Record<string, unknown> | undefined;
}): FlowDefinition {
  const flowInstanceId = input.flowInstanceId?.trim() || randomUUID();
  return buildPollCreationFlowDefinition({
    flowType: `${POLL_CREATION_FLOW_TYPE_PREFIX}${flowInstanceId}`,
    t: input.t,
    locale: input.locale,
    preferences: input.preferences,
    initialData: input.initialData ?? {}
  });
}

export function restorePollCreationFlowDefinition(input: {
  flowType: string;
  t: TranslateFn;
  locale: string;
  preferences: PollCreationFlowPreferences;
  initialData: Record<string, unknown>;
}): FlowDefinition {
  if (!isPollCreationFlowType(input.flowType)) {
    throw new Error(`Invalid Poll Assistant creation flow type: ${input.flowType || '(empty)'}.`);
  }
  return buildPollCreationFlowDefinition(input);
}

export function isPollCreationFlowType(flowType: string): boolean {
  return flowType.startsWith(POLL_CREATION_FLOW_TYPE_PREFIX)
    && flowType.length > POLL_CREATION_FLOW_TYPE_PREFIX.length;
}

export function pollCreationConfirmPurpose(flowType: string): string {
  if (!isPollCreationFlowType(flowType)) {
    throw new Error(`Invalid Poll Assistant creation flow type: ${flowType || '(empty)'}.`);
  }
  return `flow.${flowType}.${POLL_CREATION_CONFIRM_STEP_ID}`;
}

export function pollCreationFlowConfirmed(snapshot: FlowSessionSnapshot): boolean {
  return selectedValue(snapshot.state.data[POLL_CREATION_CONFIRM_STEP_ID]) === CONFIRM_VALUE;
}

export function pollCreationAnswers(snapshot: FlowSessionSnapshot): PollCreationAnswers | undefined {
  return pollCreationAnswersFromState(snapshot.state);
}

export function pollDefinitionFromCreationAnswers(input: {
  pollId: string;
  answers: PollCreationAnswers;
}): PollDefinition {
  const pollId = input.pollId.trim();
  if (!pollId) {
    throw new Error('A stable poll ID is required to materialize Poll Assistant answers.');
  }
  const options = input.answers.options.map((option, index) => ({
    id: `${pollId}:option:${index + 1}`,
    label: option.label,
    ordinal: index + 1,
    ...(option.numericValue === undefined ? {} : { numericValue: option.numericValue })
  }));
  const closing = input.answers.closing.kind === 'manual'
    ? { kind: 'manual' as const }
    : input.answers.closing.kind === 'deadline'
      ? {
          kind: 'deadline' as const,
          deadline: { mode: 'at' as const, closesAt: input.answers.closing.closesAt }
        }
      : input.answers.closing.kind === 'after_first_non_creator_response'
        ? {
            kind: 'deadline' as const,
            deadline: {
              mode: 'after_first_non_creator_response' as const,
              durationMinutes: input.answers.closing.durationMinutes,
              activationTimeoutMinutes: input.answers.closing.activationTimeoutMinutes
            }
          }
        : {
            kind: 'deadline' as const,
            deadline: {
              mode: 'after_publish' as const,
              durationMinutes: input.answers.closing.durationMinutes
            }
          };
  const base = {
    schemaVersion: 1 as const,
    id: pollId,
    question: input.answers.question,
    options,
    closing,
    quorum: input.answers.quorum,
    electorate: input.answers.ballotDelivery === 'private'
      ? { kind: 'group_members_until_cutoff' as const }
      : { kind: 'members_at_publication' as const },
    ballotDelivery: input.answers.ballotDelivery,
    voterDisclosure: input.answers.voterDisclosure
  };
  if (input.answers.rule.purpose === 'count') {
    return pollDefinitionSchema.parse({
      ...base,
      purpose: 'count',
      rule: { kind: input.answers.rule.kind, unit: input.answers.rule.unit }
    });
  }
  if (input.answers.rule.purpose === 'measure') {
    return pollDefinitionSchema.parse({
      ...base,
      purpose: 'measure',
      rule: input.answers.rule.kind === 'ordered_scale'
        ? { kind: 'ordered_scale' }
        : {
            kind: 'distribution',
            allowMultipleAnswers: input.answers.rule.allowMultipleAnswers
          }
    });
  }
  const rule = input.answers.rule.kind === 'approve_reject'
    ? {
        kind: 'approve_reject' as const,
        approveOptionId: options[0]!.id,
        rejectOptionId: options[1]!.id,
        minimumApprovalBasisPoints: input.answers.rule.minimumApprovalBasisPoints
      }
    : input.answers.rule.kind === 'single_non_transferable'
      || input.answers.rule.kind === 'multiwinner_approval'
      ? { kind: input.answers.rule.kind, seats: input.answers.rule.seats }
      : { kind: input.answers.rule.kind };
  return pollDefinitionSchema.parse({
    ...base,
    purpose: 'decide',
    rule,
    tiePolicy: { kind: input.answers.tiePolicy }
  });
}

function buildPollCreationFlowDefinition(input: {
  flowType: string;
  t: TranslateFn;
  locale: string;
  preferences: PollCreationFlowPreferences;
  initialData: Record<string, unknown>;
}): FlowDefinition {
  const preset = input.preferences.preset;
  const decideRulePreset = preset?.decideRule;
  const countUnitPreset = preset?.countUnit;
  const steps: FlowDefinition['steps'] = {
    [PURPOSE_STEP_ID]: {
      id: PURPOSE_STEP_ID,
      kind: 'choice',
      prompt: input.t('official.poll-assistant.flow.purpose'),
      options: orderedByPreferred([
        { label: input.t('official.poll-assistant.flow.purpose.decide'), value: 'decide' },
        { label: input.t('official.poll-assistant.flow.purpose.measure'), value: 'measure' },
        { label: input.t('official.poll-assistant.flow.purpose.count'), value: 'count' }
      ], input.preferences.preset?.purpose.mode !== 'ask'
        ? input.preferences.preset?.purpose.value ?? 'decide'
        : 'decide'),
      minSelections: 1,
      maxSelections: 1,
      nextStepIdByValue: {
        decide: DECIDE_QUESTION_STEP_ID,
        measure: MEASURE_QUESTION_STEP_ID,
        count: COUNT_QUESTION_STEP_ID
      }
    },
    [DECIDE_QUESTION_STEP_ID]: questionStep(
      DECIDE_QUESTION_STEP_ID,
      input.t('official.poll-assistant.flow.question.decide'),
      DECIDE_OPTIONS_STEP_ID,
      input.t
    ),
    [DECIDE_OPTIONS_STEP_ID]: optionStep({
      id: DECIDE_OPTIONS_STEP_ID,
      prompt: input.t('official.poll-assistant.flow.options.decide'),
      nextStepId: DECIDE_RULE_STEP_ID,
      t: input.t,
      optionBounds: fixedDecideOptionBounds(input.preferences.preset)
    }),
    [DECIDE_RULE_STEP_ID]: {
      id: DECIDE_RULE_STEP_ID,
      kind: 'choice',
      prompt: input.t('official.poll-assistant.flow.rule.decide'),
      options: orderedByPreferred([
        { label: input.t('official.poll-assistant.flow.rule.plurality'), value: 'plurality' },
        {
          label: input.t('official.poll-assistant.flow.rule.singleNonTransferable'),
          value: 'single_non_transferable'
        },
        { label: input.t('official.poll-assistant.flow.rule.approval'), value: 'approval' },
        {
          label: input.t('official.poll-assistant.flow.rule.multiwinnerApproval'),
          value: 'multiwinner_approval'
        },
        { label: input.t('official.poll-assistant.flow.rule.approveReject'), value: 'approve_reject' }
      ], preferredDecideRule(input.preferences.preset)),
      optionsForState: (state) => {
        const options = [
          { label: input.t('official.poll-assistant.flow.rule.plurality'), value: 'plurality' },
          {
            label: input.t('official.poll-assistant.flow.rule.singleNonTransferable'),
            value: 'single_non_transferable'
          },
          { label: input.t('official.poll-assistant.flow.rule.approval'), value: 'approval' },
          {
            label: input.t('official.poll-assistant.flow.rule.multiwinnerApproval'),
            value: 'multiwinner_approval'
          }
        ];
        const available = optionAnswers(state.data[DECIDE_OPTIONS_STEP_ID])?.length === 2
          ? [...options, {
              label: input.t('official.poll-assistant.flow.rule.approveReject'),
              value: 'approve_reject'
            }]
          : options;
        return orderedByPreferred(available, preferredDecideRule(input.preferences.preset));
      },
      minSelections: 1,
      maxSelections: 1,
      nextStepIdByValue: {
        plurality: closingStepId('decide'),
        single_non_transferable: DECIDE_SEATS_STEP_ID,
        approval: closingStepId('decide'),
        multiwinner_approval: DECIDE_SEATS_STEP_ID,
        approve_reject: DECIDE_THRESHOLD_STEP_ID
      }
    },
    [DECIDE_SEATS_STEP_ID]: {
      id: DECIDE_SEATS_STEP_ID,
      kind: 'text',
      prompt: decideRulePreset?.mode === 'suggest'
        ? input.t('official.poll-assistant.flow.seats.suggested', {
            seats: decideRulePreset.seats
          })
        : input.t('official.poll-assistant.flow.seats'),
      resolveInput: (resolution) => resolveSeats(resolution, input.t),
      nextStepId: closingStepId('decide')
    },
    [DECIDE_THRESHOLD_STEP_ID]: {
      id: DECIDE_THRESHOLD_STEP_ID,
      kind: 'text',
      prompt: decideRulePreset?.mode === 'suggest'
        ? input.t('official.poll-assistant.flow.threshold.suggested', {
            threshold: formatBasisPoints(decideRulePreset.minimumApprovalBasisPoints)
          })
        : input.t('official.poll-assistant.flow.threshold'),
      resolveInput: (resolution) => resolvePercentage(resolution.input, {
        minimumBasisPoints: 5_001,
        error: input.t('official.poll-assistant.flow.threshold.invalid')
      }),
      nextStepId: closingStepId('decide')
    },
    [MEASURE_QUESTION_STEP_ID]: questionStep(
      MEASURE_QUESTION_STEP_ID,
      input.t('official.poll-assistant.flow.question.measure'),
      MEASURE_OPTIONS_STEP_ID,
      input.t
    ),
    [MEASURE_OPTIONS_STEP_ID]: optionStep({
      id: MEASURE_OPTIONS_STEP_ID,
      prompt: input.t('official.poll-assistant.flow.options.measure'),
      nextStepId: MEASURE_RULE_STEP_ID,
      t: input.t
    }),
    [MEASURE_RULE_STEP_ID]: {
      id: MEASURE_RULE_STEP_ID,
      kind: 'choice',
      prompt: input.t('official.poll-assistant.flow.rule.measure'),
      options: orderedByPreferred([
        {
          label: input.t('official.poll-assistant.flow.rule.distributionSingle'),
          value: 'distribution_single'
        },
        {
          label: input.t('official.poll-assistant.flow.rule.distributionMultiple'),
          value: 'distribution_multiple'
        },
        { label: input.t('official.poll-assistant.flow.rule.orderedScale'), value: 'ordered_scale' }
      ], input.preferences.preset?.measureRule.mode !== 'ask'
        ? input.preferences.preset?.measureRule.kind ?? 'distribution_single'
        : 'distribution_single'),
      minSelections: 1,
      maxSelections: 1,
      nextStepId: closingStepId('measure')
    },
    [COUNT_QUESTION_STEP_ID]: questionStep(
      COUNT_QUESTION_STEP_ID,
      input.t('official.poll-assistant.flow.question.count'),
      COUNT_UNIT_STEP_ID,
      input.t
    ),
    [COUNT_UNIT_STEP_ID]: {
      id: COUNT_UNIT_STEP_ID,
      kind: 'text',
      prompt: countUnitPreset?.mode === 'suggest'
        ? input.t('official.poll-assistant.flow.unit.suggested', {
            unit: countUnitPreset.value
          })
        : input.t('official.poll-assistant.flow.unit'),
      resolveInput: (resolution) => {
        const unit = countUnitSchema.safeParse(resolution.input);
        return unit.success
          ? { status: 'use-value', value: unit.data }
          : { status: 'error', reply: input.t('official.poll-assistant.flow.unit.invalid') };
      },
      nextStepId: COUNT_OPTIONS_STEP_ID
    },
    [COUNT_OPTIONS_STEP_ID]: optionStep({
      id: COUNT_OPTIONS_STEP_ID,
      prompt: input.t('official.poll-assistant.flow.options.count'),
      nextStepId: closingStepId('count'),
      t: input.t,
      count: true
    }),
    [BALLOT_DELIVERY_STEP_ID]: {
      id: BALLOT_DELIVERY_STEP_ID,
      kind: 'choice',
      prompt: input.t('official.poll-assistant.flow.ballotDelivery'),
      options: ballotDeliveryOptions(input.t, input.preferences.preset),
      optionsForState: () => ballotDeliveryOptions(input.t, input.preferences.preset),
      minSelections: 1,
      maxSelections: 1,
      nextStepId: VOTER_DISCLOSURE_STEP_ID
    },
    [VOTER_DISCLOSURE_STEP_ID]: {
      id: VOTER_DISCLOSURE_STEP_ID,
      kind: 'choice',
      prompt: input.t('official.poll-assistant.flow.voterDisclosure'),
      options: voterDisclosureOptions(input.t, input.preferences.preset, 'group'),
      optionsForState: (state) => voterDisclosureOptions(
        input.t,
        input.preferences.preset,
        selectedValue(state.data[BALLOT_DELIVERY_STEP_ID]) === 'private' ? 'private' : 'group'
      ),
      minSelections: 1,
      maxSelections: 1,
      nextStepId: POLL_CREATION_CONFIRM_STEP_ID
    },
    [POLL_CREATION_CONFIRM_STEP_ID]: {
      id: POLL_CREATION_CONFIRM_STEP_ID,
      kind: 'choice',
      prompt: input.t('official.poll-assistant.flow.confirm', emptyPreviewParams(input.t)),
      promptForState: (state) => input.t(
        'official.poll-assistant.flow.confirm',
        pollCreationPreviewParams(state, input.t)
      ),
      options: [
        { label: input.t('official.poll-assistant.flow.confirm.yes'), value: CONFIRM_VALUE },
        { label: input.t('official.poll-assistant.flow.confirm.no'), value: 'no' }
      ],
      minSelections: 1,
      maxSelections: 1
    }
  };

  for (const purpose of ['decide', 'measure', 'count'] as const) {
    Object.assign(steps, lifecycleSteps(purpose, input.t, input.locale, input.preferences));
  }

  return applyFixedCreationPolicy({
    flowType: input.flowType,
    t: input.t,
    initialStepId: PURPOSE_STEP_ID,
    context: 'private',
    timeoutMinutes: 30,
    completionReply: false,
    steps
  }, input.preferences.preset, {
    ...pollCreationPresetInitialData(input.preferences.preset),
    ...input.initialData
  });
}

export function pollCreationPresetInitialData(
  preset: PollCreationPreset | undefined
): Record<string, unknown> {
  if (!preset) {
    return {};
  }
  const data: Record<string, unknown> = {};
  if (preset.purpose.mode === 'fixed') {
    data[PURPOSE_STEP_ID] = [preset.purpose.value];
  }
  if (preset.decideRule.mode === 'fixed') {
    data[DECIDE_RULE_STEP_ID] = [preset.decideRule.kind];
    if (
      preset.decideRule.kind === 'single_non_transferable'
      || preset.decideRule.kind === 'multiwinner_approval'
    ) {
      data[DECIDE_SEATS_STEP_ID] = preset.decideRule.seats;
    }
    if (preset.decideRule.kind === 'approve_reject') {
      data[DECIDE_THRESHOLD_STEP_ID] = preset.decideRule.minimumApprovalBasisPoints;
    }
  }
  if (preset.measureRule.mode === 'fixed') {
    data[MEASURE_RULE_STEP_ID] = [preset.measureRule.kind];
  }
  if (preset.countUnit.mode === 'fixed') {
    data[COUNT_UNIT_STEP_ID] = preset.countUnit.value;
  }
  if (preset.closing.mode === 'fixed') {
    for (const purpose of ['decide', 'measure', 'count'] as const) {
      data[closingStepId(purpose)] = [preset.closing.kind];
      if (preset.closing.kind === 'duration') {
        data[durationStepId(purpose)] = preset.closing.durationMinutes;
      } else if (preset.closing.kind === 'after_first_non_creator_response') {
        data[firstResponseDurationStepId(purpose)] = preset.closing.durationMinutes;
        data[activationTimeoutStepId(purpose)] = preset.closing.activationTimeoutMinutes ?? 120;
      }
    }
  }
  if (preset.quorum.mode === 'fixed') {
    for (const purpose of ['decide', 'measure', 'count'] as const) {
      data[quorumStepId(purpose)] = [preset.quorum.kind];
      if (preset.quorum.kind === 'absolute') {
        data[quorumAbsoluteStepId(purpose)] = preset.quorum.minimumResponses;
      }
      if (preset.quorum.kind === 'percentage') {
        data[quorumPercentageStepId(purpose)] = preset.quorum.minimumTurnoutBasisPoints;
      }
    }
  }
  if (preset.tiePolicy.mode === 'fixed') {
    data[tiePolicyStepId()] = [preset.tiePolicy.kind];
  }
  if (preset.ballotDelivery.mode === 'fixed') {
    data[BALLOT_DELIVERY_STEP_ID] = [preset.ballotDelivery.value];
  }
  if (preset.voterDisclosure.mode === 'fixed') {
    data[VOTER_DISCLOSURE_STEP_ID] = [preset.voterDisclosure.value];
  }
  return data;
}

function applyFixedCreationPolicy(
  definition: FlowDefinition,
  preset: PollCreationPreset | undefined,
  initialData: Record<string, unknown>
): FlowDefinition {
  if (!preset) {
    return definition;
  }
  const fixedStepIds = fixedCreationStepIds(preset);
  if (fixedStepIds.size === 0) {
    return definition;
  }
  const nextVisibleStepId = (start: string | undefined): string | undefined => {
    let current = start;
    const visited = new Set<string>();
    while (current && fixedStepIds.has(current)) {
      if (visited.has(current)) {
        throw new Error(`Poll creation preset ${preset.id} contains a fixed-step cycle at ${current}.`);
      }
      visited.add(current);
      const step = definition.steps[current];
      if (!step) {
        throw new Error(`Poll creation preset ${preset.id} references unknown step ${current}.`);
      }
      current = nextStepIdForPolicy(step, initialData[current]);
    }
    return current;
  };
  const steps = Object.fromEntries(Object.entries(definition.steps).map(([id, step]) => [
    id,
    {
      ...step,
      ...(step.nextStepId ? { nextStepId: nextVisibleStepId(step.nextStepId) } : {}),
      ...(step.nextStepIdByValue ? {
        nextStepIdByValue: Object.fromEntries(Object.entries(step.nextStepIdByValue).map(
          ([value, nextStepId]) => {
            const visible = nextVisibleStepId(nextStepId);
            if (!visible) {
              throw new Error(`Poll creation preset ${preset.id} removes the destination for ${id}:${value}.`);
            }
            return [value, visible];
          }
        ))
      } : {})
    }
  ]));
  const initialStepId = nextVisibleStepId(definition.initialStepId);
  if (!initialStepId) {
    throw new Error(`Poll creation preset ${preset.id} skips every flow step.`);
  }
  return { ...definition, initialStepId, steps };
}

function fixedCreationStepIds(preset: PollCreationPreset): Set<string> {
  const ids = new Set<string>();
  if (preset.purpose.mode === 'fixed') ids.add(PURPOSE_STEP_ID);
  if (preset.decideRule.mode === 'fixed') {
    ids.add(DECIDE_RULE_STEP_ID);
    if (
      preset.decideRule.kind === 'single_non_transferable'
      || preset.decideRule.kind === 'multiwinner_approval'
    ) ids.add(DECIDE_SEATS_STEP_ID);
    if (preset.decideRule.kind === 'approve_reject') ids.add(DECIDE_THRESHOLD_STEP_ID);
  }
  if (preset.measureRule.mode === 'fixed') ids.add(MEASURE_RULE_STEP_ID);
  if (preset.countUnit.mode === 'fixed') ids.add(COUNT_UNIT_STEP_ID);
  for (const purpose of ['decide', 'measure', 'count'] as const) {
    if (preset.closing.mode === 'fixed') {
      ids.add(closingStepId(purpose));
      if (preset.closing.kind === 'duration') ids.add(durationStepId(purpose));
      if (preset.closing.kind === 'after_first_non_creator_response') {
        ids.add(firstResponseDurationStepId(purpose));
        ids.add(activationTimeoutStepId(purpose));
      }
    }
    if (preset.quorum.mode === 'fixed') {
      ids.add(quorumStepId(purpose));
      if (preset.quorum.kind === 'absolute') ids.add(quorumAbsoluteStepId(purpose));
      if (preset.quorum.kind === 'percentage') ids.add(quorumPercentageStepId(purpose));
    }
  }
  if (preset.tiePolicy.mode === 'fixed') ids.add(tiePolicyStepId());
  if (preset.ballotDelivery.mode === 'fixed') ids.add(BALLOT_DELIVERY_STEP_ID);
  if (preset.voterDisclosure.mode === 'fixed') ids.add(VOTER_DISCLOSURE_STEP_ID);
  return ids;
}

function nextStepIdForPolicy(step: FlowStep, value: unknown): string | undefined {
  if (!step.nextStepIdByValue) {
    return step.nextStepId;
  }
  const selected = selectedValue(value);
  return selected ? step.nextStepIdByValue[selected] ?? step.nextStepId : step.nextStepId;
}

function questionStep(
  id: string,
  prompt: string,
  nextStepId: string,
  t: TranslateFn
): FlowStep {
  return {
    id,
    kind: 'text',
    prompt,
    resolveInput: (resolution) => {
      const question = resolution.input.trim();
      const validation = validatePollContent(question, ['a', 'b']);
      return question && validation.titleFits
        ? { status: 'use-value', value: question }
        : { status: 'error', reply: t('official.poll-assistant.flow.question.invalid') };
    },
    nextStepId
  };
}

function optionStep(input: {
  id: string;
  prompt: string;
  nextStepId: string;
  t: TranslateFn;
  count?: boolean | undefined;
  optionBounds?: { minimum: number; maximum: number } | undefined;
}): FlowStep {
  return {
    id: input.id,
    kind: 'text',
    prompt: input.prompt,
    resolveInput: (resolution) => {
      const options = input.count
        ? parseCountOptions(resolution.input)
        : parseOptions(resolution.input);
      if (
        !options
        || !optionsFit(options)
        || (input.optionBounds && (
          options.length < input.optionBounds.minimum
          || options.length > input.optionBounds.maximum
        ))
      ) {
        return {
          status: 'error',
          reply: input.optionBounds
            ? input.t('official.poll-assistant.flow.options.presetRuleInvalid', input.optionBounds)
            : input.t(input.count
              ? 'official.poll-assistant.flow.options.countInvalid'
              : 'official.poll-assistant.flow.options.invalid')
        };
      }
      return { status: 'use-value', value: options };
    },
    nextStepId: input.nextStepId
  };
}

function lifecycleSteps(
  purpose: PollCreationPurpose,
  t: TranslateFn,
  locale: string,
  preferences: PollCreationFlowPreferences
): Record<string, FlowStep> {
  const closingId = closingStepId(purpose);
  const durationId = durationStepId(purpose);
  const deadlineId = deadlineStepId(purpose);
  const firstResponseDurationId = firstResponseDurationStepId(purpose);
  const activationTimeoutId = activationTimeoutStepId(purpose);
  const quorumId = quorumStepId(purpose);
  const quorumAbsoluteId = quorumAbsoluteStepId(purpose);
  const quorumPercentageId = quorumPercentageStepId(purpose);
  const afterQuorum = purpose === 'decide' ? tiePolicyStepId() : BALLOT_DELIVERY_STEP_ID;
  const closingOptions = orderedByPreferred([
    { label: t('official.poll-assistant.flow.closing.duration'), value: 'duration' },
    {
      label: t('official.poll-assistant.flow.closing.afterFirstResponse'),
      value: 'after_first_non_creator_response'
    },
    { label: t('official.poll-assistant.flow.closing.deadline'), value: 'deadline' },
    { label: t('official.poll-assistant.flow.closing.manual'), value: 'manual' }
  ], preferences.defaultClosing.kind === 'manual'
    ? 'manual'
    : preferences.defaultClosing.kind === 'after_first_non_creator_response'
      ? 'after_first_non_creator_response'
      : 'duration');
  const quorumOptions = orderedByPreferred([
    { label: t('official.poll-assistant.flow.quorum.none'), value: 'none' },
    { label: t('official.poll-assistant.flow.quorum.absolute'), value: 'absolute' },
    { label: t('official.poll-assistant.flow.quorum.percentage'), value: 'percentage' }
  ], preferences.defaultQuorum.kind);
  return {
    [closingId]: {
      id: closingId,
      kind: 'choice',
      prompt: t('official.poll-assistant.flow.closing'),
      options: closingOptions,
      minSelections: 1,
      maxSelections: 1,
      nextStepIdByValue: {
        duration: durationId,
        after_first_non_creator_response: firstResponseDurationId,
        deadline: deadlineId,
        manual: quorumId
      }
    },
    [durationId]: {
      id: durationId,
      kind: 'text',
      prompt: t('official.poll-assistant.flow.duration', {
        maximum: preferences.maxDeadlineMinutes,
        defaultMinutes: preferences.defaultClosing.kind === 'deadline'
          ? preferences.defaultClosing.durationMinutes
          : preferences.maxDeadlineMinutes
      }),
      resolveInput: (resolution) => resolveInteger(resolution.input, 1, preferences.maxDeadlineMinutes,
        t('official.poll-assistant.flow.duration.invalid')),
      nextStepId: quorumId
    },
    [firstResponseDurationId]: {
      id: firstResponseDurationId,
      kind: 'text',
      prompt: t('official.poll-assistant.flow.firstResponseDuration', {
        maximum: preferences.maxDeadlineMinutes,
        defaultMinutes: preferences.defaultClosing.kind === 'after_first_non_creator_response'
          ? preferences.defaultClosing.durationMinutes
          : 60
      }),
      resolveInput: (resolution) => resolveInteger(
        resolution.input,
        1,
        preferences.maxDeadlineMinutes,
        t('official.poll-assistant.flow.duration.invalid')
      ),
      nextStepId: activationTimeoutId
    },
    [activationTimeoutId]: {
      id: activationTimeoutId,
      kind: 'text',
      prompt: t('official.poll-assistant.flow.activationTimeout', {
        maximum: preferences.maxDeadlineMinutes,
        defaultMinutes: preferences.defaultClosing.kind === 'after_first_non_creator_response'
          ? preferences.defaultClosing.activationTimeoutMinutes
          : 120
      }),
      resolveInput: (resolution) => resolveInteger(
        resolution.input,
        1,
        preferences.maxDeadlineMinutes,
        t('official.poll-assistant.flow.activationTimeout.invalid')
      ),
      nextStepId: quorumId
    },
    [deadlineId]: {
      id: deadlineId,
      kind: 'text',
      prompt: t(chronoParserForLocale(locale)
        ? 'official.poll-assistant.flow.deadline'
        : 'official.poll-assistant.flow.deadline.strict', {
        timezone: preferences.timezone,
        maximumMinutes: preferences.maxDeadlineMinutes
      }),
      resolveInput: (resolution) => resolveDeadline(
        resolution.input,
        preferences.timezone,
        locale,
        preferences.maxDeadlineMinutes,
        {
          invalid: t('official.poll-assistant.flow.deadline.invalid'),
          missingTime: t('official.poll-assistant.flow.deadline.missingTime'),
          past: t('official.poll-assistant.flow.deadline.past'),
          tooFar: t('official.poll-assistant.flow.deadline.tooFar', {
            maximumMinutes: preferences.maxDeadlineMinutes
          }),
          unsupportedLocale: t('official.poll-assistant.flow.deadline.unsupportedLocale', {
            timezone: preferences.timezone
          })
        }
      ),
      nextStepId: quorumId
    },
    [quorumId]: {
      id: quorumId,
      kind: 'choice',
      prompt: t('official.poll-assistant.flow.quorum'),
      options: quorumOptions,
      minSelections: 1,
      maxSelections: 1,
      nextStepIdByValue: {
        none: afterQuorum,
        absolute: quorumAbsoluteId,
        percentage: quorumPercentageId
      }
    },
    [quorumAbsoluteId]: {
      id: quorumAbsoluteId,
      kind: 'text',
      prompt: t('official.poll-assistant.flow.quorum.absoluteValue', {
        defaultCount: preferences.defaultQuorum.kind === 'absolute'
          ? preferences.defaultQuorum.minimumResponses
          : 1
      }),
      resolveInput: (resolution) => resolveInteger(
        resolution.input,
        1,
        Number.MAX_SAFE_INTEGER,
        t('official.poll-assistant.flow.quorum.absoluteInvalid')
      ),
      nextStepId: afterQuorum
    },
    [quorumPercentageId]: {
      id: quorumPercentageId,
      kind: 'text',
      prompt: t('official.poll-assistant.flow.quorum.percentageValue', {
        defaultPercentage: preferences.defaultQuorum.kind === 'percentage'
          ? formatBasisPoints(preferences.defaultQuorum.minimumTurnoutBasisPoints)
          : '100'
      }),
      resolveInput: (resolution) => resolvePercentage(resolution.input, {
        minimumBasisPoints: 1,
        error: t('official.poll-assistant.flow.quorum.percentageInvalid')
      }),
      nextStepId: afterQuorum
    },
    ...(purpose === 'decide'
      ? {
          [tiePolicyStepId()]: {
            id: tiePolicyStepId(),
            kind: 'choice' as const,
            prompt: t('official.poll-assistant.flow.tiePolicy'),
            options: orderedByPreferred([
              { label: t('official.poll-assistant.flow.tiePolicy.noDecision'), value: 'no_decision' },
              {
                label: t('official.poll-assistant.flow.tiePolicy.authorizedChoice'),
                value: 'authorized_choice'
              },
              { label: t('official.poll-assistant.flow.tiePolicy.randomDraw'), value: 'random_draw' }
            ], preferredTiePolicy(preferences.preset)),
            optionsForState: (state) => {
              const options = [
                { label: t('official.poll-assistant.flow.tiePolicy.noDecision'), value: 'no_decision' },
                {
                  label: t('official.poll-assistant.flow.tiePolicy.authorizedChoice'),
                  value: 'authorized_choice'
                },
                { label: t('official.poll-assistant.flow.tiePolicy.randomDraw'), value: 'random_draw' }
              ];
              const available = selectedValue(state.data[DECIDE_RULE_STEP_ID]) === 'approve_reject'
                ? [...options, {
                    label: t('official.poll-assistant.flow.tiePolicy.statusQuo'),
                    value: 'status_quo'
                  }]
                : options;
              return orderedByPreferred(available, preferredTiePolicy(preferences.preset));
            },
            minSelections: 1,
            maxSelections: 1,
            nextStepId: BALLOT_DELIVERY_STEP_ID
          }
        }
      : {})
  };
}

function resolveSeats(
  resolution: Parameters<NonNullable<FlowStep['resolveInput']>>[0],
  t: TranslateFn
): ReturnType<NonNullable<FlowStep['resolveInput']>> {
  const maximum = optionAnswers(resolution.state.data[DECIDE_OPTIONS_STEP_ID])?.length ?? 0;
  return resolveInteger(
    resolution.input,
    1,
    maximum,
    t('official.poll-assistant.flow.seats.invalid', { maximum })
  );
}

function resolveInteger(
  raw: string,
  minimum: number,
  maximum: number,
  error: string
): ReturnType<NonNullable<FlowStep['resolveInput']>> {
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? { status: 'use-value', value }
    : { status: 'error', reply: error };
}

function resolvePercentage(
  raw: string,
  input: { minimumBasisPoints: number; error: string }
): ReturnType<NonNullable<FlowStep['resolveInput']>> {
  const normalized = raw.trim();
  if (!/^\d{1,3}(?:[.,]\d{1,2})?$/.test(normalized)) {
    return { status: 'error', reply: input.error };
  }
  const basisPoints = Math.round(Number(normalized.replace(',', '.')) * 100);
  return basisPoints >= input.minimumBasisPoints && basisPoints <= 10_000
    ? { status: 'use-value', value: basisPoints }
    : { status: 'error', reply: input.error };
}

function resolveDeadline(
  raw: string,
  timezone: string,
  locale: string,
  maxDeadlineMinutes: number,
  errors: {
    invalid: string;
    missingTime: string;
    past: string;
    tooFar: string;
    unsupportedLocale: string;
  }
): ReturnType<NonNullable<FlowStep['resolveInput']>> {
  const now = new Date();
  const parsed = parseLocalizedDateTimeInput(raw, { timezone, locale, now });
  if (parsed.status === 'missing_time') {
    return { status: 'error', reply: errors.missingTime };
  }
  if (parsed.status === 'invalid') {
    return {
      status: 'error',
      reply: parsed.reason === 'unsupported_locale'
        ? errors.unsupportedLocale
        : errors.invalid
    };
  }
  const remainingMilliseconds = parsed.date.getTime() - now.getTime();
  if (remainingMilliseconds <= 0) {
    return { status: 'error', reply: errors.past };
  }
  if (remainingMilliseconds > maxDeadlineMinutes * 60_000) {
    return { status: 'error', reply: errors.tooFar };
  }
  return { status: 'use-value', value: parsed.date.toISOString() };
}

function parseOptions(raw: string): PollCreationOptionAnswer[] | undefined {
  const labels = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return validOptionCount(labels.length) && labelsAreUnique(labels)
    ? labels.map((label) => ({ label }))
    : undefined;
}

function parseCountOptions(raw: string): PollCreationOptionAnswer[] | undefined {
  const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (!validOptionCount(lines.length)) {
    return undefined;
  }
  const options = lines.flatMap((line) => {
    const separator = line.lastIndexOf('=');
    const label = separator >= 0 ? line.slice(0, separator).trim() : '';
    const valueText = separator >= 0 ? line.slice(separator + 1).trim() : '';
    const numericValue = Number(valueText);
    return label && /^\d+$/u.test(valueText) && Number.isSafeInteger(numericValue) && numericValue > 0
      ? [{ label, numericValue }]
      : [];
  });
  return options.length === lines.length && labelsAreUnique(options.map((option) => option.label))
    ? options
    : undefined;
}

function optionsFit(options: readonly PollCreationOptionAnswer[]): boolean {
  const labels = options.map((option) => option.label);
  const renderedLabels = numberPollOptions(labels);
  return validatePollContent('x', labels).optionsFit
    && new Set(renderedLabels).size === renderedLabels.length;
}

function validOptionCount(count: number): boolean {
  return count >= WHATSAPP_POLL_MIN_OPTIONS && count <= WHATSAPP_POLL_MAX_OPTIONS;
}

function labelsAreUnique(labels: readonly string[]): boolean {
  return new Set(labels.map((label) => label.toLowerCase())).size === labels.length;
}

function pollCreationAnswersFromState(state: FlowState): PollCreationAnswers | undefined {
  const purpose = selectedValue(state.data[PURPOSE_STEP_ID]);
  if (purpose !== 'decide' && purpose !== 'measure' && purpose !== 'count') {
    return undefined;
  }
  const questionStep = purpose === 'decide'
    ? DECIDE_QUESTION_STEP_ID
    : purpose === 'measure'
      ? MEASURE_QUESTION_STEP_ID
      : COUNT_QUESTION_STEP_ID;
  const optionsStep = purpose === 'decide'
    ? DECIDE_OPTIONS_STEP_ID
    : purpose === 'measure'
      ? MEASURE_OPTIONS_STEP_ID
      : COUNT_OPTIONS_STEP_ID;
  const question = stringAnswer(state.data[questionStep]);
  const options = optionAnswers(state.data[optionsStep]);
  const closing = closingAnswer(state, purpose);
  const quorum = quorumAnswer(state, purpose);
  const ballotDelivery = selectedValue(state.data[BALLOT_DELIVERY_STEP_ID]);
  const voterDisclosure = selectedValue(state.data[VOTER_DISCLOSURE_STEP_ID]);
  if (
    !question
    || !options
    || !closing
    || !quorum
    || (ballotDelivery !== 'group' && ballotDelivery !== 'private')
    || (voterDisclosure !== 'named' && voterDisclosure !== 'hidden')
    || (ballotDelivery === 'group' && voterDisclosure === 'hidden')
  ) {
    return undefined;
  }
  const rule = ruleAnswer(state, purpose);
  if (!rule) {
    return undefined;
  }
  if (purpose !== 'decide') {
    return {
      purpose,
      question,
      options,
      rule,
      closing,
      quorum,
      ballotDelivery,
      voterDisclosure
    } as PollCreationAnswers;
  }
  const tiePolicy = selectedValue(state.data[tiePolicyStepId()]);
  if (
    tiePolicy !== 'no_decision'
    && tiePolicy !== 'authorized_choice'
    && tiePolicy !== 'status_quo'
    && tiePolicy !== 'random_draw'
  ) {
    return undefined;
  }
  if (tiePolicy === 'status_quo' && rule.kind !== 'approve_reject') {
    return undefined;
  }
  return {
    purpose,
    question,
    options,
    rule,
    closing,
    quorum,
    ballotDelivery,
    voterDisclosure,
    tiePolicy
  };
}

function ruleAnswer(state: FlowState, purpose: PollCreationPurpose): PollCreationRuleAnswer | undefined {
  if (purpose === 'count') {
    const unit = stringAnswer(state.data[COUNT_UNIT_STEP_ID]);
    return unit ? { purpose, kind: 'sum', unit } : undefined;
  }
  if (purpose === 'measure') {
    const kind = selectedValue(state.data[MEASURE_RULE_STEP_ID]);
    if (kind === 'distribution_single' || kind === 'distribution_multiple') {
      return { purpose, kind: 'distribution', allowMultipleAnswers: kind === 'distribution_multiple' };
    }
    return kind === 'ordered_scale' ? { purpose, kind } : undefined;
  }
  const kind = selectedValue(state.data[DECIDE_RULE_STEP_ID]);
  if (kind === 'plurality' || kind === 'approval') {
    return { purpose, kind };
  }
  if (kind === 'single_non_transferable' || kind === 'multiwinner_approval') {
    const seats = numberAnswer(state.data[DECIDE_SEATS_STEP_ID]);
    return seats ? { purpose, kind, seats } : undefined;
  }
  if (kind === 'approve_reject') {
    const minimumApprovalBasisPoints = numberAnswer(state.data[DECIDE_THRESHOLD_STEP_ID]);
    return minimumApprovalBasisPoints
      ? { purpose, kind, minimumApprovalBasisPoints }
      : undefined;
  }
  return undefined;
}

function closingAnswer(state: FlowState, purpose: PollCreationPurpose): PollCreationClosingAnswer | undefined {
  const kind = selectedValue(state.data[closingStepId(purpose)]);
  if (kind === 'manual') {
    return { kind };
  }
  if (kind === 'duration') {
    const durationMinutes = numberAnswer(state.data[durationStepId(purpose)]);
    return durationMinutes ? { kind: 'after_publish_duration', durationMinutes } : undefined;
  }
  if (kind === 'after_first_non_creator_response') {
    const durationMinutes = numberAnswer(state.data[firstResponseDurationStepId(purpose)]);
    const activationTimeoutMinutes = numberAnswer(state.data[activationTimeoutStepId(purpose)]);
    return durationMinutes && activationTimeoutMinutes
      ? { kind, durationMinutes, activationTimeoutMinutes }
      : undefined;
  }
  if (kind === 'deadline') {
    const closesAt = stringAnswer(state.data[deadlineStepId(purpose)]);
    return closesAt ? { kind, closesAt } : undefined;
  }
  return undefined;
}

function quorumAnswer(state: FlowState, purpose: PollCreationPurpose): PollCreationQuorumAnswer | undefined {
  const kind = selectedValue(state.data[quorumStepId(purpose)]);
  if (kind === 'none') {
    return { kind };
  }
  if (kind === 'absolute') {
    const minimumResponses = numberAnswer(state.data[quorumAbsoluteStepId(purpose)]);
    return minimumResponses ? { kind, minimumResponses } : undefined;
  }
  if (kind === 'percentage') {
    const minimumTurnoutBasisPoints = numberAnswer(state.data[quorumPercentageStepId(purpose)]);
    return minimumTurnoutBasisPoints ? { kind, minimumTurnoutBasisPoints } : undefined;
  }
  return undefined;
}

function pollCreationPreviewParams(state: FlowState, t: TranslateFn): Record<string, string | number> {
  const answers = pollCreationAnswersFromState(state);
  if (!answers) {
    return emptyPreviewParams(t);
  }
  return {
    purpose: t(`official.poll-assistant.purpose.${answers.purpose}`),
    question: answers.question,
    rule: ruleSummary(answers, t),
    closing: closingSummary(answers.closing, t),
    quorum: quorumSummary(answers.quorum, t),
    tiePolicy: answers.tiePolicy
      ? t(`official.poll-assistant.flow.tiePolicy.${tiePolicyMessageSuffix(answers.tiePolicy)}`)
      : t('official.poll-assistant.flow.summary.tie.none'),
    ballotDelivery: t(`official.poll-assistant.flow.ballotDelivery.${answers.ballotDelivery}`),
    voterDisclosure: t(`official.poll-assistant.flow.voterDisclosure.${answers.voterDisclosure}`),
    options: answers.options.map((option, index) => t(
      option.numericValue === undefined
        ? 'official.poll-assistant.flow.summary.option'
        : 'official.poll-assistant.flow.summary.countOption',
      {
        ordinal: index + 1,
        label: option.label,
        ...(option.numericValue === undefined ? {} : { value: option.numericValue })
      }
    )).join('\n')
  };
}

function emptyPreviewParams(t: TranslateFn): Record<string, string> {
  const empty = t('official.poll-assistant.flow.summary.tie.none');
  return {
    purpose: empty,
    question: empty,
    rule: empty,
    closing: empty,
    quorum: empty,
    tiePolicy: empty,
    ballotDelivery: empty,
    voterDisclosure: empty,
    options: empty
  };
}

function ruleSummary(answers: PollCreationAnswers, t: TranslateFn): string {
  const rule = answers.rule;
  if (rule.purpose === 'count') {
    return t('official.poll-assistant.purpose.count');
  }
  if (rule.purpose === 'measure') {
    return t(rule.kind === 'ordered_scale'
      ? 'official.poll-assistant.flow.rule.orderedScale'
      : rule.allowMultipleAnswers
        ? 'official.poll-assistant.flow.rule.distributionMultiple'
        : 'official.poll-assistant.flow.rule.distributionSingle');
  }
  const base = t(`official.poll-assistant.flow.rule.${decideRuleMessageSuffix(rule.kind)}`);
  if (rule.kind === 'single_non_transferable' || rule.kind === 'multiwinner_approval') {
    return t('official.poll-assistant.flow.summary.seats', { rule: base, seats: rule.seats });
  }
  if (rule.kind === 'approve_reject') {
    return t('official.poll-assistant.flow.summary.threshold', {
      rule: base,
      threshold: formatBasisPoints(rule.minimumApprovalBasisPoints)
    });
  }
  return base;
}

function closingSummary(closing: PollCreationClosingAnswer, t: TranslateFn): string {
  if (closing.kind === 'manual') {
    return t('official.poll-assistant.flow.summary.manual');
  }
  return closing.kind === 'deadline'
    ? t('official.poll-assistant.flow.summary.deadline', { deadline: closing.closesAt })
    : closing.kind === 'after_first_non_creator_response'
      ? t('official.poll-assistant.flow.summary.afterFirstResponse', {
          minutes: closing.durationMinutes,
          timeoutMinutes: closing.activationTimeoutMinutes
        })
    : t('official.poll-assistant.flow.summary.duration', { minutes: closing.durationMinutes });
}

function quorumSummary(quorum: PollCreationQuorumAnswer, t: TranslateFn): string {
  if (quorum.kind === 'none') {
    return t('official.poll-assistant.flow.summary.quorum.none');
  }
  return quorum.kind === 'absolute'
    ? t('official.poll-assistant.flow.summary.quorum.absolute', { count: quorum.minimumResponses })
    : t('official.poll-assistant.flow.summary.quorum.percentage', {
        percentage: formatBasisPoints(quorum.minimumTurnoutBasisPoints)
      });
}

function optionAnswers(value: unknown): PollCreationOptionAnswer[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const options = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.label !== 'string' || !candidate.label.trim()) {
      return [];
    }
    if (candidate.numericValue === undefined) {
      return [{ label: candidate.label.trim() }];
    }
    return Number.isSafeInteger(candidate.numericValue) && Number(candidate.numericValue) > 0
      ? [{ label: candidate.label.trim(), numericValue: Number(candidate.numericValue) }]
      : [];
  });
  return options.length === value.length && validOptionCount(options.length) ? options : undefined;
}

function selectedValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function stringAnswer(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function numberAnswer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function closingStepId(purpose: PollCreationPurpose): string {
  return `${purpose}-closing`;
}

function durationStepId(purpose: PollCreationPurpose): string {
  return `${purpose}-duration`;
}

function deadlineStepId(purpose: PollCreationPurpose): string {
  return `${purpose}-deadline`;
}

function firstResponseDurationStepId(purpose: PollCreationPurpose): string {
  return `${purpose}-first-response-duration`;
}

function activationTimeoutStepId(purpose: PollCreationPurpose): string {
  return `${purpose}-activation-timeout`;
}

function quorumStepId(purpose: PollCreationPurpose): string {
  return `${purpose}-quorum`;
}

function quorumAbsoluteStepId(purpose: PollCreationPurpose): string {
  return `${purpose}-quorum-absolute`;
}

function quorumPercentageStepId(purpose: PollCreationPurpose): string {
  return `${purpose}-quorum-percentage`;
}

function tiePolicyStepId(): string {
  return 'decide-tie-policy';
}

function decideRuleMessageSuffix(kind: Extract<PollCreationRuleAnswer, { purpose: 'decide' }>['kind']): string {
  switch (kind) {
    case 'plurality': return 'plurality';
    case 'single_non_transferable': return 'singleNonTransferable';
    case 'approval': return 'approval';
    case 'multiwinner_approval': return 'multiwinnerApproval';
    case 'approve_reject': return 'approveReject';
  }
}

function tiePolicyMessageSuffix(policy: NonNullable<PollCreationAnswers['tiePolicy']>): string {
  switch (policy) {
    case 'no_decision': return 'noDecision';
    case 'authorized_choice': return 'authorizedChoice';
    case 'status_quo': return 'statusQuo';
    case 'random_draw': return 'randomDraw';
  }
}

function ballotDeliveryOptions(t: TranslateFn, preset: PollCreationPreset | undefined) {
  const options = preset?.voterDisclosure.mode === 'fixed'
    && preset.voterDisclosure.value === 'hidden'
    ? [{ label: t('official.poll-assistant.flow.ballotDelivery.private'), value: 'private' }]
    : [
        { label: t('official.poll-assistant.flow.ballotDelivery.group'), value: 'group' },
        { label: t('official.poll-assistant.flow.ballotDelivery.private'), value: 'private' }
      ];
  return orderedByPreferred(
    options,
    preset && preset.ballotDelivery.mode !== 'ask' ? preset.ballotDelivery.value : 'group'
  );
}

function voterDisclosureOptions(
  t: TranslateFn,
  preset: PollCreationPreset | undefined,
  ballotDelivery: 'group' | 'private'
) {
  const options = ballotDelivery === 'group'
    ? [{ label: t('official.poll-assistant.flow.voterDisclosure.named'), value: 'named' }]
    : [
        { label: t('official.poll-assistant.flow.voterDisclosure.named'), value: 'named' },
        { label: t('official.poll-assistant.flow.voterDisclosure.hidden'), value: 'hidden' }
      ];
  return orderedByPreferred(
    options,
    preset && preset.voterDisclosure.mode !== 'ask' ? preset.voterDisclosure.value : 'named'
  );
}

function formatBasisPoints(basisPoints: number): string {
  return (basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : basisPoints % 10 === 0 ? 1 : 2);
}

function orderedByPreferred<T extends { value: string }>(options: T[], preferred: string): T[] {
  return [...options].sort((left, right) => {
    if (left.value === preferred) return -1;
    if (right.value === preferred) return 1;
    return 0;
  });
}

function preferredDecideRule(preset: PollCreationPreset | undefined): string {
  return preset?.decideRule.mode !== 'ask'
    ? preset?.decideRule.kind ?? 'plurality'
    : 'plurality';
}

function preferredTiePolicy(preset: PollCreationPreset | undefined): string {
  return preset?.tiePolicy.mode !== 'ask'
    ? preset?.tiePolicy.kind ?? 'no_decision'
    : 'no_decision';
}

function fixedDecideOptionBounds(
  preset: PollCreationPreset | undefined
): { minimum: number; maximum: number } | undefined {
  if (preset?.decideRule.mode !== 'fixed') {
    return undefined;
  }
  if (preset.decideRule.kind === 'approve_reject') {
    return { minimum: 2, maximum: 2 };
  }
  if (
    preset.decideRule.kind === 'single_non_transferable'
    || preset.decideRule.kind === 'multiwinner_approval'
  ) {
    return { minimum: Math.max(2, preset.decideRule.seats), maximum: 12 };
  }
  return undefined;
}
