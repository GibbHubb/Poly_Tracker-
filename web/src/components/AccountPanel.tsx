// PT33 — sign-in / sign-out and the minimum farm sharing (add a person by the
// user id shown on THEIR Settings page). Renders nothing unless the API runs
// with AUTH_USERS=on, so token-mode deployments look exactly as before.
import { useCallback, useEffect, useState } from 'react';
import { api, type Farm, type FarmMember, type MemberRole } from '../lib/api';
import { requestMagicLink, useSession } from '../lib/session';

const input =
  'rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500';
const primary = 'rounded-md bg-brand px-4 py-1.5 text-sm text-white disabled:opacity-40';
const secondary = 'rounded-md bg-slate-700 px-4 py-1.5 text-sm text-white disabled:opacity-40';

function SharePanel({ myId }: { myId: string }) {
  const [farms, setFarms] = useState<Farm[]>([]);
  const [farmId, setFarmId] = useState('');
  const [members, setMembers] = useState<FarmMember[]>([]);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<MemberRole>('editor');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api
      .listFarms()
      .then((f) => {
        setFarms(f);
        if (f[0]) setFarmId(f[0].id);
      })
      .catch(() => setFarms([]));
  }, []);

  const loadMembers = useCallback(() => {
    if (!farmId) return;
    api
      .listMembers(farmId)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [farmId]);
  useEffect(loadMembers, [loadMembers]);

  const myRole = members.find((m) => m.user_id === myId)?.role;
  const isOwner = myRole === 'owner';

  const add = async () => {
    setMsg(null);
    try {
      await api.addMember(farmId, userId.trim(), role);
      setUserId('');
      loadMembers();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    setMsg(null);
    try {
      await api.removeMember(farmId, id);
      loadMembers();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  if (farms.length === 0) return null;
  return (
    <div className="mt-4 border-t border-slate-800 pt-3">
      <h3 className="mb-2 text-sm font-medium">Who can see a farm</h3>
      <select value={farmId} onChange={(e) => setFarmId(e.target.value)} className={`${input} mb-2 w-full`}>
        {farms.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <ul className="mb-2 space-y-1 text-sm">
        {members.map((m) => (
          <li key={m.user_id} className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-xs text-slate-300">
              {m.user_id === myId ? 'you' : m.user_id} · {m.role}
            </span>
            {(isOwner || m.user_id === myId) && (
              <button onClick={() => void remove(m.user_id)} className={secondary}>
                {m.user_id === myId ? 'Leave' : 'Remove'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {isOwner && (
        <div className="flex flex-wrap gap-2">
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="Their user id (from their Settings page)"
            className={`${input} min-w-0 flex-1`}
          />
          <select value={role} onChange={(e) => setRole(e.target.value as MemberRole)} className={input}>
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
            <option value="owner">owner</option>
          </select>
          <button onClick={() => void add()} disabled={!userId.trim()} className={primary}>
            Add
          </button>
        </div>
      )}
      {msg && <p className="mt-2 text-sm text-amber-300">{msg}</p>}
    </div>
  );
}

export function AccountPanel() {
  const { config, me, error, signOut } = useSession();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!config?.users_mode) return null;

  const send = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await requestMagicLink(config, email.trim(), `${window.location.origin}/settings`);
      setStatus(`Check ${email.trim()} for a sign-in link. Open it on this device or any other.`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const signedIn = me?.kind === 'user' && me.user_id;

  return (
    <section className="rounded-lg border border-slate-800 p-4">
      <h2 className="mb-3 font-medium">Account</h2>
      {error && <p className="mb-2 text-sm text-amber-300">Sign-in failed: {error}</p>}
      {signedIn ? (
        <>
          <p className="mb-1 text-sm text-slate-300">
            Signed in as <span className="text-emerald-400">{me.email ?? 'unknown email'}</span>
          </p>
          <p className="mb-3 text-xs text-slate-500">
            Your user id (give it to a farm owner to be added):{' '}
            <span className="select-all font-mono text-slate-300">{me.user_id}</span>
          </p>
          <p className="mb-3 text-xs text-slate-500">
            This device stays signed in for 30 days, offline included.
          </p>
          <button onClick={() => void signOut()} className={secondary}>
            Sign out
          </button>
          <SharePanel myId={me.user_id!} />
        </>
      ) : (
        <>
          <p className="mb-2 text-sm text-slate-400">Sign in with your email. We send a link; no password.</p>
          <div className="flex gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={`${input} flex-1`}
            />
            <button onClick={() => void send()} disabled={busy || !email.includes('@')} className={primary}>
              Email me a link
            </button>
          </div>
          {status && <p className="mt-2 text-sm text-slate-300">{status}</p>}
        </>
      )}
    </section>
  );
}
