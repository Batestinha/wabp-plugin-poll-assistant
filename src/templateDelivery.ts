import { resolvePluginTemplateMentions, paginateResolvedTemplate, type TemplateFragment, type PluginTemplateMentionContext, type TemplatePersonTarget } from '@wabs/plugin-sdk/templates';
import type { PluginRuntimeContext } from './runtime';
import { getPollAggregate, pollsDatabase, type StoredPoll } from './store';

type MentionRuntime = PluginTemplateMentionContext & Pick<PluginRuntimeContext, 'databases' | 'getCurrentBotWid'>;
export async function resolvePollMessage(context: MentionRuntime, poll: Pick<StoredPoll, 'id' | 'scopeId' | 'chatId' | 'creatorIdentityId'>,
  fragment: TemplateFragment, extraTargets: Record<string, TemplatePersonTarget[]> = {}) {
  const targets: Record<string, TemplatePersonTarget[]> = { creator: [{ identityId: poll.creatorIdentityId }], ...extraTargets };
  if (fragment.segments.some(segment => segment.kind === 'mention' && segment.reference.kind === 'target' && segment.reference.id === 'eligibleVoters')) {
    const electorate = getPollAggregate(pollsDatabase(context.databases), poll.id)?.electorate;
    if (!electorate) throw new Error('Poll mentions require the captured electorate.');
    const botWid = await context.getCurrentBotWid?.();
    const bot = botWid ? await context.resolveIdentityAddress?.(botWid) : undefined;
    const excluded = new Set([botWid, bot?.canonicalWid, ...(bot?.aliases ?? [])]);
    targets.eligibleVoters = electorate.filter(elector => elector.voterIdentityId !== bot?.identityId && !excluded.has(elector.voterWid))
      .map(elector => ({ identityId: elector.voterIdentityId, wid: elector.voterWid }));
  }
  return paginateResolvedTemplate(await resolvePluginTemplateMentions(fragment, { context, chatId: poll.chatId, scopeId: poll.scopeId, targets }));
}
