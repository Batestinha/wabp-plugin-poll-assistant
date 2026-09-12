import type { PluginJobContext } from '../../../../packages/plugin-sdk/src/jobs';
import type { PluginDatabaseRegistry } from '../../../../packages/plugin-sdk/src/database';
import { type PluginCommandContext } from './runtime';
import type { MessageActor } from '../../../../packages/plugin-sdk/src/message-actor';
import { POLL_ASSISTANT_PLUGIN_ID } from './database';
import { enqueuePollFinalizeJob } from './jobs';
import {
  getPollAggregate,
  listPollsByChat,
  pollsDatabase,
  requestPollRoundClose,
  type StoredPoll,
  type StoredPollAggregate,
  type StoredPollRound
} from './store';

const POLL_GROUP_LIST_LIMIT = 50;

export type PollGroupLookup =
  | { kind: 'found'; aggregate: StoredPollAggregate }
  | { kind: 'not_found' }
  | { kind: 'wrong_group' };

export function listPollAggregatesForGroup(input: {
  databases: PluginDatabaseRegistry | undefined;
  scopeId: string;
  groupWid: string;
  limit?: number | undefined;
}): StoredPollAggregate[] {
  const db = pollsDatabase(input.databases);
  return listPollsByChat(db, input.groupWid, input.limit ?? POLL_GROUP_LIST_LIMIT)
    .filter((poll) => poll.scopeId === input.scopeId)
    .flatMap((poll) => {
      const aggregate = getPollAggregate(db, poll.id);
      return aggregate ? [aggregate] : [];
    });
}

export function lookupPollForGroup(input: {
  databases: PluginDatabaseRegistry | undefined;
  scopeId: string;
  groupWid: string;
  pollId: string;
}): PollGroupLookup {
  const aggregate = getPollAggregate(pollsDatabase(input.databases), input.pollId.trim());
  if (!aggregate || aggregate.poll.scopeId !== input.scopeId) {
    return { kind: 'not_found' };
  }
  return aggregate.poll.chatId === input.groupWid
    ? { kind: 'found', aggregate }
    : { kind: 'wrong_group' };
}

export function latestPollRound(aggregate: StoredPollAggregate): StoredPollRound | undefined {
  return aggregate.rounds.at(-1);
}

export function openPollAggregatesForGroup(input: {
  databases: PluginDatabaseRegistry | undefined;
  scopeId: string;
  groupWid: string;
}): StoredPollAggregate[] {
  return listPollAggregatesForGroup(input).filter((aggregate) =>
    latestPollRound(aggregate)?.status === 'open'
  );
}

export async function actorCanManagePoll(input: {
  context: Pick<PluginCommandContext, 'explainPermission'>;
  actor: MessageActor | undefined;
  poll: StoredPoll;
}): Promise<boolean> {
  const actorIdentityId = input.actor?.identityAddress.identityId;
  if (!actorIdentityId) {
    return false;
  }
  if (actorIdentityId === input.poll.creatorIdentityId) {
    return true;
  }
  const decision = await input.context.explainPermission?.({
    actorIdentityId,
    action: 'polls.manage',
    scopeId: input.poll.scopeId,
    pluginId: POLL_ASSISTANT_PLUGIN_ID,
    ...(input.poll.groupId ? { groupId: input.poll.groupId } : {}),
    groupWid: input.poll.chatId,
    requiresCurrentManagedGroupMembership: true,
    currentManagedGroupMembershipMode: 'effective_scope'
  });
  return decision?.allowed === true;
}

export type PollCloseRequestResult =
  | { kind: 'queued'; round: StoredPollRound; requestedAt: Date }
  | { kind: 'not_open' };

export async function requestPollClose(input: {
  context: PluginJobContext;
  databases: PluginDatabaseRegistry | undefined;
  aggregate: StoredPollAggregate;
  requestedAt?: Date | undefined;
}): Promise<PollCloseRequestResult> {
  const round = latestPollRound(input.aggregate);
  if (!round || round.status !== 'open') {
    return { kind: 'not_open' };
  }
  const requestedAt = input.requestedAt ?? new Date();
  if (!requestPollRoundClose(pollsDatabase(input.databases), {
    roundId: round.id,
    requestedAt: requestedAt.toISOString()
  })) {
    return { kind: 'not_open' };
  }
  await enqueuePollFinalizeJob(input.context, {
    scopeId: input.aggregate.poll.scopeId,
    pollId: input.aggregate.poll.id,
    roundId: round.id,
    ...(input.aggregate.poll.groupId ? { groupId: input.aggregate.poll.groupId } : {}),
    groupWid: input.aggregate.poll.chatId,
    runAt: requestedAt,
    attempt: round.finalizationAttempt + 1
  });
  return { kind: 'queued', round, requestedAt };
}
