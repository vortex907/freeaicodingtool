// Skill: loads one of the installed skills (see src/skills/skills.ts) into the conversation.
import { readFileSync } from 'node:fs';
import type { Tool } from './types.js';
import { errorResult, fail, ok, strParam } from './types.js';
import { findSkill, loadSkills, parseFrontMatter } from '../skills/skills.js';

export const SkillTool: Tool = {
  name: 'Skill',
  category: 'meta',
  planSafe: true,
  parallelSafe: true,
  description:
    'Load a skill: an expert playbook listed under "Skills" in your instructions (for example for PDFs, Word/Excel files, frontend design, testing web apps). ' +
    'Call it before starting work that matches a skill, then follow the instructions it returns.',
  parameters: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'The skill name exactly as listed, e.g. "pdf"' },
    },
    required: ['skill'],
  },
  label: (input) => `Skill(${strParam(input, 'skill', 'name', 'command') ?? '?'})`,
  async prepare(input, ctx) {
    const name = strParam(input, 'skill', 'name', 'command');
    if (!name) return errorResult('Missing required parameter: skill');
    return {
      execute: async () => {
        const skill = findSkill(ctx.projectRoot, name);
        if (!skill) {
          const all = loadSkills(ctx.projectRoot).map((s) => s.name);
          return fail(`No skill named "${name}". Installed skills: ${all.length ? all.join(', ') : 'none'}.`);
        }
        const { body } = parseFrontMatter(readFileSync(skill.file, 'utf8'));
        return ok(
          `Skill "${skill.name}" loaded. Its folder is ${skill.dir}; file paths in these instructions are relative to that folder.\n\n${body.trim()}`,
          { kind: 'summary', text: `Loaded the ${skill.name} skill` },
        );
      },
    };
  },
};
