// Image files for the Read tool: the real format (from the first bytes, not the extension) and the pixel size.

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export const IMAGE_MEDIA_TYPES: Record<ImageFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** The format from the magic bytes, or null when the data is not a PNG, JPEG, GIF or WebP image. */
export function sniffImage(buf: Buffer): ImageFormat | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif';
  if (buf.length >= 16 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Width and height in pixels when the header has them. */
export function imageSize(buf: Buffer, format: ImageFormat): { width: number; height: number } | null {
  try {
    switch (format) {
      case 'png':
        return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
      case 'gif':
        return buf.length >= 10 ? { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) } : null;
      case 'webp': {
        const chunk = buf.toString('latin1', 12, 16);
        if (chunk === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        if (chunk === 'VP8L' && buf.length >= 25) {
          const bits = buf.readUInt32LE(21);
          return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        if (chunk === 'VP8X' && buf.length >= 30) return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
        return null;
      }
      case 'jpeg': {
        // Walk the segments up to the first start-of-frame marker, which holds the size.
        let i = 2;
        while (i + 9 < buf.length) {
          if (buf[i] !== 0xff) {
            i++;
            continue;
          }
          const marker = buf[i + 1]!;
          if (marker === 0xff) {
            i++;
            continue;
          }
          if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
            i += 2;
            continue;
          }
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
          }
          i += 2 + buf.readUInt16BE(i + 2);
        }
        return null;
      }
    }
  } catch {
    return null;
  }
}
