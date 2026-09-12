import { z } from 'zod';
import {
  jsonSchemaForZodObject,
  throwIfAborted,
  type AssistantTool,
  type AssistantToolContext
} from '../../../../packages/plugin-sdk/src/assistant-tools';
import { type PluginCommandContext } from './runtime';
import { parsePollAssistantConfig } from './config';
import { POLL_ASSISTANT_PLUGIN_ID } from './database';
import { pollResultSchema, type PollResult } from './domain';
import {
  actorCanManagePoll,
  latestPollRound,
  listPollAggregatesForGroup,
  lookupPollForGroup,
  requestPollClose
} from './operations';
import { calculatePollResult } from './resultCalculator';
import {
  getPollResult,
  listPollBallots,
  pollsDatabase,
  type StoredPollAggregate
} from './store';

const pollAssistantToolInputSchema = z.object({}).strict();
const pollAssistantPollIdInputSchema = z.object({
  pollId: z.string().trim().min(1).max(200)
}).strict();

const pollAssistantPollSummarySchema = z.object({
  pollId: z.string(),
  question: z.string(),
  purpose: z.enum(['decide', 'measure', 'count']),
  status: z.enum(['active', 'tie_pending', 'resolved', 'cancelled', 'failed']),
  roundStatus: z.enum([
    'publish_pending',
    'publishing',
    'open',
    'finalizing',
    'finalized',
    'tie_pending',
    'cancelled',
    'failed'
  ]).optional(),
  closesAt: z.string().optional()
}).strict();

const pollAssistantListOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('group_required'), polls: z.array(pollAssistantPollSummarySchema) }).strict(),
  z.object({ status: z.literal('ok'), polls: z.array(pollAssistantPollSummarySchema).max(50) }).strict()
]);

const pollAssistantResultOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('group_required') }).strict(),
  z.object({ status: z.literal('not_found'), pollId: z.string() }).strict(),
  z.object({ status: z.literal('wrong_group'), pollId: z.string() }).strict(),
  z.object({
    status: z.literal('found'),
    poll: pollAssistantPollSummarySchema,
    availability: z.enum(['authoritative_final', 'provisional_live', 'not_finalized']),
    asOf: z.string(),
    options: z.array(z.object({
      optionId: z.string(),
      ordinal: z.number().int(),
      label: z.string()
    }).strict()),
    result: pollResultSchema.optional()
  }).strict()
]);

const pollAssistantCloseOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('group_required') }).strict(),
  z.object({ status: z.literal('not_found'), pollId: z.string() }).strict(),
  z.object({ status: z.literal('wrong_group'), pollId: z.string() }).strict(),
  z.object({ status: z.literal('not_open'), pollId: z.string(), question: z.string() }).strict(),
  z.object({ status: z.literal('permission_denied'), pollId: z.string(), question: z.string() }).strict(),
  z.object({
    status: z.literal('queued'),
    pollId: z.string(),
    question: z.string(),
    requestedAt: z.string(),
    resultDelivery: z.literal('originating_group')
  }).strict()
]);

type PollAssistantPollIdInput = z.infer<typeof pollAssistantPollIdInputSchema>;
type PollAssistantListOutput = z.infer<typeof pollAssistantListOutputSchema>;
type PollAssistantResultOutput = z.infer<typeof pollAssistantResultOutputSchema>;
type PollAssistantCloseOutput = z.infer<typeof pollAssistantCloseOutputSchema>;

export function registerPollAssistantTools(context: PluginCommandContext): AssistantTool[] {
  return [
    pollListTool(context),
    pollResultTool(context),
    pollCloseTool(context)
  ];
}

function pollListTool(
  pluginContext: PluginCommandContext
): AssistantTool<Record<string, never>, PollAssistantListOutput> {
  return {
    descriptor: {
      name: 'official.poll-assistant.polls.list',
      description: 'List Poll Assistant polls from the current originating group with stable IDs, readable questions, lifecycle status, and closing time. Use this before resolving phrases such as “the poll” or “the current poll”.',
      pluginId: POLL_ASSISTANT_PLUGIN_ID,
      inputSchema: jsonSchemaForZodObject({}),
      outputSchema: jsonSchemaForZodObject({
        status: { type: 'string', enum: ['ok', 'group_required'] },
        polls: { type: 'array', items: { type: 'object' }, maxItems: 50 }
      }, ['status', 'polls']),
      mutation: 'none',
      dangerous: false,
      approval: 'never'
    },
    inputSchema: pollAssistantToolInputSchema,
    outputSchema: pollAssistantListOutputSchema,
    run(toolContext) {
      throwIfAborted(toolContext.signal);
      const groupWid = toolContext.groupWid?.trim();
      if (!groupWid) {
        return { content: { status: 'group_required', polls: [] } };
      }
      const polls = listPollAggregatesForGroup({
        databases: pluginContext.databases,
        scopeId: toolContext.scopeId,
        groupWid
      }).map(pollSummary);
      return { content: { status: 'ok', polls } };
    }
  };
}

