// PDF text for the Read tool. pdftotext (poppler) is used when it is installed; otherwise a small built-in
// reader handles ordinary text PDFs: Flate (and LZW, ASCII hex/85) streams, object streams, simple fonts
// (WinAnsi, Differences) and fonts with ToUnicode maps. Pages that are only images are reported as scanned.
import { execFile } from 'node:child_process';
import { inflateRawSync, inflateSync, constants as zlibConstants } from 'node:zlib';
import { which } from '../util/platform.js';

/** Pages read per call at most; the caller's size limit usually stops earlier. */
const MAX_PAGES_PER_READ = 100;
/** The built-in reader holds the whole file in memory. */
const MAX_BUILTIN_BYTES = 50 * 1024 * 1024;

export interface PdfPage {
  number: number;
  text: string;
}

export interface PdfRead {
  total: number;
  pages: PdfPage[];
  /** Requested pages left out (size limit or page cap). */
  remaining: number[];
  /** Set when none of the returned pages has text: why. */
  noText?: 'scanned' | 'fonts' | 'empty';
  via: 'pdftotext' | 'builtin';
}

// ------------------------------------------------------------------ objects and lexer

class Name {
  constructor(readonly name: string) {}
}

class Ref {
  constructor(readonly num: number) {}
}

class Stream {
  constructor(
    readonly dict: Dict,
    readonly raw: Buffer,
  ) {}
}

type Dict = Map<string, PdfValue>;
/** PDF strings are kept as latin1 JS strings (one char per byte). */
type PdfValue = number | boolean | null | string | Name | Ref | Stream | Dict | PdfValue[];

type Tok = { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'name'; v: string } | { k: 'kw'; v: string } | { k: 'sym'; v: string };

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

function isSpace(c: number): boolean {
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
}

function isDelim(c: number): boolean {
  // ( ) < > [ ] { } / %
  return c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
}

class Lexer {
  constructor(
    readonly s: string,
    public pos = 0,
  ) {}

  next(): Tok | null {
    const s = this.s;
    for (;;) {
      while (this.pos < s.length && isSpace(s.charCodeAt(this.pos))) this.pos++;
      if (this.pos >= s.length) return null;
      const c = s[this.pos]!;
      if (c === '%') {
        while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++;
        continue;
      }
      if (c === '/') return { k: 'name', v: this.name() };
      if (c === '(') return { k: 'str', v: this.literal() };
      if (c === '<') {
        if (s[this.pos + 1] === '<') {
          this.pos += 2;
          return { k: 'sym', v: '<<' };
        }
        return { k: 'str', v: this.hex() };
      }
      if (c === '>' && s[this.pos + 1] === '>') {
        this.pos += 2;
        return { k: 'sym', v: '>>' };
      }
      if (c === '[' || c === ']' || c === '{' || c === '}') {
        this.pos++;
        return { k: 'sym', v: c };
      }
      if (c === ')' || c === '>') {
        this.pos++; // stray delimiter
        continue;
      }
      const start = this.pos;
      while (this.pos < s.length && !isSpace(s.charCodeAt(this.pos)) && !isDelim(s.charCodeAt(this.pos))) this.pos++;
      const word = s.slice(start, this.pos);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { k: 'num', v: parseFloat(word) };
      return { k: 'kw', v: word };
    }
  }

  private name(): string {
    const s = this.s;
    let i = this.pos + 1;
    let out = '';
    while (i < s.length && !isSpace(s.charCodeAt(i)) && !isDelim(s.charCodeAt(i))) {
      if (s[i] === '#' && /^[0-9a-fA-F]{2}$/.test(s.substr(i + 1, 2))) {
        out += String.fromCharCode(parseInt(s.substr(i + 1, 2), 16));
        i += 3;
      } else out += s[i++];
    }
    this.pos = i;
    return out;
  }

