import { z } from 'zod';
import {
  WHATSAPP_POLL_MAX_OPTIONS,
  WHATSAPP_POLL_MIN_OPTIONS,
  numberPollOptions,
  validatePollContent
} from '../../../platform/transport/pollContract';

export const POLL_ASSISTANT_SCHEMA_VERSION = 1 as const;

const stableIdSchema = z.string().trim().min(1).max(200);
const isoTimestampSchema = z.string().datetime({ offset: true });
const basisPointsSchema = z.number().int().min(0).max(10_000);
const safeIntegerSchema = z.number().int().refine(Number.isSafeInteger, 'Must be a safe integer');
const nonNegativeSafeIntegerSchema = safeIntegerSchema.refine(
  (value) => value >= 0,
  'Must be non-negative'
);

export const countUnitSchema = z.string()
  .trim()
  .min(1)
  .refine((value) => Array.from(value).length <= 100, 'Must contain at most 100 Unicode code points');

export const pollOptionSchema = z.object({
  id: stableIdSchema,
  label: z.string().trim().min(1),
  ordinal: z.number().int().min(1).max(WHATSAPP_POLL_MAX_OPTIONS),
  numericValue: nonNegativeSafeIntegerSchema.optional()
}).strict();

export const pollClosingConditionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('deadline'),
    deadline: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('at'),
        closesAt: isoTimestampSchema
      }).strict(),
      z.object({
        mode: z.literal('after_publish'),
        durationMinutes: z.number().int().min(1).max(31 * 24 * 60)
      }).strict()
    ])
  }).strict(),
  z.object({ kind: z.literal('manual') }).strict()
]);

export const pollQuorumSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('absolute'),
    minimumResponses: z.number().int().min(1)
  }).strict(),
  z.object({
    kind: z.literal('percentage'),
    minimumTurnoutBasisPoints: basisPointsSchema.min(1)
  }).strict()
]);

export const pollElectorateDefinitionSchema = z.object({
  kind: z.literal('members_at_publication')
}).strict().or(z.object({
  kind: z.literal('group_members_until_cutoff')
}).strict()).or(z.object({
  kind: z.literal('actor')
}).strict());

export const pollBallotDeliverySchema = z.enum(['group', 'private']);
export const pollVoterDisclosureSchema = z.enum(['named', 'hidden']);

export const decideRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plurality') }).strict(),
  z.object({
    kind: z.literal('single_non_transferable'),
    seats: z.number().int().min(1).max(WHATSAPP_POLL_MAX_OPTIONS)
  }).strict(),
  z.object({ kind: z.literal('approval') }).strict(),
  z.object({
    kind: z.literal('multiwinner_approval'),
    seats: z.number().int().min(1).max(WHATSAPP_POLL_MAX_OPTIONS)
  }).strict(),
  z.object({
    kind: z.literal('approve_reject'),
    approveOptionId: stableIdSchema,
    rejectOptionId: stableIdSchema,
    minimumApprovalBasisPoints: basisPointsSchema.min(5_001)
  }).strict()
]);

export const decideTiePolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no_decision') }).strict(),
  z.object({ kind: z.literal('authorized_choice') }).strict(),
  z.object({ kind: z.literal('status_quo') }).strict(),
  z.object({ kind: z.literal('random_draw') }).strict()
]);

export const measureRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('distribution'),
    allowMultipleAnswers: z.boolean()
  }).strict(),
  z.object({ kind: z.literal('ordered_scale') }).strict()
]);

export const countRuleSchema = z.object({
  kind: z.literal('sum'),
  unit: countUnitSchema
}).strict();

const definitionBase = {
  schemaVersion: z.literal(POLL_ASSISTANT_SCHEMA_VERSION),
  id: stableIdSchema,
  question: z.string().trim().min(1),
  options: z.array(pollOptionSchema)
    .min(WHATSAPP_POLL_MIN_OPTIONS)
    .max(WHATSAPP_POLL_MAX_OPTIONS),
  closing: pollClosingConditionSchema,
  quorum: pollQuorumSchema,
  electorate: pollElectorateDefinitionSchema,
  ballotDelivery: pollBallotDeliverySchema.default('group'),
  voterDisclosure: pollVoterDisclosureSchema.default('named')
} as const;

const decidePollDefinitionSchema = z.object({
  ...definitionBase,
  purpose: z.literal('decide'),
  rule: decideRuleSchema,
  tiePolicy: decideTiePolicySchema
}).strict();

const measurePollDefinitionSchema = z.object({
  ...definitionBase,
  purpose: z.literal('measure'),
  rule: measureRuleSchema
}).strict();