function pollResultTool(
  pluginContext: PluginCommandContext
): AssistantTool<PollAssistantPollIdInput, PollAssistantResultOutput> {
  return {
    descriptor: {
      name: 'official.poll-assistant.results.get',
      description: 'Get aggregate results for one Poll Assistant poll in the current group. Final results are authoritative. Open-poll results are returned only when enabled by the operator and are explicitly provisional. Never returns voter identities or individual ballots.',
      pluginId: POLL_ASSISTANT_PLUGIN_ID,
      inputSchema: pollIdInputJsonSchema(),
      outputSchema: jsonSchemaForZodObject({
        status: { type: 'string', enum: ['found', 'not_found', 'wrong_group', 'group_required'] },
        pollId: { type: 'string' },
        poll: { type: 'object' },
        availability: { type: 'string', enum: ['authoritative_final', 'provisional_live', 'not_finalized'] },
        asOf: { type: 'string' },
        options: { type: 'array', items: { type: 'object' } },
        result: { type: 'object' }
      }, ['status']),
      mutation: 'none',
      dangerous: false,
      approval: 'never'
    },
    inputSchema: pollAssistantPollIdInputSchema,
    outputSchema: pollAssistantResultOutputSchema,
    async run(toolContext, input) {
      throwIfAborted(toolContext.signal);
      const lookup = toolPollLookup(pluginContext, toolContext, input.pollId);
      if (lookup.kind !== 'found') {
        return { content: pollLookupFailure(lookup) };
      }
      const aggregate = lookup.aggregate;
      const round = latestPollRound(aggregate);
      const options = aggregate.poll.definition.options.map((option) => ({
        optionId: option.id,
        ordinal: option.ordinal,
        label: option.label
      }));
      const finalResult = round ? getPollResult(pollsDatabase(pluginContext.databases), round.id) : undefined;
      if (finalResult) {
        return {
          content: {
            status: 'found',
            poll: pollSummary(aggregate),
            availability: 'authoritative_final',
            asOf: finalResult.computedAt,
            options,
            result: finalResult
          }
        };
      }
      const actorIdentityId = toolContext.actor.identityAddress?.identityId;
      const config = parsePollAssistantConfig(pluginContext.configFor
        ? await pluginContext.configFor(toolContext.scopeId, actorIdentityId)
        : {});
      if (!config.assistantExposeProvisionalResults || !round || round.status !== 'open') {
        return {
          content: {
            status: 'found',
            poll: pollSummary(aggregate),
            availability: 'not_finalized',
            asOf: new Date().toISOString(),
            options
          }
        };
      }
      const asOf = new Date();
      const result = provisionalResult(
        pollsDatabase(pluginContext.databases),
        aggregate,
        round.id,
        asOf
      );
      return {
        content: {
          status: 'found',
          poll: pollSummary(aggregate),
          availability: 'provisional_live',
          asOf: asOf.toISOString(),
          options,
          result
        }
      };
    }
  };
}