  private literal(): string {
    const s = this.s;
    let i = this.pos + 1;
    let depth = 1;
    let out = '';
    while (i < s.length) {
      const c = s[i]!;
      if (c === '\\') {
        const d = s[i + 1];
        if (d === undefined) {
          i++;
          break;
        }
        if (ESCAPES[d] !== undefined) {
          out += ESCAPES[d];
          i += 2;
        } else if (d >= '0' && d <= '7') {
          let j = i + 1;
          let oct = '';
          while (j < s.length && oct.length < 3 && s[j]! >= '0' && s[j]! <= '7') oct += s[j++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
          i = j;
        } else if (d === '\r') i += s[i + 2] === '\n' ? 3 : 2; // line continuation
        else if (d === '\n') i += 2;
        else {
          out += d;
          i += 2;
        }
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) {
        i++;
        break;
      }
      out += c;
      i++;
    }
    this.pos = i;
    return out;
  }

  private hex(): string {
    const end = this.s.indexOf('>', this.pos + 1);
    const stop = end < 0 ? this.s.length : end;
    let digits = this.s.slice(this.pos + 1, stop).replace(/[^0-9a-fA-F]/g, '');
    if (digits.length % 2) digits += '0';
    this.pos = stop + 1;
    let out = '';
    for (let i = 0; i < digits.length; i += 2) out += String.fromCharCode(parseInt(digits.substr(i, 2), 16));
    return out;
  }
}

/** Reads one value ("12 0 R" becomes a Ref). Returns undefined for keywords that are not values. */
function readValue(lx: Lexer, first?: Tok | null): PdfValue | undefined {
  const t = first === undefined ? lx.next() : first;
  if (!t) return undefined;
  switch (t.k) {
    case 'num': {
      const save = lx.pos;
      const t2 = lx.next();
      if (t2?.k === 'num') {
        const t3 = lx.next();
        if (t3?.k === 'kw' && t3.v === 'R') return new Ref(t.v);
      }
      lx.pos = save;
      return t.v;
    }
    case 'str':
      return t.v;
    case 'name':
      return new Name(t.v);
    case 'kw':
      return t.v === 'true' ? true : t.v === 'false' ? false : t.v === 'null' ? null : undefined;
    case 'sym': {
      if (t.v === '[') {
        const arr: PdfValue[] = [];
        for (;;) {
          const n = lx.next();
          if (!n || (n.k === 'sym' && n.v === ']')) break;
          const v = readValue(lx, n);
          if (v !== undefined) arr.push(v);
        }
        return arr;
      }
      if (t.v === '<<') {
        const d: Dict = new Map();
        for (;;) {
          const k = lx.next();
          if (!k || (k.k === 'sym' && k.v === '>>')) break;
          if (k.k !== 'name') continue;
          const vt = lx.next();
          if (!vt || (vt.k === 'sym' && vt.v === '>>')) break;
          const v = readValue(lx, vt);
          if (v !== undefined) d.set(k.v, v);
        }
        return d;
      }
      return undefined;
    }
  }
}

function nameOf(v: PdfValue | undefined): string | undefined {
  return v instanceof Name ? v.name : undefined;
}

function asDict(v: PdfValue | undefined): Dict | undefined {
  if (v instanceof Map) return v;
  if (v instanceof Stream) return v.dict;
  return undefined;
}

// ------------------------------------------------------------------ stream filters

function inflate(data: Buffer): Buffer | null {
  try {
    return inflateSync(data);
  } catch {
    // Truncated or slightly damaged streams still give most of their text.
  }
  for (const f of [inflateSync, inflateRawSync]) {
    try {
      return f(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    } catch {
      // try the next
    }
  }
  return null;
}

function asciiHex(data: Buffer): Buffer {
  const s = data.toString('latin1');
  const end = s.indexOf('>');
  let digits = (end < 0 ? s : s.slice(0, end)).replace(/[^0-9a-fA-F]/g, '');
  if (digits.length % 2) digits += '0';
  return Buffer.from(digits, 'hex');
}

function ascii85(data: Buffer): Buffer {
  let s = data.toString('latin1').replace(/\s+/g, '');
  if (s.startsWith('<~')) s = s.slice(2);
  const end = s.indexOf('~>');
  if (end >= 0) s = s.slice(0, end);
  const out: number[] = [];
  let group: number[] = [];
  const flush = (n: number) => {
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [Math.floor(v / 2 ** 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n));
  };
  for (const ch of s) {
    if (ch === 'z' && !group.length) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) {
      flush(4);
      group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length - 1;
    while (group.length < 5) group.push(84);
    flush(n);
  }
  return Buffer.from(out);
}

function lzw(data: Buffer): Buffer {
  const out: number[] = [];
  let table: number[][] = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < 258; i++) table.push(i < 256 ? [i] : []);
  };
  reset();
  let width = 9;
  let acc = 0;
  let nbits = 0;
  let prev: number[] | null = null;
  for (const byte of data) {
    acc = (acc << 8) | byte;
    nbits += 8;
    while (nbits >= width) {
      const code = (acc >> (nbits - width)) & ((1 << width) - 1);
      nbits -= width;
      acc &= (1 << nbits) - 1;
      if (code === 256) {
        reset();
        width = 9;
        prev = null;
        continue;
      }
      if (code === 257) return Buffer.from(out);
      let entry: number[];
      if (code < table.length && table[code]!.length) entry = table[code]!;
      else if (prev && code === table.length) entry = [...prev, prev[0]!];
      else return Buffer.from(out);
      for (const b of entry) out.push(b);
      if (prev) table.push([...prev, entry[0]!]);
      prev = entry;
      // Early change: the code width grows one code before the table fills up.
      if (table.length + 1 >= 1 << width && width < 12) width++;
    }
  }
  return Buffer.from(out);
}

// ------------------------------------------------------------------ fonts and encodings

/** WinAnsi (cp1252) byte to text; also the fallback for StandardEncoding and MacRoman in the ASCII range. */
const WIN_ANSI: (string | undefined)[] = (() => {
  const high: Record<number, string> = {
    0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e', 0x85: '\u2026', 0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02c6',
    0x89: '\u2030', 0x8a: '\u0160', 0x8b: '\u2039', 0x8c: '\u0152', 0x8e: '\u017d', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201c',
    0x94: '\u201d', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014', 0x98: '\u02dc', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a',
    0x9c: '\u0153', 0x9e: '\u017e', 0x9f: '\u0178',
  };
  const t: (string | undefined)[] = [];
  for (let c = 0; c < 256; c++) {
    if (c < 32) t.push(c === 9 || c === 10 || c === 13 ? String.fromCharCode(c) : undefined);
    else if (c < 127) t.push(String.fromCharCode(c));
    else if (c < 0xa0) t.push(high[c]);
    else t.push(String.fromCharCode(c));
  }
  return t;
})();

