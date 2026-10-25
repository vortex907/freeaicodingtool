// Task classification for routing. A small, fast "router AI" reads the request and rates how hard it
// is; a keyword heuristic is the fallback when no router model is available.
import { parseJsonLenient } from '../util/jsonRepair.js';

export type Complexity = 'trivial' | 'simple' | 'moderate' | 'complex';
export type TaskType = 'chat' | 'question' | 'edit' | 'debug' | 'refactor' | 'feature' | 'plan' | 'review' | 'search' | 'shell' | 'docs' | 'test';

export interface TaskProfile {
  complexity: Complexity;
  type: TaskType;
  needsReasoning: boolean;
  longContext: boolean;
  source: 'ai' | 'heuristic' | 'inherited' | 'fixed';
  /** Model that produced an AI classification. */
  classifier?: string;
}

export const COMPLEXITIES: Complexity[] = ['trivial', 'simple', 'moderate', 'complex'];

export const DEFAULT_PROFILE: TaskProfile = { complexity: 'moderate', type: 'edit', needsReasoning: false, longContext: false, source: 'fixed' };

const CONTINUATION_RE = /^(y|yes|yeah|yep|ok|okay|sure|go|go ahead|do it|continue|proceed|keep going|go on|next|fix it|try again|retry|again|please|pls|and\??|then\??|more|carry on|resume|lgtm|sounds good|perfect|great,? (continue|go ahead)|ha+n?|haan|ji|thik hai|accha)[.! ]*$/i;
const GREETING_RE = /^(hi|hello|hey|yo|hola|namaste|thanks|thank you|thx|ty|good (morning|evening|night)|bye|cool|nice|great|awesome|wow|lol|ok|okay)\b[ !.?]*$/i;