function pollCloseTool(
  pluginContext: PluginCommandContext
): AssistantTool<PollAssistantPollIdInput, PollAssistantCloseOutput> {
  return {
    descriptor: {
      name: 'official.poll-assistant.poll.close',
      description: 'Close one explicitly selected open Poll Assistant poll in the current originating group. Always requires confirmation, rechecks creator or polls.manage authorization, records the cutoff, and queues authoritative result delivery to the group.',
      pluginId: POLL_ASSISTANT_PLUGIN_ID,
      inputSchema: pollIdInputJsonSchema(),
      outputSchema: jsonSchemaForZodObject({
        status: { type: 'string', enum: ['queued', 'not_found', 'wrong_group', 'group_required', 'not_open', 'permission_denied'] },
        pollId: { type: 'string' },
        question: { type: 'string' },
        requestedAt: { type: 'string' },
        resultDelivery: { type: 'string', enum: ['originating_group'] }
      }, ['status']),
      mutation: 'durable',
      dangerous: true,
      approval: 'always'
    },
    inputSchema: pollAssistantPollIdInputSchema,
    outputSchema: pollAssistantCloseOutputSchema,
    async requiresApproval(toolContext, input) {
      const lookup = toolPollLookup(pluginContext, toolContext, input.pollId);
      return lookup.kind === 'found'
        && latestPollRound(lookup.aggregate)?.status === 'open'
        && await actorCanManagePoll({
          context: pluginContext,
          actor: toolContext.actor,
          poll: lookup.aggregate.poll
        });
    },
    async run(toolContext, input) {
      throwIfAborted(toolContext.signal);
      const lookup = toolPollLookup(pluginContext, toolContext, input.pollId);
      if (lookup.kind !== 'found') {
        return { content: pollLookupFailure(lookup) };
      }
      const aggregate = lookup.aggregate;
      const round = latestPollRound(aggregate);
      if (!round || round.status !== 'open') {
        return { content: {
          status: 'not_open',
          pollId: aggregate.poll.id,
          question: aggregate.poll.definition.question
        } };
      }
      if (!await actorCanManagePoll({
        context: pluginContext,
        actor: toolContext.actor,
        poll: aggregate.poll
      })) {
        return { content: {
          status: 'permission_denied',
          pollId: aggregate.poll.id,
          question: aggregate.poll.definition.question
        } };
      }
      const closed = await requestPollClose({
        context: pluginContext,
        databases: pluginContext.databases,
        aggregate
      });
      if (closed.kind === 'not_open') {
        return { content: {
          status: 'not_open',
          pollId: aggregate.poll.id,
          question: aggregate.poll.definition.question
        } };
      }
      return { content: {
        status: 'queued',
        pollId: aggregate.poll.id,
        question: aggregate.poll.definition.question,
        requestedAt: closed.requestedAt.toISOString(),
        resultDelivery: 'originating_group'
      } };
    }
  };
}

type ToolPollLookup =
  | { kind: 'found'; aggregate: StoredPollAggregate }
  | { kind: 'group_required' }
  | { kind: 'not_found'; pollId: string }
  | { kind: 'wrong_group'; pollId: string };

function toolPollLookup(
  pluginContext: PluginCommandContext,
  toolContext: AssistantToolContext,
  pollId: string
): ToolPollLookup {
  const groupWid = toolContext.groupWid?.trim();
  if (!groupWid) {
    return { kind: 'group_required' };
  }
  const lookup = lookupPollForGroup({
    databases: pluginContext.databases,
    scopeId: toolContext.scopeId,
    groupWid,
    pollId
  });
  if (lookup.kind === 'not_found') return { kind: 'not_found', pollId };
  if (lookup.kind === 'wrong_group') return { kind: 'wrong_group', pollId };
  return { kind: 'found', aggregate: lookup.aggregate };
}

function pollLookupFailure(
  lookup: Exclude<ToolPollLookup, { kind: 'found' }>
): { status: 'group_required' }
  | { status: 'not_found'; pollId: string }
  | { status: 'wrong_group'; pollId: string } {
  if (lookup.kind === 'group_required') return { status: 'group_required' };
  return { status: lookup.kind, pollId: lookup.pollId };
}

function pollSummary(aggregate: StoredPollAggregate) {
  const round = latestPollRound(aggregate);
  return pollAssistantPollSummarySchema.parse({
    pollId: aggregate.poll.id,
    question: aggregate.poll.definition.question,
    purpose: aggregate.poll.purpose,
    status: aggregate.poll.status,
    ...(round ? { roundStatus: round.status } : {}),
    ...(round?.closesAt ? { closesAt: round.closesAt } : {})
  });
}

function provisionalResult(
  db: ReturnType<typeof pollsDatabase>,
  aggregate: StoredPollAggregate,
  roundId: string,
  asOf: Date
): PollResult {
  const ballots = listPollBallots(db, roundId);
  return calculatePollResult({
    definition: aggregate.poll.definition,
    roundId,
    electorateIdentityIds: aggregate.electorate.map((elector) => elector.voterIdentityId),
    ballots: ballots.filter((ballot) => Date.parse(ballot.interactedAt) <= asOf.getTime()),
    cutoffAt: asOf.toISOString(),
    computedAt: asOf.toISOString()
  });
}

function pollIdInputJsonSchema(): Record<string, unknown> {
  return jsonSchemaForZodObject({
    pollId: { type: 'string', minLength: 1, maxLength: 200 }
  }, ['pollId']);
}
