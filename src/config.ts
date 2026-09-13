import { pollMessageSettingsSchema, validatePollMessageSettings } from './templates';
import { z } from 'zod';
import { pollOutcomePresetSchema } from './outcomeConfig';
import { pollAssistantWorkingHoursSchema } from './workingHours';

const pollCreationFieldModeSchema = z.enum(['ask', 'suggest', 'fixed']);
const pollPurposeSchema = z.enum(['decide', 'measure', 'count']);

const pollPurposePolicySchema = z.object({
  mode: pollCreationFieldModeSchema.default('ask'),
  value: pollPurposeSchema.default('decide')
}).strict().default({});

const pollDecideRulePolicySchema = z.object({
  mode: pollCreationFieldModeSchema.default('ask'),
  kind: z.enum([
    'plurality',
    'single_non_transferable',
    'approval',
    'multiwinner_approval',
    'approve_reject'
  ]).default('plurality'),
  seats: z.number().int().min(1).max(12).default(1),
  minimumApprovalBasisPoints: z.number().int().min(5_001).max(10_000).default(5_001)
}).strict().default({});

const pollMeasureRulePolicySchema = z.object({
  mode: pollCreationFieldModeSchema.default('ask'),
  kind: z.enum([
    'distribution_single',
    'distribution_multiple',
    'ordered_scale'
  ]).default('distribution_single')
}).strict().default({});

const pollCountUnitPolicySchema = z.object({
  mode: pollCreationFieldModeSchema.default('ask'),
  value: z.string().trim().min(1).max(100).default('items')
}).strict().default({});

const pollClosingPolicySchema = z.object({
  mode: pollCreationFieldModeSchema.default('ask'),
  kind: z.enum(['duration', 'after_first_non_creator_response', 'manual']).default('duration'),
  durationMinutes: z.number().int().min(1).max(31 * 24 * 60).default(24 * 60),
  activationTimeoutMinutes: z.number().int().min(1).max(31 * 24 * 60).optional()
}).strict().default({});

const pollQuorumPolicySchema = z.object({
  mode: pollCreationFieldModeSchema.default('ask'),
  kind: z.enum(['none', 'absolute', 'percentage']).default('none'),
  minimumResponses: z.number().int().min(1).max(100_000).default(1),
  minimumTurnoutBasisPoints: z.number().int().min(1).max(10_000).default(5_000)
}).strict().default({});

const pollTiePolicyPolicySchema = z.object({
  mode: pollCreationFieldModeSchema.default('ask'),
  kind: z.enum(['no_decision', 'authorized_choice', 'status_quo', 'random_draw'])
    .default('no_decision')
}).strict().default({});

const pollBallotDeliveryPolicySchema = z.object({
  mode: pollCreationFieldModeSchema.default('ask'),
  value: z.enum(['group', 'private']).default('group')
}).strict().default({});

const pollVoterDisclosurePolicySchema = z.object({
  mode: pollCreationFieldModeSchema.default('ask'),
  value: z.enum(['named', 'hidden']).default('named')
}).strict().default({});

export const pollCreationPresetSchema = z.object({
  outcome: pollOutcomePresetSchema.optional(),
  id: z.string().trim().min(1).max(64).regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    'Preset IDs may contain lowercase letters, numbers, dots, underscores, and hyphens'
  ),
  label: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  purpose: pollPurposePolicySchema,
  decideRule: pollDecideRulePolicySchema,
  measureRule: pollMeasureRulePolicySchema,
  countUnit: pollCountUnitPolicySchema,
  closing: pollClosingPolicySchema,
  quorum: pollQuorumPolicySchema,
  tiePolicy: pollTiePolicyPolicySchema,
  ballotDelivery: pollBallotDeliveryPolicySchema,
  voterDisclosure: pollVoterDisclosurePolicySchema
}).strict().superRefine((preset, ctx) => {
  if (
    preset.tiePolicy.mode === 'fixed'
    && preset.tiePolicy.kind === 'status_quo'
    && (preset.decideRule.mode !== 'fixed' || preset.decideRule.kind !== 'approve_reject')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A fixed status-quo tie policy requires a fixed approve/reject rule',
      path: ['tiePolicy', 'kind']
    });
  }
  if (
    preset.ballotDelivery.mode === 'fixed'
    && preset.ballotDelivery.value === 'group'
    && preset.voterDisclosure.mode === 'fixed'
    && preset.voterDisclosure.value === 'hidden'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A fixed group ballot cannot use hidden voter disclosure',
      path: ['voterDisclosure', 'value']
    });
  }
});