const GLYPHS: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', zero: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';',
  less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']',
  asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  quoteleft: '\u2018', quoteright: '\u2019', quotedblleft: '\u201c', quotedblright: '\u201d', quotesinglbase: '\u201a',
  quotedblbase: '\u201e', endash: '\u2013', emdash: '\u2014', bullet: '\u2022', ellipsis: '\u2026', dagger: '\u2020',
  daggerdbl: '\u2021', perthousand: '\u2030', guillemotleft: '\u00ab', guillemotright: '\u00bb', guilsinglleft: '\u2039',
  guilsinglright: '\u203a', exclamdown: '\u00a1', questiondown: '\u00bf', cent: '\u00a2', sterling: '\u00a3', yen: '\u00a5',
  Euro: '\u20ac', florin: '\u0192', section: '\u00a7', paragraph: '\u00b6', copyright: '\u00a9', registered: '\u00ae',
  trademark: '\u2122', degree: '\u00b0', plusminus: '\u00b1', multiply: '\u00d7', divide: '\u00f7', minus: '\u2212',
  periodcentered: '\u00b7', mu: '\u00b5', germandbls: '\u00df', ae: '\u00e6', AE: '\u00c6', oe: '\u0153', OE: '\u0152',
  oslash: '\u00f8', Oslash: '\u00d8', dotlessi: '\u0131', lslash: '\u0142', Lslash: '\u0141', eth: '\u00f0', Eth: '\u00d0',
  thorn: '\u00fe', Thorn: '\u00de', ordfeminine: '\u00aa', ordmasculine: '\u00ba', onehalf: '\u00bd', onequarter: '\u00bc',
  threequarters: '\u00be', nbspace: '\u00a0', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl',
};

const ACCENTS: Record<string, string> = {
  grave: '\u0300', acute: '\u0301', circumflex: '\u0302', tilde: '\u0303', macron: '\u0304', breve: '\u0306', dotaccent: '\u0307',
  dieresis: '\u0308', ring: '\u030a', hungarumlaut: '\u030b', caron: '\u030c', cedilla: '\u0327', ogonek: '\u0328',
};

/** Unicode text for a glyph name (Adobe glyph list basics, uniXXXX and accented letters). */
function glyphToUnicode(name: string): string | undefined {
  if (/^[A-Za-z]$/.test(name)) return name;
  if (GLYPHS[name] !== undefined) return GLYPHS[name];
  let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(name);
  if (m) return m[1]!.match(/.{4}/g)!.map((h) => String.fromCharCode(parseInt(h, 16))).join('');
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1]!, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : undefined;
  }
  const accent = ACCENTS[name.slice(1)];
  if (accent && /^[A-Za-z]/.test(name)) return (name[0] + accent).normalize('NFC');
  if (name.includes('.')) return glyphToUnicode(name.split('.')[0]!);
  if (name.includes('_')) {
    const parts = name.split('_').map(glyphToUnicode);
    return parts.every((p) => p !== undefined) ? parts.join('') : undefined;
  }
  return undefined;
}

/** Helvetica widths (1/1000 em) for codes 32-126: an estimate for fonts that come without a width table. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 222, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278,
  584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667,
  944, 667, 667, 611, 278, 278, 278, 469, 556, 222, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333,
  500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

function utf16(hex: string): string {
  if (hex.length <= 2) return hex ? String.fromCharCode(parseInt(hex, 16)) : '';
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
  return out;
}

/** Parses a ToUnicode CMap: code -> text, plus the code length from its codespace range. */
export function parseCMap(src: string): { map: Map<number, string>; bytes?: 1 | 2 } {
  const map = new Map<number, string>();
  let bytes: 1 | 2 | undefined;
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(src);
  const firstCode = cs && /<([0-9a-fA-F]+)>/.exec(cs[1]!);
  if (firstCode) bytes = firstCode[1]!.length <= 2 ? 1 : 2;
  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1]!, 16), utf16(m[2]!));
  }
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1]!, 16);
      const hi = Math.min(parseInt(m[2]!, 16), lo + 0xffff);
      if (m[3] !== undefined) {
        const dst = utf16(m[3]);
        if (!dst) continue;
        const units = Array.from({ length: dst.length }, (_, i) => dst.charCodeAt(i));
        for (let c = lo; c <= hi && map.size < 200_000; c++) {
          const u = units.slice();
          u[u.length - 1] += c - lo;
          map.set(c, String.fromCharCode(...u));
        }
      } else {
        [...m[4]!.matchAll(/<([0-9a-fA-F]*)>/g)].forEach((x, i) => {
          if (lo + i <= hi) map.set(lo + i, utf16(x[1]!));
        });
      }
    }
  }
  return { map, bytes };
}

