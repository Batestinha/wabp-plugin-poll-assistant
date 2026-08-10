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
  pollsDatabase,
  reconcileUncertainPollDelivery
} from './store';

export const POLL_ASSISTANT_RECOVERY_SWEEP_MS = 30_000;

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
        attempt: snapshot.round.publicationAttempt
      });
    } else {
      await enqueuePollFinalizeJob(context, {
        scopeId: snapshot.poll.scopeId,
        pollId: snapshot.poll.id,
        roundId: snapshot.round.id,
        ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
        groupWid: snapshot.poll.chatId,
        attempt: snapshot.round.finalizationAttempt
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
      attempt: delivery.attempt
    });
    enqueued += 1;
  }

  for (const pollId of listPollCleanupCandidateIds(db, {
    terminalBefore: now.toISOString(),
    limit: 100
  })) {
    await cleanupPollBallots(context, pollId, () => now);
    enqueued += 1;
  }
  return enqueued;
}

export function startPollAssistantRecovery(context: PluginRuntimeContext): () => void {
  let running = false;
  const sweep = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      await recoverPollAssistantJobs(context);
    } catch (error) {
      context.logger.error({ error }, 'official.poll-assistant recovery sweep failed');
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), POLL_ASSISTANT_RECOVERY_SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}
