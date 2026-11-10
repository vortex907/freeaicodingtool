// Lenient JSON parsing for model-generated tool arguments.
// Accepts: trailing commas, comments, single quotes, unquoted keys, Python literals,
// raw newlines inside strings, unescaped quotes (heuristically), and truncated input.

export class JsonRepairError extends Error {}

export function parseJsonLenient(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed) throw new JsonRepairError('empty input');
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to the lenient parser
  }
  const stripped = stripCodeFence(trimmed);
  if (stripped !== trimmed) {
    try {
      return JSON.parse(stripped);
    } catch {
      // continue
    }
  }
  const p = new LenientParser(stripped);
  return p.parseTop();
}

/** Parses tool arguments; always returns an object (wrapping non-objects). */
export function parseToolArguments(raw: string | Record<string, unknown> | undefined | null): { value: Record<string, unknown>; repaired: boolean; error?: string } {
  if (raw === undefined || raw === null) return { value: {}, repaired: false };
  if (typeof raw === 'object') return { value: raw, repaired: false };
  const text = raw.trim();
  if (!text) return { value: {}, repaired: false };
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v as Record<string, unknown>, repaired: false };
    if (typeof v === 'string') {
      // Double-encoded JSON string
      try {
        const inner = JSON.parse(v);
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) return { value: inner as Record<string, unknown>, repaired: true };
      } catch {
        // not double encoded
      }
    }
    return { value: { value: v }, repaired: true };
  } catch {
    // try lenient
  }
  try {
    const v = parseJsonLenient(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v as Record<string, unknown>, repaired: true };
    return { value: { value: v }, repaired: true };
  } catch (e) {
    return { value: {}, repaired: false, error: (e as Error).message };
  }
}

export function stripCodeFence(s: string): string {
  const m = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(s.trim());
  return m ? m[1]! : s;
}

