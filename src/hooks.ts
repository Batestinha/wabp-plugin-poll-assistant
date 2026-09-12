import type { PluginRuntimeContext } from './runtime';
import { type PluginJobEvent, type PluginParticipantChangeEvent, type PluginPollVotePluginEvent, type PluginRuntimeHooks } from '../../../../packages/plugin-sdk/src/hooks';
import { PollBallotMappingError, mapPluginPollVoteToBallot } from './ballotMapping';
import { parsePollAssistantConfig } from './config';
import { cleanupPollBallots, deliverPollMessage } from './delivery';
import { finalizePollRound } from './finalization';
import {
  POLL_CLEANUP_JOB,
  POLL_ACTIVATE_JOB,
  POLL_DELIVER_JOB,
  POLL_FINALIZE_JOB,
  POLL_PRIVATE_ISSUE_JOB,
  POLL_PUBLISH_JOB,
  POLL_PRIVATE_ISSUANCE_PACING_MS,
  enqueuePollPrivateIssueJob,
  pollCleanupJobPayloadSchema,
  pollDeliveryJobPayloadSchema,
  pollPrivateIssueJobPayloadSchema,
  pollRoundJobPayloadSchema
} from './jobs';
import { publishPollRound } from './publication';
import { publishPrivatePollIssuance } from './privatePublication';
import { startPollAssistantRecovery } from './recovery';
import {
  getPollRoundSnapshotByWhatsAppMessageId,
  getPollLifecycleByRoundId,
  getPollPrivateIssuanceByWhatsAppMessageId,
  admitLatePollElector,
  listLateAdmissionPollIdsByChat,
  removeLatePollElector,
  pollsDatabase,
  recordPollVoteEvent
} from './store';
import { reconcilePollRoundTiming } from './timing';

export interface PollAssistantHooksOptions {
  recoverJobs?: boolean | undefined;
}

export function createPollAssistantHooks(
  context: PluginRuntimeContext,
  options: PollAssistantHooksOptions = {}
): PluginRuntimeHooks {
  const stopRecovery = options.recoverJobs !== false
    ? startPollAssistantRecovery(context)
    : undefined;
  return {
    ...(stopRecovery ? { onShutdown: stopRecovery } : {}),
    resolvePrivatePollVoteRoute(envelope) {
      const db = pollsDatabase(context.databases);
      const issuance = getPollPrivateIssuanceByWhatsAppMessageId(db, envelope.pollWaMsgId);
      if (
        !issuance
        || issuance.status !== 'sent'
        || issuance.voterIdentityId !== envelope.voterIdentityId
      ) {
        return undefined;
      }
      const snapshot = getPollLifecycleByRoundId(db, issuance.roundId);
      if (
        !snapshot
        || snapshot.poll.definition.ballotDelivery !== 'private'
        || snapshot.poll.status !== 'active'
        || (snapshot.round.status !== 'open' && snapshot.round.status !== 'finalizing')
      ) {
        return undefined;
      }
      return {
        scopeId: snapshot.poll.scopeId,
        groupWid: snapshot.poll.chatId,
        ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {})
      };
    },
    async onPollVote(event) {
      await handlePollAssistantVote(context, event);
    },
    async onParticipantChange(event) {
      await handlePollAssistantParticipantChange(context, event);
    },
    async onPluginJob(event) {
      await handlePollAssistantJob(context, event);
    }
  };
}

export async function handlePollAssistantParticipantChange(
  context: PluginRuntimeContext,
  event: PluginParticipantChangeEvent
): Promise<void> {
  const admits = ['join', 'add', 'membership_approved'].includes(event.action);
  const removes = ['leave', 'remove'].includes(event.action);
  if (!admits && !removes) {
    return;
  }
  const db = pollsDatabase(context.databases);
  const occurredAt = event.occurredAt ?? event.receivedAt;
  const pollIds = listLateAdmissionPollIdsByChat(
    db,
    event.scopeId,
    event.chatId,
    occurredAt.toISOString()
  );
  if (pollIds.length === 0) {
    return;
  }
  const botIdentityIds = new Set(event.botIdentityIds);
  const config = parsePollAssistantConfig(await context.configFor(event.scopeId));
  let slot = 0;
  for (const identity of event.affectedIdentities) {
    if (botIdentityIds.has(identity.identityId)) {
      continue;
    }
    for (const pollId of pollIds) {
      if (removes) {
        removeLatePollElector(db, {
          pollId,
          voterIdentityId: identity.identityId,
          removedAt: occurredAt.toISOString(),
          eventId: event.eventId
        });
        continue;
      }
      const issuance = admitLatePollElector(db, {
        pollId,
        elector: {
          voterIdentityId: identity.identityId,
          voterWid: identity.deliveryChatId,
          ...(identity.displayName ? { displayLabel: identity.displayName } : {})
        },
        admittedAt: occurredAt.toISOString(),
        eventId: event.eventId,
        maxElectorateSize: config.maxPrivateElectorateSize
      });
      if (!issuance || issuance.status === 'sent' || issuance.status === 'failed') {
        continue;
      }
      await enqueuePollPrivateIssueJob(context, {
        scopeId: event.scopeId,
        issuanceId: issuance.id,
        ...(event.groupId ? { groupId: event.groupId } : {}),
        groupWid: event.chatId,
        attempt: issuance.attempt + 1,
        runAt: new Date(event.receivedAt.getTime() + slot * POLL_PRIVATE_ISSUANCE_PACING_MS)
      });
      slot += 1;
    }
  }
}

