import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import {
  getPollLifecycleByRoundId,
  getPollPrivateIssuance,
  markPollPrivatePublicationAuditSent,
  pollsDatabase
} from './store';

export async function deliverPollPrivatePublicationAudit(
  context: PluginRuntimeContext,
  issuanceId: string,
  clock: () => Date = () => new Date()
): Promise<boolean> {
  const db = pollsDatabase(context.databases);
  const issuance = getPollPrivateIssuance(db, issuanceId);
  if (!issuance || issuance.status !== 'sent' || !issuance.pollWaMessageId) {
    return false;
  }
  if (issuance.publicationAuditSentAt) {
    return true;
  }
  const snapshot = getPollLifecycleByRoundId(db, issuance.roundId);
  if (!snapshot || snapshot.poll.id !== issuance.pollId) {
    return false;
  }
  const eventKey = `poll-assistant:private-publication:${issuance.id}`;
  await context.audit.record({
    actorIdentityId: snapshot.poll.creatorIdentityId,
    scopeId: snapshot.poll.scopeId,
    ...(snapshot.poll.groupId ? { groupId: snapshot.poll.groupId } : {}),
    action: 'poll-assistant.private_ballot.published',
    targetJson: {
      pollId: snapshot.poll.id,
      roundId: snapshot.round.id,
      issuanceId: issuance.id,
      messageId: issuance.pollWaMessageId
    },
    metadataJson: {
      eventKey,
      groupWid: snapshot.poll.chatId,
      recipientIdentityId: issuance.voterIdentityId,
      recipientWid: issuance.voterWid,
      acceptedAt: issuance.acceptedAt,
      ballotDelivery: 'private',
      voterDisclosure: snapshot.poll.definition.voterDisclosure
    }
  });
  return markPollPrivatePublicationAuditSent(db, {
    issuanceId: issuance.id,
    sentAt: clock().toISOString()
  }) || Boolean(getPollPrivateIssuance(db, issuance.id)?.publicationAuditSentAt);
}
