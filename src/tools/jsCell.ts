// Rewrites a JavaScript cell for the REPL tool's Node runtime, so that running a cell again does not
// throw "already declared" and top-level await works inside a vm Script. Uses a small scanner, not a
// full parser: it only needs to know what sits at the top level of the cell.

type Kind = 'name' | 'punct' | 'string' | 'template' | 'regex' | 'number';

export interface Token {
  kind: Kind;
  value: string;
  start: number;
  end: number;
  /** Bracket depth; 0 is the top level of the cell. */
  depth: number;
  /** A line break comes before this token. */
  nl: boolean;
}

const OPERATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
// Words after which an expression is not finished yet.
const OPEN_WORDS = new Set(['typeof', 'void', 'delete', 'new', 'await', 'yield', 'return', 'throw', 'case', 'in', 'of', 'instanceof', 'extends']);
// Tokens that continue the previous line's expression when a line starts with them.
const CONTINUES = new Set([...OPERATORS.filter((o) => o !== '...' && o !== '++' && o !== '--'), '.', ',', '(', '[', '=', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '?', ':']);
// Statements that cannot be turned into `return (...)`.
const STATEMENT_WORDS = new Set(['var', 'let', 'const', 'class', 'function', 'if', 'else', 'for', 'while', 'do', 'try', 'catch', 'finally', 'switch', 'case', 'default', 'return', 'throw', 'break', 'continue', 'import', 'export', 'debugger', 'with']);

const isSpace = (ch: string) => /\s/.test(ch);
const isIdent = (ch: string | undefined) => ch !== undefined && /[\w$\u0080-\uffff]/.test(ch) && !isSpace(ch);
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= '0' && ch <= '9';

function skipString(code: string, i: number): number {
  const quote = code[i];
  for (i++; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\') i++;
    else if (ch === quote) return i + 1;
    else if (ch === '\n') return i;
  }
  return code.length;
}

function skipTemplate(code: string, i: number): number {
  for (i++; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\') i++;
    else if (ch === '`') return i + 1;
    else if (ch === '$' && code[i + 1] === '{') i = scan(code, i + 2, true) - 1;
  }
  return code.length;
}

function skipRegex(code: string, i: number): number {
  let inClass = false;
  for (i++; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\') i++;
    else if (ch === '\n') return i;
    else if (inClass) inClass = ch !== ']';
    else if (ch === '[') inClass = true;
    else if (ch === '/') {
      i++;
      break;
    }
  }
  while (i < code.length && isIdent(code[i])) i++;
  return i;
}

function regexAllowed(prev: { kind: Kind; value: string } | null): boolean {
  if (!prev) return true;
  if (prev.kind === 'name') return REGEX_AFTER.has(prev.value);
  if (prev.kind === 'punct') return ![')', ']', '}', '++', '--'].includes(prev.value);
  return false;
}

/** Scans from `from`. A nested scan (inside a template's `${`) stops after its closing brace. Returns the end index. */
function scan(code: string, from: number, nested: boolean, out?: Token[]): number {
  let depth = 0;
  let nl = !nested;
  let prev: { kind: Kind; value: string } | null = null;
  const add = (kind: Kind, start: number, end: number) => {
    const value = code.slice(start, end);
    out?.push({ kind, value, start, end, depth, nl });
    prev = { kind, value };
    nl = false;
  };
  let i = from;
  while (i < code.length) {
    const ch = code[i]!;
    const start = i;
    if (ch === '\n' || ch === '\u2028' || ch === '\u2029') {
      nl = true;
      i++;
    } else if (isSpace(ch)) {
      i++;
    } else if (ch === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (ch === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2);
      i = close < 0 ? code.length : close + 2;
      if (code.slice(start, i).includes('\n')) nl = true;
    } else if (ch === '"' || ch === "'") {
      i = skipString(code, i);
      add('string', start, i);
    } else if (ch === '`') {
      i = skipTemplate(code, i);
      add('template', start, i);
    } else if (ch === '/' && regexAllowed(prev)) {
      i = skipRegex(code, i);
      add('regex', start, i);
    } else if (isDigit(ch) || (ch === '.' && isDigit(code[i + 1]))) {
      i++;
      while (i < code.length && /[\w.]/.test(code[i]!)) i++;
      add('number', start, i);
    } else if (isIdent(ch) || ch === '#') {
      i++;
      while (i < code.length && isIdent(code[i])) i++;
      add('name', start, i);
    } else if (ch === '(' || ch === '[' || ch === '{') {
      add('punct', start, ++i);
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (nested && depth === 0 && ch === '}') return i + 1;
      depth = Math.max(0, depth - 1);
      add('punct', start, ++i);
    } else {
      i += (OPERATORS.find((op) => code.startsWith(op, i)) ?? ch).length;
      add('punct', start, i);
    }
  }
  return code.length;
}

