// Languages: what a file is, and the line-based rules that find its definitions and imports.
// The rules are regexes, not parsers: fast, dependency free and good enough to navigate code.

export type Family = 'js' | 'py' | 'cs' | 'java' | 'kotlin' | 'go' | 'rust' | 'c' | 'php' | 'ruby' | 'lua' | 'gd' | 'swift' | 'dart' | 'md';

export interface Lang {
  /** Stable id stored in the index, e.g. "typescript". */
  id: string;
  /** Display name, e.g. "TypeScript". */
  name: string;
  /** Rule set for definitions and imports. */
  family?: Family;
  /** Source code (counts in project profiles), as opposed to docs, data and config. */
  code: boolean;
}

const BY_ID = new Map<string, Lang>();
const BY_EXT = new Map<string, Lang>();
const BY_NAME = new Map<string, Lang>();

function lang(id: string, name: string, exts: string[], family?: Family, code = true): Lang {
  const l: Lang = { id, name, family, code };
  BY_ID.set(id, l);
  for (const e of exts) BY_EXT.set(e, l);
  return l;
}

lang('typescript', 'TypeScript', ['ts', 'tsx', 'mts', 'cts'], 'js');
lang('javascript', 'JavaScript', ['js', 'jsx', 'mjs', 'cjs'], 'js');
lang('vue', 'Vue', ['vue'], 'js');
lang('svelte', 'Svelte', ['svelte'], 'js');
lang('astro', 'Astro', ['astro'], 'js');
lang('python', 'Python', ['py', 'pyi', 'pyw'], 'py');
lang('csharp', 'C#', ['cs', 'csx'], 'cs');
lang('java', 'Java', ['java'], 'java');
lang('kotlin', 'Kotlin', ['kt', 'kts'], 'kotlin');
lang('go', 'Go', ['go'], 'go');
lang('rust', 'Rust', ['rs'], 'rust');
lang('c', 'C', ['c', 'h'], 'c');
lang('cpp', 'C++', ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++', 'ipp', 'inl', 'tpp', 'ino', 'cu', 'cuh'], 'c');
lang('objc', 'Objective-C', ['m', 'mm'], 'c');
lang('php', 'PHP', ['php', 'phtml'], 'php');
const ruby = lang('ruby', 'Ruby', ['rb', 'rake', 'gemspec'], 'ruby');
lang('lua', 'Lua', ['lua', 'luau'], 'lua');
lang('gdscript', 'GDScript', ['gd'], 'gd');
lang('swift', 'Swift', ['swift'], 'swift');
lang('dart', 'Dart', ['dart'], 'dart');
lang('scala', 'Scala', ['scala', 'sc']);
lang('shader', 'Shader', ['hlsl', 'glsl', 'vert', 'frag', 'geom', 'comp', 'tesc', 'tese', 'wgsl', 'metal', 'shader', 'cginc', 'compute', 'usf', 'ush', 'fx', 'fxh', 'gdshader']);
lang('shell', 'Shell', ['sh', 'bash', 'zsh', 'fish']);
lang('powershell', 'PowerShell', ['ps1', 'psm1', 'psd1']);
lang('batch', 'Batch', ['bat', 'cmd']);
lang('sql', 'SQL', ['sql']);
lang('html', 'HTML', ['html', 'htm', 'cshtml', 'razor', 'xhtml']);
lang('css', 'CSS', ['css', 'scss', 'sass', 'less', 'styl']);
lang('elixir', 'Elixir', ['ex', 'exs']);
lang('haskell', 'Haskell', ['hs']);
lang('zig', 'Zig', ['zig']);
lang('nim', 'Nim', ['nim']);
lang('r', 'R', ['r']);
lang('julia', 'Julia', ['jl']);
lang('perl', 'Perl', ['pl', 'pm']);
lang('fsharp', 'F#', ['fs', 'fsx']);
lang('ocaml', 'OCaml', ['ml', 'mli']);
lang('clojure', 'Clojure', ['clj', 'cljs', 'cljc']);
lang('erlang', 'Erlang', ['erl', 'hrl']);
const groovy = lang('groovy', 'Groovy', ['groovy', 'gradle']);
lang('graphql', 'GraphQL', ['graphql', 'gql']);
lang('proto', 'Protobuf', ['proto']);
const markdown = lang('markdown', 'Markdown', ['md', 'markdown', 'mdx', 'rst', 'adoc'], 'md', false);
const text = lang('text', 'Text', ['txt'], undefined, false);
lang('json', 'JSON', ['json', 'jsonc', 'json5', 'uproject', 'uplugin', 'asmdef', 'asmref', 'code-workspace'], undefined, false);
lang('yaml', 'YAML', ['yml', 'yaml'], undefined, false);
lang('toml', 'TOML', ['toml'], undefined, false);
lang('xml', 'XML', ['xml', 'csproj', 'fsproj', 'vbproj', 'vcxproj', 'filters', 'props', 'targets', 'xaml', 'axaml', 'plist', 'resx', 'config', 'nuspec', 'manifest'], undefined, false);
const ini = lang('ini', 'INI', ['ini', 'cfg', 'conf', 'properties', 'godot', 'editorconfig'], undefined, false);
const cmake = lang('cmake', 'CMake', ['cmake'], undefined, false);
lang('solution', 'Solution', ['sln'], undefined, false);
const make = lang('make', 'Makefile', ['mk', 'mak'], undefined, false);
const docker = lang('docker', 'Dockerfile', ['dockerfile'], undefined, false);

for (const [n, l] of [
  ['makefile', make],
  ['gnumakefile', make],
  ['cmakelists.txt', cmake],
  ['gemfile', ruby],
  ['rakefile', ruby],
  ['podfile', ruby],
  ['vagrantfile', ruby],
  ['jenkinsfile', groovy],
  ['readme', markdown],
  ['license', text],
  ['.env.example', ini],
  ['.env.sample', ini],
  ['.env.template', ini],
  ['.editorconfig', ini],
] as const) {
  BY_NAME.set(n, l);
}

/** Fallback for text files of unknown type. */
export const OTHER: Lang = { id: 'other', name: 'Other', code: false };

export function langById(id: string): Lang {
  return BY_ID.get(id) ?? OTHER;
}

/** Language of a file from its name. */
export function langOf(rel: string): Lang {
  const base = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
  const named = BY_NAME.get(base);
  if (named) return named;
  if (base.startsWith('dockerfile')) return docker;
  const dot = base.lastIndexOf('.');
  if (dot > 0) return BY_EXT.get(base.slice(dot + 1)) ?? OTHER;
  return OTHER;
}

// Binary formats and generated text that only adds noise (lock files, Unity/Godot scene data, maps).
const SKIP_EXT = new Set(
  (
    'png jpg jpeg gif bmp tga psd ico icns webp tif tiff dds exr hdr ktx ktx2 astc svg svgz heic avif ' +
    'mp3 wav ogg flac aac m4a wma mid midi mp4 mov avi mkv webm wmv flv ' +
    'zip 7z rar gz tgz bz2 xz zst tar jar war ear apk aab ipa dmg iso msi cab nupkg whl egg ' +
    'exe dll so dylib lib a o obj ko pdb ilk exp idb pch ipch class pyc pyo pyd wasm node bin dat db sqlite sqlite3 mdb ' +
    'ttf otf woff woff2 eot fnt pdf doc docx xls xlsx ppt pptx odt ods odp epub ' +
    'fbx blend blend1 max ma mb 3ds dae gltf glb usd usda usdz abc stl ply vox ' +
    'uasset umap upk pak ucas utoc bnk wem fsb bank ' +
    'meta unity prefab asset mat anim controller overridecontroller physicmaterial physicsmaterial2d mask playable signal lighting ' +
    'spriteatlas rendertexture terrainlayer mixer guiskin flare cubemap preset brush unitypackage ' +
    'import tscn tres scn res ' +
    'map lock log tmp bak swp swo cache sum min.js min.css csv tsv parquet avro npy npz pkl pickle pt pth onnx h5 ckpt safetensors'
  ).split(' '),
);

const SKIP_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'deno.lock',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'uv.lock',
  'composer.lock',
  'gemfile.lock',
  'podfile.lock',
  'pubspec.lock',
  'mix.lock',
  'flake.lock',
  'go.sum',
  'packages.lock.json',
  'thumbs.db',
]);

