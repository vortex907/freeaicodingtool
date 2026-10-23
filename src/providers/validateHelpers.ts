// Helpers for key validation.
import type { ModelInfo, ProviderDef } from './types.js';

export function buildModel_forValidation(def: ProviderDef, id: string): ModelInfo {
  return {
    key: `${def.id}/${id}`,
    providerId: def.id,
    id,
    name: id,
    context: 8192,
    maxOutput: 16,
    toolMode: 'native',
    quality: 50,
    speed: 50,
    reasoning: false,
    vision: false,
    effort: false,
    limits: {},
    roles: [],
    source: 'seed',
    enabled: true,
    priority: 0,
    paid: def.kind === 'paid',
    noSystemRole: false,
  };
}
