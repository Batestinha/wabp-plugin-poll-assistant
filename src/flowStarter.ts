import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  FlowEngine,
  FlowStartOrigin,
  FlowStartResult
} from '../../../adminBot/flows/flowEngine';
import type { I18nService, LanguagePackScope, TranslateFn } from '../../../platform/i18n';
import type { StableIdentityAddressResolution } from '../../../platform/identity/identityAddressService';
import type { PluginDataStore } from '../../../platform/pluginRuntime/manager/pluginDataStore';
import type { PrivateDeliveryFallback } from '../../../platform/transport/transportTypes';
import { POLL_ASSISTANT_PLUGIN_ID } from './database';
import {
  createPollCreationFlowDefinition,
  isPollCreationFlowType,
  POLL_CREATION_FLOW_TYPE_PREFIX,
  restorePollCreationFlowDefinition,
  type PollCreationFlowPreferences
} from './flow';

export interface PollCreationDraft {
  schemaVersion: 1;
  flowSessionId: string;
  flowType: string;
  pollId: string;
  roundId: string;
  scopeId: string;
  originGroupId?: string | undefined;
  originGroupWid: string;
  originChatId: string;
  actorIdentityId: string;
  actorWid: string;
  actorLabel: string;
  locale: string;
  languagePackScopes: LanguagePackScope[];
  preferences: PollCreationFlowPreferences;
  initialData: Record<string, unknown>;
  createdAt: string;
}

export const pollCreationDraftSchema = z.object({
  schemaVersion: z.literal(1),
  flowSessionId: z.string().trim().min(1),
  flowType: z.string().trim().refine(
    isPollCreationFlowType,
    'Expected a Poll Assistant creation flow type'
  ),
  pollId: z.string().trim().min(1).max(200),
  roundId: z.string().trim().min(1).max(200),
  scopeId: z.string().trim().min(1),
  originGroupId: z.string().trim().min(1).optional(),
  originGroupWid: z.string().trim().min(1),
  originChatId: z.string().trim().min(1),
  actorIdentityId: z.string().trim().min(1),
  actorWid: z.string().trim().min(1),
  actorLabel: z.string().trim().min(1),
  locale: z.string().trim().min(1).max(35),
  languagePackScopes: z.array(z.object({
    kind: z.enum(['GLOBAL', 'SCOPE', 'GROUP', 'IDENTITY']),
    subjectId: z.string().trim().min(1)
  }).strict()),
  preferences: z.object({
    timezone: z.string().trim().min(1).max(100),
    maxDeadlineMinutes: z.number().int().min(1).max(366 * 24 * 60),
    defaultClosing: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('manual') }).strict(),
      z.object({
        kind: z.literal('deadline'),
        durationMinutes: z.number().int().min(1).max(366 * 24 * 60)
      }).strict()
    ]),
    defaultQuorum: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }).strict(),
      z.object({ kind: z.literal('absolute'), minimumResponses: z.number().int().min(1) }).strict(),
      z.object({
        kind: z.literal('percentage'),
        minimumTurnoutBasisPoints: z.number().int().min(1).max(10_000)
      }).strict()
    ])
  }).strict(),
  initialData: z.record(z.unknown()),
  createdAt: z.string().datetime({ offset: true })
}).strict();

export interface PollCreationFlowStarterContext {
  flowEngine: FlowEngine;
  dataStore: PluginDataStore;
  i18n: Pick<I18nService, 'resolveIdentityLocale' | 'translator'>;
}

export interface StartPollCreationFlowInput {
  actor: StableIdentityAddressResolution;
  actorLabel: string;
  externalIdempotencyKey: string;
  origin: FlowStartOrigin;
  scopeId: string;
  originGroupWid: string;
  originGroupId?: string | undefined;
  preferences: PollCreationFlowPreferences;
  privateDeliveryFallback?: PrivateDeliveryFallback | undefined;
}

export type StartPollCreationFlowResult = FlowStartResult & {
  pollId: string;
  roundId: string;
  usedPrivateDeliveryFallback: boolean;
};

export type RegisterPollCreationCompletionHandler = (
  flowType: string,
  t: TranslateFn
) => void;

export class PollCreationFlowStarter {
  constructor(
    private readonly context: PollCreationFlowStarterContext,
    private readonly registerCompletionHandler: RegisterPollCreationCompletionHandler
  ) {}

