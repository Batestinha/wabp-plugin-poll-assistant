import { z } from 'zod';
import type { TranslateFn } from '@wabs/plugin-sdk/i18n';
import { renderConditionalTemplate, validateConditionalTemplate } from '@wabs/plugin-sdk/templates';

const contextTokens = ['pollId', 'question', 'timezone', 'cutoffAt'];
const outcomeTokens = [...contextTokens, 'options', 'certainOptions', 'tiedOptions', 'remainingSeats', 'medianOptions', 'modeOptions', 'total', 'unit'];

/** The editor, validation, localized source catalog and renderer share this contract. */
export const pollTemplateDefinitions = {
  publication: {
    title: 'Publication',
    tokens: [...contextTokens, 'deliveryNotice', 'options', 'purpose', 'rule', 'closing', 'quorum', 'tiePolicy', 'ballotDelivery', 'voterDisclosure', 'activationTimeout', 'postVoteAction'],
    source: '{deliveryNotice}\n\nQuestion: {question}\nOptions:\n{options}\n\nPurpose: {purpose}\nRule: {rule}\nClosing: {closing}{{#if postVoteAction}}\n\n{postVoteAction}{{/if}}'
  },
  publicationOption: { title: 'Publication option row', tokens: ['ordinal', 'label', 'option'], source: '{ordinal}. {label}' },
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
  pollId: 'poll-example', question: 'Morning or afternoon?', timezone: 'Europe/Lisbon', cutoffAt: '12:22:57',
  deliveryNotice: '@all — poll published in this group.', options: 'Afternoon', purpose: 'Decision', rule: 'Most votes',
  closing: '12:22:57', closesAt: '12:22:57', quorum: '50%', tiePolicy: 'Authorized choice', ballotDelivery: 'Group',
  voterDisclosure: 'Named', activationTimeout: '120 minutes', postVoteAction: 'The selected option updates the event.',
  ordinal: '1', label: 'Afternoon', option: 'Afternoon', outcome: 'Selected: Afternoon', responseCount: '2',
  eligibleCount: '4', turnoutPercent: '50', optionResults: 'Afternoon: 2 responses (100% of respondents) (Ana, Rui)',
  count: '2', respondentPercent: '100', eligiblePercent: '50', voters: 'Ana, Rui', certainOptions: 'Afternoon',
  tiedOptions: 'Morning and afternoon', remainingSeats: '1', medianOptions: 'Afternoon', modeOptions: 'Afternoon',
  total: '2', unit: 'items', resolver: 'Ana'
};

export const pollTemplateDefaultMessages: Record<string, string> = Object.fromEntries(
  Object.entries(pollTemplateDefinitions).map(([kind, definition]) => [`official.poll-assistant.template.${kind}`, definition.source])
);

const templateShape = Object.fromEntries(Object.keys(pollTemplateDefinitions).map((kind) => [kind, z.string().default('')])) as Record<PollTemplateKind, z.ZodDefault<z.ZodString>>;

export const pollMessageSettingsSchema = z.object({
  ...templateShape,
  activationEnabled: z.boolean().default(false),
  mentionEligible: z.boolean().default(true)
}).strict().default({});

export function pollTemplateIssues(kind: PollTemplateKind, source: string): string[] {
  if (!source.trim()) return [];
  if ([...source].length > POLL_TEMPLATE_MAX_LENGTH) return [`Template exceeds ${POLL_TEMPLATE_MAX_LENGTH} characters`];
  return validateConditionalTemplate(source, pollTemplateDefinitions[kind].tokens).map((issue) => issue.message);
}

export function validatePollMessageSettings(settings: PollTemplateOverrides, ctx: z.RefinementCtx): void {
  for (const kind of Object.keys(pollTemplateDefinitions) as PollTemplateKind[]) {
    for (const message of pollTemplateIssues(kind, settings[kind] ?? '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['messages', kind], message });
    }
  }
}

export interface PollTemplateDiagnostic { kind: PollTemplateKind; reason: string }

export function renderPollTemplate(input: {
  kind: PollTemplateKind;
  overrides?: PollTemplateOverrides | undefined;
  values: Readonly<Record<string, string | number | undefined>>;
  t: TranslateFn;
  diagnostic?: ((diagnostic: PollTemplateDiagnostic) => void) | undefined;
}): string {
  const definition = pollTemplateDefinitions[input.kind];
  const values = Object.fromEntries(definition.tokens.map((token) => [token, input.values[token] === undefined ? undefined : String(input.values[token])]));
  const report = (reason: string) => (input.diagnostic ?? ((diagnostic) => console.warn('Poll template fallback', diagnostic)))({ kind: input.kind, reason });
  const render = (source: string) => {
    const issues = pollTemplateIssues(input.kind, source);
    if (issues.length) throw new Error(issues.join('; '));
    const result = renderConditionalTemplate(source, values).trim();
    if (!result) throw new Error('Template rendered empty');
    return result;
  };
  const override = input.overrides?.[input.kind];
  if (override?.trim()) {
    try { return render(override); }
    catch (error) { report(error instanceof Error ? error.message : String(error)); }
  }
  const key = `official.poll-assistant.template.${input.kind}`;
  // Preserve template tokens when obtaining the localized source; interpolate only after parsing it.
  const localized = input.t(key, Object.fromEntries(definition.tokens.map((token) => [token, `{${token}}`])));
  if (localized !== key) {
    try { return render(localized); }
    catch (error) { report(error instanceof Error ? error.message : String(error)); }
  }
  return render(definition.source);
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