// Hidden files worth indexing (config people ask about). Everything else hidden is skipped,
// which also keeps secrets like .env and .npmrc out of the index.
const HIDDEN_OK = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.editorconfig',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.babelrc',
  '.gitlab-ci.yml',
  '.dockerignore',
]);

/** Whether a file name is worth reading at all (the content is checked for binary data later). */
export function indexableName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('.')) return HIDDEN_OK.has(lower);
  if (SKIP_NAMES.has(lower)) return false;
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return true;
  if (SKIP_EXT.has(lower.slice(dot + 1))) return false;
  // foo.min.js, foo.bundle.js.map and friends
  if (/\.(min|bundle|chunk)\.(js|css|mjs)$/.test(lower)) return false;
  return true;
}

// ------------------------------------------------------------------ extraction

export interface RawSym {
  name: string;
  kind: string;
  /** 1-based line */
  line: number;
  indent: number;
  exported: boolean;
  parent?: string;
  /** Used to split chunks but not a symbol (markdown headings). */
  boundaryOnly?: boolean;
}

export interface RawImport {
  spec: string;
  line: number;
}

export interface Extracted {
  syms: RawSym[];
  imports: RawImport[];
  /** Declared namespaces or packages (C#, Java, Kotlin, PHP, C++). */
  ns: string[];
}

/** Kinds that hold other definitions (methods get them as parent). */
export const CONTAINER_KINDS = new Set(['class', 'interface', 'struct', 'trait', 'record', 'impl', 'object', 'enum', 'module', 'extension', 'protocol', 'union', 'actor', 'mixin']);

export function indentOf(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) n++;
    else if (c === 9) n += 4;
    else break;
  }
  return n;
}

type Push = (name: string, kind: string, i: number, line: string, exported: boolean, parent?: string) => void;

// JavaScript / TypeScript
const JS_FROM = /^(?:import|export|\})[^'"`]*?\bfrom\s*['"]([^'"\n]+)['"]/;
const JS_SIDE = /^import\s*['"]([^'"\n]+)['"]/;
const JS_REQUIRE = /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const JS_FUNC = /^\s*(export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const JS_CLASS = /^\s*(export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const JS_IFACE = /^\s*(export\s+(?:default\s+)?)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/;
const JS_TYPE = /^\s*(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>\s*)?=/;
const JS_ENUM = /^\s*(export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/;
const JS_NS = /^\s*(export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$.]*)\s*\{/;
const JS_ARROW = /^\s*(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{1,200})?=\s*(?:async\s+)?(?:function\b|(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]{1,100})?=>)/;
const JS_VAR = /^(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
const JS_METHOD = /^\s+(?:(?:public|private|protected|static|async|readonly|override|abstract|declare|get|set)\s+)*\*?(#?[A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?::\s*[^={;]+?)?\s*\{(?:.*\})?\s*$/;
const JS_PROP_ARROW = /^\s+(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?::[^=]{1,100})?=\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]{1,100})?=>/;
const JS_EXPORTS = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(.*)$/;
const JS_EXPORT_LIST = /^\s*export\s*\{([^}]*)\}/;
const JS_MODULE_EXPORTS = /^\s*module\.exports\s*=\s*(?:\{([^}]*)\}?|([A-Za-z_$][\w$]*)\s*;?\s*$)/;
const JS_NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'else', 'do', 'try', 'finally', 'typeof', 'new', 'await', 'yield', 'delete', 'void', 'in', 'of', 'instanceof', 'super', 'this', 'import', 'export', 'case', 'throw']);

