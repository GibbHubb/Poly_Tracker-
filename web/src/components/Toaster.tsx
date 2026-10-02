import { useNotices } from '../lib/notify';

const STYLE = {
  error: { border: 'border-red-500/70', icon: '⚠️', role: 'alert' as const },
  info: { border: 'border-sky-500/60', icon: 'ℹ️', role: 'status' as const },
  success: { border: 'border-emerald-500/60', icon: '✓', role: 'status' as const },
};

/**
 * PT35 — non-blocking notices (replaces every alert()). Stacked top-centre so
 * they clear the map's own bottom controls and PT40's conflict banner.
 */
export function Toaster() {
  const notices = useNotices((s) => s.notices);
  const dismiss = useNotices((s) => s.dismiss);
  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none fixed left-1/2 top-16 z-[60] flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col gap-2">
      {notices.map((n) => {
        const s = STYLE[n.kind];
        return (
          <div
            key={n.id}
            role={s.role}
            data-testid={`notice-${n.kind}`}
            className={`pointer-events-auto flex items-start gap-3 rounded-lg border ${s.border} bg-slate-900 px-4 py-3 text-sm text-slate-100 shadow-xl`}
          >
            <span aria-hidden>{s.icon}</span>
            <p className="flex-1 break-words">{n.text}</p>
            <div className="flex shrink-0 gap-2">
              {n.action && (
                <button
                  onClick={() => {
                    dismiss(n.id);
                    n.action?.run();
                  }}
                  className="min-h-[32px] rounded-md bg-brand px-3 py-1 text-xs text-white"
                >
                  {n.action.label}
                </button>
              )}
              <button
                onClick={() => dismiss(n.id)}
                aria-label="Dismiss"
                className="min-h-[32px] rounded-md bg-slate-700 px-2 py-1 text-xs text-slate-200"
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
