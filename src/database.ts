import type { PluginDatabaseManifest } from '../../../platform/pluginRuntime/manifest';
import type {
  PluginDatabase,
  PluginDatabaseRegistry
} from '../../../platform/pluginRuntime/runtime/pluginDatabase';

export const POLL_ASSISTANT_PLUGIN_ID = 'official.poll-assistant';
export const POLL_ASSISTANT_DATABASE = 'polls';

export const pollAssistantDatabases = [{
  name: POLL_ASSISTANT_DATABASE,
  engine: 'sqlite',
  scope: 'account',
  migrations: 'migrations/polls'
}] as const satisfies readonly PluginDatabaseManifest[];

export function pollAssistantDatabase(registry: PluginDatabaseRegistry | undefined): PluginDatabase {
  if (!registry) {
    throw new Error('official.poll-assistant requires its account-scoped plugin database registry.');
  }
  return registry.open(POLL_ASSISTANT_DATABASE);
}
