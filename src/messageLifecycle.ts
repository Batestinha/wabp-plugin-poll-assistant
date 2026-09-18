import type { PluginRuntimeContext } from './runtime';
import { parsePollAssistantConfig } from './config';
import { getPollDelivery, getPollLifecycleByRoundId, pollsDatabase } from './store';
import { renderPollTemplateFragment } from './templates';
import { resolvePollMessage } from './templateDelivery';
import { pollPublicationTemplateValues } from './announcements';
import { getPollOutcomeConfiguration } from './outcomeStore';

const EDIT_WINDOW_MS = 15 * 60_000;
const PIN_SECONDS = 30 * 24 * 60 * 60;
type State = { round_id: string; pin_message_id: string | null; pinned_until: string | null; closed_edit_done: number };

/** Recovery owns these independent, idempotent effects so a failed pin/edit can
 * never undo a poll result or cause its announcement to be sent twice. */
export async function reconcilePollMessages(context: PluginRuntimeContext, now = new Date()): Promise<void> {
  const db = pollsDatabase(context.databases);
  const candidates = db.all<{ id: string }>(`SELECT r.id FROM poll_rounds r
    JOIN polls p ON p.id = r.poll_id LEFT JOIN poll_message_lifecycle m ON m.round_id = r.id
    WHERE r.published_at IS NOT NULL
      AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ?)
      AND (r.status = 'open' OR m.pin_message_id IS NOT NULL OR m.closed_edit_done = 0
        OR (m.round_id IS NULL AND r.updated_at >= ?))
    ORDER BY COALESCE(m.next_attempt_at, r.published_at), r.id LIMIT 100`,
    now.toISOString(), new Date(now.getTime() - EDIT_WINDOW_MS).toISOString());
  for (const { id } of candidates) {
    db.run('INSERT OR IGNORE INTO poll_message_lifecycle (round_id, next_attempt_at) VALUES (?, ?)', id, now.toISOString());
    // Persist pacing before any transport call, including a possible process crash.
    db.run('UPDATE poll_message_lifecycle SET next_attempt_at = ? WHERE round_id = ?', new Date(now.getTime() + 60_000).toISOString(), id);
    const state = db.get<State>('SELECT * FROM poll_message_lifecycle WHERE round_id = ?', id)!;
    const snapshot = getPollLifecycleByRoundId(db, id);
    if (!snapshot) continue;
    const config = parsePollAssistantConfig(await context.configFor(snapshot.poll.scopeId));
    const open = snapshot.poll.status === 'active' && snapshot.round.status === 'open'
      && (!snapshot.round.closesAt || new Date(snapshot.round.closesAt).getTime() > now.getTime());
    const publication = getPollDelivery(db, `poll-announcement:${id}:published`);
    const pinTarget = snapshot.poll.chatId.endsWith('@g.us')
      ? snapshot.round.pollWaMessageId ?? publication?.messageId : undefined;
    try {
      if (open && config.pinActivePolls && pinTarget) {
        if (!state.pinned_until || new Date(state.pinned_until).getTime() - now.getTime() < 24 * 60 * 60_000) {
          if (!context.pinMessage) throw new Error('Poll pinning requires an updated host.');
          // Retain the target even if acceptance is uncertain; closure must unpin it.
          db.run('UPDATE poll_message_lifecycle SET pin_message_id = ? WHERE round_id = ?', pinTarget, id);
          await context.pinMessage(pinTarget, PIN_SECONDS);
          db.run('UPDATE poll_message_lifecycle SET pinned_until = ?, last_error = NULL WHERE round_id = ?',
            new Date(now.getTime() + PIN_SECONDS * 1000).toISOString(), id);
        }
      } else if (state.pin_message_id) {
        if (!context.unpinMessage) throw new Error('Poll unpinning requires an updated host.');
        await context.unpinMessage(state.pin_message_id);
        db.run('UPDATE poll_message_lifecycle SET pin_message_id = NULL, pinned_until = NULL, last_error = NULL WHERE round_id = ?', id);
      }
    } catch (error) { await recordFailure('pin', error); }

    if (open || state.closed_edit_done || snapshot.round.status === 'open' || snapshot.round.status === 'finalizing') continue;
    try {
      if (config.editPublicationOnClose && publication?.messageId && publication.sentAt) {
        if (now.getTime() - new Date(publication.sentAt).getTime() >= EDIT_WINDOW_MS) {
          await recordFailure('edit', new Error('Publication is outside WhatsApp’s 15-minute edit window.'));
        } else {
          if (!context.editMessage) throw new Error('Poll publication editing requires an updated host.');
          const t = await context.i18n.translatorForScope(snapshot.poll.scopeId);
          const locale = (await context.i18n.resolveScopeLocale(snapshot.poll.scopeId)).locale;
          const closedAt = snapshot.round.closesAt ?? snapshot.round.finalizedAt ?? snapshot.poll.cancelledAt ?? now.toISOString();
          const outcome = getPollOutcomeConfiguration(db, snapshot.poll.id);
          const publicationValues = pollPublicationTemplateValues(snapshot, config, locale, t, false,
            outcome ? t('official.poll-assistant.outcome.published', {
              summary: outcome.summary,
              policy: t(`official.poll-assistant.outcome.policy.${outcome.policy}`)
            }) : undefined);
          const pages = await resolvePollMessage(context, snapshot.poll, renderPollTemplateFragment({
            kind: 'closedPublication', overrides: config.messages, t,
            conditionValues: publicationValues.conditionValues,
            values: {
              ...publicationValues.values,
              closedAt: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: config.timezone }).format(new Date(closedAt)),
              originalPublication: publication.text,
              result: getPollDelivery(db, `poll-result:${id}`)?.text
            }
          }));
          if (pages.length !== 1) throw new Error('Closed publication must fit in one message.');
          await context.editMessage(publication.messageId, pages[0]!.text, { ...pages[0]!, requiredProviderId: 'whatsmeow' });
          await context.audit.record({ scopeId: snapshot.poll.scopeId, action: 'poll.publication.edited', targetJson: { pollId: snapshot.poll.id, roundId: id } });
        }
      } else if (config.editPublicationOnClose && snapshot.round.announcementsRequired && (!publication || publication.status !== 'sent')) {
        // Publication may still be queued; retry when its stable send receipt exists.
        continue;
      }
      db.run('UPDATE poll_message_lifecycle SET closed_edit_done = 1 WHERE round_id = ?', id);
    } catch (error) { await recordFailure('edit', error); }

    async function recordFailure(operation: string, error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      db.run('UPDATE poll_message_lifecycle SET last_error = ? WHERE round_id = ?', reason.slice(0, 1000), id);
      context.logger.warn({ roundId: id, operation, reason }, 'Poll message lifecycle action deferred');
      await context.audit.record({ scopeId: snapshot!.poll.scopeId, action: `poll.publication.${operation}.unavailable`, targetJson: { pollId: snapshot!.poll.id, roundId: id }, metadataJson: { reason } }).catch(() => undefined);
    }
  }
}
