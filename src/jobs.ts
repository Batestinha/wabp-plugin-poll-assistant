import { enqueuePluginJob } from '../../../platform/jobs/queue';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { z } from 'zod';
import { POLL_ASSISTANT_PLUGIN_ID } from './database';

export const POLL_PUBLISH_JOB = 'poll.publish';
export const POLL_FINALIZE_JOB = 'poll.finalize';
export const POLL_DELIVER_JOB = 'poll.deliver';
export const POLL_CLEANUP_JOB = 'poll.cleanup';

export const pollRoundJobPayloadSchema = z.object({
  pollId: z.string().trim().min(1),
  roundId: z.string().trim().min(1)
}).strict();

export const pollDeliveryJobPayloadSchema = z.object({
  deliveryId: z.string().trim().min(1)
}).strict();

export const pollCleanupJobPayloadSchema = z.object({
  pollId: z.string().trim().min(1)
}).strict();

export async function enqueuePollPublishJob(
  context: Pick<PluginRuntimeContext, 'queue'>,
  input: {
    scopeId: string;
    pollId: string;
    roundId: string;
    groupId?: string | undefined;
    groupWid: string;
    attempt: number;
    runAt?: Date | undefined;
  }
): Promise<void> {
  await enqueuePluginJob(context.queue, {
    pluginId: POLL_ASSISTANT_PLUGIN_ID,
    jobName: POLL_PUBLISH_JOB,
    scopeId: input.scopeId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    groupWid: input.groupWid,
    payload: { pollId: input.pollId, roundId: input.roundId },
    ...(input.runAt ? { runAt: input.runAt } : {}),
    dedupeKey: `${POLL_PUBLISH_JOB}:${input.roundId}:${input.attempt}`
  });
}

export async function enqueuePollFinalizeJob(
  context: Pick<PluginRuntimeContext, 'queue'>,
  input: {
    scopeId: string;
    pollId: string;
    roundId: string;
    groupId?: string | undefined;
    groupWid: string;
    attempt: number;
    runAt?: Date | undefined;
  }
): Promise<void> {
  await enqueuePluginJob(context.queue, {
    pluginId: POLL_ASSISTANT_PLUGIN_ID,
    jobName: POLL_FINALIZE_JOB,
    scopeId: input.scopeId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    groupWid: input.groupWid,
    payload: { pollId: input.pollId, roundId: input.roundId },
    ...(input.runAt ? { runAt: input.runAt } : {}),
    dedupeKey: `${POLL_FINALIZE_JOB}:${input.roundId}:${input.attempt}`
  });
}

export async function enqueuePollDeliveryJob(
  context: Pick<PluginRuntimeContext, 'queue'>,
  input: {
    scopeId: string;
    deliveryId: string;
    groupId?: string | undefined;
    groupWid?: string | undefined;
    attempt: number;
    runAt?: Date | undefined;
  }
): Promise<void> {
  await enqueuePluginJob(context.queue, {
    pluginId: POLL_ASSISTANT_PLUGIN_ID,
    jobName: POLL_DELIVER_JOB,
    scopeId: input.scopeId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.groupWid ? { groupWid: input.groupWid } : {}),
    payload: { deliveryId: input.deliveryId },
    ...(input.runAt ? { runAt: input.runAt } : {}),
    dedupeKey: `${POLL_DELIVER_JOB}:${input.deliveryId}:${input.attempt}`
  });
}

export async function enqueuePollCleanupJob(
  context: Pick<PluginRuntimeContext, 'queue'>,
  input: {
    scopeId: string;
    pollId: string;
    groupId?: string | undefined;
    groupWid: string;
    scheduleKey: string;
    runAt: Date;
  }
): Promise<void> {
  await enqueuePluginJob(context.queue, {
    pluginId: POLL_ASSISTANT_PLUGIN_ID,
    jobName: POLL_CLEANUP_JOB,
    scopeId: input.scopeId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    groupWid: input.groupWid,
    payload: { pollId: input.pollId },
    runAt: input.runAt,
    dedupeKey: `${POLL_CLEANUP_JOB}:${input.pollId}:${input.scheduleKey}`
  });
}

export function pollRetryAt(now: Date, attempt: number): Date {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const delayMs = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(normalizedAttempt - 1, 8));
  return new Date(now.getTime() + delayMs);
}