  async start(input: StartPollCreationFlowInput): Promise<StartPollCreationFlowResult> {
    const actorIdentityId = required(input.actor.identityId, 'actor identity ID');
    if (input.actor.identityId !== actorIdentityId) {
      throw new Error('Poll creation requires a normalized authoritative actor identity.');
    }
    const scopeId = required(input.scopeId, 'scope ID');
    const originGroupWid = required(input.originGroupWid, 'origin group WID');
    const startedAt = new Date();
    const pollId = `poll-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;
    const initialData: Record<string, unknown> = {};
    const locale = await this.context.i18n.resolveIdentityLocale(actorIdentityId, scopeId);
    const t = this.context.i18n.translator(locale.locale, locale.languagePackScopes);
    const definition = createPollCreationFlowDefinition({
      t,
      preferences: input.preferences,
      flowInstanceId: pollId,
      initialData
    });
    this.registerCompletionHandler(definition.flowType, t);
    let draftCreated = false;
    const flowStart = await this.context.flowEngine.startFlowForIdentity({
      definition,
      actorIdentityId,
      externalIdempotencyKey: required(input.externalIdempotencyKey, 'external idempotency key'),
      origin: input.origin,
      scopeId,
      initialData,
      ...(input.privateDeliveryFallback ? { privateDeliveryFallback: input.privateDeliveryFallback } : {}),
      onSessionCreated: async (session) => {
        const draft = pollCreationDraftSchema.parse({
          schemaVersion: 1,
          flowSessionId: session.id,
          flowType: definition.flowType,
          pollId,
          roundId,
          scopeId,
          ...(input.originGroupId ? { originGroupId: input.originGroupId } : {}),
          originGroupWid,
          originChatId: required(input.origin.chatId, 'origin chat ID'),
          actorIdentityId,
          actorWid: required(input.actor.canonicalWid, 'actor canonical WID'),
          actorLabel: required(input.actorLabel, 'actor label'),
          locale: locale.locale,
          languagePackScopes: locale.languagePackScopes,
          preferences: input.preferences,
          initialData,
          createdAt: startedAt.toISOString()
        });
        await this.context.dataStore.set(pollCreationDraftKey(scopeId, session.id), draft);
        draftCreated = true;
      },
      onSessionStartFailed: async (session) => {
        if (draftCreated) {
          await this.context.dataStore.delete(pollCreationDraftKey(scopeId, session.id));
        }
      }
    });
    if (flowStart.deduplicated) {
      const recoveredDraft = await readPollCreationDraft(
        this.context.dataStore,
        scopeId,
        flowStart.flowSessionId
      );
      const promptDelivered = await this.context.flowEngine.ensureInitialPromptDelivered(
        flowStart.flowSessionId
      );
      if (!recoveredDraft || !promptDelivered) {
        throw new Error(`Poll creation flow ${flowStart.flowSessionId} could not be recovered.`);
      }
      return {
        ...flowStart,
        pollId: recoveredDraft.pollId,
        roundId: recoveredDraft.roundId,
        usedPrivateDeliveryFallback: Boolean(flowStart.privateDeliveryFallback)
      };
    }
    return {
      ...flowStart,
      pollId,
      roundId,
      usedPrivateDeliveryFallback: Boolean(flowStart.privateDeliveryFallback)
    };
  }
}

const pollCreationResolverRegistrations = new WeakSet<FlowEngine>();

export function registerPollCreationFlowDefinitionResolver(
  context: PollCreationFlowStarterContext,
  registerCompletionHandler: RegisterPollCreationCompletionHandler
): void {
  if (pollCreationResolverRegistrations.has(context.flowEngine)) {
    return;
  }
  context.flowEngine.registerDefinitionResolver({
    ownerId: POLL_ASSISTANT_PLUGIN_ID,
    flowTypePrefix: POLL_CREATION_FLOW_TYPE_PREFIX,
    async resolve(session) {
      if (!session.scopeId) {
        throw new Error(`Poll creation flow ${session.id} has no scope.`);
      }
      const draft = await readPollCreationDraft(context.dataStore, session.scopeId, session.id);
      if (!draft) {
        throw new Error(`Poll creation flow ${session.id} has no valid durable draft recipe.`);
      }
      if (
        draft.flowSessionId !== session.id
        || draft.flowType !== session.flowType
        || draft.scopeId !== session.scopeId
        || draft.actorIdentityId !== session.identityId
      ) {
        throw new Error(`Poll creation flow ${session.id} durable draft does not match its session.`);
      }
      const t = context.i18n.translator(draft.locale, draft.languagePackScopes);
      const definition = restorePollCreationFlowDefinition({
        flowType: draft.flowType,
        t,
        preferences: draft.preferences,
        initialData: draft.initialData
      });
      registerCompletionHandler(definition.flowType, t);
      return definition;
    }
  });
  pollCreationResolverRegistrations.add(context.flowEngine);
}

export async function readPollCreationDraft(
  dataStore: PluginDataStore,
  scopeId: string,
  flowSessionId: string
): Promise<PollCreationDraft | undefined> {
  const raw = await dataStore.get(pollCreationDraftKey(scopeId, flowSessionId));
  const parsed = pollCreationDraftSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function pollCreationDraftKey(scopeId: string, flowSessionId: string): string {
  return `poll-assistant:create-draft:${required(scopeId, 'scope ID')}:${required(flowSessionId, 'flow session ID')}`;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Poll creation ${label} is required.`);
  }
  return normalized;
}
