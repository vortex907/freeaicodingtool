// Interactive widgets rendered in the live region: selection lists and text prompts.
import { c, charWidth, padEndWidth, stringWidth, theme, truncateToWidth, wrapAnsi } from '../util/ansi.js';
import type { Key } from './screen.js';

export interface SelectOption<T = string> {
  label: string;
  value: T;
  description?: string;
  /** Right-aligned status text */
  status?: string;
  disabled?: boolean;
  /** Section header rendered above this option */
  section?: string;
}

export type WidgetResult<T> = { done: true; value: T | null } | { done: false };

export interface Widget<T> {
  handleKey(str: string | undefined, key: Key): WidgetResult<T>;
  render(width: number): { lines: string[]; cursor?: { row: number; col: number } };
}

export class SelectList<T = string> implements Widget<T> {
  selected = 0;
  private extraKeys = new Map<string, (opt: SelectOption<T>) => T | null | undefined>();

  constructor(
    public header: string[],
    public options: SelectOption<T>[],
    public opts: { selected?: number; numbered?: boolean; maxVisible?: number; footer?: string; border?: (s: string) => string } = {},
  ) {
    this.selected = Math.max(0, Math.min(options.length - 1, opts.selected ?? 0));
    if (this.options[this.selected]?.disabled) this.move(1);
  }

  /** Registers a shortcut key (e.g. 'd' to delete). Returning undefined keeps the list open. */
  onKey(ch: string, fn: (opt: SelectOption<T>) => T | null | undefined): this {
    this.extraKeys.set(ch, fn);
    return this;
  }

  private move(delta: number): void {
    const n = this.options.length;
    if (!n) return;
    for (let i = 0; i < n; i++) {
      this.selected = (this.selected + delta + n) % n;
      if (!this.options[this.selected]!.disabled) return;
    }
  }

  handleKey(str: string | undefined, key: Key): WidgetResult<T> {
    switch (key.name) {
      case 'up':
        this.move(-1);
        return { done: false };
      case 'down':
      case 'tab':
        this.move(1);
        return { done: false };
      case 'pageup':
        for (let i = 0; i < 8; i++) this.move(-1);
        return { done: false };
      case 'pagedown':
        for (let i = 0; i < 8; i++) this.move(1);
        return { done: false };
      case 'return':
      case 'enter': {
        const o = this.options[this.selected];
        if (!o || o.disabled) return { done: false };
        return { done: true, value: o.value };
      }
      case 'escape':
        return { done: true, value: null };
    }
    if (key.ctrl && key.name === 'c') return { done: true, value: null };
    if (key.ctrl && key.name === 'p') {
      this.move(-1);
      return { done: false };
    }
    if (key.ctrl && key.name === 'n') {
      this.move(1);
      return { done: false };
    }
    if (str && this.extraKeys.has(str)) {
      const o = this.options[this.selected];
      if (o) {
        const v = this.extraKeys.get(str)!(o);
        if (v !== undefined) return { done: true, value: v };
      }
      return { done: false };
    }
    if (str && /^[1-9]$/.test(str) && this.opts.numbered !== false) {
      const enabled = this.options.filter((o) => !o.disabled);
      const o = enabled[Number(str) - 1];
      if (o) return { done: true, value: o.value };
    }
    if (str === 'j') {
      this.move(1);
      return { done: false };
    }
    if (str === 'k') {
      this.move(-1);
      return { done: false };
    }
    return { done: false };
  }

