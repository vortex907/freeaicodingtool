// ANSI styling, display-width measurement and ANSI-aware wrapping/truncation.

const env = process.env;

function detectColorLevel(): 0 | 1 | 2 | 3 {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;
  if (env.FORCE_COLOR === '0' || env.FORCE_COLOR === 'false') return 0;
  if (env.FORCE_COLOR === '1') return 1;
  if (env.FORCE_COLOR === '2') return 2;
  if (env.FORCE_COLOR === '3' || env.FORCE_COLOR === 'true') return 3;
  if (!process.stdout.isTTY) return 0;
  if (env.TERM === 'dumb') return 0;
  const ct = (env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 3;
  if (process.platform === 'win32') return 3; // Windows 10+ terminals support truecolor
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'vscode') return 3;
  if (/-256(color)?$/i.test(env.TERM || '')) return 2;
  return 1;
}

export let colorLevel: 0 | 1 | 2 | 3 = detectColorLevel();
export function setColorLevel(level: 0 | 1 | 2 | 3): void {
  colorLevel = level;
}

const ESC = '\x1b[';

function wrap(open: string, close: string) {
  return (s: string | number): string => {
    if (colorLevel === 0) return String(s);
    const str = String(s);
    // Re-open the style after any nested reset of the same kind so nesting works.
    return open + str.split(close).join(close + open) + close;
  };
}

function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

function rgbTo16(r: number, g: number, b: number): number {
  const value = Math.round((Math.max(r, g, b) / 255) * 2);
  if (value === 0) return 30;
  let code = 30 + ((Math.round(b / 255) << 2) | (Math.round(g / 255) << 1) | Math.round(r / 255));
  if (value === 2) code += 60;
  return code;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function fg(hex: string): (s: string | number) => string {
  return (s) => {
    if (colorLevel === 0) return String(s);
    const [r, g, b] = hexToRgb(hex);
    let open: string;
    if (colorLevel === 3) open = `${ESC}38;2;${r};${g};${b}m`;
    else if (colorLevel === 2) open = `${ESC}38;5;${rgbTo256(r, g, b)}m`;
    else open = `${ESC}${rgbTo16(r, g, b)}m`;
    return wrap(open, `${ESC}39m`)(s);
  };
}

export function bg(hex: string): (s: string | number) => string {
  return (s) => {
    if (colorLevel === 0) return String(s);
    const [r, g, b] = hexToRgb(hex);
    let open: string;
    if (colorLevel === 3) open = `${ESC}48;2;${r};${g};${b}m`;
    else if (colorLevel === 2) open = `${ESC}48;5;${rgbTo256(r, g, b)}m`;
    else open = `${ESC}${rgbTo16(r, g, b) + 10}m`;
    return wrap(open, `${ESC}49m`)(s);
  };
}

export const c = {
  reset: (s: string) => (colorLevel ? `${ESC}0m${s}` : s),
  bold: wrap(`${ESC}1m`, `${ESC}22m`),
  dim: wrap(`${ESC}2m`, `${ESC}22m`),
  italic: wrap(`${ESC}3m`, `${ESC}23m`),
  underline: wrap(`${ESC}4m`, `${ESC}24m`),
  inverse: wrap(`${ESC}7m`, `${ESC}27m`),
  strike: wrap(`${ESC}9m`, `${ESC}29m`),
  red: wrap(`${ESC}31m`, `${ESC}39m`),
  green: wrap(`${ESC}32m`, `${ESC}39m`),
  yellow: wrap(`${ESC}33m`, `${ESC}39m`),
  blue: wrap(`${ESC}34m`, `${ESC}39m`),
  magenta: wrap(`${ESC}35m`, `${ESC}39m`),
  cyan: wrap(`${ESC}36m`, `${ESC}39m`),
  white: wrap(`${ESC}37m`, `${ESC}39m`),
  gray: wrap(`${ESC}90m`, `${ESC}39m`),
};

/** Theme palette used across the UI. */
export const theme = {
  accent: fg('#3ddc97'), // FreeCode green
  accent2: fg('#5fb3f9'),
  brand: (s: string) => c.bold(fg('#3ddc97')(s)),
  user: fg('#b5b5b5'),
  text: (s: string) => s,
  muted: fg('#8a8a8a'),
  faint: fg('#5c5c5c'),
  warn: fg('#e5c07b'),
  error: fg('#ef6b73'),
  success: fg('#4ec98a'),
  info: fg('#61afef'),
  tool: (s: string) => c.bold(s),
  code: fg('#e5a07b'),
  link: (s: string) => c.underline(fg('#61afef')(s)),
  heading: (s: string) => c.bold(fg('#e8e8e8')(s)),
  diffAdd: (s: string) => (colorLevel ? bg('#173d26')(fg('#9be9a8')(s)) : s),
  diffDel: (s: string) => (colorLevel ? bg('#4a1c22')(fg('#ffb3b8')(s)) : s),
  diffAddSign: fg('#4ec98a'),
  diffDelSign: fg('#ef6b73'),
  border: fg('#5c5c5c'),
  borderActive: fg('#3ddc97'),
  plan: fg('#56b6c2'),
  yolo: fg('#ef6b73'),
  acceptEdits: fg('#c678dd'),
};

// ---------------------------------------------------------------------------
// Escape-sequence handling

// Matches CSI sequences, OSC sequences (terminated by BEL or ST) and simple 2-char escapes.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Display width of a single code point in a monospace terminal. */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Combining marks and zero-width characters
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x0e31 && cp <= 0x0e3a && cp !== 0x0e32 && cp !== 0x0e33) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0xfeff ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0;
  }
  // Wide / fullwidth ranges (CJK, Hangul, emoji, ...)
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x16fe0 && cp <= 0x16fe4) ||
    (cp >= 0x17000 && cp <= 0x18cff) ||
    (cp >= 0x1b000 && cp <= 0x1b2ff) ||
    cp === 0x1f004 ||
    cp === 0x1f0cf ||
    cp === 0x1f18e ||
    (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f200 && cp <= 0x1f251) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
    (cp >= 0x1f90c && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Visible width of a string (ANSI codes ignored, wide chars count 2). */
export function stringWidth(s: string): number {
  if (!s) return 0;
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) {
    if (ch === '\t') {
      w += 4;
      continue;
    }
    w += charWidth(ch.codePointAt(0)!);
  }
  return w;
}

