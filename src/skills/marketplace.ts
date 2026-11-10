// Skills marketplace: any GitHub repository with SKILL.md folders (for example anthropics/skills,
// or a Claude Code plugin marketplace). The repository tarball is downloaded once (cached for an
// hour), scanned for skills, and installing a skill copies its folder to ~/.freecode/skills/<name>.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { freecodeHome } from '../config/paths.js';
import { readTar, type TarEntry } from '../util/tar.js';
import { parseFrontMatter, userSkillsDir } from './skills.js';

export const DEFAULT_MARKETPLACES = ['anthropics/skills'];

export interface MarketSkill {
  name: string;
  description: string;
  /** Folder of the skill inside the repository. */
  path: string;
  license?: string;
  files: number;
}

export interface Catalog {
  source: string;
  skills: MarketSkill[];
  fetchedAt: number;
}

/** Accepts "owner/repo", "owner/repo@branch" or a github.com URL. */
export function parseSource(input: string): { owner: string; repo: string; ref: string } | null {
  const s = input.trim().replace(/\.git$/, '');
  const url = /github\.com[/:]([\w.-]+)\/([\w.-]+)(?:\/tree\/([^/\s]+))?/i.exec(s);
  if (url) return { owner: url[1]!, repo: url[2]!, ref: url[3] ?? 'HEAD' };
  const short = /^([\w.-]+)\/([\w.-]+)(?:@([\w./-]+))?$/.exec(s);
  return short ? { owner: short[1]!, repo: short[2]!, ref: short[3] ?? 'HEAD' } : null;
}

function cacheFile(source: string): string {
  return path.join(freecodeHome(), 'cache', 'skills', `${source.replace(/[^\w.-]+/g, '__')}.tar.gz`);
}

async function download(source: string, force: boolean): Promise<Buffer> {
  const src = parseSource(source);
  if (!src) throw new Error(`Not a GitHub repository: ${source}`);
  const file = cacheFile(source);
  if (!force && existsSync(file) && Date.now() - statSync(file).mtimeMs < 3600_000) return readFileSync(file);
  const url = `https://codeload.github.com/${src.owner}/${src.repo}/tar.gz/${src.ref}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'FreeCode' }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    if (existsSync(file)) return readFileSync(file); // offline: use the last copy
    throw new Error(res.status === 404 ? `Repository not found: ${source}` : `Download failed (HTTP ${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buf);
  return buf;
}

/** Repository paths without the "<repo>-<sha>/" folder GitHub puts around everything. */
function entries(tarball: Buffer): TarEntry[] {
  return readTar(tarball)
    .map((e) => ({ ...e, path: e.path.split('/').slice(1).join('/') }))
    .filter((e) => e.path);
}

export async function fetchCatalog(source: string, force = false): Promise<Catalog> {
  const files = entries(await download(source, force));
  const skills: MarketSkill[] = [];
  for (const e of files) {
    if (path.posix.basename(e.path) !== 'SKILL.md') continue;
    const dir = path.posix.dirname(e.path);
    if (/(^|\/)(templates?|examples?\/broken)(\/|$)/i.test(dir) && !/(^|\/)skills\//.test(dir)) continue;
    const { data } = parseFrontMatter(e.data.toString('utf8').slice(0, 8000));
    const name = (data.name || path.posix.basename(dir === '.' ? source : dir)).trim();
    if (!name || /^template/i.test(name)) continue;
    skills.push({ name, description: (data.description || '').trim(), path: dir === '.' ? '' : dir, license: data.license, files: files.filter((f) => (dir === '.' ? true : f.path.startsWith(`${dir}/`))).length });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { source, skills, fetchedAt: Date.now() };
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'skill';
}

/** Copies one skill folder from the repository into ~/.freecode/skills/<name>. */
export async function installSkill(source: string, skillPath: string): Promise<{ name: string; dir: string; files: number }> {
  const files = entries(await download(source, false));
  const prefix = skillPath ? `${skillPath.replace(/\/+$/, '')}/` : '';
  const mine = files.filter((f) => f.path.startsWith(prefix));
  const manifest = mine.find((f) => f.path === `${prefix}SKILL.md`);
  if (!manifest) throw new Error(`No SKILL.md at ${skillPath || 'the repository root'} in ${source}`);
  const { data } = parseFrontMatter(manifest.data.toString('utf8'));
  const name = safeName((data.name || path.posix.basename(skillPath || source)).trim());
  const target = path.join(userSkillsDir(), name);
  rmSync(target, { recursive: true, force: true });
  let count = 0;
  for (const f of mine) {
    const rel = f.path.slice(prefix.length);
    const out = path.resolve(target, rel);
    if (!out.startsWith(path.resolve(target) + path.sep)) continue; // never write outside the skill folder
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, f.data);
    count++;
  }
  writeFileSync(path.join(target, '.freecode-source.json'), JSON.stringify({ source, path: skillPath, installedAt: new Date().toISOString() }, null, 2));
  return { name, dir: target, files: count };
}

/** Removes a skill installed in ~/.freecode/skills. */
export function removeSkill(name: string): boolean {
  const dir = path.join(userSkillsDir(), safeName(name));
  if (!existsSync(path.join(dir, 'SKILL.md'))) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Where an installed skill came from (marketplace installs only). */
export function installedFrom(dir: string): { source: string; path: string } | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, '.freecode-source.json'), 'utf8')) as { source: string; path: string };
  } catch {
    return null;
  }
}