interface FontInfo {
  /** Type0 (CID) font: two-byte codes, no built-in encoding. */
  composite: boolean;
  codeBytes: 1 | 2;
  decode(code: number): string | undefined;
  /** Advance width in 1/1000 em. */
  width(code: number): number;
}

// ------------------------------------------------------------------ text layout

interface GState {
  ctm: number[];
  tm: number[];
  tlm: number[];
  font?: FontInfo;
  fs: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

function mul(m: number[], n: number[]): number[] {
  return [
    m[0]! * n[0]! + m[1]! * n[2]!,
    m[0]! * n[1]! + m[1]! * n[3]!,
    m[2]! * n[0]! + m[3]! * n[2]!,
    m[2]! * n[1]! + m[3]! * n[3]!,
    m[4]! * n[0]! + m[5]! * n[2]! + n[4]!,
    m[4]! * n[1]! + m[5]! * n[3]! + n[5]!,
  ];
}

function translate(m: number[], tx: number, ty: number): number[] {
  return [m[0]!, m[1]!, m[2]!, m[3]!, tx * m[0]! + ty * m[2]! + m[4]!, tx * m[1]! + ty * m[3]! + m[5]!];
}

function cloneState(g: GState): GState {
  return { ...g, ctm: g.ctm.slice(), tm: g.tm.slice(), tlm: g.tlm.slice() };
}

/** Collects the text of a page, adding spaces and line breaks from the positions of the text runs. */
class TextSink {
  out = '';
  lastX: number | null = null;
  lastY: number | null = null;
  hasImages = false;
  undecodable = false;

