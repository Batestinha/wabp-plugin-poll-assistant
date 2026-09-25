import { z } from 'zod';
import type { TranslateFn } from '@wabs/plugin-sdk/i18n';
import { renderValueTemplate, validateValueTemplate, previewTemplateFragment, trimTemplateFragment, type TemplateFragment, type TemplateConditionVariable, type TemplateScalar, type ValueTemplateDefinition } from '@wabs/plugin-sdk/templates';

const contextTokens = ['pollId', 'question', 'timezone', 'cutoffAt'];
const outcomeTokens = [...contextTokens, 'options', 'certainOptions', 'tiedOptions', 'remainingSeats', 'medianOptions', 'modeOptions', 'total', 'unit'];
const publicationTokens = [...contextTokens, 'deliveryNotice', 'options', 'purpose', 'rule', 'closing', 'quorum', 'tiePolicy', 'ballotDelivery', 'voterDisclosure', 'activationTimeout', 'postVoteAction'];

/** The editor, validation, localized source catalog and renderer share this contract. */
export const pollTemplateDefinitions = {
  publication: {
    title: 'Publication',
    tokens: publicationTokens,
    source: '{deliveryNotice}\n\nQuestion: {question}\nOptions:\n{options}\n\nPurpose: {purpose}\nRule: {rule}\nClosing: {closing}{{#if postVoteAction}}\n\n{postVoteAction}{{/if}}'
  },
  closedPublication: {
    title: 'Closed publication',
    // Operators commonly copy the publication template and change its state
    // wording. Keep every publication field available, then add close-only data.
    tokens: [...publicationTokens, 'closedAt', 'originalPublication', 'result'],
    source: 'Poll closed: «{question}»'
  },
  publicationOption: { title: 'Publication option row', tokens: ['ordinal', 'label', 'option'], source: '{ordinal}. {label}' },
  proposalOption: { title: 'Assistant proposal option row', tokens: ['ordinal', 'label', 'numericValue', 'option'], source: '{ordinal}) {option}' },
  assistantProposal: {
    title: 'Assistant proposal summary',
    tokens: ['question', 'options', 'purpose', 'rule', 'closing', 'quorum', 'tie', 'electorate', 'delivery', 'disclosure', 'consequences', 'policy'],
    source: '*Question*\n{question}\n\n*Options*\n{options}\n\n*Purpose*: {purpose}\n*Rule*: {rule}\n*Closing*: {closing}\n*Quorum*: {quorum}\n*Tie*: {tie}\n*Who can vote*: {electorate}\n*Ballot delivery*: {delivery}\n*Voter disclosure*: {disclosure}{{#if consequences}}\n\n*Consequences*\n{consequences}\n*Apply result*: {policy}{{/if}}'
  },
  activation: { title: 'Activation notice', tokens: [...contextTokens, 'closing', 'closesAt'], source: 'Closing time for «{question}»: {closing}' },
  result: {
    title: 'Result',
    tokens: [...contextTokens, 'outcome', 'responseCount', 'eligibleCount', 'turnoutPercent', 'optionResults'],
    source: 'Poll closed: «{question}»\n\n*{outcome}*\n\nResponses: {responseCount} of {eligibleCount} eligible voters ({turnoutPercent}%)\n\n{optionResults}'
  },
  resultOption: {
    title: 'Result option row',
    tokens: ['ordinal', 'option', 'count', 'respondentPercent', 'eligiblePercent', 'voters'],
    source: '{option}: {count} response(s) ({respondentPercent}% of respondents){{#if voters}} ({voters}){{/if}}'
  },
  selected: { title: 'Selection wording', tokens: outcomeTokens, source: 'Selected: {options}' },
  selectedByRandomDraw: { title: 'Random draw wording', tokens: outcomeTokens, source: 'Selected by random draw: {options}' },
  tie: { title: 'Tie wording', tokens: outcomeTokens, source: 'Tie: {tiedOptions}{{#if certainOptions}}; already selected: {certainOptions}{{/if}}. Remaining places: {remainingSeats}.' },
  noDecision: { title: 'No decision wording', tokens: outcomeTokens, source: 'No decision: {tiedOptions}{{#if certainOptions}}; already selected: {certainOptions}{{/if}}.' },
  quorumNotMet: { title: 'Insufficient turnout wording', tokens: outcomeTokens, source: 'Insufficient turnout.' },
  measuredDistribution: { title: 'Distribution wording', tokens: outcomeTokens, source: 'Responses measured.' },
  measuredScale: { title: 'Scale wording', tokens: outcomeTokens, source: 'Median: {medianOptions}; mode: {modeOptions}.' },
  counted: { title: 'Count wording', tokens: outcomeTokens, source: 'Counted: {total} {unit}.' },
  tieResolved: { title: 'Tie resolution notice', tokens: [...outcomeTokens, 'resolver'], source: 'Tie resolved for «{question}»: {options}.' }
} as const;