function extractJs(lines: string[], out: Extracted, push: Push): void {
  const exportedNames = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    const t = line.trimStart();
    if (!t) continue;
    const c0 = t.charCodeAt(0);
    if (c0 === 47 || c0 === 42) continue; // comment lines
    if (c0 === 105 || c0 === 101 || c0 === 125) {
      // import / export / } from '...'
      const m = JS_FROM.exec(t) ?? JS_SIDE.exec(t);
      if (m) out.imports.push({ spec: m[1]!, line: i + 1 });
    }
    if (t.includes('require') || t.includes('import(')) {
      JS_REQUIRE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = JS_REQUIRE.exec(t))) out.imports.push({ spec: m[1]!, line: i + 1 });
    }
    const top = t.length === line.length;
    let m: RegExpExecArray | null;
    if (t.includes('function') && (m = JS_FUNC.exec(line))) push(m[2]!, 'function', i, line, !!m[1]);
    else if (t.includes('class ') && (m = JS_CLASS.exec(line))) push(m[2]!, 'class', i, line, !!m[1]);
    else if (t.includes('interface ') && (m = JS_IFACE.exec(line))) push(m[2]!, 'interface', i, line, !!m[1]);
    else if (t.includes('type ') && (m = JS_TYPE.exec(line))) push(m[2]!, 'type', i, line, !!m[1]);
    else if (t.includes('enum ') && (m = JS_ENUM.exec(line))) push(m[2]!, 'enum', i, line, !!m[1]);
    else if ((t.includes('namespace ') || t.includes('module ')) && (m = JS_NS.exec(line))) push(m[2]!, 'namespace', i, line, !!m[1]);
    else if ((t.includes('=>') || t.includes('function')) && (m = JS_ARROW.exec(line))) push(m[2]!, 'function', i, line, !!m[1]);
    else if (top && (m = JS_VAR.exec(line))) push(m[2]!, 'variable', i, line, !!m[1]);
    else if (top && (m = JS_EXPORTS.exec(line))) push(m[1]!, /^(async\s+)?(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(m[2]!) ? 'function' : 'variable', i, line, true);
    else if (!top && (line.endsWith('{') || line.endsWith('}')) && (m = JS_METHOD.exec(line)) && !JS_NOT_METHOD.has(m[1]!)) push(m[1]!, 'method', i, line, false);
    else if (!top && t.includes('=>') && (m = JS_PROP_ARROW.exec(line)) && !JS_NOT_METHOD.has(m[1]!)) push(m[1]!, 'method', i, line, false);
    if (top && c0 === 101 && (m = JS_EXPORT_LIST.exec(line))) {
      for (const part of m[1]!.split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]!.trim();
        if (name) exportedNames.add(name);
      }
    } else if (top && c0 === 109 && (m = JS_MODULE_EXPORTS.exec(line))) {
      if (m[2]) exportedNames.add(m[2]);
      for (const part of (m[1] ?? '').split(',')) {
        const name = part.trim().split(/\s*:\s*/).pop()!.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) exportedNames.add(name);
      }
    }
  }
  if (exportedNames.size) for (const s of out.syms) if (s.indent === 0 && exportedNames.has(s.name)) s.exported = true;
}

// Python
const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const PY_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)/;
const PY_ASSIGN = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/;
const PY_IMPORT = /^\s*import\s+(.+)$/;
const PY_FROM = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$/;

function extractPy(lines: string[], out: Extracted, push: Push): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    const t = line.trimStart();
    if (!t || t.charCodeAt(0) === 35) continue;
    const top = t.length === line.length;
    let m: RegExpExecArray | null;
    if (t.startsWith('def ') || t.startsWith('async ')) {
      if ((m = PY_DEF.exec(line))) push(m[2]!, 'function', i, line, top && !m[2]!.startsWith('_'));
    } else if (t.startsWith('class ')) {
      if ((m = PY_CLASS.exec(line))) push(m[2]!, 'class', i, line, top && !m[2]!.startsWith('_'));
    } else if (t.startsWith('import ')) {
      if ((m = PY_IMPORT.exec(line))) {
        for (const part of m[1]!.split(',')) {
          const mod = part.trim().split(/\s+/)[0];
          if (mod && /^[\w.]+$/.test(mod)) out.imports.push({ spec: mod, line: i + 1 });
        }
      }
    } else if (t.startsWith('from ')) {
      if ((m = PY_FROM.exec(line))) {
        const mod = m[1]!;
        if (/^\.+$/.test(mod)) {
          // from . import a, b: each name may be a sibling module
          for (const part of m[2]!.replace(/[()\\]/g, '').split(',')) {
            const name = part.trim().split(/\s+/)[0];
            if (name && /^\w+$/.test(name)) out.imports.push({ spec: mod + name, line: i + 1 });
          }
        } else out.imports.push({ spec: mod, line: i + 1 });
      }
    } else if (top && (m = PY_ASSIGN.exec(line))) {
      const name = m[1]!;
      if (!name.startsWith('__')) push(name, /^[A-Z][A-Z0-9_]*$/.test(name) ? 'constant' : 'variable', i, line, !name.startsWith('_'));
    }
  }
}