const countPollDefinitionSchema = z.object({
  ...definitionBase,
  purpose: z.literal('count'),
  rule: countRuleSchema
}).strict();

export const pollDefinitionSchema = z.discriminatedUnion('purpose', [
  decidePollDefinitionSchema,
  measurePollDefinitionSchema,
  countPollDefinitionSchema
]).superRefine((definition, ctx) => {
  if (definition.ballotDelivery === 'group' && definition.voterDisclosure === 'hidden') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Group ballot delivery cannot hide voter identities',
      path: ['voterDisclosure']
    });
  }
  if (definition.electorate.kind === 'actor' && definition.ballotDelivery !== 'private') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Actor-only electorates require private ballot delivery',
      path: ['ballotDelivery']
    });
  }
  const optionIds = definition.options.map((option) => option.id);
  const labels = definition.options.map((option) => option.label);
  const ordinals = definition.options.map((option) => option.ordinal);

  addDuplicateIssue(ctx, optionIds, ['options'], 'Option ids must be unique');
  addDuplicateIssue(ctx, labels, ['options'], 'Option labels must be unique');
  addDuplicateIssue(ctx, ordinals, ['options'], 'Option ordinals must be unique');

  const sortedOrdinals = [...ordinals].sort((left, right) => left - right);
  if (sortedOrdinals.some((ordinal, index) => ordinal !== index + 1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Option ordinals must be contiguous and start at 1',
      path: ['options']
    });
  }

  const wireValidation = validatePollContent(definition.question, labels);
  const renderedLabels = numberPollOptions(labels);
  if (!wireValidation.titleFits) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Question exceeds the WhatsApp poll title limit',
      path: ['question']
    });
  }
  if (!wireValidation.optionsFit) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'An option exceeds the rendered WhatsApp poll option limit',
      path: ['options']
    });
  }
  if (new Set(renderedLabels).size !== renderedLabels.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Rendered WhatsApp poll option labels must be unique',
      path: ['options']
    });
  }

  if (definition.purpose === 'count') {
    definition.options.forEach((option, index) => {
      if (option.numericValue === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Count options require numericValue',
          path: ['options', index, 'numericValue']
        });
      }
    });
  } else {
    definition.options.forEach((option, index) => {
      if (option.numericValue !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'numericValue is only valid for count polls',
          path: ['options', index, 'numericValue']
        });
      }
    });
  }

  if (definition.purpose !== 'decide') {
    return;
  }
  if (
    (definition.rule.kind === 'single_non_transferable'
      || definition.rule.kind === 'multiwinner_approval')
    && definition.rule.seats > definition.options.length
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Seats cannot exceed the number of options',
      path: ['rule', 'seats']
    });
  }
  if (definition.rule.kind === 'approve_reject') {
    const { approveOptionId, rejectOptionId } = definition.rule;
    if (definition.options.length !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Approve/reject polls require exactly two options',
        path: ['options']
      });
    }
    if (approveOptionId === rejectOptionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Approve and reject option ids must differ',
        path: ['rule']
      });
    }
    if (!optionIds.includes(approveOptionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Approve option must exist',
        path: ['rule', 'approveOptionId']
      });
    }
    if (!optionIds.includes(rejectOptionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Reject option must exist',
        path: ['rule', 'rejectOptionId']
      });
    }
  }
  if (definition.tiePolicy.kind === 'status_quo' && definition.rule.kind !== 'approve_reject') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'status_quo tie policy is only valid for approve/reject polls',
      path: ['tiePolicy']
    });
  }
});

export const pollElectorSchema = z.object({
  voterIdentityId: stableIdSchema,
  voterWid: z.string().trim().min(1).max(200),
  displayLabel: z.string().trim().min(1).max(500).optional()
}).strict();

export const pollBallotSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('transport_event'),
    waMessageId: stableIdSchema
  }).strict(),
  z.object({
    kind: z.literal('transport_readback'),
    readbackId: stableIdSchema
  }).strict(),
  z.object({
    kind: z.literal('service_resolution'),
    resolutionId: stableIdSchema
  }).strict()
]);

export const pollBallotSchema = z.object({
  roundId: stableIdSchema,
  voterIdentityId: stableIdSchema,
  voterWid: z.string().trim().min(1).max(200),
  selectedOptionIds: z.array(stableIdSchema).max(WHATSAPP_POLL_MAX_OPTIONS)
    .refine((ids) => new Set(ids).size === ids.length, 'Selected option ids must be unique'),
  source: pollBallotSourceSchema,
  interactedAt: isoTimestampSchema
}).strict();

