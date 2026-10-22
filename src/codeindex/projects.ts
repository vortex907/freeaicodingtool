// Projects inside an index root and what their manifests say: name, description, scripts,
// dependencies with versions, runtime or engine versions, config files and missing .env keys.
import { promises as fsp, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { isIgnoredDir } from './walker.js';

export interface Dep {
  name: string;
  version: string;
  dev?: boolean;
}

export interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  scripts?: Record<string, string>;
  deps: Dep[];
  /** Runtimes, frameworks and engines with versions: "node >=20", "net8.0", "Unity 2022.3.10f1". */
  platform: string[];
  /** Names other projects may import this one by: package, crate, module path, assembly, namespace. */
  aliases: string[];
  /** Folders this project points at from its manifests (ProjectReference, path dependencies). */
  refs: string[];
  /** Config files present, e.g. "tsconfig.json", ".github/workflows (ci.yml)". */
  configs: string[];
  /** Keys in .env.example (or .sample/.template) that .env does not define. Names only, never values. */
  envMissing: string[];
  envExample?: string;
  /** First paragraph of the README. */
  readme?: string;
  /** Size and mtime of the files read, to skip re-reading unchanged manifests. */
  stamp: string;
}

export interface ProjectRec {
  /** Folder relative to the root ('' for the root itself), forward slashes. */
  rel: string;
  dir: string;
  /** Manifest files that make it a project ("git" for a repository). */
  markers: string[];
  git: boolean;
  manifest?: Manifest;
}

