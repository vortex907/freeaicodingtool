// Small regex-based syntax highlighter for code blocks and diffs (no dependencies).
import { c, fg } from '../util/ansi.js';

const kw = fg('#c678dd');
const str = fg('#98c379');
const num = fg('#d19a66');
const com = (s: string) => c.italic(fg('#7f848e')(s));
const typ = fg('#e5c07b');
const fn = fg('#61afef');
const tag = fg('#e06c75');
const attrC = fg('#d19a66');

const KEYWORDS: Record<string, string[]> = {
  js: 'abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let module namespace never new null number object of private protected public readonly return set static string super switch symbol this throw true try type typeof undefined unknown var void while with yield'.split(' '),
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield match case'.split(' '),
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err'.split(' '),
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false'.split(' '),
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected virtual override template typename namespace using new delete this true false nullptr bool final abstract extends implements interface package import throws throw try catch finally static string var val fun when object companion data sealed let func guard struct protocol extension self nil'.split(' '),
  sh: 'if then else elif fi case esac for while until do done in function return local export readonly declare unset shift exit echo cd source alias set'.split(' '),
  sql: 'select from where and or not insert into values update set delete create table drop alter add column primary key foreign references join inner left right outer on group by order having limit offset as distinct union all exists in is null like between case when then else end index view'.split(' '),
  rb: 'alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor'.split(' '),
  php: 'abstract and array as break case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global if implements include instanceof interface isset list namespace new or print private protected public require return static switch throw trait try unset use var while yield true false null'.split(' '),
};

function langFamily(lang: string): string | null {
  const l = lang.toLowerCase();
  if (['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx', 'mjs', 'cjs', 'json', 'jsonc', 'json5', 'vue', 'svelte'].includes(l)) return 'js';
  if (['py', 'python', 'python3'].includes(l)) return 'py';
  if (['rs', 'rust'].includes(l)) return 'rust';
  if (['go', 'golang'].includes(l)) return 'go';
  if (['c', 'h', 'cpp', 'c++', 'cc', 'hpp', 'java', 'kotlin', 'kt', 'cs', 'csharp', 'swift', 'scala', 'dart', 'groovy', 'objc'].includes(l)) return 'c';
  if (['sh', 'bash', 'zsh', 'shell', 'console', 'fish', 'powershell', 'ps1', 'bat', 'cmd'].includes(l)) return 'sh';
  if (['sql', 'mysql', 'postgres', 'postgresql', 'sqlite'].includes(l)) return 'sql';
  if (['rb', 'ruby'].includes(l)) return 'rb';
  if (['php'].includes(l)) return 'php';
  if (['html', 'xml', 'svg', 'htm', 'xhtml'].includes(l)) return 'html';
  if (['css', 'scss', 'sass', 'less'].includes(l)) return 'css';
  if (['yaml', 'yml', 'toml', 'ini', 'env', 'dotenv', 'properties'].includes(l)) return 'yaml';
  if (['diff', 'patch'].includes(l)) return 'diff';
  return null;
}

export function guessLangFromPath(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  return ext || '';
}

function highlightGeneric(line: string, family: string): string {
  const words = new Set(KEYWORDS[family] ?? []);
  const lineComment = family === 'py' || family === 'sh' || family === 'rb' || family === 'yaml' ? '#' : family === 'sql' ? '--' : '//';
  let out = '';
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    // comments
    if (rest.startsWith(lineComment) && (lineComment !== '#' || i === 0 || /\s/.test(line[i - 1]!))) {
      out += com(rest);
      break;
    }
    if (family !== 'py' && family !== 'sh' && rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      const seg = end >= 0 ? rest.slice(0, end + 2) : rest;
      out += com(seg);
      i += seg.length;
      continue;
    }
    // strings
    const q = rest[0];
    if (q === '"' || q === "'" || q === '`') {
      let j = 1;
      while (j < rest.length && rest[j] !== q) {
        if (rest[j] === '\\') j++;
        j++;
      }
      const seg = rest.slice(0, j + 1);
      out += str(seg);
      i += seg.length;
      continue;
    }
    // numbers
    const nm = /^(0x[0-9a-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)\b/.exec(rest);
    if (nm && (i === 0 || !/[\w$]/.test(line[i - 1]!))) {
      out += num(nm[0]);
      i += nm[0].length;
      continue;
    }
    // identifiers
    const id = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (id) {
      const w = id[0];
      const after = line[i + w.length];
      if (words.has(w) || (family === 'sql' && words.has(w.toLowerCase()))) out += kw(w);
      else if (after === '(') out += fn(w);
      else if (/^[A-Z][a-zA-Z0-9]*$/.test(w) && family !== 'sql') out += typ(w);
      else out += w;
      i += w.length;
      continue;
    }
    out += rest[0];
    i++;
  }
  return out;
}

function highlightHtml(line: string): string {
  return line.replace(/(<\/?)([\w:-]+)([^>]*)(\/?>)?/g, (_m, open: string, name: string, attrs: string, close: string | undefined) => {
    const a = attrs.replace(/([\w:-]+)(=)("[^"]*"|'[^']*')?/g, (_x, k: string, eq: string, v: string | undefined) => attrC(k) + eq + (v ? str(v) : ''));
    return c.gray(open) + tag(name) + a + (close ? c.gray(close) : '');
  });
}

function highlightCss(line: string): string {
  if (/^\s*[^{]+\{\s*$/.test(line)) return typ(line);
  return line.replace(/^(\s*)([\w-]+)(\s*:)([^;]*)(;?)/, (_m, s: string, p: string, colon: string, v: string, semi: string) => s + fn(p) + colon + num(v) + semi);
}

function highlightYaml(line: string): string {
  if (/^\s*#/.test(line)) return com(line);
  const m = /^(\s*-?\s*)([\w.\-"' ]+?)(\s*[:=])(.*)$/.exec(line);
  if (m) return m[1]! + fn(m[2]!) + m[3]! + (m[4]!.trim().startsWith('#') ? com(m[4]!) : str(m[4]!));
  if (/^\s*\[.*\]\s*$/.test(line)) return typ(line);
  return line;
}

export function highlightLine(line: string, lang: string): string {
  const fam = langFamily(lang);
  if (!fam) return line;
  if (fam === 'diff') {
    if (line.startsWith('+') && !line.startsWith('+++')) return c.green(line);
    if (line.startsWith('-') && !line.startsWith('---')) return c.red(line);
    if (line.startsWith('@@')) return c.cyan(line);
    return line;
  }
  if (fam === 'html') return highlightHtml(line);
  if (fam === 'css') return highlightCss(line);
  if (fam === 'yaml') return highlightYaml(line);
  return highlightGeneric(line, fam);
}
