// Tool registry.
import type { Tool } from './types.js';
import { EditTool, MultiEditTool, ReadTool, WriteTool } from './fileTools.js';
import { BashOutputTool, BashTool, KillShellTool } from './bash.js';
import { GlobTool, GrepTool, LSTool } from './searchTools.js';
import { WebFetchTool, WebSearchTool } from './webTools.js';
import { AskUserTool, ExitPlanModeTool, TaskTool, TodoWriteTool } from './metaTools.js';
import { SkillTool } from './skillTool.js';
import { BrowserTool } from './browserTool.js';
import { DesktopTool } from './desktopTool.js';
import { isWindows } from '../util/platform.js';

export const BUILTIN_TOOLS: Tool[] = [
  ReadTool,
  EditTool,
  MultiEditTool,
  WriteTool,
  BashTool,
  BashOutputTool,
  KillShellTool,
  GlobTool,
  GrepTool,
  LSTool,
  WebFetchTool,
  WebSearchTool,
  BrowserTool,
  DesktopTool,
  TodoWriteTool,
  TaskTool,
  AskUserTool,
  SkillTool,
  ExitPlanModeTool,
];

export interface ToolSetOptions {
  /** 0 = main agent, 1 = sub-agent */
  depth: number;
  planMode: boolean;
  /** Sub-agent flavour */
  agentType?: string;
  extra?: Tool[];
  disallowed?: string[];
  interactive: boolean;
  /** Offer the Skill tool (only when skills are installed). */
  hasSkills?: boolean;
}

/** Tools offered to the model for one request. */
export function selectTools(opts: ToolSetOptions): Tool[] {
  let tools = [...BUILTIN_TOOLS, ...(opts.extra ?? [])];
  if (opts.depth > 0) {
    const explore = opts.agentType === 'explore';
    const allowed = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Bash', 'BashOutput', 'Browser', ...(explore ? [] : ['Edit', 'MultiEdit', 'Write', 'TodoWrite'])]);
    tools = tools.filter((t) => allowed.has(t.name) || t.category === 'mcp');
  } else {
    if (!opts.planMode) tools = tools.filter((t) => t.name !== 'ExitPlanMode');
  }
  if (!opts.interactive) tools = tools.filter((t) => t.name !== 'AskUserQuestion');
  if (!opts.hasSkills) tools = tools.filter((t) => t.name !== 'Skill');
  if (!isWindows) tools = tools.filter((t) => t.name !== 'Desktop');
  if (opts.disallowed?.length) {
    const deny = new Set(opts.disallowed.map((d) => d.replace(/\(.*$/, '')));
    tools = tools.filter((t) => !deny.has(t.name));
  }
  return tools;
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name) ?? tools.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? tools.find((t) => aliasOf(name) === t.name);
}

/** Common names other agents use for the same tools (helps models trained on other harnesses). */
const ALIASES: Record<string, string> = {
  read_file: 'Read',
  readfile: 'Read',
  view: 'Read',
  cat: 'Read',
  open_file: 'Read',
  write_file: 'Write',
  writefile: 'Write',
  create_file: 'Write',
  edit_file: 'Edit',
  str_replace: 'Edit',
  str_replace_editor: 'Edit',
  replace_in_file: 'Edit',
  apply_edit: 'Edit',
  search_replace: 'Edit',
  multi_edit: 'MultiEdit',
  bash: 'Bash',
  shell: 'Bash',
  run_command: 'Bash',
  run_terminal_cmd: 'Bash',
  execute_command: 'Bash',
  terminal: 'Bash',
  exec: 'Bash',
  glob: 'Glob',
  find_files: 'Glob',
  file_search: 'Glob',
  grep: 'Grep',
  search: 'Grep',
  search_files: 'Grep',
  grep_search: 'Grep',
  codebase_search: 'Grep',
  ls: 'LS',
  list_dir: 'LS',
  list_directory: 'LS',
  list_files: 'LS',
  web_fetch: 'WebFetch',
  fetch: 'WebFetch',
  fetch_url: 'WebFetch',
  web_search: 'WebSearch',
  todo_write: 'TodoWrite',
  todowrite: 'TodoWrite',
  update_todos: 'TodoWrite',
  task: 'Task',
  agent: 'Task',
  ask_user: 'AskUserQuestion',
  askuser: 'AskUserQuestion',
  ask_user_question: 'AskUserQuestion',
  ask_followup_question: 'AskUserQuestion',
  ask: 'AskUserQuestion',
  exit_plan_mode: 'ExitPlanMode',
};

export function aliasOf(name: string): string | undefined {
  return ALIASES[name.toLowerCase().replace(/[-\s]/g, '_')];
}
