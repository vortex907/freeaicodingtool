// TodoWrite, Task (sub-agents), ExitPlanMode and AskUserQuestion tools.
import type { PreparedCall, QuestionAnswer, QuestionOption, Todo, Tool, UserQuestion } from './types.js';
import { errorResult, ok, strParam } from './types.js';
import { truncate } from '../util/strings.js';

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

function normalizeStatus(s: unknown): Todo['status'] {
  const v = String(s ?? 'pending').toLowerCase().replace(/[\s-]+/g, '_');
  if (STATUSES.has(v)) return v as Todo['status'];
  if (/done|complete|finished|closed/.test(v)) return 'completed';
  if (/progress|doing|active|working|started/.test(v)) return 'in_progress';
  return 'pending';
}

export const TodoWriteTool: Tool = {
  name: 'TodoWrite',
  category: 'meta',
  planSafe: true,
  description:
    'Create or update your task list for the current job. Use it for any task with 3+ steps: write all steps first, mark exactly one as in_progress while you work on it, ' +
    'and mark each completed as soon as it is done. Always send the FULL list (it replaces the previous one).',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete task list',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Task description (imperative, e.g. "Add login route")' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            activeForm: { type: 'string', description: 'Present-continuous form shown while working, e.g. "Adding login route"' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  label: () => 'Update Todos',
  async prepare(input, ctx): Promise<PreparedCall> {
    let raw = input.todos ?? input.tasks ?? input.items;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return errorResult('todos must be an array of {content, status} objects');
      }
    }
    if (!Array.isArray(raw)) return errorResult('todos must be an array of {content, status} objects');
    const todos: Todo[] = [];
    for (const t of raw) {
      if (typeof t === 'string') {
        todos.push({ content: t, status: 'pending' });
        continue;
      }
      const o = (t ?? {}) as Record<string, unknown>;
      const content = strParam(o, 'content', 'task', 'title', 'description', 'text');
      if (!content) continue;
      todos.push({ content, status: normalizeStatus(o.status ?? o.state), activeForm: strParam(o, 'activeForm', 'active_form'), id: strParam(o, 'id') });
    }
    return {
      execute: async () => {
        ctx.session.todos = todos;
        const done = todos.filter((t) => t.status === 'completed').length;
        const doing = todos.filter((t) => t.status === 'in_progress').length;
        let note = '';
        if (doing > 1) note = ' Note: keep only ONE task in_progress at a time.';
        if (todos.length && done === todos.length) note = ' All tasks are completed.';
        return ok(`Todo list updated: ${todos.length} tasks (${done} completed, ${doing} in progress, ${todos.length - done - doing} pending).${note}`, { kind: 'todos', todos });
      },
    };
  },
};

export const TaskTool: Tool = {
  name: 'Task',
  category: 'meta',
  parallelSafe: true,
  planSafe: true,
  description:
    'Launch a sub-agent with its own fresh context to research or explore autonomously (find where something is implemented, investigate a bug across many files, summarize a module, look up docs). ' +
    'It can read files, search, and run safe commands, then returns a single report. This keeps your own context small. ' +
    'Give it a complete, self-contained prompt and say exactly what to report back. Several Task calls can run in parallel.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short (3-5 words) title of the task' },
      prompt: { type: 'string', description: 'Detailed instructions for the sub-agent, including what to return' },
      subagent_type: { type: 'string', enum: ['general-purpose', 'explore'], description: 'general-purpose (default) or explore (read-only search)' },
    },
    required: ['description', 'prompt'],
  },
  label: (input) => `Task(${truncate(strParam(input, 'description', 'title') ?? 'sub-agent', 60)})`,
  async prepare(input, ctx) {
    const prompt = strParam(input, 'prompt', 'instructions', 'task');
    if (!prompt) return errorResult('Missing required parameter: prompt');
    const description = strParam(input, 'description', 'title') ?? truncate(prompt, 40);
    if (ctx.depth >= 1) return errorResult('Sub-agents cannot start other sub-agents. Do the work directly.');
    if (!ctx.services.runSubagent) return errorResult('Sub-agents are not available in this mode.');
    return {
      execute: async () => {
        const report = await ctx.services.runSubagent!({
          description,
          prompt,
          agentType: strParam(input, 'subagent_type', 'type'),
          signal: ctx.signal,
          parentToolCallId: ctx.toolCallId,
        });
        return ok(report || '(the sub-agent returned no report)', { kind: 'summary', text: `Done: ${truncate(report.replace(/\s+/g, ' '), 100)}` });
      },
    };
  },
};

export const ExitPlanModeTool: Tool = {
  name: 'ExitPlanMode',
  category: 'meta',
  planSafe: true,
  description:
    'Only in plan mode: present your implementation plan to the user for approval once you have finished researching. ' +
    'The plan should be concise markdown with concrete steps and the files you will change. Do not use it for research-only questions.',
  parameters: {
    type: 'object',
    properties: { plan: { type: 'string', description: 'The plan in markdown' } },
    required: ['plan'],
  },
  label: () => 'Plan ready',
  async prepare(input, ctx) {
    const plan = strParam(input, 'plan', 'content', 'text');
    if (!plan) return errorResult('Missing required parameter: plan');
    return {
      execute: async () => {
        if (ctx.session.permissionMode !== 'plan') return ok('Not in plan mode; continue with the task.');
        if (!ctx.services.approvePlan) {
          return ok(`Plan recorded (non-interactive session):\n${plan}`, { kind: 'markdown', text: plan });
        }
        const decision = await ctx.services.approvePlan(plan);
        if (!decision) {
          return { content: 'The user did not approve the plan yet. Ask what they want changed, or refine the plan and present it again with ExitPlanMode. Stay in plan mode (no edits).', isError: true, display: { kind: 'markdown', text: plan } };
        }
        ctx.session.permissionMode = decision;
        ctx.session.planApproved = true;
        return ok('The user approved the plan. Plan mode is off; start implementing it now (keep the todo list updated).', { kind: 'markdown', text: plan });
      },
    };
  },
};

