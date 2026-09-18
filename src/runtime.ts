export type { DurablePlugin as BotPlugin, DurablePluginCommandContext as PluginCommandContext, DurablePluginServiceContext as PluginServiceRegistrationContext } from '@wabs/plugin-sdk/durable-plugin';

import type { DurablePluginRuntimeContext } from '@wabs/plugin-sdk/durable-plugin';
import type { SendTextOptions } from '@wabs/plugin-sdk/transport';
/** Optional host capabilities introduced in core API 0.3.8. */
export type PluginRuntimeContext = DurablePluginRuntimeContext & {
  pinMessage?(messageId: string, durationSeconds: number): Promise<void>;
  unpinMessage?(messageId: string): Promise<void>;
  editMessage?(messageId: string, text: string, options?: SendTextOptions): Promise<void>;
};
