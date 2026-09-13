// Compatibility release: retain the deployed announcement producer format while upgrading readers.
import type { TranslateFn } from '@wabs/plugin-sdk/i18n';
import type { PollDefinition } from './domain';
import type { StoredPollRoundSnapshot } from './store';

export function renderLegacyPublicationAnnouncement(
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
    ? formatLegacyPollTimestamp(closesAt, timezone, locale)
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

export function formatLegacyPollTimestamp(value: string, timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone
  }).format(new Date(value));
}

