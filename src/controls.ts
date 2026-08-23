import { defineControl } from '../../../platform/operatorConsole/controlCatalog/define';
import type {
  ControlDescriptor,
  ControlSchemaMetadata,
  ControlUiHint
} from '../../../platform/operatorConsole/controlCatalog/types';
import { POLL_ASSISTANT_PLUGIN_ID } from './database';

const POLL_COMMANDS = [
  '/poll',
  '/poll create',
  '/poll list',
  '/poll status',
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
  { value: 'manual', label: 'Manual close' }
];

const QUORUM_MODE_OPTIONS = [
  { value: 'none', label: 'No minimum' },
  { value: 'absolute', label: 'Respondent count' },
  { value: 'percentage', label: 'Electorate percentage' }
];

export const pollAssistantControls: ControlDescriptor[] = [
  control(
    'allowCreation',
    'Accept new polls',
    'Allow new Poll Assistant setup flows in this scope; committed poll lifecycles continue until terminal.',
    10,
    { type: 'boolean' },
    { widget: 'toggle' }
  ),
  control(
    'allowMemberCreation',
    'Members may create polls',
    'Allow current managed-group members to start polls without a separate polls.create grant.',
    20,
    { type: 'boolean' },
    { widget: 'toggle' }
  ),
  control(
    'timezone',
    'Timezone',
    'IANA timezone used to display poll deadlines and results.',
    30,
    { type: 'string', format: 'timezone', required: true },
    { widget: 'select' }
  ),
  control(
    'creationPresets',
    'Creation presets',
    'Configure named poll-creation policies. Fixed fields are supplied by the operator and skipped in chat; suggested fields remain creator-selectable and are shown first.',
    40,
    { type: 'array', items: { type: 'object' } },
    {
      widget: 'builder',
      builderId: 'official.poll-assistant.creation-presets.v1'
    }
  ),
  control(
    'defaultClosingMode',
    'Default closing mode',
    'Closing choice shown first in the guided poll setup flow.',
    100,
    { type: 'enum', enum: CLOSING_MODE_OPTIONS },
    { widget: 'segmented', options: CLOSING_MODE_OPTIONS },
    'Poll defaults'
  ),
  control(
    'defaultDeadlineMinutes',
    'Default duration',
    'Default number of minutes a deadline poll remains open after publication.',
    110,
    { type: 'number', unit: 'minutes', min: 1, max: 44_640 },
    { widget: 'duration' },
    'Poll defaults'
  ),
  control(
    'maxDeadlineMinutes',
    'Maximum duration',
    'Maximum number of minutes allowed between publication and a configured deadline.',
    120,
    { type: 'number', unit: 'minutes', min: 1, max: 44_640 },
    { widget: 'duration' },
    'Poll defaults'
  ),
  control(
    'defaultQuorumMode',
    'Default turnout rule',
    'Minimum-turnout choice shown first in the guided poll setup flow.',
    200,
    { type: 'enum', enum: QUORUM_MODE_OPTIONS },
    { widget: 'segmented', options: QUORUM_MODE_OPTIONS },
    'Turnout defaults'
  ),
  control(
    'defaultAbsoluteQuorumResponses',
    'Default respondent count',
    'Default minimum respondent count when count-based turnout is selected.',
    210,
    { type: 'number', unit: 'items', min: 1, max: 100_000 },
    { widget: 'number' },
    'Turnout defaults'
  ),
  control(
    'defaultPercentageQuorumBasisPoints',
    'Default turnout basis points',
    'Default electorate percentage in basis points when percentage turnout is selected; 5000 means 50%.',
    220,
    { type: 'number', min: 1, max: 10_000 },
    { widget: 'number' },
    'Turnout defaults'
  ),
  control(
    'maxActivePollsPerChat',
    'Active poll limit',
    'Maximum number of active or tie-pending polls allowed in one originating chat.',
    300,
    { type: 'number', unit: 'items', min: 1, max: 100 },
    { widget: 'number' },
    'Lifecycle limits'
  ),
  control(
    'ballotRetentionDays',
    'Ballot retention',
    'Days to retain Poll Assistant voter-level working data after terminal delivery. The independent chat archive follows its own retention policy; aggregate results remain stored.',
    310,
    { type: 'number', unit: 'days', min: 1, max: 3_650 },
    { widget: 'duration' },
    'Lifecycle limits'
  ),
  control(
    'maxPrivateElectorateSize',
    'Private ballot electorate limit',
    'Maximum eligible voters for a private multi-recipient poll. The platform limit is 250.',
    320,
    { type: 'number', unit: 'items', min: 1, max: 250 },
    { widget: 'number' },
    'Lifecycle limits'
  ),
  control(
    'assistantExposeProvisionalResults',
    'Assistant may show live tallies',
    'Allow the natural-language assistant to expose aggregate event-derived tallies for open polls. These results are explicitly provisional; finalized results always use authoritative WhatsApp readback.',
    400,
    { type: 'boolean' },
    { widget: 'toggle' },
    'Assistant access'
  )
];
