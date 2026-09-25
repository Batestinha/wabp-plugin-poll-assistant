import { pollTemplateDefinitions, pollTemplateFields, pollValueTemplateDefinition, type PollTemplateKind, POLL_TEMPLATE_MAX_LENGTH } from './templates';
import { defineControl } from '@wabs/plugin-sdk/controls';
import type {
  ControlDescriptor,
  ControlSchemaMetadata,
  ControlUiHint
} from '@wabs/plugin-sdk/controls-types';
import { POLL_ASSISTANT_PLUGIN_ID } from './database';

const POLL_COMMANDS = [
  '/poll',
  '/poll create',
  '/poll list',
  '/poll status',
  '/poll open',
  '/poll close',
  '/poll cancel',
  '/poll resolve'
] as const;

function control(
  path: string,
  label: string,
  description: string,
  order: number,
  schema: ControlSchemaMetadata,
  ui: ControlUiHint,
  section = 'Poll Assistant'
): ControlDescriptor {
  return defineControl({
    id: `plugin.official.poll-assistant.${path}`,
    label,
    description,
    plane: 'plugin-scope-config',
    domain: 'official-plugin-settings',
    section,
    order,
    visibility: 'bot_admin',
    configurable: true,
    storage: { kind: 'plugin-scope-config', pluginId: POLL_ASSISTANT_PLUGIN_ID, path },
    schema,
    ui: { helpText: description, ...ui },
    restartRequirement: 'NO_RESTART',
    dangerous: false,
    sensitivity: { sensitive: false, redact: 'none' },
    auditAction: 'operator_console.plugin_config.update',
    relatedCommandIds: [...POLL_COMMANDS],
    relatedActionIds: []
  });
}

const CLOSING_MODE_OPTIONS = [
  { value: 'deadline', label: 'Deadline' },
  { value: 'after_first_non_creator_response', label: 'After first response' },
  { value: 'manual', label: 'Manual close' }
];

const QUORUM_MODE_OPTIONS = [
  { value: 'none', label: 'No minimum' },
  { value: 'absolute', label: 'Respondent count' },
  { value: 'percentage', label: 'Electorate percentage' }
];

const TEMPLATE_DESCRIPTIONS: Record<PollTemplateKind, string> = {
  publication: 'Group introduction sent before the native poll. It explains the question, choices, voting rules, and ballot delivery.',
  publicationOption: 'Formats one choice in the group introduction sent before the native poll.',
  proposalOption: 'Formats one choice in the private approval proposal from the natural-language assistant.',
  assistantProposal: 'Full private approval summary for a natural-language poll request. The rendered text is saved with the approval and shows every resolved setting.',
  activation: 'Separate group notice when the first response starts a poll closing timer. Sent only when Announce activation is enabled.',
  closedPublication: 'Replacement text for the original group introduction after closing. Used only when Edit publication when the poll closes is enabled and WhatsApp still allows the edit.',
  result: 'Final result message sent to the group after authoritative vote readback. Includes the outcome and the formatted result rows.',
  resultOption: 'Formats one choice in the final result message, including its count, percentages, and voter names when disclosure is named.',
  selected: 'Outcome line in the final result when a decision poll selects its winner without a random draw.',
  selectedByRandomDraw: 'Outcome line in the final result when the configured random tie-break selects a winner.',
  tie: 'Outcome line in the result when a decision poll has a tie that still needs resolution.',
  noDecision: 'Outcome line in the final result when a decision poll closes without a selected winner.',
  quorumNotMet: 'Outcome line in the final result when the poll does not reach its minimum turnout.',
  measuredDistribution: 'Outcome line in the final result for a response-distribution measurement poll.',
  measuredScale: 'Outcome line in the final result for an ordered-scale measurement poll, including median and mode.',
  counted: 'Outcome line in the final result for a count poll, including the summed total and unit.',
  tieResolved: 'Separate group notice sent after an authorized person resolves a tied decision poll.'
};

