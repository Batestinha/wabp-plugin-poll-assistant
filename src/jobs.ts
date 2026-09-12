import type { PluginJobContext } from '../../../../packages/plugin-sdk/src/jobs';
import { enqueuePluginJob } from '../../../../packages/plugin-sdk/src/jobs';
import type { PluginRuntimeContext } from './runtime';
import { z } from 'zod';
import { POLL_ASSISTANT_PLUGIN_ID } from './database';

export const POLL_PUBLISH_JOB = 'poll.publish';
export const POLL_FINALIZE_JOB = 'poll.finalize';
export const POLL_ACTIVATE_JOB = 'poll.activate';
export const POLL_DELIVER_JOB = 'poll.deliver';
export const POLL_CLEANUP_JOB = 'poll.cleanup';
export const POLL_PRIVATE_ISSUE_JOB = 'poll.private-issue';
export const POLL_PRIVATE_ISSUANCE_PACING_MS = 2_000;
export const POLL_PRIVATE_MINIMUM_VOTING_WINDOW_MS = 60_000;

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

export const pollPrivateIssueJobPayloadSchema = z.object({
  issuanceId: z.string().trim().min(1)
}).strict();

export async function enqueuePollPublishJob(
  context: PluginJobContext,
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
  await enqueuePluginJob(context, {
    pluginId: POLL_ASSISTANT_PLUGIN_ID,
    jobName: POLL_PUBLISH_JOB,
    scopeId: input.scopeId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    groupWid: input.groupWid,
    payload: { pollId: input.pollId, roundId: input.roundId },
    ...(input.runAt ? { runAt: input.runAt } : {}),
    dedupeKey: scheduledJobGenerationKey(
      POLL_PUBLISH_JOB,
      input.roundId,
      input.attempt,
      input.runAt
    )
  });
}

export async function enqueuePollFinalizeJob(
  context: PluginJobContext,
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
  await enqueuePluginJob(context, {
    pluginId: POLL_ASSISTANT_PLUGIN_ID,
    jobName: POLL_FINALIZE_JOB,
    scopeId: input.scopeId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    groupWid: input.groupWid,
    payload: { pollId: input.pollId, roundId: input.roundId },
    ...(input.runAt ? { runAt: input.runAt } : {}),
    dedupeKey: scheduledJobGenerationKey(
      POLL_FINALIZE_JOB,
      input.roundId,
      input.attempt,
      input.runAt
    )
  });
}

export async function enqueuePollActivateJob(
  context: PluginJobContext,
  input: {
    scopeId: string;
    pollId: string;
    roundId: string;
    groupId?: string | undefined;
    groupWid: string;
    attempt: number;
    runAt: Date;
  }
): Promise<void> {
  await enqueuePluginJob(context, {
    pluginId: POLL_ASSISTANT_PLUGIN_ID,
    jobName: POLL_ACTIVATE_JOB,
    scopeId: input.scopeId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    groupWid: input.groupWid,
    payload: { pollId: input.pollId, roundId: input.roundId },
    runAt: input.runAt,
    dedupeKey: scheduledJobGenerationKey(
      POLL_ACTIVATE_JOB,
      input.roundId,
      input.attempt,
      input.runAt
    )
  });
}

export async function enqueuePollDeliveryJob(
  context: PluginJobContext,
  input: {
    scopeId: string;
    deliveryId: string;
    groupId?: string | undefined;
    groupWid?: string | undefined;
    attempt: number;
    runAt?: Date | undefined;
  }
): Promise<void> {
  await enqueuePluginJob(context, {
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
  context: PluginJobContext,
  input: {
    scopeId: string;
    pollId: string;
    groupId?: string | undefined;
    groupWid: string;
    runAt: Date;
  }
): Promise<void> {
  await enqueuePluginJob(context, {
    pluginId: POLL_ASSISTANT_PLUGIN_ID,
    jobName: POLL_CLEANUP_JOB,
    scopeId: input.scopeId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    groupWid: input.groupWid,
    payload: { pollId: input.pollId },
    runAt: input.runAt,
    dedupeKey: `${POLL_CLEANUP_JOB}:${input.pollId}:${input.runAt.toISOString()}`
  });
}

export async function enqueuePollPrivateIssueJob(
  context: PluginJobContext,
  input: {
    scopeId: string;
    issuanceId: string;
    groupId?: string | undefined;
    groupWid: string;
    attempt: number;
    runAt?: Date | undefined;
    replaceRetainedTerminalJob?: boolean | undefined;
  }
): Promise<void> {
  await enqueuePluginJob(context, {
    pluginId: POLL_ASSISTANT_PLUGIN_ID,
    jobName: POLL_PRIVATE_ISSUE_JOB,
    scopeId: input.scopeId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    groupWid: input.groupWid,
    payload: { issuanceId: input.issuanceId },
    ...(input.runAt ? { runAt: input.runAt } : {}),
    // Recovery may rediscover a not-yet-due issuance. Keep one durable job for
    // each claim attempt regardless of which sweep calculated its runAt.
    dedupeKey: `${POLL_PRIVATE_ISSUE_JOB}:${input.issuanceId}:${input.attempt}`,
    ...(input.replaceRetainedTerminalJob ? { replaceRetainedTerminalJob: true } : {})
  });
}

export function pollRetryAt(now: Date, attempt: number): Date {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const delayMs = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(normalizedAttempt - 1, 8));
  return new Date(now.getTime() + delayMs);
}

function scheduledJobGenerationKey(
  jobName: string,
  subjectId: string,
  attempt: number,
  runAt?: Date | undefined
): string {
  const generation = `${jobName}:${subjectId}:${attempt}`;
  return runAt ? `${generation}:${runAt.toISOString()}` : generation;
}
