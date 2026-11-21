// PT43 — what a photo upload actually is, from its first bytes.
//
// The declared Content-Type and the filename are the client's say-so; the
// bytes are not. The upload route used to store whatever it was handed under
// the client's own extension, so `notes.html` with a `image/jpeg` label went
// into the bucket as `.html`. Now the bytes decide the type, the extension and
// the stored content type, and anything that is not one of the formats the app
// actually sends is refused.
//
// The formats are the ones the web client can send: it re-encodes everything
// it can decode to JPEG (web/src/lib/downscale.ts); a format the browser cannot
// decode — HEIC/HEIF from an iPhone, outside Safari — goes up as-is. PNG and
// WebP are what a desktop browser may hand over unchanged if it is already
// small enough. No `file-type` dependency: four signatures do not need one.

export interface SniffedImage {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'image/heif';
  ext: '.jpg' | '.png' | '.webp' | '.heic' | '.heif';
}

/** Content types the upload filter lets through to the byte check. */
export const ALLOWED_UPLOAD_MIME = new Set([
  'image/jpeg',
  'image/jpg', // non-standard, but some Android pickers send it
  'image/pjpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
  // A browser that does not recognise a file (HEIC on Windows/Android Chrome)
  // labels it with an empty type, which FormData sends as octet-stream. The
  // bytes are checked either way.
  'application/octet-stream',
]);

// ISO-BMFF major brands for HEIC (HEVC-coded) and HEIF (generic) still images.
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
const HEIF_BRANDS = new Set(['mif1', 'msf1', 'mif2']);

function ascii(buf: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...buf.subarray(start, end));
}

/** The image type these bytes are, or null when they are not one we accept. */
export function sniffImageType(buf: Uint8Array): SniffedImage | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF (SOI + the first marker's FF).
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  // PNG: the full 8-byte signature.
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: '.png' };
  }
  // WebP: RIFF <size> WEBP.
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  // HEIC/HEIF: <box size> 'ftyp' <major brand>, then compatible brands.
  if (ascii(buf, 4, 8) === 'ftyp') {
    const boxSize = (buf[0]! << 24) | (buf[1]! << 16) | (buf[2]! << 8) | buf[3]!;
    const end = Math.min(buf.length, boxSize > 8 ? boxSize : 16);
    const brands = [ascii(buf, 8, 12)];
    // AVIF also lists `mif1` as compatible; it is not a format the app sends.
    if (brands[0] === 'avif' || brands[0] === 'avis') return null;
    for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(buf, i, i + 4));
    if (brands.some((b) => HEIC_BRANDS.has(b))) return { mime: 'image/heic', ext: '.heic' };
    if (brands.some((b) => HEIF_BRANDS.has(b))) return { mime: 'image/heif', ext: '.heif' };
  }
  return null;
}
