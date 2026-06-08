import { create } from 'zustand';

const TOKEN_KEY = 'pt_api_token';

export function getApiToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setApiToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // localStorage unavailable (SSR/private mode) — ignore.
  }
}

export function clearApiToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

// Zustand store for reactive Settings display.
interface AuthState {
  token: string | null;
  save: (t: string) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: getApiToken(),
  save: (t) => {
    setApiToken(t);
    set({ token: t });
  },
  clear: () => {
    clearApiToken();
    set({ token: null });
  },
}));