/** Fast keyword heuristic. Returns a profile and how confident it is (0..1). */
export function classifyHeuristic(text: string, prev?: TaskProfile): { profile: TaskProfile; confidence: number } {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (prev && t.length < 60 && CONTINUATION_RE.test(lower)) {
    return { profile: { ...prev, source: 'inherited' }, confidence: 0.95 };
  }
  if (GREETING_RE.test(lower)) {
    return { profile: { complexity: 'trivial', type: 'chat', needsReasoning: false, longContext: false, source: 'heuristic' }, confidence: 0.95 };
  }
  let type: TaskType = 'question';
  const has = (re: RegExp) => re.test(lower);
  if (has(/\b(bug|error|exception|traceback|stack ?trace|crash|fails?|failing|broken|doesn'?t work|not working|issue|fix)\b/)) type = 'debug';
  else if (has(/\b(refactor|restructure|clean ?up|reorganize|rename|extract|simplify|migrate|port)\b/)) type = 'refactor';
  else if (has(/\b(build|create|implement|add|make|develop|write|generate|scaffold|set ?up|integrate|support)\b/)) type = 'feature';
  else if (has(/\b(plan|design|architect|architecture|approach|strategy|proposal)\b/)) type = 'plan';
  else if (has(/\b(review|audit|check (my|the) code|code review|critique)\b/)) type = 'review';
  else if (has(/\b(test|tests|unit test|coverage|spec)\b/)) type = 'test';
  else if (has(/\b(where is|find|search|locate|which file|grep|look for)\b/)) type = 'search';
  else if (has(/\b(run|install|execute|start|deploy|npm|pip|git|docker|command)\b/)) type = 'shell';
  else if (has(/\b(readme|docs?|documentation|comment|explain|what does|how does|why does|what is|describe)\b/)) type = 'question';
  else if (has(/\b(change|update|modify|edit|replace|remove|delete|move|tweak)\b/)) type = 'edit';

  let score = 0;
  const words = t.split(/\s+/).length;
  if (words > 25) score++;
  if (words > 80) score++;
  if (words > 250) score++;
  if (has(/\b(entire|whole|full|complete|all (the )?files|across|every|project|app|application|system|from scratch|end[- ]to[- ]end|production|scalable|architecture)\b/)) score += 2;
  if (has(/\b(complex|difficult|hard|tricky|subtle|race condition|deadlock|memory leak|performance|optimi[sz]e|concurren|security|algorithm)\b/)) score += 2;
  if (has(/\b(build|implement|create|develop|refactor|migrate|redesign|rewrite)\b/)) score++;
  if (/```|\n\s*at |Traceback|Error:/.test(t)) score++;
  if ((t.match(/\n/g) || []).length > 10) score++;
  if (has(/\b(simple|quick|small|tiny|minor|just|only|typo|one line|single)\b/)) score -= 2;
  if (type === 'question' && words < 20) score -= 1;
  if (type === 'search') score -= 1;

  let complexity: Complexity;
  if (score <= -1) complexity = 'simple';
  else if (score <= 1) complexity = type === 'question' || type === 'search' ? 'simple' : 'moderate';
  else if (score <= 3) complexity = 'moderate';
  else complexity = 'complex';
  if (type === 'feature' && complexity === 'simple' && words > 8) complexity = 'moderate';

  const needsReasoning = complexity === 'complex' || type === 'debug' || type === 'plan';
  const longContext = has(/\b(whole (codebase|repo|project)|entire (codebase|repo|project)|all files|large file|huge|logs?)\b/);
  // Confidence: extremes are clear, the middle is fuzzy.
  const confidence = score >= 5 || score <= -2 ? 0.85 : 0.5;
  return { profile: { complexity, type, needsReasoning, longContext, source: 'heuristic' }, confidence };
}

export const CLASSIFIER_SYSTEM_PROMPT = `You are the router of an AI coding assistant. Read the user's latest request and rate the task so the best AI model can be chosen.
Reply with ONLY one line of JSON, no prose:
{"complexity":"trivial|simple|moderate|complex","type":"chat|question|edit|debug|refactor|feature|plan|review|search|shell|docs|test","reasoning":true|false,"long_context":true|false}

complexity guide:
- trivial: greetings, thanks, chit-chat, yes/no.
- simple: a quick factual question, a one-line change, explaining a small snippet, running one command.
- moderate: a focused change or bug fix touching one or a few files, writing a function, adding a test.
- complex: building a feature or app, multi-file refactors, architecture/design, hard debugging, performance or concurrency problems.
reasoning: true when careful step-by-step thinking clearly helps (tricky bugs, algorithms, design).
long_context: true when the task needs reading many or very large files.`;

export function buildClassifierInput(text: string, context?: { previousRequest?: string; turns?: number }): string {
  const parts: string[] = [];
  if (context?.previousRequest) parts.push(`Previous request (for context): ${context.previousRequest.slice(0, 400)}`);
  if (context?.turns) parts.push(`Conversation turns so far: ${context.turns}`);
  parts.push(`Latest request:\n${text.slice(0, 2500)}`);
  return parts.join('\n\n');
}

/** Parses the classifier model's reply. Returns null when unusable. */
export function parseClassifierReply(reply: string, classifier?: string): TaskProfile | null {
  const m = /\{[\s\S]*\}/.exec(reply);
  if (!m) return null;
  let v: Record<string, unknown>;
  try {
    v = parseJsonLenient(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const c = String(v.complexity ?? '').toLowerCase() as Complexity;
  if (!COMPLEXITIES.includes(c)) return null;
  const types: TaskType[] = ['chat', 'question', 'edit', 'debug', 'refactor', 'feature', 'plan', 'review', 'search', 'shell', 'docs', 'test'];
  const typeRaw = String(v.type ?? 'edit').toLowerCase();
  const type = (types.includes(typeRaw as TaskType) ? typeRaw : 'edit') as TaskType;
  const bool = (x: unknown) => x === true || x === 'true';
  return { complexity: c, type, needsReasoning: bool(v.reasoning), longContext: bool(v.long_context ?? v.longContext), source: 'ai', classifier };
}
