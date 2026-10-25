// Built-in workflow commands (/tdd, /security, /pr, ...): prompt templates that walk any model through
// a proven routine with the normal tools. Shared by the app and the terminal UI.

export interface Workflow {
  name: string;
  description: string;
  args?: string;
  /** The command does nothing useful without an argument. */
  needsArgs?: boolean;
  prompt: (args: string) => string;
}

export const COMMIT_PROMPT = `Create a git commit for the current changes. First run the project's tests (and its lint or typecheck if it has them); if they fail, stop and report instead of committing. Then run git status and git diff, stage the relevant files (not unrelated or generated files, never secrets like .env), and commit with a concise message in the style of the repository's recent commits that explains what and why. Do not push. Show the resulting commit.`;

export const WORKFLOWS: Workflow[] = [
  {
    name: 'tdd',
    description: 'Build a feature test-first (red, green, refactor)',
    args: '<feature>',
    needsArgs: true,
    prompt: (a) => `Implement this test-first: ${a}

1. Find how the project runs tests (framework, command, how to run a single test). If there is no test setup, add the standard one for this stack and tell me.
2. Write one failing test for the smallest piece of the behavior. Run it and make sure it fails for the right reason.
3. Write the simplest code that makes it pass, then run the test again.
4. Repeat steps 2 and 3 for the next piece of behavior, including edge cases and error paths.
5. Refactor with all tests green, then run the whole suite.
Show the test output at each step and finish with a short summary of the behavior that is now covered.`,
  },
  {
    name: 'security',
    description: 'Security review: vulnerable dependencies and risky code',
    prompt: () => `Do a security review of this project. If there are uncommitted changes, start with them.
1. Dependencies: run the ecosystem's audit tool if it is installed (npm audit, pnpm audit, pip-audit, dotnet list package --vulnerable, cargo audit, govulncheck) and summarize the real findings.
2. Code: look for injection (SQL, shell commands, path traversal), XSS, unsafe deserialization, SSRF, broken auth or session handling, secrets in code or config, weak crypto or randomness used for security, missing input validation, overly permissive CORS and debug settings left on.
Report findings by severity (critical, high, medium, low) with file:line, why it matters and a concrete fix. Do not change files unless I ask.`,
  },
  {
    name: 'pr',
    description: 'Write a pull request description for this branch',
    prompt: () => `Write a pull request description for the current branch compared with the main branch (find the main branch with git, then use git log and git diff against it).
Include a short summary of what changed and why, the changes grouped by area, how it was tested (run the tests now and report the real result), and risks or breaking changes. Output Markdown I can paste. Do not push or create the PR unless I ask.`,
  },
  {
    name: 'onboard',
    description: 'Explain this codebase to a new developer',
    prompt: () => `Explain this codebase to a developer who is new to it. Read the code first; do not guess.
Cover what the project does, how to install, run and test it, the architecture (the main parts and how data flows between them), the 10 most important files with file:line references, the conventions it uses, and where to start for the most common kinds of changes. Keep it practical and concise.`,
  },
  {
    name: 'deps',
    description: 'Audit dependencies: versions, updates, vulnerabilities, licenses',
    prompt: () => `Audit this project's dependencies.
List the direct dependencies with their versions, then check for updates (npm outdated, pip list --outdated, dotnet list package --outdated, cargo outdated, go list -m -u all: whatever applies and is installed), known vulnerabilities, and license problems (for example GPL or AGPL packages in a project with a permissive license). Say which upgrades are safe and which need care. Do not change files unless I ask.`,
  },
  {
    name: 'cleanup',
    description: 'Find dead code, unused imports and unused dependencies',
    prompt: () => `Find dead code in this project: unused functions, classes and exports, unused imports, unused dependencies and unreachable branches.
Use CodeSearch with mode "unused" if it is available, plus the language's own tools when installed (for example tsc --noEmit --noUnusedLocals --noUnusedParameters, eslint, vulture, dotnet build warnings). Check that each candidate is not used dynamically (reflection, string lookups, framework conventions, public API). List them with file:line and how sure you are. Ask before deleting anything.`,
  },
  {
    name: 'fuzz',
    description: 'Write edge-case tests for a function or file',
    args: '<function or file>',
    needsArgs: true,
    prompt: (a) => `Write edge-case tests for ${a}.
Use the existing test setup and cover empty and null inputs, boundaries (0, 1, -1, maximum values), very large inputs, unicode and unusual whitespace, malformed data, duplicates and unordered items, and concurrency or reentrancy where it applies. If the project already has a property-based testing library (fast-check, Hypothesis, FsCheck), use it. Run the tests, fix the real bugs they find (tell me about each one) and report the results.`,
  },
  {
    name: 'bench',
    description: 'Measure performance before and after a change',
    args: '<what to measure>',
    needsArgs: true,
    prompt: (a) => `Measure the performance of ${a}.
Build a repeatable benchmark (hyperfine for commands if it is installed, otherwise the language's benchmarking or timing tools with a warmup and several runs), record the baseline numbers, find the hotspots and propose optimizations. If I asked for an optimization, apply it, run the same benchmark again and show before and after.`,
  },
  {
    name: 'audit-ui',
    description: 'Check the UI for accessibility and phone-size problems in the browser',
    args: '[url]',
    prompt: (a) => `Audit the UI ${a ? `at ${a}` : 'of this project (start its dev server or open its HTML file)'} with the Browser tool.
For each main page: open it, read the report and the screenshot, run action=responsive, and press Tab a few times to check that keyboard focus is visible. Then fix what you found (contrast, labels, alt text, focus styles, overflow on phones, tiny click targets, heading order) and check again until the report is clean.`,
  },
  {
    name: 'ci-fix',
    description: 'Find out why CI fails and fix it',
    prompt: () => `Find out why CI is failing and fix it.
If the gh CLI is installed and logged in, use gh run list and gh run view --log-failed to read the failing job's log; otherwise read the workflow files and ask me for the log. Reproduce the failure locally with the same commands, fix the root cause (never skip or disable tests), run the checks again and summarize what was wrong.`,
  },
  {
    name: 'env',
    description: 'Check environment variables against .env files',
    prompt: () => `Audit this project's environment variables.
Find every variable the code reads (process.env, import.meta.env, os.environ, os.getenv, Environment.GetEnvironmentVariable, std::env::var and config files) and compare them with .env.example and .env. Report variables that are used but not documented, documented but unused, and missing from .env. Never print secret values, only names. Offer to update .env.example.`,
  },
  {
    name: 'port',
    description: 'Find what is using a port and free it',
    args: '<port>',
    needsArgs: true,
    prompt: (a) => `Find which process is using port ${a} (on Windows: netstat -ano | findstr :${a}, then tasklist /FI "PID eq <pid>"; on macOS and Linux: lsof -i :${a}). Tell me what it is and ask me before stopping it.`,
  },
];

export function findWorkflow(name: string): Workflow | undefined {
  return WORKFLOWS.find((w) => w.name === name.toLowerCase());
}
