// System prompt construction.
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { PermissionMode } from '../config/config.js';
import { detectShell, osDescription } from '../util/platform.js';
import { gitInfo } from '../util/git.js';
import type { MemoryFile } from './memory.js';
import { DEFAULT_IGNORED_DIRS } from '../tools/listFiles.js';

export const CORE_PROMPT = `You are FreeCode, an AI coding agent working in the user's terminal on their own computer. You help with software engineering: writing and changing code, fixing bugs, refactoring, explaining code, running builds/tests, and using git. You act through the tools you are given; the user sees your tool calls and their results.

# How to work
1. Understand the request. If it is a question, answer it (read the relevant code first when the answer depends on it). If it asks for a change, make the change instead of only describing it.
2. Explore before changing: use Glob/Grep to find the relevant files and Read to look at them. Never guess file contents, function names, APIs or config values you can check.
3. For work with 3 or more steps, keep a todo list with TodoWrite (exactly one item in_progress; mark items completed as soon as they are done).
4. Make changes with Edit/MultiEdit (existing files) or Write (new files). Keep changes focused on what was asked and follow the project's existing style, libraries and patterns. Check that a library is already used before adding it.
5. Verify your work: run the project's tests, type checker, linter or build if they exist (check package.json, Makefile, pyproject.toml, Cargo.toml, ...). Fix failures you introduced.
6. Finish with a short summary of what you did and anything the user still needs to do.

# Tool rules
- Read a file before editing it. old_string must match the file exactly; copy it from the Read output WITHOUT the line-number prefix and keep the indentation.
- Prefer Edit over Write for existing files. Never edit files with Bash (no sed -i, echo >, cat <<EOF).
- Use Glob/Grep/LS instead of find/grep/ls, and Read instead of cat/head/tail.
- When tool calls are independent (e.g. reading several files), make them together in one reply.
- Bash commands must not be interactive. Start servers/watchers with run_in_background=true. Quote paths that contain spaces.
- Use Task to delegate broad searches or research to a sub-agent so your own context stays small.
- If a tool call fails, read the error and correct the call; never repeat the exact same failing call.
- Don't create files the task doesn't need (no unrequested docs/READMEs). Don't commit, push or change git config unless the user asks.

# Communication
- Be concise and direct; your output is shown in a terminal and rendered as Markdown. No filler, flattery or apologies.
- Don't narrate each step before doing it. Explain decisions only when useful.
- Reference code locations as \`path/to/file.ext:line\`.
- If an important detail is ambiguous, ask (AskUser) rather than guess. If you can't do something, say so plainly.

# Safety
- Don't run destructive commands (rm -rf, git reset --hard, force-push, dropping databases, deleting branches) unless the user explicitly asked for exactly that.
- Never reveal or commit secrets (API keys, tokens, .env contents). Refuse to write malware or code meant to harm others.`;

export const PLAN_MODE_PROMPT = `# PLAN MODE IS ACTIVE
You must not modify anything: no file edits, no commands that change state. Research with Read, Glob, Grep, LS, WebFetch/WebSearch and read-only Bash commands. Then present a concrete, step-by-step implementation plan (files to change and how) by calling ExitPlanMode, and wait for the user's approval. For pure questions, just answer without ExitPlanMode.`;

export const SUBAGENT_PROMPT = `You are a FreeCode sub-agent. The main agent gave you a task; complete it autonomously with your tools and then reply with a concise, complete report of exactly what was asked (include file paths with line numbers, key code snippets and concrete findings). Your final reply is returned to the main agent, not shown to the user, so don't ask questions back - make reasonable assumptions and state them. Do only what the task asks.`;

async function topLevelListing(dir: string): Promise<string> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const names = entries
      .filter((e) => !e.name.startsWith('.') || ['.github', '.env.example', '.gitignore'].includes(e.name))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
      .map((e) => (e.isDirectory() ? `${e.name}/${DEFAULT_IGNORED_DIRS.has(e.name) ? ' (skipped)' : ''}` : e.name));
    const shown = names.slice(0, 60);
    return shown.join('\n') + (names.length > 60 ? `\n... (${names.length - 60} more)` : '');
  } catch {
    return '(unreadable)';
  }
}

export interface PromptContext {
  projectRoot: string;
  cwd: string;
  mode: PermissionMode;
  memory: MemoryFile[];
  depth: number;
  mcpInstructions?: string[];
  extraSections?: string[];
  /** Name/key of the model that will receive the prompt (optional). */
  modelName?: string;
}

/** Builds the environment section (cached by the caller per turn). */
export async function environmentSection(projectRoot: string, cwd: string): Promise<string> {
  const g = await gitInfo(cwd).catch(() => null);
  const shell = detectShell();
  const lines = [
    `Working directory: ${cwd}`,
    projectRoot !== cwd ? `Project root: ${projectRoot}` : '',
    `Platform: ${osDescription()}`,
    `Shell: ${shell.name}`,
    shell.kind === 'powershell' ? 'Shell syntax: PowerShell. Chain commands with ";" (Windows PowerShell 5.1 has no "&&"), set variables with $env:NAME = "value", and do not add 2>&1 (output and errors are both captured).' : '',
    shell.kind === 'cmd' ? 'Shell syntax: cmd.exe. Chain commands with "&&", set variables with set NAME=value.' : '',
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    g ? `Git: repository on branch "${g.branch}"${g.mainBranch ? ` (main branch: ${g.mainBranch})` : ''}, ${g.status.length ? `${g.status.length} uncommitted change(s)` : 'clean working tree'}` : 'Git: not a git repository',
  ].filter(Boolean);
  let out = `<environment>\n${lines.join('\n')}\n</environment>`;
  if (g?.recentCommits.length) out += `\n\nRecent commits:\n${g.recentCommits.join('\n')}`;
  if (g?.status.length) out += `\n\nUncommitted changes (git status --porcelain):\n${g.status.slice(0, 20).join('\n')}${g.status.length > 20 ? '\n...' : ''}`;
  out += `\n\nFiles in ${path.basename(cwd) || cwd}/:\n${await topLevelListing(cwd)}`;
  return out;
}

export function buildSystemPrompt(ctx: PromptContext, envSection: string): string {
  const parts: string[] = [ctx.depth > 0 ? `${SUBAGENT_PROMPT}\n\n${CORE_PROMPT.split('# Communication')[0]!.trim()}` : CORE_PROMPT];
  if (ctx.mode === 'plan' && ctx.depth === 0) parts.push(PLAN_MODE_PROMPT);
  parts.push(envSection);
  if (ctx.memory.length) {
    const mem = ctx.memory
      .map((m) => `## Instructions from ${m.scope === 'global' ? '~/' + path.basename(path.dirname(m.path)) + '/' + path.basename(m.path) : path.relative(ctx.projectRoot, m.path) || path.basename(m.path)}\n${m.content}`)
      .join('\n\n');
    parts.push(`# Project & user instructions\nFollow these instructions; they override the defaults above.\n\n${mem}`);
  }
  if (ctx.mcpInstructions?.length) parts.push(`# MCP servers\n${ctx.mcpInstructions.join('\n\n')}`);
  if (ctx.extraSections?.length) parts.push(...ctx.extraSections);
  return parts.join('\n\n');
}
