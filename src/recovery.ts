import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { cleanupPollBallots } from './delivery';
import {
  enqueuePollDeliveryJob,
  enqueuePollFinalizeJob,
  enqueuePollPublishJob
} from './jobs';
import {
  getPollAggregate,
  getPollDelivery,
  getPollLifecycleByRoundId,
  listPollCleanupCandidateIds,
  listRecoverablePollDeliveryIds,
  listRecoverablePollRounds,
  markPollCleanupReview,
  pollsDatabase,
  reconcileUncertainPollDelivery
} from './store';

export const POLL_ASSISTANT_RECOVERY_SWEEP_MS = 30_000;
const POLL_CLEANUP_FAILURE_REVIEW_MS = 5 * 60_000;

export async function recoverPollAssistantJobs(
  context: PluginRuntimeContext,
  now: Date = new Date()
): Promise<number> {
  const db = pollsDatabase(context.databases);
  let enqueued = 0;
  for (const recoverable of listRecoverablePollRounds(db, {
    now: now.toISOString(),
    limit: 100
  })) {
    const snapshot = getPollLifecycleByRoundId(db, recoverable.round.id);
    if (!snapshot) {
      continue;
    }
    if (recoverable.kind === 'publication') {
      await enqueuePollPublishJob(context, {
        scopeId: snapshot.poll.scopeId,
        pollId: snapshot.poll.id,
        roundId: snapshot.round.id,
        ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
        groupWid: snapshot.poll.chatId,
        attempt: snapshot.round.publicationAttempt + 1,
        runAt: now
      });
    } else {
      await enqueuePollFinalizeJob(context, {
        scopeId: snapshot.poll.scopeId,
        pollId: snapshot.poll.id,
        roundId: snapshot.round.id,
        ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
        groupWid: snapshot.poll.chatId,
        attempt: snapshot.round.finalizationAttempt + 1,
        runAt: now
      });
    }
    enqueued += 1;
  }

  for (const deliveryId of listRecoverablePollDeliveryIds(db, {
    now: now.toISOString(),
    limit: 100
  })) {
    let delivery = getPollDelivery(db, deliveryId);
    if (!delivery) {
      continue;
    }
    if (delivery.status === 'uncertain') {
      const reconciled = reconcileUncertainPollDelivery(db, {
        deliveryId,
        resolution: 'retry',
        reconciledAt: now.toISOString(),
        nextAttemptAt: now.toISOString(),
        note: 'Automatic retry uses the persisted transport idempotency key.'
      });
      if (!reconciled) {
        continue;
      }
      delivery = getPollDelivery(db, deliveryId)!;
    }
    const aggregate = getPollAggregate(db, delivery.pollId);
    if (!aggregate) {
      continue;
    }
    await enqueuePollDeliveryJob(context, {
      scopeId: aggregate.poll.scopeId,
      deliveryId,
      ...(aggregate.poll.groupId ? { groupId: aggregate.poll.groupId } : {}),
      groupWid: aggregate.poll.chatId,
      attempt: delivery.attempt + 1,
      runAt: now
    });
    enqueued += 1;
  }

  for (const pollId of listPollCleanupCandidateIds(db, {
    terminalBefore: now.toISOString(),
    limit: 100
  })) {
    try {
      await cleanupPollBallots(context, pollId, () => now);
      enqueued += 1;
    } catch (error) {
      const nextReviewAt = new Date(
        now.getTime() + POLL_CLEANUP_FAILURE_REVIEW_MS
      ).toISOString();
      let reviewDeferred = false;
      try {
        reviewDeferred = markPollCleanupReview(db, { pollId, nextReviewAt });
      } catch (reviewError) {
        context.logger.error(
          { error: reviewError, pollId, nextReviewAt },
          'official.poll-assistant failed to defer a cleanup candidate after an error'
        );
      }
      context.logger.error(
        { error, pollId, nextReviewAt, reviewDeferred },
        'official.poll-assistant poll cleanup candidate failed'
      );
      try {
        await context.audit.record({
          action: 'poll-assistant.cleanup.failed',
          targetJson: { pollId },
          metadataJson: {
            error: error instanceof Error ? error.message : String(error),
            nextReviewAt,
            reviewDeferred
          }
        });
      } catch (auditError) {
        context.logger.warn(
          { error: auditError, pollId },
          'official.poll-assistant could not audit a cleanup candidate failure'
        );
      }
    }
  }
  return enqueued;
}

export function startPollAssistantRecovery(context: PluginRuntimeContext): () => Promise<void> {
  let stopped = false;
  let activeSweep: Promise<void> | undefined;
  const sweep = async (): Promise<void> => {
    if (stopped || activeSweep) {
      return;
    }
    activeSweep = recoverPollAssistantJobs(context)
      .then(() => undefined)
      .catch((error) => {
        context.logger.error({ error }, 'official.poll-assistant recovery sweep failed');
      })
      .finally(() => {
        activeSweep = undefined;
      });
    await activeSweep;
  };
  void sweep();
  const timer = setInterval(() => void sweep(), POLL_ASSISTANT_RECOVERY_SWEEP_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await activeSweep;
  };
}