// C#
const CS_TYPE = /^\s*(?:\[[^\]]*\]\s*)*((?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|unsafe|new|file|ref)\s+)*)(class|struct|interface|enum|record(?:\s+(?:class|struct))?|delegate\s+[\w<>[\],.?]+)\s+([A-Za-z_]\w*)/;
const CS_NS = /^\s*namespace\s+([A-Za-z_][\w.]*)/;
const CS_USING = /^\s*(?:global\s+)?using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_][\w.]*)\s*;/;
const CS_MEMBER = /^\s*(?:\[[^\]]*\]\s*)*((?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|new|partial|readonly|const|volatile|event|required)\s+)*)([A-Za-z_][\w.]*(?:<[^()]*?>)?(?:\[\s*,*\s*\])*\??)\s+([A-Za-z_]\w*)\s*(?:<[^()]*?>)?\s*(\(|\{|=>|=|;)/;
const CS_NOT_TYPE = new Set(['return', 'new', 'await', 'throw', 'else', 'case', 'goto', 'yield', 'using', 'var', 'in', 'is', 'as', 'out', 'ref', 'params', 'this', 'base', 'typeof', 'sizeof', 'nameof', 'default', 'lock', 'fixed', 'when', 'where', 'select', 'from', 'let', 'if', 'while', 'for', 'foreach', 'switch', 'catch', 'do', 'try', 'finally', 'checked', 'unchecked', 'get', 'set', 'init', 'add', 'remove', 'operator', 'implicit', 'explicit', 'not', 'and', 'or', 'with', 'on', 'equals', 'by', 'into', 'orderby', 'group', 'join', 'ascending', 'descending']);

function extractCs(lines: string[], out: Extracted, push: Push): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    const t = line.trimStart();
    if (!t) continue;
    const c0 = t.charCodeAt(0);
    if (c0 === 47 || c0 === 42 || c0 === 35 || c0 === 125 || c0 === 123) continue; // comments, #region, braces
    let m: RegExpExecArray | null;
    if (t.startsWith('using ') || t.startsWith('global using')) {
      if ((m = CS_USING.exec(line))) out.imports.push({ spec: m[1]!, line: i + 1 });
      continue;
    }
    if (t.startsWith('namespace ')) {
      if ((m = CS_NS.exec(line))) {
        out.ns.push(m[1]!);
        push(m[1]!, 'namespace', i, line, true);
      }
      continue;
    }
    if ((m = CS_TYPE.exec(line))) {
      const kind = m[2]!.startsWith('delegate') ? 'delegate' : m[2]!.replace(/\s+(class|struct)$/, '');
      push(m[3]!, kind, i, line, /\b(public|internal)\b/.test(m[1]!) || !/\b(private|protected)\b/.test(m[1]!));
      continue;
    }
    if ((m = CS_MEMBER.exec(line))) {
      const mods = m[1]!;
      const type = m[2]!;
      const next = m[4]!;
      if (CS_NOT_TYPE.has(type) || CS_NOT_TYPE.has(m[3]!)) continue;
      const exported = /\bpublic\b/.test(mods);
      if (next === '(') push(m[3]!, 'method', i, line, exported);
      else if (next === '{' || next === '=>') push(m[3]!, 'property', i, line, exported);
      else if (mods) push(m[3]!, /\bconst\b/.test(mods) ? 'constant' : 'field', i, line, exported);
    }
  }
}

// Java and Kotlin
const JAVA_TYPE = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*((?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*)(class|interface|enum|record|@interface)\s+([A-Za-z_]\w*)/;
const JAVA_MEMBER = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*((?:(?:public|private|protected|static|final|abstract|synchronized|native|default|transient|volatile|strictfp)\s+)*)(?:<[^()]*?>\s+)?([A-Za-z_][\w.]*(?:<[^()]*?>)?(?:\[\])*)\s+([A-Za-z_]\w*)\s*(\(|=|;)/;
const JAVA_PKG = /^\s*package\s+([\w.]+)\s*;?/;
const JAVA_IMPORT = /^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?(?:\s+as\s+\w+)?\s*;?\s*$/;
const JAVA_NOT_TYPE = new Set(['return', 'new', 'throw', 'else', 'case', 'yield', 'var', 'if', 'while', 'for', 'switch', 'catch', 'do', 'try', 'finally', 'assert', 'break', 'continue', 'this', 'super', 'package', 'import', 'instanceof']);
const KT_MODS = '(?:(?:public|private|protected|internal|open|abstract|override|suspend|inline|operator|infix|tailrec|external|actual|expect|final|sealed|data|enum|value|annotation|inner|const|lateinit)\\s+)*';
const KT_FUN = new RegExp(`^\\s*(${KT_MODS})fun\\s+(?:<[^>]*>\\s*)?(?:[\\w.<>?]+\\.)?([A-Za-z_]\\w*)\\s*\\(`);
const KT_CLASS = new RegExp(`^\\s*(${KT_MODS}(?:fun\\s+)?)(class|interface|object)\\s+([A-Za-z_]\\w*)`);
const KT_PROP = new RegExp(`^(${KT_MODS})(val|var)\\s+([A-Za-z_]\\w*)`);

function extractJava(lines: string[], out: Extracted, push: Push, kotlin: boolean): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    const t = line.trimStart();
    if (!t) continue;
    const c0 = t.charCodeAt(0);
    if (c0 === 47 || c0 === 42 || c0 === 125) continue;
    let m: RegExpExecArray | null;
    if (t.startsWith('package ')) {
      if ((m = JAVA_PKG.exec(line))) out.ns.push(m[1]!);
      continue;
    }
    if (t.startsWith('import ')) {
      if ((m = JAVA_IMPORT.exec(line))) out.imports.push({ spec: m[1]!, line: i + 1 });
      continue;
    }
    if (kotlin) {
      const top = t.length === line.length;
      if (t.includes('fun ') && (m = KT_FUN.exec(line))) push(m[2]!, 'function', i, line, !/\b(private|internal)\b/.test(m[1]!));
      else if ((m = KT_CLASS.exec(line))) push(m[3]!, m[2]!, i, line, !/\b(private|internal)\b/.test(m[1]!));
      else if (top && (m = KT_PROP.exec(line))) push(m[3]!, 'variable', i, line, !/\b(private|internal)\b/.test(m[1]!));
      continue;
    }
    if ((m = JAVA_TYPE.exec(line))) {
      push(m[3]!, m[2] === '@interface' ? 'interface' : m[2]!, i, line, !/\bprivate\b/.test(m[1]!));
      continue;
    }
    if ((m = JAVA_MEMBER.exec(line))) {
      if (JAVA_NOT_TYPE.has(m[2]!) || JAVA_NOT_TYPE.has(m[3]!)) continue;
      const exported = /\bpublic\b/.test(m[1]!);
      if (m[4] === '(') push(m[3]!, 'method', i, line, exported);
      else if (m[1]) push(m[3]!, /\bstatic\b/.test(m[1]) && /\bfinal\b/.test(m[1]) ? 'constant' : 'field', i, line, exported);
    }
  }
}

