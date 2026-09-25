import { z } from 'zod';
import type { WorkflowActionDeclaration } from '@wabs/plugin-sdk/workflows';
import { workflowProgramSchema } from '@wabs/plugin-sdk/workflows';
import { pollDefinitionSchema } from './domain';

export const POLL_CREATE_ACTION_SERVICE = 'official.poll-assistant.create-action.v1';
export const pollCreateActionInputSchema = z.object({
  groupWid: z.string().min(1), definition: pollDefinitionSchema,
  outcome: z.object({ policy: z.enum(['automatic', 'requester_confirmation']), program: workflowProgramSchema }).strict().optional()
}).strict();
export const pollCreateActionDraftInputSchema = z.object({
  groupWid: z.string().min(1),
  definition: z.record(z.unknown()),
  presetId: z.string().trim().min(1).optional(),
  outcome: pollCreateActionInputSchema.shape.outcome
}).strict();
export const pollCreateAction: WorkflowActionDeclaration = {
  actionId: 'official.poll-assistant.create', version: 1, sources: ['assistant'],
  titleKey: 'official.poll-assistant.outcome.createTitle', descriptionKey: 'official.poll-assistant.outcome.createDescription',
  serviceId: POLL_CREATE_ACTION_SERVICE, methods: { describe: 'describe', prepare: 'prepare', execute: 'execute', inspect: 'inspect' },
  requiredPermissions: [], requiredBotCapabilities: ['botIsAdmin', 'canSend'],
  inputSchema: { type: 'object', required: ['groupWid', 'definition'], additionalProperties: false, properties: {
    groupWid: { type: 'string', title: 'Group' },
    presetId: { type: 'string', description: 'Optional enabled creation preset ID. The scope default preset is used when omitted.' },
    definition: { type: 'object', description: 'Poll definition schema version 1. Use id "draft" and stable option IDs option:1, option:2, etc. Omitted settings resolve from the selected or scoped default creation preset.',
      required: ['purpose', 'question', 'options'],
      properties: { schemaVersion: { const: 1 }, id: { type: 'string' }, purpose: { enum: ['decide', 'measure', 'count'] }, question: { type: 'string' },
        options: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'object', required: ['id', 'label', 'ordinal'], properties: {
          id: { type: 'string' }, label: { type: 'string' }, ordinal: { type: 'integer' }, numericValue: { type: 'integer', minimum: 1 } } } },
        closing: { type: 'object', description: 'kind manual, or kind deadline with deadline: {mode:after_publish,durationMinutes} / {mode:at,closesAt ISO timestamp} / {mode:after_first_non_creator_response,durationMinutes,activationTimeoutMinutes}' },
        quorum: { type: 'object', description: 'kind none, absolute with minimumResponses, or percentage with minimumTurnoutBasisPoints' },
        electorate: { type: 'object', properties: { kind: { enum: ['members_at_publication', 'group_members_until_cutoff'] } } },
        ballotDelivery: { enum: ['group', 'private'] }, voterDisclosure: { enum: ['named', 'hidden'] },
        rule: { type: 'object', description: 'decide: plurality, approval, single_non_transferable or multiwinner_approval with seats, approve_reject with approveOptionId/rejectOptionId/minimumApprovalBasisPoints; measure: distribution with allowMultipleAnswers or ordered_scale; count: sum with unit' },
        tiePolicy: { type: 'object', properties: { kind: { enum: ['no_decision', 'authorized_choice', 'status_quo', 'random_draw'] } } } } },
    outcome: { type: 'object', required: ['policy', 'program'], properties: { policy: { enum: ['automatic', 'requester_confirmation'] },
      program: { type: 'object', description: 'Version 1 workflow graph. Each node has id, actionId, version, input, conditions, bindings and dependsOn. Use only declared poll_outcome actions. Option references use stable definition option IDs.' } } }
  } }, outputSchema: { type: 'object', properties: { pollId: { type: 'string' }, roundId: { type: 'string' }, messageId: { type: 'string' } } }
};
