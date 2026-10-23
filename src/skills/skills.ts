// Skills: folders with a SKILL.md (YAML front matter "name" and "description", then instructions),
// the same format Claude Code uses. FreeCode reads them from:
//   ~/.claude/skills/*/SKILL.md   ~/.freecode/skills/*/SKILL.md            (user)
//   <project>/.claude/skills/*/SKILL.md   <project>/.freecode/skills/*/SKILL.md   (project)
// Later locations win when two skills share a name.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { freecodeHome } from '../config/paths.js';

export interface Skill {
  name: string;
  description: string;
  /** Folder that holds SKILL.md (scripts and references are relative to it). */
  dir: string;
  file: string;
  scope: 'user' | 'project';
}

/** Parses simple YAML front matter (key: value, quoted values, folded/literal blocks). */
export function parseFrontMatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-' || value === '') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1]!) && !/^[A-Za-z0-9_-]+:/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim();
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[kv[1]!] = value;
  }
  return { data, body: text.slice(m[0].length) };
}

export function skillDirs(projectRoot: string): { dir: string; scope: Skill['scope'] }[] {
  return [
    { dir: path.join(os.homedir(), '.claude', 'skills'), scope: 'user' },
    { dir: path.join(freecodeHome(), 'skills'), scope: 'user' },
    { dir: path.join(projectRoot, '.claude', 'skills'), scope: 'project' },
    { dir: path.join(projectRoot, '.freecode', 'skills'), scope: 'project' },
  ];
}

export function userSkillsDir(): string {
  return path.join(freecodeHome(), 'skills');
}

export function loadSkills(projectRoot: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const { dir, scope } of skillDirs(projectRoot)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n, 'SKILL.md');
      try {
        if (!statSync(file).isFile()) continue;
        const { data } = parseFrontMatter(readFileSync(file, 'utf8').slice(0, 8000));
        const name = (data.name || n).trim();
        byName.set(name.toLowerCase(), { name, description: (data.description || '').trim(), dir: path.join(dir, n), file, scope });
      } catch {
        // not a skill folder
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const cache = new Map<string, { at: number; skills: Skill[] }>();

/** loadSkills() for hot paths (the prompt and tool list are built every step). */
export function loadSkillsCached(projectRoot: string): Skill[] {
  const hit = cache.get(projectRoot);
  if (hit && Date.now() - hit.at < 10_000) return hit.skills;
  const skills = loadSkills(projectRoot);
  cache.set(projectRoot, { at: Date.now(), skills });
  return skills;
}

export function clearSkillsCache(): void {
  cache.clear();
}

export function findSkill(projectRoot: string, name: string): Skill | undefined {
  const want = name.trim().toLowerCase().replace(/^\//, '');
  const all = loadSkills(projectRoot);
  return all.find((s) => s.name.toLowerCase() === want) ?? all.find((s) => path.basename(s.dir).toLowerCase() === want);
}

/** The skills section of the system prompt (names and descriptions only; the agent loads one with the Skill tool). */
export function skillsPromptSection(skills: Skill[]): string {
  if (!skills.length) return '';
  const lines = skills.slice(0, 60).map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 300)}`);
  return `# Skills\nSkills are expert playbooks for specific kinds of work. When a request matches one of these, call the Skill tool with its name BEFORE starting, then follow its instructions.\n${lines.join('\n')}`;
}
