import { describe, it, expect } from 'vitest';
import { accessTokenFromHash } from './session';

describe('PT33 accessTokenFromHash', () => {
  it('reads the token from a Supabase implicit-flow redirect', () => {
    expect(
      accessTokenFromHash('#access_token=abc.def.ghi&expires_in=3600&refresh_token=r&token_type=bearer&type=magiclink'),
    ).toBe('abc.def.ghi');
  });
  it('is null for an ordinary fragment or none', () => {
    expect(accessTokenFromHash('')).toBeNull();
    expect(accessTokenFromHash('#section-2')).toBeNull();
    expect(accessTokenFromHash('#error=access_denied&error_description=Email+link+is+invalid')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The network half, with fetch stubbed: what each call sends and how it reads
// the answer. (The real round trip is the API's authorize.test.ts.)
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, vi } from 'vitest';
import {
  consumeAuthRedirect,
  fetchAuthConfig,
  fetchMe,
  requestMagicLink,
  signOut,
  useSession,
} from './session';

const CFG = { users_mode: true, supabase_url: 'https://ref.supabase.co/', supabase_publishable_key: 'sb_publishable_x' };

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

let replaced: string | null = null;
beforeEach(() => {
  replaced = null;
  vi.stubGlobal('window', {
    location: { hash: '', pathname: '/settings', search: '' },
    history: { replaceState: (_s: unknown, _t: string, url: string) => (replaced = url) },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useSession.setState({ config: null, me: null, error: null, loaded: false });
});

describe('PT33 session client', () => {
  it('fetchAuthConfig falls back to users_mode:false when the API is older', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(404)));
    expect((await fetchAuthConfig()).users_mode).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, CFG)));
    expect(await fetchAuthConfig()).toEqual(CFG);
  });

  it('fetchMe: 401 is "not signed in", other failures throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, {})));
    expect(await fetchMe()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => reply(500, {})));
    await expect(fetchMe()).rejects.toThrow('500');
  });

  it('requestMagicLink posts the email to Supabase with the redirect and key', async () => {
    const f = vi.fn(async () => reply(200, {}));
    vi.stubGlobal('fetch', f);
    await requestMagicLink(CFG, 'max@example.test', 'https://app.example/settings');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ref.supabase.co/auth/v1/otp?redirect_to=https%3A%2F%2Fapp.example%2Fsettings');
    expect((init.headers as Record<string, string>).apikey).toBe('sb_publishable_x');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'max@example.test', create_user: true });
  });

  it('requestMagicLink explains a rate limit and refuses without config', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(429, {})));
    await expect(requestMagicLink(CFG, 'a@b.c', 'x')).rejects.toThrow(/wait a minute/);
    vi.stubGlobal('fetch', vi.fn(async () => reply(500, {})));
    await expect(requestMagicLink(CFG, 'a@b.c', 'x')).rejects.toThrow('500');
    await expect(
      requestMagicLink({ ...CFG, supabase_publishable_key: null }, 'a@b.c', 'x'),
    ).rejects.toThrow(/not configured/);
  });

  it('consumeAuthRedirect does nothing without a token in the URL', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await consumeAuthRedirect()).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('consumeAuthRedirect hands the token to the API once and scrubs the URL', async () => {
    (window.location as { hash: string }).hash = '#access_token=t.o.k&type=magiclink';
    const f = vi.fn(async () => reply(201, { user_id: 'u1', email: 'max@example.test' }));
    vi.stubGlobal('fetch', f);
    const me = await consumeAuthRedirect();
    expect(me).toMatchObject({ kind: 'user', user_id: 'u1' });
    expect(replaced).toBe('/settings');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/session');
    expect(JSON.parse(String(init.body))).toEqual({ access_token: 't.o.k' });
  });

  it('consumeAuthRedirect surfaces Supabase and API refusals', async () => {
    (window.location as { hash: string }).hash = '#error=access_denied&error_description=Email+link+is+invalid';
    await expect(consumeAuthRedirect()).rejects.toThrow('Email link is invalid');
    (window.location as { hash: string }).hash = '#access_token=bad';
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'expired' })));
    await expect(consumeAuthRedirect()).rejects.toThrow('expired');
  });

  it('signOut clears the cookie and the cached API reads', async () => {
    const f = vi.fn(async () => reply(204));
    const del = vi.fn(async () => true);
    vi.stubGlobal('fetch', f);
    vi.stubGlobal('caches', { delete: del });
    (window as unknown as { caches: unknown }).caches = { delete: del };
    await signOut();
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('DELETE');
    expect(del).toHaveBeenCalledWith('api-cache');
  });

  it('useSession.load: users mode off skips the session calls; on, it asks who I am', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { ...CFG, users_mode: false })));
    await useSession.getState().load();
    expect(useSession.getState()).toMatchObject({ loaded: true, me: null });

    const f = vi.fn(async (url: string) =>
      url.endsWith('/auth/config') ? reply(200, CFG) : reply(200, { users_mode: true, kind: 'user', user_id: 'u2' }),
    );
    vi.stubGlobal('fetch', f);
    await useSession.getState().load();
    expect(useSession.getState().me).toMatchObject({ user_id: 'u2' });

    vi.stubGlobal('fetch', vi.fn(async () => reply(204)));
    await useSession.getState().signOut();
    expect(useSession.getState().me).toBeNull();
  });

  it('useSession.load survives being offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await useSession.getState().load();
    expect(useSession.getState().loaded).toBe(true);
  });
});
