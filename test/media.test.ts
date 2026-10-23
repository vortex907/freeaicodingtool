// Read on images and PDFs. The PDFs are written byte by byte here, one of them with a Flate stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { ReadTool } from '../src/tools/fileTools.js';
import { FileTracker } from '../src/tools/fileTracker.js';
import { imageSize, sniffImage } from '../src/tools/images.js';
import { PdfDocument, pageRangeText, parseCMap, parsePageSpec, readPdf } from '../src/tools/pdf.js';
import { toWireMessages } from '../src/providers/wire.js';
import type { ChatMessage, ModelInfo } from '../src/providers/types.js';
import type { SessionState, ToolContext, ToolResult } from '../src/tools/types.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'fc-media-'));
process.env.FREECODE_HOME = mkdtempSync(path.join(os.tmpdir(), 'fc-media-home-'));
const session = { cwd: dir, todos: [], shells: new Map(), shellCounter: 0, toolSeq: 0, permissionMode: 'default' } as never as SessionState;
const ctx = { projectRoot: dir, session, settings: { env: {} }, files: new FileTracker(false), signal: new AbortController().signal, toolCallId: 't', services: { progress: () => undefined }, depth: 0 } as never as ToolContext;

async function read(input: Record<string, unknown>): Promise<ToolResult> {
  const prep = await ReadTool.prepare(input, ctx);
  if (prep.error) return prep.error;
  return prep.execute();
}

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('Read returns a PNG as an image part with its size, and refuses big or fake images', async () => {
  writeFileSync(path.join(dir, 'dot.png'), PNG);
  const r = await read({ file_path: 'dot.png' });
  assert.equal(r.isError, undefined, r.content);
  assert.equal(r.images?.length, 1);
  assert.equal(r.images![0]!.mediaType, 'image/png');
  assert.equal(r.images![0]!.data, PNG.toString('base64'));
  assert.match(r.content, /dot\.png \(PNG, 1x1, \d+ B\)/);
  assert.match(r.content, /without vision gets only this description/);
  assert.equal(r.display?.kind, 'image');

  // The format comes from the bytes, not the name.
  writeFileSync(path.join(dir, 'really-png.jpg'), PNG);
  assert.equal((await read({ file_path: 'really-png.jpg' })).images![0]!.mediaType, 'image/png');
  writeFileSync(path.join(dir, 'no-extension'), PNG);
  assert.equal((await read({ file_path: 'no-extension' })).images?.length, 1);

  writeFileSync(path.join(dir, 'big.png'), Buffer.alloc(5 * 1024 * 1024 + 10));
  const big = await read({ file_path: 'big.png' });
  assert.equal(big.isError, true);
  assert.match(big.content, /up to 5 MB/);
  assert.equal(big.images, undefined);

  writeFileSync(path.join(dir, 'fake.png'), 'not an image at all');
  assert.match((await read({ file_path: 'fake.png' })).content, /not a valid PNG, JPEG, GIF or WebP image/);
  writeFileSync(path.join(dir, 'icon.bmp'), Buffer.from('BM'));
  assert.match((await read({ file_path: 'icon.bmp' })).content, /Read shows PNG, JPEG, GIF and WebP/);
});

test('an image from Read reaches vision models and text-only models get the note instead', async () => {
  const r = await read({ file_path: 'dot.png' });
  const history: ChatMessage[] = [
    { role: 'user', content: 'look at dot.png' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', arguments: '{"file_path":"dot.png"}' }] },
    { role: 'tool', toolCallId: 'c1', toolName: 'Read', content: r.content },
    // What the agent adds after the tool results when a result carries images.
    { role: 'user', content: 'Image from the tool call above.', images: r.images, meta: { synthetic: true, kind: 'screenshot' } },
  ];
  const wire = (vision: boolean) => toWireMessages(history, { quirks: {}, model: { id: 'm', key: 'p/m', vision } as unknown as ModelInfo, toolMode: 'native' });
  const seen = JSON.stringify(wire(true));
  assert.match(seen, /data:image\/png;base64,iVBORw0KGgo/);
  const blind = wire(false);
  assert.doesNotMatch(JSON.stringify(blind), /image_url/);
  assert.match(String(blind.find((m) => m.role === 'tool')!.content), /without vision gets only this description/);
});

test('image sizes come from the headers of each format', () => {
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([3, 0, 2, 0]), Buffer.alloc(10)]);
  assert.equal(sniffImage(gif), 'gif');
  assert.deepEqual(imageSize(gif, 'gif'), { width: 3, height: 2 });
  // JPEG: SOI, an APP0 segment, then SOF0 with height 20 and width 30.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x14, 0x00, 0x1e, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffImage(jpeg), 'jpeg');
  assert.deepEqual(imageSize(jpeg, 'jpeg'), { width: 30, height: 20 });
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X'), Buffer.alloc(8), Buffer.from([99, 0, 0, 49, 0, 0])]);
  assert.equal(sniffImage(webp), 'webp');
  assert.deepEqual(imageSize(webp, 'webp'), { width: 100, height: 50 });
  assert.equal(sniffImage(Buffer.from('hello world')), null);
});