  put(text: string, x: number, y: number, em: number): void {
    if (this.lastX !== null && this.lastY !== null) {
      const dy = Math.abs(y - this.lastY);
      if (dy > em * 0.6) this.out += dy > em * 2.5 ? '\n\n' : '\n';
      else if ((x - this.lastX > em * 0.15 || this.lastX - x > em * 1.5) && !/\s$/.test(this.out) && !/^\s/.test(text)) this.out += ' ';
    }
    this.out += text;
  }
}

const LIGATURES: Record<string, string> = { '\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi', '\ufb04': 'ffl', '\ufb05': 'st', '\ufb06': 'st' };

function tidy(text: string): string {
  return text
    .replace(/[\ufb00-\ufb06]/g, (c) => LIGATURES[c] ?? c)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ------------------------------------------------------------------ document

export interface BuiltinPage {
  text: string;
  hasImages: boolean;
  undecodable: boolean;
}

export class PdfDocument {
  private s: string;
  private objects = new Map<number, PdfValue>();
  private trailers: { at: number; dict: Dict }[] = [];
  private fontCache = new Map<Dict, FontInfo>();
  private pageList: { dict: Dict; resources?: Dict }[] | null = null;
  readonly encrypted: boolean;

  constructor(private buf: Buffer) {
    this.s = buf.toString('latin1');
    this.scan();
    this.encrypted = this.trailers.some((t) => t.dict.has('Encrypt'));
  }

  get pageCount(): number {
    return this.pages().length;
  }

  /** Text of page `n` (1-based). */
  page(n: number): BuiltinPage {
    const p = this.pages()[n - 1];
    const sink = new TextSink();
    if (p) {
      const contents = this.resolve(p.dict.get('Contents'));
      const streams = (Array.isArray(contents) ? contents.map((c) => this.resolve(c)) : [contents]).filter((c): c is Stream => c instanceof Stream);
      const data = streams.map((st) => this.decode(st)?.toString('latin1') ?? '').join('\n');
      const state: GState = { ctm: IDENTITY.slice(), tm: IDENTITY.slice(), tlm: IDENTITY.slice(), fs: 12, tc: 0, tw: 0, th: 1, tl: 0 };
      this.run(data, p.resources, state, sink, 0, new Set());
    }
    return { text: tidy(sink.out), hasImages: sink.hasImages, undecodable: sink.undecodable };
  }

  private scan(): void {
    const s = this.s;
    const re = /(\d+)\s+\d+\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const num = Number(m[1]);
      const lx = new Lexer(s, m.index + m[0].length);
      const value = readValue(lx);
      const save = lx.pos;
      const t = lx.next();
      if (t?.k === 'kw' && t.v === 'stream' && value instanceof Map) {
        let start = lx.pos;
        if (s[start] === '\r') start++;
        if (s[start] === '\n') start++;
        const len = value.get('Length');
        let end = -1;
        if (typeof len === 'number' && len >= 0 && start + len <= s.length && /^\s*endstream/.test(s.slice(start + len, start + len + 40))) end = start + len;
        if (end < 0) {
          const e = s.indexOf('endstream', start);
          end = e < 0 ? s.length : e;
          if (s[end - 1] === '\n') end--;
          if (s[end - 1] === '\r') end--;
        }
        const st = new Stream(value, this.buf.subarray(start, Math.max(start, end)));
        this.objects.set(num, st);
        const type = nameOf(value.get('Type'));
        // Objects inside an object stream count as defined where the stream is (later updates win).
        if (type === 'ObjStm') this.expandObjectStream(st);
        if (type === 'XRef') this.trailers.push({ at: m.index, dict: value });
        const after = s.indexOf('endstream', end);
        re.lastIndex = after < 0 ? s.length : after + 9;
        continue;
      }
      lx.pos = save;
      if (value !== undefined) this.objects.set(num, value);
      re.lastIndex = Math.max(re.lastIndex, lx.pos);
    }
    const tr = /trailer\s*<</g;
    while ((m = tr.exec(s))) {
      const d = readValue(new Lexer(s, m.index + 7));
      if (d instanceof Map) this.trailers.push({ at: m.index, dict: d });
    }
    this.trailers.sort((a, b) => a.at - b.at);
  }

  private expandObjectStream(st: Stream): void {
    const n = this.resolve(st.dict.get('N'));
    const first = this.resolve(st.dict.get('First'));
    if (typeof n !== 'number' || typeof first !== 'number') return;
    const data = this.decode(st);
    if (!data) return;
    const text = data.toString('latin1');
    const head = new Lexer(text, 0);
    for (let i = 0; i < n; i++) {
      const a = head.next();
      const b = head.next();
      if (a?.k !== 'num' || b?.k !== 'num') break;
      const v = readValue(new Lexer(text, first + b.v));
      if (v !== undefined) this.objects.set(a.v, v);
    }
  }

  private resolve(v: PdfValue | undefined): PdfValue | undefined {
    for (let i = 0; v instanceof Ref && i < 32; i++) v = this.objects.get(v.num);
    return v instanceof Ref ? undefined : v;
  }

  private decode(st: Stream): Buffer | null {
    const f = this.resolve(st.dict.get('Filter'));
    const filters = (Array.isArray(f) ? f : f === undefined || f === null ? [] : [f]).map((x) => nameOf(this.resolve(x)));
    let data: Buffer | null = st.raw;
    for (const name of filters) {
      if (!data) return null;
      if (name === 'FlateDecode' || name === 'Fl') data = inflate(data);
      else if (name === 'ASCIIHexDecode' || name === 'AHx') data = asciiHex(data);
      else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85(data);
      else if (name === 'LZWDecode' || name === 'LZW') data = lzw(data);
      else return null; // image codecs: no text in there
    }
    return data;
  }

  private catalog(): Dict | undefined {
    for (let i = this.trailers.length - 1; i >= 0; i--) {
      const root = asDict(this.resolve(this.trailers[i]!.dict.get('Root')));
      if (root) return root;
    }
    let found: Dict | undefined;
    for (const v of this.objects.values()) if (v instanceof Map && nameOf(v.get('Type')) === 'Catalog') found = v;
    return found;
  }

  private pages(): { dict: Dict; resources?: Dict }[] {
    if (this.pageList) return this.pageList;
    const out: { dict: Dict; resources?: Dict }[] = [];
    const seen = new Set<Dict>();
    const walk = (node: PdfValue | undefined, inherited: Dict | undefined, depth: number) => {
      const d = asDict(this.resolve(node));
      if (!d || seen.has(d) || depth > 64) return;
      seen.add(d);
      const resources = asDict(this.resolve(d.get('Resources'))) ?? inherited;
      const kids = this.resolve(d.get('Kids'));
      if (Array.isArray(kids)) for (const k of kids) walk(k, resources, depth + 1);
      else if (nameOf(d.get('Type')) !== 'Pages') out.push({ dict: d, resources });
    };
    walk(this.catalog()?.get('Pages'), undefined, 0);
    if (!out.length) {
      // No usable page tree: take the page objects in object-number order.
      const nums = [...this.objects.keys()].sort((a, b) => a - b);
      for (const n of nums) {
        const d = this.objects.get(n);
        if (d instanceof Map && nameOf(d.get('Type')) === 'Page') out.push({ dict: d, resources: asDict(this.resolve(d.get('Resources'))) });
      }
    }
    this.pageList = out;
    return out;
  }

  private font(ref: PdfValue | undefined): FontInfo | undefined {
    const fd = asDict(this.resolve(ref));
    if (!fd) return undefined;
    let f = this.fontCache.get(fd);
    if (!f) {
      f = this.loadFont(fd);
      this.fontCache.set(fd, f);
    }
    return f;
  }

  private numbers(v: PdfValue | undefined): number[] {
    const arr = this.resolve(v);
    return Array.isArray(arr) ? arr.map((x) => this.resolve(x)).map((x) => (typeof x === 'number' ? x : 0)) : [];
  }

  private loadFont(fd: Dict): FontInfo {
    const subtype = nameOf(fd.get('Subtype'));
    let toUnicode: Map<number, string> | undefined;
    let cmapBytes: 1 | 2 | undefined;
    const tu = this.resolve(fd.get('ToUnicode'));
    if (tu instanceof Stream) {
      const data = this.decode(tu);
      if (data) ({ map: toUnicode, bytes: cmapBytes } = parseCMap(data.toString('latin1')));
    }
    if (subtype === 'Type0') {
      const encoding = nameOf(this.resolve(fd.get('Encoding'))) ?? '';
      // Predefined UCS-2 CMaps use the Unicode value as the code.
      const ucs2 = /UCS2|UTF16/i.test(encoding);
      const descendants = this.resolve(fd.get('DescendantFonts'));
      const cid = asDict(this.resolve(Array.isArray(descendants) ? descendants[0] : undefined));
      const dw = this.resolve(cid?.get('DW'));
      const widths = new Map<number, number>();
      const w = this.resolve(cid?.get('W'));
      if (Array.isArray(w)) {
        for (let i = 0; i < w.length && widths.size < 100_000; ) {
          const first = this.resolve(w[i]);
          const next = this.resolve(w[i + 1]);
          if (typeof first !== 'number') break;
          if (Array.isArray(next)) {
            next.forEach((x, j) => {
              const v = this.resolve(x);
              if (typeof v === 'number') widths.set(first + j, v);
            });
            i += 2;
          } else {
            const width = this.resolve(w[i + 2]);
            if (typeof next !== 'number' || typeof width !== 'number') break;
            for (let c = first; c <= Math.min(next, first + 65535); c++) widths.set(c, width);
            i += 3;
          }
        }
      }
      const defaultWidth = typeof dw === 'number' ? dw : 1000;
      return {
        composite: true,
        codeBytes: cmapBytes ?? 2,
        decode: (code) => toUnicode?.get(code) ?? (ucs2 ? String.fromCharCode(code) : undefined),
        width: (code) => widths.get(code) ?? defaultWidth,
      };
    }
    const table = WIN_ANSI.slice();
    const enc = this.resolve(fd.get('Encoding'));
    if (enc instanceof Map) {
      const diffs = this.resolve(enc.get('Differences'));
      if (Array.isArray(diffs)) {
        let code = 0;
        for (const d of diffs) {
          const v = this.resolve(d);
          if (typeof v === 'number') code = v;
          else if (v instanceof Name && code < 256) table[code++] = glyphToUnicode(v.name);
        }
      }
    }
    const firstChar = this.resolve(fd.get('FirstChar'));
    const widths = this.numbers(fd.get('Widths'));
    const start = typeof firstChar === 'number' ? firstChar : 0;
    const base = nameOf(fd.get('BaseFont')) ?? '';
    // Type3 widths are in glyph space; the font matrix scales them to text space.
    const matrix = this.numbers(fd.get('FontMatrix'));
    const scale = subtype === 'Type3' && matrix.length === 6 ? Math.abs(matrix[0]!) * 1000 : 1;
    const fallback = (code: number) => (/courier|mono/i.test(base) ? 600 : code >= 32 && code <= 126 ? HELVETICA[code - 32]! : 556);
    return {
      composite: false,
      codeBytes: 1,
      decode: (code) => toUnicode?.get(code) ?? table[code],
      width: (code) => {
        const w = widths[code - start];
        return w ? w * scale : fallback(code);
      },
    };
  }

  /** Interprets a content stream, sending text runs to the sink. */
  private run(data: string, resources: Dict | undefined, initial: GState, sink: TextSink, depth: number, active: Set<Stream>): void {
    const lx = new Lexer(data, 0);
    const ops: PdfValue[] = [];
    const saved: GState[] = [];
    let g = initial;
    const fonts = asDict(this.resolve(resources?.get('Font')));
    const xobjects = asDict(this.resolve(resources?.get('XObject')));
    const num = (i: number) => {
      const v = ops[ops.length - i];
      return typeof v === 'number' ? v : 0;
    };
    const moveText = (tx: number, ty: number) => {
      g.tlm = translate(g.tlm, tx, ty);
      g.tm = g.tlm.slice();
    };
    for (let steps = 0; steps < 3_000_000; steps++) {
      const t = lx.next();
      if (!t) break;
      if (t.k === 'num' || t.k === 'str') {
        ops.push(t.v);
        continue;
      }
      if (t.k === 'name') {
        ops.push(new Name(t.v));
        continue;
      }
      if (t.k === 'sym') {
        if (t.v === '[' || t.v === '<<') ops.push(readValue(lx, t) ?? null);
        continue;
      }
      switch (t.v) {
        case 'true':
        case 'false':
        case 'null':
          ops.push(t.v === 'true' ? true : t.v === 'false' ? false : null);
          continue;
        case 'q':
          saved.push(cloneState(g));
          break;
        case 'Q':
          if (saved.length) g = saved.pop()!;
          break;
        case 'cm':
          if (ops.length >= 6) g.ctm = mul([num(6), num(5), num(4), num(3), num(2), num(1)], g.ctm);
          break;
        case 'BT':
          g.tm = IDENTITY.slice();
          g.tlm = IDENTITY.slice();
          break;
        case 'Tf': {
          const name = ops[ops.length - 2];
          if (name instanceof Name) g.font = this.font(fonts?.get(name.name));
          g.fs = num(1);
          break;
        }
        case 'Tc':
          g.tc = num(1);
          break;
        case 'Tw':
          g.tw = num(1);
          break;
        case 'Tz':
          g.th = num(1) / 100;
          break;
        case 'TL':
          g.tl = num(1);
          break;
        case 'Td':
          moveText(num(2), num(1));
          break;
        case 'TD':
          g.tl = -num(1);
          moveText(num(2), num(1));
          break;
        case 'Tm':
          if (ops.length >= 6) {
            g.tlm = [num(6), num(5), num(4), num(3), num(2), num(1)];
            g.tm = g.tlm.slice();
          }
          break;
        case 'T*':
          moveText(0, -g.tl);
          break;
        case 'Tj':
          this.show(ops[ops.length - 1], g, sink);
          break;
        case "'":
          moveText(0, -g.tl);
          this.show(ops[ops.length - 1], g, sink);
          break;
        case '"':
          g.tw = num(3);
          g.tc = num(2);
          moveText(0, -g.tl);
          this.show(ops[ops.length - 1], g, sink);
          break;
        case 'TJ': {
          const arr = ops[ops.length - 1];
          if (Array.isArray(arr)) {
            for (const item of arr) {
              if (typeof item === 'string') this.show(item, g, sink);
              else if (typeof item === 'number') g.tm = translate(g.tm, (-item / 1000) * g.fs * g.th, 0);
            }
          }
          break;
        }
        case 'Do': {
          const name = ops[ops.length - 1];
          const xo = name instanceof Name ? this.resolve(xobjects?.get(name.name)) : undefined;
          if (!(xo instanceof Stream)) break;
          const sub = nameOf(xo.dict.get('Subtype'));
          if (sub === 'Image') sink.hasImages = true;
          else if (sub === 'Form' && depth < 6 && !active.has(xo)) {
            const content = this.decode(xo);
            if (!content) break;
            const m = this.numbers(xo.dict.get('Matrix'));
            const inner = cloneState(g);
            inner.ctm = mul(m.length === 6 ? m : IDENTITY, g.ctm);
            active.add(xo);
            this.run(content.toString('latin1'), asDict(this.resolve(xo.dict.get('Resources'))) ?? resources, inner, sink, depth + 1, active);
            active.delete(xo);
          }
          break;
        }
        case 'BI': {
          // Inline image: skip its parameters and binary data.
          sink.hasImages = true;
          for (let tok = lx.next(); tok && !(tok.k === 'kw' && tok.v === 'ID'); tok = lx.next());
          const end = /\sEI(?=\s|$)/g;
          end.lastIndex = lx.pos + 1;
          const hit = end.exec(lx.s);
          lx.pos = hit ? hit.index + 3 : lx.s.length;
          break;
        }
      }
      ops.length = 0;
    }
  }

  private show(value: PdfValue | undefined, g: GState, sink: TextSink): void {
    if (typeof value !== 'string' || !value) return;
    const font = g.font;
    const two = font?.codeBytes === 2;
    let text = '';
    let advance = 0;
    for (let i = 0; i < value.length; i += two ? 2 : 1) {
      const code = two ? (value.charCodeAt(i) << 8) | (value.charCodeAt(i + 1) || 0) : value.charCodeAt(i);
      const u = font ? font.decode(code) : WIN_ANSI[code];
      if (u !== undefined) text += u;
      else if (font?.composite) sink.undecodable = true;
      const w = font ? font.width(code) : code >= 32 && code <= 126 ? HELVETICA[code - 32]! : 556;
      advance += (w / 1000) * g.fs + g.tc + (!two && code === 32 ? g.tw : 0);
    }
    const trm = mul(g.tm, g.ctm);
    const em = Math.max(0.5, Math.abs(g.fs) * Math.hypot(trm[2]!, trm[3]!));
    if (text) sink.put(text, trm[4]!, trm[5]!, em);
    g.tm = translate(g.tm, advance * g.th, 0);
    if (text) {
      const end = mul(g.tm, g.ctm);
      sink.lastX = end[4]!;
      sink.lastY = end[5]!;
    }
  }
}

// ------------------------------------------------------------------ page selection and the public entry point

/** Parses "3", "1-5", "2,4-6" or "7-" into sorted page numbers within 1..total, or an error message. */
export function parsePageSpec(spec: string, total: number): number[] | string {
  const out = new Set<number>();
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d*))?$/.exec(part);
    if (!m) return `Invalid pages "${spec}". Use page numbers and ranges like "3", "1-5" or "2,4-6".`;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : m[2] === '' ? total : Number(m[2]);
    if (from < 1 || to < from) return `Invalid page range "${part}". Pages start at 1.`;
    for (let p = from; p <= Math.min(to, total) && out.size < 10_000; p++) out.add(p);
  }
  if (!out.size) return `The PDF has ${total} page${total === 1 ? '' : 's'}; pages "${spec}" selects none of them.`;
  return [...out].sort((a, b) => a - b);
}