// Go
const GO_FUNC = /^func\s+(?:\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)/;
const GO_TYPE = /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*=?\s*(struct|interface)?/;
const GO_VAR = /^(const|var)\s+([A-Za-z_]\w*)/;
const GO_BLOCK = /^(const|var|type|import)\s*\(\s*$/;
const GO_BLOCK_ITEM = /^\s+([A-Za-z_]\w*)\b/;
const GO_IMPORT = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/;
const GO_IMPORT_ITEM = /^\s*(?:[\w.]+\s+)?"([^"]+)"/;
const GO_PKG = /^package\s+(\w+)/;

function extractGo(lines: string[], out: Extracted, push: Push): void {
  let block: string | null = null;
  const upper = (s: string) => s.charCodeAt(0) >= 65 && s.charCodeAt(0) <= 90;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    let m: RegExpExecArray | null;
    if (block) {
      if (/^\)/.test(line)) {
        block = null;
        continue;
      }
      if (block === 'import') {
        if ((m = GO_IMPORT_ITEM.exec(line))) out.imports.push({ spec: m[1]!, line: i + 1 });
      } else if (indentOf(line) <= 4 && (m = GO_BLOCK_ITEM.exec(line)) && !line.trimStart().startsWith('//')) {
        push(m[1]!, block === 'type' ? 'type' : block === 'const' ? 'constant' : 'variable', i, line, upper(m[1]!));
      }
      continue;
    }
    if (!line || line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9) continue;
    if ((m = GO_BLOCK.exec(line))) block = m[1]!;
    else if ((m = GO_FUNC.exec(line))) push(m[2]!, m[1] ? 'method' : 'function', i, line, upper(m[2]!), m[1]);
    else if ((m = GO_TYPE.exec(line))) push(m[1]!, m[2] ?? 'type', i, line, upper(m[1]!));
    else if ((m = GO_VAR.exec(line))) push(m[2]!, m[1] === 'const' ? 'constant' : 'variable', i, line, upper(m[2]!));
    else if ((m = GO_IMPORT.exec(line))) out.imports.push({ spec: m[1]!, line: i + 1 });
    else if ((m = GO_PKG.exec(line))) out.ns.push(m[1]!);
  }
}

// Rust
const RS_VIS = '(pub(?:\\s*\\([^)]*\\))?\\s+)?';
const RS_FN = new RegExp(`^\\s*${RS_VIS}(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+([A-Za-z_]\\w*)`);
const RS_ITEM = new RegExp(`^\\s*${RS_VIS}(?:unsafe\\s+)?(struct|enum|trait|union|type|mod)\\s+([A-Za-z_]\\w*)`);
const RS_CONST = new RegExp(`^\\s*${RS_VIS}(const|static)\\s+(?:mut\\s+)?([A-Za-z_]\\w*)\\s*:`);
const RS_IMPL = /^\s*(?:unsafe\s+)?impl(?:\s*<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?(?:[\w]+::)*([A-Za-z_]\w*)/;
const RS_MACRO = /^\s*macro_rules!\s*([A-Za-z_]\w*)/;
const RS_USE = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\s+(?:::)?([\w:]+)/;
const RS_EXTERN = /^\s*extern\s+crate\s+(\w+)/;

function extractRust(lines: string[], out: Extracted, push: Push): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    const t = line.trimStart();
    if (!t || t.startsWith('//')) continue;
    let m: RegExpExecArray | null;
    if (t.includes('fn ') && (m = RS_FN.exec(line))) push(m[2]!, 'function', i, line, !!m[1]);
    else if ((m = RS_ITEM.exec(line))) push(m[3]!, m[2]!, i, line, !!m[1]);
    else if ((m = RS_CONST.exec(line))) push(m[3]!, 'constant', i, line, !!m[1]);
    else if (t.startsWith('impl') || t.startsWith('unsafe impl')) {
      if ((m = RS_IMPL.exec(line))) push(m[1]!, 'impl', i, line, false);
    } else if ((m = RS_MACRO.exec(line))) push(m[1]!, 'macro', i, line, true);
    else if ((m = RS_USE.exec(line))) out.imports.push({ spec: m[1]!.replace(/::$/, ''), line: i + 1 });
    else if ((m = RS_EXTERN.exec(line))) out.imports.push({ spec: m[1]!, line: i + 1 });
  }
}