export function tokenize(code: string): Token[] {
  const out: Token[] = [];
  scan(code, 0, false, out);
  return out;
}

const isPunct = (t: Token | undefined, value: string): boolean => !!t && t.kind === 'punct' && t.value === value;

function canEnd(t: Token): boolean {
  if (t.kind === 'punct') return [')', ']', '}', '++', '--'].includes(t.value);
  if (t.kind === 'name') return !OPEN_WORDS.has(t.value);
  return true;
}

function continues(t: Token): boolean {
  if (t.kind === 'punct') return CONTINUES.has(t.value);
  if (t.kind === 'name') return t.value === 'in' || t.value === 'of' || t.value === 'instanceof';
  return t.kind === 'template';
}

/** Index of the bracket that closes the one at `open`, or -1. */
function closing(tokens: Token[], open: number): number {
  const want = ({ '(': ')', '[': ']', '{': '}' } as Record<string, string>)[tokens[open]!.value];
  for (let k = open + 1; k < tokens.length; k++) {
    if (tokens[k]!.depth === tokens[open]!.depth && isPunct(tokens[k], want!)) return k;
  }
  return -1;
}

/** The statement at `k` is the unbraced body of if/for/while/else/do, so it is not top-level code. */
function isBody(tokens: Token[], k: number): boolean {
  const prev = tokens[k - 1];
  if (prev?.kind === 'name' && (prev.value === 'else' || prev.value === 'do')) return true;
  if (!prev || !isPunct(prev, ')')) return false;
  for (let j = k - 2; j >= 0; j--) {
    if (tokens[j]!.depth !== prev.depth || !isPunct(tokens[j], '(')) continue;
    const before = tokens[j - 1];
    return before?.kind === 'name' && ['if', 'for', 'while', 'with', 'await'].includes(before.value);
  }
  return false;
}

/** Indexes of the tokens that start a top-level statement (line breaks follow the usual ASI rules). */
export function statementStarts(tokens: Token[]): number[] {
  const starts: number[] = [];
  tokens.forEach((t, k) => {
    if (t.depth !== 0) return;
    const prev = tokens[k - 1];
    if (!prev || isPunct(prev, ';') || (t.nl && canEnd(prev) && !continues(t) && !isBody(tokens, k))) starts.push(k);
  });
  return starts;
}

/** Names bound by a destructuring pattern between the brackets at `open` and `close`. */
function patternNames(tokens: Token[], open: number, close: number): string[] {
  const names: string[] = [];
  const d = tokens[open]!.depth + 1;
  const isObject = tokens[open]!.value === '{';
  const nextItem = (k: number) => {
    while (k < close && !(isPunct(tokens[k], ',') && tokens[k]!.depth === d)) k++;
    return k + 1;
  };
  let k = open + 1;
  while (k < close) {
    if (isPunct(tokens[k], ',')) {
      k++;
      continue;
    }
    const rest = isPunct(tokens[k], '...');
    if (rest) k++;
    let target = k;
    if (isObject && !rest) {
      const keyEnd = isPunct(tokens[k], '[') ? closing(tokens, k) : k;
      if (keyEnd < 0) return names;
      if (!isPunct(tokens[keyEnd + 1], ':')) {
        // Shorthand property: the key is the name.
        if (tokens[k]!.kind === 'name') names.push(tokens[k]!.value);
        k = nextItem(keyEnd + 1);
        continue;
      }
      target = keyEnd + 2;
    }
    const t = tokens[target];
    if (t?.kind === 'name') names.push(t.value);
    else if (t && (isPunct(t, '{') || isPunct(t, '['))) {
      const end = closing(tokens, target);
      if (end < 0) return names;
      names.push(...patternNames(tokens, target, end));
      target = end;
    }
    k = nextItem(target + 1);
  }
  return names;
}