/** Finds the end index (exclusive) of a balanced JSON object/array starting at `start`, or -1. */
export function findBalancedEnd(s: string, start: number): number {
  const open = s[start];
  if (open !== '{' && open !== '[') return -1;
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"') inStr = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

class LenientParser {
  private i = 0;
  constructor(private s: string) {}

  parseTop(): unknown {
    this.skipWs();
    // Skip any leading prose before the first JSON value.
    if (this.i < this.s.length && !'{["\'0123456789-tfnTFN'.includes(this.s[this.i]!)) {
      const brace = this.s.search(/[{[]/);
      if (brace < 0) throw new JsonRepairError('no JSON value found');
      this.i = brace;
    }
    const v = this.parseValue();
    return v;
  }

  private peek(): string | undefined {
    return this.s[this.i];
  }

  private skipWs(): void {
    while (this.i < this.s.length) {
      const ch = this.s[this.i]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '﻿') {
        this.i++;
      } else if (ch === '/' && this.s[this.i + 1] === '/') {
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
      } else if (ch === '/' && this.s[this.i + 1] === '*') {
        const end = this.s.indexOf('*/', this.i + 2);
        this.i = end < 0 ? this.s.length : end + 2;
      } else if (ch === '#' && this.atLineStart()) {
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
      } else break;
    }
  }

  private atLineStart(): boolean {
    let j = this.i - 1;
    while (j >= 0 && (this.s[j] === ' ' || this.s[j] === '\t')) j--;
    return j < 0 || this.s[j] === '\n';
  }

  private parseValue(): unknown {
    this.skipWs();
    const ch = this.peek();
    if (ch === undefined) return null;
    if (ch === '{') return this.parseObject();
    if (ch === '[') return this.parseArray();
    if (ch === '"' || ch === "'" || ch === '`' || ch === '“' || ch === '‘') return this.parseString();
    if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9')) return this.parseNumber();
    const word = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i))?.[0];
    if (word) {
      this.i += word.length;
      switch (word) {
        case 'true':
        case 'True':
          return true;
        case 'false':
        case 'False':
          return false;
        case 'null':
        case 'None':
        case 'undefined':
        case 'NaN':
        case 'nil':
          return null;
        case 'Infinity':
          return null;
        default:
          // Unquoted string value: read until a delimiter.
          return word + this.readBareRest();
      }
    }
    throw new JsonRepairError(`unexpected character '${ch}' at ${this.i}`);
  }

  private readBareRest(): string {
    let out = '';
    while (this.i < this.s.length && !',}]\n'.includes(this.s[this.i]!)) out += this.s[this.i++];
    return out.trimEnd();
  }

  private parseObject(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    this.i++; // {
    for (;;) {
      this.skipWs();
      const ch = this.peek();
      if (ch === undefined) return obj; // truncated
      if (ch === '}') {
        this.i++;
        return obj;
      }
      if (ch === ',') {
        this.i++;
        continue;
      }
      let key: string;
      if (ch === '"' || ch === "'" || ch === '`' || ch === '“' || ch === '‘') key = this.parseString(true);
      else {
        const m = /^[^:=\s,}]+/.exec(this.s.slice(this.i));
        if (!m) throw new JsonRepairError(`bad key at ${this.i}`);
        key = m[0];
        this.i += key.length;
      }
      this.skipWs();
      if (this.peek() === ':' || this.peek() === '=') this.i++;
      else if (this.peek() === undefined) {
        obj[key] = null;
        return obj;
      }
      const value = this.parseValue();
      obj[key] = value;
      this.skipWs();
      if (this.peek() === ',') this.i++;
    }
  }

  private parseArray(): unknown[] {
    const arr: unknown[] = [];
    this.i++; // [
    for (;;) {
      this.skipWs();
      const ch = this.peek();
      if (ch === undefined) return arr;
      if (ch === ']') {
        this.i++;
        return arr;
      }
      if (ch === ',') {
        this.i++;
        continue;
      }
      if (ch === '}') {
        // mismatched bracket: treat as end of array
        this.i++;
        return arr;
      }
      arr.push(this.parseValue());
    }
  }

  private parseString(isKey = false): string {
    let quote = this.s[this.i]!;
    if (quote === '“') quote = '”';
    if (quote === '‘') quote = '’';
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const ch = this.s[this.i]!;
      if (ch === '\\') {
        const n = this.s[this.i + 1];
        this.i += 2;
        switch (n) {
          case 'n':
            out += '\n';
            break;
          case 't':
            out += '\t';
            break;
          case 'r':
            out += '\r';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'u': {
            const hex = this.s.slice(this.i, this.i + 4);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              out += String.fromCharCode(parseInt(hex, 16));
              this.i += 4;
            } else out += 'u';
            break;
          }
          case undefined:
            break;
          default:
            out += n; // \" \' \\ \/ and invalid escapes like \$
        }
        continue;
      }
      if (ch === quote || (quote === '"' && ch === '”')) {
        if (isKey || this.looksLikeStringEnd(this.i + 1)) {
          this.i++;
          return out;
        }
        out += ch;
        this.i++;
        continue;
      }
      out += ch;
      this.i++;
    }
    return out; // truncated string
  }

  /** Heuristic: is the quote at position i-1 really the end of the string? */
  private looksLikeStringEnd(pos: number): boolean {
    let j = pos;
    while (j < this.s.length && (this.s[j] === ' ' || this.s[j] === '\t' || this.s[j] === '\r' || this.s[j] === '\n')) j++;
    if (j >= this.s.length) return true;
    const ch = this.s[j]!;
    if (ch === ':' || ch === ']') return true;
    if (ch === '}') {
      // `}` right after a quote is usually the end of the object.
      return true;
    }
    if (ch === ',') {
      // Next thing after the comma should be a key, a value start or a closing bracket.
      let k = j + 1;
      while (k < this.s.length && /\s/.test(this.s[k]!)) k++;
      if (k >= this.s.length) return true;
      const rest = this.s.slice(k, k + 200);
      if (/^["'][^"'\n]{0,100}["']\s*:/.test(rest)) return true; // "key":
      if (/^[A-Za-z_$][\w$]*\s*:/.test(rest)) return true; // key:
      if (/^[}\]]/.test(rest)) return true;
      if (/^["'[{\d-]|^(true|false|null)\b/.test(rest)) return true; // array element
      return false;
    }
    return false;
  }

  private parseNumber(): number | string {
    const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(this.s.slice(this.i));
    if (!m) {
      this.i++;
      return 0;
    }
    this.i += m[0].length;
    const n = Number(m[0]);
    return isNaN(n) ? m[0] : n;
  }
}