// C, C++, Objective-C
const C_TYPE = /^\s*(?:template\s*<.*>\s*)?(?:typedef\s+)?(class|struct|union|enum(?:\s+class|\s+struct)?)\s+(?:(?:[A-Z_][A-Z0-9_]*|alignas\([^)]*\)|__declspec\([^)]*\)|\[\[[^\]]*\]\])\s+)*([A-Za-z_]\w*)\s*(?:final\s*)?(?:[:{]|$)/;
const C_TYPEDEF = /^\s*typedef\s+[^;()]*?\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;\s*$/;
const C_TYPEDEF_FN = /^\s*typedef\s+[^;(]*\(\s*\*\s*([A-Za-z_]\w*)\s*\)/;
const C_TYPEDEF_CLOSE = /^\}\s*([A-Za-z_]\w*)\s*;/;
const C_TYPEDEF_INLINE = /\}\s*([A-Za-z_]\w*)\s*;\s*$/;
const C_USING = /^\s*using\s+([A-Za-z_]\w*)\s*=/;
const C_DEFINE = /^\s*#\s*define\s+([A-Za-z_]\w*)/;
const C_NS = /^\s*namespace\s+([A-Za-z_][\w:]*)\s*(?:\{|$)/;
const C_FUNC = /^\s*((?:template\s*<[^>]*>\s*)?(?:[A-Za-z_][\w:]*(?:\s*<[^;(){}]*>)?[\s*&]+)+)(~?[A-Za-z_]\w*(?:::~?[A-Za-z_]\w*)*)\s*\(/;
const C_CTOR = /^\s*([A-Za-z_]\w*)::(~?[A-Za-z_]\w*)\s*\(/;
const C_INCLUDE = /^\s*#\s*(?:include|import)\s*([<"])([^>"]+)[>"]/;
const C_NOT_TYPE = new Set(['return', 'else', 'new', 'delete', 'case', 'goto', 'throw', 'co_return', 'co_await', 'co_yield', 'typedef', 'using', 'sizeof', 'if', 'while', 'for', 'switch', 'do']);
const C_NOT_NAME = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'catch', 'defined', 'alignof', 'decltype', 'static_assert', 'typeof', 'operator', '__attribute__', '__declspec']);
const C_SIG_END = /(?:[{})]|\bconst|\boverride|\bfinal|\bnoexcept|\bnoexcept\([^)]*\))\s*$/;

function extractC(lines: string[], out: Extracted, push: Push): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    const t = line.trimStart();
    if (!t) continue;
    const c0 = t.charCodeAt(0);
    if (c0 === 47 || c0 === 42) continue;
    let m: RegExpExecArray | null;
    if (c0 === 35) {
      if ((m = C_INCLUDE.exec(line))) out.imports.push({ spec: (m[1] === '<' ? '<' : '') + m[2]!, line: i + 1 });
      else if ((m = C_DEFINE.exec(line))) push(m[1]!, 'macro', i, line, true);
      continue;
    }
    const top = t.length === line.length;
    if (t.startsWith('namespace ') || t === 'namespace') {
      if ((m = C_NS.exec(line))) {
        out.ns.push(m[1]!);
        push(m[1]!.split('::').pop()!, 'namespace', i, line, true);
      }
      continue;
    }
    if ((m = C_TYPE.exec(line))) {
      push(m[2]!, m[1]!.split(/\s+/)[0]!, i, line, true);
      continue;
    }
    if (t.startsWith('typedef')) {
      if ((m = C_TYPEDEF_FN.exec(line) ?? C_TYPEDEF.exec(line) ?? (t.includes('{') ? C_TYPEDEF_INLINE.exec(line) : null))) push(m[1]!, 'typedef', i, line, true);
      continue;
    }
    if (c0 === 125) {
      if (top && (m = C_TYPEDEF_CLOSE.exec(line))) push(m[1]!, 'typedef', i, line, true);
      continue;
    }
    if (t.startsWith('using ')) {
      if ((m = C_USING.exec(line))) push(m[1]!, 'type', i, line, true);
      continue;
    }
    const trimmed = line.trimEnd();
    if (trimmed.endsWith(';')) continue; // prototypes, calls and declarations
    if (!top && !C_SIG_END.test(trimmed)) continue; // inside bodies only accept complete signatures
    if ((m = C_FUNC.exec(line))) {
      const typePart = m[1]!.trim();
      const first = typePart.split(/[\s*&<]+/)[0]!;
      if (C_NOT_TYPE.has(first) || typePart.includes('<<') || typePart.includes('>>')) continue;
      const full = m[2]!;
      const parts = full.split('::');
      const name = parts.pop()!;
      if (C_NOT_NAME.has(name)) continue;
      push(name, parts.length ? 'method' : 'function', i, line, !/\bstatic\b/.test(typePart), parts.length ? parts[parts.length - 1] : undefined);
    } else if ((m = C_CTOR.exec(line))) {
      if (!C_NOT_NAME.has(m[2]!)) push(m[2]!, 'method', i, line, true, m[1]);
    }
  }
}

