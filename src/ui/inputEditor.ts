// Multi-line prompt editor with history, bracketed paste, completion menu and a bordered box.
import { c, charWidth, padEndWidth, stringWidth, theme, truncateToWidth } from '../util/ansi.js';
import type { Key } from './screen.js';

export interface CompletionItem {
  label: string;
  description?: string;
  /** Text that replaces the completed token. */
  insert: string;
  /** Submit immediately after accepting (slash commands without args). */
  submit?: boolean;
}

export interface CompletionResult {
  items: CompletionItem[];
  from: number;
  to: number;
}

export interface EditorRender {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
}

const PASTE_PLACEHOLDER_RE = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g;

export class InputEditor {
  value = '';
  cursor = 0;
  history: string[] = [];
  private historyIdx = -1;
  private draft = '';
  private pastes = new Map<number, string>();
  private pasteCounter = 0;
  private inPaste = false;
  private pasteBuf = '';
  menu: { items: CompletionItem[]; selected: number; from: number; to: number } | null = null;
  private menuDismissedFor: string | null = null;

  completer: ((value: string, cursor: number) => CompletionResult | null) | null = null;
  onSubmit: ((text: string) => void) | null = null;
  onChange: (() => void) | null = null;

  setValue(v: string, cursor = v.length): void {
    this.value = v;
    this.cursor = Math.max(0, Math.min(cursor, v.length));
    this.updateMenu();
    this.onChange?.();
  }

  clear(): void {
    this.value = '';
    this.cursor = 0;
    this.menu = null;
    this.historyIdx = -1;
    this.pastes.clear();
    this.onChange?.();
  }

  /** Expands paste placeholders into the real pasted text. */
  expandedValue(): string {
    return this.value.replace(PASTE_PLACEHOLDER_RE, (m, n: string) => this.pastes.get(Number(n)) ?? m);
  }

  get isEmpty(): boolean {
    return this.value.length === 0;
  }

  private insert(text: string): void {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
    this.historyIdx = -1;
    this.updateMenu();
  }

  private deleteRange(from: number, to: number): void {
    if (from >= to) return;
    this.value = this.value.slice(0, from) + this.value.slice(to);
    this.cursor = from;
    this.historyIdx = -1;
    this.updateMenu();
  }

  updateMenu(): void {
    if (!this.completer) return;
    if (this.menuDismissedFor !== null && this.menuDismissedFor === this.value) return;
    this.menuDismissedFor = null;
    const res = this.completer(this.value, this.cursor);
    if (!res || !res.items.length) {
      this.menu = null;
      return;
    }
    const prevSel = this.menu?.items[this.menu.selected]?.label;
    const idx = prevSel ? res.items.findIndex((i) => i.label === prevSel) : -1;
    this.menu = { items: res.items, selected: idx >= 0 ? idx : 0, from: res.from, to: res.to };
  }

  dismissMenu(): void {
    this.menu = null;
    this.menuDismissedFor = this.value;
  }

  private acceptCompletion(): boolean {
    if (!this.menu) return false;
    const item = this.menu.items[this.menu.selected];
    if (!item) return false;
    const { from, to } = this.menu;
    this.value = this.value.slice(0, from) + item.insert + this.value.slice(to);
    this.cursor = from + item.insert.length;
    this.menu = null;
    this.menuDismissedFor = this.value;
    if (item.submit) {
      this.submit();
      return true;
    }
    this.onChange?.();
    return true;
  }

  private submit(): void {
    const text = this.expandedValue();
    if (!text.trim()) return;
    if (this.history[this.history.length - 1] !== this.value) this.history.push(this.value);
    if (this.history.length > 1000) this.history.shift();
    const cb = this.onSubmit;
    this.value = '';
    this.cursor = 0;
    this.menu = null;
    this.menuDismissedFor = null;
    this.historyIdx = -1;
    this.pastes.clear();
    cb?.(text);
  }

