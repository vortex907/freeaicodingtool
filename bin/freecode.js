#!/usr/bin/env node
// FreeCode command-line entry point.
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`FreeCode needs Node.js 20 or newer (you have ${process.version}). Get it at https://nodejs.org`);
  process.exit(1);
}

let cli;
try {
  cli = await import('../dist/src/cli.js');
} catch (err) {
  if (err && err.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes('cli.js')) {
    console.error('FreeCode is not built yet. Run `npm install` (or `npm run build`) in the FreeCode folder first.');
    process.exit(1);
  }
  throw err;
}

try {
  const code = await cli.main(process.argv.slice(2));
  if (typeof code === 'number') process.exitCode = code;
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
