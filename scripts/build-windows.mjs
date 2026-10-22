// Builds the Windows downloads:
//   release/FreeCode-Setup-<version>.exe        installer (desktop icon, Start menu, PATH, uninstaller)
//   release/FreeCode-<version>-win-x64.zip      portable folder (unzip and run FreeCode.exe)
// Both bundle the official Node.js runtime, so nothing else needs to be installed.
//
// Needs: makensis (NSIS 3), x86_64-w64-mingw32-g++ + windres (MinGW-w64), unzip, zip.
// On Debian/Ubuntu: sudo apt-get install nsis g++-mingw-w64-x86-64 unzip zip
// Usage: node scripts/build-windows.mjs [--node <version>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
// Node.js LTS bundled with the app. Keep it on an LTS line.
const NODE_VERSION = opt('--node', '24.22.1');
// WebView2 SDK headers for the app window (FreeCode.exe), from NuGet.
const WEBVIEW2_SDK = { version: '1.0.4258.31', sha256: '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9' };
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const [major, minor, patch] = VERSION.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);

const cacheDir = path.join(root, '.cache');
const buildDir = path.join(root, 'build', 'win');
const stage = path.join(buildDir, 'FreeCode');
const outDir = path.join(root, 'release');
const win = path.join(root, 'packaging', 'windows');

const run = (file, args, opts = {}) => execFileSync(file, args, { stdio: 'inherit', ...opts });
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const step = (msg) => console.log(`\n▸ ${msg}`);

const has = (tool) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [tool], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
for (const tool of ['makensis', 'x86_64-w64-mingw32-g++', 'x86_64-w64-mingw32-windres', 'unzip', 'zip']) {
  if (!has(tool)) {
    console.error(`Missing build tool: ${tool}\nOn Debian/Ubuntu: sudo apt-get install nsis g++-mingw-w64-x86-64 unzip zip`);
    process.exit(1);
  }
}
// The posix thread model links everything statically without surprises.
const CXX = has('x86_64-w64-mingw32-g++-posix') ? 'x86_64-w64-mingw32-g++-posix' : 'x86_64-w64-mingw32-g++';

/** Downloads `url` into the cache once and checks its SHA-256. */
async function cached(url, name, sha) {
  const file = path.join(cacheDir, name);
  if (!existsSync(file) || sha256(file) !== sha) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    if (sha256(file) !== sha) throw new Error(`Checksum mismatch for ${name}`);
  }
  return file;
}

step('Compiling FreeCode');
run('npm', ['run', 'build'], { cwd: root, shell: process.platform === 'win32' });

step(`Getting Node.js ${NODE_VERSION} for Windows`);
mkdirSync(cacheDir, { recursive: true });
const zipName = `node-v${NODE_VERSION}-win-x64.zip`;
const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
const expected = sums
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .find((p) => p[1] === zipName)?.[0];
if (!expected) throw new Error(`No checksum for ${zipName} (is ${NODE_VERSION} a real Node.js version?)`);
const zipPath = await cached(`${base}/${zipName}`, zipName, expected);
console.log(`  ${zipName} (sha256 verified)`);

step('Staging files');
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(path.join(stage, 'runtime'), { recursive: true });
mkdirSync(path.join(stage, 'app'), { recursive: true });
run('unzip', ['-q', '-j', '-o', zipPath, `node-v${NODE_VERSION}-win-x64/node.exe`, `node-v${NODE_VERSION}-win-x64/LICENSE`, '-d', path.join(stage, 'runtime')]);
const app = path.join(stage, 'app');
for (const entry of ['bin', 'web', 'assets', 'package.json', 'README.md', 'LICENSE']) {
  if (existsSync(path.join(root, entry))) cpSync(path.join(root, entry), path.join(app, entry), { recursive: true });
}
cpSync(path.join(root, 'dist', 'src'), path.join(app, 'dist', 'src'), { recursive: true, filter: (src) => !src.endsWith('.map') });
copyFileSync(path.join(win, 'freecode.cmd'), path.join(stage, 'freecode.cmd'));
copyFileSync(path.join(win, 'helper.ps1'), path.join(stage, 'helper.ps1'));
copyFileSync(path.join(root, 'assets', 'freecode.ico'), path.join(stage, 'FreeCode.ico'));

