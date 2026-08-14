import type { BotPlugin } from '../../../platform/pluginRuntime/types';
import {
  registerPollAssistantCancellations,
  registerPollAssistantCommands
} from './commands';
import { createPollAssistantHooks } from './hooks';
import { registerPollAssistantTools } from './assistantTools';
import { pollAssistantManifest } from './manifest';

export const pollAssistantPlugin: BotPlugin = {
  manifest: pollAssistantManifest,
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
  }
};

export default pollAssistantPlugin;
