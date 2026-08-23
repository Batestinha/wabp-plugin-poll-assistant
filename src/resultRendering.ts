import type { TranslateFn } from '../../../platform/i18n/types';
import type {
  PollBallot,
  PollDefinition,
  PollElector,
  PollResult
} from './domain';
import { describePollRandomDraw } from './resultCalculator';

const MESSAGE_PREFIX = 'official.poll-assistant.result';
export const POLL_RESULT_MESSAGE_MAX_CODEPOINTS = 3_500;

type RenderPollResultInput = {
  definition: PollDefinition;
  result: PollResult;
  cutoffAtLabel: string;
  locale: string;
  t: TranslateFn;
  ballots?: readonly PollBallot[] | undefined;
  electorate?: readonly PollElector[] | undefined;
};

export function renderPollResult(input: RenderPollResultInput): string {
  const rendered = renderPollResultParts(input);
  const text = rendered.namedBallots.length > 0
    ? [rendered.summary, input.t(`${MESSAGE_PREFIX}.namedBallots`), ...rendered.namedBallots].join('\n')
    : rendered.summary;
  if (codePointLength(text) > POLL_RESULT_MESSAGE_MAX_CODEPOINTS) {
    throw new Error('Poll result requires paginated delivery.');
  }
  return text;
}

export function renderPollResultMessages(input: RenderPollResultInput): string[] {
  const rendered = renderPollResultParts(input);
  if (codePointLength(rendered.summary) > POLL_RESULT_MESSAGE_MAX_CODEPOINTS) {
    throw new Error('Poll result summary exceeds the safe WhatsApp message limit.');
  }
  return rendered.namedBallots.length === 0
    ? [rendered.summary]
    : [rendered.summary, ...paginateNamedBallots(rendered.namedBallots, input.t)];
}

function renderPollResultParts(input: RenderPollResultInput): {
  summary: string;
  namedBallots: string[];
} {
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
  let namedBallots: string[] = [];
  if (definition.ballotDelivery === 'private' && definition.voterDisclosure === 'named') {
    const ballots = input.ballots;
    const electorate = input.electorate;
    if (!ballots || !electorate) {
      throw new Error('Named private poll results require final ballots and electorate labels.');
    }
    namedBallots = renderNamedBallots(ballots, electorate, labelByOptionId, locale, t);
  }
  return { summary: lines.join('\n'), namedBallots };
}

function renderNamedBallots(
  ballots: readonly PollBallot[],
  electorate: readonly PollElector[],
  labelByOptionId: ReadonlyMap<string, string>,
  locale: string,
  t: TranslateFn
): string[] {
  const electorByIdentityId = new Map(electorate.map((elector) => [elector.voterIdentityId, elector]));
  const displayLabelCounts = new Map<string, number>();
  for (const elector of electorate) {
    const label = safeResultLabel(elector.displayLabel);
    if (!label) continue;
    const key = normalizedDisplayLabel(label, locale);
    displayLabelCounts.set(key, (displayLabelCounts.get(key) ?? 0) + 1);
  }
  return ballots
    .filter((ballot) => ballot.selectedOptionIds.length > 0)
    .map((ballot) => {
      const elector = electorByIdentityId.get(ballot.voterIdentityId);
      if (!elector) {
        throw new Error(`Named ballot references unknown elector ${ballot.voterIdentityId}.`);
      }
      const displayLabel = safeResultLabel(elector.displayLabel);
      const stableReference = safeResultLabel(elector.voterWid)
        || safeResultLabel(elector.voterIdentityId)
        || `identity:${encodeURIComponent(elector.voterIdentityId)}`;
      const voter = displayLabel
        ? (displayLabelCounts.get(normalizedDisplayLabel(displayLabel, locale)) ?? 0) > 1
          ? `${displayLabel} · ${stableReference}`
          : displayLabel
        : stableReference;
      return {
        voter,
        text: t(`${MESSAGE_PREFIX}.namedBallot`, {
          voter,
          options: optionList(labelByOptionId, ballot.selectedOptionIds, locale)
        })
      };
    })
    .sort((left, right) => left.voter.localeCompare(right.voter, locale))
    .map(({ text }) => text);
}

function paginateNamedBallots(lines: readonly string[], t: TranslateFn): string[] {
  const pages: string[] = [];
  let page = 1;
  let current: string[] = [];
  for (const line of lines) {
    const header = t(`${MESSAGE_PREFIX}.namedBallotsPage`, { page });
    const candidate = [header, ...current, line].join('\n');
    if (codePointLength(candidate) <= POLL_RESULT_MESSAGE_MAX_CODEPOINTS) {
      current.push(line);
      continue;
    }
    if (current.length === 0) {
      throw new Error('A named poll ballot line exceeds the safe WhatsApp message limit.');
    }
    pages.push([header, ...current].join('\n'));
    page += 1;
    current = [line];
    const nextHeader = t(`${MESSAGE_PREFIX}.namedBallotsPage`, { page });
    if (codePointLength([nextHeader, line].join('\n')) > POLL_RESULT_MESSAGE_MAX_CODEPOINTS) {
      throw new Error('A named poll ballot line exceeds the safe WhatsApp message limit.');
    }
  }
  if (current.length > 0) {
    pages.push([t(`${MESSAGE_PREFIX}.namedBallotsPage`, { page }), ...current].join('\n'));
  }
  return pages;
}

function normalizedDisplayLabel(value: string, locale: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase(locale);
}

function safeResultLabel(value: string | undefined): string | undefined {
  const normalized = value
    ?.normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized || undefined;
}

function codePointLength(value: string): number {
  return [...value].length;
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
      const randomDraw = describePollRandomDraw(definition, result);
      return t(randomDraw
        ? `${MESSAGE_PREFIX}.selectedByRandomDraw`
        : `${MESSAGE_PREFIX}.selected`, {
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