// PHP
const PHP_FUNC = /^\s*((?:(?:abstract|final|public|private|protected|static|readonly)\s+)*)function\s+&?\s*([A-Za-z_]\w*)\s*\(/;
const PHP_CLASS = /^\s*((?:(?:abstract|final|readonly)\s+)*)(class|interface|trait|enum)\s+([A-Za-z_]\w*)/;
const PHP_NS = /^\s*namespace\s+([\w\\]+)\s*[;{]/;
const PHP_CONST = /^\s*((?:(?:public|private|protected|final)\s+)*)const\s+([A-Za-z_]\w*)\s*=/;
const PHP_USE = /^\s*use\s+(?:function\s+|const\s+)?\\?([\w\\]+)/;
const PHP_REQUIRE = /\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/;

function extractPhp(lines: string[], out: Extracted, push: Push): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    const t = line.trimStart();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('#')) continue;
    let m: RegExpExecArray | null;
    if (t.includes('function') && (m = PHP_FUNC.exec(line))) push(m[2]!, line.length - t.length > 0 ? 'method' : 'function', i, line, !/\b(private|protected)\b/.test(m[1]!));
    else if ((m = PHP_CLASS.exec(line))) push(m[3]!, m[2]!, i, line, true);
    else if ((m = PHP_NS.exec(line))) out.ns.push(m[1]!);
    else if ((m = PHP_CONST.exec(line))) push(m[2]!, 'constant', i, line, !/\bprivate\b/.test(m[1]!));
    else if (t.startsWith('use ') && line.length === t.length && (m = PHP_USE.exec(line))) out.imports.push({ spec: m[1]!, line: i + 1 });
    if ((t.includes('require') || t.includes('include')) && (m = PHP_REQUIRE.exec(line))) out.imports.push({ spec: './' + m[1]!.replace(/^\/+/, ''), line: i + 1 });
  }
}

// Ruby
const RB_DEF = /^\s*def\s+(self\.)?([A-Za-z_]\w*[?!=]?)/;
const RB_CLASS = /^\s*(class|module)\s+((?:[A-Z]\w*::)*[A-Z]\w*)/;
const RB_CONST = /^\s*([A-Z][A-Z0-9_]*)\s*=[^=~]/;
const RB_REQ = /^\s*require(_relative)?\s*\(?\s*['"]([^'"]+)['"]/;

function extractRuby(lines: string[], out: Extracted, push: Push): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    const t = line.trimStart();
    if (!t || t.charCodeAt(0) === 35) continue;
    let m: RegExpExecArray | null;
    if ((m = RB_DEF.exec(line))) push(m[2]!, 'method', i, line, true);
    else if ((m = RB_CLASS.exec(line))) push(m[2]!.split('::').pop()!, m[1]!, i, line, true);
    else if ((m = RB_CONST.exec(line))) push(m[1]!, 'constant', i, line, true);
    else if ((m = RB_REQ.exec(line))) out.imports.push({ spec: (m[1] ? './' : '') + m[2]!, line: i + 1 });
  }
}

// Lua
const LUA_FUNC = /^\s*(local\s+)?function\s+([\w.:]+)\s*\(/;
const LUA_ASSIGN = /^\s*(local\s+)?([\w.:]+)\s*=\s*function\b/;
const LUA_REQ = /\brequire\s*\(?\s*['"]([^'"]+)['"]/;

function extractLua(lines: string[], out: Extracted, push: Push): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    const t = line.trimStart();
    if (!t || t.startsWith('--')) continue;
    const m = LUA_FUNC.exec(line) ?? LUA_ASSIGN.exec(line);
    if (m) {
      const parts = m[2]!.split(/[.:]/);
      const name = parts.pop()!;
      push(name, parts.length ? 'method' : 'function', i, line, !m[1], parts.length ? parts.join('.') : undefined);
    }
    const r = t.includes('require') ? LUA_REQ.exec(line) : null;
    if (r) out.imports.push({ spec: r[1]!, line: i + 1 });
  }
}

// GDScript (Godot)
const GD_FUNC = /^\s*(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/;
const GD_CLASS_NAME = /^class_name\s+([A-Za-z_]\w*)/;
const GD_CLASS = /^\s*class\s+([A-Za-z_]\w*)/;
const GD_SIGNAL = /^\s*signal\s+([A-Za-z_]\w*)/;
const GD_VAR = /^(?:@\w+(?:\([^)]*\))?\s+)*(var|const)\s+([A-Za-z_]\w*)/;
const GD_ENUM = /^enum\s+([A-Za-z_]\w*)/;
const GD_LOAD = /\b(?:preload|load)\s*\(\s*["'](res:\/\/[^"']+)["']/g;
const GD_EXTENDS = /^extends\s+["'](res:\/\/[^"']+)["']/;

function extractGd(lines: string[], out: Extracted, push: Push): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    const t = line.trimStart();
    if (!t || t.charCodeAt(0) === 35) continue;
    let m: RegExpExecArray | null;
    if ((m = GD_FUNC.exec(line))) push(m[1]!, 'function', i, line, true);
    else if ((m = GD_CLASS_NAME.exec(line))) push(m[1]!, 'class', i, line, true);
    else if ((m = GD_CLASS.exec(line))) push(m[1]!, 'class', i, line, true);
    else if ((m = GD_SIGNAL.exec(line))) push(m[1]!, 'signal', i, line, true);
    else if ((m = GD_ENUM.exec(line))) push(m[1]!, 'enum', i, line, true);
    else if (t.length === line.length && (m = GD_VAR.exec(line))) push(m[2]!, m[1] === 'const' ? 'constant' : 'variable', i, line, true);
    else if ((m = GD_EXTENDS.exec(line))) out.imports.push({ spec: m[1]!, line: i + 1 });
    if (t.includes('load')) {
      GD_LOAD.lastIndex = 0;
      while ((m = GD_LOAD.exec(line))) out.imports.push({ spec: m[1]!, line: i + 1 });
    }
  }
}

// Swift
const SW_MODS = '((?:(?:public|private|fileprivate|internal|open|static|class|final|override|mutating|nonmutating|convenience|required|lazy|weak|unowned|dynamic|indirect|@\\w+(?:\\([^)]*\\))?)\\s+)*)';
const SW_FUNC = new RegExp(`^\\s*${SW_MODS}func\\s+([A-Za-z_]\\w*)`);
const SW_TYPE = new RegExp(`^\\s*${SW_MODS}(class|struct|enum|protocol|extension|actor)\\s+([A-Za-z_][\\w.]*)`);
const SW_VAR = new RegExp(`^${SW_MODS}(let|var)\\s+([A-Za-z_]\\w*)`);
const SW_IMPORT = /^\s*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([\w.]+)/;

