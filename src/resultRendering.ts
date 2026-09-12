import type { TranslateFn } from '../../../../packages/plugin-sdk/src/i18n';
import type { PollBallot, PollDefinition, PollElector, PollResult } from './domain';
import { describePollRandomDraw } from './resultCalculator';
import { paginatePollText, renderPollTemplate, type PollTemplateKind, type PollTemplateOverrides } from './templates';

export const POLL_RESULT_MESSAGE_MAX_CODEPOINTS = 3_500;

type RenderPollResultInput = {
  definition: PollDefinition;
  result: PollResult;
  cutoffAtLabel: string;
  locale: string;
  t: TranslateFn;
  timezone?: string | undefined;
  templates?: PollTemplateOverrides | undefined;
  ballots?: readonly PollBallot[] | undefined;
  electorate?: readonly PollElector[] | undefined;
};

export function renderPollResult(input: RenderPollResultInput): string {
  const messages = renderPollResultMessages(input);
  if (messages.length !== 1) throw new Error('Poll result requires paginated delivery.');
  return messages[0]!;
}

export function renderPollResultMessages(input: RenderPollResultInput): string[] {
  const { definition, result, t, locale } = input;
  if (definition.id !== result.pollId || definition.purpose !== result.purpose) {
    throw new Error('Poll result does not match its definition.');
  }
  const labels = new Map(definition.options.map(option => [option.id, option.label]));
  const context = { question: definition.question, pollId: definition.id, cutoffAt: input.cutoffAtLabel, timezone: input.timezone };
  const render = (kind: PollTemplateKind, values: Record<string, string | number | undefined>) => renderPollTemplate({
    kind, overrides: input.templates, values: { ...context, ...values }, t
  });
  const voters = definition.voterDisclosure === 'named' ? votersByOption(input) : new Map<string, string[]>();
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const optionResults = result.tallies.map(tally => render('resultOption', {
    ordinal: definition.options.find(option => option.id === tally.optionId)!.ordinal,
    option: requireOptionLabel(labels, tally.optionId),
    count: tally.count,
    respondentPercent: number.format(tally.respondentShareBasisPoints / 100),
    eligiblePercent: number.format(result.eligibleCount ? tally.count * 100 / result.eligibleCount : 0),
    voters: voters.get(tally.optionId)?.join(', ') || undefined
  })).join('\n');
  const text = render('result', {
    outcome: renderOutcome(definition, result, labels, locale, render),
    responseCount: result.responseCount, eligibleCount: result.eligibleCount,
    turnoutPercent: number.format(result.turnoutBasisPoints / 100), optionResults
  });
  return paginatePollText(text, POLL_RESULT_MESSAGE_MAX_CODEPOINTS);
}

function votersByOption(input: RenderPollResultInput): Map<string, string[]> {
  if (!input.ballots || !input.electorate) throw new Error('Named poll results require final ballots and electorate labels.');
  const counts = new Map<string, number>();
  const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase(input.locale);
  for (const elector of input.electorate) {
    const name = safeResultLabel(elector.displayLabel);
    if (name) counts.set(normalized(name), (counts.get(normalized(name)) ?? 0) + 1);
  }
  const electors = new Map(input.electorate.map(elector => [elector.voterIdentityId, elector]));
  const named = input.ballots.filter(ballot => ballot.selectedOptionIds.length > 0).map(ballot => {
    const elector = electors.get(ballot.voterIdentityId);
    if (!elector) throw new Error(`Named ballot references unknown elector ${ballot.voterIdentityId}.`);
    const name = safeResultLabel(elector.displayLabel);
    const reference = safeResultLabel(elector.voterWid) || safeResultLabel(elector.voterIdentityId) || `identity:${encodeURIComponent(elector.voterIdentityId)}`;
    const label = name ? (counts.get(normalized(name)) ?? 0) > 1 ? `${name} · ${reference}` : name : reference;
    return { ballot, label };
  }).sort((left, right) => left.label.localeCompare(right.label, input.locale)
    || left.ballot.voterIdentityId.localeCompare(right.ballot.voterIdentityId, 'en'));
  const output = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const { ballot, label } of named) {
    for (const optionId of ballot.selectedOptionIds) {
      if (!input.definition.options.some(option => option.id === optionId)) throw new Error(`Named ballot references unknown option ${optionId}.`);
      const key = JSON.stringify([optionId, ballot.voterIdentityId]);
      if (seen.has(key)) continue;
      seen.add(key);
      const names = output.get(optionId) ?? [];
      names.push(label);
      output.set(optionId, names);
    }
  }
  return output;
}

function safeResultLabel(value: string | undefined): string | undefined {
  return value?.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/gu, ' ').trim() || undefined;
}

function renderOutcome(
  definition: PollDefinition,
  result: PollResult,
  labels: ReadonlyMap<string, string>,
  locale: string,
  render: (kind: PollTemplateKind, values: Record<string, string | number | undefined>) => string
): string {
  const list = (ids: readonly string[]) => new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(ids.map(id => requireOptionLabel(labels, id)));
  if (result.outcome.status === 'quorum_not_met') return render('quorumNotMet', {});
  if (result.purpose === 'decide') {
    if (result.outcome.status === 'selected') return render(describePollRandomDraw(definition, result) ? 'selectedByRandomDraw' : 'selected', { options: list(result.outcome.selectedOptionIds) });
    return render(result.outcome.status === 'tie' ? 'tie' : 'noDecision', {
      certainOptions: list(result.outcome.certainOptionIds) || undefined,
      tiedOptions: list(result.outcome.tiedOptionIds), remainingSeats: result.outcome.remainingSeats
    });
  }
  if (result.purpose === 'measure') {
    if (result.outcome.analysis.kind === 'distribution') return render('measuredDistribution', {});
    return render('measuredScale', { medianOptions: list(result.outcome.analysis.medianOptionIds), modeOptions: list(result.outcome.analysis.modeOptionIds) });
  }
  return render('counted', { total: result.outcome.total, unit: result.outcome.unit });
}

function requireOptionLabel(labels: ReadonlyMap<string, string>, optionId: string): string {
  const label = labels.get(optionId);
  if (!label) throw new Error(`Poll result references unknown option ${optionId}.`);
  return label;
}
