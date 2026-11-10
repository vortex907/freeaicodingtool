// Renders web/icon.svg into the icon files the desktop packages need:
//   assets/freecode.ico   Windows (16-64 px as bitmaps, 128/256 px as PNG)
//   assets/freecode.icns  macOS (.app bundle created by `freecode install-shortcut`)
//   assets/icon-512.png   Linux launcher icon
//   web/icon-192.png, web/icon-512.png   app window / taskbar icon
// The outputs are committed, so this only needs to run when the logo changes.
// Needs Playwright with a Chromium build: node scripts/make-icons.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = createRequire(process.env.PLAYWRIGHT_REQUIRE_FROM ?? '/opt/node22/lib/node_modules/')('playwright'));
}

const svg = readFileSync(path.join(root, 'web', 'icon.svg'), 'utf8');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 192, 256, 512];

const browser = await chromium.launch();
const page = await browser.newPage();
const rendered = await page.evaluate(
  async ({ svg, sizes }) => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(svg);
    await img.decode();
    const out = {};
    for (const s of sizes) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = s;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, s, s);
      out[s] = {
        png: canvas.toDataURL('image/png').split(',')[1],
        rgba: Array.from(ctx.getImageData(0, 0, s, s).data),
      };
    }
    return out;
  },
  { svg, sizes },
);
await browser.close();

const png = (s) => Buffer.from(rendered[s].png, 'base64');

/** A 32-bit BGRA DIB icon image (with the 1-bit AND mask), as stored inside .ico files. */
function dib(s) {
  const rgba = rendered[s].rgba;
  const maskRow = Math.ceil(s / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(s, 4);
  header.writeInt32LE(s * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(s * s * 4 + maskRow * s, 20);
  const pixels = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const src = ((s - 1 - y) * s + x) * 4; // bottom-up rows
      const dst = (y * s + x) * 4;
      pixels[dst] = rgba[src + 2];
      pixels[dst + 1] = rgba[src + 1];
      pixels[dst + 2] = rgba[src];
      pixels[dst + 3] = rgba[src + 3];
    }
  }
  const mask = Buffer.alloc(maskRow * s); // all zero: alpha channel decides transparency
  return Buffer.concat([header, pixels, mask]);
}

function ico(list) {
  const images = list.map((s) => (s >= 128 ? png(s) : dib(s)));
  const head = Buffer.alloc(6 + 16 * list.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(list.length, 4);
  let offset = head.length;
  list.forEach((s, i) => {
    const e = 6 + i * 16;
    head.writeUInt8(s >= 256 ? 0 : s, e);
    head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt8(0, e + 2);
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(images[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

function icns(entries) {
  const chunks = entries.map(([type, s]) => {
    const data = png(s);
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const body = Buffer.concat(chunks);
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'ascii');
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

mkdirSync(path.join(root, 'assets'), { recursive: true });
writeFileSync(path.join(root, 'assets', 'freecode.ico'), ico([16, 20, 24, 32, 40, 48, 64, 128, 256]));
writeFileSync(
  path.join(root, 'assets', 'freecode.icns'),
  icns([
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
  ]),
);
writeFileSync(path.join(root, 'assets', 'icon-512.png'), png(512));
writeFileSync(path.join(root, 'web', 'icon-192.png'), png(192));
writeFileSync(path.join(root, 'web', 'icon-512.png'), png(512));
console.log('icons written');
