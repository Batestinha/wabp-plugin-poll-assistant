import {
  decidePollResultSchema,
  countPollResultSchema,
  measurePollResultSchema,
  pollBallotSchema,
  pollDefinitionSchema,
  pollAllowsMultipleAnswers,
  type DecidePollDefinition,
  type DecidePollResult,
  type CountPollDefinition,
  type CountPollResult,
  type MeasurePollDefinition,
  type MeasurePollResult,
  type PollBallot,
  type PollDefinition,
  type PollOptionTally,
  type PollResult
} from './domain';

export interface CalculatePollResultInput {
  definition: PollDefinition;
  roundId: string;
  electorateIdentityIds: readonly string[];
  ballots: readonly PollBallot[];
  cutoffAt: string;
  computedAt: string;
}

export function calculatePollResult(input: CalculatePollResultInput): PollResult {
  const definition = pollDefinitionSchema.parse(input.definition);
  const ballots = input.ballots.map((ballot) => pollBallotSchema.parse(ballot));
  assertCanonicalInputs(
    definition,
    input.roundId,
    input.electorateIdentityIds,
    ballots,
    input.cutoffAt
  );

  const orderedOptions = [...definition.options].sort((left, right) => left.ordinal - right.ordinal);
  const respondingBallots = ballots.filter((ballot) => ballot.selectedOptionIds.length > 0);
  const responseCount = respondingBallots.length;
  const eligibleCount = input.electorateIdentityIds.length;
  const tallies: PollOptionTally[] = orderedOptions.map((option) => {
    const count = respondingBallots.reduce(
      (total, ballot) => total + Number(ballot.selectedOptionIds.includes(option.id)),
      0
    );
    return {
      optionId: option.id,
      count,
      respondentShareBasisPoints: responseCount === 0
        ? 0
        : Math.floor((count * 10_000) / responseCount)
    };
  });
  const quorumMet = calculateQuorumMet(definition, eligibleCount, responseCount);
  const common = {
    schemaVersion: definition.schemaVersion,
    pollId: definition.id,
    roundId: input.roundId,
    computedAt: input.computedAt,
    cutoffAt: input.cutoffAt,
    eligibleCount,
    responseCount,
    turnoutBasisPoints: eligibleCount === 0
      ? 0
      : Math.floor((responseCount * 10_000) / eligibleCount),
    quorum: definition.quorum,
    quorumMet,
    tallies
  } as const;

  if (definition.purpose === 'decide') {
    const result: DecidePollResult = {
      ...common,
      purpose: 'decide',
      outcome: quorumMet
        ? calculateDecisionOutcome(definition, tallies)
        : { status: 'quorum_not_met' }
    };
    return decidePollResultSchema.parse(result);
  }
  if (definition.purpose === 'measure') {
    const result: MeasurePollResult = {
      ...common,
      purpose: 'measure',
      outcome: quorumMet
        ? {
            status: 'measured',
            analysis: calculateMeasureAnalysis(definition, respondingBallots, tallies)
          }
        : { status: 'quorum_not_met' }
    };
    return measurePollResultSchema.parse(result);
  }

  const result: CountPollResult = {
    ...common,
    purpose: 'count',
    outcome: quorumMet
      ? {
          status: 'counted',
          total: calculateCountTotal(definition, respondingBallots),
          unit: definition.rule.unit
        }
      : { status: 'quorum_not_met' }
  };
  return countPollResultSchema.parse(result);
}

function assertCanonicalInputs(
  definition: PollDefinition,
  roundId: string,
  electorateIdentityIds: readonly string[],
  ballots: readonly PollBallot[],
  cutoffAt: string
): void {
  if (!roundId.trim()) {
    throw new Error('roundId is required.');
  }
  if (new Set(electorateIdentityIds).size !== electorateIdentityIds.length) {
    throw new Error('Electorate identity ids must be unique.');
  }
  if (electorateIdentityIds.some((identityId) => !identityId.trim())) {
    throw new Error('Electorate identity ids must not be empty.');
  }
  const electorate = new Set(electorateIdentityIds);
  const optionIds = new Set(definition.options.map((option) => option.id));
  const seenBallots = new Set<string>();
  const multipleAnswersAllowed = pollAllowsMultipleAnswers(definition);
  const cutoffTimestamp = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoffTimestamp)) {
    throw new Error('cutoffAt must be a valid timestamp.');
  }

  for (const ballot of ballots) {
    if (ballot.roundId !== roundId) {
      throw new Error(`Ballot ${ballotSourceId(ballot)} belongs to a different round.`);
    }
    if (!electorate.has(ballot.voterIdentityId)) {
      throw new Error(`Voter identity ${ballot.voterIdentityId} is not in the captured electorate.`);
    }
    if (seenBallots.has(ballot.voterIdentityId)) {
      throw new Error(`Multiple materialized ballots exist for voter identity ${ballot.voterIdentityId}.`);
    }
    seenBallots.add(ballot.voterIdentityId);
    if (Date.parse(ballot.interactedAt) > cutoffTimestamp) {
      throw new Error(`Ballot ${ballotSourceId(ballot)} occurred after the result cutoff.`);
    }
    if (ballot.selectedOptionIds.some((optionId) => !optionIds.has(optionId))) {
      throw new Error(`Ballot ${ballotSourceId(ballot)} contains an unknown option id.`);
    }
    if (!multipleAnswersAllowed && ballot.selectedOptionIds.length > 1) {
      throw new Error(`Ballot ${ballotSourceId(ballot)} selects too many options.`);
    }
  }
}

