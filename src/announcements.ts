import type { TranslateFn } from '../../../platform/i18n';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { parsePollAssistantConfig } from './config';
import type { PollDefinition } from './domain';
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
  const delivery = ensurePollLifecycleDelivery(pollsDatabase(context.databases), {
    pollId: snapshot.poll.id,
    roundId,
    delivery: {
      id: deliveryId,
      kind: 'announcement',
      deliveryKey: `${deliveryId}:v1`,
      chatId: snapshot.poll.chatId,
      text: renderPublicationAnnouncement(snapshot, config.timezone, locale, t) + (() => {
        const outcome = getPollOutcomeConfiguration(pollsDatabase(context.databases), snapshot.poll.id);
        return outcome ? '\n\n' + t('official.poll-assistant.outcome.published', { summary: outcome.summary,
          policy: t(`official.poll-assistant.outcome.policy.${outcome.policy}`) }) : '';
      })(),
      idempotencyKey: `poll-assistant:${deliveryId}:v1`,
      deliveryBatchKey,
      deliverySequence: 0
    },
    createdAt: now.toISOString()
  });
  if (delivery.status === 'sent') {
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
        closesAt: formatTimestamp(snapshot.round.closesAt, config.timezone, locale),
        pollId: snapshot.poll.id
      }),
      idempotencyKey: `poll-assistant:${deliveryId}:v1`,
      deliveryBatchKey,
      deliverySequence: 1
    },
    createdAt: now.toISOString()
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

function renderPublicationAnnouncement(
  snapshot: StoredPollRoundSnapshot,
  timezone: string,
  locale: string,
  t: TranslateFn
): string {
  const definition = snapshot.poll.definition;
  const tiePolicy = definition.purpose === 'decide'
    ? t(`official.poll-assistant.flow.tiePolicy.${tiePolicyKey(definition.tiePolicy.kind)}`)
    : t('official.poll-assistant.flow.summary.tie.none');
  return t('official.poll-assistant.announcement.published', {
    question: definition.question,
    options: [...definition.options]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((option) => t('official.poll-assistant.flow.summary.option', {
        ordinal: option.ordinal,
        label: option.label
      })).join('\n'),
    purpose: t(`official.poll-assistant.purpose.${definition.purpose}`),
    rule: ruleLabel(definition, t),
    closing: closingLabel(snapshot, timezone, locale, t),
    quorum: quorumLabel(definition, t),
    tiePolicy,
    ballotDelivery: t(`official.poll-assistant.flow.ballotDelivery.${definition.ballotDelivery}`),
    voterDisclosure: t(`official.poll-assistant.flow.voterDisclosure.${definition.voterDisclosure}`),
    pollId: definition.id
  });
}

function closingLabel(
  snapshot: StoredPollRoundSnapshot,
  timezone: string,
  locale: string,
  t: TranslateFn
): string {
  const closing = snapshot.poll.definition.closing;
  if (closing.kind === 'manual') {
    return t('official.poll-assistant.flow.summary.manual');
  }
  if (closing.deadline.mode === 'after_first_non_creator_response') {
    return t('official.poll-assistant.flow.summary.afterFirstResponse', {
      minutes: closing.deadline.durationMinutes,
      timeoutMinutes: closing.deadline.activationTimeoutMinutes
    });
  }
  const closesAt = snapshot.round.closesAt
    ?? (closing.deadline.mode === 'at' ? closing.deadline.closesAt : undefined);
  return closesAt
    ? formatTimestamp(closesAt, timezone, locale)
    : t('official.poll-assistant.flow.summary.duration', {
        minutes: closing.deadline.mode === 'after_publish'
          ? closing.deadline.durationMinutes
          : 0
      });
}

function quorumLabel(definition: PollDefinition, t: TranslateFn): string {
  return definition.quorum.kind === 'none'
    ? t('official.poll-assistant.flow.summary.quorum.none')
    : definition.quorum.kind === 'absolute'
      ? t('official.poll-assistant.flow.summary.quorum.absolute', {
          count: definition.quorum.minimumResponses
        })
      : t('official.poll-assistant.flow.summary.quorum.percentage', {
          percentage: (definition.quorum.minimumTurnoutBasisPoints / 100).toFixed(2)
        });
}

export function renderPollConfiguration(definition: PollDefinition, t: TranslateFn, timezone: string): string {
  const closing = definition.closing;
  const deadline = closing.kind === 'manual' ? t('official.poll-assistant.flow.summary.manual')
    : closing.deadline.mode === 'at' ? `${closing.deadline.closesAt} (${timezone})`
      : closing.deadline.mode === 'after_first_non_creator_response' ? t('official.poll-assistant.flow.summary.afterFirstResponse', {
        minutes: closing.deadline.durationMinutes, timeoutMinutes: closing.deadline.activationTimeoutMinutes
      }) : t('official.poll-assistant.flow.summary.duration', { minutes: closing.deadline.durationMinutes });
  return t('official.poll-assistant.outcome.createRules', { purpose: t(`official.poll-assistant.purpose.${definition.purpose}`),
    rule: ruleLabel(definition, t), closing: deadline, quorum: quorumLabel(definition, t),
    tie: definition.purpose === 'decide' ? t(`official.poll-assistant.flow.tiePolicy.${tiePolicyKey(definition.tiePolicy.kind)}`) : '-',
    electorate: t(`official.poll-assistant.outcome.electorate.${definition.electorate.kind}`),
    delivery: t(`official.poll-assistant.flow.ballotDelivery.${definition.ballotDelivery}`),
    disclosure: t(`official.poll-assistant.flow.voterDisclosure.${definition.voterDisclosure}`) });
}

function ruleLabel(definition: PollDefinition, t: TranslateFn): string {
  if (definition.purpose === 'measure') {
    return definition.rule.kind === 'ordered_scale'
      ? t('official.poll-assistant.flow.rule.orderedScale')
      : t(definition.rule.allowMultipleAnswers
          ? 'official.poll-assistant.flow.rule.distributionMultiple'
          : 'official.poll-assistant.flow.rule.distributionSingle');
  }
  if (definition.purpose === 'count') {
    return t('official.poll-assistant.announcement.rule.sum', { unit: definition.rule.unit });
  }
  const key = definition.rule.kind === 'single_non_transferable'
    ? 'singleNonTransferable'
    : definition.rule.kind === 'multiwinner_approval'
      ? 'multiwinnerApproval'
      : definition.rule.kind === 'approve_reject'
        ? 'approveReject'
        : definition.rule.kind;
  return t(`official.poll-assistant.flow.rule.${key}`);
}

function tiePolicyKey(kind: 'no_decision' | 'authorized_choice' | 'status_quo' | 'random_draw'): string {
  return kind === 'no_decision'
    ? 'noDecision'
    : kind === 'authorized_choice'
      ? 'authorizedChoice'
      : kind === 'status_quo'
        ? 'statusQuo'
        : 'randomDraw';
}

function formatTimestamp(value: string, timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone
  }).format(new Date(value));
}

type PollAnnouncementContext = Pick<
  PluginRuntimeContext,
  'databases' | 'i18n' | 'configFor' | 'queue'
>;
