// Converts FreeCode's internal conversation into an OpenAI-compatible request body, applying
// per-provider quirks so the same history works on every provider (and survives failover).
import { createHash } from 'node:crypto';
import type { ChatMessage, ModelInfo, ProviderQuirks, ToolSchema, ToolMode } from './types.js';
import { renderToolCallText, renderToolResultText, textToolInstructions } from './textTools.js';

export interface WireOptions {
  quirks: ProviderQuirks;
  model: ModelInfo;
  toolMode: ToolMode;
  tools?: ToolSchema[];
  /** Strip all optional parameters (used when retrying after a 400). */
  minimal?: boolean;
  /** Extra-defensive message shaping (empty-string content instead of null, ...). */
  strict?: boolean;
  /** Merge the system prompt into the first user message. */
  noSystemRole?: boolean;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

type WireMessage = Record<string, unknown>;

/** Deterministic 9-char alphanumeric id for providers that require it (Mistral). */
function mistralId(id: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  if (/^[a-zA-Z0-9]{9}$/.test(id)) return id;
  const h = createHash('sha256').update(id).digest();
  let out = '';
  for (let i = 0; i < 9; i++) out += alphabet[h[i]! % alphabet.length];
  return out;
}

function sanitizeId(id: string, quirks: ProviderQuirks): string {
  if (quirks.toolCallIdFormat === 'mistral9') return mistralId(id);
  // Some providers reject very long or exotic ids.
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean.length > 64 ? clean.slice(0, 64) : clean || 'call_0';
}

/** Makes sure every tool call has a result and every tool result has a call. */
export function repairToolPairs(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'tool') {
      // Orphan tool message (its assistant call is gone): keep the information as user text.
      const prev = findOwningCall(out, m.toolCallId);
      if (!prev) {
        out.push({ role: 'user', content: `[Result of earlier ${m.toolName ?? 'tool'} call]\n${m.content}`, meta: m.meta });
        continue;
      }
      out.push(m);
      continue;
    }
    out.push(m);
    if (m.role === 'assistant' && m.toolCalls?.length) {
      // Collect the following tool results.
      const ids = new Set<string>();
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === 'tool') {
        ids.add(messages[j]!.toolCallId ?? '');
        j++;
      }
      // Emit them now (in order), then add stubs for missing ones.
      for (let k = i + 1; k < j; k++) out.push(messages[k]!);
      for (const tc of m.toolCalls) {
        if (!ids.has(tc.id)) {
          out.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, content: 'No result: the tool call was interrupted or skipped.', isError: true });
        }
      }
      i = j - 1;
    }
  }
  return out;
}

function findOwningCall(out: ChatMessage[], id: string | undefined): boolean {
  if (!id) return false;
  for (let k = out.length - 1; k >= 0; k--) {
    const m = out[k]!;
    if (m.role === 'assistant') return !!m.toolCalls?.some((t) => t.id === id);
    if (m.role !== 'tool') return false;
  }
  return false;
}

/** JSON-schema cleanup. Gemini accepts only an OpenAPI subset. */
export function sanitizeSchema(schema: unknown, dialect: 'openai' | 'gemini' = 'openai'): unknown {
  if (Array.isArray(schema)) return schema.map((s) => sanitizeSchema(s, dialect));
  if (!schema || typeof schema !== 'object') return schema;
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const drop = dialect === 'gemini'
    ? new Set(['$schema', 'additionalProperties', '$id', '$ref', '$defs', 'definitions', 'default', 'examples', 'const', 'patternProperties', 'unevaluatedProperties', 'propertyNames', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'contentEncoding', 'contentMediaType', 'readOnly', 'writeOnly', 'deprecated', 'title', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'multipleOf', 'uniqueItems'])
    : new Set(['$schema', '$id']);
  for (const [k, v] of Object.entries(src)) {
    if (drop.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) props[pk] = sanitizeSchema(pv, dialect);
      out[k] = props;
    } else if (k === 'type' && Array.isArray(v) && dialect === 'gemini') {
      // ["string","null"] -> "string" + nullable
      const types = v.filter((t) => t !== 'null');
      out.type = types[0] ?? 'string';
      if (v.includes('null')) out.nullable = true;
    } else if ((k === 'anyOf' || k === 'oneOf' || k === 'allOf') && dialect === 'gemini') {
      const variants = (v as unknown[]).map((s) => sanitizeSchema(s, dialect)) as Record<string, unknown>[];
      const nonNull = variants.filter((s) => s.type !== 'null');
      if (nonNull.length === 1) Object.assign(out, nonNull[0]);
      else out.anyOf = nonNull;
    } else if (k === 'enum' && Array.isArray(v) && dialect === 'gemini') {
      out.enum = v.filter((x) => x !== null).map(String);
    } else if (typeof v === 'object' && v !== null) {
      out[k] = sanitizeSchema(v, dialect);
    } else {
      out[k] = v;
    }
  }
  if (dialect === 'gemini' && out.type === 'object' && out.properties && Object.keys(out.properties as object).length === 0) {
    delete out.properties;
  }
  if (Array.isArray(out.required) && out.properties) {
    out.required = (out.required as string[]).filter((r) => r in (out.properties as object));
  }
  return out;
}

