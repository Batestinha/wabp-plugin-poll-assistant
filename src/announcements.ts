import { type TranslateFn } from '@wabs/plugin-sdk/i18n';
import type { PluginRuntimeContext } from './runtime';
import { parsePollAssistantConfig, type PollAssistantConfig } from './config';
import { renderPollTemplateFragment } from './templates';
import { joinTemplateFragments, type TemplateFragment, type PluginTemplateMentionContext } from '@wabs/plugin-sdk/templates';
import { resolvePollMessage } from './templateDelivery';
import type { PollDefinition } from './domain';
import { getPollOutcomeConfiguration } from './outcomeStore';
import { enqueuePollDeliveryJob } from './jobs';
import {
  ensurePollLifecycleDeliveryBatch,
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
  if (!snapshot?.round.announcementsRequired) {
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
  const distributing = listPollPrivateIssuancesByRound(db, roundId).some(issuance => ['pending', 'publishing'].includes(issuance.status));
  const pages = await resolvePollMessage(context, snapshot.poll, renderPublicationAnnouncement(snapshot, config, locale, t, distributing, outcome ? t('official.poll-assistant.outcome.published', {
    summary: outcome.summary, policy: t(`official.poll-assistant.outcome.policy.${outcome.policy}`)
  }) : undefined));
  const deliveries = ensurePollLifecycleDeliveryBatch(db, pages.map((page, index) => ({
    pollId: snapshot.poll.id, roundId,
    delivery: {
      id: index ? `${deliveryId}:page:${index + 1}` : deliveryId, kind: 'announcement',
      deliveryKey: index ? `${deliveryId}:page:${index + 1}:v1` : `${deliveryId}:v1`, chatId: snapshot.poll.chatId,
      ...page, idempotencyKey: index ? `poll-assistant:${deliveryId}:page:${index + 1}:v1` : `poll-assistant:${deliveryId}:v1`,
      deliveryBatchKey, deliverySequence: index
    }, createdAt: now.toISOString(), activationAnnouncementEnabled: config.messages.activationEnabled, reuseExistingAnnouncement: true
  })));
  const delivery = deliveries[0]!;
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
  const pages = await resolvePollMessage(context, snapshot.poll, renderPollTemplateFragment({ kind: 'activation', overrides: config.messages, t, values: {
    question: snapshot.poll.definition.question, pollId: snapshot.poll.id, timezone: config.timezone,
    closing: formatTimestamp(snapshot.round.closesAt, config.timezone, locale),
    closesAt: formatTimestamp(snapshot.round.closesAt, config.timezone, locale), cutoffAt: formatTimestamp(snapshot.round.closesAt, config.timezone, locale)
  } }));
  const db = pollsDatabase(context.databases);
  let delivery;
  try {
    delivery = ensurePollLifecycleDeliveryBatch(db, pages.map((page, index) => ({
      pollId: snapshot.poll.id, roundId, createdAt: now.toISOString(), reuseExistingAnnouncement: true,
      delivery: { ...page, id: index ? `${deliveryId}:page:${index + 1}` : deliveryId, kind: 'activation' as const, chatId: snapshot.poll.chatId,
        deliveryKey: index ? `${deliveryId}:page:${index + 1}:v1` : `${deliveryId}:v1`,
        idempotencyKey: index ? `poll-assistant:${deliveryId}:page:${index + 1}:v1` : `poll-assistant:${deliveryId}:v1`,
        deliveryBatchKey, deliverySequence: index }
    })))[0]!;
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
): TemplateFragment {
  return renderPollTemplateFragment({
    kind: 'publication',
    overrides: config.messages,
    t,
    ...pollPublicationTemplateValues(snapshot, config, locale, t, distributing, postVoteAction)
  });
}

/** Shared display and canonical values for publication-derived templates. */
export function pollPublicationTemplateValues(
  snapshot: StoredPollRoundSnapshot,
  config: PollAssistantConfig,
  locale: string,
  t: TranslateFn,
  distributing: boolean,
  postVoteAction: string | undefined
) {
  const timezone = config.timezone;
  const definition = snapshot.poll.definition;
  const tiePolicy = definition.purpose === 'decide'
    ? t(`official.poll-assistant.flow.tiePolicy.${tiePolicyKey(definition.tiePolicy.kind)}`)
    : t('official.poll-assistant.flow.summary.tie.none');
  return { conditionValues: {
    ballotDelivery: definition.ballotDelivery, voterDisclosure: definition.voterDisclosure, purpose: definition.purpose,
    rule: definition.rule.kind, tiePolicy: definition.purpose === 'decide' ? definition.tiePolicy.kind : undefined,
    activationTimeout: definition.closing.kind === 'deadline' && definition.closing.deadline.mode === 'after_first_non_creator_response' ? definition.closing.deadline.activationTimeoutMinutes : undefined
  }, values: {
    deliveryNotice: t(`official.poll-assistant.announcement.delivery.${definition.electorate.kind === 'actor' ? 'actor' : definition.ballotDelivery === 'group' ? 'group' : distributing ? 'privateUnderway' : 'private'}`),
    timezone, postVoteAction, cutoffAt: snapshot.round.closesAt ? formatTimestamp(snapshot.round.closesAt, timezone, locale) : undefined,
    activationTimeout: definition.closing.kind === 'deadline' && definition.closing.deadline.mode === 'after_first_non_creator_response' ? String(definition.closing.deadline.activationTimeoutMinutes) : undefined,
    question: definition.question,
    options: joinTemplateFragments([...definition.options]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((option) => renderPollTemplateFragment({ kind: 'publicationOption', overrides: config.messages, t, values: {
        ordinal: option.ordinal, label: option.label, option: option.label
      } })), '\n'),
    purpose: t(`official.poll-assistant.purpose.${definition.purpose}`),
    rule: ruleLabel(definition, t),
    closing: closingLabel(snapshot, timezone, locale, t),
    quorum: quorumLabel(definition, t),
    tiePolicy,
    ballotDelivery: t(`official.poll-assistant.flow.ballotDelivery.${definition.ballotDelivery}`),
    voterDisclosure: t(`official.poll-assistant.flow.voterDisclosure.${definition.voterDisclosure}`),
    pollId: definition.id
  } };
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
  return t('official.poll-assistant.outcome.createRules', pollConfigurationValues(definition, t, timezone));
}

export function pollConfigurationValues(definition: PollDefinition, t: TranslateFn, timezone: string) {
  const closing = definition.closing;
  const deadline = closing.kind === 'manual' ? t('official.poll-assistant.flow.summary.manual')
    : closing.deadline.mode === 'at' ? `${closing.deadline.closesAt} (${timezone})`
      : closing.deadline.mode === 'after_first_non_creator_response' ? t('official.poll-assistant.flow.summary.afterFirstResponse', {
        minutes: closing.deadline.durationMinutes, timeoutMinutes: closing.deadline.activationTimeoutMinutes
      }) : t('official.poll-assistant.flow.summary.duration', { minutes: closing.deadline.durationMinutes });
  return { purpose: t(`official.poll-assistant.purpose.${definition.purpose}`),
    rule: ruleLabel(definition, t), closing: deadline, quorum: quorumLabel(definition, t),
    tie: definition.purpose === 'decide' ? t(`official.poll-assistant.flow.tiePolicy.${tiePolicyKey(definition.tiePolicy.kind)}`) : '-',
    electorate: t(`official.poll-assistant.outcome.electorate.${definition.electorate.kind}`),
    delivery: t(`official.poll-assistant.flow.ballotDelivery.${definition.ballotDelivery}`),
    disclosure: t(`official.poll-assistant.flow.voterDisclosure.${definition.voterDisclosure}`) };
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
  const label = t(`official.poll-assistant.flow.rule.${key}`);
  if (definition.rule.kind === 'single_non_transferable' || definition.rule.kind === 'multiwinner_approval') {
    return t('official.poll-assistant.flow.summary.seats', { rule: label, seats: definition.rule.seats });
  }
  if (definition.rule.kind === 'approve_reject') {
    const basisPoints = definition.rule.minimumApprovalBasisPoints;
    const threshold = (basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : basisPoints % 10 === 0 ? 1 : 2);
    return t('official.poll-assistant.flow.summary.threshold', { rule: label, threshold });
  }
  return label;
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

type PollAnnouncementContext = PluginTemplateMentionContext & Pick<
  PluginRuntimeContext,
  'databases' | 'i18n' | 'configFor' | 'pluginId' | 'enqueuePluginJob' | 'getCurrentBotWid' | 'resolveIdentityAddress'
>;
