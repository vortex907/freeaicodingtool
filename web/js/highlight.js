// Small regex-based syntax highlighter producing HTML spans.
import { escapeHtml } from './dom.js';

const KW = {
  js: 'abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let module namespace never new null number object of private protected public readonly return set static string super switch symbol this throw true try type typeof undefined unknown var void while with yield',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield match case',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false',
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected virtual override template typename namespace using new delete this true false nullptr bool final abstract extends implements interface package import throws throw try catch finally string var val fun when object companion data sealed let func guard protocol extension self nil',
  sh: 'if then else elif fi case esac for while until do done in function return local export readonly declare unset shift exit echo cd source alias set sudo npm npx pnpm yarn git node python pip cargo go make docker',
  sql: 'select from where and or not insert into values update set delete create table drop alter add column primary key foreign references join inner left right outer on group by order having limit offset as distinct union all exists in is null like between case when then else end index view',
  rb: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require',
  php: 'abstract and array as break case catch class clone const continue declare default do echo else elseif empty extends final finally fn for foreach function global if implements include instanceof interface isset list namespace new or print private protected public require return static switch throw trait try unset use var while yield true false null',
};
const KWS = Object.fromEntries(Object.entries(KW).map(([k, v]) => [k, new Set(v.split(' '))]));

function family(lang) {
  const l = (lang || '').toLowerCase();
  if (['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx', 'mjs', 'cjs', 'json', 'jsonc', 'vue', 'svelte'].includes(l)) return 'js';
  if (['py', 'python'].includes(l)) return 'py';
  if (['rs', 'rust'].includes(l)) return 'rust';
  if (['go', 'golang'].includes(l)) return 'go';
  if (['c', 'h', 'cpp', 'c++', 'cc', 'hpp', 'java', 'kotlin', 'kt', 'cs', 'csharp', 'swift', 'scala', 'dart'].includes(l)) return 'c';
  if (['sh', 'bash', 'zsh', 'shell', 'console', 'powershell', 'ps1', 'bat', 'cmd'].includes(l)) return 'sh';
  if (['sql', 'postgres', 'mysql', 'sqlite'].includes(l)) return 'sql';
  if (['rb', 'ruby'].includes(l)) return 'rb';
  if (l === 'php') return 'php';
  if (['html', 'xml', 'svg', 'htm'].includes(l)) return 'html';
  if (['css', 'scss', 'less'].includes(l)) return 'css';
  if (['yaml', 'yml', 'toml', 'ini', 'env'].includes(l)) return 'yaml';
  if (['diff', 'patch'].includes(l)) return 'diff';
  return null;
}

export function langFromPath(p) {
  const m = /\.([a-z0-9]+)$/i.exec(p || '');
  return m ? m[1].toLowerCase() : '';
}

const span = (cls, s) => `<span class="tok-${cls}">${escapeHtml(s)}</span>`;

function hlGeneric(line, fam) {
  const words = KWS[fam] || new Set();
  const lineComment = ['py', 'sh', 'rb', 'yaml'].includes(fam) ? '#' : fam === 'sql' ? '--' : '//';
  let out = '';
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest.startsWith(lineComment) && (lineComment !== '#' || i === 0 || /\s/.test(line[i - 1]))) {
      out += span('com', rest);
      break;
    }
    if (fam !== 'py' && fam !== 'sh' && rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      const seg = end >= 0 ? rest.slice(0, end + 2) : rest;
      out += span('com', seg);
      i += seg.length;
      continue;
    }
    const q = rest[0];
    if (q === '"' || q === "'" || q === '`') {
      let j = 1;
      while (j < rest.length && rest[j] !== q) {
        if (rest[j] === '\\') j++;
        j++;
      }
      const seg = rest.slice(0, j + 1);
      out += span('str', seg);
      i += seg.length;
      continue;
    }
    const nm = /^(0x[0-9a-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)\b/.exec(rest);
    if (nm && (i === 0 || !/[\w$]/.test(line[i - 1]))) {
      out += span('num', nm[0]);
      i += nm[0].length;
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (id) {
      const w = id[0];
      const after = line[i + w.length];
      if (words.has(w) || (fam === 'sql' && words.has(w.toLowerCase()))) out += span('kw', w);
      else if (after === '(') out += span('fn', w);
      else if (/^[A-Z][a-zA-Z0-9]*$/.test(w) && fam !== 'sql' && fam !== 'sh') out += span('type', w);
      else out += escapeHtml(w);
      i += w.length;
      continue;
    }
    out += escapeHtml(rest[0]);
    i++;
  }
  return out;
}

function hlHtml(line) {
  let out = '';
  let last = 0;
  const re = /(<\/?)([\w:-]+)([^>]*?)(\/?>)/g;
  let m;
  while ((m = re.exec(line))) {
    out += escapeHtml(line.slice(last, m.index));
    const attrs = m[3].replace(/([\w:-]+)(=)("[^"]*"|'[^']*')?/g, '\u0001$1\u0002$2\u0003$3\u0004');
    let a = escapeHtml(attrs);
    a = a.replace(/\u0001(.*?)\u0002(.*?)\u0003(.*?)\u0004/g, (_x, k, eq, v) => `<span class="tok-attr">${k}</span>${eq}${v ? `<span class="tok-str">${v}</span>` : ''}`);
    out += `<span class="tok-com">${escapeHtml(m[1])}</span><span class="tok-tag">${escapeHtml(m[2])}</span>${a}<span class="tok-com">${escapeHtml(m[4])}</span>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(line.slice(last));
}

function hlYaml(line) {
  if (/^\s*#/.test(line)) return span('com', line);
  const m = /^(\s*-?\s*)([\w.\-"' ]+?)(\s*[:=])(.*)$/.exec(line);
  if (m) return escapeHtml(m[1]) + span('fn', m[2]) + escapeHtml(m[3]) + (m[4].trim().startsWith('#') ? span('com', m[4]) : span('str', m[4]));
  return escapeHtml(line);
}

function hlCss(line) {
  const m = /^(\s*)([\w-]+)(\s*:)([^;]*)(;?)(.*)$/.exec(line);
  if (m && !line.includes('{')) return escapeHtml(m[1]) + span('fn', m[2]) + escapeHtml(m[3]) + span('num', m[4]) + escapeHtml(m[5] + m[6]);
  return escapeHtml(line);
}

export function highlightLine(line, lang) {
  const fam = family(lang);
  if (!fam) return escapeHtml(line);
  if (fam === 'diff') {
    if (line.startsWith('+')) return `<span class="tok-str">${escapeHtml(line)}</span>`;
    if (line.startsWith('-')) return `<span class="tok-tag">${escapeHtml(line)}</span>`;
    if (line.startsWith('@@')) return `<span class="tok-fn">${escapeHtml(line)}</span>`;
    return escapeHtml(line);
  }
  if (fam === 'html') return hlHtml(line);
  if (fam === 'yaml') return hlYaml(line);
  if (fam === 'css') return hlCss(line);
  return hlGeneric(line, fam);
}

export function highlight(code, lang) {
  return code
    .split('\n')
    .map((l) => highlightLine(l, lang))
    .join('\n');
}
