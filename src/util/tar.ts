// Minimal reader for .tar / .tar.gz archives (ustar, pax and GNU long names), enough for GitHub
// repository tarballs. Only regular files are returned.
import { gunzipSync } from 'node:zlib';

export interface TarEntry {
  path: string;
  data: Buffer;
}

function str(buf: Buffer, start: number, len: number): string {
  const s = buf.subarray(start, start + len);
  const nul = s.indexOf(0);
  return s.subarray(0, nul < 0 ? s.length : nul).toString('utf8');
}

function octal(buf: Buffer, start: number, len: number): number {
  const s = str(buf, start, len).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

/** Parses pax "length key=value\n" records. */
function paxPath(data: Buffer): string | undefined {
  let i = 0;
  const text = data.toString('utf8');
  while (i < text.length) {
    const space = text.indexOf(' ', i);
    if (space < 0) break;
    const len = Number(text.slice(i, space));
    if (!len) break;
    const record = text.slice(space + 1, i + len - 1);
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') return record.slice(eq + 1);
    i += len;
  }
  return undefined;
}

export function readTar(input: Buffer): TarEntry[] {
  const buf = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input) : input;
  const out: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(header, 345, 155);
    let name = str(header, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = offset + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = str(data, 0, data.length);
      continue;
    }
    if (type === 'x') {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === 'g') continue;
    const path = longName ?? name;
    longName = undefined;
    if (type === '0' || type === '\0' || type === '7') out.push({ path, data: Buffer.from(data) });
  }
  return out;
}
