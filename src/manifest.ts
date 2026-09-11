import type { PluginManifest } from '../../../platform/pluginRuntime/manifest';
import { POLL_HISTORY_OWNED_DATA_RESOURCE } from '../../../platform/pluginRuntime/pluginOwnedData';
import { pollAssistantConfigSchema } from './config';
import {
  POLL_ASSISTANT_PLUGIN_ID,
  pollAssistantDatabases
} from './database';
import {
  POLL_ASSISTANT_COMMAND_PERMISSIONS,
  POLL_CREATION_CANCELLATION_WORKFLOW_ID
} from './commands';
import {
  POLL_CLEANUP_JOB,
  POLL_ACTIVATE_JOB,
  POLL_DELIVER_JOB,
  POLL_FINALIZE_JOB,
  POLL_PRIVATE_ISSUE_JOB,
  POLL_PUBLISH_JOB
} from './jobs';
import {
  POLL_ASSISTANT_AUTOMATION_SERVICE_ID,
  POLL_ASSISTANT_CANCEL_POLL_METHOD,
  POLL_ASSISTANT_ENSURE_POLL_METHOD,
  POLL_ASSISTANT_RESOLVE_OUTCOME_METHOD,
  POLL_ASSISTANT_RESOLVE_POLL_METHOD
} from './serviceApi';
import { pollAssistantMessages } from './messages';
import { pollCreateAction, POLL_CREATE_ACTION_SERVICE } from './createActionApi';
import {
  POLL_ASSISTANT_LIFECYCLE_CANCEL_METHOD,
  POLL_ASSISTANT_LIFECYCLE_ENSURE_METHOD,
  POLL_ASSISTANT_LIFECYCLE_FINALIZE_METHOD,
  POLL_ASSISTANT_LIFECYCLE_INSPECT_METHOD,
  POLL_ASSISTANT_LIFECYCLE_SERVICE_ID
} from './lifecycleServiceApi';

