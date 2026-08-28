import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { ensurePollActivationAnnouncement, ensurePollPublicationAnnouncement } from './announcements';
import { enqueuePollActivateJob, enqueuePollFinalizeJob } from './jobs';
import {
  getPollLifecycleByRoundId,
  pollsDatabase,
  processPollRoundActivation
} from './store';

export async function reconcilePollRoundTiming(
  context: Pick<PluginRuntimeContext, 'databases' | 'i18n' | 'configFor' | 'queue'>,
  roundId: string,
  now = new Date()
): Promise<void> {
  const db = pollsDatabase(context.databases);
  processPollRoundActivation(db, { roundId, now: now.toISOString() });
  const snapshot = getPollLifecycleByRoundId(db, roundId);
  if (!snapshot || snapshot.poll.status !== 'active' || snapshot.round.status !== 'open') {
    return;
  }
  await ensurePollPublicationAnnouncement(context, roundId, now);
  if (snapshot.round.closesAt) {
    await ensurePollActivationAnnouncement(context, roundId, now);
    await enqueuePollFinalizeJob(context, {
      scopeId: snapshot.poll.scopeId,
      pollId: snapshot.poll.id,
      roundId,
      ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
      groupWid: snapshot.poll.chatId,
      attempt: snapshot.round.finalizationAttempt + 1,
      runAt: new Date(snapshot.round.closesAt)
    });
    return;
  }
  const activationAt = snapshot.round.activationNotBefore
    ?? snapshot.round.activationDeadlineAt;
  if (!activationAt) {
    return;
  }
  await enqueuePollActivateJob(context, {
    scopeId: snapshot.poll.scopeId,
    pollId: snapshot.poll.id,
    roundId,
    ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
    groupWid: snapshot.poll.chatId,
    attempt: snapshot.round.finalizationAttempt + 1,
    runAt: new Date(activationAt)
  });
}
