import { createHash } from 'node:crypto';
import { attachPollOutcomeFlow } from './outcomeFlow';
import { z } from 'zod';
import type {
  FlowEngine,
  FlowSessionSnapshot,
  FlowStartOrigin,
  FlowStartResult
} from '../../../adminBot/flows/flowEngine';
import type { I18nService, LanguagePackScope, TranslateFn } from '../../../platform/i18n';
import type { StableIdentityAddressResolution } from '../../../platform/identity/identityAddressService';
import type { PrivateDeliveryFallback } from '../../../platform/transport/transportTypes';
import { POLL_ASSISTANT_PLUGIN_ID } from './database';
import { pollCreationPresetSchema } from './config';
import {
  createPollCreationFlowDefinition,
  isPollCreationFlowType,
  POLL_CREATION_FLOW_TYPE_PREFIX,
  pollCreationPresetInitialData,
  restorePollCreationFlowDefinition,
  type PollCreationFlowPreferences
} from './flow';

export const POLL_CREATION_RECIPE_DATA_KEY = 'pollAssistantCreationRecipe';

export interface PollCreationRecipe {
  schemaVersion: 1;
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
  createdAt: string;
}

const pollCreationPreferencesSchema = z.object({
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
  ]),
  preset: pollCreationPresetSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (
    value.defaultClosing.kind === 'deadline'
    && value.defaultClosing.durationMinutes > value.maxDeadlineMinutes
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Default deadline duration cannot exceed the maximum deadline duration',
      path: ['defaultClosing', 'durationMinutes']
    });
  }
});

export const pollCreationRecipeSchema = z.object({
  schemaVersion: z.literal(1),
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
  preferences: pollCreationPreferencesSchema,
  createdAt: z.string().datetime({ offset: true })
}).strict().superRefine((recipe, ctx) => {
  if (recipe.flowType !== `${POLL_CREATION_FLOW_TYPE_PREFIX}${recipe.pollId}`) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Poll creation flow type must be derived from its stable poll ID',
      path: ['flowType']
    });
  }
});

export interface PollCreationFlowStarterContext {
  flowEngine: FlowEngine;
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
    const externalIdempotencyKey = required(
      input.externalIdempotencyKey,
      'external idempotency key'
    );
    const inspection = await this.context.flowEngine.inspectIdentityFlowStart({
      actorIdentityId,
      externalIdempotencyKey
    });
    if (inspection.kind === 'duplicate') {
      return this.recoverDuplicate(inspection.session);
    }
    const stableIds = stableCreationIds(scopeId, actorIdentityId, externalIdempotencyKey);
    const pollId = stableIds.pollId;
    const roundId = stableIds.roundId;
    const flowType = `${POLL_CREATION_FLOW_TYPE_PREFIX}${pollId}`;
    const locale = await this.context.i18n.resolveIdentityLocale(actorIdentityId, scopeId);
    const recipe = pollCreationRecipeSchema.parse({
      schemaVersion: 1,
      flowType,
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
      createdAt: new Date().toISOString()
    });
    const initialData: Record<string, unknown> = {
      ...pollCreationPresetInitialData(recipe.preferences.preset),
      [POLL_CREATION_RECIPE_DATA_KEY]: recipe
    };
    const t = this.context.i18n.translator(recipe.locale, recipe.languagePackScopes);
    const definition = attachPollOutcomeFlow(createPollCreationFlowDefinition({
      t,
      locale: recipe.locale,
      preferences: recipe.preferences,
      flowInstanceId: recipe.pollId,
      initialData
    }), this.context.flowEngine, recipe, t);
    this.registerCompletionHandler(definition.flowType, t);
    const flowStart = await this.context.flowEngine.startFlowForIdentity({
      definition,
      actorIdentityId,
      externalIdempotencyKey,
      origin: input.origin,
      scopeId,
      initialData,
      ...(input.privateDeliveryFallback ? { privateDeliveryFallback: input.privateDeliveryFallback } : {})
    });
    if (flowStart.deduplicated) {
      const snapshot = await this.context.flowEngine.getSessionSnapshot(flowStart.flowSessionId);
      if (!snapshot) {
        throw new Error(`Poll creation flow ${flowStart.flowSessionId} could not be recovered.`);
      }
      return this.recoverDuplicate(snapshot);
    }
    return {
      ...flowStart,
      pollId: recipe.pollId,
      roundId: recipe.roundId,
      usedPrivateDeliveryFallback: Boolean(flowStart.privateDeliveryFallback)
    };
  }

  private async recoverDuplicate(
    snapshot: FlowSessionSnapshot
  ): Promise<StartPollCreationFlowResult> {
    const recipe = pollCreationRecipeFromSnapshot(snapshot);
    if (!recipe) {
      throw new Error(`Poll creation flow ${snapshot.id} could not be recovered.`);
    }
    const t = this.context.i18n.translator(recipe.locale, recipe.languagePackScopes);
    const definition = attachPollOutcomeFlow(restorePollCreationFlowDefinition({
      flowType: recipe.flowType,
      t,
      locale: recipe.locale,
      preferences: recipe.preferences,
      initialData: snapshot.state.data
    }), this.context.flowEngine, recipe, t);
    this.context.flowEngine.register(definition);
    this.registerCompletionHandler(snapshot.flowType, t);
    if (!await this.context.flowEngine.ensureInitialPromptDelivered(snapshot.id)) {
      throw new Error(`Poll creation flow ${snapshot.id} could not be recovered.`);
    }
    return {
      flowSessionId: snapshot.id,
      deduplicated: true,
      pollId: recipe.pollId,
      roundId: recipe.roundId,
      usedPrivateDeliveryFallback: false
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
      const recipe = pollCreationRecipeFromSnapshot(session);
      if (!recipe) {
        throw new Error(`Poll creation flow ${session.id} has no valid durable session recipe.`);
      }
      const t = context.i18n.translator(recipe.locale, recipe.languagePackScopes);
      const definition = attachPollOutcomeFlow(restorePollCreationFlowDefinition({
        flowType: recipe.flowType,
        t,
        locale: recipe.locale,
        preferences: recipe.preferences,
        initialData: session.state.data
      }), context.flowEngine, recipe, t);
      registerCompletionHandler(definition.flowType, t);
      return definition;
    }
  });
  pollCreationResolverRegistrations.add(context.flowEngine);
}

export function pollCreationRecipeFromSnapshot(
  snapshot: FlowSessionSnapshot
): PollCreationRecipe | undefined {
  const parsed = pollCreationRecipeSchema.safeParse(
    snapshot.state.data[POLL_CREATION_RECIPE_DATA_KEY]
  );
  if (!parsed.success) {
    return undefined;
  }
  const recipe = parsed.data;
  if (
    snapshot.flowType !== recipe.flowType
    || snapshot.scopeId !== recipe.scopeId
    || snapshot.identityId !== recipe.actorIdentityId
    || (snapshot.originChatId !== undefined && snapshot.originChatId !== recipe.originChatId)
  ) {
    return undefined;
  }
  return recipe;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Poll creation ${label} is required.`);
  }
  return normalized;
}

function stableCreationIds(
  scopeId: string,
  actorIdentityId: string,
  externalIdempotencyKey: string
): { pollId: string; roundId: string } {
  const base = createHash('sha256')
    .update(scopeId)
    .update('\0')
    .update(actorIdentityId)
    .update('\0')
    .update(externalIdempotencyKey)
    .digest('hex');
  const round = createHash('sha256').update(base).update('\0round:1').digest('hex');
  return {
    pollId: `poll-${base.slice(0, 32)}`,
    roundId: `round-${round.slice(0, 32)}`
  };
}
