import type { StableIdentityAddressResolution } from '../../../platform/identity/identityAddressService';
import { requireCompletePollVotes } from '../../../platform/transport/pollVoteReadback';
import type { PollVoteReadback } from '../../../platform/transport/transportTypes';
import { equivalentWhatsAppMessageIds } from '../../../platform/transport/messageIds';
import type { PollReadbackBallot } from './domain';
import {
  mapResolvedPollVoteToReadbackBallot,
  type PollBallotMappingTarget,
  type ResolvedPollVoteSnapshot
} from './ballotMapping';

export async function mapAuthoritativePollReadback(input: {
  readback: PollVoteReadback;
  target: PollBallotMappingTarget;
  cutoffAt: Date;
  electorateWidByIdentityId: ReadonlyMap<string, string>;
  resolveIdentityAddress(wid: string): Promise<StableIdentityAddressResolution>;
}): Promise<PollReadbackBallot[]> {
  const votes = requireCompletePollVotes(input.readback);
  const ballotsByIdentity = new Map<string, {
    ballot: PollReadbackBallot;
    sourceWaMessageId: string;
  }>();
  for (const vote of votes) {
    validateReadbackVoteEnvelope(vote, input.target, input.cutoffAt);
    const identity = await input.resolveIdentityAddress(vote.voterWid);
    const electorateWid = input.electorateWidByIdentityId.get(identity.identityId);
    if (!electorateWid) {
      continue;
    }
    const projected: ResolvedPollVoteSnapshot = {
      ...vote,
      voterIdentityId: identity.identityId,
      // Delivery aliases can change as PN/LID knowledge improves. The frozen
      // electorate address is an immutable publication-time fact and therefore
      // keeps the deterministic readback stable across finalization retries.
      voterWid: electorateWid
    };
    const ballot = mapResolvedPollVoteToReadbackBallot(projected, input.target, input.cutoffAt);
    const sourceWaMessageId = requiredSourceMessageId(vote.sourceWaMsgId);
    const existing = ballotsByIdentity.get(ballot.voterIdentityId);
    if (!existing || ballotIsNewer(ballot, sourceWaMessageId, existing)) {
      ballotsByIdentity.set(ballot.voterIdentityId, { ballot, sourceWaMessageId });
    }
  }
  return [...ballotsByIdentity.values()].map(({ ballot }) => ballot).sort((left, right) =>
    left.voterIdentityId.localeCompare(right.voterIdentityId)
  );
}

function ballotIsNewer(
  candidate: PollReadbackBallot,
  candidateSourceWaMessageId: string,
  existing: { ballot: PollReadbackBallot; sourceWaMessageId: string }
): boolean {
  const difference = Date.parse(candidate.interactedAt) - Date.parse(existing.ballot.interactedAt);
  return difference > 0
    || (difference === 0 && candidateSourceWaMessageId > existing.sourceWaMessageId);
}

function requiredSourceMessageId(value: string | undefined): string {
  const sourceWaMessageId = value?.trim();
  if (!sourceWaMessageId) {
    throw new Error('Authoritative poll readback vote has no source WhatsApp message id.');
  }
  return sourceWaMessageId;
}

function validateReadbackVoteEnvelope(
  vote: PollVoteReadback['votes'][number],
  target: PollBallotMappingTarget,
  cutoffAt: Date
): void {
  requiredSourceMessageId(vote.sourceWaMsgId);
  if (!equivalentWhatsAppMessageIds(vote.pollWaMsgId, target.pollWaMessageId)) {
    throw new Error(`Authoritative readback vote belongs to a different poll than ${target.roundId}.`);
  }
  if (!vote.interactedAt || Number.isNaN(vote.interactedAt.getTime())) {
    throw new Error('Authoritative poll readback vote has no trustworthy interaction timestamp.');
  }
  if (vote.interactedAt.getTime() > cutoffAt.getTime()) {
    throw new Error('Authoritative poll readback returned a vote after the requested cutoff.');
  }
}