export const pollReadbackBallotSchema = z.object({
  voterIdentityId: stableIdSchema,
  voterWid: z.string().trim().min(1).max(200),
  selectedOptionIds: z.array(stableIdSchema).max(WHATSAPP_POLL_MAX_OPTIONS)
    .refine((ids) => new Set(ids).size === ids.length, 'Selected option ids must be unique'),
  interactedAt: isoTimestampSchema
}).strict();

export const pollOptionTallySchema = z.object({
  optionId: stableIdSchema,
  count: z.number().int().min(0),
  respondentShareBasisPoints: basisPointsSchema
}).strict();

const resultBase = {
  schemaVersion: z.literal(POLL_ASSISTANT_SCHEMA_VERSION),
  pollId: stableIdSchema,
  roundId: stableIdSchema,
  computedAt: isoTimestampSchema,
  cutoffAt: isoTimestampSchema,
  eligibleCount: z.number().int().min(0),
  responseCount: z.number().int().min(0),
  turnoutBasisPoints: basisPointsSchema,
  quorum: pollQuorumSchema,
  quorumMet: z.boolean(),
  tallies: z.array(pollOptionTallySchema)
} as const;

const quorumNotMetOutcomeSchema = z.object({ status: z.literal('quorum_not_met') }).strict();

export const decidePollResultSchema = z.object({
  ...resultBase,
  purpose: z.literal('decide'),
  outcome: z.union([
    quorumNotMetOutcomeSchema,
    z.object({
      status: z.literal('selected'),
      selectedOptionIds: z.array(stableIdSchema).min(1)
    }).strict(),
    z.object({
      status: z.literal('tie'),
      certainOptionIds: z.array(stableIdSchema),
      tiedOptionIds: z.array(stableIdSchema).min(2),
      remainingSeats: z.number().int().min(1)
    }).strict(),
    z.object({
      status: z.literal('no_decision'),
      reason: z.literal('tie'),
      certainOptionIds: z.array(stableIdSchema),
      tiedOptionIds: z.array(stableIdSchema).min(2),
      remainingSeats: z.number().int().min(1)
    }).strict()
  ])
}).strict();

export const measurePollResultSchema = z.object({
  ...resultBase,
  purpose: z.literal('measure'),
  outcome: z.union([
    quorumNotMetOutcomeSchema,
    z.object({
      status: z.literal('measured'),
      analysis: z.union([
        z.object({ kind: z.literal('distribution') }).strict(),
        z.object({
          kind: z.literal('ordered_scale'),
          medianOptionIds: z.array(stableIdSchema).max(2),
          modeOptionIds: z.array(stableIdSchema)
        }).strict()
      ])
    }).strict()
  ])
}).strict();

export const countPollResultSchema = z.object({
  ...resultBase,
  purpose: z.literal('count'),
  outcome: z.union([
    quorumNotMetOutcomeSchema,
    z.object({
      status: z.literal('counted'),
      total: safeIntegerSchema,
      unit: countUnitSchema
    }).strict()
  ])
}).strict();

export const pollResultSchema = z.discriminatedUnion('purpose', [
  decidePollResultSchema,
  measurePollResultSchema,
  countPollResultSchema
]);

export type PollOption = z.infer<typeof pollOptionSchema>;
export type PollDefinition = z.infer<typeof pollDefinitionSchema>;
export type DecidePollDefinition = z.infer<typeof decidePollDefinitionSchema>;
export type MeasurePollDefinition = z.infer<typeof measurePollDefinitionSchema>;
export type CountPollDefinition = z.infer<typeof countPollDefinitionSchema>;
export type PollElector = z.infer<typeof pollElectorSchema>;
export type PollBallotDelivery = z.infer<typeof pollBallotDeliverySchema>;
export type PollVoterDisclosure = z.infer<typeof pollVoterDisclosureSchema>;
export type PollBallot = z.infer<typeof pollBallotSchema>;
export type PollReadbackBallot = z.infer<typeof pollReadbackBallotSchema>;
export type PollOptionTally = z.infer<typeof pollOptionTallySchema>;
export type DecidePollResult = z.infer<typeof decidePollResultSchema>;
export type MeasurePollResult = z.infer<typeof measurePollResultSchema>;
export type CountPollResult = z.infer<typeof countPollResultSchema>;
export type PollResult = z.infer<typeof pollResultSchema>;

export function pollAllowsMultipleAnswers(definition: PollDefinition): boolean {
  if (definition.purpose === 'measure') {
    return definition.rule.kind === 'distribution' && definition.rule.allowMultipleAnswers;
  }
  return definition.purpose === 'decide'
    && (definition.rule.kind === 'approval' || definition.rule.kind === 'multiwinner_approval');
}

function addDuplicateIssue(
  ctx: z.RefinementCtx,
  values: readonly (string | number)[],
  path: (string | number)[],
  message: string
): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  }
}