  render(width: number): { lines: string[] } {
    const border = this.opts.border;
    const lines: string[] = [];
    const inner = border ? width - 4 : width;
    for (const h of this.header) lines.push(...wrapAnsi(h, inner, { hard: false }));
    const maxVisible = this.opts.maxVisible ?? 12;
    let start = 0;
    if (this.options.length > maxVisible) start = Math.max(0, Math.min(this.selected - Math.floor(maxVisible / 2), this.options.length - maxVisible));
    const visible = this.options.slice(start, start + maxVisible);
    let enabledIdx = this.options.slice(0, start).filter((o) => !o.disabled).length;
    const labelW = Math.min(Math.max(10, ...visible.map((o) => stringWidth(o.label))) + 1, Math.floor(inner * 0.5));
    if (start > 0) lines.push(c.dim(`   ↑ ${start} more`));
    visible.forEach((o, i) => {
      if (o.section) lines.push(c.dim(`  ${o.section}`));
      const idx = start + i;
      const sel = idx === this.selected;
      if (!o.disabled) enabledIdx++;
      const num = this.opts.numbered !== false && !o.disabled && enabledIdx <= 9 ? `${enabledIdx}. ` : '   ';
      const pointer = sel ? theme.accent('❯ ') : '  ';
      let label = truncateToWidth(o.label, labelW);
      label = o.disabled ? c.dim(label) : sel ? theme.accent(c.bold(label)) : label;
      let line = `${pointer}${c.dim(num)}${padEndWidth(label, labelW)}`;
      const status = o.status ?? '';
      const descRoom = inner - stringWidth(line) - stringWidth(status) - 2;
      if (o.description && descRoom > 8) line += ' ' + c.dim(truncateToWidth(o.description, descRoom));
      if (status) line = padEndWidth(line, inner - stringWidth(status)) + status;
      lines.push(line);
    });
    if (start + maxVisible < this.options.length) lines.push(c.dim(`   ↓ ${this.options.length - start - maxVisible} more`));
    if (this.opts.footer) lines.push('', c.dim(this.opts.footer));
    if (!border) return { lines };
    const top = border('╭' + '─'.repeat(width - 2) + '╮');
    const bottom = border('╰' + '─'.repeat(width - 2) + '╯');
    return { lines: [top, ...lines.map((l) => border('│') + ' ' + padEndWidth(truncateToWidth(l, inner), inner) + ' ' + border('│')), bottom] };
  }
}

export class TextPrompt implements Widget<string> {
  value: string;
  cursor: number;

  constructor(
    public header: string[],
    public opts: { mask?: boolean; placeholder?: string; initial?: string; prompt?: string; allowEmpty?: boolean } = {},
  ) {
    this.value = opts.initial ?? '';
    this.cursor = this.value.length;
  }

  handleKey(str: string | undefined, key: Key): WidgetResult<string> {
    switch (key.name) {
      case 'return':
      case 'enter':
        if (!this.value.trim() && !this.opts.allowEmpty) return { done: false };
        return { done: true, value: this.value.trim() };
      case 'escape':
        return { done: true, value: null };
      case 'backspace':
        if (this.cursor > 0) {
          this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
          this.cursor--;
        }
        return { done: false };
      case 'delete':
        this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
        return { done: false };
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        return { done: false };
      case 'right':
        this.cursor = Math.min(this.value.length, this.cursor + 1);
        return { done: false };
      case 'home':
        this.cursor = 0;
        return { done: false };
      case 'end':
        this.cursor = this.value.length;
        return { done: false };
      case 'paste-start':
      case 'paste-end':
        return { done: false };
    }
    if (key.ctrl) {
      if (key.name === 'c') return { done: true, value: null };
      if (key.name === 'u') {
        this.value = this.value.slice(this.cursor);
        this.cursor = 0;
      } else if (key.name === 'a') this.cursor = 0;
      else if (key.name === 'e') this.cursor = this.value.length;
      else if (key.name === 'k') this.value = this.value.slice(0, this.cursor);
      return { done: false };
    }
    if (str && !key.meta) {
      const clean = str.replace(/[\r\n]+/g, '').replace(/[\x00-\x1f]/g, '');
      if (clean) {
        this.value = this.value.slice(0, this.cursor) + clean + this.value.slice(this.cursor);
        this.cursor += clean.length;
      }
    }
    return { done: false };
  }

  render(width: number): { lines: string[]; cursor: { row: number; col: number } } {
    const lines: string[] = [];
    for (const h of this.header) lines.push(...wrapAnsi(h, width, { hard: false }));
    const prompt = this.opts.prompt ?? '> ';
    const shown = this.opts.mask ? maskKey(this.value) : this.value;
    const avail = width - stringWidth(prompt) - 2;
    let display = shown;
    let curCol = this.opts.mask ? Math.min(this.cursor, shown.length) : [...this.value.slice(0, this.cursor)].reduce((a, ch) => a + charWidth(ch.codePointAt(0)!), 0);
    if (stringWidth(display) > avail) {
      // scroll horizontally to keep the cursor visible
      const startCol = Math.max(0, curCol - avail + 1);
      display = [...display].slice(startCol).join('');
      curCol -= startCol;
      display = truncateToWidth(display, avail, '');
    }
    const placeholder = !this.value && this.opts.placeholder ? c.dim(this.opts.placeholder) : '';
    lines.push(theme.accent(prompt) + (display || placeholder));
    return { lines, cursor: { row: lines.length - 1, col: stringWidth(prompt) + curCol } };
  }
}

/** Shows a key as "sk-a…xyz9" style for display. */
export function maskKey(k: string): string {
  if (!k) return '';
  if (k.length <= 8) return '•'.repeat(k.length);
  return k.slice(0, 4) + '•'.repeat(Math.min(20, k.length - 8)) + k.slice(-4);
}
