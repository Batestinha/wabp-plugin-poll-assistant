import { z } from 'zod';
import { startOfScopeDate } from '@wabs/plugin-sdk/clock';
import type { PluginServiceDeclaration, PluginServiceRegistration } from '@wabs/plugin-sdk/services';
import type { PluginServiceRegistrationContext } from './runtime';
import { pollsDatabase, listPublicPollReadPage } from './store';

export const pollReadDeclaration: PluginServiceDeclaration = {
  serviceId: 'official.poll-assistant.assistant.v1',
  methods: [{ name: 'polls', access: 'read', assistantRead: {
    name: 'official.poll-assistant.polls', descriptionKey: 'official.poll-assistant.assistant.read.polls',
    allowScopeMembers: true, membership: 'current_group'
  } }]
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cursor = z.object({ timestamp: z.string().datetime({ offset: true }), id: z.string().min(1).max(128) }).strict();
const range = z.object({
  mode: z.enum(['open', 'history']),
  from: date.optional(), until: date.optional(),
  after: cursor.optional(),
  limit: z.number().int().min(1).max(25).default(10)
}).strict().refine(input => input.mode !== 'history' || Boolean(input.from && input.until && input.from < input.until),
  'History requires an increasing local date range.');
const inputSchema = {
  type: 'object', additionalProperties: false, required: ['mode'],
  properties: {
    mode: { type: 'string', enum: ['open', 'history'] },
    from: { type: 'string', description: 'Inclusive local date in YYYY-MM-DD format.' },
    until: { type: 'string', description: 'Exclusive local date in YYYY-MM-DD format.' },
    after: { type: 'object', additionalProperties: false, required: ['timestamp', 'id'],
      properties: { timestamp: { type: 'string' }, id: { type: 'string' } } },
    limit: { type: 'integer', minimum: 1, maximum: 25 }
  }
};

export function registerPollReads(context: PluginServiceRegistrationContext): PluginServiceRegistration {
  return { serviceId: pollReadDeclaration.serviceId, methods: [{
    name: 'polls', access: 'read', inputSchema: range,
    outputSchema: z.object({
      polls: z.array(z.object({ id: z.string(), question: z.string(), status: z.string(), createdAt: z.string() }).strict()),
      next: cursor.nullable(), timezone: z.string()
    }).strict(),
    assistantSchema: { input: inputSchema, output: { type: 'object' } },
    async handler(raw, call) {
      const input = range.parse(raw);
      const clock = await context.clockFor?.(call.scopeId, { scopeId: call.scopeId });
      if (!call.groupWid || !clock) throw new Error('A group and its community clock are required.');
      const rows = listPublicPollReadPage(pollsDatabase(context.databases), {
        scopeId: call.scopeId, chatId: call.groupWid, openOnly: input.mode === 'open',
        from: input.from ? startOfScopeDate(clock, input.from) : undefined,
        until: input.until ? startOfScopeDate(clock, input.until) : undefined,
        after: input.after, limit: input.limit + 1
      });
      const last = rows[input.limit - 1];
      return {
        polls: rows.slice(0, input.limit).map(poll => ({
          id: poll.id, question: poll.definition.question, status: poll.status, createdAt: poll.createdAt
        })),
        next: last && rows.length > input.limit ? { timestamp: last.createdAt, id: last.id } : null, timezone: clock.timezone
      };
    }
  }] };
}