interface Declaration {
  names: string[];
  /** Last token of the statement (before any `;`). */
  last: number;
  /** Index of the closing `;`, or -1 when the statement ends at a line break. */
  semicolon: number;
}

/** Parses `var|let|const` declarators starting at token `k`. */
function declaration(tokens: Token[], k: number): Declaration | null {
  const names: string[] = [];
  let j = k + 1;
  for (;;) {
    const t = tokens[j];
    if (!t || t.depth !== 0) return null;
    if (t.kind === 'name') {
      names.push(t.value);
      j++;
    } else if (isPunct(t, '{') || isPunct(t, '[')) {
      const close = closing(tokens, j);
      if (close < 0) return null;
      names.push(...patternNames(tokens, j, close));
      j = close + 1;
    } else return null;
    if (isPunct(tokens[j], '=')) {
      for (j++; j < tokens.length; j++) {
        const u = tokens[j]!;
        if (u.depth === 0 && (isPunct(u, ',') || isPunct(u, ';') || (u.nl && canEnd(tokens[j - 1]!) && !continues(u)))) break;
      }
    }
    const u = tokens[j];
    if (isPunct(u, ',')) {
      j++;
      continue;
    }
    return isPunct(u, ';') ? { names, last: j - 1, semicolon: j } : { names, last: j - 1, semicolon: -1 };
  }
}

/** Index of the `{` that opens the body of the class declared at `k`, or -1. */
function classBody(tokens: Token[], k: number): number {
  for (let j = k + 1; j < tokens.length; j++) {
    if (tokens[j]!.depth !== 0) continue;
    if (isPunct(tokens[j], '{')) return j;
    if (isPunct(tokens[j], ';')) return -1;
  }
  return -1;
}

interface Edit {
  at: number;
  end: number;
  text: string;
}

function applyEdits(code: string, edits: Edit[]): string {
  let out = code;
  for (const e of [...edits].sort((a, b) => b.at - a.at || b.end - a.end)) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return out;
}

/**
 * Top-level `const`/`let` become `var` (padded so columns stay put) and `class X {}` becomes
 * `var X = class X {};`, so a cell can run again without "Identifier has already been declared".
 */
export function redeclarable(code: string, tokens = tokenize(code)): string {
  const edits: Edit[] = [];
  for (const k of statementStarts(tokens)) {
    const t = tokens[k]!;
    const next = tokens[k + 1];
    if (t.kind !== 'name' || !next) continue;
    if ((t.value === 'const' || t.value === 'let') && (next.kind === 'name' || isPunct(next, '[') || isPunct(next, '{'))) {
      edits.push({ at: t.start, end: t.end, text: t.value === 'const' ? 'var  ' : 'var' });
    } else if (t.value === 'class' && next.kind === 'name' && next.value !== 'extends') {
      const body = classBody(tokens, k);
      const close = body < 0 ? -1 : closing(tokens, body);
      if (close < 0) continue;
      edits.push({ at: t.start, end: t.start, text: `var ${next.value} = ` }, { at: tokens[close]!.end, end: tokens[close]!.end, text: ';' });
    }
  }
  return applyEdits(code, edits);
}

export interface AsyncCell {
  /** `(async () => {...})()`; the cell's own lines start on line 2. */
  source: string;
  /** Names to declare with `var` on the context first, so the assignments inside persist. */
  declare: string[];
}

/**
 * Wraps a cell that uses top-level await in an async function. With `hoist`, top-level declarations
 * become assignments to context globals so they outlive the function; with `returnLast`, the last
 * expression statement is returned as the cell's value.
 */
