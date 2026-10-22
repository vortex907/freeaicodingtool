// Import resolution: relative imports become files, package and namespace imports become the
// other indexed project that provides them. The result says "project A uses project B" and where.
import * as path from 'node:path';
import { langById } from './lang.js';
import type { ProjectRec } from './projects.js';
import { Slicer } from './slicer.js';
import type { FileEntry, RootState } from './types.js';

export interface ProjectRef {
  root: RootState;
  project: ProjectRec;
}

export interface LinkEdge {
  from: ProjectRef;
  to: ProjectRef;
  /** Import statements that resolve to the other project. */
  imports: number;
  /** Importing files, relative to the importing project. */
  files: string[];
  /** The manifest lists the other project (dependency, ProjectReference, path dependency). */
  declared: boolean;
}

export interface Links {
  edges: LinkEdge[];
}

const JS_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];
const RUST_INTERNAL = new Set(['crate', 'self', 'super', 'std', 'core', 'alloc']);

function norm(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Deepest project that contains a root-relative path. */
export function projectOf(root: RootState, rel: string): ProjectRec | undefined {
  let best: ProjectRec | undefined;
  for (const p of root.projects) {
    if (p.rel === '' || rel === p.rel || rel.startsWith(`${p.rel}/`)) {
      if (!best || p.rel.length > best.rel.length) best = p;
    }
  }
  return best;
}

/** Resolves every import of every root. Yields to the event loop now and then (large roots). */
export async function computeLinks(roots: RootState[]): Promise<Links> {
  const slicer = new Slicer();
  const byName = new Map<string, ProjectRef[]>();
  const byNs = new Map<string, ProjectRef[]>();
  const byDir = new Map<string, ProjectRef>();
  const add = (map: Map<string, ProjectRef[]>, key: string, ref: ProjectRef) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.some((r) => r.project === ref.project)) list.push(ref);
    map.set(key, list);
  };
  const lower = new Map<RootState, Map<string, string>>();
  const headers = new Map<string, { root: RootState; rel: string }[]>();
  const fileProject = new Map<FileEntry, ProjectRec | undefined>();

  for (const root of roots) {
    for (const project of [...root.projects]) {
      const ref = { root, project };
      byDir.set(norm(project.dir), ref);
      const m = project.manifest;
      for (const a of m?.aliases ?? []) add(byName, a, ref);
      if (m?.name) add(byName, m.name, ref);
    }
    const lm = new Map<string, string>();
    for (const [rel, f] of [...root.files]) {
      await slicer.tick();
      lm.set(rel.toLowerCase(), rel);
      const project = projectOf(root, rel);
      fileProject.set(f, project);
      if (!project || f.skipped) continue;
      const ref = { root, project };
      for (const ns of f.ns) add(byNs, ns, ref);
      // Python packages: folders with __init__.py at the project top or under src/
      const inProject = project.rel ? rel.slice(project.rel.length + 1) : rel;
      const py = /^(?:src\/)?([A-Za-z_]\w*)\/__init__\.py$/.exec(inProject);
      if (py) add(byName, `py:${py[1]}`, ref);
      if (langById(f.lang).family === 'c' && /\.(h|hh|hpp|hxx|h\+\+|inl|ipp)$/i.test(rel)) {
        const base = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
        const list = headers.get(base) ?? [];
        list.push({ root, rel });
        headers.set(base, list);
      }
    }
    lower.set(root, lm);
  }

  const findRel = (root: RootState, rel: string): string | undefined => (root.files.has(rel) ? rel : lower.get(root)?.get(rel.toLowerCase()));
  const relative = (root: RootState, fromRel: string, spec: string, exts: string[]): string | undefined => {
    const dir = path.posix.dirname(fromRel);
    const joined = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, spec));
    if (joined.startsWith('..')) return undefined;
    for (const e of exts) {
      const r = findRel(root, joined + e);
      if (r) return r;
    }
    const js = /\.[mc]?js$/.exec(joined);
    if (js) for (const e of ['.ts', '.tsx', '.mts', '.cts']) {
      const r = findRel(root, joined.slice(0, -js[0].length) + e);
      if (r) return r;
    }
    return undefined;
  };
  // Longest dotted (or slashed) prefix of an import that names a project or namespace.
  const byPrefix = (spec: string, sep: string, maps: Map<string, ProjectRef[]>[], self: ProjectRec): ProjectRef | undefined => {
    const parts = spec.split(sep);
    for (let n = parts.length; n >= 1; n--) {
      const key = parts.slice(0, n).join(sep);
      for (const map of maps) {
        const hits = map.get(key);
        if (!hits) continue;
        if (hits.some((h) => h.project === self)) return undefined;
        return hits[0];
      }
    }
    return undefined;
  };
  const named = (key: string, self: ProjectRec): ProjectRef | undefined => {
    const hits = byName.get(key);
    if (!hits || hits.some((h) => h.project === self)) return undefined;
    return hits[0];
  };

  const resolve = (root: RootState, f: FileEntry, spec: string, self: ProjectRec): ProjectRef | undefined => {
    const family = langById(f.lang).family;
    const inFile = (rel: string | undefined): ProjectRef | undefined => {
      if (!rel) return undefined;
      const p = projectOf(root, rel);
      return p ? { root, project: p } : undefined;
    };
    switch (family) {
      case 'js': {
        if (spec.startsWith('.')) return inFile(relative(root, f.rel, spec, JS_EXTS));
        if (/^[a-z]+:/i.test(spec) && !spec.startsWith('@')) return undefined; // node:fs, http: URLs
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
        return named(pkg, self);
      }
      case 'py': {
        if (spec.startsWith('.')) {
          const dots = /^\.+/.exec(spec)![0].length;
          let dir = path.posix.dirname(f.rel);
          for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
          const base = (dir === '.' ? '' : `${dir}/`) + spec.slice(dots).replace(/\./g, '/');
          return inFile(findRel(root, `${base}.py`) ?? findRel(root, `${base}/__init__.py`));
        }
        const parts = spec.split('.');
        const pdir = self.rel ? `${self.rel}/` : '';
        for (const prefix of [pdir, `${pdir}src/`]) {
          for (let n = parts.length; n >= 1; n--) {
            const base = prefix + parts.slice(0, n).join('/');
            if (findRel(root, `${base}.py`) ?? findRel(root, `${base}/__init__.py`)) return undefined;
          }
        }
        return named(`py:${parts[0]}`, self) ?? named(parts[0]!.toLowerCase(), self);
      }
      case 'cs':
      case 'java':
      case 'kotlin':
        return byPrefix(spec, '.', [byNs, byName], self);
      case 'php':
        return spec.startsWith('./') ? inFile(relative(root, f.rel, spec, [''])) : byPrefix(spec, '\\', [byNs, byName], self);
      case 'go':
        return byPrefix(spec, '/', [byName], self);
      case 'rust': {
        const first = spec.split('::')[0]!;
        return RUST_INTERNAL.has(first) ? undefined : named(first, self);
      }
      case 'c': {
        const angle = spec.startsWith('<');
        const s = angle ? spec.slice(1) : spec;
        if (!angle) {
          const pdir = self.rel ? `${self.rel}/` : '';
          const local = relative(root, f.rel, s, ['']) ?? findRel(root, pdir + s) ?? findRel(root, `${pdir}include/${s}`) ?? findRel(root, `${pdir}src/${s}`);
          if (local) return inFile(local);
        } else if (!s.includes('/')) return undefined;
        const want = `/${s.toLowerCase()}`;
        for (const c of headers.get(s.slice(s.lastIndexOf('/') + 1).toLowerCase()) ?? []) {
          if (!`/${c.rel.toLowerCase()}`.endsWith(want)) continue;
          const p = projectOf(c.root, c.rel);
          if (p && p !== self) return { root: c.root, project: p };
          if (p === self) return undefined;
        }
        return undefined;
      }
      case 'dart': {
        const pm = /^package:([^/]+)\//.exec(spec);
        if (pm) return named(pm[1]!, self);
        return /^[a-z]+:/.test(spec) ? undefined : inFile(relative(root, f.rel, spec, ['', '.dart']));
      }
      case 'ruby':
        return spec.startsWith('./') ? inFile(relative(root, f.rel, spec, ['', '.rb'])) : undefined;
      case 'swift':
        return named(spec, self);
      default:
        return undefined;
    }
  };

  const edges = new Map<string, LinkEdge>();
  const edge = (from: ProjectRef, to: ProjectRef): LinkEdge => {
    const key = `${norm(from.project.dir)}\0${norm(to.project.dir)}`;
    let e = edges.get(key);
    if (!e) {
      e = { from, to, imports: 0, files: [], declared: false };
      edges.set(key, e);
    }
    return e;
  };

  for (const root of roots) {
    for (const f of [...root.files.values()]) {
      await slicer.tick();
      if (f.skipped || !f.imps.length) continue;
      const self = fileProject.get(f);
      if (!self) continue;
      const fileRel = self.rel ? f.rel.slice(self.rel.length + 1) : f.rel;
      for (const imp of f.imps) {
        const target = resolve(root, f, imp.spec, self);
        if (!target || target.project === self) continue;
        const e = edge({ root, project: self }, target);
        e.imports++;
        if (!e.files.includes(fileRel) && e.files.length < 50) e.files.push(fileRel);
      }
    }
    // Manifest references and dependencies on other indexed projects.
    for (const project of root.projects) {
      const m = project.manifest;
      if (!m) continue;
      const self = { root, project };
      for (const r of m.refs) {
        let dir = norm(r);
        let hit = byDir.get(dir);
        while (!hit && path.dirname(dir) !== dir) {
          dir = path.dirname(dir);
          hit = byDir.get(dir);
        }
        if (hit && hit.project !== project) edge(self, hit).declared = true;
      }
      for (const d of m.deps) {
        const hit = named(d.name, project);
        if (hit) edge(self, hit).declared = true;
      }
    }
  }
  return { edges: [...edges.values()] };
}
