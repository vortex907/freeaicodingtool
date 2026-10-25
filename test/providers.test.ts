// Free providers added in 1.6: Ollama Cloud (Ollama's own API with a key), Requesty (free models only)
// and OVHcloud AI Endpoints (no key at all).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { discoverProvider, normalizeModelEntry } from '../src/providers/discovery.js';
import { getProviderDef, setupOrder } from '../src/providers/catalog.js';
import { buildProviders } from '../src/providers/registry.js';
import { estimateModel } from '../src/providers/modelInfo.js';
import { defaultSettings } from '../src/config/config.js';
import type { ProviderRuntime } from '../src/providers/types.js';

async function serve(handler: (req: http.IncomingMessage, body: string) => { status?: number; json: unknown }): Promise<{ url: string; seen: http.IncomingHttpHeaders[]; close: () => Promise<void> }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(req.headers);
      const r = handler(req, body);
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => srv.close(() => r())) };
}

const runtime = (id: string, baseURL: string, key: string) => {
  const s = defaultSettings();
  s.providers = { [id]: { apiKey: key, baseURL } };
  return buildProviders(s, {}, { version: 1, providers: {} }).find((p) => p.id === id)!;
};

test('the new providers are in the catalog and the setup list', () => {
  const ids = setupOrder().map((p) => p.id);
  for (const id of ['ollamacloud', 'requesty', 'ovhcloud']) {
    const def = getProviderDef(id)!;
    assert.ok(def, id);
    assert.ok(ids.includes(id), `${id} is offered in setup`);
    assert.match(def.signupUrl, /^https:\/\//);
    assert.ok(def.freeTier.length > 20);
  }
  assert.equal(getProviderDef('ollamacloud')!.api, 'ollama');
  assert.equal(getProviderDef('requesty')!.discovery?.freeOnly, true, 'Requesty only ever lists free models');
  const ovh = getProviderDef('ovhcloud')!;
  assert.equal(ovh.keyRequired, false);
  assert.deepEqual(ovh.keyEnv, [], 'no key is picked up: an OVHcloud key is billed per token');
  assert.ok(ovh.models.every((m) => m.limits?.rpm === 2), 'the anonymous limit is per model');
});

test('Ollama Cloud discovery sends the key, keeps the strongest models and their real context', async () => {
  const srv = await serve((req, body) => {
    if (req.headers.authorization !== 'Bearer olm_key') return { status: 401, json: { error: 'unauthorized' } };
    if (req.url === '/api/tags') return { json: { models: [{ name: 'llama3.2:1b' }, { name: 'gpt-oss:20b' }, { name: 'deepseek-v4-pro' }, { name: 'kimi-k2.6' }] } };
    const model = (JSON.parse(body) as { model: string }).model;
    return { json: { capabilities: ['completion', 'tools'], model_info: { 'general.context_length': model === 'deepseek-v4-pro' ? 262144 : 131072 } } };
  });
  try {
    const models = await discoverProvider(runtime('ollamacloud', srv.url, 'olm_key'));
    const ids = models.map((m) => m.id);
    assert.equal(ids[0], 'deepseek-v4-pro', 'strongest first');
    assert.ok(!ids.includes('llama3.2:1b'), 'too weak for the bar');
    assert.equal(models.find((m) => m.id === 'deepseek-v4-pro')!.context, 262144, 'not capped at the local default');
    assert.equal(models[0]!.tools, true);
    // Ollama names gpt-oss with a colon; it still reasons and takes an effort level.
    assert.equal(estimateModel('gpt-oss:120b').effort, true);
    assert.equal(estimateModel('gpt-oss:20b').reasoning, true);
  } finally {
    await srv.close();
  }
});

test('Requesty discovery keeps only zero-priced models, whatever the price fields are called', async () => {
  assert.equal(normalizeModelEntry({ id: 'a/b', input_price: 0, output_price: 0 })!.free, true);
  assert.equal(normalizeModelEntry({ id: 'a/b', input_price: 0.000003, output_price: 0.000015 })!.free, false);
  assert.equal(normalizeModelEntry({ id: 'a/b', pricing: { prompt: '0', completion: '0' } })!.free, true);
  assert.equal(normalizeModelEntry({ id: 'a/b' })!.free, undefined);
  const srv = await serve(() => ({
    json: {
      data: [
        { id: 'nvidia/nemotron-3-super-120b-a12b', input_price: 0, output_price: 0 },
        { id: 'google/gemma-4-31b-it', input_price: 0, output_price: 0 },
        { id: 'anthropic/claude-opus-5-5', input_price: 0.000004, output_price: 0.00002 },
        { id: 'openai/gpt-5', pricing: { prompt: '0.00000125', completion: '0.00001' } },
      ],
    },
  }));
  try {
    const ids = (await discoverProvider(runtime('requesty', `${srv.url}/v1`, 'rq_key'))).map((m) => m.id).sort();
    assert.deepEqual(ids, ['google/gemma-4-31b-it', 'nvidia/nemotron-3-super-120b-a12b']);
    assert.equal(srv.seen[0]!.authorization, 'Bearer rq_key');
  } finally {
    await srv.close();
  }
});

test('OVHcloud is ready without a key and sends no Authorization header', async () => {
  const s = defaultSettings();
  const ovh = buildProviders(s, {}, { version: 1, providers: {} }).find((p) => p.id === 'ovhcloud') as ProviderRuntime;
  assert.equal(ovh.configured, true);
  assert.equal(ovh.enabled, true);
  assert.deepEqual(ovh.apiKeys, ['']);
  const srv = await serve(() => ({ json: { data: [{ id: 'gpt-oss-120b' }, { id: 'Qwen3-Coder-30B-A3B-Instruct' }] } }));
  try {
    const ids = (await discoverProvider({ ...ovh, baseURL: `${srv.url}/v1` })).map((m) => m.id);
    assert.ok(ids.includes('gpt-oss-120b'));
    assert.equal(srv.seen[0]!.authorization, undefined);
  } finally {
    await srv.close();
  }
});