export type PollCreationPreset = z.infer<typeof pollCreationPresetSchema>;
export type PollCreationFieldMode = z.infer<typeof pollCreationFieldModeSchema>;

const ianaTimezoneSchema = z.string().trim().min(1).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, 'Must be a valid IANA timezone');

const pollAssistantConfigObjectSchema = z.object({
  messages: pollMessageSettingsSchema,
  allowCreation: z.boolean().default(true),
  allowMemberCreation: z.boolean().default(true),
  timezone: ianaTimezoneSchema.default('UTC'),
  defaultClosingMode: z.enum(['deadline', 'after_first_non_creator_response', 'manual']).default('deadline'),
  defaultDeadlineMinutes: z.number().int().min(1).max(31 * 24 * 60).default(24 * 60),
  defaultActivationTimeoutMinutes: z.number().int().min(1).max(31 * 24 * 60).default(120),
  maxDeadlineMinutes: z.number().int().min(1).max(31 * 24 * 60).default(31 * 24 * 60),
  defaultQuorumMode: z.enum(['none', 'absolute', 'percentage']).default('none'),
  defaultAbsoluteQuorumResponses: z.number().int().min(1).max(100_000).default(1),
  defaultPercentageQuorumBasisPoints: z.number().int().min(1).max(10_000).default(5_000),
  maxActivePollsPerChat: z.number().int().min(1).max(100).default(20),
  maxPrivateElectorateSize: z.number().int().min(1).max(250).default(250),
  ballotRetentionDays: z.number().int().min(1).max(3_650).default(90),
  assistantExposeProvisionalResults: z.boolean().default(false),
  automationWorkingHours: pollAssistantWorkingHoursSchema,
  creationPresets: z.array(pollCreationPresetSchema).max(20).default([])
}).strict().superRefine((config, ctx) => {
  if (config.defaultDeadlineMinutes > config.maxDeadlineMinutes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'defaultDeadlineMinutes cannot exceed maxDeadlineMinutes',
      path: ['defaultDeadlineMinutes']
    });
  }
  const presetIds = new Set<string>();
  let defaultCount = 0;
  config.creationPresets.forEach((preset, index) => {
    if (presetIds.has(preset.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate creation preset id ${preset.id}`,
        path: ['creationPresets', index, 'id']
      });
    }
    presetIds.add(preset.id);
    if (preset.enabled && preset.isDefault) {
      defaultCount += 1;
    }
    if (preset.closing.durationMinutes > config.maxDeadlineMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Preset duration cannot exceed maxDeadlineMinutes',
        path: ['creationPresets', index, 'closing', 'durationMinutes']
      });
    }
  });
  if (defaultCount > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'At most one enabled creation preset may be the default',
      path: ['creationPresets']
    });
  }
});

export const pollAssistantRuntimeConfigSchema = pollAssistantConfigObjectSchema.default({});
// Do not introduce the new messages field into legacy stored configurations during reader rollout.
// Settings accepted by the forward release remain readable and are preserved on later saves.
export const pollAssistantConfigSchema = pollAssistantConfigObjectSchema.innerType()
  .extend({ messages: pollMessageSettingsSchema.optional() }).superRefine((config, ctx) => {
    const parsed = pollAssistantRuntimeConfigSchema.safeParse(config);
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue(issue);
    if (config.messages !== undefined) validatePollMessageSettings(config.messages, ctx);
  }).default({});

export type PollAssistantConfig = z.infer<typeof pollAssistantRuntimeConfigSchema>;

export function parsePollAssistantConfig(input: unknown): PollAssistantConfig {
  return pollAssistantRuntimeConfigSchema.parse(input ?? {});
}
