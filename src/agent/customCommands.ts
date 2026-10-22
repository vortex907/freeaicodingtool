// Custom slash commands from Markdown files:
//   .freecode/commands/*.md, .claude/commands/*.md (project) and ~/.freecode/commands/*.md (user).
// The file body is the prompt; $ARGUMENTS (and $1, $2, ...) are replaced with what follows the command.
// Optional front matter: description, argument-hint.
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { globalPaths, projectPaths } from '../config/paths.js';

export interface CustomCommand {
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
  source: 'project' | 'user';
  file: string;
}

function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: raw.slice(m[0].length) };
}

async function scan(dir: string, source: CustomCommand['source'], prefix = ''): Promise<CustomCommand[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: CustomCommand[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await scan(p, source, `${prefix}${e.name}:`)));
    else if (e.isFile() && e.name.endsWith('.md')) {
      try {
        const raw = await fsp.readFile(p, 'utf8');
        const { meta, body } = parseFrontMatter(raw);
        const name = `${prefix}${e.name.slice(0, -3)}`.toLowerCase().replace(/\s+/g, '-');
        const firstLine = body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? '';
        out.push({ name, description: meta.description ?? firstLine.slice(0, 80), argumentHint: meta['argument-hint'], body: body.trim(), source, file: p });
      } catch {
        // skip unreadable
      }
    }
  }
  return out;
}

export async function loadCustomCommands(projectRoot: string): Promise<CustomCommand[]> {
  const pp = projectPaths(projectRoot);
  const lists = await Promise.all([
    scan(globalPaths.commandsDir, 'user'),
    scan(path.join(os.homedir(), '.claude', 'commands'), 'user'),
    scan(pp.claudeCommandsDir, 'project'),
    scan(pp.commandsDir, 'project'),
  ]);
  const byName = new Map<string, CustomCommand>();
  for (const list of lists) for (const c of list) byName.set(c.name, c); // later (project) wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCommand(cmd: CustomCommand, args: string): string {
  let body = cmd.body;
  const positional = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map((a) => a.replace(/^["']|["']$/g, '')) ?? [];
  const hadPlaceholder = /\$ARGUMENTS|\$\d/.test(body);
  body = body.replace(/\$ARGUMENTS/g, args);
  body = body.replace(/\$(\d)/g, (_, n: string) => positional[Number(n) - 1] ?? '');
  if (!hadPlaceholder && args.trim()) body += `\n\nArguments: ${args}`;
  return body;
}