export function asyncCell(code: string, opts: { hoist: boolean; returnLast: boolean }, tokens = tokenize(code)): AsyncCell {
  const edits: Edit[] = [];
  const declare: string[] = [];
  const functions: string[] = [];
  const starts = statementStarts(tokens);
  if (opts.hoist) {
    for (const k of starts) {
      const t = tokens[k]!;
      if (t.kind !== 'name') continue;
      if (t.value === 'var' || t.value === 'let' || t.value === 'const') {
        const decl = declaration(tokens, k);
        if (!decl) continue;
        declare.push(...decl.names);
        // `const {a} = b` turns into `;(    {a} = b);` and keeps its line and columns.
        edits.push({ at: t.start, end: t.end, text: ';(' + ' '.repeat(t.value.length - 2) });
        const at = decl.semicolon >= 0 ? tokens[decl.semicolon]!.start : tokens[decl.last]!.end;
        edits.push({ at, end: at, text: decl.semicolon >= 0 ? ')' : ');' });
      } else if (t.value === 'class' && tokens[k + 1]?.kind === 'name' && tokens[k + 1]!.value !== 'extends') {
        const name = tokens[k + 1]!.value;
        const body = classBody(tokens, k);
        const close = body < 0 ? -1 : closing(tokens, body);
        if (close < 0) continue;
        declare.push(name);
        edits.push({ at: t.start, end: t.start, text: `;${name} = ` }, { at: tokens[close]!.end, end: tokens[close]!.end, text: ';' });
      } else if (t.value === 'function' || (t.value === 'async' && tokens[k + 1]?.value === 'function')) {
        // Function declarations stay (they are hoisted) and are also copied to the context.
        let j = t.value === 'async' ? k + 2 : k + 1;
        if (isPunct(tokens[j], '*')) j++;
        if (tokens[j]?.kind === 'name') functions.push(tokens[j]!.value);
      }
    }
  }
  if (opts.returnLast && starts.length) {
    const k = starts[starts.length - 1]!;
    const t = tokens[k]!;
    const label = t.kind === 'name' && isPunct(tokens[k + 1], ':');
    const statement = t.kind === 'name' && (STATEMENT_WORDS.has(t.value) || (t.value === 'async' && tokens[k + 1]?.value === 'function'));
    if (!label && !statement && !isPunct(t, ';')) {
      const last = tokens[tokens.length - 1]!;
      const at = isPunct(last, ';') && last.depth === 0 ? last.start : last.end;
      edits.push({ at: t.start, end: t.start, text: 'return (' }, { at, end: at, text: ')' });
    }
  }
  const exports = functions.map((n) => `globalThis.${n} = ${n};`).join(' ');
  return { source: `(async () => { ${exports}\n${applyEdits(code, edits)}\n})()`, declare: [...new Set(declare)] };
}

export interface CellVariant {
  source: string;
  /** For vm.Script, so error positions point at the user's lines. */
  lineOffset: number;
  /** Names to declare with `var` on the context before running. */
  declare: string[];
  /** The script evaluates to a promise to await (top-level await). */
  isAsync: boolean;
}

/**
 * Ways to run a cell, best first. The runtime uses the first one that compiles; when none does,
 * the error of the last one (closest to what the user wrote) is reported.
 */
export function cellVariants(code: string): CellVariant[] {
  const tokens = tokenize(code);
  const variants: CellVariant[] = [{ source: redeclarable(code, tokens), lineOffset: 0, declare: [], isAsync: false }];
  const plain: CellVariant = { source: code, lineOffset: 0, declare: [], isAsync: false };
  if (!/\bawait\b/.test(code)) return [...variants, plain];
  for (const opts of [{ hoist: true, returnLast: true }, { hoist: true, returnLast: false }]) {
    const a = asyncCell(code, opts, tokens);
    variants.push({ source: a.source, lineOffset: -1, declare: a.declare, isAsync: true });
  }
  const bare = asyncCell(code, { hoist: false, returnLast: false }, tokens);
  return [...variants, plain, { source: bare.source, lineOffset: -1, declare: [], isAsync: true }];
}