export type PollTemplateKind = keyof typeof pollTemplateDefinitions;
export type PollTemplateOverrides = Partial<Record<PollTemplateKind, string>>;
export const POLL_TEMPLATE_MAX_LENGTH = 14_000;

/** @operatorConsoleSamples Example values for token buttons and preview only. */
export const pollTemplateSamples: Record<string, string> = {
  pollId: 'poll-example', question: 'Morning or afternoon?', timezone: 'Europe/Lisbon', cutoffAt: '12:22:57', closedAt: '12:22:57', originalPublication: 'Question: Morning or afternoon?', result: 'Selected: Afternoon',
  deliveryNotice: 'poll published in this group.', options: 'Afternoon', purpose: 'Decision', rule: 'Most votes',
  closing: '12:22:57', closesAt: '12:22:57', quorum: '50%', tiePolicy: 'Authorized choice', ballotDelivery: 'Group',
  voterDisclosure: 'Named', activationTimeout: '120 minutes', postVoteAction: 'The selected option updates the event.',
  ordinal: '1', label: 'Afternoon', numericValue: '1', option: 'Afternoon', outcome: 'Selected: Afternoon', responseCount: '2',
  eligibleCount: '4', turnoutPercent: '50', optionResults: 'Afternoon: 2 responses (100% of respondents) (Ana, Rui)',
  count: '2', respondentPercent: '100', eligiblePercent: '50', voters: 'Ana, Rui', certainOptions: 'Afternoon',
  tiedOptions: 'Morning and afternoon', remainingSeats: '1', medianOptions: 'Afternoon', modeOptions: 'Afternoon',
  total: '2', unit: 'items', resolver: 'Ana', consequences: 'Update the event.', policy: 'After requester confirmation'
};

const numericTokens = new Set(['ordinal', 'count', 'responseCount', 'eligibleCount', 'turnoutPercent', 'respondentPercent', 'eligiblePercent', 'remainingSeats', 'total', 'activationTimeout']);
const choiceOptions: Record<string, Array<{ value: string; label: string }>> = {
  ballotDelivery: [{ value: 'private', label: 'Private' }, { value: 'group', label: 'Group' }],
  voterDisclosure: [{ value: 'named', label: 'Named' }, { value: 'hidden', label: 'Hidden' }],
  purpose: [{ value: 'decide', label: 'Decision' }, { value: 'measure', label: 'Measurement' }, { value: 'count', label: 'Count' }],
  rule: [
    { value: 'plurality', label: 'Most votes' }, { value: 'approval', label: 'Approval' },
    { value: 'single_non_transferable', label: 'Single non-transferable vote' }, { value: 'multiwinner_approval', label: 'Multiple winners by approval' },
    { value: 'approve_reject', label: 'Approve or reject' }, { value: 'distribution', label: 'Distribution' },
    { value: 'ordered_scale', label: 'Ordered scale' }, { value: 'sum', label: 'Sum' }
  ],
  tiePolicy: [
    { value: 'no_decision', label: 'No decision' }, { value: 'authorized_choice', label: 'Authorized choice' },
    { value: 'status_quo', label: 'Status quo' }, { value: 'random_draw', label: 'Random draw' }
  ]
};
export function pollTemplateFields(kind: PollTemplateKind): TemplateConditionVariable[] {
  return pollTemplateDefinitions[kind].tokens.map(token => ({ token,
    label: token.replace(/([A-Z])/g, ' $1').replace(/^./, letter => letter.toUpperCase()), sampleValue: pollTemplateSamples[token] ?? '',
    valueType: numericTokens.has(token) ? 'number' : choiceOptions[token] ? 'enum' : 'text', optional: true,
    ...(numericTokens.has(token) ? { conditionSampleValue: Number(pollTemplateSamples[token]?.replace(/[^0-9.-]/g, '') || 1), ...(token === 'activationTimeout' ? { unit: 'minutes' } : {}) } : {}),
    ...(choiceOptions[token] ? { options: choiceOptions[token], conditionSampleValue: choiceOptions[token]![0]!.value } : {})
  }));
}
export function pollValueTemplateDefinition(kind: PollTemplateKind): ValueTemplateDefinition {
  return { variables: pollTemplateFields(kind), allowDefault: true, mentions: {
    people: true, groups: true, all: true, targets: [
      { id: 'creator', label: 'Poll creator' }, { id: 'eligibleVoters', label: 'Eligible voters', description: 'Captured electorate, excluding the bot' },
      { id: 'currentGroup', label: 'Current group' }, ...(kind === 'tieResolved' ? [{ id: 'resolver', label: 'Tie resolver' }] : [])
    ]
  } };
}
export const POLL_DEFAULT_PUBLICATION = '{{mention target "eligibleVoters" "Eligible voters"}}\n{{default}}';

export const pollTemplateDefaultMessages: Record<string, string> = Object.fromEntries(
  Object.entries(pollTemplateDefinitions).map(([kind, definition]) => [`official.poll-assistant.template.${kind}`, definition.source])
);