/** Accepts both the structured shape and the older {question, options: string[]} one. */
export function normalizeQuestions(input: Record<string, unknown>): UserQuestion[] {
  const toOption = (o: unknown): QuestionOption | null => {
    if (typeof o === 'string') return o.trim() ? { label: o.trim() } : null;
    if (o && typeof o === 'object') {
      const r = o as Record<string, unknown>;
      const label = String(r.label ?? r.title ?? r.value ?? r.name ?? '').trim();
      const description = typeof r.description === 'string' && r.description.trim() ? r.description.trim() : undefined;
      return label ? { label, description } : null;
    }
    return null;
  };
  const toQuestion = (q: unknown): UserQuestion | null => {
    if (typeof q === 'string') return q.trim() ? { question: q.trim(), options: [] } : null;
    if (!q || typeof q !== 'object') return null;
    const r = q as Record<string, unknown>;
    const question = String(r.question ?? r.q ?? r.text ?? r.prompt ?? '').trim();
    if (!question) return null;
    const seen = new Set<string>();
    const options = (Array.isArray(r.options) ? r.options : Array.isArray(r.choices) ? r.choices : [])
      .map(toOption)
      .filter((o): o is QuestionOption => !!o && !seen.has(o.label.toLowerCase()) && !!seen.add(o.label.toLowerCase()))
      .slice(0, 6);
    const header = typeof r.header === 'string' && r.header.trim() ? r.header.trim().slice(0, 24) : undefined;
    return { question, header, options, multiSelect: r.multiSelect === true || r.multi_select === true || r.multiple === true };
  };
  let list: unknown[] = [];
  if (Array.isArray(input.questions)) list = input.questions;
  else if (input.question || input.q || input.prompt) list = [{ question: input.question ?? input.q ?? input.prompt, options: input.options ?? input.choices, header: input.header, multiSelect: input.multiSelect }];
  return list.map(toQuestion).filter((q): q is UserQuestion => !!q).slice(0, 4);
}

export function formatAnswers(answers: QuestionAnswer[]): string {
  const lines = answers.map((a, i) => {
    const parts = [...a.selected];
    if (a.other) parts.push(a.selected.length ? `also: "${a.other}"` : `"${a.other}"`);
    return `${i + 1}. ${a.header ?? a.question} -> ${parts.length ? parts.join(', ') : '(no answer)'}`;
  });
  return `The user answered:\n${lines.join('\n')}\nFollow these answers.`;
}

export const AskUserTool: Tool = {
  name: 'AskUserQuestion',
  category: 'meta',
  planSafe: true,
  description:
    'Ask the user 1-4 multiple-choice questions when you need a decision only they can make (requirements, preferences, trade-offs) and a wrong guess would waste work. ' +
    'Each question gets 2-4 concrete options with a one-line description; the user can always type their own answer instead. ' +
    'Put the option you recommend first and add " (Recommended)" to its label. Ask everything you need in ONE call. ' +
    'Never ask open-ended questions like "what do you want me to do?", and never ask what you can find out yourself from the code or the web: decide those and move on.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: '1-4 questions',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The complete question, e.g. "Which UI framework should the calculator use?"' },
            header: { type: 'string', description: 'Very short label shown as a chip (max 12 characters), e.g. "Framework"' },
            options: {
              type: 'array',
              description: '2-4 distinct choices',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'The choice in 1-5 words' },
                  description: { type: 'string', description: 'What it means or its trade-off, in one sentence' },
                },
                required: ['label'],
              },
            },
            multiSelect: { type: 'boolean', description: 'true if several options can be chosen together' },
          },
          required: ['question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
  label: (input) => {
    const qs = normalizeQuestions(input);
    return `AskUserQuestion(${truncate(qs[0]?.header ?? qs[0]?.question ?? '?', 60)}${qs.length > 1 ? ` +${qs.length - 1}` : ''})`;
  },
  async prepare(input, ctx) {
    const questions = normalizeQuestions(input);
    if (!questions.length) return errorResult('Missing required parameter: questions (each with a question and 2-4 options)');
    return {
      execute: async () => {
        if (!ctx.services.askUser) return ok('The user is not available to answer (non-interactive run). Pick the most sensible option, say which one you chose, and continue.');
        const answers = await ctx.services.askUser(questions);
        if (answers === null) return ok('The user skipped the question. Pick the most sensible option, say which one you chose, and continue.');
        const short = answers.map((a) => [...a.selected, ...(a.other ? [a.other] : [])].join(', ')).join(' · ');
        return ok(formatAnswers(answers), { kind: 'summary', text: `Answer: ${truncate(short, 90)}` });
      },
    };
  },
};