/** "1-3, 5" for [1, 2, 3, 5]. */
export function pageRangeText(pages: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    parts.push(j > i ? `${pages[i]}-${pages[j]}` : `${pages[i]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

function pdftotextPath(): string | null {
  return process.env.FREECODE_NO_PDFTOTEXT ? null : which('pdftotext');
}

function execText(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve(err && !stdout ? null : String(stdout ?? '')));
  });
}

async function pdfinfoPages(file: string): Promise<number | null> {
  const bin = process.env.FREECODE_NO_PDFTOTEXT ? null : which('pdfinfo');
  if (!bin) return null;
  const out = await execText(bin, [file], 20_000);
  return Number(/^Pages:\s+(\d+)/m.exec(out ?? '')?.[1]) || null;
}

/** Text of pages first..last with pdftotext (one entry per page), or null when it fails. */
async function pdftotextPages(bin: string, file: string, first: number, last: number): Promise<string[] | null> {
  const out = await execText(bin, ['-q', '-enc', 'UTF-8', '-f', String(first), '-l', String(last), file, '-'], 120_000);
  if (out === null) return null;
  // pdftotext ends every page with a form feed, so the piece after the last one is not a page.
  const parts = out.split('\f');
  if (parts.length > 1) parts.pop();
  return parts.slice(0, last - first + 1).map(tidy);
}

/**
 * Reads the text of a PDF page by page. Stops adding pages once `maxChars` is reached (always at least one
 * page). Returns an error message for files it cannot read.
 */
export async function readPdf(file: string, buf: Buffer, spec: string | undefined, maxChars: number): Promise<PdfRead | string> {
  if (!buf.subarray(0, 1024).toString('latin1').includes('%PDF')) return 'The file does not start like a PDF (no %PDF header).';
  const bin = pdftotextPath();
  let doc: PdfDocument | null = null;
  const builtin = (): PdfDocument | null => {
    if (!doc && buf.length <= MAX_BUILTIN_BYTES) {
      try {
        doc = new PdfDocument(buf);
      } catch {
        doc = null;
      }
    }
    return doc;
  };
  let total = bin ? await pdfinfoPages(file) : null;
  if (!total) total = builtin()?.pageCount || null;
  if (!total) {
    if (!bin && buf.length > MAX_BUILTIN_BYTES) return `The PDF is too large for the built-in reader (over ${MAX_BUILTIN_BYTES / 1024 / 1024} MB). Install pdftotext (poppler-utils) to read it.`;
    if (!bin) return 'No pages found in this PDF; the file may be damaged. Install pdftotext (poppler-utils) for a more complete reader.';
  }
  let wanted: number[];
  if (spec?.trim()) {
    const parsed = parsePageSpec(spec, total ?? 10_000);
    if (typeof parsed === 'string') return parsed;
    wanted = parsed;
  } else wanted = Array.from({ length: Math.min(total ?? MAX_PAGES_PER_READ, MAX_PAGES_PER_READ) }, (_, i) => i + 1);
  const capped = wanted.slice(0, MAX_PAGES_PER_READ);
  const remaining = wanted.slice(MAX_PAGES_PER_READ);

  const pages: PdfPage[] = [];
  let via: PdfRead['via'] = 'builtin';
  let chars = 0;
  const add = (number: number, text: string): boolean => {
    if (pages.length && chars + text.length > maxChars) return false;
    pages.push({ number, text: text.length > maxChars ? `${text.slice(0, maxChars)}\n[page text truncated]` : text });
    chars += text.length;
    return true;
  };
  let done = false;
  if (bin) {
    // One pdftotext call per run of consecutive pages.
    const texts = new Map<number, string>();
    let ok = true;
    for (let i = 0; i < capped.length && ok; ) {
      let j = i;
      while (j + 1 < capped.length && capped[j + 1] === capped[j]! + 1) j++;
      const got = await pdftotextPages(bin, file, capped[i]!, capped[j]!);
      if (!got) ok = false;
      else got.forEach((t, k) => texts.set(capped[i]! + k, t));
      i = j + 1;
    }
    if (ok && texts.size) {
      via = 'pdftotext';
      if (!total) total = Math.max(...texts.keys());
      for (let i = 0; i < capped.length; i++) {
        if (!texts.has(capped[i]!)) continue;
        if (!add(capped[i]!, texts.get(capped[i]!)!)) {
          remaining.unshift(...capped.slice(i));
          break;
        }
      }
      done = true;
    }
  }
  let scanned = false;
  let fonts = false;
  if (!done) {
    const d = builtin();
    if (!d) return buf.length > MAX_BUILTIN_BYTES ? 'The PDF is too large for the built-in reader. Install pdftotext (poppler-utils) to read it.' : 'Could not read this PDF.';
    if (d.encrypted) return 'The PDF is encrypted and the built-in reader cannot decrypt it. Install pdftotext (poppler-utils) to read it.';
    total = d.pageCount;
    for (let i = 0; i < capped.length; i++) {
      const p = d.page(capped[i]!);
      scanned ||= p.hasImages;
      fonts ||= p.undecodable;
      if (!add(capped[i]!, p.text)) {
        remaining.unshift(...capped.slice(i));
        break;
      }
    }
  }
  const result: PdfRead = { total: total ?? pages.length, pages, remaining, via };
  if (pages.every((p) => !p.text.trim())) {
    if (via === 'pdftotext') {
      const d = builtin();
      scanned = !!d && pages.some((p) => d.page(p.number).hasImages);
    }
    result.noText = scanned ? 'scanned' : fonts ? 'fonts' : 'empty';
  }
  return result;
}
