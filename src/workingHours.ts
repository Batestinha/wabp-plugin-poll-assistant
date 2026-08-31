import { z } from 'zod';

export const pollAssistantWeekdaySchema = z.number().int().min(0).max(6);
export const pollAssistantLocalTimeSchema = z.string().regex(
  /^([01]\d|2[0-3]):[0-5]\d$/,
  'Expected a local time in HH:mm format'
);

export const pollAssistantWorkingHoursWindowSchema = z.object({
  days: z.array(pollAssistantWeekdaySchema).min(1).max(7)
    .refine((days) => new Set(days).size === days.length, 'Window days must be unique'),
  start: pollAssistantLocalTimeSchema,
  end: pollAssistantLocalTimeSchema
}).strict().refine((window) => window.start !== window.end, {
  message: 'A working-hours window must not span a full day',
  path: ['end']
});

export const pollAssistantWorkingHoursSchema = z.object({
  enabled: z.boolean().default(true),
  windows: z.array(pollAssistantWorkingHoursWindowSchema).min(1).max(28).default([
    { days: [0, 1, 2, 3, 4], start: '12:00', end: '23:00' },
    { days: [5, 6], start: '12:00', end: '01:00' }
  ])
}).strict().default({});

export type PollAssistantWorkingHours = z.infer<typeof pollAssistantWorkingHoursSchema>;

export const pollAssistantTimezoneSchema = z.string().trim().min(1).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, 'Must be a valid IANA timezone');

export const pollAssistantAutomationPolicySnapshotSchema = z.object({
  timezone: pollAssistantTimezoneSchema,
  workingHours: pollAssistantWorkingHoursSchema,
  bypassWorkingHours: z.boolean()
}).strict();

export type PollAssistantAutomationPolicySnapshot = z.infer<
  typeof pollAssistantAutomationPolicySnapshotSchema
>;

export function pollAssistantPolicyNotBefore(
  instant: Date,
  policy: PollAssistantAutomationPolicySnapshot,
  override = false
): Date {
  return policy.bypassWorkingHours || override
    ? instant
    : nextPollAssistantWorkingHoursOpening(instant, policy.timezone, policy.workingHours);
}

const WEEKDAY_BY_LABEL: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};
const localClockFormatters = new Map<string, Intl.DateTimeFormat>();

export function isWithinPollAssistantWorkingHours(
  instant: Date,
  timezone: string,
  schedule: PollAssistantWorkingHours
): boolean {
  if (!schedule.enabled) {
    return true;
  }
  const local = localClock(instant, timezone);
  return schedule.windows.some((window) => {
    const start = localMinutes(window.start);
    const end = localMinutes(window.end);
    if (start < end) {
      return window.days.includes(local.weekday)
        && local.minuteOfDay >= start
        && local.minuteOfDay < end;
    }
    if (local.minuteOfDay >= start && window.days.includes(local.weekday)) {
      return true;
    }
    const previousWeekday = (local.weekday + 6) % 7;
    return local.minuteOfDay < end && window.days.includes(previousWeekday);
  });
}

export function nextPollAssistantWorkingHoursOpening(
  instant: Date,
  timezone: string,
  schedule: PollAssistantWorkingHours
): Date {
  if (isWithinPollAssistantWorkingHours(instant, timezone, schedule)) {
    return instant;
  }
  const candidate = new Date(instant);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const searchLimit = 8 * 24 * 60 + 180;
  for (let minute = 0; minute < searchLimit; minute += 1) {
    if (isWithinPollAssistantWorkingHours(candidate, timezone, schedule)) {
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error('Poll Assistant working hours have no opening in the next eight days.');
}

function localClock(instant: Date, timezone: string): { weekday: number; minuteOfDay: number } {
  if (Number.isNaN(instant.getTime())) {
    throw new Error('A valid instant is required for working-hours evaluation.');
  }
  let formatter = localClockFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    localClockFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_BY_LABEL[values.get('weekday') ?? ''];
  const hour = Number(values.get('hour'));
  const minute = Number(values.get('minute'));
  if (weekday === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`Unable to resolve local time in ${timezone}.`);
  }
  return { weekday, minuteOfDay: hour * 60 + minute };
}

function localMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour! * 60 + minute!;
}