interface Token {
  ansi: boolean;
  text: string;
  width: number;
}

function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  ANSI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const pushText = (text: string) => {
    for (const ch of text) {
      const width = ch === '\t' ? 4 : charWidth(ch.codePointAt(0)!);
      tokens.push({ ansi: false, text: ch === '\t' ? '    ' : ch, width });
    }
  };
  while ((m = ANSI_RE.exec(s))) {
    if (m.index > last) pushText(s.slice(last, m.index));
    tokens.push({ ansi: true, text: m[0], width: 0 });
    last = m.index + m[0].length;
  }
  if (last < s.length) pushText(s.slice(last));
  return tokens;
}

/** Tracks SGR state so wrapped lines can re-open active styles. */
class SgrState {
  private active: string[] = [];
  apply(seq: string): void {
    if (!seq.startsWith('\x1b[') || !seq.endsWith('m')) return;
    const params = seq.slice(2, -1);
    if (params === '' || params === '0') {
      this.active = [];
      return;
    }
    this.active.push(seq);
    if (this.active.length > 16) this.active = this.active.slice(-16);
  }
  open(): string {
    return this.active.join('');
  }
  get any(): boolean {
    return this.active.length > 0;
  }
}

/** Truncates a string to a maximum display width, keeping ANSI codes balanced. */
export function truncateToWidth(s: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(s) <= maxWidth) return s;
  const ellW = stringWidth(ellipsis);
  const target = Math.max(0, maxWidth - ellW);
  let out = '';
  let w = 0;
  let hadAnsi = false;
  for (const t of tokenize(s)) {
    if (t.ansi) {
      out += t.text;
      hadAnsi = true;
      continue;
    }
    if (w + t.width > target) break;
    out += t.text;
    w += t.width;
  }
  return out + (hadAnsi && colorLevel ? '\x1b[0m' : '') + ellipsis;
}

/** Hard/soft wraps an ANSI string into lines no wider than `width`. */
export function wrapAnsi(s: string, width: number, opts: { hard?: boolean } = {}): string[] {
  const out: string[] = [];
  if (width <= 0) width = 1;
  for (const rawLine of s.split('\n')) {
    out.push(...wrapLine(rawLine, width, opts.hard ?? true));
  }
  return out;
}

function wrapLine(line: string, width: number, hard: boolean): string[] {
  if (stringWidth(line) <= width) return [line];
  const tokens = tokenize(line);
  const lines: string[] = [];
  const state = new SgrState();
  let cur = '';
  let curW = 0;
  // Word-aware wrapping: remember the last space position to break there.
  let lastSpaceIdx = -1; // index in `cur` string after the space
  let lastSpaceW = 0;
  let lastSpaceState = '';

  const flush = (text: string) => {
    lines.push(text + (state.any && colorLevel ? '\x1b[0m' : ''));
  };

  for (const t of tokens) {
    if (t.ansi) {
      cur += t.text;
      state.apply(t.text);
      continue;
    }
    if (curW + t.width > width) {
      if (!hard && lastSpaceIdx > 0) {
        const head = cur.slice(0, lastSpaceIdx);
        const tail = cur.slice(lastSpaceIdx);
        flush(head.trimEnd());
        cur = lastSpaceState + tail;
        curW = curW - lastSpaceW;
      } else if (hard && lastSpaceIdx > 0 && curW - lastSpaceW < width / 2) {
        const head = cur.slice(0, lastSpaceIdx);
        const tail = cur.slice(lastSpaceIdx);
        flush(head.trimEnd());
        cur = lastSpaceState + tail;
        curW = curW - lastSpaceW;
      } else {
        flush(cur);
        cur = state.open();
        curW = 0;
      }
      lastSpaceIdx = -1;
      lastSpaceW = 0;
      if (t.text === ' ' && curW === 0) continue; // drop leading space on new line
    }
    cur += t.text;
    curW += t.width;
    if (t.text === ' ') {
      lastSpaceIdx = cur.length;
      lastSpaceW = curW;
      lastSpaceState = state.open();
    }
  }
  if (cur.length || lines.length === 0) lines.push(cur);
  return lines;
}

/** Pads a string with spaces to a display width. */
export function padEndWidth(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function padStartWidth(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}

// Cursor/screen control sequences
export const term = {
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearLine: '\x1b[2K',
  clearDown: '\x1b[0J',
  clearScreen: '\x1b[2J\x1b[3J\x1b[H',
  cursorTo: (col: number) => `\x1b[${col + 1}G`,
  up: (n: number) => (n > 0 ? `\x1b[${n}A` : ''),
  down: (n: number) => (n > 0 ? `\x1b[${n}B` : ''),
  right: (n: number) => (n > 0 ? `\x1b[${n}C` : ''),
  left: (n: number) => (n > 0 ? `\x1b[${n}D` : ''),
  bracketedPasteOn: '\x1b[?2004h',
  bracketedPasteOff: '\x1b[?2004l',
};
