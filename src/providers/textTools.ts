// Text-based tool calling, for models without native function calling, and salvage of tool calls that
// models print as text in one of the many formats open models were trained on.
import type { ToolCall, ToolSchema } from './types.js';
import { findBalancedEnd, parseJsonLenient } from '../util/jsonRepair.js';
import { randomId } from '../util/strings.js';

export function newToolCallId(): string {
  return `call_${randomId(16)}`;
}

/** System-prompt section that teaches the text tool-call protocol. */
export function textToolInstructions(tools: ToolSchema[]): string {
  const lines: string[] = [];
  lines.push('# How to call tools');
  lines.push('You have tools, but you call them by writing a tool call block in your reply. Format (the content is JSON):');
  lines.push('');
  lines.push('<tool_call>');
  lines.push('{"name": "TOOL_NAME", "arguments": {"param": "value"}}');
  lines.push('</tool_call>');
  lines.push('');
  lines.push('Rules:');
  lines.push('- One block per tool call. You may put several blocks in one reply when the calls are independent.');
  lines.push('- After your tool call blocks, STOP writing. The system runs the tools and replies with <tool_result> blocks.');
  lines.push('- Never write <tool_result> blocks yourself and never guess what a tool would return.');
  lines.push('- The arguments must be valid JSON: escape newlines inside strings as \\n and quotes as \\".');
  lines.push('- When the task is finished, answer normally with no tool call block.');
  lines.push('');
  lines.push('# Available tools');
  for (const t of tools) {
    lines.push('');
    lines.push(`## ${t.name}`);
    lines.push(t.description.trim());
    lines.push(`Parameters (JSON schema): ${JSON.stringify(compactSchema(t.parameters))}`);
  }
  return lines.join('\n');
}

/** Drops verbose schema fields to save tokens in text mode. */
function compactSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === 'additionalProperties' || k === 'title') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) props[pk] = compactSchema(pv as Record<string, unknown>);
      out[k] = props;
    } else if (k === 'items' && v && typeof v === 'object') {
      out[k] = compactSchema(v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out;
}

export function renderToolCallText(call: ToolCall): string {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    args = call.arguments;
  }
  return `<tool_call>\n${JSON.stringify({ name: call.name, arguments: args })}\n</tool_call>`;
}

export function renderToolResultText(name: string, id: string, content: string, isError?: boolean): string {
  return `<tool_result name="${name}" id="${id}"${isError ? ' error="true"' : ''}>\n${content}\n</tool_result>`;
}

export interface ParsedText {
  text: string;
  toolCalls: ToolCall[];
}

interface Match {
  start: number;
  end: number;
  calls: { name: string; args: unknown }[];
}

const NAME_KEYS = ['name', 'tool', 'tool_name', 'function', 'toolName', 'function_name', 'action'];
const ARG_KEYS = ['arguments', 'parameters', 'args', 'input', 'params', 'tool_input', 'action_input', 'argument'];

function callFromObject(obj: unknown, known?: Set<string>): { name: string; args: unknown } | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  let o = obj as Record<string, unknown>;
  // {"type":"function","function":{"name":..,"arguments":..}}
  if (o.function && typeof o.function === 'object' && !Array.isArray(o.function)) o = o.function as Record<string, unknown>;
  let name: string | undefined;
  for (const k of NAME_KEYS) {
    if (typeof o[k] === 'string') {
      name = o[k] as string;
      break;
    }
  }
  if (!name) return null;
  name = name.replace(/^functions\./, '').trim();
  let args: unknown = {};
  for (const k of ARG_KEYS) {
    if (o[k] !== undefined) {
      args = o[k];
      break;
    }
  }
  if (typeof args === 'string') {
    try {
      args = parseJsonLenient(args);
    } catch {
      // keep string
    }
  }
  if (known && !known.has(name)) {
    const ci = [...known].find((k) => k.toLowerCase() === name!.toLowerCase());
    if (ci) name = ci;
  }
  return { name, args };
}

function tryParseCalls(jsonText: string, known?: Set<string>): { name: string; args: unknown }[] {
  let v: unknown;
  try {
    v = parseJsonLenient(jsonText);
  } catch {
    return [];
  }
  const list = Array.isArray(v) ? v : [v];
  const out: { name: string; args: unknown }[] = [];
  for (const item of list) {
    const c = callFromObject(item, known);
    if (c) out.push(c);
  }
  return out;
}