/** Builds a PDF from object bodies (object n is bodies[n - 1]) with a correct xref table. */
function buildPdf(bodies: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let size = parts[0]!.length;
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(size);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), typeof body === 'string' ? Buffer.from(body, 'latin1') : body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk);
    size += chunk.length;
  });
  const xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

function stream(dict: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
}

const TO_UNICODE = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n2 beginbfchar <0001> <0048> <0002> <0069> endbfchar\n1 beginbfrange <0003> <0004> <00E9> endbfrange\nendcmap end end';

function textPdf(): Buffer {
  const page1 = Buffer.from('BT /F1 12 Tf 72 720 Td (Hello PDF world) Tj 0 -16 Td (Caf\\351 \\(cr\\350me\\)) Tj ET', 'latin1');
  const page2 = deflateSync(Buffer.from('BT /F1 12 Tf 14 TL 72 700 Td [(Second) -300 (page)] TJ T* <48657820737472696E67> Tj (quoted line) \' /F2 12 Tf 0 -20 Td <0001000200030004> Tj ET', 'latin1'));
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents 4 0 R >>',
    stream('', page1),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents 6 0 R >>',
    stream('/Filter /FlateDecode', page2),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /Demo /Encoding /Identity-H /DescendantFonts [9 0 R] /ToUnicode 10 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Demo /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 600 >>',
    stream('', Buffer.from(TO_UNICODE, 'latin1')),
  ]);
}

function scannedPdf(): Buffer {
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    stream('', Buffer.from('q 200 0 0 100 72 600 cm /Im1 Do Q', 'latin1')),
    stream('/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', Buffer.from([0x80])),
  ]);
}

test('the built-in PDF reader handles plain and Flate streams, TJ, hex strings, WinAnsi and ToUnicode fonts', () => {
  const doc = new PdfDocument(textPdf());
  assert.equal(doc.pageCount, 2);
  assert.equal(doc.page(1).text, 'Hello PDF world\nCaf\u00e9 (cr\u00e8me)');
  assert.equal(doc.page(2).text, 'Second page\nHex string\nquoted line\nHi\u00e9\u00ea');
  assert.equal(doc.page(1).hasImages, false);
  const scanned = new PdfDocument(scannedPdf()).page(1);
  assert.equal(scanned.text, '');
  assert.equal(scanned.hasImages, true);
});

test('the built-in PDF reader finds pages kept in a compressed object stream', () => {
  const objects: [number, string][] = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
    [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ];
  let header = '';
  let body = '';
  for (const [n, o] of objects) {
    header += `${n} ${body.length} `;
    body += `${o}\n`;
  }
  const objStm = deflateSync(Buffer.from(header + body, 'latin1'));
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.5\n4 0 obj\n'),
    stream('', Buffer.from('BT /F1 12 Tf 72 720 Td (Inside an object stream) Tj ET')),
    Buffer.from('\nendobj\n6 0 obj\n'),
    stream(`/Type /ObjStm /N 4 /First ${header.length} /Filter /FlateDecode`, objStm),
    Buffer.from('\nendobj\n7 0 obj\n'),
    stream('/Type /XRef /Size 8 /Root 1 0 R /W [1 2 1]', Buffer.alloc(0)),
    Buffer.from('\nendobj\nstartxref\n0\n%%EOF\n'),
  ]);
  const doc = new PdfDocument(pdf);
  assert.equal(doc.pageCount, 1);
  assert.equal(doc.page(1).text, 'Inside an object stream');
});

