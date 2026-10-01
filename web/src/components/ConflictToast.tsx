import { useNavigate } from 'react-router-dom';
import {
  conflictReviewPath,
  recordKind,
  useConflictNotice,
} from '../lib/conflictNotice';

/**
 * PT40 — the "your save was refused" banner. Mounted once in App so it shows
 * on the map (where the edit was made) and on any other page a queued replay
 * can conflict on. "Review" opens the merge dialog for that conflict.
 */
export function ConflictToast() {
  const notice = useConflictNotice((s) => s.notice);
  const dismiss = useConflictNotice((s) => s.dismiss);
  const navigate = useNavigate();
  if (!notice) return null;

  const kind = recordKind(notice.endpoint);
  const text =
    notice.count > 1
      ? `${notice.count} of your changes conflicted with newer edits and were not saved.`
      : `Your change to this ${kind} conflicted with a newer edit and was not saved. You are now seeing the newer version.`;

  return (
    <div
      role="alert"
      data-testid="conflict-toast"
      className="fixed bottom-4 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-start gap-3 rounded-lg border border-amber-500/60 bg-slate-900 px-4 py-3 text-sm text-slate-100 shadow-xl"
    >
      <span aria-hidden className="text-amber-400">⚠️</span>
      <p className="flex-1">{text}</p>
      <div className="flex shrink-0 gap-2">
        <button
          onClick={() => {
            dismiss();
            navigate(conflictReviewPath(notice.conflictId));
          }}
          className="rounded-md bg-brand px-3 py-1 text-xs text-white"
        >
          Review
        </button>
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="rounded-md bg-slate-700 px-2 py-1 text-xs text-slate-200"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
