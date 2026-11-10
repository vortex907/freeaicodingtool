// Glob pattern matching (**, *, ?, [...], {a,b}) on forward-slash relative paths.

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string, opts: { dot?: boolean; nocase?: boolean } = {}): RegExp {
  const key = `${pattern}\0${opts.dot ? 1 : 0}${opts.nocase ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let p = pattern.replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  let re = '';
  let i = 0;
  let braceDepth = 0;
  while (i < p.length) {
    const ch = p[i]!;
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // ** matches any number of path segments
        const atSegStart = i === 0 || p[i - 1] === '/';
        const atSegEnd = i + 2 >= p.length || p[i + 2] === '/';
        if (atSegStart && atSegEnd) {
          if (p[i + 2] === '/') {
            re += '(?:.*/)?';
            i += 3;
          } else {
            re += '.*';
            i += 2;
          }
          continue;
        }
        re += '[^/]*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (ch === '[') {
      const end = p.indexOf(']', i + 1);
      if (end > i) {
        let cls = p.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end + 1;
        continue;
      }
    }
    if (ch === '{') {
      braceDepth++;
      re += '(?:';
      i++;
      continue;
    }
    if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
      i++;
      continue;
    }
    if (ch === ',' && braceDepth > 0) {
      re += '|';
      i++;
      continue;
    }
    re += /[.+^$()|\\]/.test(ch) ? '\\' + ch : ch;
    i++;
  }
  const rx = new RegExp(`^${re}$`, opts.nocase ? 'i' : '');
  cache.set(key, rx);
  return rx;
}

export function matchGlob(pattern: string, relPath: string, opts: { dot?: boolean; nocase?: boolean } = {}): boolean {
  const rx = globToRegExp(pattern, opts);
  return rx.test(relPath.replace(/\\/g, '/'));
}

export function hasGlobChars(s: string): boolean {
  return /[*?[\]{}]/.test(s);
}

/** Matches either the full relative path or (for patterns without '/') just the basename. */
export function matchPathOrBase(pattern: string, relPath: string): boolean {
  if (matchGlob(pattern, relPath, { dot: true })) return true;
  if (!pattern.includes('/')) {
    const base = relPath.slice(relPath.lastIndexOf('/') + 1);
    return matchGlob(pattern, base, { dot: true });
  }
  return false;
}