step(`Getting the WebView2 SDK ${WEBVIEW2_SDK.version}`);
const nupkg = await cached(
  `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2_SDK.version}/microsoft.web.webview2.${WEBVIEW2_SDK.version}.nupkg`,
  `microsoft.web.webview2.${WEBVIEW2_SDK.version}.nupkg`,
  WEBVIEW2_SDK.sha256,
);
const sdkDir = path.join(buildDir, 'webview2');
run('unzip', ['-q', '-o', nupkg, 'build/native/include/*', 'LICENSE.txt', '-d', sdkDir]);
// WebView2.h includes <EventToken.h>; MinGW ships it as eventtoken.h (matters on case-sensitive disks).
const shimDir = path.join(buildDir, 'shim');
mkdirSync(shimDir, { recursive: true });
writeFileSync(path.join(shimDir, 'EventToken.h'), '#include <eventtoken.h>\n');

step('Building the app window (FreeCode.exe)');
const resDir = path.join(buildDir, 'res');
mkdirSync(resDir, { recursive: true });
for (const f of ['app.rc', 'app.manifest']) copyFileSync(path.join(win, f), path.join(resDir, f));
copyFileSync(path.join(root, 'assets', 'freecode.ico'), path.join(resDir, 'freecode.ico'));
writeFileSync(path.join(resDir, 'version.h'), `#define VER_MAJOR ${major}\n#define VER_MINOR ${minor}\n#define VER_PATCH ${patch}\n#define VER_STRING "${VERSION}"\n`);
run('x86_64-w64-mingw32-windres', ['app.rc', '-O', 'coff', '-o', 'app.res'], { cwd: resDir });
run(CXX, [
  '-std=c++17', '-O2', '-s', '-static', '-mwindows',
  '-I', shimDir, '-I', path.join(win, 'vendor'), '-I', path.join(sdkDir, 'build', 'native', 'include'),
  '-o', path.join(stage, 'FreeCode.exe'),
  path.join(win, 'app.cc'), path.join(resDir, 'app.res'),
  '-ladvapi32', '-lole32', '-lshell32', '-lshlwapi', '-luser32', '-lversion', '-ldwmapi',
]);
writeFileSync(
  path.join(stage, 'THIRD_PARTY_NOTICES.txt'),
  [
    'FreeCode includes the following third-party software.',
    '',
    '== Node.js ==',
    'See runtime/LICENSE.',
    '',
    '== webview (https://github.com/webview/webview) ==',
    readFileSync(path.join(win, 'vendor', 'webview', 'LICENSE'), 'utf8').trim(),
    '',
    '== Microsoft WebView2 SDK (headers) ==',
    readFileSync(path.join(sdkDir, 'LICENSE.txt'), 'utf8').trim(),
    '',
  ].join('\n'),
);

step('Building the installer');
mkdirSync(outDir, { recursive: true });
const setup = path.join(outDir, `FreeCode-Setup-${VERSION}.exe`);
const portable = path.join(outDir, `FreeCode-${VERSION}-win-x64.zip`);
rmSync(setup, { force: true });
rmSync(portable, { force: true });
run('makensis', [
  '-V2',
  `-DVERSION=${VERSION}`,
  `-DVERSION_QUAD=${major}.${minor}.${patch}.0`,
  `-DSTAGE=${stage}`,
  `-DHELPER=${path.join(win, 'helper.ps1')}`,
  `-DOUTFILE=${setup}`,
  path.join(win, 'installer.nsi'),
]);

step('Building the portable zip');
run('zip', ['-q', '-r', '-9', portable, 'FreeCode'], { cwd: buildDir });

const mb = (f) => (statSync(f).size / 1024 / 1024).toFixed(1);
console.log('\nDone:');
for (const f of [setup, portable]) console.log(`  ${path.relative(root, f)}  ${mb(f)} MB  sha256 ${sha256(f)}`);
