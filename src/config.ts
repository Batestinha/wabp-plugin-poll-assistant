import { z } from 'zod';

const ianaTimezoneSchema = z.string().trim().min(1).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, 'Must be a valid IANA timezone');

const pollAssistantConfigObjectSchema = z.object({
  allowCreation: z.boolean().default(true),
  allowMemberCreation: z.boolean().default(true),
  timezone: ianaTimezoneSchema.default('UTC'),
  defaultClosingMode: z.enum(['deadline', 'manual']).default('deadline'),
  defaultDeadlineMinutes: z.number().int().min(1).max(31 * 24 * 60).default(24 * 60),
  maxDeadlineMinutes: z.number().int().min(1).max(31 * 24 * 60).default(31 * 24 * 60),
  defaultQuorumMode: z.enum(['none', 'absolute', 'percentage']).default('none'),
  defaultAbsoluteQuorumResponses: z.number().int().min(1).max(100_000).default(1),
  defaultPercentageQuorumBasisPoints: z.number().int().min(1).max(10_000).default(5_000),
  maxActivePollsPerChat: z.number().int().min(1).max(100).default(20),
  ballotRetentionDays: z.number().int().min(1).max(3_650).default(90)
}).strict().superRefine((config, ctx) => {
  if (config.defaultDeadlineMinutes > config.maxDeadlineMinutes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'defaultDeadlineMinutes cannot exceed maxDeadlineMinutes',
      path: ['defaultDeadlineMinutes']
    });
  }
});

export const pollAssistantConfigSchema = pollAssistantConfigObjectSchema.default({});

export type PollAssistantConfig = z.infer<typeof pollAssistantConfigSchema>;

export function parsePollAssistantConfig(input: unknown): PollAssistantConfig {
  return pollAssistantConfigSchema.parse(input ?? {});
}
