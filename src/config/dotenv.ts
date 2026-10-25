// Minimal .env parser (KEY=VALUE, optional quotes, `export` prefix, # comments).
import { readFileSync } from 'node:fs';

export function parseDotenv(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if (q === '"' || q === "'" || q === '`') {
      // Support multi-line quoted values.
      let full = value.slice(1);
      while (!full.includes(q) && i + 1 < lines.length) {
        full += '\n' + lines[++i];
      }
      const end = full.indexOf(q);
      value = end >= 0 ? full.slice(0, end) : full;
      if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"');
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

export function loadDotenvFile(file: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