/** Qwen3-Coder style: <function=NAME><parameter=KEY>VALUE</parameter>...</function> */
function parseXmlFunction(body: string): { name: string; args: unknown } | null {
  const fm = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/.exec(body);
  if (!fm) return null;
  const name = fm[1]!.trim();
  const inner = fm[2]!;
  const trimmedInner = inner.trim();
  if (trimmedInner.startsWith('{')) {
    try {
      return { name, args: parseJsonLenient(trimmedInner) };
    } catch {
      // fall through
    }
  }
  const args: Record<string, unknown> = {};
  const pre = /<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pre.exec(inner))) args[pm[1]!.trim()] = coerceScalar(pm[2]!);
  return { name, args };
}

/** GLM style: NAME<arg_key>k</arg_key><arg_value>v</arg_value>... */
function parseGlmCall(body: string): { name: string; args: unknown } | null {
  const idx = body.indexOf('<arg_key>');
  const name = (idx >= 0 ? body.slice(0, idx) : body).trim();
  if (!/^[\w.-]+$/.test(name)) return null;
  const args: Record<string, unknown> = {};
  const re = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) args[m[1]!.trim()] = coerceScalar(m[2]!);
  return { name, args };
}

function coerceScalar(v: string): unknown {
  const t = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(t) && t.length < 16) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t);
    } catch {
      // keep text
    }
  }
  return v.replace(/^\n/, '').replace(/\n$/, '');
}

/**
 * Extracts tool calls written as text. `known` is the set of available tool names; ambiguous formats
 * (bare JSON) are only accepted when the name is known.
 */