function ballotSourceId(ballot: PollBallot): string {
  return ballot.source.kind === 'transport_event'
    ? ballot.source.waMessageId
    : ballot.source.readbackId;
}

function calculateDecisionOutcome(
  definition: DecidePollDefinition,
  tallies: readonly PollOptionTally[]
): DecidePollResult['outcome'] {
  if (definition.rule.kind === 'approve_reject') {
    const rule = definition.rule;
    const approveCount = tallies.find(
      (tally) => tally.optionId === rule.approveOptionId
    )?.count ?? 0;
    const rejectCount = tallies.find((tally) => tally.optionId === rule.rejectOptionId)?.count ?? 0;
    const responseCount = approveCount + rejectCount;
    if (approveCount === rejectCount) {
      const tiedOutcome = {
        certainOptionIds: [],
        tiedOptionIds: [rule.approveOptionId, rule.rejectOptionId],
        remainingSeats: 1
      };
      if (definition.tiePolicy.kind === 'authorized_choice') {
        return { status: 'tie', ...tiedOutcome };
      }
      if (definition.tiePolicy.kind === 'no_decision') {
        return { status: 'no_decision', reason: 'tie', ...tiedOutcome };
      }
      return { status: 'selected', selectedOptionIds: [rule.rejectOptionId] };
    }
    const approved = responseCount > 0
      && approveCount * 10_000 >= responseCount * rule.minimumApprovalBasisPoints;
    return {
      status: 'selected',
      selectedOptionIds: [approved
        ? rule.approveOptionId
        : rule.rejectOptionId]
    };
  }

  const seats = definition.rule.kind === 'single_non_transferable'
    || definition.rule.kind === 'multiwinner_approval'
    ? definition.rule.seats
    : 1;
  const ordinalByOptionId = new Map(definition.options.map((option) => [option.id, option.ordinal]));
  const ranked = [...tallies].sort((left, right) =>
    right.count - left.count
    || (ordinalByOptionId.get(left.optionId) ?? 0) - (ordinalByOptionId.get(right.optionId) ?? 0)
  );
  const boundaryScore = ranked[seats - 1]?.count;
  if (boundaryScore === undefined) {
    throw new Error('Decision rule has no seat boundary.');
  }
  const certain = ranked.filter((tally) => tally.count > boundaryScore);
  const boundary = ranked.filter((tally) => tally.count === boundaryScore);
  const remainingSeats = seats - certain.length;
  if (boundary.length > remainingSeats) {
    const tiedOutcome = {
      certainOptionIds: certain.map((tally) => tally.optionId),
      tiedOptionIds: boundary.map((tally) => tally.optionId),
      remainingSeats
    };
    return definition.tiePolicy.kind === 'authorized_choice'
      ? { status: 'tie', ...tiedOutcome }
      : { status: 'no_decision', reason: 'tie', ...tiedOutcome };
  }
  return {
    status: 'selected',
    selectedOptionIds: ranked.slice(0, seats).map((tally) => tally.optionId)
  };
}

function calculateMeasureAnalysis(
  definition: MeasurePollDefinition,
  ballots: readonly PollBallot[],
  tallies: readonly PollOptionTally[]
): Extract<MeasurePollResult['outcome'], { status: 'measured' }>['analysis'] {
  if (definition.rule.kind === 'distribution') {
    return { kind: 'distribution' };
  }
  const ordinalByOptionId = new Map(definition.options.map((option) => [option.id, option.ordinal]));
  const orderedSelections = ballots
    .map((ballot) => ballot.selectedOptionIds[0])
    .filter((optionId): optionId is string => optionId !== undefined)
    .sort((left, right) => ordinalByOptionId.get(left)! - ordinalByOptionId.get(right)!);
  const medianOptionIds = orderedSelections.length === 0
    ? []
    : [...new Set([
        orderedSelections[Math.floor((orderedSelections.length - 1) / 2)]!,
        orderedSelections[Math.floor(orderedSelections.length / 2)]!
      ])];
  const maximumCount = tallies.reduce((maximum, tally) => Math.max(maximum, tally.count), 0);
  const modeOptionIds = maximumCount === 0
    ? []
    : tallies.filter((tally) => tally.count === maximumCount).map((tally) => tally.optionId);
  return { kind: 'ordered_scale', medianOptionIds, modeOptionIds };
}

function calculateQuorumMet(
  definition: PollDefinition,
  eligibleCount: number,
  responseCount: number
): boolean {
  if (definition.quorum.kind === 'none') {
    return true;
  }
  if (definition.quorum.kind === 'absolute') {
    return responseCount >= definition.quorum.minimumResponses;
  }
  return responseCount * 10_000
    >= eligibleCount * definition.quorum.minimumTurnoutBasisPoints;
}

function calculateCountTotal(
  definition: CountPollDefinition,
  ballots: readonly PollBallot[]
): number {
  const numericValues = new Map(definition.options.map((option) => [option.id, option.numericValue!]));
  let total = 0;
  for (const ballot of ballots) {
    const selectedOptionId = ballot.selectedOptionIds[0];
    if (!selectedOptionId) {
      continue;
    }
    const value = numericValues.get(selectedOptionId);
    if (value === undefined) {
      throw new Error(`Count option ${selectedOptionId} has no numeric value.`);
    }
    const next = total + value;
    if (!Number.isSafeInteger(next)) {
      throw new Error('Count result exceeds the safe integer range.');
    }
    total = next;
  }
  return total;
}
