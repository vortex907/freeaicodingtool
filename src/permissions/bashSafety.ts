// Classifies shell commands: which are read-only (safe to auto-run) and which are destructive.

const SAFE_COMMANDS = new Set([
  'ls', 'll', 'la', 'pwd', 'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'which', 'whereis', 'type', 'whoami', 'id', 'date', 'uname', 'hostname', 'uptime', 'file', 'stat', 'du', 'df', 'tree', 'basename', 'dirname',
  'realpath', 'readlink', 'diff', 'cmp', 'comm', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'nl', 'column', 'fold', 'rev', 'seq', 'true', 'false',
  'test', '[', 'env', 'printenv', 'locale', 'ps', 'free', 'lscpu', 'nproc', 'jq', 'yq', 'less', 'xxd', 'od', 'hexdump', 'strings', 'cal', 'sleep',
]);

const SAFE_GIT = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'reflog', 'grep', 'cat-file', 'whatchanged', 'name-rev', 'merge-base', 'count-objects', 'version', 'help']);

const VERSION_FLAGS = /^(--version|-v|-V|version|--help|-h|help)$/;
const VERSION_ONLY = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3', 'pip', 'pip3', 'go', 'cargo', 'rustc', 'java', 'javac', 'ruby', 'gem', 'php', 'dotnet', 'gcc', 'g++', 'clang', 'make', 'cmake', 'docker', 'kubectl', 'git', 'tsc', 'uv', 'poetry']);

/** Splits a command line on && || ; | while respecting quotes. Returns null if it uses features we can't vet. */
export function splitCommand(cmd: string): string[] | null {
  const parts: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < cmd.length) {
        cur += ch + cmd[++i];
        continue;
      }
      if (ch === q) q = null;
      if (q === '"' && (ch === '$' || ch === '`')) {
        if (ch === '`' || cmd[i + 1] === '(') return null; // command substitution
      }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === '`') return null;
    if (ch === '$' && cmd[i + 1] === '(') return null;
    if (ch === '<' && cmd[i + 1] === '(') return null;
    if (ch === '>' ) {
      // allow redirects to /dev/null and fd duplication like 2>&1
      const rest = cmd.slice(i);
      const m = /^>>?\s*(\/dev\/null|&[12])/.exec(rest);
      if (m) {
        cur += m[0];
        i += m[0].length - 1;
        continue;
      }
      return null;
    }
    if (ch === '&' && cmd[i + 1] === '&') {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === '|' && cmd[i + 1] === '|') {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === '&' && cmd[i - 1] !== '>' && cmd[i + 1] !== '>') return null; // background job
    if (ch === ';' || ch === '|' || ch === '\n') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (q) return null;
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function tokens(seg: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

function isSafeSegment(seg: string): boolean {
  let t = tokens(seg);
  // strip leading env assignments
  while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]!)) t = t.slice(1);
  if (!t.length) return true;
  const cmd = t[0]!.replace(/^.*\//, '');
  const args = t.slice(1);
  if (SAFE_COMMANDS.has(cmd)) {
    if (cmd === 'env' || cmd === 'printenv') return args.every((a) => !/^[A-Za-z_]\w*=/.test(a) || false) && args.length <= 1;
    if (cmd === 'sleep') return true;
    if (cmd === 'less') return false;
    return true;
  }
  if (cmd === 'find') return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(a));
  if (cmd === 'sed') return !args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place'));
  if (cmd === 'awk' || cmd === 'gawk') return !/system\s*\(|>\s*"|print\s*>|\|\s*"/.test(seg);
  if (cmd === 'git') {
    const sub = args.find((a) => !a.startsWith('-'));
    if (!sub) return args.every((a) => VERSION_FLAGS.test(a));
    if (sub === 'branch') return !args.some((a) => /^-(d|D|m|M|c|C|-delete|-move|-copy|-set-upstream|-unset-upstream)/.test(a)) && args.filter((a) => !a.startsWith('-')).length <= 1;
    if (sub === 'tag') return args.filter((a) => !a.startsWith('-')).length <= 1 && !args.some((a) => /^-(d|a|s|f)/.test(a));
    if (sub === 'remote') return args.length <= 2 && (args.includes('-v') || args.length === 1);
    if (sub === 'stash') return args.includes('list') || args.includes('show');
    if (sub === 'config') return args.includes('--get') || args.includes('--list') || args.includes('-l');
    return SAFE_GIT.has(sub);
  }
  if (VERSION_ONLY.has(cmd)) return args.length >= 1 && args.every((a) => VERSION_FLAGS.test(a));
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') return ['ls', 'list', 'view', 'info', 'outdated', 'why', 'explain', 'config', 'root', 'prefix', 'audit'].includes(args[0] ?? '') && !args.includes('fix') && (args[0] !== 'config' || args[1] === 'get' || args[1] === 'list');
  if (cmd === 'pip' || cmd === 'pip3') return ['list', 'show', 'freeze', 'check'].includes(args[0] ?? '');
  if (cmd === 'cargo') return ['tree', 'metadata', 'search'].includes(args[0] ?? '');
  if (cmd === 'go') return ['env', 'list', 'version', 'doc'].includes(args[0] ?? '');
  return false;
}

/** True when every part of the command only reads information. */
export function isReadOnlyCommand(cmd: string): boolean {
  const parts = splitCommand(cmd.trim());
  if (!parts || !parts.length) return false;
  return parts.every(isSafeSegment);
}

const CATASTROPHIC: { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|\/\*|~|~\/|\$HOME|\.\.?\/?)(\s|$)/, why: 'recursively deletes a root, home or parent directory' },
  { re: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+--no-preserve-root/, why: 'deletes the whole filesystem' },
  { re: /\bmkfs(\.\w+)?\b/, why: 'formats a disk' },
  { re: /\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|hd|disk|mmcblk)/, why: 'overwrites a raw disk' },
  { re: />\s*\/dev\/(sd|nvme|hd|disk)\w*/, why: 'overwrites a raw disk' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'is a fork bomb' },
  { re: /\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, why: 'makes the whole filesystem world-writable' },
  { re: /\bchown\s+-R\s+\S+\s+\/(\s|$)/, why: 'changes ownership of the whole filesystem' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: 'shuts down or restarts the computer' },
  { re: /\bgit\s+push\s+[^;&|]*(--force|-f)\b[^;&|]*\b(main|master|production|prod)\b/, why: 'force-pushes over a main branch' },
  { re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|)sh\b/, why: 'downloads and runs a remote script' },
  { re: /\bgit\s+(clean\s+-[a-zA-Z]*f[a-zA-Z]*d|reset\s+--hard\s+origin)/, why: 'irreversibly discards local changes' },
];

/** Explanation if the command looks destructive enough to always require confirmation. */
export function dangerousCommandReason(cmd: string): string | null {
  for (const { re, why } of CATASTROPHIC) if (re.test(cmd)) return why;
  return null;
}

/** Commands that cannot be undone with /undo (they change files outside FreeCode's tracking). */
export function mayModifyFiles(cmd: string): boolean {
  return !isReadOnlyCommand(cmd);
}
