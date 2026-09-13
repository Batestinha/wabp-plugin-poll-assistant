import type { PluginRuntimeContext } from './runtime';
export { renderPollConfiguration } from './compatibilityAnnouncements';
import { parsePollAssistantConfig } from './config';
import { renderLegacyPublicationAnnouncement, formatLegacyPollTimestamp } from './compatibilityAnnouncements';
import { getPollOutcomeConfiguration } from './outcomeStore';
import { enqueuePollDeliveryJob } from './jobs';
import {
  ensurePollLifecycleDelivery,
  PollActivationAnnouncementSuppressedError,
  getPollDelivery,
  getPollLifecycleByRoundId,
  pollsDatabase,
  type StoredPollRoundSnapshot
} from './store';

export async function ensurePollPublicationAnnouncement(
  context: PollAnnouncementContext,
  roundId: string,
  now = new Date()
): Promise<boolean> {
  const snapshot = getPollLifecycleByRoundId(pollsDatabase(context.databases), roundId);
  if (!snapshot?.round.publishedAt || !snapshot.round.announcementsRequired) {
    return false;
  }
  const existingDelivery = getPollDelivery(pollsDatabase(context.databases), `poll-announcement:${roundId}:published`);
  if (existingDelivery) return enqueueStoredAnnouncement(context, snapshot, existingDelivery);
  const t = await context.i18n.translatorForScope(snapshot.poll.scopeId);
  const locale = (await context.i18n.resolveScopeLocale(snapshot.poll.scopeId)).locale;
  const config = parsePollAssistantConfig(await context.configFor(snapshot.poll.scopeId));
  const deliveryId = `poll-announcement:${roundId}:published`;
  const deliveryBatchKey = `poll-announcements:${roundId}`;
  const db = pollsDatabase(context.databases);
  const outcome = getPollOutcomeConfiguration(db, snapshot.poll.id);
  const delivery = ensurePollLifecycleDelivery(db, {
    pollId: snapshot.poll.id, roundId,
    delivery: {
      id: deliveryId, kind: 'announcement', deliveryKey: `${deliveryId}:v1`, chatId: snapshot.poll.chatId,
      text: renderLegacyPublicationAnnouncement(snapshot, config.timezone, locale, t) + (outcome ? '\n\n' + t('official.poll-assistant.outcome.published', {
        summary: outcome.summary, policy: t(`official.poll-assistant.outcome.policy.${outcome.policy}`)
      }) : ''),
      idempotencyKey: `poll-assistant:${deliveryId}:v1`, deliveryBatchKey, deliverySequence: 0
    },
    createdAt: now.toISOString(), activationAnnouncementEnabled: true, reuseExistingAnnouncement: true
  });
  const queued = await enqueueStoredAnnouncement(context, snapshot, delivery);
  if (snapshot.round.activatedAt) await ensurePollActivationAnnouncement(context, roundId, now);
  return queued;
}

export async function ensurePollActivationAnnouncement(
  context: PollAnnouncementContext,
  roundId: string,
  now = new Date()
): Promise<boolean> {
  const snapshot = getPollLifecycleByRoundId(pollsDatabase(context.databases), roundId);
  const closing = snapshot?.poll.definition.closing;
  if (
    !snapshot?.round.activatedAt
    || !snapshot.round.announcementsRequired
    || !snapshot.round.closesAt
    || closing?.kind !== 'deadline'
    || closing.deadline.mode !== 'after_first_non_creator_response'
    || snapshot.round.activationTriggerKind === 'no_response_timeout'
  ) {
    return false;
  }
  const existingDelivery = getPollDelivery(pollsDatabase(context.databases), `poll-announcement:${roundId}:activated`);
  if (existingDelivery) return enqueueStoredAnnouncement(context, snapshot, existingDelivery);
  if (snapshot.round.activationAnnouncementSuppressedAt) return false;
  // A publication without a suppression marker froze the enabled policy, including legacy publications.
  if (!getPollDelivery(pollsDatabase(context.databases), `poll-announcement:${roundId}:published`)) return false;
  const t = await context.i18n.translatorForScope(snapshot.poll.scopeId);
  const locale = (await context.i18n.resolveScopeLocale(snapshot.poll.scopeId)).locale;
  const config = parsePollAssistantConfig(await context.configFor(snapshot.poll.scopeId));
  const deliveryId = `poll-announcement:${roundId}:activated`;
  const deliveryBatchKey = `poll-announcements:${roundId}`;
  let delivery;
  try {
    delivery = ensurePollLifecycleDelivery(pollsDatabase(context.databases), {
      pollId: snapshot.poll.id,
      roundId,
      delivery: {
        id: deliveryId,
        kind: 'activation',
        deliveryKey: `${deliveryId}:v1`,
        chatId: snapshot.poll.chatId,
        text: t('official.poll-assistant.announcement.activated', {
          question: snapshot.poll.definition.question,
          closesAt: formatLegacyPollTimestamp(snapshot.round.closesAt, config.timezone, locale),
          pollId: snapshot.poll.id
        }),
        idempotencyKey: `poll-assistant:${deliveryId}:v1`,
        deliveryBatchKey,
        deliverySequence: 1
      },
      createdAt: now.toISOString(), reuseExistingAnnouncement: true
    });
  } catch (error) {
    if (error instanceof PollActivationAnnouncementSuppressedError) return false;
    throw error;
  }
  if (delivery.status === 'sent') {
    return false;
  }
  const publication = getPollDelivery(
    pollsDatabase(context.databases),
    `poll-announcement:${roundId}:published`
  );
  if (publication?.status !== 'sent') {
    return false;
  }
  await enqueuePollDeliveryJob(context, {
    scopeId: snapshot.poll.scopeId,
    deliveryId,
    ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
    groupWid: snapshot.poll.chatId,
    attempt: delivery.attempt + 1
  });
  return true;
}

async function enqueueStoredAnnouncement(
  context: PollAnnouncementContext,
  snapshot: StoredPollRoundSnapshot,
  delivery: NonNullable<ReturnType<typeof getPollDelivery>>
): Promise<boolean> {
  if (delivery.status === 'sent') return false;
  if (delivery.kind === 'activation' && getPollDelivery(pollsDatabase(context.databases), `poll-announcement:${snapshot.round.id}:published`)?.status !== 'sent') return false;
  await enqueuePollDeliveryJob(context, {
    scopeId: snapshot.poll.scopeId,
    deliveryId: delivery.id,
    ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
    groupWid: snapshot.poll.chatId,
    attempt: delivery.attempt + 1
  });
  return true;
}

type PollAnnouncementContext = Pick<
  PluginRuntimeContext,
  'databases' | 'i18n' | 'configFor' | 'pluginId' | 'enqueuePluginJob' | 'getCurrentBotWid' | 'resolveIdentityAddress'
>;