function extractSwift(lines: string[], out: Extracted, push: Push): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    const t = line.trimStart();
    if (!t || t.startsWith('//')) continue;
    let m: RegExpExecArray | null;
    if (t.includes('func ') && (m = SW_FUNC.exec(line))) push(m[2]!, 'function', i, line, !/\b(private|fileprivate)\b/.test(m[1]!));
    else if ((m = SW_TYPE.exec(line))) push(m[3]!.split('.').pop()!, m[2]!, i, line, !/\b(private|fileprivate)\b/.test(m[1]!));
    else if (t.length === line.length && (m = SW_VAR.exec(line))) push(m[3]!, 'variable', i, line, !/\b(private|fileprivate)\b/.test(m[1]!));
    else if ((m = SW_IMPORT.exec(line))) out.imports.push({ spec: m[1]!, line: i + 1 });
  }
}

// Dart
const DART_CLASS = /^\s*((?:(?:abstract|sealed|base|final|interface|mixin)\s+)*)(class|mixin|enum|extension(?:\s+type)?)\s+([A-Za-z_]\w*)/;
const DART_FUNC = /^\s*(?:(?:static|external|abstract)\s+)*(?:[A-Za-z_][\w<>?,. ]*?\s+)?([A-Za-z_]\w*)\s*(?:<[^>()]*>)?\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?:async\*?|sync\*)?\s*(?:\{|=>)/;
const DART_TYPEDEF = /^typedef\s+([A-Za-z_]\w*)/;
const DART_IMPORT = /^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/;
const DART_NOT = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'new', 'await', 'throw', 'assert', 'super', 'this', 'do', 'try']);

function extractDart(lines: string[], out: Extracted, push: Push): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    const t = line.trimStart();
    if (!t || t.startsWith('//')) continue;
    let m: RegExpExecArray | null;
    if ((m = DART_IMPORT.exec(line))) out.imports.push({ spec: m[1]!, line: i + 1 });
    else if ((m = DART_CLASS.exec(line))) push(m[3]!, m[2]!.split(/\s+/)[0]!, i, line, !m[3]!.startsWith('_'));
    else if ((m = DART_TYPEDEF.exec(line))) push(m[1]!, 'type', i, line, !m[1]!.startsWith('_'));
    else if ((m = DART_FUNC.exec(line)) && !DART_NOT.has(m[1]!)) push(m[1]!, 'function', i, line, !m[1]!.startsWith('_'));
  }
}

// Markdown headings split documents into sections.
const MD_HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;

function extractMd(lines: string[], out: Extracted): void {
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('```') || line.startsWith('~~~')) fence = !fence;
    if (fence) continue;
    const m = MD_HEADING.exec(line);
    if (m) out.syms.push({ name: m[2]!.slice(0, 120), kind: 'section', line: i + 1, indent: m[1]!.length - 1, exported: false, boundaryOnly: true });
  }
}

/** Finds definitions, imports and declared namespaces in a file. */
export function extract(family: Family | undefined, lines: string[]): Extracted {
  const out: Extracted = { syms: [], imports: [], ns: [] };
  if (!family) return out;
  const push: Push = (name, kind, i, line, exported, parent) => {
    out.syms.push({ name, kind, line: i + 1, indent: indentOf(line), exported, parent });
  };
  switch (family) {
    case 'js':
      extractJs(lines, out, push);
      break;
    case 'py':
      extractPy(lines, out, push);
      break;
    case 'cs':
      extractCs(lines, out, push);
      break;
    case 'java':
      extractJava(lines, out, push, false);
      break;
    case 'kotlin':
      extractJava(lines, out, push, true);
      break;
    case 'go':
      extractGo(lines, out, push);
      break;
    case 'rust':
      extractRust(lines, out, push);
      break;
    case 'c':
      extractC(lines, out, push);
      break;
    case 'php':
      extractPhp(lines, out, push);
      break;
    case 'ruby':
      extractRuby(lines, out, push);
      break;
    case 'lua':
      extractLua(lines, out, push);
      break;
    case 'gd':
      extractGd(lines, out, push);
      break;
    case 'swift':
      extractSwift(lines, out, push);
      break;
    case 'dart':
      extractDart(lines, out, push);
      break;
    case 'md':
      extractMd(lines, out);
      break;
  }
  assignParents(out.syms);
  return out;
}

/**
 * Methods get the nearest enclosing class-like definition (by indentation) as parent, and
 * functions inside one become methods. Explicit parents (Go receivers, C++ Foo::bar) are kept.
 */
function assignParents(syms: RawSym[]): void {
  const stack: RawSym[] = [];
  for (const s of syms) {
    if (s.boundaryOnly) continue;
    while (stack.length && stack[stack.length - 1]!.indent >= s.indent) stack.pop();
    if (!s.parent) {
      for (let k = stack.length - 1; k >= 0; k--) {
        const p = stack[k]!;
        if (CONTAINER_KINDS.has(p.kind)) {
          s.parent = p.name;
          break;
        }
        if (p.kind !== 'namespace') break;
      }
      if (s.parent && s.kind === 'function') s.kind = 'method';
    }
    stack.push(s);
  }
}

/** Whether a definition sits at file level (not inside a class or function). */
export function isTopLevel(syms: RawSym[], index: number): boolean {
  const s = syms[index]!;
  if (s.parent) return false;
  for (let k = index - 1; k >= 0; k--) {
    const p = syms[k]!;
    if (p.boundaryOnly) continue;
    if (p.indent < s.indent) return p.kind === 'namespace';
  }
  return true;
}