  private lineBounds(pos = this.cursor): { start: number; end: number } {
    const start = this.value.lastIndexOf('\n', pos - 1) + 1;
    let end = this.value.indexOf('\n', pos);
    if (end < 0) end = this.value.length;
    return { start, end };
  }

  private prevCharIndex(i: number): number {
    if (i <= 0) return 0;
    const code = this.value.charCodeAt(i - 1);
    if (code >= 0xdc00 && code <= 0xdfff && i >= 2) return i - 2;
    return i - 1;
  }

  private nextCharIndex(i: number): number {
    if (i >= this.value.length) return this.value.length;
    const code = this.value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) return i + 2;
    return i + 1;
  }

  private wordLeft(i: number): number {
    let j = i;
    while (j > 0 && /\s/.test(this.value[j - 1]!)) j--;
    while (j > 0 && !/[\s/.\-_]/.test(this.value[j - 1]!)) j--;
    if (j === i && j > 0) j--;
    return j;
  }

  private wordRight(i: number): number {
    let j = i;
    const n = this.value.length;
    while (j < n && /\s/.test(this.value[j]!)) j++;
    while (j < n && !/[\s/.\-_]/.test(this.value[j]!)) j++;
    if (j === i && j < n) j++;
    return j;
  }

  private historyPrev(): void {
    if (!this.history.length) return;
    if (this.historyIdx === -1) {
      this.draft = this.value;
      this.historyIdx = this.history.length - 1;
    } else if (this.historyIdx > 0) this.historyIdx--;
    else return;
    this.value = this.history[this.historyIdx]!;
    this.cursor = this.value.length;
    this.menu = null;
  }

  private historyNext(): void {
    if (this.historyIdx === -1) return;
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      this.value = this.history[this.historyIdx]!;
    } else {
      this.historyIdx = -1;
      this.value = this.draft;
    }
    this.cursor = this.value.length;
    this.menu = null;
  }

  private finishPaste(): void {
    let text = this.pasteBuf.replace(/\r\n?/g, '\n');
    this.pasteBuf = '';
    this.inPaste = false;
    const lines = text.split('\n').length;
    if (text.length > 1200 || lines > 12) {
      const n = ++this.pasteCounter;
      this.pastes.set(n, text);
      text = `[Pasted text #${n} +${lines} lines]`;
    }
    this.insert(text);
  }

  /** Handles a key. Returns false when the key is not for the editor (e.g. ctrl+c). */
  handleKey(str: string | undefined, key: Key): boolean {
    const name = key.name;
    if (name === 'paste-start') {
      this.inPaste = true;
      this.pasteBuf = '';
      return true;
    }
    if (name === 'paste-end') {
      this.finishPaste();
      this.onChange?.();
      return true;
    }
    if (this.inPaste) {
      if (name === 'return' || name === 'enter') this.pasteBuf += '\n';
      else if (str) this.pasteBuf += str;
      return true;
    }
    if (key.ctrl && !key.meta) {
      switch (name) {
        case 'a':
          this.cursor = this.lineBounds().start;
          break;
        case 'e':
          this.cursor = this.lineBounds().end;
          break;
        case 'b':
          this.cursor = this.prevCharIndex(this.cursor);
          break;
        case 'f':
          this.cursor = this.nextCharIndex(this.cursor);
          break;
        case 'u': {
          const { start } = this.lineBounds();
          this.deleteRange(start === this.cursor && start > 0 ? start - 1 : start, this.cursor);
          break;
        }
        case 'k': {
          const { end } = this.lineBounds();
          this.deleteRange(this.cursor, end === this.cursor && end < this.value.length ? end + 1 : end);
          break;
        }
        case 'w':
        case 'backspace':
          this.deleteRange(this.wordLeft(this.cursor), this.cursor);
          break;
        case 'h':
          this.deleteRange(this.prevCharIndex(this.cursor), this.cursor);
          break;
        case 'j':
          this.insert('\n');
          break;
        case 'left':
          this.cursor = this.wordLeft(this.cursor);
          break;
        case 'right':
          this.cursor = this.wordRight(this.cursor);
          break;
        case 'p':
          if (this.menu) this.menu.selected = (this.menu.selected - 1 + this.menu.items.length) % this.menu.items.length;
          else this.historyPrev();
          break;
        case 'n':
          if (this.menu) this.menu.selected = (this.menu.selected + 1) % this.menu.items.length;
          else this.historyNext();
          break;
        default:
          return false;
      }
      this.onChange?.();
      return true;
    }
    switch (name) {
      case 'return':
        if (key.meta || key.shift) {
          this.insert('\n');
          break;
        }
        if (this.menu && this.acceptCompletion()) return true;
        if (this.value.endsWith('\\') && this.cursor === this.value.length) {
          this.value = this.value.slice(0, -1);
          this.cursor = this.value.length;
          this.insert('\n');
          break;
        }
        this.submit();
        return true;
      case 'enter':
        this.insert('\n');
        break;
      case 'tab':
        if (key.shift) return false;
        if (this.menu) this.acceptCompletion();
        else return true;
        break;
      case 'backspace':
        if (key.meta) this.deleteRange(this.wordLeft(this.cursor), this.cursor);
        else this.deleteRange(this.prevCharIndex(this.cursor), this.cursor);
        break;
      case 'delete':
        this.deleteRange(this.cursor, this.nextCharIndex(this.cursor));
        break;
      case 'left':
        this.cursor = key.meta ? this.wordLeft(this.cursor) : this.prevCharIndex(this.cursor);
        break;
      case 'right':
        if (key.meta) this.cursor = this.wordRight(this.cursor);
        else if (this.cursor === this.value.length && this.menu) this.acceptCompletion();
        else this.cursor = this.nextCharIndex(this.cursor);
        break;
      case 'home':
        this.cursor = this.lineBounds().start;
        break;
      case 'end':
        this.cursor = this.lineBounds().end;
        break;
      case 'up': {
        if (this.menu) {
          this.menu.selected = (this.menu.selected - 1 + this.menu.items.length) % this.menu.items.length;
          break;
        }
        const { start } = this.lineBounds();
        if (start === 0) {
          this.historyPrev();
          break;
        }
        const col = this.cursor - start;
        const prev = this.lineBounds(start - 1);
        this.cursor = Math.min(prev.start + col, prev.end);
        break;
      }
      case 'down': {
        if (this.menu) {
          this.menu.selected = (this.menu.selected + 1) % this.menu.items.length;
          break;
        }
        const { start, end } = this.lineBounds();
        if (end >= this.value.length) {
          this.historyNext();
          break;
        }
        const col = this.cursor - start;
        const next = this.lineBounds(end + 1);
        this.cursor = Math.min(next.start + col, next.end);
        break;
      }
      case 'escape':
        if (this.menu) {
          this.dismissMenu();
          break;
        }
        return false;
      default: {
        if (key.meta && str && str.length === 1) {
          // alt+b / alt+f word movement
          if (name === 'b') this.cursor = this.wordLeft(this.cursor);
          else if (name === 'f') this.cursor = this.wordRight(this.cursor);
          else if (name === 'd') this.deleteRange(this.cursor, this.wordRight(this.cursor));
          else return false;
          break;
        }
        if (!str) return false;
        // Printable text (also handles multi-char input from IME or unbracketed paste)
        const text = str.replace(/\r\n?/g, '\n');
        if ([...text].some((ch) => ch.charCodeAt(0) < 32 && ch !== '\n' && ch !== '\t')) return false;
        this.insert(text);
      }
    }
    this.onChange?.();
    return true;
  }

  /** Renders the input box. */
  render(width: number, opts: { borderColor: (s: string) => string; prompt: string; promptColor?: (s: string) => string; placeholder?: string; showBox?: boolean }): EditorRender {
    const inner = Math.max(10, width - 4);
    const promptW = stringWidth(opts.prompt);
    const textW = Math.max(5, inner - promptW);
    const rows: { text: string; startIdx: number }[] = [];
    // Hard-wrap each logical line by display width, remembering source indices for cursor mapping.
    const value = this.value;
    let cursorRow = 0;
    let cursorCol = 0;
    let idx = 0;
    const logical = value.split('\n');
    for (let li = 0; li < logical.length; li++) {
      const line = logical[li]!;
      let rowText = '';
      let rowW = 0;
      let rowStart = idx;
      let i = 0;
      const chars = [...line];
      for (const ch of chars) {
        const cw = ch === '\t' ? 2 : charWidth(ch.codePointAt(0)!);
        if (rowW + cw > textW) {
          rows.push({ text: rowText, startIdx: rowStart });
          rowText = '';
          rowW = 0;
          rowStart = idx + i;
        }
        if (idx + i === this.cursor) {
          cursorRow = rows.length;
          cursorCol = rowW;
        }
        rowText += ch === '\t' ? '  ' : ch;
        rowW += cw;
        i += ch.length;
      }
      if (idx + i === this.cursor) {
        if (rowW >= textW) {
          rows.push({ text: rowText, startIdx: rowStart });
          rowText = '';
          rowW = 0;
          rowStart = idx + i;
        }
        cursorRow = rows.length;
        cursorCol = rowW;
      }
      rows.push({ text: rowText, startIdx: rowStart });
      idx += line.length + 1;
    }
    const empty = !value.length;
    const border = opts.borderColor;
    const lines: string[] = [];
    const showBox = opts.showBox !== false;
    if (showBox) lines.push(border('╭' + '─'.repeat(width - 2) + '╮'));
    const maxRows = 12;
    let first = 0;
    if (rows.length > maxRows) first = Math.max(0, Math.min(cursorRow - Math.floor(maxRows / 2), rows.length - maxRows));
    const visible = rows.slice(first, first + maxRows);
    visible.forEach((r, i) => {
      const p = i === 0 && first === 0 ? (opts.promptColor ?? ((s: string) => s))(opts.prompt) : ' '.repeat(promptW);
      let text = r.text;
      if (empty && opts.placeholder) text = c.dim(truncateToWidth(opts.placeholder, textW));
      const content = padEndWidth(p + text, inner);
      lines.push(showBox ? border('│') + ' ' + content + ' ' + border('│') : content);
    });
    if (showBox) lines.push(border('╰' + '─'.repeat(width - 2) + '╯'));
    return {
      lines,
      cursorRow: (showBox ? 1 : 0) + (cursorRow - first),
      cursorCol: (showBox ? 2 : 0) + promptW + cursorCol,
    };
  }

  renderMenu(width: number, maxItems = 8): string[] {
    if (!this.menu) return [];
    const { items, selected } = this.menu;
    let start = 0;
    if (items.length > maxItems) start = Math.max(0, Math.min(selected - Math.floor(maxItems / 2), items.length - maxItems));
    const slice = items.slice(start, start + maxItems);
    const labelW = Math.min(Math.max(...slice.map((i) => stringWidth(i.label))) + 2, Math.floor(width * 0.45));
    const out = slice.map((item, i) => {
      const isSel = start + i === selected;
      const label = padEndWidth(truncateToWidth(item.label, labelW - 1), labelW);
      const desc = item.description ? truncateToWidth(item.description, Math.max(10, width - labelW - 6)) : '';
      return isSel ? '  ' + theme.accent(c.bold(label)) + ' ' + desc : '  ' + label + ' ' + c.dim(desc);
    });
    if (items.length > maxItems) out.push(c.dim(`  … ${items.length - maxItems} more (↑/↓ to scroll)`));
    return out;
  }
}