export const pollAssistantControls: ControlDescriptor[] = [
  control('pinActivePolls', 'Pin active polls', 'Pin group polls while voting is open and unpin them when voting closes. Private ballots use the group publication. Turning this off also removes pins managed by this plugin.', 330, { type: 'boolean' }, { widget: 'toggle' }, 'Publishing and voting'),
  control('editPublicationOnClose', 'Edit publication when the poll closes', 'Replace the original publication text using the template below. WhatsApp only permits edits within 15 minutes of sending; older publications stay unchanged and results are still sent normally.', 405, { type: 'boolean' }, { widget: 'toggle' }, 'Closing and results'),
  ...Object.entries(pollTemplateDefinitions).map(([kind, definition], index) => control(
    `messages.${kind}`, definition.title,
    TEMPLATE_DESCRIPTIONS[kind as PollTemplateKind],
    kind === 'proposalOption' ? 190 : kind === 'assistantProposal' ? 200
      : ['publication', 'publicationOption', 'activation'].includes(kind) ? 340 + index
        : kind === 'closedPublication' ? 410 : kind === 'tieResolved' ? 420 : 450 + index,
    { type: 'string', max: POLL_TEMPLATE_MAX_LENGTH },
    {
      widget: 'text', multiline: true,
      templateDialect: 'conditional-values-v2', templateActivation: 'always', templateEmptyResult: 'reject',
      templateVariables: pollTemplateFields(kind as PollTemplateKind),
      templateConditionVariables: pollTemplateFields(kind as PollTemplateKind),
      templateMentions: pollValueTemplateDefinition(kind as PollTemplateKind).mentions,
      templateDefaultFragment: true,
      placeholder: definition.source
    },
    ['proposalOption', 'assistantProposal'].includes(kind) ? 'Creation'
      : ['publication', 'publicationOption', 'activation'].includes(kind) ? 'Publishing and voting'
        : ['closedPublication', 'tieResolved'].includes(kind) ? 'Closing' : 'Results'
  )),
  control('messages.activationEnabled', 'Announce activation', 'Send a separate closing-time announcement after activation. New announcements are disabled by default.', 344, { type: 'boolean' }, { widget: 'toggle' }, 'Publishing and voting'),
  control(
    'allowCreation',
    'Accept new polls',
    'Allow new Poll Assistant setup flows in this scope; committed poll lifecycles continue until terminal.',
    10,
    { type: 'boolean' },
    { widget: 'toggle' },
    'Access'
  ),
  control(
    'allowMemberCreation',
    'Members may create polls',
    'Allow current managed-group members to start polls without a separate polls.create grant.',
    20,
    { type: 'boolean' },
    { widget: 'toggle' },
    'Access'
  ),
  control(
    'timezone',
    'Timezone',
    'IANA timezone used to display poll deadlines and results.',
    100,
    { type: 'string', format: 'timezone', required: true },
    { widget: 'select' },
    'Creation'
  ),
  control(
    'creationPresets',
    'Creation presets',
    'Configure named policies for guided /poll setup and natural-language proposals. In chat, fixed fields are skipped and suggested fields are offered first. When a proposal omits a field, its preset operator value is proposed.',
    180,
    { type: 'array', items: { type: 'object' } },
    {
      widget: 'builder',
      builderId: 'official.poll-assistant.creation-presets.v1',
      builderEndpoints: { actions: '/api/v1/operator-console/workflow-actions' }
    },
    'Creation'
  ),
  control(
    'automationWorkingHours.enabled',
    'Enforce automation working hours',
    'Gate automated poll publication and first-response activation to the configured weekly windows. Manual polls are unaffected.',
    500,
    { type: 'boolean' },
    { widget: 'toggle' },
    'Automation'
  ),
  control(
    'automationWorkingHours.windows',
    'Automation working-hours windows',
    'Weekly local-time windows that gate automated poll publication and first-response activation. Multiple and overnight windows are supported.',
    510,
    { type: 'array', items: { type: 'object' } },
    { widget: 'builder', builderId: 'official.poll-assistant.working-hours.v1' },
    'Automation'
  ),
  control(
    'defaultClosingMode',
    'Default closing mode',
    'Closing choice shown first in guided setup and used for omitted assistant proposal settings when no preset is selected.',
    110,
    { type: 'enum', enum: CLOSING_MODE_OPTIONS },
    { widget: 'segmented', options: CLOSING_MODE_OPTIONS },
    'Creation'
  ),
  control(
    'defaultDeadlineMinutes',
    'Default duration',
    'Default number of minutes a deadline poll remains open after publication.',
    120,
    { type: 'number', unit: 'minutes', min: 1, max: 44_640 },
    { widget: 'duration' },
    'Creation'
  ),
  control(
    'maxDeadlineMinutes',
    'Maximum duration',
    'Maximum number of minutes allowed between publication and a configured deadline.',
    620,
    { type: 'number', unit: 'minutes', min: 1, max: 44_640 },
    { widget: 'duration' },
    'Limits and retention'
  ),
  control(
    'defaultActivationTimeoutMinutes',
    'Default activation timeout',
    'Minutes after publication before a first-response poll promotes a creator ballot or finalizes with no response.',
    130,
    { type: 'number', unit: 'minutes', min: 1, max: 44_640 },
    { widget: 'duration' },
    'Creation'
  ),
  control(
    'defaultQuorumMode',
    'Default turnout rule',
    'Minimum-turnout choice shown first in guided setup and used for omitted assistant proposal settings when no preset is selected.',
    140,
    { type: 'enum', enum: QUORUM_MODE_OPTIONS },
    { widget: 'segmented', options: QUORUM_MODE_OPTIONS },
    'Creation'
  ),
  control(
    'defaultAbsoluteQuorumResponses',
    'Default respondent count',
    'Default minimum respondent count when count-based turnout is selected.',
    150,
    { type: 'number', unit: 'items', min: 1, max: 100_000 },
    { widget: 'number' },
    'Creation'
  ),
  control(
    'defaultPercentageQuorumBasisPoints',
    'Default turnout basis points',
    'Default electorate percentage in basis points when percentage turnout is selected; 5000 means 50%.',
    160,
    { type: 'number', min: 1, max: 10_000 },
    { widget: 'number' },
    'Creation'
  ),
  control(
    'maxActivePollsPerChat',
    'Active poll limit',
    'Maximum number of active or tie-pending polls allowed in one originating chat.',
    600,
    { type: 'number', unit: 'items', min: 1, max: 100 },
    { widget: 'number' },
    'Limits and retention'
  ),
  control(
    'ballotRetentionDays',
    'Ballot retention',
    'Days to retain Poll Assistant voter-level working data after terminal delivery. The independent chat archive follows its own retention policy; aggregate results remain stored.',
    630,
    { type: 'number', unit: 'days', min: 1, max: 3_650 },
    { widget: 'duration' },
    'Limits and retention'
  ),
  control(
    'maxPrivateElectorateSize',
    'Private ballot electorate limit',
    'Maximum eligible voters for a private multi-recipient poll. The platform limit is 250.',
    610,
    { type: 'number', unit: 'items', min: 1, max: 250 },
    { widget: 'number' },
    'Limits and retention'
  ),
  control(
    'assistantExposeProvisionalResults',
    'Assistant may show live tallies',
    'Allow the natural-language assistant to expose aggregate event-derived tallies for open polls. These results are explicitly provisional; finalized results always use authoritative WhatsApp readback.',
    30,
    { type: 'boolean' },
    { widget: 'toggle' },
    'Access'
  )
];
