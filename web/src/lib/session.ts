// PT33 — per-person sign-in (only when the API runs with AUTH_USERS=on).
//
// Magic link against Supabase Auth, implicit flow: the link lands back here
// with `#access_token=…` in the URL, on whatever device the email was opened
// (PKCE would tie it to the device that asked; Our_Menu learned that the hard
// way). That token is handed to the API ONCE, which swaps it for its own
// HttpOnly 30-day cookie. Nothing is kept in localStorage, and every fetch and
// every <img> on this origin carries the cookie automatically.
//
// No supabase-js: two plain requests do the job and keep the bundle as it was.
import { create } from 'zustand';

const BASE = import.meta.env.VITE_API_BASE || '/api';

export interface AuthConfig {
  users_mode: boolean;
  supabase_url: string | null;
  supabase_publishable_key: string | null;
}

export interface Me {
  users_mode: boolean;
  kind?: 'user' | 'legacy' | 'open';
  user_id?: string;
  email?: string | null;
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  const res = await fetch(`${BASE}/auth/config`);
  if (!res.ok) return { users_mode: false, supabase_url: null, supabase_publishable_key: null };
  return (await res.json()) as AuthConfig;
}

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch(`${BASE}/auth/me`);
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`auth/me ${res.status}`);
  return (await res.json()) as Me;
}

/** Ask Supabase to email a sign-in link that returns to `redirectTo`. */
export async function requestMagicLink(cfg: AuthConfig, email: string, redirectTo: string): Promise<void> {
  if (!cfg.supabase_url || !cfg.supabase_publishable_key) {
    throw new Error('Sign-in is not configured on this deployment.');
  }
  const url = `${cfg.supabase_url.replace(/\/$/, '')}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: cfg.supabase_publishable_key },
    body: JSON.stringify({ email, create_user: true }),
  });
  if (!res.ok) {
    // GoTrue's 429 is the common one (one email per 60 s per address).
    throw new Error(res.status === 429 ? 'Too many requests: wait a minute and try again.' : `Could not send the link (${res.status}).`);
  }
}

/** Pull `access_token` out of a URL fragment, or null. Exported for tests. */
export function accessTokenFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h) return null;
  const params = new URLSearchParams(h);
  return params.get('access_token');
}

/**
 * Called once at start-up. If the page was opened from a sign-in link, hand
 * the token to the API and scrub it from the address bar (and history).
 */
export async function consumeAuthRedirect(): Promise<Me | null> {
  const token = accessTokenFromHash(window.location.hash);
  const err = new URLSearchParams(window.location.hash.slice(1)).get('error_description');
  if (!token && !err) return null;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  if (err) throw new Error(err);
  const res = await fetch(`${BASE}/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: token }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Sign-in failed (${res.status}).`);
  }
  const me = (await res.json()) as { user_id: string; email: string | null };
  return { users_mode: true, kind: 'user', user_id: me.user_id, email: me.email };
}

export async function signOut(): Promise<void> {
  await fetch(`${BASE}/auth/session`, { method: 'DELETE' });
  // The service worker caches API reads; the next person on this device must
  // not be shown the last one's farms.
  try {
    if ('caches' in window) await caches.delete('api-cache');
  } catch {
    // Cache Storage unavailable (private mode): nothing cached to leak.
  }
}

interface SessionState {
  config: AuthConfig | null;
  me: Me | null;
  error: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  config: null,
  me: null,
  error: null,
  loaded: false,
  load: async () => {
    try {
      const config = await fetchAuthConfig();
      let me: Me | null = null;
      let error: string | null = null;
      if (config.users_mode) {
        try {
          me = await consumeAuthRedirect();
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        if (!me) me = await fetchMe().catch(() => null);
      }
      set({ config, me, error, loaded: true });
    } catch {
      // Offline at start-up: keep whatever the cookie already allows; the
      // API calls themselves will say if it does not.
      set({ loaded: true });
    }
  },
  signOut: async () => {
    await signOut();
    set({ me: null });
  },
}));
