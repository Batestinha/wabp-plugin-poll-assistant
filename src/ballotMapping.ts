import { equivalentWhatsAppMessageIds } from '../../../platform/transport/messageIds';
import {
  numberPollOptions,
  WHATSAPP_POLL_MAX_OPTIONS,
  WHATSAPP_POLL_MIN_OPTIONS
} from '../../../platform/transport/pollContract';
import type { PollVoteSnapshot } from '../../../platform/transport/transportTypes';
import type { PluginPollVote } from '../../../platform/pluginRuntime/types';
import {
  pollBallotSchema,
  pollReadbackBallotSchema,
  type PollBallot,
  type PollReadbackBallot
} from './domain';

export interface PollRoundOptionSnapshot {
  optionId: string;
  ordinal: number;
  wireLabel: string;
}

export interface PollBallotMappingTarget {
  roundId: string;
  pollWaMessageId: string;
  allowMultipleAnswers: boolean;
  options: readonly PollRoundOptionSnapshot[];
}

export interface ResolvedPollVoteSnapshot extends PollVoteSnapshot {
  voterIdentityId: string;
}

export type PollBallotMappingErrorCode =
  | 'poll_mismatch'
  | 'missing_source_message_id'
  | 'missing_interaction_time'
  | 'interaction_after_cutoff'
  | 'invalid_option_snapshot'
  | 'incomplete_selection'
  | 'selection_mismatch'
  | 'duplicate_selection'
  | 'multiple_answers_not_allowed';

export class PollBallotMappingError extends Error {
  constructor(
    readonly code: PollBallotMappingErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PollBallotMappingError';
  }
}

export function mapPluginPollVoteToBallot(
  vote: PluginPollVote,
  target: PollBallotMappingTarget,
  cutoffAt?: Date | undefined
): PollBallot {
  const mapped = mapResolvedPollVote(vote, target, cutoffAt);
  return pollBallotSchema.parse({
    roundId: target.roundId,
    voterIdentityId: vote.voterIdentityId,
    voterWid: vote.voterWid,
    selectedOptionIds: mapped.selectedOptionIds,
    source: { kind: 'transport_event', waMessageId: mapped.sourceWaMessageId },
    interactedAt: mapped.interactedAt
  });
}

export function mapResolvedPollVoteToReadbackBallot(
  vote: ResolvedPollVoteSnapshot,
  target: PollBallotMappingTarget,
  cutoffAt?: Date | undefined
): PollReadbackBallot {
  const mapped = mapResolvedPollVote(vote, target, cutoffAt);
  return pollReadbackBallotSchema.parse({
    voterIdentityId: vote.voterIdentityId,
    voterWid: vote.voterWid,
    selectedOptionIds: mapped.selectedOptionIds,
    sourceWaMessageId: mapped.sourceWaMessageId,
    interactedAt: mapped.interactedAt,
    ...(vote.receivedAt ? { receivedAt: vote.receivedAt.toISOString() } : {})
  });
}

function mapResolvedPollVote(
  vote: ResolvedPollVoteSnapshot,
  target: PollBallotMappingTarget,
  cutoffAt?: Date | undefined
): { selectedOptionIds: string[]; sourceWaMessageId: string; interactedAt: string } {
  if (!equivalentWhatsAppMessageIds(vote.pollWaMsgId, target.pollWaMessageId)) {
    throw new PollBallotMappingError(
      'poll_mismatch',
      `Vote poll ${vote.pollWaMsgId} does not match round ${target.roundId}.`
    );
  }
  const sourceWaMessageId = vote.sourceWaMsgId?.trim();
  if (!sourceWaMessageId) {
    throw new PollBallotMappingError(
      'missing_source_message_id',
      `Vote for round ${target.roundId} has no source message id.`
    );
  }
  const interactedAt = vote.interactedAt;
  if (!interactedAt || Number.isNaN(interactedAt.getTime())) {
    throw new PollBallotMappingError(
      'missing_interaction_time',
      `Vote ${sourceWaMessageId} has no valid interaction time.`
    );
  }
  if (cutoffAt && interactedAt.getTime() > cutoffAt.getTime()) {
    throw new PollBallotMappingError(
      'interaction_after_cutoff',
      `Vote ${sourceWaMessageId} occurred after the round cutoff.`
    );
  }

  const options = canonicalOptionSnapshot(target);
  const selectedOptionIds = mapSelections(vote, options, sourceWaMessageId);
  if (!target.allowMultipleAnswers && selectedOptionIds.length > 1) {
    throw new PollBallotMappingError(
      'multiple_answers_not_allowed',
      `Vote ${sourceWaMessageId} selects more than one option.`
    );
  }

  return { selectedOptionIds, sourceWaMessageId, interactedAt: interactedAt.toISOString() };
}

