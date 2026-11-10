// Provider status for the app's setup and settings screens.
import { setupOrder } from '../providers/catalog.js';
import type { ProviderKind, ProviderRuntime } from '../providers/types.js';
import { readGlobalConfig } from '../config/config.js';
import { loadDotenvFile } from '../config/dotenv.js';
import { globalPaths } from '../config/paths.js';

export type ProviderState = 'saved' | 'env' | 'none' | 'keyless' | 'local-up' | 'local-down' | 'disabled';

export interface ProviderInfo {
  id: string;
  name: string;
  kind: ProviderKind;
  freeTier: string;
  signupUrl: string;
  keyEnv: string[];
  state: ProviderState;
  envName?: string;
  maskedKey?: string;
  needsAccountId: boolean;
  accountId?: string;
  models: number;
  recommended: boolean;
  notes?: string;
}

let localCache: { at: number; value: Record<string, boolean> } | null = null;

export async function probeLocalServers(force = false): Promise<Record<string, boolean>> {
  if (!force && localCache && Date.now() - localCache.at < 15_000) return localCache.value;
  const host = process.env.OLLAMA_HOST ? (/^https?:/.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : 'http://localhost:11434';
  const probe = async (url: string) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(700) });
      return r.ok;
    } catch {
      return false;
    }
  };
  const [ollama, lmstudio] = await Promise.all([probe(`${host.replace(/\/+$/, '')}/api/tags`), probe('http://localhost:1234/v1/models')]);
  localCache = { at: Date.now(), value: { ollama, lmstudio } };
  return localCache.value;
}

export function maskKey(k: string): string {
  if (k.length <= 10) return '•'.repeat(k.length);
  return `${k.slice(0, 4)}••••••${k.slice(-4)}`;
}

const RECOMMENDED = new Set(['gemini', 'groq', 'openrouter', 'mistral', 'nvidia', 'cerebras']);

export async function providerInfos(runtimes: ProviderRuntime[]): Promise<ProviderInfo[]> {
  const cfg = readGlobalConfig();
  const dotenv = loadDotenvFile(globalPaths.envFile);
  const local = await probeLocalServers();
  const out: ProviderInfo[] = [];
  for (const def of setupOrder()) {
    const pc = cfg.providers?.[def.id];
    const rt = runtimes.find((r) => r.id === def.id);
    let state: ProviderState = 'none';
    let envName: string | undefined;
    let maskedKey: string | undefined;
    if (def.kind === 'local') state = local[def.id] ? 'local-up' : 'local-down';
    else if (pc?.apiKey || pc?.apiKeys?.length) {
      state = 'saved';
      maskedKey = maskKey(pc.apiKey ?? pc.apiKeys![0]!);
    } else {
      for (const n of def.keyEnv) {
        if (process.env[n] || dotenv[n]) {
          state = 'env';
          envName = n;
          break;
        }
      }
      if (state === 'none' && !def.keyRequired) state = 'keyless';
    }
    if (pc?.enabled === false) state = 'disabled';
    out.push({
      id: def.id,
      name: def.name,
      kind: def.kind,
      freeTier: def.freeTier,
      signupUrl: def.keyUrl ?? def.signupUrl,
      keyEnv: def.keyEnv,
      state,
      envName,
      maskedKey,
      needsAccountId: !!def.accountIdEnv,
      accountId: pc?.accountId,
      models: rt?.models.filter((m) => m.enabled).length ?? 0,
      recommended: RECOMMENDED.has(def.id),
      notes: def.notes,
    });
  }
  return out;
}
