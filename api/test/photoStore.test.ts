import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPhotoStore } from '../src/storage/index.js';

/**
 * The selection rules, which are the part that can silently send a deployment's
 * photos somewhere nobody intended.
 */
describe('photo store selection', () => {
  const writable = () => mkdtempSync(join(tmpdir(), 'poly-photos-'));

  it('defaults to disk when PHOTO_BACKEND is unset', () => {
    const store = createPhotoStore({ PHOTO_STORAGE_PATH: writable() } as NodeJS.ProcessEnv);
    expect(store.kind).toBe('disk');
    expect(store.unavailable).toBeNull();
  });

  it('defaults to disk for an unrecognised PHOTO_BACKEND, never to object storage', () => {
    // A typo must not silently move where photos land.
    const store = createPhotoStore({
      PHOTO_BACKEND: 'supabse',
      PHOTO_STORAGE_PATH: writable(),
    } as NodeJS.ProcessEnv);
    expect(store.kind).toBe('disk');
  });

  it('selects supabase when asked and fully configured', () => {
    const store = createPhotoStore({
      PHOTO_BACKEND: 'supabase',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    } as NodeJS.ProcessEnv);
    expect(store.kind).toBe('supabase');
    expect(store.unavailable).toBeNull();
  });

  it('fails CLOSED — named — when asked for supabase without credentials', () => {
    // Not a throw (PT21: that takes down every route), and NOT a silent
    // fallback to a disk that does not exist on this host.
    const store = createPhotoStore({ PHOTO_BACKEND: 'supabase' } as NodeJS.ProcessEnv);
    expect(store.kind).toBe('supabase');
    expect(store.unavailable).toContain('SUPABASE_URL');
    expect(store.unavailable).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('reports the ONE missing variable, so the message is actionable', () => {
    const store = createPhotoStore({
      PHOTO_BACKEND: 'supabase',
      SUPABASE_URL: 'https://example.supabase.co',
    } as NodeJS.ProcessEnv);
    expect(store.unavailable).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(store.unavailable).not.toContain('SUPABASE_URL is');
  });

  it('records an unwritable disk path instead of throwing at construction', () => {
    // PT21's incident in one assertion: a bare mkdirSync threw EROFS while the
    // module loaded and took down every route in the app.
    const store = createPhotoStore({
      PHOTO_STORAGE_PATH: '\0invalid-path',
    } as NodeJS.ProcessEnv);
    expect(store.kind).toBe('disk');
    expect(store.unavailable).toBeTruthy();
  });

  it('round-trips bytes through the disk backend', async () => {
    const store = createPhotoStore({ PHOTO_STORAGE_PATH: writable() } as NodeJS.ProcessEnv);
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22]);
    const key = await store.put(bytes, '.jpg', 'image/jpeg');
    const resolved = await store.resolve(key);
    expect(resolved.kind).toBe('file');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(key).equals(bytes)).toBe(true);
    await store.remove(key);
    expect(() => readFileSync(key)).toThrow();
    // A second delete of the same key must be a no-op, not a throw.
    await expect(store.remove(key)).resolves.toBeUndefined();
  });
});