export function parseToolCallsFromText(text: string, known?: Set<string>): ParsedText {
  const matches: Match[] = [];
  const taken = (start: number, end: number) => matches.some((m) => start < m.end && end > m.start);

  // 1. <tool_call> ... </tool_call>  (Hermes/Qwen JSON, Qwen3-Coder XML, GLM arg_key)
  {
    const re = /<tool_call>([\s\S]*?)(<\/tool_call>|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) break;
      const body = m[1]!.trim();
      let calls: { name: string; args: unknown }[] = [];
      if (body.includes('<function=')) {
        const c = parseXmlFunction(body);
        if (c) calls = [c];
      } else if (body.includes('<arg_key>') || /^[\w.-]+\s*$/.test(body)) {
        const c = parseGlmCall(body);
        if (c) calls = [c];
      } else {
        calls = tryParseCalls(body, known);
      }
      if (calls.length) matches.push({ start: m.index, end: m.index + m[0].length, calls });
      if (!m[2]) break;
    }
  }

  // 2. Bare <function=NAME>...</function> (Llama 3.1 / Qwen3-Coder without wrapper)
  {
    const re = /<function=([^>\s]+)>([\s\S]*?)<\/function>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (taken(m.index, m.index + m[0].length)) continue;
      const c = parseXmlFunction(m[0]);
      if (c) matches.push({ start: m.index, end: m.index + m[0].length, calls: [c] });
    }
  }

  // 3. Kimi K2 raw tokens
  {
    const re = /<\|tool_call_begin\|>\s*(?:functions\.)?([\w.-]+?)(?::\d+)?\s*<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (taken(m.index, m.index + m[0].length)) continue;
      let args: unknown = {};
      try {
        args = parseJsonLenient(m[2]!);
      } catch {
        // ignore
      }
      matches.push({ start: m.index, end: m.index + m[0].length, calls: [{ name: m[1]!, args }] });
    }
  }

  // 4. DeepSeek raw tokens
  {
    const re = /<｜tool▁call▁begin｜>(?:function)?<｜tool▁sep｜>([\w.-]+)\s*(?:```(?:json)?)?\s*([\s\S]*?)\s*(?:```)?\s*<｜tool▁call▁end｜>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (taken(m.index, m.index + m[0].length)) continue;
      let args: unknown = {};
      try {
        args = parseJsonLenient(m[2]!);
      } catch {
        // ignore
      }
      matches.push({ start: m.index, end: m.index + m[0].length, calls: [{ name: m[1]!, args }] });
    }
  }

  // 5. Mistral [TOOL_CALLS] and Llama <|python_tag|>
  for (const marker of ['[TOOL_CALLS]', '<|python_tag|>']) {
    let from = 0;
    let idx: number;
    while ((idx = text.indexOf(marker, from)) >= 0) {
      from = idx + marker.length;
      let j = from;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      // [TOOL_CALLS]name[ARGS]{...}
      const named = /^([\w.-]+)\[ARGS\]/.exec(text.slice(j));
      if (named) {
        const argStart = j + named[0].length;
        const end = findBalancedEnd(text, argStart);
        const stop = end < 0 ? text.length : end;
        let args: unknown = {};
        try {
          args = parseJsonLenient(text.slice(argStart, stop));
        } catch {
          // ignore
        }
        if (!taken(idx, stop)) matches.push({ start: idx, end: stop, calls: [{ name: named[1]!, args }] });
        from = stop;
        continue;
      }
      if (text[j] === '{' || text[j] === '[') {
        const end = findBalancedEnd(text, j);
        const stop = end < 0 ? text.length : end;
        const calls = tryParseCalls(text.slice(j, stop), known);
        if (calls.length && !taken(idx, stop)) matches.push({ start: idx, end: stop, calls });
        from = stop;
      }
    }
  }

  // 6. Fenced JSON blocks naming a known tool
  if (known && known.size) {
    const re = /```(?:json|tool_call|tool|javascript|js)?\s*\n([\s\S]*?)\n?```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (taken(m.index, m.index + m[0].length)) continue;
      const body = m[1]!.trim();
      if (!body.startsWith('{') && !body.startsWith('[')) continue;
      const calls = tryParseCalls(body, known).filter((c) => known.has(c.name));
      if (calls.length) matches.push({ start: m.index, end: m.index + m[0].length, calls });
    }
  }

  // 7. gpt-oss "harmony" tokens: <|channel|>commentary to=functions.NAME <|constrain|>json<|message|>{...}<|call|>
  {
    const re = /(?:<\|start\|>assistant)?<\|channel\|>[^<]*?\bto=(?:functions\.)?([\w.-]+)[^<]*?(?:<\|constrain\|>[^<]*)?<\|message\|>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      let j = m.index + m[0].length;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      const end = text[j] === '{' ? findBalancedEnd(text, j) : -1;
      const stop = end < 0 ? text.length : end;
      let args: unknown = {};
      try {
        args = parseJsonLenient(text.slice(j, stop));
      } catch {
        // ignore
      }
      const closing = /^\s*(?:<\|call\|>|<\|end\|>)/.exec(text.slice(stop));
      const tail = stop + (closing ? closing[0].length : 0);
      if (!taken(m.index, tail)) matches.push({ start: m.index, end: tail, calls: [{ name: m[1]!, args }] });
    }
  }

  // 8. The whole reply is a bare JSON call object
  if (!matches.length && known && known.size) {
    const t = text.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      const calls = tryParseCalls(t, known).filter((c) => known.has(c.name));
      if (calls.length) matches.push({ start: text.indexOf(t), end: text.indexOf(t) + t.length, calls });
    }
  }

  if (!matches.length) return { text, toolCalls: [] };
  matches.sort((a, b) => a.start - b.start);
  let rest = '';
  let last = 0;
  const toolCalls: ToolCall[] = [];
  for (const m of matches) {
    rest += text.slice(last, m.start);
    last = m.end;
    for (const c of m.calls) {
      toolCalls.push({ id: newToolCallId(), name: c.name, arguments: JSON.stringify(c.args ?? {}) });
    }
  }
  rest += text.slice(last);
  // Remove leftover protocol tokens (and gpt-oss "analysis" thinking, which is not meant to be shown).
  rest = rest
    .replace(/<\|channel\|>\s*analysis\s*<\|message\|>[\s\S]*?(?:<\|end\|>|$)/g, '')
    .replace(/<\|(?:start|end|message|channel|call|return|constrain)\|>(?:assistant|final)?/g, '')
    .replace(/<\|tool_calls_section_begin\|>|<\|tool_calls_section_end\|>|<｜tool▁calls▁begin｜>|<｜tool▁calls▁end｜>|<\/?tool_calls?>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: rest, toolCalls };
}

/** True if the text might contain a tool call (cheap pre-check). */
export function mightContainToolCall(text: string): boolean {
  return /<tool_call>|<function=|\[TOOL_CALLS\]|<\|python_tag\|>|<\|tool_call_begin\|>|tool▁call|<\|channel\|>|"name"\s*:|"tool"\s*:/.test(text);
}