function canonicalOptionSnapshot(target: PollBallotMappingTarget): PollRoundOptionSnapshot[] {
  const options = [...target.options].sort((left, right) => left.ordinal - right.ordinal);
  const renderedWireLabels = numberPollOptions(options.map((option) => option.wireLabel));
  if (options.length < WHATSAPP_POLL_MIN_OPTIONS || options.length > WHATSAPP_POLL_MAX_OPTIONS) {
    throw new PollBallotMappingError(
      'invalid_option_snapshot',
      `Round ${target.roundId} has an invalid option count.`
    );
  }
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  const labels = new Set<string>();
  for (const [index, option] of options.entries()) {
    const renderedWireLabel = renderedWireLabels[index]!;
    if (
      !option.optionId.trim()
      || !Number.isSafeInteger(option.ordinal)
      || option.ordinal < 1
      || !option.wireLabel.trim()
      || ids.has(option.optionId)
      || ordinals.has(option.ordinal)
      || labels.has(renderedWireLabel)
    ) {
      throw new PollBallotMappingError(
        'invalid_option_snapshot',
        `Round ${target.roundId} has a non-canonical option snapshot.`
      );
    }
    ids.add(option.optionId);
    ordinals.add(option.ordinal);
    labels.add(renderedWireLabel);
  }
  if (options.some((option, index) => option.ordinal !== index + 1)) {
    throw new PollBallotMappingError(
      'invalid_option_snapshot',
      `Round ${target.roundId} option ordinals are not contiguous.`
    );
  }
  return options.map((option, index) => ({
    ...option,
    // Every transport applies the canonical numeric wire rendering before
    // publication. Source-owned surveys retain their exact logical labels in
    // storage, so readback must compare against what WhatsApp actually saw.
    wireLabel: renderedWireLabels[index]!
  }));
}

function mapSelections(
  vote: PollVoteSnapshot,
  options: readonly PollRoundOptionSnapshot[],
  sourceWaMessageId: string
): string[] {
  if (vote.selectedOptions.length === 0) {
    if (
      vote.selectedOptionIds.length > 0
      || vote.selectedOptionNames.length > 0
      || vote.selectedOptionNumbers.length > 0
    ) {
      throw new PollBallotMappingError(
        'selection_mismatch',
        `Vote ${sourceWaMessageId} has inconsistent selection projections.`
      );
    }
    return [];
  }

  const optionByOrdinal = new Map(options.map((option) => [option.ordinal, option]));
  const optionByWireLabel = new Map(options.map((option) => [option.wireLabel, option]));
  const selected = vote.selectedOptions.map((selection) => {
    if (!selection.name || !selection.number) {
      throw new PollBallotMappingError(
        'incomplete_selection',
        `Vote ${sourceWaMessageId} lacks an exact option label or ordinal.`
      );
    }
    const byOrdinal = optionByOrdinal.get(selection.number);
    const byWireLabel = optionByWireLabel.get(selection.name);
    if (!byOrdinal || !byWireLabel || byOrdinal.optionId !== byWireLabel.optionId) {
      throw new PollBallotMappingError(
        'selection_mismatch',
        `Vote ${sourceWaMessageId} does not match the immutable option snapshot.`
      );
    }
    return byOrdinal;
  });

  const projectedNames = selected.map((option) => option.wireLabel);
  const projectedOrdinals = selected.map((option) => option.ordinal);
  if (
    (vote.selectedOptionNames.length > 0 && !sameArray(vote.selectedOptionNames, projectedNames))
    || (vote.selectedOptionNumbers.length > 0 && !sameArray(vote.selectedOptionNumbers, projectedOrdinals))
  ) {
    throw new PollBallotMappingError(
      'selection_mismatch',
      `Vote ${sourceWaMessageId} has conflicting option projections.`
    );
  }

  const selectedOptionIds = selected.map((option) => option.optionId);
  if (new Set(selectedOptionIds).size !== selectedOptionIds.length) {
    throw new PollBallotMappingError(
      'duplicate_selection',
      `Vote ${sourceWaMessageId} repeats an option.`
    );
  }
  return selectedOptionIds;
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