test('ToUnicode maps, page ranges and the scanned-PDF answer', async () => {
  const cmap = parseCMap(TO_UNICODE);
  assert.equal(cmap.bytes, 2);
  assert.deepEqual([...cmap.map.entries()], [[1, 'H'], [2, 'i'], [3, '\u00e9'], [4, '\u00ea']]);
  assert.deepEqual(parsePageSpec('2,4-5', 6), [2, 4, 5]);
  assert.deepEqual(parsePageSpec('5-', 6), [5, 6]);
  assert.match(String(parsePageSpec('9', 6)), /selects none/);
  assert.match(String(parsePageSpec('a-b', 6)), /Invalid pages/);
  assert.equal(pageRangeText([1, 2, 3, 5, 7, 8]), '1-3, 5, 7-8');

  const prev = process.env.FREECODE_NO_PDFTOTEXT;
  process.env.FREECODE_NO_PDFTOTEXT = '1';
  try {
    const file = path.join(dir, 'scan.pdf');
    writeFileSync(file, scannedPdf());
    const r = await readPdf(file, scannedPdf(), undefined, 40_000);
    assert.ok(typeof r !== 'string');
    assert.equal(r.noText, 'scanned');
    assert.equal(r.via, 'builtin');
    const tool = await read({ file_path: 'scan.pdf' });
    assert.match(tool.content, /scanned images without a text layer/);
  } finally {
    if (prev === undefined) delete process.env.FREECODE_NO_PDFTOTEXT;
    else process.env.FREECODE_NO_PDFTOTEXT = prev;
  }
});

test('Read returns PDF text page by page with the built-in reader and with pdftotext when installed', async () => {
  writeFileSync(path.join(dir, 'doc.pdf'), textPdf());
  const prev = process.env.FREECODE_NO_PDFTOTEXT;
  try {
    for (const builtinOnly of [true, false]) {
      if (builtinOnly) process.env.FREECODE_NO_PDFTOTEXT = '1';
      else delete process.env.FREECODE_NO_PDFTOTEXT;
      const all = await read({ file_path: 'doc.pdf' });
      assert.equal(all.isError, undefined, all.content);
      assert.match(all.content, /^PDF doc\.pdf, 2 pages:/);
      assert.match(all.content, /--- Page 1 ---\nHello PDF world/);
      assert.match(all.content, /--- Page 2 ---\n/);
      const second = await read({ file_path: 'doc.pdf', pages: '2' });
      assert.doesNotMatch(second.content, /Hello PDF world/);
      assert.match(second.content, /Hex string/);
      assert.match((await read({ file_path: 'doc.pdf', pages: '3' })).content, /has 2 pages/);
    }
  } finally {
    if (prev === undefined) delete process.env.FREECODE_NO_PDFTOTEXT;
    else process.env.FREECODE_NO_PDFTOTEXT = prev;
  }
});

test('a PDF read stops at the size limit and says which pages to read next', async () => {
  const kids: string[] = [];
  const bodies: (string | Buffer)[] = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const line = 'x'.repeat(200);
  for (let i = 0; i < 5; i++) {
    const n = bodies.length + 1;
    kids.push(`${n} 0 R`);
    const content = Array.from({ length: 30 }, (_, j) => `BT /F1 10 Tf 50 ${750 - j * 12} Td (${line}) Tj ET`).join('\n');
    bodies.push(`<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /Contents ${n + 1} 0 R >>`, stream('', Buffer.from(content, 'latin1')));
  }
  bodies.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  // Fix up the font reference now that every object has its number.
  const fontNum = bodies.length;
  bodies.forEach((b, i) => typeof b === 'string' && (bodies[i] = b.replace('/F1 3 0 R', `/F1 ${fontNum} 0 R`)));
  bodies[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count 5 >>`;
  const buf = buildPdf(bodies);
  const prev = process.env.FREECODE_NO_PDFTOTEXT;
  process.env.FREECODE_NO_PDFTOTEXT = '1';
  try {
    const r = await readPdf(path.join(dir, 'long.pdf'), buf, undefined, 12_000);
    assert.ok(typeof r !== 'string');
    assert.equal(r.total, 5);
    assert.equal(r.pages.length, 1);
    assert.deepEqual(r.remaining, [2, 3, 4, 5]);
    assert.equal(r.pages[0]!.text.split('\n').length, 30);
  } finally {
    if (prev === undefined) delete process.env.FREECODE_NO_PDFTOTEXT;
    else process.env.FREECODE_NO_PDFTOTEXT = prev;
  }
});
