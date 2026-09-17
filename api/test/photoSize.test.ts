import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { MAX_PHOTO_BYTES } from '../src/routes/photos.js';
import { truncateAll, closePool } from './helpers.js';

beforeEach(truncateAll);
afterAll(closePool);

// PT26 — Vercel refuses a request body over ~4.5 MB before our code runs. The API's own cap
// sits under that, so an oversize photo is refused by US, with a status and a reason.
describe('photos — size limit (PT26)', () => {
  const jpegOf = (bytes: number) => {
    const b = Buffer.alloc(bytes, 0x41);
    b[0] = 0xff; b[1] = 0xd8; // JPEG magic; the API stores bytes, it does not decode them
    return b;
  };

  it('refuses a file over the cap with 413 and a message, not a 500', async () => {
    const res = await request(app)
      .post('/api/photos')
      .attach('photo', jpegOf(MAX_PHOTO_BYTES + 1), { filename: 'big.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
  });

  it('accepts a file just under the cap (control)', async () => {
    const res = await request(app)
      .post('/api/photos')
      .attach('photo', jpegOf(MAX_PHOTO_BYTES - 1024), { filename: 'ok.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
  });

  it('keeps the cap under the platform body limit (~4.5 MB) with room for multipart overhead', () => {
    expect(MAX_PHOTO_BYTES).toBeLessThanOrEqual(4.2 * 1024 * 1024);
  });
});
