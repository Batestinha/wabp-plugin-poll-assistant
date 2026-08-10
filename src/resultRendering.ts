import type { TranslateFn } from '../../../platform/i18n/types';
import type { PollDefinition, PollResult } from './domain';

const MESSAGE_PREFIX = 'official.poll-assistant.result';

export function renderPollResult(input: {
  definition: PollDefinition;
  result: PollResult;
  cutoffAtLabel: string;
  locale: string;
  t: TranslateFn;
}): string {
  const { definition, result, cutoffAtLabel, locale, t } = input;
  if (definition.id !== result.pollId || definition.purpose !== result.purpose) {
    throw new Error('Poll result does not match its definition.');
  }
  const labelByOptionId = new Map(definition.options.map((option) => [option.id, option.label]));
  const lines = [t(`${MESSAGE_PREFIX}.summary`, {
    question: definition.question,
    responseCount: result.responseCount,
    eligibleCount: result.eligibleCount,
    turnoutPercent: result.turnoutBasisPoints / 100,
    cutoffAt: cutoffAtLabel
  })];
  for (const tally of result.tallies) {
    lines.push(t(`${MESSAGE_PREFIX}.tally`, {
      option: requireOptionLabel(labelByOptionId, tally.optionId),
      count: tally.count,
      respondentPercent: tally.respondentShareBasisPoints / 100
    }));
  }
  lines.push(renderOutcome(definition, result, labelByOptionId, locale, t));
  return lines.join('\n');
}

function renderOutcome(
  definition: PollDefinition,
  result: PollResult,
  labelByOptionId: ReadonlyMap<string, string>,
  locale: string,
  t: TranslateFn
): string {
  if (result.outcome.status === 'quorum_not_met') {
    return t(`${MESSAGE_PREFIX}.quorumNotMet`);
  }
  if (result.purpose === 'decide') {
    if (result.outcome.status === 'selected') {
      return t(`${MESSAGE_PREFIX}.selected`, {
        options: optionList(labelByOptionId, result.outcome.selectedOptionIds, locale)
      });
    }
    if (result.outcome.status === 'tie') {
      return t(`${MESSAGE_PREFIX}.tie`, {
        certainOptions: optionList(labelByOptionId, result.outcome.certainOptionIds, locale),
        tiedOptions: optionList(labelByOptionId, result.outcome.tiedOptionIds, locale),
        remainingSeats: result.outcome.remainingSeats
      });
    }
    return t(`${MESSAGE_PREFIX}.noDecision`, {
      certainOptions: optionList(labelByOptionId, result.outcome.certainOptionIds, locale),
      tiedOptions: optionList(labelByOptionId, result.outcome.tiedOptionIds, locale),
      remainingSeats: result.outcome.remainingSeats
    });
  }
  if (result.purpose === 'measure') {
    if (result.outcome.analysis.kind === 'distribution') {
      return t(`${MESSAGE_PREFIX}.measuredDistribution`);
    }
    return t(`${MESSAGE_PREFIX}.measuredScale`, {
      medianOptions: optionList(labelByOptionId, result.outcome.analysis.medianOptionIds, locale),
      modeOptions: optionList(labelByOptionId, result.outcome.analysis.modeOptionIds, locale)
    });
  }
  return t(`${MESSAGE_PREFIX}.counted`, {
    total: result.outcome.total,
    unit: result.outcome.unit
  });
}

function optionList(
  labels: ReadonlyMap<string, string>,
  optionIds: readonly string[],
  locale: string
): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(
    optionIds.map((optionId) => requireOptionLabel(labels, optionId))
  );
}

function requireOptionLabel(labels: ReadonlyMap<string, string>, optionId: string): string {
  const label = labels.get(optionId);
  if (!label) {
    throw new Error(`Poll result references unknown option ${optionId}.`);
  }
  return label;
}