/** Builds the messages array for the wire. */
export function toWireMessages(messages: ChatMessage[], opts: WireOptions): WireMessage[] {
  const { quirks, toolMode, model } = opts;
  const text = toolMode === 'text';
  let msgs = repairToolPairs(messages);

  // Text tool mode: append protocol to system prompt, convert calls/results to text.
  if (text && opts.tools?.length) {
    const instructions = textToolInstructions(opts.tools);
    const sysIdx = msgs.findIndex((m) => m.role === 'system');
    if (sysIdx >= 0) msgs = msgs.map((m, i) => (i === sysIdx ? { ...m, content: `${m.content}\n\n${instructions}` } : m));
    else msgs = [{ role: 'system', content: instructions }, ...msgs];
  }

  const out: WireMessage[] = [];
  const pushUser = (content: string, images?: ChatMessage['images']) => {
    const last = out[out.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string' && !images?.length) {
      last.content = `${last.content}\n\n${content}`;
      return;
    }
    if (images?.length && model.vision) {
      out.push({
        role: 'user',
        content: [{ type: 'text', text: content || '(see image)' }, ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.data}` } }))],
      });
    } else {
      const note = images?.length ? `\n\n[${images.length} image(s) omitted: the current model cannot see images]` : '';
      out.push({ role: 'user', content: (content || '(empty message)') + note });
    }
  };

  for (const m of msgs) {
    switch (m.role) {
      case 'system': {
        if (model.noSystemRole || opts.noSystemRole) {
          pushUser(`<system_instructions>\n${m.content}\n</system_instructions>`);
        } else if (out.length && out[out.length - 1]!.role === 'system') {
          out[out.length - 1]!.content = `${out[out.length - 1]!.content}\n\n${m.content}`;
        } else out.push({ role: 'system', content: m.content });
        break;
      }
      case 'user':
        pushUser(m.content, m.images);
        break;
      case 'assistant': {
        if (text) {
          const parts = [m.content.trim(), ...(m.toolCalls ?? []).map(renderToolCallText)].filter(Boolean);
          if (!parts.length) continue;
          out.push({ role: 'assistant', content: parts.join('\n\n') });
          break;
        }
        if (m.toolCalls?.length) {
          out.push({
            role: 'assistant',
            content: m.content ? m.content : quirks.emptyStringContent || opts.strict ? '' : null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: sanitizeId(tc.id, quirks),
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments && tc.arguments.trim() ? tc.arguments : '{}' },
            })),
          });
        } else {
          if (!m.content.trim()) continue; // empty assistant turns are rejected by several providers
          const last = out[out.length - 1];
          if (last && last.role === 'assistant' && !last.tool_calls && typeof last.content === 'string') {
            last.content = `${last.content}\n\n${m.content}`;
          } else out.push({ role: 'assistant', content: m.content });
        }
        break;
      }
      case 'tool': {
        if (text) {
          pushUser(renderToolResultText(m.toolName ?? 'tool', m.toolCallId ?? '', m.content, m.isError));
          break;
        }
        const msg: WireMessage = {
          role: 'tool',
          tool_call_id: sanitizeId(m.toolCallId ?? 'call_0', quirks),
          content: m.content || '(no output)',
        };
        if (quirks.toolMessageName) msg.name = m.toolName ?? 'tool';
        out.push(msg);
        break;
      }
    }
  }

  // Providers that dislike user-after-tool get a short assistant bridge.
  if (quirks.noUserAfterTool && !text) {
    for (let i = 1; i < out.length; i++) {
      if (out[i]!.role === 'user' && out[i - 1]!.role === 'tool') {
        out.splice(i, 0, { role: 'assistant', content: 'Noted.' });
        i++;
      }
    }
  }

  // The conversation must not end with an assistant message (no prefill support on most providers).
  while (out.length && out[out.length - 1]!.role === 'assistant' && !out[out.length - 1]!.tool_calls) {
    const last = out.pop()!;
    pushUser(`(Your previous reply was: ${String(last.content).slice(0, 2000)})\nPlease continue.`);
  }
  // Must start with system or user.
  if (out.length && out[0]!.role === 'assistant') out.unshift({ role: 'user', content: '(conversation start)' });
  return out;
}

/** Builds the full JSON request body. */
export function buildRequestBody(messages: ChatMessage[], opts: WireOptions): Record<string, unknown> {
  const { quirks, model, toolMode, minimal } = opts;
  const body: Record<string, unknown> = {
    model: model.id,
    messages: toWireMessages(messages, opts),
    stream: opts.stream ?? true,
  };
  if (toolMode === 'native' && opts.tools?.length) {
    const dialect = quirks.schemaDialect ?? 'openai';
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: sanitizeSchema(t.parameters, dialect) },
    }));
    if (!minimal && !quirks.noToolChoice) body.tool_choice = 'auto';
  }
  if (opts.maxTokens && (!minimal || quirks.requireMaxTokens)) {
    body[quirks.maxTokensField ?? 'max_tokens'] = opts.maxTokens;
  }
  if (opts.temperature !== undefined && !minimal) body.temperature = opts.temperature;
  if (!minimal) {
    if (quirks.streamUsage && body.stream) body.stream_options = { include_usage: true };
    if (model.extraBody) Object.assign(body, model.extraBody);
  }
  return body;
}
