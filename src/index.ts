import { migratePollTemplates } from './templateMigration';
import { type BotPlugin } from './runtime';
import {
  registerPollAssistantCancellations,
  registerPollAssistantCommands
} from './commands';
import { createPollAssistantHooks } from './hooks';
import { registerPollAssistantTools } from './assistantTools';
import { pollAssistantManifest } from './manifest';
import { registerPollAssistantServices } from './service';

export const pollAssistantPlugin: BotPlugin = {
  manifest: pollAssistantManifest,
  lifecycle: { onInstall: migratePollTemplates, onUpdate: migratePollTemplates, migrateData: migratePollTemplates },
  registerCommands(context) {
    registerPollAssistantCommands(context);
  },
  registerCancellations(context) {
    return registerPollAssistantCancellations(context);
  },
  registerHooks(context) {
    return createPollAssistantHooks(context);
  },
  registerAssistantTools(context) {
    return registerPollAssistantTools(context);
  },
  registerServices(context) {
    return registerPollAssistantServices(context);
  }
};

export default pollAssistantPlugin;
