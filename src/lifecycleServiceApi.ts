import { z } from 'zod';
import { pollDefinitionSchema } from './domain';

export const POLL_ASSISTANT_LIFECYCLE_SERVICE_ID = 'official.poll-assistant.lifecycle.v1';
export const POLL_ASSISTANT_LIFECYCLE_ENSURE_METHOD = 'ensurePoll';
export const POLL_ASSISTANT_LIFECYCLE_INSPECT_METHOD = 'inspectPoll';
export const POLL_ASSISTANT_LIFECYCLE_FINALIZE_METHOD = 'finalizePoll';
export const POLL_ASSISTANT_LIFECYCLE_CANCEL_METHOD = 'cancelPoll';

const stableIdSchema = z.string().trim().min(1).max(200);
const groupWidSchema = z.string().trim().min(1).max(256);
const isoTimestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const pollAssistantLifecyclePresentationOwnerSchema = z.enum([
  'poll_assistant',
  'source_plugin'
]);

export const pollAssistantSourceSurveyDefinitionSchema = pollDefinitionSchema.superRefine(
  (definition, ctx) => {
    if (definition.purpose === 'decide') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source survey lifecycles must be non-decision polls',
        path: ['purpose']
      });
    }
    if (definition.ballotDelivery !== 'group') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source survey lifecycles require one group poll',
        path: ['ballotDelivery']
      });
    }
    if (definition.voterDisclosure !== 'named') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source survey lifecycles require named ballots',
        path: ['voterDisclosure']
      });
    }
    if (definition.electorate.kind === 'actor') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source survey lifecycles require a group electorate',
        path: ['electorate']
      });
    }
  }
);

export const pollAssistantLifecycleEnsureInputSchema = z.object({
  groupWid: groupWidSchema,
  sourceIdempotencyKey: stableIdSchema,
  definition: pollAssistantSourceSurveyDefinitionSchema,
  presentationOwner: pollAssistantLifecyclePresentationOwnerSchema
}).strict();

const lifecycleReferenceInput = {
  groupWid: groupWidSchema,
  sourceIdempotencyKey: stableIdSchema
} as const;

export const pollAssistantLifecycleInspectInputSchema = z.object({
  ...lifecycleReferenceInput
}).strict();

export const pollAssistantLifecycleFinalizeInputSchema = z.object({
  ...lifecycleReferenceInput,
  finalizationIdempotencyKey: stableIdSchema
}).strict();

export const pollAssistantLifecycleCancelInputSchema = z.object({
  ...lifecycleReferenceInput,
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

const sourceSurveyOptionSchema = z.object({
  id: stableIdSchema,
  label: z.string().trim().min(1),
  ordinal: z.number().int().min(1).max(12)
}).strict();

export const pollAssistantNamedBallotSnapshotSchema = z.object({
  voterIdentityId: stableIdSchema,
  voterWid: z.string().trim().min(1).max(256),
  selectedOptionIds: z.array(stableIdSchema).max(12)
    .refine((ids) => new Set(ids).size === ids.length, 'Selected option ids must be unique'),
  sourceWaMessageId: stableIdSchema,
  interactedAt: isoTimestampSchema,
  receivedAt: isoTimestampSchema
}).strict();

export const pollAssistantLifecycleSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  sourcePluginId: stableIdSchema,
  sourceIdempotencyKey: stableIdSchema,
  groupWid: groupWidSchema,
  pollId: stableIdSchema,
  roundId: stableIdSchema,
  pollWaMessageId: stableIdSchema,
  cutoffAt: isoTimestampSchema,
  finalizedAt: isoTimestampSchema,
  ballots: z.array(pollAssistantNamedBallotSnapshotSchema)
}).strict();

const lifecycleBase = {
  sourcePluginId: stableIdSchema,
  sourceIdempotencyKey: stableIdSchema,
  organizerIdentityId: stableIdSchema,
  groupWid: groupWidSchema,
  pollId: stableIdSchema,
  roundId: stableIdSchema,
  pollStatus: pollStatusSchema,
  roundStatus: roundStatusSchema,
  presentationOwner: pollAssistantLifecyclePresentationOwnerSchema,
  question: z.string().trim().min(1),
  allowMultipleAnswers: z.boolean(),
  pollWaMessageId: stableIdSchema.nullable(),
  closesAt: isoTimestampSchema.nullable(),
  options: z.array(sourceSurveyOptionSchema).min(2).max(12),
  snapshot: pollAssistantLifecycleSnapshotSchema.nullable(),
  snapshotSha256: sha256Schema.nullable()
} as const;

export const pollAssistantLifecycleEnsureOutputSchema = z.object({
  kind: z.enum(['created', 'existing']),
  ...lifecycleBase
}).strict();

export const pollAssistantLifecycleInspectOutputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum(['not_found', 'wrong_group'])
  }).strict(),
  z.object({ kind: z.literal('found'), ...lifecycleBase }).strict()
]);

export const pollAssistantLifecycleFinalizeOutputSchema = z.object({
  kind: z.enum(['queued', 'existing', 'finalized', 'cancelled', 'failed']),
  ...lifecycleBase
}).strict();

export const pollAssistantLifecycleCancelOutputSchema = z.object({
  kind: z.enum(['cancelled', 'existing']),
  ...lifecycleBase
}).strict();

export type PollAssistantLifecycleEnsureInput = z.infer<typeof pollAssistantLifecycleEnsureInputSchema>;
export type PollAssistantLifecycleEnsureOutput = z.infer<typeof pollAssistantLifecycleEnsureOutputSchema>;
export type PollAssistantLifecycleInspectInput = z.infer<typeof pollAssistantLifecycleInspectInputSchema>;
export type PollAssistantLifecycleInspectOutput = z.infer<typeof pollAssistantLifecycleInspectOutputSchema>;
export type PollAssistantLifecycleFinalizeInput = z.infer<typeof pollAssistantLifecycleFinalizeInputSchema>;
export type PollAssistantLifecycleFinalizeOutput = z.infer<typeof pollAssistantLifecycleFinalizeOutputSchema>;
export type PollAssistantLifecycleCancelInput = z.infer<typeof pollAssistantLifecycleCancelInputSchema>;
export type PollAssistantLifecycleCancelOutput = z.infer<typeof pollAssistantLifecycleCancelOutputSchema>;
export type PollAssistantLifecycleSnapshot = z.infer<typeof pollAssistantLifecycleSnapshotSchema>;
