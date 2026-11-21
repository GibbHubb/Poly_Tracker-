/** PT43 — the upload byte check. DB-free. */
import { describe, it, expect } from 'vitest';
import { ALLOWED_UPLOAD_MIME, sniffImageType } from '../src/lib/imageType.js';

const pad = (head: number[] | Buffer, len = 32) => {
  const b = Buffer.alloc(len, 0);
  Buffer.from(head).copy(b);
  return b;
};
/** An ISO-BMFF `ftyp` box: size, 'ftyp', major brand, minor version, compatible brands. */
const ftyp = (major: string, ...compatible: string[]) => {
  const size = 16 + 4 * compatible.length;
  const b = Buffer.alloc(Math.max(size, 32), 0);
  b.writeUInt32BE(size, 0);
  b.write('ftyp', 4, 'latin1');
  b.write(major, 8, 'latin1');
  compatible.forEach((c, i) => b.write(c, 16 + 4 * i, 'latin1'));
  return b;
};

describe('sniffImageType (PT43)', () => {
  it('recognises JPEG (FF D8 FF)', () => {
    expect(sniffImageType(pad([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ mime: 'image/jpeg', ext: '.jpg' });
    expect(sniffImageType(pad([0xff, 0xd8, 0xff, 0xe1]))).toEqual({ mime: 'image/jpeg', ext: '.jpg' }); // EXIF APP1
  });

  it('recognises PNG by its full 8-byte signature', () => {
    expect(sniffImageType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ mime: 'image/png', ext: '.png' });
    // A truncated signature is not PNG.
    expect(sniffImageType(pad([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });

  it('recognises WebP (RIFF....WEBP) and not other RIFF files', () => {
    const webp = pad(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1'));
    expect(sniffImageType(webp)).toEqual({ mime: 'image/webp', ext: '.webp' });
    const wav = pad(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'));
    expect(sniffImageType(wav)).toBeNull();
  });

  it('recognises HEIC by major or compatible brand, HEIF by mif1', () => {
    expect(sniffImageType(ftyp('heic', 'mif1', 'heic'))).toEqual({ mime: 'image/heic', ext: '.heic' });
    expect(sniffImageType(ftyp('mif1', 'mif1', 'heic'))).toEqual({ mime: 'image/heic', ext: '.heic' });
    expect(sniffImageType(ftyp('mif1', 'mif1'))).toEqual({ mime: 'image/heif', ext: '.heif' });
  });

  it('refuses ISO-BMFF files that are not HEIC/HEIF: MP4 video, AVIF', () => {
    expect(sniffImageType(ftyp('isom', 'isom', 'mp41'))).toBeNull();
    expect(sniffImageType(ftyp('avif', 'mif1', 'avif'))).toBeNull();
  });

  it('refuses text with an image label, an SVG, a GIF and anything shorter than 12 bytes', () => {
    expect(sniffImageType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageType(pad(Buffer.from('GIF89a', 'latin1')))).toBeNull();
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('ALLOWED_UPLOAD_MIME (PT43)', () => {
  it('lets the client formats (and unlabelled octet-stream) through to the byte check, nothing else', () => {
    for (const ok of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/octet-stream']) {
      expect(ALLOWED_UPLOAD_MIME.has(ok)).toBe(true);
    }
    for (const no of ['text/html', 'image/svg+xml', 'application/pdf', 'image/gif', '']) {
      expect(ALLOWED_UPLOAD_MIME.has(no)).toBe(false);
    }
  });
});