const MARKER_FILES = new Set(['package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'cmakelists.txt', 'makefile', 'project.godot', 'pubspec.yaml', 'composer.json', 'gemfile', 'package.swift']);
const MARKER_EXT = ['.csproj', '.sln', '.uproject', '.fsproj', '.vcxproj'];

async function readdirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function markersOf(dir: string, entries: Dirent[]): Promise<string[]> {
  const out: string[] = [];
  for (const e of entries) {
    const lower = e.name.toLowerCase();
    if (e.name === '.git') out.push('git');
    else if (e.isFile() && (MARKER_FILES.has(lower) || MARKER_EXT.some((x) => lower.endsWith(x)))) out.push(e.name);
    else if (e.isDirectory() && e.name === 'ProjectSettings' && (await exists(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt')))) out.push('Unity');
  }
  return out;
}

/**
 * Projects of a root: the root itself when it has a manifest or .git, each immediate subfolder that
 * has one, and folders the caller says are projects (the one the user opened).
 */
export async function detectProjects(root: string, explicit: string[]): Promise<ProjectRec[]> {
  const out: ProjectRec[] = [];
  const top = await readdirSafe(root);
  const rootMarkers = await markersOf(root, top);
  if (rootMarkers.length || explicit.includes('')) out.push({ rel: '', dir: root, markers: rootMarkers, git: rootMarkers.includes('git') });
  const subdirs = top.filter((e) => e.isDirectory() && !isIgnoredDir(e.name));
  const found = await Promise.all(
    subdirs.map(async (e) => {
      const dir = path.join(root, e.name);
      const markers = await markersOf(dir, await readdirSafe(dir));
      return markers.length || explicit.includes(e.name) ? { rel: e.name, dir, markers, git: markers.includes('git') } : null;
    }),
  );
  for (const p of found) if (p) out.push(p);
  for (const rel of explicit) {
    if (out.some((p) => p.rel === rel)) continue;
    const dir = path.join(root, rel);
    const markers = await markersOf(dir, await readdirSafe(dir));
    out.push({ rel, dir, markers, git: markers.includes('git') });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// ------------------------------------------------------------------ small parsers

async function readText(file: string, max = 512 * 1024): Promise<string | null> {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > max) return null;
    const s = await fsp.readFile(file, 'utf8');
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  } catch {
    return null;
  }
}

function stripTomlComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function bracketDepth(s: string): number {
  let d = 0;
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') d++;
    else if (c === ']' || c === '}') d--;
  }
  return d;
}

/** Minimal TOML reader: section -> key -> raw value text (multi-line arrays joined). */
export function parseToml(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let cur = new Map<string, string>();
  out.set('', cur);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripTomlComment(lines[i]!).trim();
    if (!line) continue;
    const sec = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (sec) {
      const name = sec[1]!.replace(/"/g, '').replace(/\s*\.\s*/g, '.');
      cur = out.get(name) ?? new Map<string, string>();
      out.set(name, cur);
      continue;
    }
    const kv = /^("[^"]+"|'[^']+'|[\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2]!;
    if (value.startsWith('"""') && !value.slice(3).includes('"""')) {
      while (i + 1 < lines.length && !value.slice(3).includes('"""')) value += ' ' + lines[++i]!.trim();
    } else {
      while (bracketDepth(value) > 0 && i + 1 < lines.length) value += ' ' + stripTomlComment(lines[++i]!).trim();
    }
    cur.set(kv[1]!.replace(/^["']|["']$/g, ''), value.trim());
  }
  return out;
}

function tomlStr(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /^"""([\s\S]*?)"""|^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(raw);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').replace(/\s+/g, ' ').trim() : undefined;
}

function tomlStrings(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
}

function tomlTable(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(/([\w-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|\[[^\]]*\]|[^,}]+)/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

/** Version of a TOML dependency value: "1.0", { version = "1.0" } or { path = "../x" }. */
function tomlDepVersion(raw: string): { version: string; path?: string } {
  const s = tomlStr(raw);
  if (s !== undefined) return { version: s };
  if (raw.startsWith('{')) {
    const t = tomlTable(raw);
    const p = tomlStr(t.get('path'));
    const v = tomlStr(t.get('version'));
    return { version: v ?? (p ? `path ${p}` : t.has('git') ? 'git' : '*'), path: p };
  }
  return { version: raw };
}

/** PEP 508 requirement: "requests[socks]>=2.31; python_version>'3'" -> requests, >=2.31 */
function pep508(spec: string): Dep | null {
  const s = spec.split(';')[0]!.trim();
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!m) return null;
  return { name: m[1]!, version: m[2]!.replace(/^\(|\)$/g, '').replace(/\s+/g, '') || '*' };
}

function xmlTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(xml);
  return m?.[1] || undefined;
}

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)?.[1];
}

/** First paragraph of a README in plain text (no headings, badges, HTML or markup). */
export function readmeSummary(text: string): string | undefined {
  const lines = text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i]!.trim() !== '---') i++;
    i++;
  }
  const para: string[] = [];
  let fence = false;
  for (; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.startsWith('```') || t.startsWith('~~~')) {
      if (para.length) break;
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (!t) {
      if (para.length) break;
      continue;
    }
    // A title underlined with === or --- (setext, reStructuredText)
    if (/^(=+|-+|~+|\^+)$/.test(lines[i + 1]?.trim() ?? '') && !para.length) {
      i++;
      continue;
    }
    if (/^(#|=+$|-+$|\*{3,}$|_{3,}$|\[!\[|!\[|<|\||\.\.\s|:\w+:)/.test(t) || /^\[[^\]]*\]:/.test(t)) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  const s = para
    .join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)([^*_`]+)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return undefined;
  return s.length > 300 ? `${s.slice(0, 297).replace(/\s+\S*$/, '')}...` : s;
}

/** Variable names defined in a dotenv-style file (values are never kept). */
export function envKeys(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

const CONFIG_RE: RegExp[] = [
  /^tsconfig(\..+)?\.json$/i,
  /^jsconfig\.json$/i,
  /^(vite|vitest|webpack|next|nuxt|rollup|svelte|astro|remix|tailwind|postcss|babel|jest|playwright|cypress|eslint|prettier)\.config\.[cm]?[jt]s$/i,
  /^dockerfile(\..+)?$/i,
  /^(docker-)?compose(\..+)?\.ya?ml$/i,
  /^\.env\.(example|sample|template)$/i,
  /^\.eslintrc(\..+)?$/i,
  /^\.prettierrc(\..+)?$/i,
  /^\.editorconfig$/i,
  /^\.babelrc$/i,
  /^\.gitlab-ci\.yml$/i,
  /^(pytest\.ini|tox\.ini|setup\.cfg|ruff\.toml|mypy\.ini|\.flake8|noxfile\.py)$/i,
  /^(directory\.build\.props|directory\.packages\.props|global\.json|nuget\.config)$/i,
];

export function isConfigFile(name: string): boolean {
  return CONFIG_RE.some((r) => r.test(name));
}

// ------------------------------------------------------------------ manifests

export interface ManifestInput {
  dir: string;
  /** Files of the project (forward-slash paths relative to dir), from the index. */
  files: string[];
  markers: string[];
  stamp: string;
}

type Ctx = { m: Manifest; dir: string; files: string[] };

function addDep(m: Manifest, name: string, version: string, dev?: boolean): void {
  if (!name || m.deps.some((d) => d.name === name)) return;
  m.deps.push(dev ? { name, version: version || '*', dev: true } : { name, version: version || '*' });
}

function addRef(c: Ctx, base: string, rel: string): void {
  const p = path.resolve(base, rel.replace(/\\/g, '/'));
  if (!c.m.refs.includes(p)) c.m.refs.push(p);
}

async function readPackageJson(c: Ctx): Promise<void> {
  const raw = await readText(path.join(c.dir, 'package.json'));
  if (!raw) return;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const m = c.m;
  if (typeof pkg.name === 'string') {
    m.name = m.name ?? pkg.name;
    m.aliases.push(pkg.name);
  }
  if (typeof pkg.version === 'string') m.version = m.version ?? pkg.version;
  if (typeof pkg.description === 'string') m.description = m.description ?? pkg.description;
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    const scripts: Record<string, string> = {};
    for (const [k, v] of Object.entries(pkg.scripts as Record<string, unknown>)) if (typeof v === 'string') scripts[k] = v;
    m.scripts = { ...scripts, ...(m.scripts ?? {}) };
  }
  for (const [field, dev] of [['dependencies', false], ['optionalDependencies', false], ['peerDependencies', false], ['devDependencies', true]] as const) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, v] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      addDep(m, name, v, dev);
      const local = /^(?:file|link|portal):(.+)$/.exec(v);
      if (local) addRef(c, c.dir, local[1]!);
    }
  }
  const engines = pkg.engines as Record<string, unknown> | undefined;
  if (engines && typeof engines.node === 'string') m.platform.push(`node ${engines.node}`);
  if (typeof pkg.packageManager === 'string') m.platform.push(pkg.packageManager.split('+')[0]!);
  // Workspace packages can be imported by their own names.
  const nested = c.files.filter((f) => f.endsWith('/package.json') && f.split('/').length <= 4).slice(0, 50);
  for (const f of nested) {
    const t = await readText(path.join(c.dir, f), 64 * 1024);
    const name = t ? /"name"\s*:\s*"([^"]+)"/.exec(t)?.[1] : undefined;
    if (name && !m.aliases.includes(name)) m.aliases.push(name);
  }
}

async function readRequirements(c: Ctx): Promise<void> {
  const raw = await readText(path.join(c.dir, 'requirements.txt'));
  if (!raw) return;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.replace(/\s+#.*$/, '').trim();
    if (!t || t.startsWith('#') || t.startsWith('-') || /^[a-z+]+:\/\//i.test(t)) continue;
    const d = pep508(t);
    if (d) addDep(c.m, d.name, d.version);
  }
}

async function readPyproject(c: Ctx): Promise<void> {
  const raw = await readText(path.join(c.dir, 'pyproject.toml'));
  if (!raw) return;
  const toml = parseToml(raw);
  const m = c.m;
  const project = toml.get('project');
  const poetry = toml.get('tool.poetry');
  const name = tomlStr(project?.get('name')) ?? tomlStr(poetry?.get('name'));
  if (name) {
    m.name = m.name ?? name;
    m.aliases.push(name, name.toLowerCase().replace(/[-.]/g, '_'));
  }
  m.version = m.version ?? tomlStr(project?.get('version')) ?? tomlStr(poetry?.get('version'));
  m.description = m.description ?? tomlStr(project?.get('description')) ?? tomlStr(poetry?.get('description'));
  const py = tomlStr(project?.get('requires-python'));
  if (py) m.platform.push(`python ${py}`);
  for (const s of tomlStrings(project?.get('dependencies'))) {
    const d = pep508(s);
    if (d) addDep(m, d.name, d.version);
  }
  for (const s of tomlStrings(toml.get('dependency-groups')?.get('dev'))) {
    const d = pep508(s);
    if (d) addDep(m, d.name, d.version, true);
  }
  for (const [sec, dev] of [['tool.poetry.dependencies', false], ['tool.poetry.dev-dependencies', true], ['tool.poetry.group.dev.dependencies', true]] as const) {
    for (const [k, v] of toml.get(sec) ?? []) {
      const dv = tomlDepVersion(v);
      if (k === 'python') m.platform.push(`python ${dv.version}`);
      else addDep(m, k, dv.version, dev);
      if (dv.path) addRef(c, c.dir, dv.path);
    }
  }
  const scripts = toml.get('project.scripts') ?? toml.get('tool.poetry.scripts');
  if (scripts?.size) {
    m.scripts = m.scripts ?? {};
    for (const [k, v] of scripts) m.scripts[k] = tomlStr(v) ?? v;
  }
}

async function readSetupPy(c: Ctx): Promise<void> {
  const raw = await readText(path.join(c.dir, 'setup.py'));
  if (!raw) return;
  const name = /\bname\s*=\s*['"]([^'"]+)['"]/.exec(raw)?.[1];
  if (name) {
    c.m.name = c.m.name ?? name;
    c.m.aliases.push(name, name.toLowerCase().replace(/[-.]/g, '_'));
  }
  c.m.description = c.m.description ?? /\bdescription\s*=\s*['"]([^'"]+)['"]/.exec(raw)?.[1];
  const req = /install_requires\s*=\s*\[([^\]]*)\]/.exec(raw)?.[1];
  for (const s of req ? tomlStrings(req) : []) {
    const d = pep508(s);
    if (d) addDep(c.m, d.name, d.version);
  }
  const py = /python_requires\s*=\s*['"]([^'"]+)['"]/.exec(raw)?.[1];
  if (py) c.m.platform.push(`python ${py}`);
}

async function readCsproj(c: Ctx): Promise<void> {
  const m = c.m;
  const central = new Map<string, string>();
  const props = await readText(path.join(c.dir, 'Directory.Packages.props'));
  if (props) for (const t of props.matchAll(/<PackageVersion\b([^>]*)>/g)) {
    const inc = attr(t[1]!, 'Include');
    const v = attr(t[1]!, 'Version');
    if (inc && v) central.set(inc, v);
  }
  const projects = c.files.filter((f) => /\.(cs|fs|vb)proj$/i.test(f)).slice(0, 30);
  for (const f of projects) {
    const raw = await readText(path.join(c.dir, f));
    if (!raw) continue;
    const base = path.dirname(path.join(c.dir, f));
    const asm = xmlTag(raw, 'AssemblyName') ?? path.basename(f).replace(/\.\w+proj$/i, '');
    if (!m.name && projects.length === 1) m.name = asm;
    m.aliases.push(asm);
    const rootNs = xmlTag(raw, 'RootNamespace');
    if (rootNs) m.aliases.push(rootNs);
    m.description = m.description ?? xmlTag(raw, 'Description');
    for (const tag of ['TargetFramework', 'TargetFrameworks']) {
      const v = xmlTag(raw, tag);
      if (v) for (const fw of v.split(';')) if (fw.trim() && !m.platform.includes(fw.trim())) m.platform.push(fw.trim());
    }
    const sdk = /<Project\s+Sdk="([^"]+)"/.exec(raw)?.[1];
    if (sdk && sdk !== 'Microsoft.NET.Sdk' && !m.platform.includes(sdk)) m.platform.push(sdk);
    for (const t of raw.matchAll(/<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/g)) {
      const inc = attr(t[1]!, 'Include') ?? attr(t[1]!, 'Update');
      if (!inc) continue;
      const v = attr(t[1]!, 'Version') ?? (t[2] ? xmlTag(t[2], 'Version') : undefined) ?? central.get(inc) ?? '*';
      addDep(m, inc, v);
    }
    for (const t of raw.matchAll(/<ProjectReference\b[^>]*\bInclude="([^"]+)"/g)) addRef(c, base, path.dirname(t[1]!.replace(/\\/g, '/')));
  }
}

async function readCargo(c: Ctx): Promise<void> {
  const tomlFiles = ['Cargo.toml', ...c.files.filter((f) => f.endsWith('/Cargo.toml') && f.split('/').length <= 3).slice(0, 30)];
  for (const f of tomlFiles) {
    const raw = await readText(path.join(c.dir, f));
    if (!raw) continue;
    const toml = parseToml(raw);
    const pkg = toml.get('package');
    const name = tomlStr(pkg?.get('name'));
    const isRoot = f === 'Cargo.toml';
    if (name) c.m.aliases.push(name.replace(/-/g, '_'));
    const lib = tomlStr(toml.get('lib')?.get('name'));
    if (lib) c.m.aliases.push(lib.replace(/-/g, '_'));
    if (!isRoot) continue;
    const m = c.m;
    if (name) m.name = m.name ?? name;
    m.version = m.version ?? tomlStr(pkg?.get('version'));
    m.description = m.description ?? tomlStr(pkg?.get('description'));
    const edition = tomlStr(pkg?.get('edition'));
    if (edition) m.platform.push(`Rust edition ${edition}`);
    const rv = tomlStr(pkg?.get('rust-version'));
    if (rv) m.platform.push(`rustc ${rv}`);
    for (const [sec, dev] of [['dependencies', false], ['workspace.dependencies', false], ['build-dependencies', true], ['dev-dependencies', true]] as const) {
      for (const [k, v] of toml.get(sec) ?? []) {
        if (k.includes('.')) {
          // foo.version = "1.0" / foo.workspace = true
          const [dep, key] = k.split('.');
          if (key === 'version') addDep(m, dep!, tomlStr(v) ?? v, dev);
          continue;
        }
        const dv = tomlDepVersion(v);
        addDep(m, k, dv.version, dev);
        if (dv.path) addRef(c, c.dir, dv.path);
      }
    }
    for (const [secName, sec] of toml) {
      const dm = /^(dev-|build-)?dependencies\.(.+)$/.exec(secName);
      if (!dm) continue;
      const p = tomlStr(sec.get('path'));
      addDep(m, dm[2]!, tomlStr(sec.get('version')) ?? (p ? `path ${p}` : '*'), !!dm[1]);
      if (p) addRef(c, c.dir, p);
    }
  }
}

async function readGoMod(c: Ctx): Promise<void> {
  const raw = await readText(path.join(c.dir, 'go.mod'));
  if (!raw) return;
  const m = c.m;
  const mod = /^module\s+(\S+)/m.exec(raw)?.[1];
  if (mod) {
    m.name = m.name ?? mod.split('/').pop();
    m.aliases.push(mod);
  }
  const go = /^go\s+(\S+)/m.exec(raw)?.[1];
  if (go) m.platform.push(`go ${go}`);
  let block = false;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (/^require\s*\($/.test(t)) {
      block = true;
      continue;
    }
    if (block && t === ')') {
      block = false;
      continue;
    }
    const r = block ? /^(\S+)\s+(\S+)(.*)$/.exec(t) : /^require\s+(\S+)\s+(\S+)(.*)$/.exec(t);
    if (r && !r[3]!.includes('// indirect')) addDep(m, r[1]!, r[2]!);
    const rep = /^(?:replace\s+)?\S+(?:\s+\S+)?\s+=>\s+(\.{1,2}\/\S*)/.exec(t);
    if (rep) addRef(c, c.dir, rep[1]!);
  }
}

async function readPom(c: Ctx): Promise<void> {
  const raw = await readText(path.join(c.dir, 'pom.xml'));
  if (!raw) return;
  const m = c.m;
  const body = raw.replace(/<parent>[\s\S]*?<\/parent>/, '').replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '').replace(/<build>[\s\S]*?<\/build>/g, '');
  const head = body.split('<dependencies>')[0]!;
  const artifact = xmlTag(head, 'artifactId');
  const group = xmlTag(head, 'groupId') ?? xmlTag(raw, 'groupId');
  m.name = m.name ?? xmlTag(head, 'name') ?? artifact;
  m.version = m.version ?? xmlTag(head, 'version');
  m.description = m.description ?? xmlTag(head, 'description');
  if (group) m.aliases.push(group);
  const java = xmlTag(raw, 'maven.compiler.release') ?? xmlTag(raw, 'maven.compiler.source') ?? xmlTag(raw, 'java.version');
  if (java) m.platform.push(`Java ${java}`);
  for (const d of body.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const g = xmlTag(d[1]!, 'groupId');
    const a = xmlTag(d[1]!, 'artifactId');
    if (a) addDep(m, g ? `${g}:${a}` : a, xmlTag(d[1]!, 'version') ?? '*', xmlTag(d[1]!, 'scope') === 'test');
  }
}

async function readGradle(c: Ctx): Promise<void> {
  const raw = (await readText(path.join(c.dir, 'build.gradle.kts'))) ?? (await readText(path.join(c.dir, 'build.gradle')));
  if (!raw) return;
  const m = c.m;
  for (const d of raw.matchAll(/\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|androidTestImplementation|kapt|ksp|annotationProcessor|classpath)\s*\(?\s*['"]([^'":\s]+):([^'":\s]+):([^'"\s]+)['"]/g)) {
    addDep(m, `${d[2]}:${d[3]}`, d[4]!, /^(test|androidTest)/.test(d[1]!));
  }
  for (const p of raw.matchAll(/\bid\s*\(?\s*['"]([\w.-]+)['"]\s*\)?\s*version\s*['"]([^'"]+)['"]/g)) addDep(m, p[1]!, p[2]!);
  const jv = /(?:jvmToolchain\s*\(\s*(\d+)|JavaVersion\.VERSION_(\d+)|sourceCompatibility\s*=\s*['"]?(\d+))/.exec(raw);
  if (jv) m.platform.push(`Java ${jv[1] ?? jv[2] ?? jv[3]}`);
  const group = /^\s*group\s*=\s*['"]([^'"]+)['"]/m.exec(raw)?.[1];
  if (group) m.aliases.push(group);
}

async function readCMake(c: Ctx): Promise<void> {
  const raw = await readText(path.join(c.dir, 'CMakeLists.txt'));
  if (!raw) return;
  const m = c.m;
  const name = /\bproject\s*\(\s*([A-Za-z_][\w.-]*)/i.exec(raw)?.[1];
  if (name) {
    m.name = m.name ?? name;
    m.aliases.push(name);
  }
  const ver = /cmake_minimum_required\s*\(\s*VERSION\s+([\d.]+)/i.exec(raw)?.[1];
  if (ver) m.platform.push(`CMake ${ver}+`);
  const std = /CMAKE_CXX_STANDARD\s+(\d+)/.exec(raw)?.[1];
  if (std) m.platform.push(`C++${std}`);
  for (const f of raw.matchAll(/\bfind_package\s*\(\s*([A-Za-z_][\w-]*)(?:\s+([\d.]+))?/gi)) addDep(m, f[1]!, f[2] ?? '*');
  for (const f of raw.matchAll(/\bFetchContent_Declare\s*\(\s*([A-Za-z_][\w-]*)[\s\S]*?(?:GIT_TAG\s+(\S+))?\s*\)/gi)) addDep(m, f[1]!, f[2] ?? '*');
}

async function readMakefile(c: Ctx): Promise<void> {
  const raw = await readText(path.join(c.dir, 'Makefile'));
  if (!raw) return;
  const scripts: Record<string, string> = {};
  for (const t of raw.matchAll(/^([A-Za-z][\w.-]*)\s*:(?!=)/gm)) {
    if (Object.keys(scripts).length >= 12) break;
    scripts[t[1]!] = `make ${t[1]}`;
  }
  if (Object.keys(scripts).length) c.m.scripts = { ...scripts, ...(c.m.scripts ?? {}) };
}

async function readGodot(c: Ctx): Promise<void> {
  const raw = await readText(path.join(c.dir, 'project.godot'));
  if (!raw) return;
  const m = c.m;
  const name = /^config\/name\s*=\s*"([^"]*)"/m.exec(raw)?.[1];
  if (name) m.name = m.name ?? name;
  const desc = /^config\/description\s*=\s*"([^"]*)"/m.exec(raw)?.[1];
  if (desc) m.description = m.description ?? desc;
  const features = /^config\/features\s*=\s*PackedStringArray\(([^)]*)\)/m.exec(raw)?.[1];
  const ver = features ? tomlStrings(features).find((f) => /^\d+\.\d+/.test(f)) : undefined;
  m.platform.push(ver ? `Godot ${ver}` : /^config_version\s*=\s*5/m.test(raw) ? 'Godot 4' : 'Godot 3');
}

async function readUproject(c: Ctx, file: string): Promise<void> {
  const raw = await readText(path.join(c.dir, file));
  if (!raw) return;
  let u: Record<string, unknown>;
  try {
    u = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const m = c.m;
  m.name = m.name ?? path.basename(file, '.uproject');
  const engine = typeof u.EngineAssociation === 'string' ? u.EngineAssociation : '';
  m.platform.push(/^\d/.test(engine) ? `Unreal Engine ${engine}` : 'Unreal Engine (source build)');
  if (typeof u.Description === 'string' && u.Description) m.description = m.description ?? u.Description;
  for (const mod of Array.isArray(u.Modules) ? u.Modules : []) if (mod && typeof (mod as { Name?: unknown }).Name === 'string') m.aliases.push((mod as { Name: string }).Name);
  for (const p of Array.isArray(u.Plugins) ? u.Plugins : []) {
    const pl = p as { Name?: unknown; Enabled?: unknown };
    if (typeof pl.Name === 'string' && pl.Enabled !== false) addDep(m, pl.Name, 'plugin');
  }
}

async function readUnity(c: Ctx): Promise<void> {
  const m = c.m;
  const ver = await readText(path.join(c.dir, 'ProjectSettings', 'ProjectVersion.txt'));
  const v = ver ? /m_EditorVersion:\s*(\S+)/.exec(ver)?.[1] : undefined;
  m.platform.push(v ? `Unity ${v}` : 'Unity');
  const settings = await readText(path.join(c.dir, 'ProjectSettings', 'ProjectSettings.asset'), 2 * 1024 * 1024);
  const product = settings ? /^\s*productName:\s*(.+)$/m.exec(settings)?.[1]?.trim() : undefined;
  if (product) m.name = m.name ?? product;
  const manifest = await readText(path.join(c.dir, 'Packages', 'manifest.json'));
  if (!manifest) return;
  try {
    const deps = (JSON.parse(manifest) as { dependencies?: Record<string, unknown> }).dependencies ?? {};
    for (const [name, version] of Object.entries(deps)) {
      // Built-in engine modules are always there and say nothing about the project.
      if (typeof version === 'string' && !name.startsWith('com.unity.modules.')) addDep(m, name, version);
    }
  } catch {
    // ignore a broken manifest
  }
}

async function readPubspec(c: Ctx): Promise<void> {
  const raw = await readText(path.join(c.dir, 'pubspec.yaml'));
  if (!raw) return;
  const m = c.m;
  const top = (k: string) => new RegExp(`^${k}:\\s*["']?([^"'\\n#]+?)["']?\\s*$`, 'm').exec(raw)?.[1];
  const name = top('name');
  if (name) {
    m.name = m.name ?? name;
    m.aliases.push(name);
  }
  m.description = m.description ?? top('description');
  m.version = m.version ?? top('version');
  const sdk = /^environment:\s*\n(?:\s+.*\n)*?\s+sdk:\s*["']?([^"'\n]+)["']?/m.exec(raw)?.[1];
  if (sdk) m.platform.push(`Dart ${sdk.trim()}`);
  let section: string | null = null;
  let pending: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      section = /^(dependencies|dev_dependencies):/.exec(line)?.[1] ?? null;
      pending = null;
      continue;
    }
    if (!section) continue;
    const d = /^ {2}([A-Za-z_]\w*):\s*(.*)$/.exec(line);
    if (d) {
      const v = d[2]!.replace(/["']/g, '').trim();
      if (d[1] === 'flutter' && section === 'dependencies') m.platform.push('Flutter');
      addDep(m, d[1]!, v || '*', section === 'dev_dependencies');
      pending = v ? null : d[1]!;
      continue;
    }
    const p = pending ? /^\s{4}path:\s*["']?([^"'\n]+)["']?/.exec(line) : null;
    if (p) addRef(c, c.dir, p[1]!.trim());
  }
}

async function readComposer(c: Ctx): Promise<void> {
  const raw = await readText(path.join(c.dir, 'composer.json'));
  if (!raw) return;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const m = c.m;
  if (typeof j.name === 'string') m.name = m.name ?? j.name;
  if (typeof j.description === 'string') m.description = m.description ?? j.description;
  for (const [field, dev] of [['require', false], ['require-dev', true]] as const) {
    for (const [name, v] of Object.entries((j[field] as Record<string, unknown>) ?? {})) {
      if (typeof v !== 'string') continue;
      if (name === 'php') m.platform.push(`php ${v}`);
      else addDep(m, name, v, dev);
    }
  }
  const psr4 = ((j.autoload as Record<string, unknown> | undefined)?.['psr-4'] as Record<string, unknown> | undefined) ?? {};
  for (const ns of Object.keys(psr4)) m.aliases.push(ns.replace(/\\+$/, ''));
  if (j.scripts && typeof j.scripts === 'object') {
    m.scripts = m.scripts ?? {};
    for (const [k, v] of Object.entries(j.scripts as Record<string, unknown>)) if (typeof v === 'string') m.scripts[k] = v;
  }
}

async function readGemfile(c: Ctx): Promise<void> {
  const raw = await readText(path.join(c.dir, 'Gemfile'));
  if (!raw) return;
  let dev = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*group\b.*\b(development|test)\b.*\bdo\b/.test(line)) dev = true;
    else if (/^\s*end\b/.test(line)) dev = false;
    const g = /^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/.exec(line);
    if (g) addDep(c.m, g[1]!, g[2] ?? '*', dev);
    const r = /^\s*ruby\s+['"]([^'"]+)['"]/.exec(line);
    if (r) c.m.platform.push(`ruby ${r[1]}`);
  }
}

async function readSwiftPackage(c: Ctx): Promise<void> {
  const raw = await readText(path.join(c.dir, 'Package.swift'));
  if (!raw) return;
  const m = c.m;
  const tools = /swift-tools-version:\s*([\d.]+)/.exec(raw)?.[1];
  if (tools) m.platform.push(`Swift tools ${tools}`);
  const name = /Package\s*\(\s*name:\s*"([^"]+)"/.exec(raw)?.[1];
  if (name) {
    m.name = m.name ?? name;
    m.aliases.push(name);
  }
  for (const p of raw.matchAll(/\.package\s*\(\s*(?:name:\s*"[^"]*"\s*,\s*)?url:\s*"([^"]+)"\s*,\s*(?:from:\s*"([^"]+)"|\.upToNextMajor\(from:\s*"([^"]+)"\)|exact:\s*"([^"]+)"|"([^"]+)"\s*\.\.)/g)) {
    addDep(m, p[1]!.replace(/\.git$/, '').split('/').pop()!, p[2] ?? p[3] ?? p[4] ?? p[5] ?? '*');
  }
}

/** Reads what a project's manifests, README and env files say. Never throws. */
export async function readManifest(input: ManifestInput): Promise<Manifest> {
  const m: Manifest = { deps: [], platform: [], aliases: [], refs: [], configs: [], envMissing: [], stamp: input.stamp };
  const c: Ctx = { m, dir: input.dir, files: input.files };
  const top = new Set(input.files.filter((f) => !f.includes('/')).map((f) => f.toLowerCase()));
  const has = (n: string) => top.has(n.toLowerCase());
  const tasks: [boolean, () => Promise<void>][] = [
    [has('package.json'), () => readPackageJson(c)],
    [has('pyproject.toml'), () => readPyproject(c)],
    [has('setup.py'), () => readSetupPy(c)],
    [has('requirements.txt'), () => readRequirements(c)],
    [input.files.some((f) => /\.(cs|fs|vb)proj$/i.test(f)), () => readCsproj(c)],
    [has('cargo.toml'), () => readCargo(c)],
    [has('go.mod'), () => readGoMod(c)],
    [has('pom.xml'), () => readPom(c)],
    [has('build.gradle') || has('build.gradle.kts'), () => readGradle(c)],
    [has('cmakelists.txt'), () => readCMake(c)],
    [has('makefile'), () => readMakefile(c)],
    [has('project.godot'), () => readGodot(c)],
    [has('pubspec.yaml'), () => readPubspec(c)],
    [has('composer.json'), () => readComposer(c)],
    [has('gemfile'), () => readGemfile(c)],
    [has('package.swift'), () => readSwiftPackage(c)],
    [input.markers.includes('Unity'), () => readUnity(c)],
  ];
  for (const [when, run] of tasks) {
    if (!when) continue;
    try {
      await run();
    } catch {
      // a broken manifest must not break the index
    }
  }
  const uproject = input.files.find((f) => !f.includes('/') && f.toLowerCase().endsWith('.uproject'));
  if (uproject) await readUproject(c, uproject).catch(() => undefined);

  // Config files present
  const workflows = input.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(f)).map((f) => f.slice(f.lastIndexOf('/') + 1));
  m.configs = input.files.filter((f) => !f.includes('/') && isConfigFile(f)).sort();
  if (workflows.length) m.configs.push(`.github/workflows (${workflows.slice(0, 6).join(', ')}${workflows.length > 6 ? ', ...' : ''})`);

  // .env keys from the example that the real .env does not set (names only).
  const example = input.files.find((f) => /^\.env\.(example|sample|template)$/i.test(f));
  if (example) {
    const ex = await readText(path.join(input.dir, example));
    if (ex) {
      const present = new Set<string>();
      for (const f of ['.env', '.env.local']) {
        const t = await readText(path.join(input.dir, f));
        if (t) for (const k of envKeys(t)) present.add(k);
      }
      m.envExample = example;
      m.envMissing = [...new Set(envKeys(ex))].filter((k) => !present.has(k));
    }
  }

  const readme = input.files.find((f) => /^readme(\.(md|markdown|txt|rst))?$/i.test(f));
  if (readme) {
    const t = await readText(path.join(input.dir, readme), 256 * 1024);
    if (t) m.readme = readmeSummary(t);
  }
  m.aliases = [...new Set(m.aliases.filter(Boolean))];
  m.platform = [...new Set(m.platform)];
  return m;
}
