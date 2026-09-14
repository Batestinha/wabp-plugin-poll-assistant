import type { PluginConfigurationMigrationInput, PluginConfigurationLayer, PluginConfigurationLayerPatch, PluginLifecycleContext } from '@wabs/plugin-sdk/plugin-lifecycle';
import { migrateLegacyPollMessageSettings } from './templates';

export const POLL_TEMPLATE_MIGRATION_KEY = 'message-templates-v2';
export async function migratePollTemplates(context: PluginLifecycleContext): Promise<void> {
  if (!context.migrateConfiguration) throw new Error('Poll template migration requires core API 0.3.6.');
  const result = await context.migrateConfiguration(POLL_TEMPLATE_MIGRATION_KEY, migratePollTemplateLayers);
  context.logger.info({ changed: result.changed, backupKey: result.backupKey }, 'Migrated Poll message templates with an original configuration backup');
}

/** Compute every replacement from the original graph, before writing any parent layer. */
export function migratePollTemplateLayers(input: PluginConfigurationMigrationInput): PluginConfigurationLayerPatch[] {
  const scopes = new Map(input.scopes.map(scope => [scope.id, scope]));
  const scopeLayers = new Map(input.layers.filter(layer => !layer.identityId && layer.scopeId).map(layer => [layer.scopeId!, layer]));
  const lineage = (scopeId: string): string[] => {
    const result: string[] = []; let current: string | null = scopeId;
    while (current) {
      if (result.includes(current) || result.length >= 128) throw new Error('Invalid scope ancestry during template migration.');
      const scope = scopes.get(current); if (!scope) throw new Error('Unknown scope during template migration.');
      result.unshift(current); current = scope.parentScopeId;
    }
    return result;
  };
  const effective = (scopeId: string, identityId?: string) => {
    const config: Record<string, unknown> = {};
    for (const id of lineage(scopeId)) merge(config, scopeLayers.get(id)?.config ?? {});
    if (identityId) {
      merge(config, input.layers.find(layer => layer.identityId === identityId && layer.scopeId === null)?.config ?? {});
      merge(config, input.layers.find(layer => layer.identityId === identityId && layer.scopeId === scopeId)?.config ?? {});
    }
    return config;
  };
  const patches = new Map<string, PluginConfigurationLayerPatch>();
  const save = (layer: Pick<PluginConfigurationLayer, 'scopeId' | 'identityId' | 'config'>, resolved: Record<string, unknown>) => {
    const messages = object(layer.config.messages);
    const migrated = object(migrateLegacyPollMessageSettings({ ...object(resolved.messages), templateVersion: undefined }));
    const config = { ...layer.config, messages: { ...messages, publication: migrated.publication, templateVersion: 2 } };
    delete (config.messages as Record<string, unknown>).mentionEligible;
    patches.set(JSON.stringify([layer.scopeId, layer.identityId ?? null]), { scopeId: layer.scopeId, ...(layer.identityId ? { identityId: layer.identityId } : {}), config });
  };
  const ownsNotification = (layer: PluginConfigurationLayer | undefined) => {
    const messages = object(layer?.config.messages);
    return messages.templateVersion !== 2 && (Object.hasOwn(messages, 'publication') || Object.hasOwn(messages, 'mentionEligible'));
  };
  for (const layer of scopeLayers.values()) {
    const messages = object(layer.config.messages);
    if (messages.templateVersion === 2) continue;
    const hasAncestor = lineage(layer.scopeId!).slice(0, -1).some(id => scopeLayers.has(id));
    if (ownsNotification(layer) || !hasAncestor) save(layer, effective(layer.scopeId!));
  }
  const identityIds = new Set(input.layers.flatMap(layer => layer.identityId ? [layer.identityId] : []));
  for (const identityId of identityIds) {
    const global = input.layers.find(layer => layer.identityId === identityId && layer.scopeId === null);
    const globalNeedsMigration = ownsNotification(global);
    if (globalNeedsMigration && global) save(global, global.config);
    for (const scope of input.scopes) {
      const scoped = input.layers.find(layer => layer.identityId === identityId && layer.scopeId === scope.id);
      if (object(scoped?.config.messages).templateVersion === 2) continue;
      if (globalNeedsMigration || ownsNotification(scoped)) save(scoped ?? { scopeId: scope.id, identityId, config: {} }, effective(scope.id, identityId));
    }
  }
  return [...patches.values()];
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function merge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const child = { ...object(target[key]) }; merge(child, value as Record<string, unknown>); target[key] = child;
    } else target[key] = value;
  }
}