export const pollAssistantManifest: PluginManifest = {
  pluginId: POLL_ASSISTANT_PLUGIN_ID,
  kind: 'managed_group',
  version: '0.4.0',
  coreApiRange: '>=0.2.0',
  messageNamespace: 'official.poll-assistant',
  descriptionKey: 'official.poll-assistant.description',
  defaultMessages: pollAssistantMessages,
  commands: [
    '/poll',
    '/poll create',
    '/poll list',
    '/poll status',
    '/poll open',
    '/poll close',
    '/poll cancel',
    '/poll resolve',
    '/poll actions'
  ],
  help: {
    featureId: 'poll-assistant',
    titleKey: 'official.poll-assistant.help.feature.title',
    summaryKey: 'official.poll-assistant.help.feature.summary',
    order: 25,
    topics: [
      {
        topicId: 'create',
        titleKey: 'official.poll-assistant.help.create',
        summaryKey: 'official.poll-assistant.help.create',
        order: 10,
        commands: ['/poll', '/poll create'],
        exampleKeys: ['official.poll-assistant.help.create.example'],
        keywords: ['poll', 'create', 'decision', 'measure', 'tally'],
        availability: {
          invocation: 'group_only',
          requiredAccessPlane: 'group_member',
          permission: POLL_ASSISTANT_COMMAND_PERMISSIONS.create,
          requiresCurrentManagedGroupMembership: true,
          currentManagedGroupMembershipMode: 'effective_scope',
          allowCurrentManagedGroupMemberConfigPath: 'allowMemberCreation',
          requiredConfigBooleanPath: 'allowCreation',
          requiredBotCapabilities: ['botIsAdmin', 'canSend']
        }
      },
      {
        topicId: 'inspect',
        titleKey: 'official.poll-assistant.help.status',
        summaryKey: 'official.poll-assistant.help.list',
        order: 20,
        commands: ['/poll list', '/poll status'],
        exampleKeys: [
          'official.poll-assistant.help.list.example',
          'official.poll-assistant.help.status.example'
        ],
        keywords: ['poll', 'list', 'status', 'result'],
        availability: {
          invocation: 'group_only',
          requiredAccessPlane: 'group_member',
          requiresCurrentManagedGroupMembership: true,
          currentManagedGroupMembershipMode: 'effective_scope'
        }
      },
      {
        topicId: 'manage',
        titleKey: 'official.poll-assistant.help.close',
        summaryKey: 'official.poll-assistant.help.cancel',
        order: 30,
        commands: ['/poll open', '/poll close', '/poll cancel', '/poll resolve', '/poll actions'],
        exampleKeys: [
          'official.poll-assistant.help.open.example',
          'official.poll-assistant.help.close.example',
          'official.poll-assistant.help.cancel.example',
          'official.poll-assistant.help.resolve.example',
          'official.poll-assistant.outcome.help.example'
        ],
        keywords: ['poll', 'open', 'close', 'cancel', 'resolve', 'tie'],
        availability: {
          invocation: 'group_only',
          requiredAccessPlane: 'group_member',
          requiresCurrentManagedGroupMembership: true,
          currentManagedGroupMembershipMode: 'effective_scope'
        }
      }
    ]
  },
  eventSubscriptions: ['poll.vote', 'participant.change', 'plugin.job'],
  services: [
    { serviceId: POLL_CREATE_ACTION_SERVICE, methods: [
      { name: 'describe', access: 'read' }, { name: 'prepare', access: 'read' },
      { name: 'execute', access: 'mutation' }, { name: 'inspect', access: 'read' }
    ] },
    {
      serviceId: POLL_ASSISTANT_AUTOMATION_SERVICE_ID,
      description: 'Idempotent source-owned automated decision poll lifecycles.',
      methods: [
        { name: POLL_ASSISTANT_ENSURE_POLL_METHOD, access: 'mutation' },
        {
          name: POLL_ASSISTANT_RESOLVE_POLL_METHOD,
          access: 'read',
          availability: 'installed'
        },
        { name: POLL_ASSISTANT_RESOLVE_OUTCOME_METHOD, access: 'mutation' },
        { name: POLL_ASSISTANT_CANCEL_POLL_METHOD, access: 'mutation' }
      ]
    },
    {
      serviceId: POLL_ASSISTANT_LIFECYCLE_SERVICE_ID,
      description: 'Idempotent source-owned named survey lifecycles and immutable ballot snapshots.',
      methods: [
        { name: POLL_ASSISTANT_LIFECYCLE_ENSURE_METHOD, access: 'mutation' },
        {
          name: POLL_ASSISTANT_LIFECYCLE_INSPECT_METHOD,
          access: 'read',
          availability: 'installed'
        },
        { name: POLL_ASSISTANT_LIFECYCLE_FINALIZE_METHOD, access: 'mutation' },
        { name: POLL_ASSISTANT_LIFECYCLE_CANCEL_METHOD, access: 'mutation' }
      ]
    }
  ],
  requiredPermissions: [
    POLL_ASSISTANT_COMMAND_PERMISSIONS.create,
    POLL_ASSISTANT_COMMAND_PERMISSIONS.manage
  ],
  requiredBotCapabilities: [],
  configSchema: pollAssistantConfigSchema,
  dangerousActions: [],
  backgroundJobs: [
    POLL_PUBLISH_JOB,
    POLL_ACTIVATE_JOB,
    POLL_FINALIZE_JOB,
    POLL_PRIVATE_ISSUE_JOB,
    POLL_DELIVER_JOB,
    POLL_CLEANUP_JOB
  ],
  backgroundJobAvailability: 'installed',
  cancellation: {
    workflows: [
      {
        id: POLL_CREATION_CANCELLATION_WORKFLOW_ID,
        description: 'Guided poll setup before the poll lifecycle is durably created.',
        mode: 'core-flow',
        scope: 'actor-chat',
        commands: ['/poll', '/poll create'],
        cancellableStates: ['active'],
        terminalStates: ['completed', 'cancelled', 'expired'],
        effects: ['terminate-poll-setup-session']
      },
      {
        id: 'published-poll-lifecycle',
        description: 'Durably created poll lifecycles require the explicit poll cancellation command.',
        mode: 'not-cancellable',
        scope: 'scope',
        commands: ['/poll cancel'],
        notCancellableReason: 'A published or queued native poll may already be visible, so cancellation requires the lifecycle-specific confirmed command and durable result delivery.'
      }
    ]
  },
  dependencies: [
    { pluginId: 'official.doas', versionRange: '>=0.4.0' }
  ],
  databases: [...pollAssistantDatabases],
  ownedData: [{ resource: POLL_HISTORY_OWNED_DATA_RESOURCE }],
  dataVersion: '5',
  workflowActions: [pollCreateAction],
  assistant: {
    summary: pollAssistantMessages['official.poll-assistant.assistant.summary']!,
    summaryKey: 'official.poll-assistant.assistant.summary',
    workflows: [
      {
        intent: 'poll_create',
        description: pollAssistantMessages['official.poll-assistant.assistant.workflow.create']!,
        descriptionKey: 'official.poll-assistant.assistant.workflow.create',
        commands: ['/poll', '/poll create']
      },
      {
        intent: 'poll_inspect',
        description: pollAssistantMessages['official.poll-assistant.assistant.workflow.inspect']!,
        descriptionKey: 'official.poll-assistant.assistant.workflow.inspect',
        commands: ['/poll list', '/poll status']
      },
      {
        intent: 'poll_manage',
        description: pollAssistantMessages['official.poll-assistant.assistant.workflow.manage']!,
        descriptionKey: 'official.poll-assistant.assistant.workflow.manage',
        commands: ['/poll open', '/poll close', '/poll cancel', '/poll resolve']
      }
    ]
  }
};
