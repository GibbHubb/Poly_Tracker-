import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Farm } from '../lib/api';

export function FarmList() {
  const [farms, setFarms] = useState<Farm[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api
      .listFarms()
      .then(setFarms)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Failed to load farms'),
      )
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const createFarm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api.createFarm({ name: name.trim() });
      setName('');
      setCreating(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create farm');
    }
  };

  return (
    <div className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Farms</h1>
        <button
          onClick={() => setCreating((v) => !v)}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white"
        >
          {creating ? 'Cancel' : 'Create farm'}
        </button>
      </div>

      {creating && (
        <form onSubmit={createFarm} className="mb-4 flex gap-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Farm name"
            className="flex-1 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white"
          >
            Save
          </button>
        </form>
      )}

      {error && <p className="mb-3 text-sm text-amber-400">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Loading…</p>}

      {!loading && farms.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-700 p-10 text-center text-slate-400">
          <p className="mb-2">No farms yet.</p>
          <p className="text-sm">Click “Create farm” to add your first one.</p>
        </div>
      )}

      <ul className="space-y-2">
        {farms.map((f) => (
          <li key={f.id}>
            <Link
              to={`/farms/${f.id}`}
              className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-800/50 px-4 py-3 hover:border-brand"
            >
              <span className="font-medium">{f.name}</span>
              <span className="text-xs text-slate-400">
                {f.owner ?? 'no owner'}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
