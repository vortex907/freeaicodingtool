// Tool interfaces shared by the agent, the permission engine and the UI.
import type { Settings } from '../config/config.js';
import type { FileTracker } from './fileTracker.js';
import type { ToolSchema } from '../providers/types.js';

export type ToolCategory = 'read' | 'edit' | 'execute' | 'network' | 'meta' | 'mcp';

export interface PermissionRequest {
  tool: string;
  category: ToolCategory;
  /** Dialog title, e.g. "Bash command" */
  title: string;
  /** Main line: the command, path or URL */
  subject: string;
  /** Explanation shown under the subject */
  description?: string;
  /** Pre-rendered preview (diff, file content) */
  preview?: ToolDisplay;
  /** Rule that "don't ask again" would add, e.g. Bash(npm install:*) */
  ruleSuggestion?: string;
  ruleLabel?: string;
  /** Absolute path for file operations */
  path?: string;
  /** Raw command for Bash */
  command?: string;
  /** URL / domain for network tools */
  domain?: string;
  /** What Tool(specifier) rules match for other tools, e.g. "python" for REPL(python) */
  specifier?: string;
  /** Extra warning for destructive operations */
  danger?: string;
  /** Tool reported it only reads (MCP readOnlyHint, safe bash). */
  readOnly?: boolean;
}

export type ToolDisplay =
  | { kind: 'text'; text: string; maxLines?: number; dim?: boolean }
  | { kind: 'diff'; path: string; hunks: DiffHunk[]; added: number; removed: number; created?: boolean }
  | { kind: 'summary'; text: string }
  | { kind: 'todos'; todos: Todo[] }
  | { kind: 'markdown'; text: string }
  | { kind: 'none' };

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
  id?: string;
}

export interface ToolResult {
  /** Text sent back to the model */
  content: string;
  isError?: boolean;
  /** What the UI shows under the tool call */
  display?: ToolDisplay;
}

export interface BackgroundShell {
  id: string;
  command: string;
  startedAt: number;
  output: string;
  readOffset: number;
  exitCode: number | null;
  running: boolean;
  kill: () => void;
}

/** Mutable per-session state that tools share. */
export interface SessionState {
  cwd: string;
  todos: Todo[];
  shells: Map<string, BackgroundShell>;
  shellCounter: number;
  /** Number of tool results so far (lets Read spot a re-read of something still in view). */
  toolSeq?: number;
  permissionMode: Settings['permissions']['mode'];
  /** Set by ExitPlanMode when the user approves a plan. */
  planApproved?: boolean;
}

export interface SubagentRequest {
  description: string;
  prompt: string;
  agentType?: string;
  signal: AbortSignal;
  parentToolCallId: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

/** A multiple-choice question for the user (the user can always type their own answer). */
export interface UserQuestion {
  question: string;
  /** Very short chip label, e.g. "Framework". */
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionAnswer {
  question: string;
  header?: string;
  /** Labels of the chosen options. */
  selected: string[];
  /** Free-text answer typed instead of (or in addition to) the options. */
  other?: string;
}

export interface ToolServices {
  /** Report live progress (e.g. tail of a running command). */
  progress: (text: string) => void;
  /** Ask the human multiple-choice questions (undefined in non-interactive mode). Null = dismissed. */
  askUser?: (questions: UserQuestion[]) => Promise<QuestionAnswer[] | null>;
  /** Present a plan for approval (plan mode). Returns the chosen mode or null to keep planning. */
  approvePlan?: (plan: string) => Promise<'acceptEdits' | 'default' | null>;
  /** Run a sub-agent (Task tool). */
  runSubagent?: (req: SubagentRequest) => Promise<string>;
  /** Condense a long text with a cheap model (WebFetch with a prompt). */
  summarize?: (text: string, instruction: string, signal: AbortSignal) => Promise<string>;
}

export interface ToolContext {
  projectRoot: string;
  session: SessionState;
  settings: Settings;
  files: FileTracker;
  signal: AbortSignal;
  toolCallId: string;
  services: ToolServices;
  /** Nesting depth (0 = main agent) */
  depth: number;
}

export interface PreparedCall {
  /** When set, the call needs (or may need) approval. */
  permission?: PermissionRequest;
  /** Validation error: returned to the model without running anything. */
  error?: ToolResult;
  execute: () => Promise<ToolResult>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  category: ToolCategory;
  /** Can run concurrently with other parallel-safe calls. */
  parallelSafe?: boolean;
  /** Allowed in plan mode (read-only exploration). */
  planSafe?: boolean;
  /** Short UI label, e.g. Read(src/index.ts) */
  label: (input: Record<string, unknown>, ctx: { cwd: string; projectRoot: string }) => string;
  prepare: (input: Record<string, unknown>, ctx: ToolContext) => Promise<PreparedCall>;
}

export function toolSchema(t: Tool): ToolSchema {
  return { name: t.name, description: t.description, parameters: t.parameters };
}

export function errorResult(message: string): PreparedCall {
  return { error: { content: message, isError: true, display: { kind: 'summary', text: message.split('\n')[0]! } }, execute: async () => ({ content: message, isError: true }) };
}

export function ok(content: string, display?: ToolDisplay): ToolResult {
  return { content, display };
}

export function fail(content: string, display?: ToolDisplay): ToolResult {
  return { content, isError: true, display: display ?? { kind: 'summary', text: content.split('\n')[0]! } };
}

/** Read a string parameter (tolerating alternative names models invent). */
export function strParam(input: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = input[n];
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

export function numParam(input: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const n of names) {
    const v = input[n];
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && !isNaN(Number(v))) return Number(v);
  }
  return undefined;
}

export function boolParam(input: Record<string, unknown>, ...names: string[]): boolean | undefined {
  for (const n of names) {
    const v = input[n];
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return undefined;
}
