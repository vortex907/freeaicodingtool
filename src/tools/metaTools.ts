// TodoWrite, Task (sub-agents), ExitPlanMode and AskUser tools.
import type { PreparedCall, Todo, Tool } from './types.js';
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

export const AskUserTool: Tool = {
  name: 'AskUser',
  category: 'meta',
  planSafe: true,
  description:
    'Ask the user a clarifying question when the request is ambiguous and a wrong guess would waste significant work. Optionally give 2-4 answer options. ' +
    'Do not use it for things you can find out yourself by reading the code.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask' },
      options: { type: 'array', items: { type: 'string' }, description: 'Optional list of suggested answers' },
    },
    required: ['question'],
  },
  label: (input) => `AskUser(${truncate(strParam(input, 'question') ?? '?', 70)})`,
  async prepare(input, ctx) {
    const question = strParam(input, 'question', 'q', 'prompt');
    if (!question) return errorResult('Missing required parameter: question');
    const options = Array.isArray(input.options) ? (input.options as unknown[]).map(String).filter(Boolean).slice(0, 6) : undefined;
    return {
      execute: async () => {
        if (!ctx.services.askUser) return ok('The user is not available to answer (non-interactive run). Make a sensible assumption, state it, and continue.');
        const answer = await ctx.services.askUser(question, options);
        if (answer === null) return ok('The user dismissed the question without answering. Make a sensible assumption, state it, and continue.');
        return ok(`User answered: ${answer}`, { kind: 'summary', text: `Answer: ${truncate(answer, 80)}` });
      },
    };
  },
};
