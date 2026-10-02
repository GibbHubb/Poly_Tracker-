// PT35 — one place every failure the user should know about goes.
//
// Before this, twelve catches discarded their error and five more surfaced it
// through alert(), which on a phone is a modal that blocks the map and shows
// whatever err.message happened to hold. A notice is non-blocking; errors stay
// until dismissed (a toast is easier to miss than an alert), successes and
// informational notices fade on their own.

import { create } from 'zustand';
import { ApiError } from './api';

export type NoticeKind = 'error' | 'info' | 'success';

export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
  action?: { label: string; run: () => void };
}

interface NoticeState {
  notices: Notice[];
  push: (n: Omit<Notice, 'id'>) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;
const AUTO_DISMISS_MS = 5000;
const MAX_VISIBLE = 4;

export const useNotices = create<NoticeState>((set, get) => ({
  notices: [],
  push: (n) => {
    const id = nextId++;
    // Same text twice (a retry that fails again) replaces, not stacks.
    const rest = get().notices.filter((x) => x.text !== n.text);
    set({ notices: [...rest, { ...n, id }].slice(-MAX_VISIBLE) });
    if (n.kind !== 'error') {
      setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS);
    }
    return id;
  },
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((x) => x.id !== id) })),
}));

/** True when the request never got an HTTP answer: no signal, DNS, CORS, aborted. */
export function isNetworkError(err: unknown): boolean {
  return !(err instanceof ApiError);
}

/** The request id the API put in an error body (PT35), if any. */
export function requestIdOf(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const body = JSON.parse(err.body) as { requestId?: unknown };
    return typeof body.requestId === 'string' ? body.requestId : null;
  } catch {
    // Not every error body is JSON (a proxy's HTML 502, say); no id to quote then.
    return null;
  }
}

/** The server's own message for a 4xx we wrote (HttpError/ZodError bodies), if any. */
function serverMessage(err: ApiError): string | null {
  try {
    const body = JSON.parse(err.body) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : null;
  } catch {
    // A non-JSON body carries nothing we would want to show a user verbatim.
    return null;
  }
}

/**
 * "<action> failed: <why>" — names the action, and separates "you are offline"
 * from "the server refused this" because the user's next move differs.
 */
export function describeError(action: string, err: unknown): string {
  if (isNetworkError(err)) {
    return `${action} failed: no connection to the server.`;
  }
  const e = err as ApiError;
  const rid = requestIdOf(e);
  const ref = rid ? ` (ref ${rid.slice(0, 8)})` : '';
  if (e.status === 401 || e.status === 403) {
    return `${action} failed: this device is not allowed to do that. Check the access token in Settings.`;
  }
  if (e.status === 404) return `${action} failed: it no longer exists on the server.`;
  if (e.status >= 500) {
    const own = e.status === 503 ? serverMessage(e) : null;
    return sentence(`${action} failed: ${own ?? 'the server had a problem'}${ref}`);
  }
  return sentence(`${action} failed: ${serverMessage(e) ?? `the server refused it (${e.status})`}${ref}`);
}

/** End with exactly one full stop (server messages often bring their own). */
function sentence(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** Report a failure to the user. Returns the notice id. */
export function reportError(
  action: string,
  err: unknown,
  retry?: () => void,
): number {
  // The full error still goes to the console for whoever is debugging.
  console.warn(`[${action}]`, err);
  return useNotices.getState().push({
    kind: 'error',
    text: describeError(action, err),
    action: retry ? { label: 'Retry', run: retry } : undefined,
  });
}

export function notify(kind: NoticeKind, text: string): number {
  return useNotices.getState().push({ kind, text });
}

/** 4xx answers about the moment, not the edit — same set as photoQueue's TRANSIENT_4XX. */
const RETRYABLE_4XX = new Set([401, 403, 408, 425, 429]);

/**
 * Whether a failed write should go to the offline queue: when the server was
 * never reached, answered 5xx, or refused for a reason that fixing the token in
 * Settings cures. Anything else (400, 404, 413, 422) is a refusal of the edit
 * itself; replaying it later gets the same answer, and a refused row at the
 * head of the queue blocks every edit behind it.
 */
export function shouldQueue(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  const s = (err as ApiError).status;
  return s >= 500 || RETRYABLE_4XX.has(s);
}
