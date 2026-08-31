import { z } from 'zod';
import {
  pollDefinitionSchema,
  pollElectorateDefinitionSchema,
  pollOptionTallySchema
} from './domain';
import {
  pollAssistantAutomationPolicySnapshotSchema,
  pollAssistantTimezoneSchema
} from './workingHours';

export const POLL_ASSISTANT_AUTOMATION_SERVICE_ID = 'official.poll-assistant.automation.v1';
export const POLL_ASSISTANT_ENSURE_POLL_METHOD = 'ensurePoll';
export const POLL_ASSISTANT_RESOLVE_POLL_METHOD = 'resolvePoll';
export const POLL_ASSISTANT_RESOLVE_OUTCOME_METHOD = 'resolveOutcome';
export const POLL_ASSISTANT_CANCEL_POLL_METHOD = 'cancelPoll';

const stableIdSchema = z.string().trim().min(1).max(200);
const groupWidSchema = z.string().trim().min(1).max(256);

export const pollAssistantAutomationDefinitionSchema = pollDefinitionSchema.superRefine(
  (definition, ctx) => {
    if (definition.purpose !== 'decide') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Automated Poll Assistant lifecycles currently require a decision poll',
        path: ['purpose']
      });
    }
    if (
      definition.electorate.kind !== 'group_members_until_cutoff'
      && definition.electorate.kind !== 'actor'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Automated polls require group_members_until_cutoff or actor electorate semantics',
        path: ['electorate']
      });
    }
  }
);

export const pollAssistantEnsurePollInputSchema = z.object({
  groupWid: groupWidSchema,
  sourceIdempotencyKey: stableIdSchema,
  definition: pollAssistantAutomationDefinitionSchema,
  workingHoursTimezone: pollAssistantTimezoneSchema.optional(),
  bypassWorkingHours: z.boolean().default(false)
}).strict();

export const pollAssistantResolvePollInputSchema = z.object({
  groupWid: groupWidSchema,
  sourceIdempotencyKey: stableIdSchema
}).strict();

export const pollAssistantResolveOutcomeInputSchema = z.object({
  groupWid: groupWidSchema,
  sourceIdempotencyKey: stableIdSchema,
  resolutionIdempotencyKey: stableIdSchema,
  selectedOptionIds: z.array(stableIdSchema).min(1).max(12)
    .refine((ids) => new Set(ids).size === ids.length, 'Selected option ids must be unique')
}).strict();

export const pollAssistantCancelPollInputSchema = z.object({
  groupWid: groupWidSchema,
  sourceIdempotencyKey: stableIdSchema,
  cancellationIdempotencyKey: stableIdSchema,
  reason: z.string().trim().min(1).max(1_000).optional()
}).strict();

const pollStatusSchema = z.enum(['active', 'tie_pending', 'resolved', 'cancelled', 'failed']);
const roundStatusSchema = z.enum([
  'publish_pending',
  'publishing',
  'open',
  'finalizing',
  'finalized',
  'tie_pending',
  'cancelled',
  'failed'
]);

const automationPollOptionSchema = z.object({
  id: stableIdSchema,
  label: z.string().trim().min(1),
  ordinal: z.number().int().min(1).max(12)
}).strict();

const automationPollBase = {
  sourcePluginId: stableIdSchema,
  sourceIdempotencyKey: stableIdSchema,
  organizerIdentityId: stableIdSchema,
  groupWid: groupWidSchema,
  pollId: stableIdSchema,
  roundId: stableIdSchema,
  pollStatus: pollStatusSchema,
  roundStatus: roundStatusSchema,
  ballotDelivery: z.enum(['group', 'private']),
  voterDisclosure: z.enum(['named', 'hidden']),
  electorate: pollElectorateDefinitionSchema,
  publicationNotBefore: z.string().datetime({ offset: true }),
  activationDeadlineAt: z.string().datetime({ offset: true }).nullable(),
  activatedAt: z.string().datetime({ offset: true }).nullable(),
  closesAt: z.string().datetime({ offset: true }).nullable(),
  workingHoursPolicy: pollAssistantAutomationPolicySnapshotSchema,
  workingHoursOverrideAt: z.string().datetime({ offset: true }).nullable(),
  options: z.array(automationPollOptionSchema).min(2).max(12)
} as const;

export const pollAssistantEnsurePollOutputSchema = z.object({
  kind: z.enum(['created', 'existing']),
  ...automationPollBase
}).strict();

export const pollAssistantResolvedOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open') }).strict(),
  z.object({
    kind: z.literal('not_finalized'),
    reason: z.enum(['publish_pending', 'publishing', 'finalizing', 'tie_pending'])
  }).strict(),
  z.object({
    kind: z.literal('no_response'),
    tallies: z.array(pollOptionTallySchema),
    eligibleCount: z.number().int().nonnegative()
  }).strict(),
  z.object({
    kind: z.literal('decided'),
    selectedOptionIds: z.array(stableIdSchema).min(1),
    tallies: z.array(pollOptionTallySchema),
    eligibleCount: z.number().int().nonnegative(),
    responseCount: z.number().int().nonnegative()
  }).strict(),
  z.object({
    kind: z.literal('undecided'),
    reason: z.enum(['quorum_not_met', 'tie', 'no_decision']),
    tallies: z.array(pollOptionTallySchema),
    eligibleCount: z.number().int().nonnegative(),
    responseCount: z.number().int().nonnegative()
  }).strict(),
  z.object({ kind: z.literal('cancelled') }).strict(),
  z.object({ kind: z.literal('failed') }).strict()
]);

export const pollAssistantResolvePollOutputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum(['not_found', 'wrong_group'])
  }).strict(),
  z.object({
    kind: z.literal('found'),
    ...automationPollBase,
    outcome: pollAssistantResolvedOutcomeSchema
  }).strict()
]);

export const pollAssistantResolveOutcomeOutputSchema = z.object({
  kind: z.enum(['resolved', 'existing']),
  pollId: stableIdSchema,
  roundId: stableIdSchema,
  selectedOptionIds: z.array(stableIdSchema).min(1),
  resolvedAt: z.string().datetime({ offset: true })
}).strict();

export const pollAssistantCancelPollOutputSchema = z.object({
  kind: z.enum(['cancelled', 'existing']),
  pollId: stableIdSchema,
  cancelledAt: z.string().datetime({ offset: true })
}).strict();

export type PollAssistantEnsurePollInput = Omit<
  z.infer<typeof pollAssistantEnsurePollInputSchema>,
  'bypassWorkingHours'
> & { bypassWorkingHours?: boolean | undefined };
export type PollAssistantEnsurePollOutput = z.infer<typeof pollAssistantEnsurePollOutputSchema>;
export type PollAssistantResolvePollInput = z.infer<typeof pollAssistantResolvePollInputSchema>;
export type PollAssistantResolvePollOutput = z.infer<typeof pollAssistantResolvePollOutputSchema>;
export type PollAssistantResolvedOutcome = z.infer<typeof pollAssistantResolvedOutcomeSchema>;
export type PollAssistantResolveOutcomeInput = z.infer<typeof pollAssistantResolveOutcomeInputSchema>;
export type PollAssistantResolveOutcomeOutput = z.infer<typeof pollAssistantResolveOutcomeOutputSchema>;
export type PollAssistantCancelPollInput = z.infer<typeof pollAssistantCancelPollInputSchema>;
export type PollAssistantCancelPollOutput = z.infer<typeof pollAssistantCancelPollOutputSchema>;
