// UI host: owns the Screen, routes keys to the active modal widget or to the REPL, and draws spinners.
import { Screen, type Key, type LiveFrame } from './screen.js';
import type { Widget } from './widgets.js';
import { c, theme } from '../util/ansi.js';
import { formatDuration } from '../util/strings.js';

export const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

interface ActiveModal {
  widget: Widget<unknown>;
  resolve: (v: unknown) => void;
}

export class UIHost {
  readonly screen = new Screen();
  private modals: ActiveModal[] = [];
  private spinner: { text: string; started: number } | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private animators = 0;
  /** Normal (non-modal) frame provider and key handler (set by the REPL). */
  baseFrame: (() => LiveFrame) | null = null;
  baseKey: ((str: string | undefined, key: Key) => void) | null = null;
  frameCounter = 0;

  get width(): number {
    return this.screen.width;
  }

  start(): void {
    this.screen.start((s, k) => this.onKey(s, k));
    this.screen.setRenderer(() => this.frame());
  }

  stop(): void {
    this.stopAnimation(true);
    this.screen.stop();
  }

  get hasModal(): boolean {
    return this.modals.length > 0;
  }

  private onKey(str: string | undefined, key: Key): void {
    const top = this.modals[this.modals.length - 1];
    if (top) {
      const r = top.widget.handleKey(str, key);
      if (r.done) {
        this.modals.pop();
        top.resolve(r.value);
      }
      this.screen.requestRender(true);
      return;
    }
    if (key.ctrl && key.name === 'z') {
      this.screen.suspend();
      return;
    }
    this.baseKey?.(str, key);
    this.screen.requestRender();
  }

  frame(): LiveFrame {
    this.frameCounter++;
    const top = this.modals[this.modals.length - 1];
    if (top) {
      const r = top.widget.render(this.width - 1);
      const lines = [...r.lines];
      if (this.spinner) lines.push(this.spinnerLine());
      return { lines, cursor: r.cursor };
    }
    if (this.baseFrame) return this.baseFrame();
    return { lines: this.spinner ? [this.spinnerLine()] : [] };
  }

  spinnerGlyph(): string {
    return theme.accent(SPINNER_FRAMES[Math.floor(Date.now() / 120) % SPINNER_FRAMES.length]!);
  }

  spinnerLine(text?: string, started?: number): string {
    const t = text ?? this.spinner?.text ?? '';
    const s = started ?? this.spinner?.started ?? Date.now();
    return `${this.spinnerGlyph()} ${theme.accent(t)} ${c.dim(`(${formatDuration(Date.now() - s)})`)}`;
  }

  /** Shows a widget as a modal and resolves with its result (null when cancelled). */
  showWidget<T>(widget: Widget<T>): Promise<T | null> {
    return new Promise((resolve) => {
      this.modals.push({ widget: widget as Widget<unknown>, resolve: resolve as (v: unknown) => void });
      this.screen.requestRender(true);
    });
  }

  /** Runs an async job while showing a spinner line. */
  async withSpinner<T>(text: string, fn: () => Promise<T>): Promise<T> {
    this.spinner = { text, started: Date.now() };
    this.startAnimation();
    try {
      return await fn();
    } finally {
      this.spinner = null;
      this.stopAnimation();
      this.screen.requestRender(true);
    }
  }

  startAnimation(): void {
    this.animators++;
    if (this.ticker) return;
    this.ticker = setInterval(() => this.screen.requestRender(), 100);
  }

  stopAnimation(all = false): void {
    this.animators = all ? 0 : Math.max(0, this.animators - 1);
    if (this.animators === 0 && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  print(text: string): void {
    this.screen.print(text);
  }

  printLines(lines: string[]): void {
    if (lines.length) this.screen.print(lines.join('\n'));
  }
}