export async function handlePollAssistantVote(
  context: PluginRuntimeContext,
  event: PluginPollVotePluginEvent
): Promise<void> {
  const db = pollsDatabase(context.databases);
  const privateIssuance = getPollPrivateIssuanceByWhatsAppMessageId(db, event.vote.pollWaMsgId);
  const snapshot = getPollRoundSnapshotByWhatsAppMessageId(db, event.vote.pollWaMsgId)
    ?? (privateIssuance ? getPollLifecycleByRoundId(db, privateIssuance.roundId) : undefined);
  if (!snapshot || snapshot.poll.scopeId !== event.scopeId) {
    return;
  }
  if (
    privateIssuance
    && (
      snapshot.poll.definition.ballotDelivery !== 'private'
      || privateIssuance.voterIdentityId !== event.vote.voterIdentityId
    )
  ) {
    return;
  }
  if (snapshot.round.status !== 'open' && snapshot.round.status !== 'finalizing') {
    return;
  }
  try {
    const ballot = mapPluginPollVoteToBallot(
      event.vote,
      {
        roundId: snapshot.round.id,
        pollWaMessageId: privateIssuance?.pollWaMessageId ?? snapshot.round.pollWaMessageId!,
        allowMultipleAnswers: snapshot.round.allowMultipleAnswers,
        options: snapshot.options.map((option) => ({
          optionId: option.optionId,
          ordinal: option.ordinal,
          wireLabel: option.wireLabel
        }))
      },
      snapshot.round.closesAt ? new Date(snapshot.round.closesAt) : undefined
    );
    const durableReceivedAt = event.vote.receivedAt ?? event.receivedAt;
    recordPollVoteEvent(db, {
      ballot,
      receivedAt: durableReceivedAt.toISOString()
    });
    await reconcilePollRoundTiming(context, snapshot.round.id, durableReceivedAt);
  } catch (error) {
    await context.audit.record({
      actorIdentityId: event.vote.voterIdentityId,
      scopeId: event.scopeId,
      ...(event.groupId ? { groupId: event.groupId } : {}),
      action: 'poll-assistant.vote.rejected',
      targetJson: {
        pollId: snapshot.poll.id,
        roundId: snapshot.round.id,
        sourceWaMessageId: event.vote.sourceWaMsgId
      },
      metadataJson: {
        reason: error instanceof PollBallotMappingError ? error.code : 'store_rejected'
      }
    });
  }
}

export async function handlePollAssistantJob(
  context: PluginRuntimeContext,
  event: PluginJobEvent
): Promise<void> {
  if (
    event.jobName === POLL_PUBLISH_JOB
    || event.jobName === POLL_ACTIVATE_JOB
    || event.jobName === POLL_FINALIZE_JOB
  ) {
    const parsed = pollRoundJobPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      await auditInvalidJob(context, event);
      return;
    }
    if (event.jobName === POLL_PUBLISH_JOB) {
      await publishPollRound(context, parsed.data.pollId, parsed.data.roundId);
    } else if (event.jobName === POLL_ACTIVATE_JOB) {
      await reconcilePollRoundTiming(context, parsed.data.roundId);
    } else {
      await finalizePollRound(context, parsed.data.pollId, parsed.data.roundId);
    }
    return;
  }
  if (event.jobName === POLL_DELIVER_JOB) {
    const parsed = pollDeliveryJobPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      await auditInvalidJob(context, event);
      return;
    }
    await deliverPollMessage(context, parsed.data.deliveryId);
    return;
  }
  if (event.jobName === POLL_PRIVATE_ISSUE_JOB) {
    const parsed = pollPrivateIssueJobPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      await auditInvalidJob(context, event);
      return;
    }
    await publishPrivatePollIssuance(context, parsed.data.issuanceId);
    return;
  }
  if (event.jobName === POLL_CLEANUP_JOB) {
    const parsed = pollCleanupJobPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      await auditInvalidJob(context, event);
      return;
    }
    await cleanupPollBallots(context, parsed.data.pollId);
  }
}

async function auditInvalidJob(
  context: PluginRuntimeContext,
  event: PluginJobEvent
): Promise<void> {
  await context.audit.record({
    scopeId: event.scopeId,
    ...(event.groupId ? { groupId: event.groupId } : {}),
    action: 'poll-assistant.job.rejected',
    targetJson: { jobName: event.jobName },
    metadataJson: { reason: 'invalid_payload' }
  });
}
