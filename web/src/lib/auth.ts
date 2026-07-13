import { create } from 'zustand';

// The legacy single-token key maps to the WRITE token (back-compat with PT14).
const WRITE_TOKEN_KEY = 'pt_api_token';
const READ_TOKEN_KEY = 'pt_api_read_token';

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable (SSR/private mode) — ignore.
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function getWriteToken(): string | null {
  return readKey(WRITE_TOKEN_KEY);
}

export function getReadToken(): string | null {
  return readKey(READ_TOKEN_KEY);
}

/** @deprecated Use getWriteToken(). Kept as an alias for existing callers. */
export function getApiToken(): string | null {
  return getWriteToken();
}

export function setWriteToken(token: string): void {
  writeKey(WRITE_TOKEN_KEY, token);
}

export function setReadToken(token: string): void {
  writeKey(READ_TOKEN_KEY, token);
}

export function clearWriteToken(): void {
  removeKey(WRITE_TOKEN_KEY);
}

export function clearReadToken(): void {
  removeKey(READ_TOKEN_KEY);
}

// Zustand store for reactive Settings display.
interface AuthState {
  writeToken: string | null;
  readToken: string | null;
  /** Alias of writeToken for back-compat with any single-token callers. */
  token: string | null;
  saveWrite: (t: string) => void;
  clearWrite: () => void;
  saveRead: (t: string) => void;
  clearRead: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  writeToken: getWriteToken(),
  readToken: getReadToken(),
  token: getWriteToken(),
  saveWrite: (t) => {
    setWriteToken(t);
    set({ writeToken: t, token: t });
  },
  clearWrite: () => {
    clearWriteToken();
    set({ writeToken: null, token: null });
  },
  saveRead: (t) => {
    setReadToken(t);
    set({ readToken: t });
  },
  clearRead: () => {
    clearReadToken();
    set({ readToken: null });
  },
}));
