import { z } from 'zod';

export const DOAS_POLL_SERVICE_ID = 'official.doas.poll.v1';
export const DOAS_POLL_PUBLISH_METHOD = 'publish';
export const DOAS_POLL_PUBLISH_TIMEOUT_MS = 90_000;
export const DOAS_POLL_RECONCILE_METHOD = 'reconcilePoll';
export const DOAS_POLL_RECONCILE_TIMEOUT_MS = 45_000;
export const DOAS_PRIVATE_POLL_SERVICE_ID = 'official.doas.private-poll.v1';
export const DOAS_PRIVATE_POLL_PUBLISH_METHOD = 'publish';
export const DOAS_PRIVATE_POLL_PUBLISH_TIMEOUT_MS = 90_000;
export const DOAS_PRIVATE_POLL_RECONCILE_METHOD = 'reconcilePoll';
export const DOAS_PRIVATE_POLL_RECONCILE_TIMEOUT_MS = 45_000;
export const DOAS_PRIVATE_POLL_RELEASE_METHOD = 'releasePoll';
export const DOAS_PRIVATE_POLL_RELEASE_TIMEOUT_MS = 45_000;
export const DOAS_PRIVATE_POLL_SENDS_PER_MINUTE = 30;
export const DOAS_POLL_IDEMPOTENCY_KEY_MAX_BYTES = 512;

const doasPollIdempotencyKeySchema = z.string()
  .trim()
  .min(1)
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= DOAS_POLL_IDEMPOTENCY_KEY_MAX_BYTES,
    `Idempotency key must not exceed ${DOAS_POLL_IDEMPOTENCY_KEY_MAX_BYTES} UTF-8 bytes.`
  );

export const doasPollPublishInputSchema = z.object({
  groupWid: z.string().trim().min(1),
  question: z.string().trim().min(1),
  options: z.array(z.string().trim().min(1)).min(1),
  allowMultipleAnswers: z.boolean().optional(),
  idempotencyKey: doasPollIdempotencyKeySchema.optional(),
  notAfter: z.string().datetime({ offset: true }).optional(),
  reason: z.string().trim().min(1).optional(),
  sourcePluginId: z.string().trim().min(1).max(200).optional(),
  historyHoldOwner: z.string().trim().min(1).max(200).optional()
}).strict().superRefine((input, ctx) => {
  if (input.historyHoldOwner && !input.idempotencyKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A poll history hold requires an idempotency key.',
      path: ['historyHoldOwner']
    });
  }
  if (input.historyHoldOwner && input.historyHoldOwner !== input.sourcePluginId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A poll history hold must be owned by the source plugin.',
      path: ['historyHoldOwner']
    });
  }
});

export const doasPollPublishOutputSchema = z.object({
  messageId: z.string().optional(),
  remoteChatId: z.string().optional(),
  acceptedAt: z.string().datetime({ offset: true }).optional(),
  ack: z.number().optional(),
  addressMode: z.enum(['pn', 'lid', 'direct']).optional(),
  deliveryChatId: z.string().optional(),
  attempts: z.array(z.object({
    addressMode: z.enum(['pn', 'lid', 'direct']),
    chatId: z.string(),
    messageId: z.string().optional(),
    remoteChatId: z.string().optional(),
    ack: z.number().optional(),
    error: z.string().optional()
  }).strict()).optional(),
  privateDeliveryFallback: z.object({
    chatId: z.string(),
    mentionedWids: z.array(z.string()),
    reason: z.string(),
    quotePolicy: z.unknown().optional(),
    quotedMessageId: z.string().optional()
  }).strict().optional()
}).strict();

export const doasPollReconcileInputSchema = z.object({
  groupWid: z.string().trim().min(1),
  idempotencyKey: doasPollIdempotencyKeySchema
}).strict();

export const doasPollReconcileOutputSchema = z.object({
  status: z.enum(['found', 'absent', 'unknown']),
  providerId: z.string().trim().min(1),
  messageId: z.string().trim().min(1).optional(),
  remoteChatId: z.string().trim().min(1).optional(),
  acceptedAt: z.string().datetime({ offset: true }).optional()
}).strict().superRefine((receipt, ctx) => {
  if (receipt.status === 'found' && (!receipt.messageId || !receipt.acceptedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A found poll receipt requires messageId and acceptedAt.'
    });
  }
});

const doasPrivatePollRecipientSchema = z.object({
  groupWid: z.string().trim().min(1),
  recipientIdentityId: z.string().trim().min(1).max(200),
  recipientDeliveryChatId: z.string().trim().min(1).max(200),
  idempotencyKey: doasPollIdempotencyKeySchema
});

export const doasPrivatePollPublishInputSchema = doasPrivatePollRecipientSchema.extend({
  question: z.string().trim().min(1),
  options: z.array(z.string().trim().min(1)).min(1),
  allowMultipleAnswers: z.boolean().optional(),
  notAfter: z.string().datetime({ offset: true }).optional(),
  reason: z.string().trim().min(1).optional()
}).strict();

export const doasPrivatePollPublishOutputSchema = doasPollPublishOutputSchema;

export const doasPrivatePollReconcileInputSchema = doasPrivatePollRecipientSchema.strict();
export const doasPrivatePollReconcileOutputSchema = doasPollReconcileOutputSchema;

export const doasPrivatePollReleaseInputSchema = doasPrivatePollRecipientSchema.strict();
export const doasPrivatePollReleaseOutputSchema = z.object({
  released: z.boolean()
}).strict();

export type DoasPollPublishInput = z.infer<typeof doasPollPublishInputSchema>;
export type DoasPollPublishOutput = z.infer<typeof doasPollPublishOutputSchema>;
export type DoasPollReconcileInput = z.infer<typeof doasPollReconcileInputSchema>;
export type DoasPollReconcileOutput = z.infer<typeof doasPollReconcileOutputSchema>;
export type DoasPrivatePollPublishInput = z.infer<typeof doasPrivatePollPublishInputSchema>;
export type DoasPrivatePollPublishOutput = z.infer<typeof doasPrivatePollPublishOutputSchema>;
export type DoasPrivatePollReconcileInput = z.infer<typeof doasPrivatePollReconcileInputSchema>;
export type DoasPrivatePollReconcileOutput = z.infer<typeof doasPrivatePollReconcileOutputSchema>;
export type DoasPrivatePollReleaseInput = z.infer<typeof doasPrivatePollReleaseInputSchema>;
export type DoasPrivatePollReleaseOutput = z.infer<typeof doasPrivatePollReleaseOutputSchema>;