const templateShape = Object.fromEntries(Object.keys(pollTemplateDefinitions).map((kind) => [kind, z.string().default('')])) as Record<PollTemplateKind, z.ZodDefault<z.ZodString>>;

export const pollMessageSettingsSchema = z.preprocess(migrateLegacyPollMessageSettings, z.object({
  ...templateShape,
  activationEnabled: z.boolean().default(false),
  templateVersion: z.literal(2).default(2)
}).strict().default({}));

/** Host migration persists this normalization before editors become available. */
export function migrateLegacyPollMessageSettings(value: unknown): unknown {
  const messages = value && typeof value === 'object' && !Array.isArray(value) ? { ...value as Record<string, unknown> } : {};
  if (messages.templateVersion === 2) { delete messages.mentionEligible; return messages; }
  const source = typeof messages.publication === 'string' && messages.publication.trim() ? messages.publication : '{{default}}';
  messages.publication = messages.mentionEligible === false ? source : `${POLL_DEFAULT_PUBLICATION.split('\n')[0]}\n${source}`;
  messages.templateVersion = 2; delete messages.mentionEligible;
  return messages;
}

export function pollTemplateIssues(kind: PollTemplateKind, source: string): string[] {
  if (!source.trim()) return [];
  if ([...source].length > POLL_TEMPLATE_MAX_LENGTH) return [`Template exceeds ${POLL_TEMPLATE_MAX_LENGTH} characters`];
  return validateValueTemplate(source, pollValueTemplateDefinition(kind)).map((issue) => issue.message);
}

export function validatePollMessageSettings(settings: PollTemplateOverrides, ctx: z.RefinementCtx): void {
  for (const kind of Object.keys(pollTemplateDefinitions) as PollTemplateKind[]) {
    for (const message of pollTemplateIssues(kind, settings[kind] ?? '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['messages', kind], message });
    }
  }
}

export interface PollTemplateDiagnostic { kind: PollTemplateKind; reason: string }

export interface RenderPollTemplateInput {
  kind: PollTemplateKind;
  overrides?: PollTemplateOverrides | undefined;
  values: Readonly<Record<string, string | number | TemplateFragment | undefined>>;
  conditionValues?: Readonly<Record<string, TemplateScalar | undefined>> | undefined;
  t: TranslateFn;
  diagnostic?: ((diagnostic: PollTemplateDiagnostic) => void) | undefined;
}
export function renderPollTemplateFragment(input: RenderPollTemplateInput): TemplateFragment {
  const definition = pollTemplateDefinitions[input.kind];
  const values = Object.fromEntries(definition.tokens.map(token => [token, typeof input.values[token] === 'number' ? String(input.values[token]) : input.values[token]])) as Record<string, string | TemplateFragment | undefined>;
  const raw = { ...Object.fromEntries(Object.entries(input.values).filter(([, value]) => typeof value === 'number')), ...input.conditionValues } as Record<string, TemplateScalar | undefined>;
  const report = (reason: string) => (input.diagnostic ?? (diagnostic => console.warn('Poll template fallback', diagnostic)))({ kind: input.kind, reason });
  const key = `official.poll-assistant.template.${input.kind}`;
  const localized = input.t(key, Object.fromEntries(definition.tokens.map(token => [token, `{${token}}`])));
  const defaultSource = localized !== key && !pollTemplateIssues(input.kind, localized).length ? localized : definition.source;
  const render = (source: string) => {
    const fragment = trimTemplateFragment(renderValueTemplate(source, pollValueTemplateDefinition(input.kind), { displayValues: values, conditionValues: raw, defaultSource }));
    if (!fragment.segments.length) throw new Error('Template rendered empty');
    return fragment;
  };
  const override = input.overrides?.[input.kind];
  if (override?.trim()) {
    try { return render(override); } catch (error) { report(error instanceof Error ? error.message : String(error)); }
  }
  try { return render(defaultSource); } catch (error) { report(error instanceof Error ? error.message : String(error)); }
  return render(definition.source);
}
/** Text-only compatibility entrypoint. Production messages use the fragment API. */
export function renderPollTemplate(input: RenderPollTemplateInput): string {
  const fragment = renderPollTemplateFragment(input);
  if (fragment.segments.some(segment => segment.kind === 'mention')) throw new Error('Mention templates require fragment delivery.');
  return previewTemplateFragment(fragment);
}

/** Preserve every code point, splitting at line/word boundaries where possible. */
export function paginatePollText(text: string, limit = 3_500): string[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid poll message limit');
  const points = [...text];
  const pages: string[] = [];
  let offset = 0;
  while (offset < points.length) {
    let end = Math.min(offset + limit, points.length);
    if (end < points.length) {
      let boundary = end;
      while (boundary > offset + Math.floor(limit / 2) && !/\s/u.test(points[boundary - 1]!)) boundary -= 1;
      if (boundary > offset + Math.floor(limit / 2)) end = boundary;
    }
    pages.push(points.slice(offset, end).join(''));
    offset = end;
  }
  return pages;
}
