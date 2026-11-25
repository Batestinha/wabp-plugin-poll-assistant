import type { SendTextOptions } from '@wabs/plugin-sdk/transport';

/** Carry a configured-message slot through the vendored SDK types. */
export function withMessageSlot(key: string, options?: SendTextOptions, scopeId?: string | null): SendTextOptions {
  return { ...(options ?? {}), messageSlot: { key, ...(scopeId ? { scopeId } : {}) } } as SendTextOptions;
}
