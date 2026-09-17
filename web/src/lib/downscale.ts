/**
 * PT26 — shrink a photo in the browser before it is uploaded or queued.
 *
 * On Vercel the platform refuses a request body over ~4.5 MB before the API runs, and a
 * phone camera JPEG is typically 3–8 MB, so a real photo failed with a generic error.
 * The longest side goes to MAX_DIMENSION and the result is re-encoded as JPEG.
 *
 * EXIF is dropped by the re-encode, deliberately: the location and capture time are read
 * from the ORIGINAL file first (PhotoUpload) and sent as their own fields, so nothing the
 * app uses is lost, and the stored bytes no longer carry the camera's metadata.
 */
export const MAX_DIMENSION = 1600;
export const JPEG_QUALITY = 0.8;
/** Must stay under the API's MAX_PHOTO_BYTES (4 MB). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export class PhotoTooLargeError extends Error {
  constructor(bytes: number) {
    super(`This photo could not be made small enough to upload (${(bytes / 1024 / 1024).toFixed(1)} MB).`);
  }
}

export interface Downscaled {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
  /** false when the original was kept (already small, or the browser could not decode it). */
  resized: boolean;
}

function jpegName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'photo';
  return `${base}.jpg`;
}

export async function downscalePhoto(file: File): Promise<Downscaled> {
  let bitmap: ImageBitmap;
  try {
    // 'from-image' applies the EXIF orientation, so a portrait photo stays portrait once
    // the metadata that described its rotation is gone.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // A format this browser cannot decode (e.g. HEIC outside Safari): send it as-is if it fits.
    if (file.size <= MAX_UPLOAD_BYTES) {
      return { blob: file, filename: file.name || 'photo', width: 0, height: 0, resized: false };
    }
    throw new PhotoTooLargeError(file.size);
  }

  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_UPLOAD_BYTES && file.type === 'image/jpeg') {
    const out = { blob: file, filename: file.name || 'photo.jpg', width: bitmap.width, height: bitmap.height, resized: false };
    bitmap.close();
    return out;
  }
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('This browser could not re-encode the photo.');
  if (blob.size > MAX_UPLOAD_BYTES) throw new PhotoTooLargeError(blob.size);
  return { blob, filename: jpegName(file.name || 'photo'), width, height, resized: true };
}
