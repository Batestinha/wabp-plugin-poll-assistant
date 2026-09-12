import { type TranslateFn } from '../../../../packages/plugin-sdk/src/i18n';
import type { PluginRuntimeContext } from './runtime';
import { parsePollAssistantConfig, type PollAssistantConfig } from './config';
import { renderPollTemplate } from './templates';
import type { PollDefinition } from './domain';
import { getPollOutcomeConfiguration } from './outcomeStore';
import { enqueuePollDeliveryJob } from './jobs';
import {
  ensurePollLifecycleDelivery,
  PollActivationAnnouncementSuppressedError,
  getPollDelivery,
  getPollAggregate,
  listPollPrivateIssuancesByRound,
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
  const recipients = config.messages.mentionEligible ? await publicationRecipients(context, snapshot) : [];
  const distributing = listPollPrivateIssuancesByRound(db, roundId).some(issuance => ['pending', 'publishing'].includes(issuance.status));
  const delivery = ensurePollLifecycleDelivery(db, {
    pollId: snapshot.poll.id, roundId,
    delivery: {
      id: deliveryId, kind: 'announcement', deliveryKey: `${deliveryId}:v1`, chatId: snapshot.poll.chatId,
      text: renderPublicationAnnouncement(snapshot, config, locale, t, distributing, outcome ? t('official.poll-assistant.outcome.published', {
        summary: outcome.summary, policy: t(`official.poll-assistant.outcome.policy.${outcome.policy}`)
      }) : undefined),
      mentionedWids: recipients,
      idempotencyKey: `poll-assistant:${deliveryId}:v1`, deliveryBatchKey, deliverySequence: 0
    },
    createdAt: now.toISOString(), activationAnnouncementEnabled: config.messages.activationEnabled, reuseExistingAnnouncement: true
  });
  const queued = await enqueueStoredAnnouncement(context, snapshot, delivery);
  if (snapshot.round.activatedAt) await ensurePollActivationAnnouncement(context, roundId, now);
  return queued;
}

async function publicationRecipients(context: PollAnnouncementContext, snapshot: StoredPollRoundSnapshot): Promise<string[]> {
  const electorate = getPollAggregate(pollsDatabase(context.databases), snapshot.poll.id)?.electorate;
  if (!electorate) throw new Error('Poll publication requires a captured electorate');
  const botWid = await context.getCurrentBotWid?.();
  const bot = botWid ? await context.resolveIdentityAddress?.(botWid) : undefined;
  const excluded = new Set([botWid, bot?.canonicalWid, ...(bot?.aliases ?? [])].filter((value): value is string => Boolean(value)));
  return [...new Set(electorate.filter(elector => elector.voterIdentityId !== bot?.identityId && !excluded.has(elector.voterWid))
    .map(elector => elector.voterWid.trim()).filter(Boolean))].sort();
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
        text: renderPollTemplate({ kind: 'activation', overrides: config.messages, t, values: {
          question: snapshot.poll.definition.question, pollId: snapshot.poll.id, timezone: config.timezone,
          closing: formatTimestamp(snapshot.round.closesAt, config.timezone, locale),
          closesAt: formatTimestamp(snapshot.round.closesAt, config.timezone, locale),
          cutoffAt: formatTimestamp(snapshot.round.closesAt, config.timezone, locale)
        } }),
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

function renderPublicationAnnouncement(
  snapshot: StoredPollRoundSnapshot,
  config: PollAssistantConfig,
  locale: string,
  t: TranslateFn,
  distributing: boolean,
  postVoteAction: string | undefined
): string {
  const timezone = config.timezone;
  const definition = snapshot.poll.definition;
  const tiePolicy = definition.purpose === 'decide'
    ? t(`official.poll-assistant.flow.tiePolicy.${tiePolicyKey(definition.tiePolicy.kind)}`)
    : t('official.poll-assistant.flow.summary.tie.none');
  return renderPollTemplate({ kind: 'publication', overrides: config.messages, t, values: {
    deliveryNotice: t(`official.poll-assistant.announcement.delivery.${definition.electorate.kind === 'actor' ? 'actor' : definition.ballotDelivery === 'group' ? 'group' : distributing ? 'privateUnderway' : 'private'}`),
    timezone, postVoteAction, cutoffAt: snapshot.round.closesAt ? formatTimestamp(snapshot.round.closesAt, timezone, locale) : undefined,
    activationTimeout: definition.closing.kind === 'deadline' && definition.closing.deadline.mode === 'after_first_non_creator_response' ? String(definition.closing.deadline.activationTimeoutMinutes) : undefined,
    question: definition.question,
    options: [...definition.options]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((option) => renderPollTemplate({ kind: 'publicationOption', overrides: config.messages, t, values: {
        ordinal: option.ordinal, label: option.label, option: option.label
      } })).join('\n'),
    purpose: t(`official.poll-assistant.purpose.${definition.purpose}`),
    rule: ruleLabel(definition, t),
    closing: closingLabel(snapshot, timezone, locale, t),
    quorum: quorumLabel(definition, t),
    tiePolicy,
    ballotDelivery: t(`official.poll-assistant.flow.ballotDelivery.${definition.ballotDelivery}`),
    voterDisclosure: t(`official.poll-assistant.flow.voterDisclosure.${definition.voterDisclosure}`),
    pollId: definition.id
  } });
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
    return t('official.poll-assistant.announcement.closing.afterFirstResponse', {
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
    timeStyle: 'medium',
    timeZone: timezone
  }).format(new Date(value));
}

type PollAnnouncementContext = Pick<
  PluginRuntimeContext,
  'databases' | 'i18n' | 'configFor' | 'pluginId' | 'enqueuePluginJob' | 'getCurrentBotWid' | 'resolveIdentityAddress'
>;
