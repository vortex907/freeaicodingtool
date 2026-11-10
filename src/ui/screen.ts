// Terminal screen manager: permanent output scrolls above a "live region" (spinner, input box, menus)
// that is redrawn in place. All writes are batched into one stdout.write per frame to avoid flicker.
import * as readline from 'node:readline';
import { stringWidth, term, truncateToWidth } from '../util/ansi.js';
import { isWindows } from '../util/platform.js';

export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

export interface LiveFrame {
  lines: string[];
  /** Cursor position inside `lines` (row index, display column). Hidden when absent. */
  cursor?: { row: number; col: number };
}

export class Screen {
  readonly out = process.stdout;
  readonly input = process.stdin;
  readonly isTTY = !!process.stdout.isTTY && !!process.stdin.isTTY;
  private liveRows = 0;
  private cursorRow = 0; // row inside the live region where the terminal cursor currently is
  private pendingLog: string[] = [];
  private renderer: (() => LiveFrame) | null = null;
  private scheduled: NodeJS.Timeout | null = null;
  private lastFrameKey = '';
  private keyHandler: ((str: string | undefined, key: Key) => void) | null = null;
  private started = false;
  private paused = false;

  get width(): number {
    const w = this.out.columns || 100;
    return Math.max(20, w);
  }

  get height(): number {
    return Math.max(10, this.out.rows || 40);
  }

  start(onKey: (str: string | undefined, key: Key) => void): void {
    if (this.started) return;
    this.started = true;
    this.keyHandler = onKey;
    if (this.isTTY) {
      readline.emitKeypressEvents(this.input, { escapeCodeTimeout: 40 } as unknown as readline.Interface);
      this.input.setRawMode(true);
      this.out.write(term.bracketedPasteOn);
    }
    this.input.on('keypress', this.onKeypress);
    this.input.resume();
    this.out.on('resize', this.onResize);
    process.on('exit', this.restore);
    if (!isWindows) {
      process.on('SIGCONT', this.onCont);
    }
  }

  private onKeypress = (str: string | undefined, key: Key | undefined) => {
    if (this.paused) return;
    this.keyHandler?.(str, key ?? { sequence: str });
  };

  private onResize = () => {
    // Line wrapping changed: the old live region height is unknown now, clear what we can.
    this.lastFrameKey = '';
    this.requestRender(true);
  };

  private onCont = () => {
    if (this.isTTY) {
      this.input.setRawMode(true);
      this.out.write(term.bracketedPasteOn);
    }
    this.liveRows = 0;
    this.cursorRow = 0;
    this.requestRender(true);
  };

  /** Suspends the process (Ctrl+Z). */
  suspend(): void {
    if (isWindows) return;
    this.clearLive();
    this.restore();
    process.kill(process.pid, 'SIGTSTP');
  }

  restore = (): void => {
    if (!this.isTTY) return;
    try {
      this.out.write(term.bracketedPasteOff + term.showCursor);
      this.input.setRawMode(false);
    } catch {
      // stream closed
    }
  };

  stop(): void {
    if (!this.started) return;
    this.flush();
    this.clearLive();
    this.input.off('keypress', this.onKeypress);
    this.out.off('resize', this.onResize);
    this.restore();
    this.input.pause();
    this.started = false;
  }

  /** Temporarily give the terminal back (e.g. to run an editor). */
  pause(): void {
    this.flush();
    this.clearLive();
    this.paused = true;
    if (this.isTTY) this.input.setRawMode(false);
    this.out.write(term.showCursor);
  }

  resume(): void {
    this.paused = false;
    if (this.isTTY) this.input.setRawMode(true);
    this.liveRows = 0;
    this.cursorRow = 0;
    this.requestRender(true);
  }

  setRenderer(fn: (() => LiveFrame) | null): void {
    this.renderer = fn;
    this.requestRender(true);
  }

  /** Appends permanent output (may contain newlines). */
  print(text: string): void {
    this.pendingLog.push(text);
    this.requestRender(true);
  }

  /** Schedules a redraw of the live region. */
  requestRender(force = false): void {
    if (force) this.lastFrameKey = '';
    if (this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.flush();
    }, 16);
  }

  private clearLive(): string {
    if (!this.liveRows) return '';
    const seq = term.up(this.cursorRow) + '\r' + term.clearDown;
    this.out.write(seq);
    this.liveRows = 0;
    this.cursorRow = 0;
    return seq;
  }

  /** Writes pending output and redraws the live region now. */
  flush(): void {
    if (this.scheduled) {
      clearTimeout(this.scheduled);
      this.scheduled = null;
    }
    if (this.paused) return;
    const frame = this.renderer ? this.renderer() : { lines: [] };
    const width = this.width;
    // Fit the frame to the terminal (each line shorter than width to avoid auto-wrap surprises).
    let lines = frame.lines.map((l) => (stringWidth(l) >= width ? truncateToWidth(l, width - 1) : l));
    const maxRows = Math.max(3, this.height - 1);
    let cursor = frame.cursor;
    if (lines.length > maxRows) {
      const drop = lines.length - maxRows;
      lines = lines.slice(drop);
      if (cursor) cursor = { row: Math.max(0, cursor.row - drop), col: cursor.col };
    }
    const key = lines.join('\n') + (cursor ? `@${cursor.row}:${cursor.col}` : '');
    if (!this.pendingLog.length && key === this.lastFrameKey) return;
    this.lastFrameKey = key;
    let buf = term.hideCursor;
    if (this.liveRows) buf += term.up(this.cursorRow) + '\r' + term.clearDown;
    if (this.pendingLog.length) {
      let log = this.pendingLog.join('');
      this.pendingLog = [];
      if (!log.endsWith('\n')) log += '\n';
      buf += log.replace(/\n/g, '\r\n');
    }
    if (lines.length) {
      buf += lines.join('\r\n');
      const lastRow = lines.length - 1;
      if (cursor) {
        buf += term.up(lastRow - cursor.row) + '\r' + term.right(cursor.col) + term.showCursor;
        this.cursorRow = cursor.row;
      } else this.cursorRow = lastRow;
      this.liveRows = lines.length;
    } else {
      this.liveRows = 0;
      this.cursorRow = 0;
    }
    this.out.write(buf);
  }

  /** Clears the whole screen and scrollback. */
  clearScreen(): void {
    this.out.write(term.clearScreen);
    this.liveRows = 0;
    this.cursorRow = 0;
    this.requestRender(true);
  }
}
