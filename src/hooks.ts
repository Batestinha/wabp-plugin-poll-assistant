import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type {
  PluginJobEvent,
  PluginPollVotePluginEvent,
  PluginRuntimeHooks
} from '../../../platform/pluginRuntime/types';
import { PollBallotMappingError, mapPluginPollVoteToBallot } from './ballotMapping';
import { cleanupPollBallots, deliverPollMessage } from './delivery';
import { finalizePollRound } from './finalization';
import {
  POLL_CLEANUP_JOB,
  POLL_DELIVER_JOB,
  POLL_FINALIZE_JOB,
  POLL_PUBLISH_JOB,
  pollCleanupJobPayloadSchema,
  pollDeliveryJobPayloadSchema,
  pollRoundJobPayloadSchema
} from './jobs';
import { publishPollRound } from './publication';
import { startPollAssistantRecovery } from './recovery';
import {
  getPollRoundSnapshotByWhatsAppMessageId,
  pollsDatabase,
  recordPollVoteEvent
} from './store';

export interface PollAssistantHooksOptions {
  recoverJobs?: boolean | undefined;
}

export function createPollAssistantHooks(
  context: PluginRuntimeContext,
  options: PollAssistantHooksOptions = {}
): PluginRuntimeHooks {
  if (options.recoverJobs !== false) {
    startPollAssistantRecovery(context);
  }
  return {
    async onPollVote(event) {
      await handlePollAssistantVote(context, event);
    },
    async onPluginJob(event) {
      await handlePollAssistantJob(context, event);
    }
  };
}

export async function handlePollAssistantVote(
  context: PluginRuntimeContext,
  event: PluginPollVotePluginEvent
): Promise<void> {
  const db = pollsDatabase(context.databases);
  const snapshot = getPollRoundSnapshotByWhatsAppMessageId(db, event.vote.pollWaMsgId);
  if (!snapshot || snapshot.poll.scopeId !== event.scopeId) {
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
        pollWaMessageId: snapshot.round.pollWaMessageId!,
        allowMultipleAnswers: snapshot.round.allowMultipleAnswers,
        options: snapshot.options.map((option) => ({
          optionId: option.optionId,
          ordinal: option.ordinal,
          wireLabel: option.wireLabel
        }))
      },
      snapshot.round.closesAt ? new Date(snapshot.round.closesAt) : undefined
    );
    recordPollVoteEvent(db, {
      ballot,
      receivedAt: event.receivedAt.toISOString()
    });
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
  if (event.jobName === POLL_PUBLISH_JOB || event.jobName === POLL_FINALIZE_JOB) {
    const parsed = pollRoundJobPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      await auditInvalidJob(context, event);
      return;
    }
    if (event.jobName === POLL_PUBLISH_JOB) {
      await publishPollRound(context, parsed.data.pollId, parsed.data.roundId);
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
